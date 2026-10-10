package httpapi_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/httpapi"
)

func TestReadyz(t *testing.T) {
	cases := []struct {
		name     string
		opts     []httpapi.Option
		dbGone   bool
		wantCode int
		wantBody string
	}{
		// TYRE-79: the deploy gate tells this build from the one it replaces
		// by the sha /readyz names, so the field is pinned, not merely present.
		{
			name:     "names the build and the revision",
			opts:     []httpapi.Option{httpapi.WithBuildSHA("abc1234"), httpapi.WithRevision("ca-api-staging--c7-1-abc1234")},
			wantCode: http.StatusOK,
			wantBody: `{"status":"ready","sha":"abc1234","revision":"ca-api-staging--c7-1-abc1234"}`,
		},
		{
			name:     "defaults to dev",
			wantCode: http.StatusOK,
			wantBody: `{"status":"ready","sha":"dev","revision":""}`,
		},
		// NFR-OBS-005: a replica whose database is gone reports unready, and
		// the body never carries the ping error.
		{
			name:     "unready when the database is gone",
			opts:     []httpapi.Option{httpapi.WithBuildSHA("abc1234")},
			dbGone:   true,
			wantCode: http.StatusServiceUnavailable,
			wantBody: `{"status":"unready","sha":"abc1234","revision":""}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, _ := testStore(t, ctx)
			h := httpapi.New(s, httpapi.HeaderActorResolver{}, tc.opts...)
			if tc.dbGone {
				s.Close()
			}

			rec := get(t, h, "/readyz", "", "")
			require.Equal(t, tc.wantCode, rec.Code, rec.Body.String())
			require.JSONEq(t, tc.wantBody, rec.Body.String())
			require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
			require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		})
	}
}
