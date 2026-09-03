package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// plantRigUnit adds one free unit of the given kind, on an axle configuration
// of its own. Members of a rig need not share one — 000011 dropped
// app.combination.configuration_id because a rig's shape is derived from its
// members — so giving each unit its own keeps the helper independent of the
// order its callers plant in.
func plantRigUnit(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, kind string) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var configID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, $2, 'rig test rig', 1) RETURNING id`,
		tenantID, "RIGTEST-"+suffix,
	).Scan(&configID))

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, $2, $3, $4::app.unit_kind) RETURNING id`,
		tenantID, kind+"-"+suffix, configID, kind,
	).Scan(&vehicleID))
	return vehicleID
}

// plantRigUnits is plantCaptureFixture's first half and deliberately no more:
// a tenant and one FREE horse/trailer pair, with no combination. The capture
// fixture plants an open rig of its own, and INV-4 (000037's
// combination_member_in_order) would then refuse every rig these tests set.
// Nothing the capture context reads beyond the unit row is planted either —
// app.config_for and app.removal_threshold_mm_for answer NULL for a tenant
// that has configured nothing, which is a 200 carrying nulls rather than a
// failure, and no test here reads a position.
func plantRigUnits(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) (uuid.UUID, uuid.UUID, uuid.UUID) {
	t.Helper()
	tenantID, _ := plantTenant(t, ctx, admin, label)
	return tenantID,
		plantRigUnit(t, ctx, admin, tenantID, "HORSE"),
		plantRigUnit(t, ctx, admin, tenantID, "TRAILER")
}

func fleetNumberOf(t *testing.T, ctx context.Context, admin *pgx.Conn, vehicleID uuid.UUID) string {
	t.Helper()
	var fleet string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT fleet_number FROM app.vehicle WHERE id = $1`, vehicleID).Scan(&fleet))
	return fleet
}

func countCombinations(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.combination WHERE tenant_id = $1`, tenantID).Scan(&n))
	return n
}

// rigBody is the wire shape D3 pins, as a test reads it.
type rigBody struct {
	ID                string  `json:"id"`
	MotiveVehicleID   string  `json:"motiveVehicleId"`
	MotiveFleetNumber string  `json:"motiveFleetNumber"`
	EffectiveFrom     string  `json:"effectiveFrom"`
	EffectiveTo       *string `json:"effectiveTo"`
	Members           []struct {
		VehicleID   string  `json:"vehicleId"`
		FleetNumber string  `json:"fleetNumber"`
		Sequence    int     `json:"sequence"`
		Descriptor  *string `json:"descriptor"`
		UnitKind    *string `json:"unitKind"`
	} `json:"members"`
}

