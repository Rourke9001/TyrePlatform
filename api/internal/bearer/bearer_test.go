package bearer_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/bearer/bearertest"
	"tyreplatform/api/internal/httpapi"
)

func newResolver(t *testing.T, idp *bearertest.IdP, opts ...bearer.Option) *bearer.Resolver {
	t.Helper()
	r := bearer.New(idp.Config(), opts...)
	t.Cleanup(r.Close)
	return r
}

func request(token string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return r
}

func logAttrs(t *testing.T, err error) string {
	t.Helper()
	var la interface{ LogAttrs() []any }
	require.True(t, errors.As(err, &la), "a refusal must say what may be logged")
	return fmt.Sprint(la.LogAttrs())
}

func TestIdentifyAcceptsAValidToken(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	subject, tenant := uuid.New(), uuid.New()
	claims := idp.Claims(subject, tenant)

	id, err := r.Identify(context.Background(), request(idp.Mint(t, claims)))
	require.NoError(t, err)
	require.Equal(t, httpapi.Identity{TenantID: tenant, Subject: subject, SessionID: "sid:" + claims["sid"].(string)}, id)
}

// Spec section 1, steps 1 to 9. Each case changes one thing about a claim set
// the control shows is accepted.
func TestIdentifyRefusesEachBadTokenWith401(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	ctx := context.Background()
	now := time.Now()
	valid := func() jwt.MapClaims { return idp.Claims(uuid.New(), uuid.New()) }
	with := func(k string, v any) jwt.MapClaims { c := valid(); c[k] = v; return c }
	without := func(keys ...string) jwt.MapClaims {
		c := valid()
		for _, k := range keys {
			delete(c, k)
		}
		return c
	}
	kid := map[string]any{"kid": bearertest.Kid}

	_, err := r.Identify(ctx, request(idp.Mint(t, valid())))
	require.NoError(t, err, "control: the unaltered claim set is accepted")

	cases := []struct{ name, token string }{
		{"no token", ""},
		{"not a JWT", "not.a.jwt"},
		{"alg none", idp.MintWith(t, jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, kid, valid())},
		{"HS256 keyed with the public key", idp.MintWith(t, jwt.SigningMethodHS256, idp.PublicKeyPEM(t), kid, valid())},
		// keyfunc tries every key when the header names none, so without the
		// resolver's own check this token would verify.
		{"no kid", idp.MintWith(t, jwt.SigningMethodRS256, idp.Key(), nil, valid())},
		{"signed by another key under the set's kid", idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(), kid, valid())},
		{"wrong iss", idp.Mint(t, with("iss", "https://someone-else.example/v2.0"))},
		{"wrong aud", idp.Mint(t, with("aud", uuid.NewString()))},
		{"wrong azp", idp.Mint(t, with("azp", uuid.NewString()))},
		{"v1 token", idp.Mint(t, with("ver", "1.0"))},
		{"wrong tid", idp.Mint(t, with("tid", uuid.NewString()))},
		{"a scope that only starts with access_as_user", idp.Mint(t, with("scp", "access_as_user_admin"))},
		{"no access_as_user scope", idp.Mint(t, with("scp", "openid profile"))},
		{"expired past the leeway", idp.Mint(t, with("exp", now.Add(-3*time.Minute).Unix()))},
		{"no exp", idp.Mint(t, without("exp"))},
		{"nbf beyond the leeway", idp.Mint(t, with("nbf", now.Add(3*time.Minute).Unix()))},
		{"malformed oid", idp.Mint(t, with("oid", "not-a-uuid"))},
		{"no sid and no uti", idp.Mint(t, without("sid", "uti"))},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := r.Identify(ctx, request(tc.token))
			require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
		})
	}
}

func TestIdentifyAllowsTwoMinutesOfClockSkew(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	now := time.Now()
	for name, change := range map[string]func(jwt.MapClaims){
		"expired a minute ago":   func(c jwt.MapClaims) { c["exp"] = now.Add(-time.Minute).Unix() },
		"valid from a minute on": func(c jwt.MapClaims) { c["nbf"] = now.Add(time.Minute).Unix() },
	} {
		t.Run(name, func(t *testing.T) {
			c := idp.Claims(uuid.New(), uuid.New())
			change(c)
			_, err := r.Identify(context.Background(), request(idp.Mint(t, c)))
			require.NoError(t, err)
		})
	}
}

func TestIdentifyAcceptsAccessAsUserAmongOtherScopes(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	c := idp.Claims(uuid.New(), uuid.New())
	c["scp"] = "openid access_as_user profile"
	_, err := r.Identify(context.Background(), request(idp.Mint(t, c)))
	require.NoError(t, err)
}

