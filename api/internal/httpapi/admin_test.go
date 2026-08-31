package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

	// Shape refusals, each 422 and each naming its field. wantMessage is the
	// bare field-plus-why text ADR-0013 puts on the wire, with no wrapping
	// prefix.
	for _, tt := range []struct{ name, payload, wantMessage string }{
		{"no fleet number", `{"fleetNumber":"  ","configurationId":"` + configID + `","unitKind":"HORSE"}`, "fleetNumber is required"},
		{"no unit kind", `{"fleetNumber":"X1","configurationId":"` + configID + `"}`, "unitKind is required"},
		{"unknown unit kind", `{"fleetNumber":"X2","configurationId":"` + configID + `","unitKind":"SPACESHIP"}`, "unitKind must be one of HORSE, TRAILER, RIGID, LIGHT"},
		{"unparseable configuration", `{"fleetNumber":"X3","configurationId":"not-a-uuid","unitKind":"HORSE"}`, "configurationId must be a uuid"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Equal(t, tt.wantMessage, ref.Message)
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
	// is TestWriteAimedAtAnotherTenantIsRefused's job, and this assertion
	// must not be described as doing it.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.vehicle WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}

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

	// D9: a TECHNICIAN may not create any user, but a CONTROLLER may create a
	// DRIVER through InviteDriver. ManageUsers remains ORG_ADMIN's alone.
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	rec := post(t, h, "/api/users", tenantID.String(), technician.String(), body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created createdUserBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, email, created.Email)
	require.Equal(t, "DRIVER", created.Role)
	require.True(t, created.Active, "a created user is active; leaving is active=false and is TYRE-64's")

	// D10: the rehire branch this handler builds needs to know which conflict
	// it hit, which is why this is not a generic conflict.
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
	// different property, proven by
	// TestWriteAimedAtAnotherTenantIsRefused_AppUser, which issues the insert
	// a handler cannot.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.app_user WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}

// The WITH CHECK half of tenant_isolation — see
// TestWriteAimedAtAnotherTenantIsRefused for what this proves and why no
// handler-driven test can reach it any other way.
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

type assignmentBody struct {
	ID        string `json:"id"`
	VehicleID string `json:"vehicleId"`
	UserID    string `json:"userId"`
	FromDate  string `json:"fromDate"`
}

func TestAssignDriverToVehicle(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "assign")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	path := "/api/vehicles/" + vehicleID.String() + "/drivers"
	body := `{"userId":"` + driver.String() + `","fromDate":"2026-01-01"}`

	// The gate is ManageAssignments. A TECHNICIAN holds ViewFleet and no more.
	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	require.Equal(t, http.StatusForbidden,
		post(t, h, path, tenantID.String(), tech.String(), body).Code)

	rec := post(t, h, path, tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created assignmentBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, driver.String(), created.UserID)

	// The point of the endpoint: the assignment is what makes the unit
	// reachable, so the driver can now read it (FR-AUT-005,
	// app.v_capture_vehicle).
	require.Equal(t, http.StatusOK,
		get(t, h, "/api/capture/vehicles/"+vehicleID.String(), tenantID.String(), driver.String()).Code)

	// B1's vehicle_driver_no_overlap (000026), reachable for the first time
	// through an endpoint. Unmapped, 23P01 would answer 500.
	rec = post(t, h, path, tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "assignment_overlaps", ref.Code)
	require.NotContains(t, rec.Body.String(), "vehicle_driver_no_overlap")

	// An absent fromDate is not malformed — it defaults to the tenant's day
	// (rule 6, TestAssignmentDefaultsToTheTenantDay) — so this table holds
	// only genuinely malformed input.
	for _, tt := range []struct{ name, path, payload, field string }{
		{"unparseable vehicle", "/api/vehicles/not-a-uuid/drivers", body, "vehicleId"},
		{"unparseable user", path, `{"userId":"nope","fromDate":"2026-01-01"}`, "userId"},
		{"unparseable from date", path, `{"userId":"` + driver.String() + `","fromDate":"01/01/2026"}`, "fromDate"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, tt.path, tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Contains(t, ref.Message, tt.field)
		})
	}

	// A user in another tenant is not assignable here, and the composite FK
	// (tenant_id, user_id) is what refuses it below RLS (000004).
	otherID, _ := plantTenant(t, ctx, admin, "assign-other")
	stranger := plantUser(t, ctx, admin, otherID, auth.RoleDriver)
	rec = post(t, h, path, tenantID.String(), orgAdmin.String(),
		`{"userId":"`+stranger.String()+`","fromDate":"2026-01-01"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

// app.vehicle_driver carries three composite tenant FKs (000004, 000017), not
// tenant_isolation's usual one: (tenant_id, vehicle_id), (tenant_id, user_id)
// and (tenant_id, created_by). Leaving any of the three to a default or to a
// tenant-A value would fail that FK before WITH CHECK is ever evaluated
// (2026-08-28 lessons entry) — a red for the wrong reason, indistinguishable
// from a working policy. To isolate tenant_id as the sole confound,
// vehicle_id, user_id and created_by must each be a real row genuinely
// belonging to tenant B.
func TestWriteAimedAtAnotherTenantIsRefused_VehicleDriver(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenantWithVehicle(t, ctx, admin, "withcheck-vd-a")
	tenantB, vehicleB := plantTenantWithVehicle(t, ctx, admin, "withcheck-vd-b")

	var vehicleBID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`,
		tenantB, vehicleB).Scan(&vehicleBID))

	userA := plantUser(t, ctx, admin, tenantA, auth.RoleOrgAdmin)
	// driverB stands in for both the assignee and the created_by stamp: both
	// need only be a genuine tenant-B row, and one suffices for that.
	driverB := plantUser(t, ctx, admin, tenantB, auth.RoleDriver)

	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date, created_by)
			 VALUES ($1, $2, $3, '2026-01-01', $4)`,
			tenantB, vehicleBID, driverB, driverB)
		return err
	})
	require.Error(t, err, "a row aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how a row-level security
	// policy refuses a write it will not admit. 23503 would mean an FK fired
	// instead of the policy, which means the test's own setup is broken.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.vehicle_driver WHERE vehicle_id = $1 AND user_id = $2`,
		vehicleBID, driverB).Scan(&landed))
	require.Zero(t, landed)
}

