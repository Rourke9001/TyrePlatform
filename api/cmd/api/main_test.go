package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

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
		{"other values do not enable it", map[string]string{"APP_DEV_TENANT_HEADER": "true"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			getenv := func(k string) string { return tt.env[k] }
			require.Equal(t, tt.want, devHeaderEnabled(getenv))
		})
	}
}

// TestTrustedProxyHopsParsing pins the absent-vs-invalid distinction
// NFR-SEC-007's address limit depends on: an unset TRUSTED_PROXY_HOPS is the
// documented default and must not itself be treated as an error, while a set
// but non-positive-integer value must surface as one for main to fail loudly
// on rather than silently keep serving at the wrong trust boundary.
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
