package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/httpapi"
)

// The harness answers (value, present) like os.LookupEnv, because the
// distinction is the whole test: os.Getenv reads "" for both an unset
// variable and one set to "", and a stray --set-env-vars CONTAINER_APP_NAME=
// in staging is the second case (TYRE-160).
func TestDevHeaderResolverGating(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{"off by default", map[string]string{}, false},
		{"on when asked", map[string]string{"APP_DEV_TENANT_HEADER": "1"}, true},
		{"refused inside Container Apps even when asked",
			map[string]string{"APP_DEV_TENANT_HEADER": "1", "CONTAINER_APP_NAME": "ca-api-staging"}, false},
		{"refused when CONTAINER_APP_NAME is present but empty",
			map[string]string{"APP_DEV_TENANT_HEADER": "1", "CONTAINER_APP_NAME": ""}, false},
		{"other values do not enable it", map[string]string{"APP_DEV_TENANT_HEADER": "true"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lookup := func(k string) (string, bool) { v, ok := tt.env[k]; return v, ok }
			require.Equal(t, tt.want, devHeaderEnabled(lookup))
		})
	}
}

func TestDevResolverWiring(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	lookup := func(env map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := env[k]; return v, ok }
	}

	require.Nil(t, devResolver(lookup(map[string]string{}), nil, logger),
		"off by default, and nothing configured")
	require.Equal(t, httpapi.HeaderActorResolver{},
		devResolver(lookup(map[string]string{"APP_DEV_TENANT_HEADER": "1"}), nil, logger))
	require.Nil(t, devResolver(lookup(map[string]string{"APP_DEV_TENANT_HEADER": "1", "CONTAINER_APP_NAME": "ca-api-staging"}), nil, logger),
		"the veto still holds in a devheader build")
}

// TestTrustedProxyHopsParsing pins the absent-vs-invalid distinction
// NFR-SEC-007's address limit depends on; trustedProxyHops in main.go carries
// the reasoning.
func TestTrustedProxyHopsParsing(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    int
		wantErr bool
	}{
		{"absent means the documented default of 1", "", 1, false},
		{"a valid positive integer is parsed", "2", 2, false},
		{"zero is not a valid hop count", "0", 0, true},
		{"negative is not a valid hop count", "-1", 0, true},
		{"non-numeric is a deploy mistake, not a silent 1", "two", 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(k string) string {
				if k == "TRUSTED_PROXY_HOPS" {
					return tt.raw
				}
				return ""
			}
			got, err := trustedProxyHops(getenv)
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}

func authEnv(overrides map[string]string) func(string) string {
	env := map[string]string{
		"AUTH_DISCOVERY_URL": "https://example.ciamlogin.com/tid/v2.0/.well-known/openid-configuration?appid=0c0ffee0-0000-4000-8000-000000000002",
		"AUTH_ISSUER":        "https://example.ciamlogin.com/tid/v2.0",
		"AUTH_TENANT_ID":     "0c0ffee0-0000-4000-8000-000000000001",
		"AUTH_AUDIENCE":      "0c0ffee0-0000-4000-8000-000000000002",
		"AUTH_CLIENT_ID":     "0c0ffee0-0000-4000-8000-000000000003",
		"AUTH_TENANT_CLAIM":  "extension_abc_platformTenantId",
	}
	for k, v := range overrides {
		env[k] = v
	}
	return func(k string) string { return env[k] }
}

// ADR-0016: all six set wires the resolver, none set wires none, anything in
// between is a deploy mistake that stops startup, as a malformed
// TRUSTED_PROXY_HOPS does.
func TestAuthConfig(t *testing.T) {
	none := map[string]string{
		"AUTH_DISCOVERY_URL": "", "AUTH_ISSUER": "", "AUTH_TENANT_ID": "",
		"AUTH_AUDIENCE": "", "AUTH_CLIENT_ID": "", "AUTH_TENANT_CLAIM": "",
	}
	const base = "https://example.ciamlogin.com/tid/v2.0/.well-known/openid-configuration"
	tests := []struct {
		name      string
		env       map[string]string
		wantWired bool
		wantErr   bool
	}{
		{"all six set", nil, true, false},
		{"none set", none, false, false},
		{"one set", map[string]string{"AUTH_DISCOVERY_URL": "", "AUTH_ISSUER": "", "AUTH_TENANT_ID": "", "AUTH_AUDIENCE": "", "AUTH_CLIENT_ID": ""}, false, true},
		{"five set", map[string]string{"AUTH_TENANT_CLAIM": ""}, false, true},
		{"a loopback http URL is accepted for tests", map[string]string{
			"AUTH_DISCOVERY_URL": "http://127.0.0.1:8081/discovery?appid=0c0ffee0-0000-4000-8000-000000000002", "AUTH_ISSUER": "http://localhost:8081/tid/v2.0"}, true, false},
		{"http on a real host", map[string]string{"AUTH_ISSUER": "http://example.ciamlogin.com/tid/v2.0"}, false, true},
		{"a relative URL", map[string]string{"AUTH_DISCOVERY_URL": "/discovery"}, false, true},
		{"a tenant id that is not a uuid", map[string]string{"AUTH_TENANT_ID": "sandbox"}, false, true},
		{"an audience that is not a uuid", map[string]string{"AUTH_AUDIENCE": "api://tyre-api"}, false, true},
		{"a client id that is not a uuid", map[string]string{"AUTH_CLIENT_ID": "tyre-pwa"}, false, true},
		{"a claim name with a space", map[string]string{"AUTH_TENANT_CLAIM": "platform tenant"}, false, true},
		{"an issuer with a trailing space", map[string]string{"AUTH_ISSUER": "https://example.ciamlogin.com/tid/v2.0 "}, false, true},
		{"an upper-case scheme", map[string]string{"AUTH_ISSUER": "HTTPS://example.ciamlogin.com/tid/v2.0"}, false, true},
		{"an issuer with a fragment", map[string]string{"AUTH_ISSUER": "https://example.ciamlogin.com/tid/v2.0#x"}, false, true},
		{"an issuer with userinfo", map[string]string{"AUTH_ISSUER": "https://user:secret@example.ciamlogin.com/tid/v2.0"}, false, true},
		{"an issuer with an empty hostname", map[string]string{"AUTH_ISSUER": "https://:443/tid/v2.0"}, false, true},
		{"an IPv6 loopback http URL", map[string]string{"AUTH_ISSUER": "http://[::1]:8081/tid/v2.0"}, true, false},
		{"a discovery URL with no appid", map[string]string{"AUTH_DISCOVERY_URL": base}, false, true},
		{"a discovery appid naming another app", map[string]string{"AUTH_DISCOVERY_URL": base + "?appid=0c0ffee0-0000-4000-8000-000000000003"}, false, true},
		{"a discovery appid that is not a uuid", map[string]string{"AUTH_DISCOVERY_URL": base + "?appid=tyre-api"}, false, true},
		{"a discovery appid in another case still matches", map[string]string{"AUTH_DISCOVERY_URL": base + "?appid=0C0FFEE0-0000-4000-8000-000000000002"}, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, wired, err := authConfig(authEnv(tt.env))
			if tt.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.wantWired, wired)
			if wired {
				require.NotEmpty(t, cfg.Issuer)
				require.Equal(t, "extension_abc_platformTenantId", cfg.TenantClaim)
			}
		})
	}
}

