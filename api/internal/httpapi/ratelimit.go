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

// NFR-SEC-007: "rate-limit authentication endpoints and submission endpoints
// per account and per source address." Submission is the only endpoint this
// slice adds; authentication has no endpoint yet (FR-AUT-001 is still the
// dev header resolver), so there is nothing to limit there today.
//
// Two independent counters, not a composite key: a key of account+address
// would satisfy neither half of the requirement on its own. One account
// rotating N addresses would get N times the account limit, and one address
// rotating N accounts would get N times the address limit. A request is
// refused if EITHER counter refuses (submitRateLimit below).
//
// The two limits are deliberately not equal. Sixty a minute per account is
// far above any human capture rate — the whole design target is three
// minutes per vehicle — and far below what a retry loop can manage. The
// address limit is ten times that: a depot's drivers share one NAT egress
// address, so several phones capturing at once legitimately present as one
// source, and the address counter exists to catch a hostile client, not
// normal depot concurrency.
//
// Both limits are Go constants, not tenant configuration. CLAUDE.md rule 5
// governs business policy a tenant sets — thresholds, bands, rates — and a
// rate limit is an operational transport control, not that. It is also not
// mechanically coherent as tenant config here: the limiters are built once
// at router construction with no tenant in scope, and the address counter
// in particular is never tenant-scoped at all.
const (
	accountSubmitsPerMinute = 60
	addressSubmitsPerMinute = 10 * accountSubmitsPerMinute
	rateLimitWindow         = time.Minute
)

// rateLimiter is a fixed-window counter per key. In-memory and per-instance
// on purpose: the requirement asks for a brake on a runaway or hostile
// client, not a durable quota, and a shared store would put a network round
// trip in front of the one endpoint whose latency a driver actually feels.
// Revisit if the API ever runs more than a couple of replicas.
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

// submitRateLimit composes the account and address counters into the one
// middleware NFR-SEC-007 asks for on the submission endpoint. The two
// limiters are constructed once at router construction (see New) and closed
// over here, never rebuilt per request.
//
// Keyed on the identity requireActor already resolved, never on a raw
// header: HeaderActorResolver is documented DEV ONLY (httpapi.go), and once
// the real identity provider lands the header disappears — keying on it
// directly would collapse the per-account limit into one global bucket for
// the whole fleet the moment that happens. requireActor runs via r.Use on
// the /api route and this middleware is attached with an inline r.With() on
// the submission route alone; chi runs a router's Use-registered middleware
// before an inline With() chain, so the identity is genuinely present by the
// time this runs (TestRequireActorRunsBeforeInlineRateLimitMiddleware).
func submitRateLimit(account, address *rateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := identityFrom(r.Context())
			if !ok {
				// TY010's case (see the submitStatus comment): a request
				// reaching this far with no bound identity is an invariant
				// breach, not a client mistake, so 500 is the honest answer.
				slog.ErrorContext(r.Context(), "rate limiter reached with no bound identity")
				http.Error(w, "internal error", http.StatusInternalServerError)
				return
			}

			host := clientAddress(r)

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
				http.Error(w, "too many requests", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientAddress resolves the source address the per-address counter keys
// on. Every deployed environment fronts the API with an Azure Container
// Apps ingress (infra/main.bicep's `ingress: { external: true }`), and that
// ingress terminates every connection itself and forwards over its own
// internal hop — so RemoteAddr is the ingress's address, never the caller's,
// on every request in every deployed environment. Keying the address
// counter on RemoteAddr there would collapse it into one bucket shared by
// every client on the internet, turning the limiter meant to stop a hostile
// client into a way for one to lock out every driver.
//
// The fix is the LAST hop of the LAST X-Forwarded-For header line — not
// Header.Get, which returns only the first line. RFC 7230 makes repeated
// header lines equivalent to one comma-joined line, so a conformant proxy
// may append its own observed address as a separate line instead of
// extending the caller's; Header.Values preserves every line in the order
// received, so its last element is that ingress-appended line regardless of
// which form was used. Within that line, the last comma-separated hop is
// the one the ingress itself observed — everything before it, in that line
// or an earlier one, is caller-supplied and can be forged. Trusting
// anything but this last-of-last hop would let a request buy a fresh
// address bucket per forged value and bypass the limit entirely. This
// assumes exactly one trusted hop between the caller and this process; an
// additional hop in front of the ingress would need this to change.
//
// A header absent or entirely blank falls back to RemoteAddr — the
// local/dev and httptest case, where nothing sits in front of the process
// at all.
func clientAddress(r *http.Request) string {
	if lines := r.Header.Values("X-Forwarded-For"); len(lines) > 0 {
		if last := lastForwardedHop(lines[len(lines)-1]); last != "" {
			if host, _, err := net.SplitHostPort(last); err == nil {
				return host
			}
			return last
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// lastForwardedHop returns the last non-empty comma-separated entry of one
// X-Forwarded-For header line, trimmed — skipping backward over a trailing
// empty segment (a stray trailing comma) rather than returning it as if it
// were a hop.
func lastForwardedHop(line string) string {
	hops := strings.Split(line, ",")
	for i := len(hops) - 1; i >= 0; i-- {
		if hop := strings.TrimSpace(hops[i]); hop != "" {
			return hop
		}
	}
	return ""
}
