package httpapi

import (
	"net/http"
	"slices"
	"strings"
)

// CORS lives here and never in Container Apps ingress corsPolicy: two
// layers would each send Access-Control-Allow-Origin, and a browser refuses
// a response that carries two (ADR-0019).
const (
	corsAllowMethods = "GET, POST, PATCH"
	corsAllowHeaders = "Authorization, Content-Type"
	// Chromium's cap; ADR-0019 lists each browser's and its source.
	corsMaxAge = "7200"
)

// allowOrigins answers CORS for the web origins named, matched byte for
// byte, never a pattern or a reflected Origin (ADR-0019). It runs ahead of
// requireActor and every rate limiter, so a preflight is answered before
// either and a refusal carries the origin too: client.ts then reads a 401
// or 429 envelope rather than a network error. Credentials are never
// allowed, because sign-in is a bearer token, not a cookie (ADR-0016).
func allowOrigins(origins []string) func(http.Handler) http.Handler {
	if len(origins) == 0 {
		return func(next http.Handler) http.Handler { return next }
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			h := w.Header()
			// So no cache serves one origin's answer to another.
			h.Add("Vary", "Origin")
			origin := r.Header.Get("Origin")
			if !slices.Contains(origins, origin) {
				next.ServeHTTP(w, r)
				return
			}
			h.Set("Access-Control-Allow-Origin", origin)
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", corsAllowMethods)
				h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
				h.Set("Access-Control-Max-Age", corsMaxAge)
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
