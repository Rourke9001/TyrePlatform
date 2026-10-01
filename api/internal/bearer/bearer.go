// Package bearer validates the Entra External ID access token a request
// carries and names the identity it proves (ADR-0016). It resolves no user.
// The tenant claim is a hint that store.InActorTx proves under RLS.
package bearer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/time/rate"

	"tyreplatform/api/internal/httpapi"
)

// HeaderName is where the token travels. It is one constant on each side
// because the Static Web App's linked backend may not forward it, and the
// recorded fallback is a second name (ADR-0016, TYRE-51).
const HeaderName = "Authorization"

const (
	// clockSkew is the leeway on exp and nbf for server clock drift. It is a
	// transport constant, not tenant configuration (spec section 1, step 8).
	clockSkew = 2 * time.Minute
	// fetchTimeout bounds each discovery and key-set fetch, so a slow Entra
	// holds a request for seconds rather than jwkset's default minute (spec
	// section 1, Loading the keys).
	fetchTimeout = 5 * time.Second
	// unknownKIDWait bounds an unknown kid's refetch (spec section 1, step 2).
	// jwkset spends one deadline on the limiter wait and the fetch together
	// (jwkset v0.11.3 http.go, KeyRead), so a slow Entra refuses within it.
	unknownKIDWait  = time.Second
	unknownKIDEvery = 5 * time.Minute
	refreshEvery    = time.Hour
	requiredScope   = "access_as_user"
	// maxLoggedKID caps an unverified kid in the log, where it is whatever a
	// caller sent (spec section 1, Logging a refusal).
	maxLoggedKID = 64
)

// Config holds ADR-0016's six AUTH_* values, which main format-checks (spec
// section 1, Configuration).
type Config struct {
	DiscoveryURL string
	Issuer       string
	TenantID     string
	Audience     string
	ClientID     string
	TenantClaim  string
}

// Resolver implements httpapi.ActorResolver for Entra access tokens. Its key
// set loads on the first request, never at startup, so an unreachable Entra
// cannot stop the process (spec section 1, Loading the keys).
type Resolver struct {
	cfg     Config
	client  *http.Client
	refresh time.Duration
	parser  *jwt.Parser

	mu      sync.Mutex
	keys    keyfunc.Keyfunc
	stop    context.CancelFunc
	pending *attempt
	closed  bool
}

// attempt is one key-set load, shared by every request that arrives while it
// runs.
type attempt struct {
	done chan struct{}
	keys keyfunc.Keyfunc
	err  error
}

type Option func(*Resolver)

// WithRefreshInterval shortens jwkset's background refresh, for tests that
// watch it run.
func WithRefreshInterval(d time.Duration) Option { return func(r *Resolver) { r.refresh = d } }

func New(cfg Config, opts ...Option) *Resolver {
	r := &Resolver{
		cfg:     cfg,
		client:  &http.Client{Timeout: fetchTimeout},
		refresh: refreshEvery,
	}
	for _, opt := range opts {
		opt(r)
	}
	r.parser = jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}),
		jwt.WithIssuer(cfg.Issuer),
		jwt.WithAudience(cfg.Audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(clockSkew),
	)
	return r
}

// Close ends the key set's background refresh.
func (r *Resolver) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.stop != nil {
		r.stop()
	}
}

// Identify runs spec section 1's checks in order and refuses on the first
// failure.
func (r *Resolver) Identify(ctx context.Context, req *http.Request) (httpapi.Identity, error) {
	raw, ok := bearerToken(req)
	if !ok {
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: "no bearer token"}
	}
	// Steps 1 and 2 need no key set, so a malformed token is a 401 even while
	// Entra cannot be reached.
	head, _, err := jwt.NewParser().ParseUnverified(raw, jwt.MapClaims{})
	if err != nil {
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: "malformed token"}
	}
	if head.Method.Alg() != jwt.SigningMethodRS256.Alg() {
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: "algorithm is not RS256",
			attrs: []any{"kid", loggedKID(head)}}
	}
	// A token must name its kid (spec section 1, step 2). keyfunc tries every
	// key in the set when it names none (keyfunc v3.8.0 KeyfuncCtx), so the
	// check runs here, before any lookup.
	if kid, _ := head.Header["kid"].(string); kid == "" {
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: "no kid"}
	}
	keys, err := r.keySet(ctx)
	if err != nil {
		return httpapi.Identity{}, err
	}
	claims := jwt.MapClaims{}
	_, err = r.parser.ParseWithClaims(raw, claims, keys.KeyfuncCtx(ctx))
	switch {
	case err == nil:
		return r.identity(claims)
	case errors.Is(err, jwt.ErrTokenInvalidClaims):
		// golang-jwt validates claims only after the signature verifies, so
		// these claims are Entra's and may be logged.
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: err.Error(),
			attrs: verifiedAttrs(claims, r.cfg.TenantClaim)}
	default:
		return httpapi.Identity{}, &refusal{kind: httpapi.ErrUnauthenticated, reason: unverifiedReason(err),
			attrs: []any{"kid", loggedKID(head)}}
	}
}

