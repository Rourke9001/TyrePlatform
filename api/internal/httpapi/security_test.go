package httpapi_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/httpapi"
)

// TYRE-205 / NFR-SEC-010: the header set is set once, ahead of every route
// (security.go), so it must reach a healthy response, an unauthenticated
// refusal and a 404 alike, not only the routes a handler explicitly writes.
func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, tc := range []struct {
		name       string
		path       string
		wantStatus int
	}{
		{"healthz, no actor needed", "/healthz", http.StatusOK},
		{"an unauthenticated write", "/api/me", http.StatusUnauthorized},
		// requireActor is registered on the /api sub-router (New), which
		// wraps that whole mount including its own routing miss, so an
		// unmatched path under /api answers 401, not 404. A path outside
		// the mount is what reaches the root router's own NotFound handler.
		{"an unmatched route outside /api", "/no-such-route", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := get(t, h, tc.path, "", "")
			require.Equal(t, tc.wantStatus, rec.Code, rec.Body.String())

			hdr := rec.Header()
			require.Equal(t, "max-age=63072000; includeSubDomains", hdr.Get("Strict-Transport-Security"))
			require.Equal(t, "nosniff", hdr.Get("X-Content-Type-Options"))
			require.Equal(t, "DENY", hdr.Get("X-Frame-Options"))
			require.Equal(t, "no-referrer", hdr.Get("Referrer-Policy"))
			require.Equal(t, "default-src 'none'; frame-ancestors 'none'", hdr.Get("Content-Security-Policy"))
		})
	}
}
