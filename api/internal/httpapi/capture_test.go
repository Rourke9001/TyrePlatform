package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

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