// D9: the invite is narrowed by capability and not by role name, so the test
// asserts the pairing of actor and requested role rather than the actor alone.
// A CONTROLLER creating an ORG_ADMIN is the privilege-escalation path the
// decision exists to close, and it is the case worth failing loudly.
func TestTieredInvite(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "tiered")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	body := func(email, role string) string {
		return fmt.Sprintf(`{"email":%q,"displayName":"Someone","role":%q}`, email, role)
	}

	tests := []struct {
		name  string
		role  auth.Role
		makes string
		want  int
	}{
		{"controller invites a driver", auth.RoleController, "DRIVER", http.StatusCreated},
		{"depot manager invites a driver", auth.RoleDepotManager, "DRIVER", http.StatusCreated},
		{"controller may not invite an org admin", auth.RoleController, "ORG_ADMIN", http.StatusForbidden},
		{"controller may not invite a controller", auth.RoleController, "CONTROLLER", http.StatusForbidden},
		{"depot manager may not invite an org admin", auth.RoleDepotManager, "ORG_ADMIN", http.StatusForbidden},
		{"org admin invites any role", auth.RoleOrgAdmin, "ORG_ADMIN", http.StatusCreated},
		{"technician invites nobody", auth.RoleTechnician, "DRIVER", http.StatusForbidden},
		{"driver invites nobody", auth.RoleDriver, "DRIVER", http.StatusForbidden},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actor := plantUser(t, ctx, admin, tenantID, tt.role)
			email := fmt.Sprintf("tiered-%d-%s@example.invalid", i, uuid.NewString()[:8])
			rec := post(t, h, "/api/users", tenantID.String(), actor.String(), body(email, tt.makes))
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// D10: leaving a company is active = false, never a delete, so a rehire meets
// a unique constraint that spans inactive rows. The refusal has to say which
// collision it is, or the screen can only offer "that email is taken" to an
// admin whose next action is to reactivate the person.
func TestReactivateAnInactiveUser(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "rehire")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)

	email := "rehire-" + uuid.NewString()[:8] + "@example.invalid"
	create := fmt.Sprintf(
		`{"email":%q,"displayName":"Thandi First","role":"DRIVER","staffNumber":"BAC-4471"}`, email)

	rec := post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var first userBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &first))
	require.NotNil(t, first.StaffNumber)
	require.Equal(t, "BAC-4471", *first.StaffNumber)

	// An active collision stays email_taken: there is nothing to reactivate.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_taken", errorCode(t, rec))

	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, first.ID)
	require.NoError(t, err)

	// Now the same request is a rehire, and must say so rather than repeat
	// the sentence that tells the admin to pick another address.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_inactive", errorCode(t, rec))

	// The same request carrying the admin's answer reactivates in place: the
	// id is the original person's, so their inspection history stays theirs
	// (FR-VEH-008). It omits staffNumber, the way the reactivate form does —
	// absence must not wipe FR-AUT-022's identifier.
	reactivate := fmt.Sprintf(
		`{"email":%q,"displayName":"Thandi Returned","role":"DRIVER","reactivate":true}`, email)
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), reactivate)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var again userBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &again))
	require.Equal(t, first.ID, again.ID, "a rehire is the same person, not a new row")
	require.True(t, again.Active)
	require.Equal(t, "Thandi Returned", again.DisplayName)
	require.NotNil(t, again.StaffNumber, "a rehire that omits staffNumber must not clear it")
	require.Equal(t, "BAC-4471", *again.StaffNumber, "the returning employee's identifier survives")

	// And reactivating what is already active is not a silent no-op.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), reactivate)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_taken", errorCode(t, rec))
}

