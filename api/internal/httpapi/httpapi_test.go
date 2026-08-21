package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// Same contract and rationale as internal/store's testURLs: integration
// tests against a migrated Postgres, skipped when no database is offered.
func testStore(t *testing.T, ctx context.Context) (*store.Store, *pgx.Conn) {
	t.Helper()
	appURL := os.Getenv("TEST_DATABASE_URL")
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if appURL == "" || adminURL == "" {
		t.Skip("TEST_DATABASE_URL / TEST_ADMIN_DATABASE_URL not set; integration test needs a migrated Postgres")
	}

	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	s, err := store.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s, admin
}

// plantTenant creates a throwaway tenant via the admin connection. Tests
// plant their own data because the CI Go job runs against a migrated but
// unseeded database; depending on seed rows would pass locally and fail there.
func plantTenant(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) (uuid.UUID, string) {
	t.Helper()
	suffix := uuid.NewString()[:8]
	name := "httpapi-test-" + label

	var tenantID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.tenant (name, subdomain) VALUES ($1, $2) RETURNING id`,
		name, "httpapi-test-"+suffix,
	).Scan(&tenantID)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(), `DELETE FROM app.tenant WHERE id = $1`, tenantID)
		require.NoError(t, err)
	})
	return tenantID, name
}

func plantTenantWithVehicle(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) (uuid.UUID, string) {
	t.Helper()
	tenantID, _ := plantTenant(t, ctx, admin, label)
	suffix := uuid.NewString()[:8]
	fleet := fmt.Sprintf("%s-%s", label, suffix)

	var configID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, 'HTTPTEST', 'httpapi test rig', 2) RETURNING id`,
		tenantID,
	).Scan(&configID)
	require.NoError(t, err)

	_, err = admin.Exec(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id) VALUES ($1, $2, $3)`,
		tenantID, fleet, configID,
	)
	require.NoError(t, err)
	return tenantID, fleet
}

func get(t *testing.T, h http.Handler, path string, tenant string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestVehiclesScopedToHeaderTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, fleetA := plantTenantWithVehicle(t, ctx, admin, "a")
	_, fleetB := plantTenantWithVehicle(t, ctx, admin, "b")

	h := httpapi.New(s, httpapi.HeaderTenantResolver{})

	rec := get(t, h, "/api/vehicles", tenantA.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var vehicles []struct {
		ID          string `json:"id"`
		FleetNumber string `json:"fleetNumber"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vehicles))

	var fleets []string
	for _, v := range vehicles {
		fleets = append(fleets, v.FleetNumber)
	}
	require.Contains(t, fleets, fleetA)
	require.NotContains(t, fleets, fleetB, "tenant A's response must never contain tenant B's vehicle")
}

func plantBranding(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, value string, effectiveOffset string) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'branding', $2::jsonb, now() + $3::interval)`,
		tenantID, value, effectiveOffset,
	)
	require.NoError(t, err)
}

type brandingBody struct {
	DisplayName  string  `json:"displayName"`
	PrimaryColor string  `json:"primaryColor"`
	LogoURL      *string `json:"logoUrl"`
}

func getBranding(t *testing.T, h http.Handler, tenant string) brandingBody {
	t.Helper()
	rec := get(t, h, "/api/org/branding", tenant)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var b brandingBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &b))
	return b
}

func TestBrandingScopedToHeaderTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "brand-a")
	tenantB, _ := plantTenant(t, ctx, admin, "brand-b")
	plantBranding(t, ctx, admin, tenantA, `{"displayName":"Fleet A","primaryColor":"#0B5394","logoUrl":null}`, "-1 hour")
	plantBranding(t, ctx, admin, tenantB, `{"displayName":"Fleet B","primaryColor":"#7A2E8D","logoUrl":null}`, "-1 hour")

	h := httpapi.New(s, httpapi.HeaderTenantResolver{})

	a := getBranding(t, h, tenantA.String())
	require.Equal(t, "Fleet A", a.DisplayName)
	require.Equal(t, "#0B5394", a.PrimaryColor)
	require.Nil(t, a.LogoURL)

	b := getBranding(t, h, tenantB.String())
	require.Equal(t, "Fleet B", b.DisplayName, "tenant B must never see tenant A's branding")
	require.Equal(t, "#7A2E8D", b.PrimaryColor)
}

func TestBrandingDefaultsWhenAbsent(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, name := plantTenant(t, ctx, admin, "brand-default")

	h := httpapi.New(s, httpapi.HeaderTenantResolver{})

	b := getBranding(t, h, tenantID.String())
	require.Equal(t, name, b.DisplayName, "absent key falls back to the tenant's registered name")
	require.Equal(t, "#14586E", b.PrimaryColor)
	require.Nil(t, b.LogoURL)
}

// FR-CFG-051: configuration applies prospectively only, so the governing
// value is the newest effective_from that is not in the future.
func TestBrandingLatestEffectiveWins(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "brand-dated")
	plantBranding(t, ctx, admin, tenantID, `{"displayName":"Old","primaryColor":"#111111","logoUrl":null}`, "-2 hours")
	plantBranding(t, ctx, admin, tenantID, `{"displayName":"Current","primaryColor":"#222222","logoUrl":null}`, "-1 hour")
	plantBranding(t, ctx, admin, tenantID, `{"displayName":"Future","primaryColor":"#333333","logoUrl":null}`, "1 hour")

	h := httpapi.New(s, httpapi.HeaderTenantResolver{})

	b := getBranding(t, h, tenantID.String())
	require.Equal(t, "Current", b.DisplayName)
}

func TestBrandingWithoutTenantIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderTenantResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/org/branding", "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/org/branding", "not-a-uuid").Code)
}

// The refusal paths never reach the database, so a nil store keeps these
// runnable without one — they must not silently skip in environments where
// only the unit tests run.
func TestVehiclesWithoutTenantIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderTenantResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", "not-a-uuid").Code)
}

func TestVehiclesWithNoResolverIsUnauthorized(t *testing.T) {
	// nil resolver is the production default until the IdP integration lands:
	// no way to name a tenant means no tenant-scoped route answers.
	h := httpapi.New(nil, nil)

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", uuid.NewString()).Code)
}

func TestHealthzNeedsNoTenant(t *testing.T) {
	h := httpapi.New(nil, nil)
	require.Equal(t, http.StatusOK, get(t, h, "/healthz", "").Code)
}