// Without sid every hourly token is a new session (FR-AUD-002), so sid wins
// when both are present and uti is the fallback.
func TestTheSessionIDPrefersSidOverUti(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	ctx := context.Background()

	both := idp.Claims(uuid.New(), uuid.New())
	id, err := r.Identify(ctx, request(idp.Mint(t, both)))
	require.NoError(t, err)
	require.Equal(t, "sid:"+both["sid"].(string), id.SessionID, "sid wins when the token carries both")

	utiOnly := idp.Claims(uuid.New(), uuid.New())
	delete(utiOnly, "sid")
	id, err = r.Identify(ctx, request(idp.Mint(t, utiOnly)))
	require.NoError(t, err)
	require.Equal(t, "uti:"+utiOnly["uti"].(string), id.SessionID, "uti names the session when sid is absent")
}

// A valid person with no platform tenant is a 403 the outbox holds, not a
// 401 that sends them round the sign-in again (spec section 1, step 10).
func TestIdentifyRefusesAMissingOrMalformedTenantClaimWith403(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	missing := idp.Claims(uuid.New(), uuid.New())
	delete(missing, bearertest.TenantClaim)
	malformed := idp.Claims(uuid.New(), uuid.New())
	malformed[bearertest.TenantClaim] = "sandbox fleet"
	for name, c := range map[string]jwt.MapClaims{"missing": missing, "malformed": malformed} {
		t.Run(name, func(t *testing.T) {
			_, err := r.Identify(context.Background(), request(idp.Mint(t, c)))
			require.ErrorIs(t, err, httpapi.ErrNotProvisioned)
		})
	}
}

// RFC 7235 section 2.1 makes the auth scheme case-insensitive.
func TestIdentifyAcceptsALowerCaseScheme(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	req := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	req.Header.Set("Authorization", "bearer "+idp.Mint(t, idp.Claims(uuid.New(), uuid.New())))
	_, err := r.Identify(context.Background(), req)
	require.NoError(t, err)
}

// The tenant claim is a UUID (spec section 1, step 10), so its upper-case
// spelling binds the same tenant. A string comparison would split one tenant
// in two.
func TestAnUpperCaseTenantClaimYieldsTheCanonicalUUID(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	tenant := uuid.New()
	c := idp.Claims(uuid.New(), tenant)
	c[bearertest.TenantClaim] = strings.ToUpper(tenant.String())
	id, err := r.Identify(context.Background(), request(idp.Mint(t, c)))
	require.NoError(t, err)
	require.Equal(t, tenant, id.TenantID)
}

// An unknown kid refetches the set once; a second within the limiter's five
// minutes is refused at once, never waiting past a second and never a 503.
func TestAnUnknownKidRefetchesOnceThenRefusesWithinASecond(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	ctx := context.Background()
	_, err := r.Identify(ctx, request(idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))))
	require.NoError(t, err, "control: the key set loads")
	loads := idp.JWKSHits.Load()

	rotated := func(kid string) string {
		return idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(), map[string]any{"kid": kid}, idp.Claims(uuid.New(), uuid.New()))
	}
	_, err = r.Identify(ctx, request(rotated("rotated-1")))
	require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
	require.Equal(t, loads+1, idp.JWKSHits.Load(), "an unknown kid refetches the set once")

	start := time.Now()
	_, err = r.Identify(ctx, request(rotated("rotated-2")))
	require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
	require.Less(t, time.Since(start), 1500*time.Millisecond)
	require.Equal(t, loads+1, idp.JWKSHits.Load(), "a spent limiter does not refetch")
}

// jwkset spends one deadline on the limiter and the refetch together, so a
// stalled Entra refuses within the same second.
func TestAStalledRefetchRefusesWithinASecond(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	ctx := context.Background()
	_, err := r.Identify(ctx, request(idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))))
	require.NoError(t, err, "control: the key set loads")
	idp.StallJWKS(5 * time.Second)

	start := time.Now()
	_, err = r.Identify(ctx, request(idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(),
		map[string]any{"kid": "rotated"}, idp.Claims(uuid.New(), uuid.New()))))
	require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
	require.Less(t, time.Since(start), 1500*time.Millisecond)
}