// An email that exists only in another tenant is invisible under
// tenant_isolation's USING half, so the classification SELECT finds nothing
// and the UPDATE's WHERE clause matches zero rows: the request falls through
// to a create, which must land in the actor's own tenant (rule 1) — proven
// below by resolving the response id through the admin connection, not by
// trusting the 201 body. WITH CHECK is not exercised here, because an UPDATE
// matching no rows never reaches it; that half of the policy is already
// proven by TestWriteAimedAtAnotherTenantIsRefused_AppUser's INSERT.
func TestReactivateCannotReachAnotherTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	mine, _ := plantTenantWithVehicle(t, ctx, admin, "rehire-mine")
	theirs, _ := plantTenantWithVehicle(t, ctx, admin, "rehire-theirs")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	email := "cross-" + uuid.NewString()[:8] + "@example.invalid"
	var victim uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role, active)
		 VALUES ($1, $2, 'Their Person', 'DRIVER', false) RETURNING id`,
		theirs, email).Scan(&victim))

	// My admin asks to reactivate an address only the other tenant holds. The
	// row is invisible under RLS, so this must read as "nobody here has that
	// address" and create a new user in MY tenant — never touch theirs.
	mineAdmin := plantUser(t, ctx, admin, mine, auth.RoleOrgAdmin)
	rec := post(t, h, "/api/users", mine.String(), mineAdmin.String(),
		fmt.Sprintf(`{"email":%q,"displayName":"Mine","role":"DRIVER","reactivate":true}`, email))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var stillInactive bool
	var owner uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT active, tenant_id FROM app.app_user WHERE id = $1`, victim).
		Scan(&stillInactive, &owner))
	require.False(t, stillInactive, "the other tenant's row must not have been reactivated")
	require.Equal(t, theirs, owner)

	// Rule 1's write half: the cross-tenant assertions above prove the OTHER
	// tenant's row was untouched, but not where the new row actually landed.
	// Resolve it through the admin connection so a handler that fabricated
	// its response body could not pass this test.
	var created userBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	var landedTenant string
	var landedActive bool
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id, active FROM app.app_user WHERE id = $1`, created.ID).
		Scan(&landedTenant, &landedActive))
	require.Equal(t, mine.String(), landedTenant)
	require.True(t, landedActive)
}

type userBody struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	StaffNumber *string `json:"staffNumber"`
	Active      bool    `json:"active"`
}

// errorCode reads the refusal envelope's machine-readable half (ADR-0012), so
// an assertion names the contract rather than a sentence that may be reworded.
// The envelope is flat — errorBody is {"code": …, "message": …} — with no
// wrapper key.
func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Code
}

// Two tenants 25 hours apart cannot share a civil date at any instant, so this
// holds whatever time CI runs at. An admin working late from another zone must
// not date a South African tenant's assignment a day out (rule 6).
func TestAssignmentDefaultsToTheTenantDay(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	east, _ := plantTenantInZone(t, ctx, admin, "tz-east", "Pacific/Kiritimati") // UTC+14
	west, _ := plantTenantInZone(t, ctx, admin, "tz-west", "Pacific/Midway")     // UTC-11

	landed := func(tenantID uuid.UUID) string {
		actor := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
		driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
		var vehicleID uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT id FROM app.vehicle WHERE tenant_id = $1 LIMIT 1`, tenantID).Scan(&vehicleID))

		var before string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT app.tenant_today(timezone)::text FROM app.tenant WHERE id = $1`,
			tenantID).Scan(&before))

		rec := post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
			tenantID.String(), actor.String(),
			fmt.Sprintf(`{"userId":%q}`, driver.String()))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

		var body struct {
			FromDate string `json:"fromDate"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

		// Read the tenant's day again after the write, and accept either.
		// A run straddling the tenant's midnight would otherwise flake, and a
		// test that lectures about clock independence must not depend on one.
		var after string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT app.tenant_today(timezone)::text FROM app.tenant WHERE id = $1`,
			tenantID).Scan(&after))
		require.Contains(t, []string{before, after}, body.FromDate)
		return body.FromDate
	}

	require.NotEqual(t, landed(east), landed(west),
		"two tenants 25 hours apart must never land an omitted date on the same day")

	// An explicit date is still honoured — the default is a default.
	actor := plantUser(t, ctx, admin, east, auth.RoleOrgAdmin)
	driver := plantUser(t, ctx, admin, east, auth.RoleDriver)
	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 LIMIT 1`, east).Scan(&vehicleID))
	rec := post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
		east.String(), actor.String(),
		fmt.Sprintf(`{"userId":%q,"fromDate":"2020-02-29"}`, driver.String()))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "2020-02-29")

	// A malformed date is still a malformed date, not a silent default.
	rec = post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
		east.String(), actor.String(),
		fmt.Sprintf(`{"userId":%q,"fromDate":"29-02-2020"}`, driver.String()))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}
