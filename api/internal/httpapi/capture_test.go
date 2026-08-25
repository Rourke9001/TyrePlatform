package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

func TestCaptureContextIsCapabilityGatedAndCarriesNoMoney(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "capture")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusOK},
		{auth.RoleTechnician, http.StatusForbidden},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			if tt.role == auth.RoleDriver {
				// FR-AUT-005 gates capture on this exact assignment, and this
				// driver did not exist when plantCaptureFixture ran, so the
				// fixture could not have made it. Motive unit only, never
				// the trailer: that is the one thing that actually exercises
				// app.v_capture_vehicle below rather than app.v_driver_vehicle
				// alone (see assignVehicleDriver).
				assignVehicleDriver(t, ctx, admin, tenantID, vehicleID, userID)
			}
			rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(), tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())

			if tt.want != http.StatusOK {
				return
			}
			// FR-AUT-005a: a DRIVER does not hold ViewValuation, and the
			// control is the projection, not the client omitting a field.
			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			raw := rec.Body.String()
			for _, banned := range []string{"randPerMm", "casingValue", "treadValue", "purchasePrice"} {
				require.NotContains(t, raw, banned, "a monetary field reached the capture payload")
			}
			require.NotEmpty(t, body["positions"], "capture cannot proceed without positions")

			// FR-INS-062: the rig the controller set, for the driver to
			// confirm. The fixture's comb1 is horse + 6m + 12m.
			if tt.role == auth.RoleDriver {
				require.NotNil(t, body["combination"], "a rig's motive unit served no composition")
			}

			// The hole v_capture_vehicle exists to close, pinned as its own
			// case: driver1 holds veh1 and veh3, their veh2 assignment ended
			// in 2024, and all three are members of comb1. Before the view,
			// this 403s and a superlink cannot be inspected.
			for _, m := range body["combination"].(map[string]any)["members"].([]any) {
				member := m.(map[string]any)["vehicleId"].(string)
				rec := get(t, h, "/api/capture/vehicles/"+member, tenantID.String(), userID.String())
				require.Equal(t, http.StatusOK, rec.Code,
					"a driver could not read a member unit of their own rig: "+member)
			}
			require.NotNil(t, body["config"], "capture cannot evaluate warnings without thresholds")

			// FR-OFF-002 as amended by E2. Each of these is the sole input to
			// a Must inside Appendix H.1, and each is unreachable once
			// FR-OFF-001 takes the signal away — so an absent field is a
			// warning that silently never fires, not a cosmetic gap.
			cfg, ok := body["config"].(map[string]any)
			require.True(t, ok)
			require.NotNil(t, cfg["wearRateAlertMultiple"], "FR-INS-035 has no multiple")
			require.NotNil(t, cfg["removalThresholdMm"], "FR-INS-036 has no threshold")
			require.NotNil(t, cfg["widthSpreadWarnMm"], "FR-INS-041 has no margin")
			require.NotNil(t, cfg["odometerMaxDailyKm"], "FR-INS-033 has no ceiling")
			require.NotNil(t, body["cohortWearRateMmPerMonth"], "FR-INS-035 has no denominator")

			// A running position must carry a resolvable target; a spare must
			// not (FR-CFG-013 as amended — a spare's pressure is recorded and
			// deliberately unclassified, and a zero would be a claim).
			var sawRunningTarget bool
			for _, raw := range body["positions"].([]any) {
				pos := raw.(map[string]any)
				_, hasPrev := pos["previousGoverningMm"]
				require.True(t, hasPrev, "FR-INS-034 has no previous reading to compare against")
				_, hasFit := pos["fitmentSincePrevious"]
				require.True(t, hasFit, "FR-INS-034 cannot excuse an increase without fitment state")
				if pos["isSpare"] == true {
					require.Nil(t, pos["targetKpa"], "a spare was given a pressure target")
					continue
				}
				if pos["targetKpa"] != nil {
					sawRunningTarget = true
					require.NotNil(t, pos["warnUnderPct"], "FR-INS-037 has no band edge")
					require.NotNil(t, pos["criticalOverPct"], "FR-INS-031a has no confirmation point")
				}
			}
			require.True(t, sawRunningTarget,
				"no running position resolved a target — app.target_pressure is seeded by 000013, "+
					"so this means the resolution join is wrong, not that the tenant has no targets")
		})
	}
}

