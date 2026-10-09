package httpapi_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/httpapi"
)

// TYRE-79: the deploy gate tells this build from the one it replaces by the
// sha /readyz names, so the field is pinned, not merely present.
func TestReadyzNamesTheBuild(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{},
		httpapi.WithBuildSHA("abc1234"), httpapi.WithRevision("ca-api-staging--c7-1-abc1234"))

	rec := get(t, h, "/readyz", "", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"status":"ready","sha":"abc1234","revision":"ca-api-staging--c7-1-abc1234"}`, rec.Body.String())
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestReadyzDefaultsToDev(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/readyz", "", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"status":"ready","sha":"dev","revision":""}`, rec.Body.String())
}

// NFR-OBS-005: a replica whose database is gone reports unready, and the
// body never carries the driver's error text.
func TestReadyzUnreadyWhenTheDatabaseIsGone(t *testing.T) {
	ctx := context.Background()
	s, _ := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{}, httpapi.WithBuildSHA("abc1234"))
	s.Close()

	rec := get(t, h, "/readyz", "", "")
	require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	require.JSONEq(t, `{"status":"unready","sha":"abc1234","revision":""}`, rec.Body.String())
}