func TestUnreachableDiscoveryAnswers503AndRecovers(t *testing.T) {
	idp := bearertest.New(t)
	idp.SetDiscoveryStatus(http.StatusServiceUnavailable)
	r := newResolver(t, idp)
	ctx := context.Background()
	token := idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))

	_, err := r.Identify(ctx, request(token))
	require.ErrorIs(t, err, httpapi.ErrAuthUnavailable)

	idp.SetDiscoveryStatus(http.StatusOK)
	_, err = r.Identify(ctx, request(token))
	require.NoError(t, err, "a failed load is not cached")
	require.EqualValues(t, 2, idp.DiscoveryHits.Load())
}

// Steps 1 and 2 need no key set, so a token that fails them is a 401 while
// Entra is down, not the 503 a key-set failure would give.
func TestAMalformedTokenIs401EvenWhileEntraIsDown(t *testing.T) {
	idp := bearertest.New(t)
	idp.SetDiscoveryStatus(http.StatusServiceUnavailable)
	r := newResolver(t, idp)
	noKID := idp.MintWith(t, jwt.SigningMethodRS256, idp.Key(), nil, idp.Claims(uuid.New(), uuid.New()))
	hs256 := idp.MintWith(t, jwt.SigningMethodHS256, idp.PublicKeyPEM(t), map[string]any{"kid": bearertest.Kid}, idp.Claims(uuid.New(), uuid.New()))
	for name, token := range map[string]string{"no kid": noKID, "HS256": hs256, "not a JWT": "not.a.jwt"} {
		t.Run(name, func(t *testing.T) {
			_, err := r.Identify(context.Background(), request(token))
			require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
		})
	}
	require.Zero(t, idp.DiscoveryHits.Load(), "none of them needed the key set")
}

func TestAnIdentityProviderThatIsGoneAnswers503(t *testing.T) {
	idp := bearertest.New(t)
	token := idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))
	r := newResolver(t, idp)
	idp.Server.Close()
	_, err := r.Identify(context.Background(), request(token))
	require.ErrorIs(t, err, httpapi.ErrAuthUnavailable)
}

func TestADiscoveryIssuerMismatchAnswers503NamingBothValues(t *testing.T) {
	idp := bearertest.New(t)
	idp.SetDiscoveryIssuer("https://someone-else.example/v2.0")
	r := newResolver(t, idp)
	_, err := r.Identify(context.Background(), request(idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))))
	require.ErrorIs(t, err, httpapi.ErrAuthUnavailable)
	attrs := logAttrs(t, err)
	require.Contains(t, attrs, "https://someone-else.example/v2.0")
	require.Contains(t, attrs, idp.Issuer())
}

// Waiters on a failed load all get its answer. Without sharing, each would
// start its own and discovery would be hit ten times.
func TestRequestsArrivingDuringALoadShareIt(t *testing.T) {
	idp := bearertest.New(t)
	idp.SetDiscoveryStatus(http.StatusServiceUnavailable)
	release := idp.HoldDiscovery()
	r := newResolver(t, idp)
	token := idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))

	errs := make(chan error, 10)
	for i := 0; i < 10; i++ {
		go func() {
			_, err := r.Identify(context.Background(), request(token))
			errs <- err
		}()
	}
	require.Eventually(t, func() bool { return idp.DiscoveryHits.Load() == 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond) // let the other nine reach the wait
	release()
	for i := 0; i < 10; i++ {
		require.ErrorIs(t, <-errs, httpapi.ErrAuthUnavailable)
	}
	require.EqualValues(t, 1, idp.DiscoveryHits.Load())
}

// Concurrent requests share one load (spec section 1, Loading the keys), so a
// caller who hangs up gets its 503 at once and the load it started still
// lands for everyone else.
func TestARequestThatHangsUpDoesNotFailTheLoadForOthers(t *testing.T) {
	idp := bearertest.New(t)
	release := idp.HoldDiscovery()
	r := newResolver(t, idp)
	token := idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := r.Identify(ctx, request(token))
		done <- err
	}()
	require.Eventually(t, func() bool { return idp.DiscoveryHits.Load() == 1 }, time.Second, 5*time.Millisecond)
	cancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, httpapi.ErrAuthUnavailable)
	case <-time.After(time.Second):
		t.Fatal("a cancelled request waited for the load")
	}
	release()
	_, err := r.Identify(context.Background(), request(token))
	require.NoError(t, err)
	require.EqualValues(t, 1, idp.DiscoveryHits.Load(), "the detached load finished and was kept")
}

