package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type axleConfigBody struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// The library a create form picks from. Gated on ManageAssets — the capability
// that can act on the answer — so a driver is refused the list as well as the
// write (FR-AUT-005 is about what may be asked for, not only what comes back).
func TestAxleConfigurationsAreCapabilityGatedAndTenantScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg")
	otherID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg-other")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	require.Equal(t, http.StatusForbidden,
		get(t, h, "/api/axle-configurations", tenantID.String(), driver.String()).Code)

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/axle-configurations", tenantID.String(), orgAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var configs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &configs))
	require.Len(t, configs, 1, "the fixture plants exactly one configuration per tenant")
	require.Equal(t, "HTTPTEST", configs[0].Code)
	require.Equal(t, 2, configs[0].AxleCount)

	// The other tenant's configuration is not reachable, and the refusal is
	// emptiness rather than an error: RLS answers the question honestly.
	otherAdmin := plantUser(t, ctx, admin, otherID, auth.RoleOrgAdmin)
	rec = get(t, h, "/api/axle-configurations", otherID.String(), otherAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code)
	var otherConfigs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &otherConfigs))
	require.Len(t, otherConfigs, 1)
	require.NotEqual(t, configs[0].ID, otherConfigs[0].ID)
}

type createdVehicleBody struct {
	ID           string  `json:"id"`
	FleetNumber  string  `json:"fleetNumber"`
	Registration *string `json:"registration"`
}

type refusalBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func TestCreateVehicle(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "createveh")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var configID string
	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/axle-configurations", tenantID.String(), orgAdmin.String())
	var configs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &configs))
	require.NotEmpty(t, configs)
	configID = configs[0].ID

	body := func(fleet string) string {
		return `{"fleetNumber":"` + fleet + `","registration":"CA123456",` +
			`"configurationId":"` + configID + `","unitKind":"HORSE"}`
	}

	// D8: the gate is ManageAssets, and a DRIVER does not hold it.
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	rec = post(t, h, "/api/vehicles", tenantID.String(), driver.String(), body("REFUSED-1"))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	// The create itself, answering 201 with the list projection.
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), body("NEW-1"))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created createdVehicleBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, "NEW-1", created.FleetNumber)
	require.NotEmpty(t, created.ID)

	// DR-013: created_by is stamped from the bound actor, without the handler
	// naming it — app.current_actor_id() is the column's default.
	var createdBy string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT created_by FROM app.vehicle WHERE id = $1`, created.ID).Scan(&createdBy))
	require.Equal(t, orgAdmin.String(), createdBy)

	// FR-VEH-004 / DR-003, and the code a form branches on (ADR-0013).
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), body("NEW-1"))
	require.Equal(t, http.StatusConflict, rec.Code)
	var refusal refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
	require.Equal(t, "fleet_number_taken", refusal.Code)
	require.NotContains(t, rec.Body.String(), "vehicle_tenant_id_fleet_number_key")

	// Shape refusals, each 422 and each naming its field.
	for _, tt := range []struct{ name, payload, field string }{
		{"no fleet number", `{"fleetNumber":"  ","configurationId":"` + configID + `","unitKind":"HORSE"}`, "fleetNumber"},
		{"no unit kind", `{"fleetNumber":"X1","configurationId":"` + configID + `"}`, "unitKind"},
		{"unknown unit kind", `{"fleetNumber":"X2","configurationId":"` + configID + `","unitKind":"SPACESHIP"}`, "unitKind"},
		{"unparseable configuration", `{"fleetNumber":"X3","configurationId":"not-a-uuid","unitKind":"HORSE"}`, "configurationId"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Contains(t, ref.message(), tt.field)
		})
	}

	// A configuration that exists in another tenant is not a reference this
	// tenant can make: the composite FK (tenant_id, configuration_id) checks
	// below RLS, so the refusal is a foreign-key violation and not a leak of
	// whether that id exists (000004, TYRE-29 class).
	otherID, _ := plantTenantWithVehicle(t, ctx, admin, "createveh-other")
	otherAdmin := plantUser(t, ctx, admin, otherID, auth.RoleOrgAdmin)
	rec = get(t, h, "/api/axle-configurations", otherID.String(), otherAdmin.String())
	var otherConfigs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &otherConfigs))
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(),
		`{"fleetNumber":"CROSS-1","configurationId":"`+otherConfigs[0].ID+`","unitKind":"HORSE"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())

	// The row carries the actor's tenant. This proves the handler binds it
	// from the session — it does NOT prove the policy would refuse one that
	// did not, because the handler never sends a tenant to be refused. That
	// is Step 14's job, and this assertion must not be described as doing it.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.vehicle WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}

func (r refusalBody) message() string { return r.Message }

