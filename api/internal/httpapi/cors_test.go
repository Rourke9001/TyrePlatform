package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/httpapi"
)

const webOrigin = "https://web.example.test"

func serveCORS(h http.Handler, method, path string, headers map[string]string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func varyNamesOrigin(rec *httptest.ResponseRecorder) bool {
	for _, v := range rec.Header().Values("Vary") {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), "Origin") {
				return true
			}
		}
	}
	return false
}

// The behaviour allowOrigins states (cors.go, ADR-0019), case by case.
func TestCORS(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{}, httpapi.WithAllowedOrigins([]string{webOrigin}))

	preflight := func(origin, method, headers string) map[string]string {
		return map[string]string{
			"Origin":                         origin,
			"Access-Control-Request-Method":  method,
			"Access-Control-Request-Headers": headers,
		}
	}

	for _, tc := range []struct {
		name     string
		method   string
		path     string
		headers  map[string]string
		wantCode int
		wantACAO string
		check    func(t *testing.T, rec *httptest.ResponseRecorder)
	}{
		{
			name:     "a preflight from the web origin",
			method:   http.MethodOptions,
			path:     "/api/org/branding",
			headers:  preflight(webOrigin, "GET", "authorization"),
			wantCode: http.StatusNoContent,
			wantACAO: webOrigin,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				hdr := rec.Header()
				require.Equal(t, "GET, POST, PATCH", hdr.Get("Access-Control-Allow-Methods"))
				require.Equal(t, "Authorization, Content-Type", hdr.Get("Access-Control-Allow-Headers"))
				require.Equal(t, "7200", hdr.Get("Access-Control-Max-Age"))
				require.True(t, varyNamesOrigin(rec), "Vary: %v", hdr.Values("Vary"))
				require.Empty(t, hdr.Values("Access-Control-Allow-Credentials"), "sign-in is a bearer token, not a cookie (ADR-0016)")
				require.Empty(t, rec.Body.String())
				// NFR-SEC-010 reaches the preflight: securityHeaders runs first.
				require.Equal(t, "max-age=63072000; includeSubDomains", hdr.Get("Strict-Transport-Security"))
				require.Equal(t, "nosniff", hdr.Get("X-Content-Type-Options"))
			},
		},
		{
			// NFR-SEC-007: a preflight never reaches the submit's limiters.
			name:     "a preflight to the rate-limited submit",
			method:   http.MethodOptions,
			path:     "/api/inspections",
			headers:  preflight(webOrigin, "POST", "authorization, content-type"),
			wantCode: http.StatusNoContent,
			wantACAO: webOrigin,
		},
		{
			name:     "a bare OPTIONS is not a preflight",
			method:   http.MethodOptions,
			path:     "/api/org/branding",
			headers:  map[string]string{"Origin": webOrigin},
			wantCode: http.StatusUnauthorized,
			wantACAO: webOrigin,
		},
		{
			name:     "a preflight from another origin",
			method:   http.MethodOptions,
			path:     "/api/org/branding",
			headers:  preflight("https://other.example.test", "GET", "authorization"),
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "an origin that differs by case",
			method:   http.MethodGet,
			path:     "/api/me",
			headers:  map[string]string{"Origin": "https://WEB.example.test"},
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "an origin with a trailing slash",
			method:   http.MethodGet,
			path:     "/api/me",
			headers:  map[string]string{"Origin": webOrigin + "/"},
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "a refusal to the web origin carries the origin",
			method:   http.MethodGet,
			path:     "/api/me",
			headers:  map[string]string{"Origin": webOrigin},
			wantCode: http.StatusUnauthorized,
			wantACAO: webOrigin,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				require.True(t, varyNamesOrigin(rec), "Vary: %v", rec.Header().Values("Vary"))
				var env struct {
					Code string `json:"code"`
				}
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &env))
				require.Equal(t, "unauthorized", env.Code)
			},
		},
		{
			name:     "a request with no origin",
			method:   http.MethodGet,
			path:     "/api/me",
			wantCode: http.StatusUnauthorized,
		},
		{
			name:     "readyz is outside /api",
			method:   http.MethodGet,
			path:     "/readyz",
			headers:  map[string]string{"Origin": webOrigin},
			wantCode: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				require.Empty(t, rec.Header().Values("Vary"))
			},
		},
		{
			name:     "healthz is outside /api",
			method:   http.MethodGet,
			path:     "/healthz",
			headers:  map[string]string{"Origin": webOrigin},
			wantCode: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				require.Empty(t, rec.Header().Values("Vary"))
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveCORS(h, tc.method, tc.path, tc.headers, "")
			require.Equal(t, tc.wantCode, rec.Code, rec.Body.String())
			require.Equal(t, tc.wantACAO, rec.Header().Get("Access-Control-Allow-Origin"))
			require.LessOrEqual(t, len(rec.Header().Values("Access-Control-Allow-Origin")), 1)
			if tc.check != nil {
				tc.check(t, rec)
			}
		})
	}
}

// Unset, the API sends no CORS headers at all: local dev and e2e stay
// same-origin through Vite's proxy (ADR-0019).
func TestCORSUnconfigured(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := serveCORS(h, http.MethodOptions, "/api/org/branding", map[string]string{
		"Origin":                         webOrigin,
		"Access-Control-Request-Method":  "GET",
		"Access-Control-Request-Headers": "authorization",
	}, "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Empty(t, rec.Header().Get("Access-Control-Allow-Origin"))
	require.Empty(t, rec.Header().Values("Vary"))
}

// A 429 is a refusal the web must read too: the outbox backs off on it.
func TestCORSOnARateLimitRefusal(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{}, httpapi.WithAllowedOrigins([]string{webOrigin}))

	headers := map[string]string{
		"Origin":       webOrigin,
		"X-Tenant-ID":  uuid.NewString(),
		"X-User-ID":    uuid.NewString(),
		"Content-Type": "application/json",
	}
	var rec *httptest.ResponseRecorder
	for range 61 {
		rec = serveCORS(h, http.MethodPost, "/api/inspections", headers, "{}")
	}
	require.Equal(t, http.StatusTooManyRequests, rec.Code, rec.Body.String())
	require.Equal(t, webOrigin, rec.Header().Get("Access-Control-Allow-Origin"))
}