// TYRE-72's DoD, end to end at the API: the controller sets the rig, and the
// driver assigned to the horse is offered it in the capture context. The
// capture read is the proof that matters — a rig the driver's screen cannot
// see is a rig that was never set, whatever the POST answered.
func TestCreateCombinationIsOfferedToTheDriver(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "rig-dod")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/combinations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q,"descriptor":"front"}]}`, horseID, trailerID))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var rig rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rig))
	require.Equal(t, horseID.String(), rig.MotiveVehicleID)
	require.Equal(t, fleetNumberOf(t, ctx, admin, horseID), rig.MotiveFleetNumber)
	require.Len(t, rig.Members, 2)
	// U7: the motive unit is member 1, and the towed units follow in the
	// order they were given.
	require.Equal(t, horseID.String(), rig.Members[0].VehicleID)
	require.Equal(t, 1, rig.Members[0].Sequence)
	require.Nil(t, rig.Members[0].Descriptor)
	require.Equal(t, "HORSE", *rig.Members[0].UnitKind)
	require.Equal(t, trailerID.String(), rig.Members[1].VehicleID)
	require.Equal(t, 2, rig.Members[1].Sequence)
	require.Equal(t, "front", *rig.Members[1].Descriptor)
	require.Equal(t, "TRAILER", *rig.Members[1].UnitKind)
	require.Nil(t, rig.EffectiveTo)

	ctxRec := get(t, h, "/api/capture/vehicles/"+horseID.String(), tenantID.String(), driver.String())
	require.Equal(t, http.StatusOK, ctxRec.Code, ctxRec.Body.String())
	var captured struct {
		Combination *struct {
			ID      string `json:"id"`
			Members []struct {
				VehicleID string `json:"vehicleId"`
			} `json:"members"`
		} `json:"combination"`
	}
	require.NoError(t, json.Unmarshal(ctxRec.Body.Bytes(), &captured))
	require.NotNil(t, captured.Combination, "the driver was not offered the rig the controller set")
	require.Equal(t, rig.ID, captured.Combination.ID)
	require.Len(t, captured.Combination.Members, 2)

	endRec := post(t, h, "/api/combinations/"+rig.ID+"/end", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusOK, endRec.Code, endRec.Body.String())
	var ended rigBody
	require.NoError(t, json.Unmarshal(endRec.Body.Bytes(), &ended))
	require.NotNil(t, ended.EffectiveTo, "the ended rig still projects an open effectiveTo")

	ctxRec = get(t, h, "/api/capture/vehicles/"+horseID.String(), tenantID.String(), driver.String())
	require.Equal(t, http.StatusOK, ctxRec.Code, ctxRec.Body.String())
	require.NoError(t, json.Unmarshal(ctxRec.Body.Bytes(), &captured))
	require.Nil(t, captured.Combination, "an ended rig is still offered to the driver")
}

// U2: rig reads gate on ViewFleet and rig writes on ManageAssignments, so a
// TECHNICIAN reads and does not write, and a DRIVER does neither.
func TestCombinationCapabilities(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "rig-caps")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/combinations", tenantID.String(), technician.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `[]`, rec.Body.String())

	body := fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, horseID, trailerID)
	rec = post(t, h, "/api/combinations", tenantID.String(), technician.String(), body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Equal(t, 0, countCombinations(t, ctx, admin, tenantID),
		"a TECHNICIAN's refused POST still wrote a rig")

	rec = get(t, h, "/api/combinations", tenantID.String(), driver.String())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// A TY017 raised by app.create_combination reaches the wire verbatim
// (ADR-0012's TY-class rule): the message names the fleet number the
// controller typed, which no Go constant could state.
func TestCombinationRefusalIsForwarded(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "rig-refusal")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/combinations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, trailerID, horseID))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())

	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY017", ref.Code)
	require.Equal(t,
		fmt.Sprintf("a rig is headed by a horse, rigid or light vehicle; %s is a trailer",
			fleetNumberOf(t, ctx, admin, trailerID)),
		ref.Message)
	require.Equal(t, 0, countCombinations(t, ctx, admin, tenantID))
}

// Shape is refused in Go before a transaction opens (ADR-0013 decision 5),
// and the message names the request field so a form can point at it.
func TestCombinationShapeRefusals(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "rig-shape")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, tc := range []struct {
		name, body, message string
	}{
		{
			name:    "motive is not a uuid",
			body:    fmt.Sprintf(`{"motiveVehicleId":"a horse","towed":[{"vehicleId":%q}]}`, trailerID),
			message: "motiveVehicleId must be a uuid",
		},
		{
			name:    "towed is absent",
			body:    fmt.Sprintf(`{"motiveVehicleId":%q}`, horseID),
			message: "towed is required",
		},
		{
			name:    "a towed id is not a uuid",
			body:    fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":"the red one"}]}`, horseID),
			message: "towed[0].vehicleId must be a uuid",
		},
		{
			name: "effectiveOn is not a date",
			body: fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}],"effectiveOn":"yesterday"}`,
				horseID, trailerID),
			message: "effectiveOn must be a date as YYYY-MM-DD",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, "/api/combinations", tenantID.String(), controller.String(), tc.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Equal(t, tc.message, ref.Message)
		})
	}

	// A path id that does not even parse is a malformed request, not an
	// invalid submission — pathID's 400, as every id-carrying route answers.
	rec := post(t, h, "/api/combinations/not-a-uuid/end", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "bad_request", ref.Code)

	require.Equal(t, 0, countCombinations(t, ctx, admin, tenantID))
}

// Both rig writes take their ids from the request and their tenant only from
// the session, so RLS's USING half is the whole refusal. Every probe here is
// planted so that a leak would make the call SUCCEED rather than merely
// change the error text: tenant B names a pair of tenant A units that are in
// no rig at all, and the control one line later — tenant A creating the very
// same rig — proves the refusal was tenant-caused and not INV-4 or a kind
// check answering first.
func TestCombinationCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, coupledHorse, coupledTrailer := plantRigUnits(t, ctx, admin, "rig-xten-a")
	freeHorse := plantRigUnit(t, ctx, admin, tenantA, "HORSE")
	freeTrailer := plantRigUnit(t, ctx, admin, tenantA, "TRAILER")
	tenantB, _ := plantTenant(t, ctx, admin, "rig-xten-b")
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// Tenant A's own rig, set through the API, so what tenant B tries to end
	// below is a rig that genuinely exists and is genuinely open.
	rec := post(t, h, "/api/combinations", tenantA.String(), controllerA.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, coupledHorse, coupledTrailer))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var rigA rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rigA))

	freePair := fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, freeHorse, freeTrailer)
	rec = post(t, h, "/api/combinations", tenantB.String(), controllerB.String(), freePair)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
		"tenant B coupled tenant A's units: RLS leaked the rows (got %s)", rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such unit in this fleet", ref.Message)
	require.Equal(t, 0, countCombinations(t, ctx, admin, tenantB))

	// The control: the identical body succeeds for the units' own tenant, so
	// the refusal above cannot have come from anything but the tenant.
	rec = post(t, h, "/api/combinations", tenantA.String(), controllerA.String(), freePair)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/combinations/"+rigA.ID+"/end", tenantB.String(), controllerB.String(), `{}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
		"tenant B ended tenant A's rig: RLS leaked the row (got %s)", rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such rig in this fleet", ref.Message)

	var stillOpen bool
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT effective_to IS NULL FROM app.combination WHERE id = $1`, rigA.ID).Scan(&stillOpen))
	require.True(t, stillOpen, "tenant A's rig was ended by tenant B's request")

	// The same control for the end path.
	rec = post(t, h, "/api/combinations/"+rigA.ID+"/end", tenantA.String(), controllerA.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = get(t, h, "/api/combinations", tenantB.String(), controllerB.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `[]`, rec.Body.String(), "tenant B's rig list carried tenant A's rigs")
}

// D3: open rigs first, then by start descending, and ?open=true narrows to
// the open ones.
func TestListCombinationsOrdersOpenFirst(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, firstHorse, firstTrailer := plantRigUnits(t, ctx, admin, "rig-order")
	secondHorse := plantRigUnit(t, ctx, admin, tenantID, "HORSE")
	secondTrailer := plantRigUnit(t, ctx, admin, tenantID, "TRAILER")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/combinations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, firstHorse, firstTrailer))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var endedRig rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &endedRig))

	rec = post(t, h, "/api/combinations/"+endedRig.ID+"/end", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/combinations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, secondHorse, secondTrailer))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var openRig rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &openRig))

	rec = get(t, h, "/api/combinations?open=true", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var open []rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &open))
	require.Len(t, open, 1)
	require.Equal(t, openRig.ID, open[0].ID)
	require.Nil(t, open[0].EffectiveTo)

	rec = get(t, h, "/api/combinations", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var all []rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &all))
	require.Len(t, all, 2)
	require.Equal(t, openRig.ID, all[0].ID, "the open rig is not listed first")
	require.Equal(t, endedRig.ID, all[1].ID)
	require.NotNil(t, all[1].EffectiveTo)
	require.Len(t, all[1].Members, 2)
}
