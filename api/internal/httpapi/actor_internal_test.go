package httpapi

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/google/uuid"
	// Aliased: package httpapi declares its own require (docs/lessons.md, 2026-08-28).
	req "github.com/stretchr/testify/require"
)

type stubResolver struct {
	id  Identity
	err error
}

func (s stubResolver) Identify(context.Context, *http.Request) (Identity, error) { return s.id, s.err }

type loggedRefusal struct{ kind error }

func (e loggedRefusal) Error() string   { return "refused" }
func (e loggedRefusal) Unwrap() error   { return e.kind }
func (e loggedRefusal) LogAttrs() []any { return []any{"reason", "expired", "kid", "key-1"} }

func serveThrough(resolver ActorResolver, authorization string) *httptest.ResponseRecorder {
	h := requireActor(resolver, 1)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	if authorization != "" {
		r.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec
}

// captureLog swaps slog's default for a buffer. Not parallel: the default is
// process-wide.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// The refusal table in spec section 1, The seam. 401 sends the client to
// sign in, so a missing resolver or an unreachable identity provider must
// never be one.
func TestRequireActorMapsEachRefusalToItsStatus(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"unauthenticated", fmt.Errorf("%w: expired", ErrUnauthenticated), http.StatusUnauthorized, codeUnauthorized},
		{"not provisioned", fmt.Errorf("%w: no tenant claim", ErrNotProvisioned), http.StatusForbidden, codeNotProvisioned},
		{"unavailable", fmt.Errorf("%w: discovery down", ErrAuthUnavailable), http.StatusServiceUnavailable, codeAuthUnavailable},
		{"anything else", errors.New("resolver bug"), http.StatusInternalServerError, codeInternal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveThrough(stubResolver{err: tc.err}, "")
			req.Equal(t, tc.status, rec.Code, rec.Body.String())
			req.Contains(t, rec.Body.String(), `"code":"`+tc.code+`"`)
		})
	}
}

func TestRequireActorWithNoResolverIsUnavailable(t *testing.T) {
	rec := serveThrough(nil, "")
	req.Equal(t, http.StatusServiceUnavailable, rec.Code)
	req.Contains(t, rec.Body.String(), `"code":"auth_unavailable"`)
}

// FR-AUD-004's record of a refused token is this log line: the resolver's
// own attributes and the client address, never the token (spec section 1,
// Logging a refusal).
func TestRequireActorLogsTheRefusalButNeverTheToken(t *testing.T) {
	buf := captureLog(t)
	rec := serveThrough(stubResolver{err: loggedRefusal{kind: ErrUnauthenticated}}, "Bearer secret-token-text")
	req.Equal(t, http.StatusUnauthorized, rec.Code)
	line := buf.String()
	req.Contains(t, line, `"kid":"key-1"`)
	req.Contains(t, line, `"reason":"expired"`)
	req.Contains(t, line, `"client":"192.0.2.1"`)
	req.NotContains(t, line, "secret-token-text")
}

// One person, one name: the Entra object id is "subject" in every log line,
// and the identity field that is nil is left out rather than logged as the
// nil UUID (spec section 1, Logging a refusal).
func TestActorAttrsOmitTheIdentityFieldThatIsNil(t *testing.T) {
	tenant, subject, user := uuid.New(), uuid.New(), uuid.New()
	ctx := context.Background()

	bearer := fmt.Sprint(actorAttrs(ctx, Identity{TenantID: tenant, Subject: subject, SessionID: "sid:a"}))
	req.Contains(t, bearer, "subject "+subject.String())
	req.NotContains(t, bearer, "user")
	req.NotContains(t, bearer, uuid.Nil.String())

	dev := fmt.Sprint(actorAttrs(ctx, Identity{TenantID: tenant, UserID: user}))
	req.Contains(t, dev, "user "+user.String())
	req.NotContains(t, dev, "subject")
	req.NotContains(t, dev, uuid.Nil.String())
}

