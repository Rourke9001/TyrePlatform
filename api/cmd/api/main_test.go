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