// jwkset starts its refresh goroutine before the first fetch, so a failed
// load must end it or it fetches forever.
func TestAFailedKeyLoadStopsItsRefreshGoroutine(t *testing.T) {
	idp := bearertest.New(t)
	idp.SetJWKSStatus(http.StatusInternalServerError)
	r := newResolver(t, idp, bearer.WithRefreshInterval(20*time.Millisecond))
	_, err := r.Identify(context.Background(), request(idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))))
	require.ErrorIs(t, err, httpapi.ErrAuthUnavailable)
	hits := idp.JWKSHits.Load()
	time.Sleep(200 * time.Millisecond)
	require.Equal(t, hits, idp.JWKSHits.Load())
}

// jwkset replaces its keys only on a good fetch. The control shows the
// refresh did run and fail at the same interval.
func TestAFailedBackgroundRefreshKeepsTheCachedKeys(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp, bearer.WithRefreshInterval(20*time.Millisecond))
	ctx := context.Background()
	token := idp.Mint(t, idp.Claims(uuid.New(), uuid.New()))
	_, err := r.Identify(ctx, request(token))
	require.NoError(t, err)

	idp.SetJWKSStatus(http.StatusInternalServerError)
	hits := idp.JWKSHits.Load()
	require.Eventually(t, func() bool { return idp.JWKSHits.Load() > hits+1 }, 2*time.Second, 10*time.Millisecond,
		"control: the background refresh runs and fails")
	_, err = r.Identify(ctx, request(token))
	require.NoError(t, err)
}

// Spec section 1, Logging a refusal: before the signature verifies only the
// kid may be logged, after it the verified claims, and never the token.
func TestARefusalSaysOnlyWhatMayBeLogged(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	ctx := context.Background()
	subject := uuid.New()

	forged := idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(), map[string]any{"kid": bearertest.Kid}, idp.Claims(subject, uuid.New()))
	_, err := r.Identify(ctx, request(forged))
	attrs := logAttrs(t, err)
	require.Contains(t, attrs, bearertest.Kid)
	require.NotContains(t, attrs, subject.String(), "a forged token's claims are the caller's choice")
	require.NotContains(t, attrs, forged)
	// requireActor logs Error() as well on its 500 path.
	require.NotContains(t, err.Error(), subject.String())
	require.NotContains(t, err.Error(), forged)

	c := idp.Claims(subject, uuid.New())
	c["azp"] = uuid.NewString()
	wrongClient := idp.Mint(t, c)
	_, err = r.Identify(ctx, request(wrongClient))
	attrs = logAttrs(t, err)
	require.Contains(t, attrs, subject.String(), "a verified token's oid names who was refused")
	require.NotContains(t, attrs, wrongClient)
}

// Spec section 7, Logging: the same two refusals read from the slog line
// requireActor writes. Not parallel: slog's default is process-wide.
func TestTheRefusalLogLineNamesOnlyVerifiedClaimsAndNeverTheToken(t *testing.T) {
	idp := bearertest.New(t)
	// A refused request never reaches a handler, so no store is needed.
	h := httpapi.New(nil, newResolver(t, idp))
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	refuse := func(token string) string {
		t.Helper()
		buf.Reset()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, request(token))
		require.Equal(t, http.StatusUnauthorized, rec.Code)
		line := buf.String()
		for _, part := range strings.Split(token, ".") {
			require.NotContains(t, line, part, "no part of the token is logged")
		}
		return line
	}
	subject := uuid.New()

	line := refuse(idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(), map[string]any{"kid": bearertest.Kid}, idp.Claims(subject, uuid.New())))
	require.Contains(t, line, bearertest.Kid)
	require.NotContains(t, line, subject.String(), "a forged token's oid is the caller's choice")

	c := idp.Claims(subject, uuid.New())
	c["azp"] = uuid.NewString()
	line = refuse(idp.Mint(t, c))
	require.Contains(t, line, subject.String(), "a token refused at step 5 has verified, so its oid is logged")
}

// Spec section 1, Logging a refusal: before the signature verifies the kid is
// whatever the caller sent, so the log caps it.
func TestAnOversizedKidIsCappedInTheLog(t *testing.T) {
	idp := bearertest.New(t)
	r := newResolver(t, idp)
	long := strings.Repeat("k", 10_000)
	token := idp.MintWith(t, jwt.SigningMethodRS256, idp.OtherKey(), map[string]any{"kid": long}, idp.Claims(uuid.New(), uuid.New()))
	_, err := r.Identify(context.Background(), request(token))
	require.ErrorIs(t, err, httpapi.ErrUnauthenticated)
	require.NotContains(t, logAttrs(t, err), strings.Repeat("k", 65))
	require.NotContains(t, err.Error(), strings.Repeat("k", 65), "jwkset quotes an unknown kid in full")
}