// unverifiedReason names why a token failed before its signature verified.
// It is a fixed phrase, never the library's message, because jwkset quotes an
// unknown kid in full and before verification the kid is the caller's.
func unverifiedReason(err error) string {
	switch {
	case errors.Is(err, jwt.ErrTokenSignatureInvalid):
		return "bad signature"
	case errors.Is(err, jwt.ErrTokenUnverifiable):
		return "no key for this kid"
	default:
		return "token not verified"
	}
}

// identity finishes steps 5 to 10 on a verified token.
func (r *Resolver) identity(c jwt.MapClaims) (httpapi.Identity, error) {
	attrs := verifiedAttrs(c, r.cfg.TenantClaim)
	refuse := func(kind error, reason string) (httpapi.Identity, error) {
		return httpapi.Identity{}, &refusal{kind: kind, reason: reason, attrs: attrs}
	}
	if !soleAudience(c["aud"], r.cfg.Audience) {
		return refuse(httpapi.ErrUnauthenticated, "aud is not tyre-api alone")
	}
	if azp, _ := c["azp"].(string); azp != r.cfg.ClientID {
		return refuse(httpapi.ErrUnauthenticated, "azp is not tyre-pwa")
	}
	if ver, _ := c["ver"].(string); ver != "2.0" {
		return refuse(httpapi.ErrUnauthenticated, "ver is not 2.0")
	}
	if tid, _ := c["tid"].(string); tid != r.cfg.TenantID {
		return refuse(httpapi.ErrUnauthenticated, "tid is not the CIAM tenant")
	}
	if !hasScope(c["scp"], requiredScope) {
		return refuse(httpapi.ErrUnauthenticated, "scp lacks access_as_user")
	}
	oidText, _ := c["oid"].(string)
	oid, err := uuid.Parse(oidText)
	if err != nil || oid == uuid.Nil {
		return refuse(httpapi.ErrUnauthenticated, "oid is not a uuid")
	}
	session := sessionID(c)
	if session == "" {
		return refuse(httpapi.ErrUnauthenticated, "the token carries neither sid nor uti")
	}
	// A valid person with no platform tenant gets 403, not the 401 that would
	// send them round a sign-in that cannot help (spec section 1, step 10).
	tenantText, _ := c[r.cfg.TenantClaim].(string)
	tenant, err := uuid.Parse(tenantText)
	if err != nil || tenant == uuid.Nil {
		return refuse(httpapi.ErrNotProvisioned, "no usable tenant claim")
	}
	return httpapi.Identity{TenantID: tenant, Subject: oid, SessionID: session}, nil
}

// keySet returns the loaded key set, or shares one load among the requests
// that arrive while it runs. A failed load is not cached, so the next request
// starts another (spec section 1, Loading the keys).
func (r *Resolver) keySet(ctx context.Context) (keyfunc.Keyfunc, error) {
	r.mu.Lock()
	if r.keys != nil {
		keys := r.keys
		r.mu.Unlock()
		return keys, nil
	}
	a := r.pending
	if a == nil {
		a = &attempt{done: make(chan struct{})}
		r.pending = a
		// Detached from this request, so a caller who hangs up does not fail
		// the load for the others waiting on it.
		go r.load(a)
	}
	r.mu.Unlock()
	select {
	case <-a.done:
		return a.keys, a.err
	case <-ctx.Done():
		return nil, &refusal{kind: httpapi.ErrAuthUnavailable, reason: "the request ended while the key set loaded"}
	}
}

func (r *Resolver) load(a *attempt) {
	keys, stop, err := r.fetch()
	r.mu.Lock()
	if err == nil {
		if r.closed {
			stop()
		} else {
			r.keys, r.stop = keys, stop
		}
	}
	r.pending = nil
	r.mu.Unlock()
	a.keys, a.err = keys, err
	close(a.done)
}

