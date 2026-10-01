package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	// Aliased: this file shares package httpapi (deliberately, for
	// newRateLimiter access) with httpapi.go's own capability-check function
	// named require, so the unaliased import would shadow it.
	req "github.com/stretchr/testify/require"
)

// TestRateLimiterAllowsUpToTheLimitThenRefuses pins the whole sequence, not
// only the last call: asserting merely that the fourth of four calls is
// refused would also pass if the first had been wrongly refused.
func TestRateLimiterAllowsUpToTheLimitThenRefuses(t *testing.T) {
	l := newRateLimiter(2)
	now := time.Now()

	got := []bool{
		l.allow("acct-1", now),
		l.allow("acct-1", now),
		l.allow("acct-1", now),
		l.allow("acct-1", now),
	}
	req.Equal(t, []bool{true, true, false, false}, got)
}

// TestRateLimiterWindowTurnsOver drives the clock forward through the `now`
// parameter rather than a real sleep or a fake timer, since allow() already
// takes it as an argument.
func TestRateLimiterWindowTurnsOver(t *testing.T) {
	l := newRateLimiter(1)
	now := time.Now()

	req.True(t, l.allow("acct-1", now))
	req.False(t, l.allow("acct-1", now), "second request in the same minute is over the limit of 1")
	req.True(t, l.allow("acct-1", now.Add(61*time.Second)),
		"a new minute must not still be refusing on the previous one's overflow")
}

// TestSubmitRateLimitTracksTwoIndependentAxes pins NFR-SEC-007's "per account
// and per source address": one account rotating source addresses must not
// multiply its own limit, and one address rotating accounts must not
// multiply the address limit either, each axis is a separate counter,
// never a combined key.
func TestSubmitRateLimitTracksTwoIndependentAxes(t *testing.T) {
	t.Run("one account from two addresses shares the account counter", func(t *testing.T) {
		account := newRateLimiter(2)
		now := time.Now()
		req.True(t, account.allow("user-1", now), "request from address A")
		req.True(t, account.allow("user-1", now), "request from address B")
		req.False(t, account.allow("user-1", now),
			"a third request from yet another address still exceeds the account's own limit")
	})

	t.Run("one address from two accounts shares the address counter", func(t *testing.T) {
		address := newRateLimiter(2)
		now := time.Now()
		req.True(t, address.allow("10.0.0.1", now), "request from account 1")
		req.True(t, address.allow("10.0.0.1", now), "request from account 2")
		req.False(t, address.allow("10.0.0.1", now),
			"a third account sharing this NAT address still exceeds the address's own limit")
	})
}

// TestClientAddressUsesRightmostForwardedForHop pins clientAddress's address
// derivation case by case; clientAddress's own doc comment carries why the
// Nth-from-right entry is the only one the caller cannot forge.
func TestClientAddressUsesRightmostForwardedForHop(t *testing.T) {
	tests := []struct {
		name string
		// Each entry is added as its own X-Forwarded-For header LINE (via
		// Header.Add, in order), not comma-joined here, clientAddress says
		// why both header forms must read the same. A nil/empty slice means
		// the header is not sent at all.
		xff         []string
		trustedHops int
		remote      string
		want        string
	}{
		{
			name:        "single hop with a port is stripped to the host",
			xff:         []string{"203.0.113.9:51712"},
			trustedHops: 1,
			remote:      "10.0.0.4:443",
			want:        "203.0.113.9",
		},
		{
			name:        "a forged leftmost entry within one line is ignored in favour of the trusted rightmost one",
			xff:         []string{"9.9.9.9, 203.0.113.9:51712"},
			trustedHops: 1,
			remote:      "10.0.0.4:443",
			want:        "203.0.113.9",
		},
		{
			name: "a forged entry on its own EARLIER header line is ignored in favour of the real LAST line",
			// The separate-line form: the caller's forged line arrives first,
			// the trusted ingress line last (clientAddress).
			xff:         []string{"9.9.9.9", "203.0.113.9:51712"},
			trustedHops: 1,
			remote:      "10.0.0.4:443",
			want:        "203.0.113.9",
		},
		{
			name:        "no header falls back to RemoteAddr",
			xff:         nil,
			trustedHops: 1,
			remote:      "192.0.2.7:1234",
			want:        "192.0.2.7",
		},
		{
			name:        "a header present but blank falls back to RemoteAddr",
			xff:         []string{"   "},
			trustedHops: 1,
			remote:      "192.0.2.7:1234",
			want:        "192.0.2.7",
		},
		{
			name: "two trusted hops (an L7 hop in front of the ingress) picks second-from-right",
			// What the counter should key on is one entry further in than the
			// outer hop's own rightmost entry (clientAddress).
			xff:         []string{"9.9.9.9, 203.0.113.9:51712, 10.10.10.5:443"},
			trustedHops: 2,
			remote:      "10.0.0.4:443",
			want:        "203.0.113.9",
		},
		{
			name: "fewer entries than the configured trusted-hop count falls back to RemoteAddr",
			// The topology says two trusted hops appended entries; one hop's
			// worth is present. clientAddress says why a mismatch must not be
			// resolved by indexing into caller-supplied territory.
			xff:         []string{"203.0.113.9:51712"},
			trustedHops: 2,
			remote:      "192.0.2.7:1234",
			want:        "192.0.2.7",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
			hreq.RemoteAddr = tt.remote
			for _, line := range tt.xff {
				hreq.Header.Add("X-Forwarded-For", line)
			}
			req.Equal(t, tt.want, clientAddress(hreq, tt.trustedHops))
		})
	}
}

