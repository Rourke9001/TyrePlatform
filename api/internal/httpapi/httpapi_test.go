package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
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

func get(t *testing.T, h http.Handler, path, tenant, user string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	if user != "" {
		req.Header.Set("X-User-ID", user)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// plantUser adds a user to a planted tenant. The parameter is bound like any
// other; the cast is what tells Postgres the text is a user_role.
func plantUser(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, role auth.Role) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var userID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role)
		 VALUES ($1, $2, $3, $4::app.user_role) RETURNING id`,
		tenantID, "httpapi-test-"+suffix+"@example.invalid", "Httpapi Test "+suffix, string(role),
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func TestVehiclesScopedToHeaderTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, fleetA := plantTenantWithVehicle(t, ctx, admin, "a")
	_, fleetB := plantTenantWithVehicle(t, ctx, admin, "b")
	// CONTROLLER because a DRIVER is refused this route from Task 5 onward.
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/vehicles", tenantA.String(), userA.String())
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

func getBranding(t *testing.T, h http.Handler, tenant, user string) brandingBody {
	t.Helper()
	rec := get(t, h, "/api/org/branding", tenant, user)
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
	// DRIVER is deliberate: branding asserts no capability, and the narrowest
	// role proves that.
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleDriver)
	userB := plantUser(t, ctx, admin, tenantB, auth.RoleDriver)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	a := getBranding(t, h, tenantA.String(), userA.String())
	require.Equal(t, "Fleet A", a.DisplayName)
	require.Equal(t, "#0B5394", a.PrimaryColor)
	require.Nil(t, a.LogoURL)

	b := getBranding(t, h, tenantB.String(), userB.String())
	require.Equal(t, "Fleet B", b.DisplayName, "tenant B must never see tenant A's branding")
	require.Equal(t, "#7A2E8D", b.PrimaryColor)
}

func TestBrandingDefaultsWhenAbsent(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, name := plantTenant(t, ctx, admin, "brand-default")
	userID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	b := getBranding(t, h, tenantID.String(), userID.String())
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
	userID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	b := getBranding(t, h, tenantID.String(), userID.String())
	require.Equal(t, "Current", b.DisplayName)
}

func TestBrandingWithoutTenantIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/org/branding", "", "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/org/branding", "not-a-uuid", "").Code)
}

// The refusal paths never reach the database, so a nil store keeps these
// runnable without one — they must not silently skip in environments where
// only the unit tests run.
func TestVehiclesWithoutTenantIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", "", "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", "not-a-uuid", "").Code)
}

func TestVehiclesWithNoResolverIsUnauthorized(t *testing.T) {
	// nil resolver is the production default until the identity provider
	// lands: no way to name anyone means no scoped route answers.
	h := httpapi.New(nil, nil)

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/vehicles", uuid.NewString(), "").Code)
}

func TestHealthzNeedsNoTenant(t *testing.T) {
	h := httpapi.New(nil, nil)
	require.Equal(t, http.StatusOK, get(t, h, "/healthz", "", "").Code)
}

type meBody struct {
	UserID       string   `json:"userId"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Depots       []string `json:"depots"`
}

func TestMeReportsTheRoleTheDatabaseHolds(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "me")
	userID := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantID.String(), userID.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var me meBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	require.Equal(t, userID.String(), me.UserID)
	require.Equal(t, "CONTROLLER", me.Role)
	require.Contains(t, me.Capabilities, "ManageAssets")
	require.NotContains(t, me.Capabilities, "ManageUsers")
	require.Empty(t, me.Depots)
}

func TestRequestWithoutAUserIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", uuid.NewString(), "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", uuid.NewString(), "not-a-uuid").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", "", uuid.NewString()).Code)
}

// A syntactically valid identity for a user this tenant cannot see is a
// refusal, not an error and not an empty success.
func TestUnknownUserIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "unknown-user")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantID.String(), uuid.NewString())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestUserFromAnotherTenantIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "cross-a")
	tenantB, _ := plantTenant(t, ctx, admin, "cross-b")
	userInB := plantUser(t, ctx, admin, tenantB, auth.RoleOrgAdmin)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantA.String(), userInB.String())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// plantDepotWithVehicle plants a depot and a vehicle homed at it, with no
// membership. Callers join the actor separately, so a test can also plant a
// depot the actor is deliberately not a member of.
//
// The axle-configuration code is unique per call (app.axle_configuration
// carries UNIQUE (tenant_id, code, version)): a test that plants more than
// one depot in the same tenant collides on a shared 'DEPOTTEST' code.
func plantDepotWithVehicle(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) (uuid.UUID, string) {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var depotID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		tenantID, "depot-"+suffix,
	).Scan(&depotID))

	var configID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, $2, 'depot test rig', 2) RETURNING id`, tenantID, "DEPOTTEST-"+suffix,
	).Scan(&configID))

	fleet := "DEPOT-" + suffix
	_, err := admin.Exec(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, home_depot_id)
		 VALUES ($1, $2, $3, $4)`,
		tenantID, fleet, configID, depotID)
	require.NoError(t, err)
	return depotID, fleet
}