// A nil UUID parses but names no one. A nil user would reach InActorTx with
// neither identity set, and a nil tenant could only end in a lookup that
// finds nobody, so both are refused as a missing header is.
func TestHeaderResolverRefusesANilUUID(t *testing.T) {
	nilID := uuid.Nil.String()
	good := uuid.NewString()
	for _, tc := range []struct{ name, tenant, user string }{
		{"nil tenant", nilID, good},
		{"nil user", good, nilID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
			r.Header.Set("X-Tenant-ID", tc.tenant)
			r.Header.Set("X-User-ID", tc.user)
			_, err := HeaderActorResolver{}.Identify(context.Background(), r)
			req.ErrorIs(t, err, ErrUnauthenticated)
		})
	}
}

// A 500 is a resolver bug: the log says what failed as well as the
// resolver's own attributes.
func TestRequireActorLogsWhatFailedOnA500(t *testing.T) {
	buf := captureLog(t)
	rec := serveThrough(stubResolver{err: loggedRefusal{kind: errors.New("resolver bug")}}, "")
	req.Equal(t, http.StatusInternalServerError, rec.Code)
	req.Contains(t, buf.String(), `"err":"refused"`)
	req.Contains(t, buf.String(), `"kid":"key-1"`)
}

// requireActor, not the resolver, says where a request came from: the
// address NFR-SEC-007's counter keys on, in the form app.audit_log.source_ip
// stores (FR-AUD-002, TYRE-383). The resolver presets a Source in every case,
// so each want proves requireActor replaced it, the zero ones included, and
// an address the audit row cannot use never refuses the request.
func TestRequireActorSetsSourceFromTheClientAddress(t *testing.T) {
	preset := netip.MustParseAddr("198.51.100.1")
	cases := []struct {
		name   string
		xff    []string // one entry per header line, sent with Header.Add
		hops   int
		remote string
		want   netip.Addr
	}{
		{"the trusted forwarded hop", []string{"9.9.9.9, 203.0.113.9:51712"}, 1, "10.0.0.4:443",
			netip.MustParseAddr("203.0.113.9")},
		{"the second trusted hop from the right", []string{"9.9.9.9, 203.0.113.9:51712, 10.10.10.5:443"}, 2, "10.0.0.4:443",
			netip.MustParseAddr("203.0.113.9")},
		{"RemoteAddr with no forwarded header", nil, 1, "192.0.2.7:1234",
			netip.MustParseAddr("192.0.2.7")},
		{"RemoteAddr when no hop is trusted", []string{"203.0.113.9"}, 0, "192.0.2.7:1234",
			netip.MustParseAddr("192.0.2.7")},
		{"a zone is stripped", nil, 1, "[fe80::1%eth0]:443",
			netip.MustParseAddr("fe80::1")},
		{"an IPv4-mapped trusted hop on its own header line is unmapped", []string{"9.9.9.9", "::ffff:203.0.113.9"}, 1, "10.0.0.4:443",
			netip.MustParseAddr("203.0.113.9")},
		{"an IPv6 hop stays IPv6", []string{"2001:db8::1"}, 1, "10.0.0.4:443",
			netip.MustParseAddr("2001:db8::1")},
		{"a hop that is not an address is the zero Addr", []string{"unknown"}, 1, "10.0.0.4:443",
			netip.Addr{}},
		{"a bracketed IPv6 hop with no port is the zero Addr", []string{"[2001:db8::1]"}, 1, "10.0.0.4:443",
			netip.Addr{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got Identity
			reached := false
			resolver := stubResolver{id: Identity{TenantID: uuid.New(), UserID: uuid.New(), Source: preset}}
			h := requireActor(resolver, tc.hops)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, reached = identityFrom(r.Context())
				w.WriteHeader(http.StatusOK)
			}))
			r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
			r.RemoteAddr = tc.remote
			for _, line := range tc.xff {
				r.Header.Add("X-Forwarded-For", line)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			req.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			req.True(t, reached, "the handler never saw an identity")
			req.Equal(t, tc.want, got.Source)
		})
	}
}
