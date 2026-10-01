// Package bearertest stands in for Entra External ID in tests. It serves a
// discovery document and a key set for one RSA key and mints tokens for it
// (ADR-0016, spec section 7). Only _test.go files import it.
package bearertest

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"tyreplatform/api/internal/bearer"
)

// Fixed identifiers the minted tokens carry. Test values, not the CIAM
// tenant's.
const (
	TenantID    = "0c0ffee0-0000-4000-8000-000000000001"
	Audience    = "0c0ffee0-0000-4000-8000-000000000002"
	ClientID    = "0c0ffee0-0000-4000-8000-000000000003"
	TenantClaim = "extension_test_platformTenantId"
	Kid         = "test-key-1"
)

type IdP struct {
	Server        *httptest.Server
	DiscoveryHits atomic.Int64
	JWKSHits      atomic.Int64

	key   *rsa.PrivateKey
	other *rsa.PrivateKey

	mu              sync.Mutex
	discoveryStatus int
	discoveryIssuer string
	jwksStatus      int
	jwksStall       time.Duration
	hold            chan struct{}
}

func New(t testing.TB) *IdP {
	t.Helper()
	served, other := testKeys(t)
	p := &IdP{key: served, other: other, discoveryStatus: http.StatusOK, jwksStatus: http.StatusOK}
	mux := http.NewServeMux()
	mux.HandleFunc("/discovery", p.serveDiscovery)
	mux.HandleFunc("/keys", p.serveKeys)
	p.Server = httptest.NewServer(mux)
	t.Cleanup(p.Server.Close)
	return p
}

var (
	keysOnce          sync.Once
	servedKey, altKey *rsa.PrivateKey
	keysErr           error
)

// testKeys generates the two RSA keys once per test binary, because a
// 2048-bit key takes long enough that one pair per test would slow the
// package down.
func testKeys(t testing.TB) (served, other *rsa.PrivateKey) {
	t.Helper()
	keysOnce.Do(func() {
		if servedKey, keysErr = rsa.GenerateKey(rand.Reader, 2048); keysErr != nil {
			return
		}
		altKey, keysErr = rsa.GenerateKey(rand.Reader, 2048)
	})
	if keysErr != nil {
		t.Fatalf("generating the test keys: %v", keysErr)
	}
	return servedKey, altKey
}

func (p *IdP) Issuer() string { return p.Server.URL + "/" + TenantID + "/v2.0" }

func (p *IdP) Config() bearer.Config {
	return bearer.Config{
		DiscoveryURL: p.Server.URL + "/discovery?appid=" + Audience,
		Issuer:       p.Issuer(),
		TenantID:     TenantID,
		Audience:     Audience,
		ClientID:     ClientID,
		TenantClaim:  TenantClaim,
	}
}

// Claims is a claim set the resolver accepts for this person and platform
// tenant.
func (p *IdP) Claims(subject, tenant uuid.UUID) jwt.MapClaims {
	now := time.Now()
	return jwt.MapClaims{
		"iss": p.Issuer(), "aud": Audience, "azp": ClientID, "tid": TenantID, "ver": "2.0",
		"scp": "access_as_user", "oid": subject.String(), "sub": "pairwise-" + subject.String(),
		"sid": "session-" + uuid.NewString(), "uti": uuid.NewString(),
		"iat": now.Unix(), "nbf": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		TenantClaim: tenant.String(),
	}
}

// Mint signs claims with the served key under Kid.
func (p *IdP) Mint(t testing.TB, claims jwt.MapClaims) string {
	return p.MintWith(t, jwt.SigningMethodRS256, p.key, map[string]any{"kid": Kid}, claims)
}

// MintWith signs with any method, key and header, for the refusal cases.
func (p *IdP) MintWith(t testing.TB, method jwt.SigningMethod, key any, header map[string]any, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(method, claims)
	for k, v := range header {
		tok.Header[k] = v
	}
	s, err := tok.SignedString(key)
	if err != nil {
		t.Fatalf("signing a test token: %v", err)
	}
	return s
}

func (p *IdP) Key() *rsa.PrivateKey      { return p.key }
func (p *IdP) OtherKey() *rsa.PrivateKey { return p.other }

// PublicKeyPEM is the served key's public half, which the HS256
// algorithm-confusion case uses as its secret.
func (p *IdP) PublicKeyPEM(t testing.TB) []byte {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(&p.key.PublicKey)
	if err != nil {
		t.Fatalf("encoding the test public key: %v", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
}

func (p *IdP) SetDiscoveryStatus(code int)   { p.mu.Lock(); p.discoveryStatus = code; p.mu.Unlock() }
func (p *IdP) SetDiscoveryIssuer(iss string) { p.mu.Lock(); p.discoveryIssuer = iss; p.mu.Unlock() }
func (p *IdP) SetJWKSStatus(code int)        { p.mu.Lock(); p.jwksStatus = code; p.mu.Unlock() }
func (p *IdP) StallJWKS(d time.Duration)     { p.mu.Lock(); p.jwksStall = d; p.mu.Unlock() }

// HoldDiscovery makes discovery wait until release is called.
func (p *IdP) HoldDiscovery() (release func()) {
	hold := make(chan struct{})
	p.mu.Lock()
	p.hold = hold
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		p.hold = nil
		p.mu.Unlock()
		close(hold)
	}
}

func (p *IdP) serveDiscovery(w http.ResponseWriter, r *http.Request) {
	p.DiscoveryHits.Add(1)
	p.mu.Lock()
	status, iss, hold := p.discoveryStatus, p.discoveryIssuer, p.hold
	p.mu.Unlock()
	if hold != nil {
		select {
		case <-hold:
		case <-r.Context().Done():
			return
		}
	}
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	if iss == "" {
		iss = p.Issuer()
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"issuer": iss, "jwks_uri": p.Server.URL + "/keys"})
}

func (p *IdP) serveKeys(w http.ResponseWriter, r *http.Request) {
	p.JWKSHits.Add(1)
	p.mu.Lock()
	status, stall := p.jwksStatus, p.jwksStall
	p.mu.Unlock()
	if stall > 0 {
		select {
		case <-time.After(stall):
		case <-r.Context().Done():
			return
		}
	}
	if status != http.StatusOK {
		w.WriteHeader(status)
		return
	}
	pub := p.key.PublicKey
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "use": "sig", "alg": "RS256", "kid": Kid,
		"n": base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
	}}})
}