func (r *Resolver) fetch() (keyfunc.Keyfunc, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
	defer cancel()
	doc, err := r.discover(ctx)
	if err != nil {
		return nil, nil, &refusal{kind: httpapi.ErrAuthUnavailable, reason: "discovery unreachable",
			attrs: []any{"err", err.Error()}}
	}
	// A mismatch is a configuration mistake. Every request answers 503 with
	// both values logged, never a 401 that sends drivers to a sign-in that
	// cannot help (spec section 1, step 3).
	if doc.Issuer != r.cfg.Issuer {
		return nil, nil, &refusal{kind: httpapi.ErrAuthUnavailable, reason: "discovery issuer does not match AUTH_ISSUER",
			attrs: []any{"discovery_issuer", doc.Issuer, "configured_issuer", r.cfg.Issuer}}
	}
	life, stop := context.WithCancel(context.Background())
	noErrorOnFirstFetch := false
	keys, err := keyfunc.NewDefaultOverrideCtx(life, []string{doc.JWKSURI}, keyfunc.Override{
		Client:                    r.client,
		HTTPTimeout:               fetchTimeout,
		NoErrorReturnFirstHTTPReq: &noErrorOnFirstFetch,
		RateLimitWaitMax:          unknownKIDWait,
		RefreshInterval:           r.refresh,
		RefreshUnknownKID:         rate.NewLimiter(rate.Every(unknownKIDEvery), 1),
	})
	if err != nil {
		// jwkset starts its refresh goroutine before its first fetch (jwkset
		// v0.11.3 storage.go, NewStorageFromHTTP), so a failed load must end it.
		stop()
		return nil, nil, &refusal{kind: httpapi.ErrAuthUnavailable, reason: "key set unreachable",
			attrs: []any{"err", err.Error()}}
	}
	return keys, stop, nil
}

type discovery struct {
	Issuer  string `json:"issuer"`
	JWKSURI string `json:"jwks_uri"`
}

func (r *Resolver) discover(ctx context.Context) (discovery, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.cfg.DiscoveryURL, nil)
	if err != nil {
		return discovery{}, fmt.Errorf("building the discovery request: %w", err)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return discovery{}, fmt.Errorf("fetching discovery: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return discovery{}, fmt.Errorf("fetching discovery: status %d", resp.StatusCode)
	}
	var doc discovery
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&doc); err != nil {
		return discovery{}, fmt.Errorf("decoding discovery: %w", err)
	}
	if doc.JWKSURI == "" {
		return discovery{}, errors.New("discovery names no jwks_uri")
	}
	return doc, nil
}

// refusal is a resolver error that carries what may be logged about it. Its
// Error() is the reason alone, which holds no token text and no unverified
// claim, so it is safe wherever it is logged (spec section 1, Logging a
// refusal).
type refusal struct {
	kind   error
	reason string
	attrs  []any
}

func (e *refusal) Error() string { return e.reason }
func (e *refusal) Unwrap() error { return e.kind }

// LogAttrs is what requireActor logs. Before the signature verifies that is
// the reason and the kid alone, after it the verified claims, and never the
// token (spec section 1, Logging a refusal).
func (e *refusal) LogAttrs() []any { return append([]any{"reason", e.reason}, e.attrs...) }

// bearerToken reads the scheme case-insensitively (RFC 7235 section 2.1).
func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get(HeaderName), " ")
	token = strings.TrimSpace(token)
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}

// soleAudience wants aud to equal AUTH_AUDIENCE (spec section 1, step 5).
// golang-jwt's WithAudience accepts any array that contains it. One audience
// may still travel as a one-element array (RFC 7519 section 4.1.3).
func soleAudience(v any, want string) bool {
	switch aud := v.(type) {
	case string:
		return aud == want
	case []any:
		return len(aud) == 1 && aud[0] == want
	default:
		return false
	}
}

// hasScope wants the scope as a whole element, so "access_as_user_admin" is
// not "access_as_user" (spec section 1, step 7).
func hasScope(v any, want string) bool {
	s, _ := v.(string)
	for _, f := range strings.Fields(s) {
		if f == want {
			return true
		}
	}
	return false
}

// sessionID prefers sid, which spans a sign-in. uti names one access token,
// so without sid every hourly renewal reads as a new session (FR-AUD-002).
func sessionID(c jwt.MapClaims) string {
	if sid, _ := c["sid"].(string); sid != "" {
		return "sid:" + sid
	}
	if uti, _ := c["uti"].(string); uti != "" {
		return "uti:" + uti
	}
	return ""
}

func verifiedAttrs(c jwt.MapClaims, tenantClaim string) []any {
	return []any{"oid", c["oid"], "tenant", c[tenantClaim], "session", sessionID(c)}
}

func loggedKID(t *jwt.Token) string {
	if t == nil {
		return ""
	}
	kid, _ := t.Header["kid"].(string)
	if len(kid) > maxLoggedKID {
		// A byte cut can split a multi-byte rune, which the JSON log would
		// carry as a replacement character.
		kid = strings.ToValidUTF8(kid[:maxLoggedKID], "")
	}
	return kid
}