// The WITH CHECK half of tenant_isolation, which no test driven through a
// handler can reach: every handler binds tenant_id from the session, so none
// of them can produce the row this refuses. USING hides another tenant's
// rows; WITH CHECK refuses a row aimed AT one, and only an insert that names
// the other tenant exercises it.
func TestWriteAimedAtAnotherTenantIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenantWithVehicle(t, ctx, admin, "withcheck-a")
	tenantB, _ := plantTenantWithVehicle(t, ctx, admin, "withcheck-b")

	// Tenant B's own configuration, so the row is valid in every way except
	// the one under test. Borrowing tenant A's would fail the composite FK
	// even with the policy gone, and a test that cannot distinguish the two
	// refusals proves neither.
	var configB uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.axle_configuration WHERE tenant_id = $1`, tenantB).Scan(&configB))

	// created_by is stamped explicitly rather than left to its
	// app.current_actor_id() default (000017, DR-013): the default would
	// resolve to userA, and vehicle_created_by_fkey's own composite FK
	// (tenant_id, created_by) would then refuse this row on a foreign-key
	// violation whether or not tenant_isolation's WITH CHECK is even
	// evaluated — which would prove nothing about the policy under test.
	// userB is a real row in tenant B, so this is the one field that differs
	// from a genuine tenant-B insert being the tenant_id smuggled in above.
	userA := plantUser(t, ctx, admin, tenantA, auth.RoleOrgAdmin)
	userB := plantUser(t, ctx, admin, tenantB, auth.RoleOrgAdmin)
	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind, created_by)
			 VALUES ($1, 'SMUGGLED', $2, 'HORSE', $3)`,
			tenantB, configB, userB)
		return err
	})
	require.Error(t, err, "a row aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how a row-level security
	// policy refuses a write it will not admit.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.vehicle WHERE fleet_number = 'SMUGGLED'`).Scan(&landed))
	require.Zero(t, landed)
}

type createdUserBody struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	StaffNumber *string `json:"staffNumber"`
	Active      bool    `json:"active"`
}

func TestCreateUser(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "createuser")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	email := "new-driver-" + uuid.NewString()[:8] + "@example.invalid"
	body := `{"email":"` + email + `","displayName":"New Driver",` +
		`"staffNumber":"SBX-9001","role":"DRIVER"}`

	// ManageUsers is ORG_ADMIN's alone today (D9 keeps it so). A CONTROLLER
	// holds ManageAssets and not this.
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	rec := post(t, h, "/api/users", tenantID.String(), controller.String(), body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created createdUserBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, email, created.Email)
	require.Equal(t, "DRIVER", created.Role)
	require.True(t, created.Active, "a created user is active; leaving is active=false and is TYRE-83's")

	// D10: the rehire branch TYRE-83 builds needs to know which conflict it
	// hit, which is why this is not a generic conflict.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusConflict, rec.Code)
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "email_taken", ref.Code)
	require.NotContains(t, rec.Body.String(), "app_user_tenant_id_email_key")

	// ADR-0011: platform staff are never the subject of a tenant-scoped
	// request any more than they are its actor. Refused as an invalid role,
	// not left to platform_admin_has_no_tenant to catch.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(),
		`{"email":"pa-`+uuid.NewString()[:8]+`@example.invalid","displayName":"No","role":"PLATFORM_ADMIN"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "role")

	for _, tt := range []struct{ name, payload, field string }{
		{"no email", `{"displayName":"X","role":"DRIVER"}`, "email"},
		{"no display name", `{"email":"a@example.invalid","role":"DRIVER"}`, "displayName"},
		{"unknown role", `{"email":"b@example.invalid","displayName":"X","role":"WIZARD"}`, "role"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Contains(t, ref.Message, tt.field)
		})
	}

	// The row carries the actor's tenant, which proves the handler binds it
	// from the session. The policy's refusal of a row aimed elsewhere is a
	// different property and is proven by TestWriteAimedAtAnotherTenantIsRefused
	// (Task 3, Step 14), which issues the insert a handler cannot.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.app_user WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}

// The WITH CHECK half of tenant_isolation, which no test driven through a
// handler can reach: every handler binds tenant_id from the session, so none
// of them can produce the row this refuses. USING hides another tenant's
// rows; WITH CHECK refuses a row aimed AT one, and only an insert that names
// the other tenant exercises it.
//
// app.app_user.created_by is a self-referencing column with its own composite
// FK (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id) — if
// created_by is left at its default app.current_actor_id(), a row that
// smuggles in another tenant's tenant_id will fail on that FK, not on the RLS
// policy (000017, DR-013). To prove the policy fires, created_by must be
// stamped explicitly with a real user from the TARGET tenant.
func TestWriteAimedAtAnotherTenantIsRefused_AppUser(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "withcheck-appuser-a")
	tenantB, _ := plantTenant(t, ctx, admin, "withcheck-appuser-b")

	userA := plantUser(t, ctx, admin, tenantA, auth.RoleOrgAdmin)
	userB := plantUser(t, ctx, admin, tenantB, auth.RoleOrgAdmin)
	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.app_user (tenant_id, email, display_name, role, created_by)
			 VALUES ($1, 'smuggled@example.invalid', 'Smuggled', 'DRIVER'::app.user_role, $2)`,
			tenantB, userB)
		return err
	})
	require.Error(t, err, "a row aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how a row-level security
	// policy refuses a write it will not admit.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.app_user WHERE email = 'smuggled@example.invalid'`).Scan(&landed))
	require.Zero(t, landed)
}