func joinDepot(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, userID, depotID uuid.UUID) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.user_depot (tenant_id, user_id, depot_id) VALUES ($1, $2, $3)`,
		tenantID, userID, depotID)
	require.NoError(t, err)
}

func plantDepotVehicle(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, userID uuid.UUID) string {
	t.Helper()
	depotID, fleet := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, userID, depotID)
	return fleet
}

func fleetNumbers(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var vehicles []struct {
		FleetNumber string `json:"fleetNumber"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vehicles))
	out := []string{}
	for _, v := range vehicles {
		out = append(out, v.FleetNumber)
	}
	return out
}

// FR-AUT-005 as a route rather than a filter: the fleet list is not a driver's
// to read at all, and ADR-0006 names these per-role tests as the only thing
// standing between a handler that skips the scope view and a quiet
// intra-tenant overexposure.
func TestFleetListIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "gate")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleTechnician, http.StatusOK},
		{auth.RoleDepotManager, http.StatusOK},
		{auth.RoleController, http.StatusOK},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/vehicles", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// ADR-0011: PLATFORM_ADMIN rows carry a NULL tenant_id, so the actor lookup
// inside a tenant-bound transaction cannot see them. The refusal is layer 2,
// unresolvable actor — the capability gate is never reached, and the client
// cannot tell this apart from a user that does not exist.
func TestPlatformAdminCannotActInATenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "platform")

	var userID uuid.UUID
	suffix := uuid.NewString()[:8]
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role)
		 VALUES (NULL, $1, $2, 'PLATFORM_ADMIN') RETURNING id`,
		"platform-"+suffix+"@example.invalid", "Platform Admin "+suffix,
	).Scan(&userID))

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	require.Equal(t, http.StatusForbidden,
		get(t, h, "/api/vehicles", tenantID.String(), userID.String()).Code)
}

// FR-AUT-006/008: the depot roles read the fleet through the depot predicate.
// The negative case is a vehicle homed at a *different* depot, not one homed
// nowhere — a NULL home_depot_id is excluded by any depot join at all, so it
// cannot tell a working predicate from a broken one.
func TestFleetListIsDepotScopedForDepotRoles(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "scoped")
	_, elsewhere := plantDepotWithVehicle(t, ctx, admin, tenantID)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, role := range []auth.Role{auth.RoleTechnician, auth.RoleDepotManager} {
		t.Run(string(role), func(t *testing.T) {
			user := plantUser(t, ctx, admin, tenantID, role)
			mine := plantDepotVehicle(t, ctx, admin, tenantID, user)

			got := fleetNumbers(t, get(t, h, "/api/vehicles", tenantID.String(), user.String()))
			require.Equal(t, []string{mine}, got,
				"a depot role sees its own depot's units and no others")
		})
	}

	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	whole := fleetNumbers(t, get(t, h, "/api/vehicles", tenantID.String(), controller.String()))
	require.Contains(t, whole, elsewhere, "a controller reads the whole tenant (FR-AUT-007)")
}

// A driver out of scope gets an empty list, not a refusal: they are entitled
// to ask what they are assigned, and the answer is legitimately nothing.
func TestDriverVehiclesAreAssignmentScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, "assigned")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	other := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet,
	).Scan(&vehicleID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date)
		 VALUES ($1, $2, $3, (now() AT TIME ZONE 'UTC')::date - 1)`,
		tenantID, vehicleID, driver)
	require.NoError(t, err)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, []string{fleet},
		fleetNumbers(t, get(t, h, "/api/my/vehicles", tenantID.String(), driver.String())))
	require.Empty(t,
		fleetNumbers(t, get(t, h, "/api/my/vehicles", tenantID.String(), other.String())),
		"an unassigned driver sees nothing, and that is an empty list rather than a refusal")
}

func TestMyTasksNeedsCaptureCapability(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tasks")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusOK, get(t, h, "/api/my/tasks", tenantID.String(), driver.String()).Code)
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/my/tasks", tenantID.String(), technician.String()).Code)
}

// FR-DSH-012. The scope view is the only thing keeping one driver's work list
// from being everyone's, so this asserts rows and not merely a status: a
// handler reading app.inspection_task directly answers 200 with the whole
// tenant's tasks, which no status-code assertion can see.
func TestMyTasksAreActorScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, "mytasks")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	other := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet,
	).Scan(&vehicleID))

	var mine uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, state)
		 VALUES ($1, $2, now() - interval '1 day', $3, 'OPEN') RETURNING id`,
		tenantID, vehicleID, driver,
	).Scan(&mine))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, state)
		 VALUES ($1, $2, now() + interval '1 day', $3, 'OPEN')`,
		tenantID, vehicleID, other)
	require.NoError(t, err)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/my/tasks", tenantID.String(), driver.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var tasks []struct {
		ID          string `json:"id"`
		FleetNumber string `json:"fleetNumber"`
		DueAt       string `json:"dueAt"`
		State       string `json:"state"`
		Overdue     bool   `json:"overdue"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &tasks))
	require.Len(t, tasks, 1, "a driver sees their own task and no one else's")
	require.Equal(t, mine.String(), tasks[0].ID)
	require.Equal(t, fleet, tasks[0].FleetNumber)
	require.Equal(t, "OPEN", tasks[0].State)
	require.True(t, tasks[0].Overdue, "a task past its due date reads overdue")
	_, perr := time.Parse(time.RFC3339, tasks[0].DueAt)
	require.NoError(t, perr, "dueAt is RFC3339")
}
