package httpapi

import "net/http"

// securityHeadersCSP is a baseline suited to a JSON API: this process never
// serves markup, a script or a frame of its own, so every fetch directive
// collapses to 'none' rather than naming an origin nothing here will ever
// load from (NFR-SEC-010).
const securityHeadersCSP = "default-src 'none'; frame-ancestors 'none'"

// securityHeaders sets NFR-SEC-010's headers on every answer this process
// gives, refusals included: chi resolves NotFound and MethodNotAllowed
// through the same middleware chain as a matched route, so registering this
// on the root router before any route covers both. The static web app's own
// headers are TYRE-51's.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", securityHeadersCSP)
		next.ServeHTTP(w, r)
	})
}
