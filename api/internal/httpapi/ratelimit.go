package httpapi

import (
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NFR-SEC-007: rate-limit submission per account and per source address.
// Submission is the only endpoint this slice adds; authentication has none
// yet (FR-AUT-001 is still the dev header resolver). Two independent
// counters, not a composite key, because a key of account+address lets one
// account rotating N addresses get N times the account limit
// (submitRateLimit refuses if EITHER counter refuses). The account limit
// (60/min) is far above human capture rate and far below a retry loop's; the
// address limit is 10x that because a depot's drivers share one NAT egress
// address. Both are Go constants: rule 5 governs tenant policy, and a rate
// limit is an operational transport control, built once at router
// construction with no tenant in scope.
const (
	accountSubmitsPerMinute = 60
	addressSubmitsPerMinute = 10 * accountSubmitsPerMinute
	rateLimitWindow         = time.Minute
)

// rateLimiter is a fixed-window counter per key. In-memory and per-instance
// on purpose: the requirement asks for a brake on a runaway or hostile
// client, not a durable quota, and a shared store would put a network round
// trip in front of the one endpoint whose latency a driver actually feels.
//
// A fixed window admits up to twice its limit in any sliding minute per
// replica: a full window's worth at its end, and again at the start of the
// next. infra/main.bicep's scale block permits maxReplicas: 2, so with both
// warm the bound is four times each constant above (240 submits per sliding
// minute per account, not 60), and minReplicas: 0 means a cold start resets
// every window to empty (TYRE-184 F7).
type rateLimiter struct {
	mu      sync.Mutex
	perMin  int
	windows map[string]*rateWindow
}

type rateWindow struct {
	start time.Time
	count int
}

func newRateLimiter(perMinute int) *rateLimiter {
	return &rateLimiter{perMin: perMinute, windows: make(map[string]*rateWindow)}
}

func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Swept on write rather than by a goroutine: the map only grows when
	// somebody is submitting, so that is exactly when it is worth tidying.
	for k, w := range l.windows {
		if now.Sub(w.start) > 2*rateLimitWindow {
			delete(l.windows, k)
		}
	}

	w, seen := l.windows[key]
	if !seen || now.Sub(w.start) >= rateLimitWindow {
		l.windows[key] = &rateWindow{start: now, count: 1}
		return true
	}
	w.count++
	return w.count <= l.perMin
}

// submitRateLimit composes the two counters into NFR-SEC-007's one
// middleware, built once at router construction and closed over here (see
// New). Keyed on the identity requireActor resolved, never a raw header,
// because HeaderActorResolver is DEV ONLY and keying on it directly would
// collapse the per-account limit into one bucket the moment the real
// identity provider lands. requireActor's r.Use ordering guarantee is
// TestRequireActorRunsBeforeInlineRateLimitMiddleware's.
func submitRateLimit(account, address *rateLimiter, trustedProxyHops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := identityFrom(r.Context())
			if !ok {
				// TY010's case (see the submitStatus comment): a request
				// reaching this far with no bound identity is an invariant
				// breach, not a client mistake, so 500 is the honest answer.
				slog.ErrorContext(r.Context(), "rate limiter reached with no bound identity")
				writeError(r.Context(), w, http.StatusInternalServerError, codeInternal, msgInternal)
				return
			}

			host := clientAddress(r, trustedProxyHops)

			now := time.Now()
			// Both counters always advance, even if one has already
			// refused: a request rejected on the account axis must still
			// count against the address it came from, or an attacker could
			// use a string of doomed-to-be-refused accounts to dodge the
			// address counter entirely.
			accountOK := account.allow(id.UserID.String(), now)
			addressOK := address.allow(host, now)
			if !accountOK || !addressOK {
				w.Header().Set("Retry-After", strconv.Itoa(int(rateLimitWindow.Seconds())))
				writeError(r.Context(), w, http.StatusTooManyRequests, codeRateLimited, "too many requests")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientAddress resolves the per-address counter's key, honouring
// trustedProxyHops trusted L7 hops in front of this process
// (infra/main.bicep's TRUSTED_PROXY_HOPS, default 1: today's single
// Container Apps ingress hop). Keying on RemoteAddr behind an untrusted
// proxy would collapse every client into one bucket. See
// docs/architecture.md's rate-limiting section for the full topology
// argument and the X-Forwarded-For position math.
func clientAddress(r *http.Request, trustedProxyHops int) string {
	hops := forwardedHops(r)
	if trustedProxyHops >= 1 && len(hops) >= trustedProxyHops {
		hop := hops[len(hops)-trustedProxyHops]
		if host, _, err := net.SplitHostPort(hop); err == nil {
			return host
		}
		return hop
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// forwardedHops flattens every X-Forwarded-For header line into one ordered,
// trimmed, non-empty chain: line order first, then comma order within each
// line. clientAddress says why both header forms must read the same.
func forwardedHops(r *http.Request) []string {
	var hops []string
	for _, line := range r.Header.Values("X-Forwarded-For") {
		for _, hop := range strings.Split(line, ",") {
			if h := strings.TrimSpace(hop); h != "" {
				hops = append(hops, h)
			}
		}
	}
	return hops
}