type recordingResolver struct{ calls int }

func (r *recordingResolver) Identify(context.Context, *http.Request) (httpapi.Identity, error) {
	r.calls++
	return httpapi.Identity{TenantID: uuid.New(), Subject: uuid.New(), SessionID: "sid:x"}, nil
}

// Spec section 1, Composing the resolvers: a request that carries a token is
// the bearer resolver's to judge, even when it also carries the dev headers.
func TestDevResolverRoutesByTheAuthorizationHeader(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	on := func(k string) (string, bool) {
		if k == "APP_DEV_TENANT_HEADER" {
			return "1", true
		}
		return "", false
	}
	bearerStub := &recordingResolver{}
	resolver := devResolver(on, bearerStub, logger)

	withBoth := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	withBoth.Header.Set("Authorization", "Bearer token")
	withBoth.Header.Set("X-Tenant-ID", uuid.NewString())
	withBoth.Header.Set("X-User-ID", uuid.NewString())
	id, err := resolver.Identify(context.Background(), withBoth)
	require.NoError(t, err)
	require.Equal(t, 1, bearerStub.calls)
	require.NotEqual(t, uuid.Nil, id.Subject)

	headersOnly := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	headersOnly.Header.Set("X-Tenant-ID", uuid.NewString())
	userID := uuid.New()
	headersOnly.Header.Set("X-User-ID", userID.String())
	id, err = resolver.Identify(context.Background(), headersOnly)
	require.NoError(t, err)
	require.Equal(t, 1, bearerStub.calls, "a request with no token never reaches the bearer resolver")
	require.Equal(t, userID, id.UserID)

	require.Same(t, bearerStub, devResolver(func(string) (string, bool) { return "", false }, bearerStub, logger),
		"with the dev switch off only the bearer resolver is wired")
}

// bearer compares azp and tid byte for byte, so authConfig hands it the
// canonical lower-case form, and each value lands in its own field.
func TestAuthConfigValues(t *testing.T) {
	cfg, wired, err := authConfig(authEnv(nil))
	require.NoError(t, err)
	require.True(t, wired)
	require.Equal(t, bearer.Config{
		DiscoveryURL: "https://example.ciamlogin.com/tid/v2.0/.well-known/openid-configuration?appid=0c0ffee0-0000-4000-8000-000000000002",
		Issuer:       "https://example.ciamlogin.com/tid/v2.0",
		TenantID:     "0c0ffee0-0000-4000-8000-000000000001",
		Audience:     "0c0ffee0-0000-4000-8000-000000000002",
		ClientID:     "0c0ffee0-0000-4000-8000-000000000003",
		TenantClaim:  "extension_abc_platformTenantId",
	}, cfg)

	cfg, _, err = authConfig(authEnv(map[string]string{
		"AUTH_TENANT_ID": "0C0FFEE0-0000-4000-8000-000000000001",
		"AUTH_AUDIENCE":  "0C0FFEE0-0000-4000-8000-000000000002",
		"AUTH_CLIENT_ID": "0C0FFEE0-0000-4000-8000-000000000003",
	}))
	require.NoError(t, err)
	require.Equal(t, "0c0ffee0-0000-4000-8000-000000000001", cfg.TenantID)
	require.Equal(t, "0c0ffee0-0000-4000-8000-000000000002", cfg.Audience)
	require.Equal(t, "0c0ffee0-0000-4000-8000-000000000003", cfg.ClientID)
}

func TestAuthConfigNamesTheUnsetVariables(t *testing.T) {
	_, _, err := authConfig(authEnv(map[string]string{"AUTH_ISSUER": "", "AUTH_CLIENT_ID": "", "AUTH_TENANT_CLAIM": ""}))
	require.ErrorContains(t, err, "AUTH_ISSUER")
	require.ErrorContains(t, err, "AUTH_CLIENT_ID")
	require.ErrorContains(t, err, "AUTH_TENANT_CLAIM")
	require.NotContains(t, err.Error(), "AUTH_AUDIENCE")
}