// TestSubmitRateLimitKeysAddressOnRightmostForwardedForHop drives the same
// scenario through requireActor and submitRateLimit's actual address
// counter, as New wires them, not just clientAddress in isolation: a forged
// leftmost entry must not buy a fresh address bucket, and a genuinely
// different rightmost hop must land in a different one. The account limiter
// is set high enough that only the address axis can trip in this test.
func TestSubmitRateLimitKeysAddressOnRightmostForwardedForHop(t *testing.T) {
	limiter := submitRateLimit(newRateLimiter(100), newRateLimiter(2))
	h := requireActor(HeaderActorResolver{}, 1)(limiter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))

	send := func(forwardedFor string) int {
		hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
		hreq.RemoteAddr = "10.0.0.4:443" // the ingress hop: identical on every call
		if forwardedFor != "" {
			hreq.Header.Set("X-Forwarded-For", forwardedFor)
		}
		hreq.Header.Set("X-Tenant-ID", uuid.NewString())
		hreq.Header.Set("X-User-ID", uuid.NewString())
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, hreq)
		return rec.Code
	}

	req.Equal(t, http.StatusOK, send("9.9.9.9, 203.0.113.9:1"))
	req.Equal(t, http.StatusOK, send("8.8.8.8, 203.0.113.9:2"),
		"a different forged leftmost entry shares the same rightmost hop, and so the same address bucket")
	req.Equal(t, http.StatusTooManyRequests, send("7.7.7.7, 203.0.113.9:3"),
		"the third request against the unchanged rightmost hop exceeds the two-per-minute address limit")
	req.Equal(t, http.StatusOK, send("203.0.113.50:1"),
		"a genuinely different rightmost hop is a fresh address bucket")
}

// The address counter keys on the client requireActor bound, so the limiter
// and the refusal log (FR-AUD-004) name one address, derived once.
func TestSubmitRateLimitKeysAddressOnTheBoundClient(t *testing.T) {
	limiter := submitRateLimit(newRateLimiter(100), newRateLimiter(1))
	h := limiter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	send := func(client, remoteAddr string) int {
		hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
		hreq.RemoteAddr = remoteAddr
		ctx := context.WithValue(hreq.Context(), clientKey{}, client)
		id := Identity{TenantID: uuid.New(), UserID: uuid.New()}
		hreq = hreq.WithContext(context.WithValue(ctx, identityKey{}, id))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, hreq)
		return rec.Code
	}

	req.Equal(t, http.StatusOK, send("203.0.113.1", "10.0.0.4:443"))
	req.Equal(t, http.StatusOK, send("203.0.113.2", "10.0.0.4:443"),
		"a different bound client is a different bucket, over the same socket")
	req.Equal(t, http.StatusTooManyRequests, send("203.0.113.1", "10.0.0.5:443"),
		"the same bound client is the same bucket, over a different socket")
}