// captureFixture builds a valid app.submit_inspection payload for vehicleID:
// one reading, on the vehicle's first non-spare position (plantCaptureFixture's
// leftPos, which already carries a fitted tyre so this exercises the FR-OFF-016
// tyre-match path rather than an always-nil tyre_id), with the tenant's
// configured tread_reading_count of measurements. A fresh client_uuid every
// call is what lets FR-INS-038's case ask for a second, distinct inspection
// rather than replaying the first.
func captureFixture(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, vehicleID uuid.UUID) string {
	t.Helper()

	var positionID uuid.UUID
	var tyreID *uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT p.id, f.tyre_id
		   FROM app.position p
		   JOIN app.vehicle v ON v.configuration_id = p.configuration_id
		   LEFT JOIN app.fitment f
		          ON f.position_id = p.id AND f.vehicle_id = v.id AND f.removed_at IS NULL
		  WHERE v.id = $1 AND NOT p.is_spare
		  ORDER BY p.sequence LIMIT 1`,
		vehicleID,
	).Scan(&positionID, &tyreID))

	now := time.Now().UTC()
	payload := map[string]any{
		"client_uuid":      uuid.New().String(),
		"vehicle_id":       vehicleID.String(),
		"started_at":       now.Add(-2 * time.Minute).Format(time.RFC3339),
		"submitted_at":     now.Format(time.RFC3339),
		"odometer_km":      60000,
		"duration_seconds": 120,
		"readings": []map[string]any{
			{
				"vehicle_id":   vehicleID.String(),
				"position_id":  positionID.String(),
				"tyre_id":      tyreID,
				"pressure_kpa": 800,
				"treads":       []float64{8.0, 8.5, 8.2},
			},
		},
	}
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	return string(raw)
}

// FR-OFF-011: an uncertain network must be safe to retry. The outbox replays
// on any answer it did not clearly receive, so this is the single most
// load-bearing assertion in the API.
func TestSubmitReplayContract(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "submit")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	// FR-AUT-005: plantCaptureFixture deliberately plants no assignment
	// (its docstring names this calling convention) — without it the
	// driver's own submit would 403 before ever reaching submit_inspection.
	assignVehicleDriver(t, ctx, admin, tenantID, vehicleID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	payload := captureFixture(t, ctx, admin, tenantID, vehicleID)

	first := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), payload)
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())

	var a, b struct {
		InspectionID string `json:"inspectionId"`
	}
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &a))
	require.NotEmpty(t, a.InspectionID)

	replay := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), payload)
	require.Equal(t, http.StatusOK, replay.Code, replay.Body.String())
	require.NoError(t, json.Unmarshal(replay.Body.Bytes(), &b))
	require.Equal(t, a.InspectionID, b.InspectionID, "a replay created a second inspection")
}

func TestSubmitRefusals(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "refuse")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	// The technician is deliberately left unassigned: its 403 below must be
	// attributable to the missing CaptureInspection capability alone, and
	// require() fires before the FR-AUT-005 scope check ever runs.
	assignVehicleDriver(t, ctx, admin, tenantID, vehicleID, driverID)
	techID := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/inspections", tenantID.String(), techID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code,
		"a TECHNICIAN does not hold CaptureInspection")

	require.Equal(t, http.StatusBadRequest,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(), "{not json").Code)

	// FR-INS-038 is a permanent refusal: the outbox must surface FR-OFF-013's
	// recovery action rather than retry it for thirty minutes, which is why it
	// cannot share a status with 422's malformed vehicle.
	require.Equal(t, http.StatusCreated,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code)
	require.Equal(t, http.StatusConflict,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code)
}

// TestSubmitUnknownVehicleIsUnprocessable pins TY007 ("vehicle not visible"):
// app.submit_inspection's own comment explains that SQLSTATE exists so an
// unrecognised or cross-tenant vehicle_id never falls through to the
// composite FK violation (23503), which is not in submitStatus and would
// otherwise surface as a 500 — telling the outbox to retry forever something
// that will never succeed. A CONTROLLER (ScopeTenant) is used deliberately:
// it skips the handler's own FR-AUT-005 v_capture_vehicle check, so this is
// the one path that actually reaches submit_inspection's own guard.
func TestSubmitUnknownVehicleIsUnprocessable(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "unknownveh")
	controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, vehicleID)), &body))
	body["vehicle_id"] = uuid.New().String()
	raw, err := json.Marshal(body)
	require.NoError(t, err)

	rec := post(t, h, "/api/inspections", tenantID.String(), controllerID.String(), string(raw))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}