// TestSubmitRateLimitMiddlewareRefusesOverLimit exercises submitRateLimit
// itself (not just the underlying counters), asserting the full sequence of
// four requests rather than only the last: asserting only the last would
// also pass if the first had been wrongly refused.
func TestSubmitRateLimitMiddlewareRefusesOverLimit(t *testing.T) {
	limiter := submitRateLimit(newRateLimiter(2), newRateLimiter(100))
	h := limiter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	id := Identity{TenantID: uuid.New(), UserID: uuid.New()}
	var codes []int
	var lastRec *httptest.ResponseRecorder
	for i := 0; i < 4; i++ {
		hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
		hreq = hreq.WithContext(context.WithValue(hreq.Context(), identityKey{}, id))
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, hreq)
		codes = append(codes, rec.Code)
		lastRec = rec
	}
	req.Equal(t,
		[]int{http.StatusOK, http.StatusOK, http.StatusTooManyRequests, http.StatusTooManyRequests},
		codes)
	req.Equal(t, "60", lastRec.Header().Get("Retry-After"),
		"Retry-After must derive from the window constant, not repeat a literal")
}

// TestSubmitRateLimitRefusesWithoutIdentity: arriving at the limiter with no
// identity bound is TY010's invariant breach, not a client mistake, so the
// honest answer is 500 rather than 401 or 429.
func TestSubmitRateLimitRefusesWithoutIdentity(t *testing.T) {
	limiter := submitRateLimit(newRateLimiter(10), newRateLimiter(10))
	h := limiter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, hreq)

	req.Equal(t, http.StatusInternalServerError, rec.Code)
}

// TestRequireActorRunsBeforeInlineRateLimitMiddleware is empirical proof that
// the identity submitRateLimit depends on is genuinely present: it builds
// the same shape New() wires: requireActor registered with r.Use on the
// /api group, the rate limiter attached with an inline r.With() on one
// route. It shows the identity requireActor resolves is visible inside
// the inline middleware. Were chi's ordering the other way round,
// submitRateLimit would find no identity and refuse with 500 before the
// no-op handler below ever ran.
func TestRequireActorRunsBeforeInlineRateLimitMiddleware(t *testing.T) {
	router := chi.NewRouter()
	limiter := submitRateLimit(newRateLimiter(10), newRateLimiter(10))
	router.Route("/api", func(r chi.Router) {
		r.Use(requireActor(HeaderActorResolver{}, 1))
		r.With(limiter).Post("/inspections", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	})

	hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
	hreq.Header.Set("X-Tenant-ID", uuid.NewString())
	hreq.Header.Set("X-User-ID", uuid.NewString())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, hreq)

	req.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// Each case is a set of accounts at a one-per-minute account limit, so a
// second request landing in an earlier account's bucket would be refused.
func TestSubmitRateLimitGivesEachBearerAccountItsOwnBucket(t *testing.T) {
	tenant, subject := uuid.New(), uuid.New()
	tests := []struct {
		name string
		ids  []Identity
	}{
		// Bearer identities carry no user id, so keying on UserID alone would
		// put every signed-in person in one bucket (spec section 1, Rate limit).
		{"each subject in one tenant", []Identity{
			{TenantID: tenant, Subject: uuid.New(), SessionID: "sid:a"},
			{TenantID: tenant, Subject: uuid.New(), SessionID: "sid:b"},
		}},
		// A subject is unique only within a tenant (000052), so the same
		// subject under a second tenant is a different account.
		{"one subject in each tenant", []Identity{
			{TenantID: uuid.New(), Subject: subject, SessionID: "sid:a"},
			{TenantID: uuid.New(), Subject: subject, SessionID: "sid:b"},
			{TenantID: uuid.New(), Subject: subject, SessionID: "sid:c"},
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			limiter := submitRateLimit(newRateLimiter(1), newRateLimiter(100))
			h := limiter(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			var codes, want []int
			for _, id := range tt.ids {
				hreq := httptest.NewRequest(http.MethodPost, "/api/inspections", nil)
				hreq = hreq.WithContext(context.WithValue(hreq.Context(), identityKey{}, id))
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, hreq)
				codes = append(codes, rec.Code)
				want = append(want, http.StatusOK)
			}
			req.Equal(t, want, codes)
		})
	}
}
