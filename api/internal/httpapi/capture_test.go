package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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
				// FR-AUT-005 gates capture on this exact trip, and this driver
				// did not exist when plantCaptureFixture ran, so the fixture
				// could not have made it. The trip is on the motive alone: the
				// trailer is reached through the rig, which the member reads
				// below exercise.
				plantTrip(t, ctx, admin, tenantID, vehicleID, userID)
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
			// case: the trip is on the motive alone, and every member of its
			// rig must still read. Without the rig leg a member 403s and a
			// superlink cannot be inspected.
			for _, m := range body["combination"].(map[string]any)["members"].([]any) {
				member := m.(map[string]any)["vehicleId"].(string)
				rec := get(t, h, "/api/capture/vehicles/"+member, tenantID.String(), userID.String())
				require.Equal(t, http.StatusOK, rec.Code,
					"a driver could not read a member unit of their own rig: "+member)
			}
			require.NotNil(t, body["config"], "capture cannot evaluate warnings without thresholds")

			// FR-OFF-002 as amended by E2. Each of these is the sole input to
			// a Must inside Appendix H.1, and each is unreachable once
			// FR-OFF-001 takes the signal away, so an absent field is a
			// warning that silently never fires, not a cosmetic gap.
			cfg, ok := body["config"].(map[string]any)
			require.True(t, ok)
			require.NotNil(t, cfg["wearRateAlertMultiple"], "FR-INS-035 has no multiple")
			require.NotNil(t, cfg["removalThresholdMm"], "FR-INS-036 has no threshold")
			require.NotNil(t, cfg["widthSpreadWarnMm"], "FR-INS-041 has no margin")
			require.NotNil(t, cfg["odometerMaxDailyKm"], "FR-INS-033 has no ceiling")
			// TYRE-155: rule 5, whether spares are captured is served, not assumed.
			require.Equal(t, true, cfg["captureSpares"], "TYRE-155: whether spares are captured is tenant configuration")
			require.NotNil(t, body["cohortWearRateMmPerMonth"], "FR-INS-035 has no denominator")

			// A running position must carry a resolvable target; a spare must
			// not (FR-CFG-013 as amended, a spare's pressure is recorded and
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
					// TYRE-147: a spare has no side, so the sheet must not
					// attempt to draw a mirrored glyph for one.
					require.Nil(t, pos["side"], "a spare was given a side")
					continue
				}
				// TYRE-147: submit_inspection maps entry order to
				// OUTER/CENTRE/INNER by this side (000023 v_side), so a
				// running position must carry one for the sheet to agree with.
				require.Contains(t, []any{"LEFT", "RIGHT"}, pos["side"],
					"a running position's side was not served")
				if pos["targetKpa"] != nil {
					sawRunningTarget = true
					require.NotNil(t, pos["warnUnderPct"], "FR-INS-037 has no band edge")
					require.NotNil(t, pos["criticalOverPct"], "FR-INS-031a has no confirmation point")
				}
			}
			require.True(t, sawRunningTarget,
				"no running position resolved a target. app.target_pressure is seeded by 000013, "+
					"so this means the resolution join is wrong, not that the tenant has no targets")
		})
	}
}

// capturePositionAndTyre looks up vehicleID's first non-spare position (by
// sequence) and any tyre currently fitted there. Positions belong to the
// axle_configuration, not the vehicle row, so this resolves correctly for
// any vehicle sharing plantCaptureFixture's one shared configuration:
// motive unit or trailer alike.
func capturePositionAndTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, vehicleID uuid.UUID) (uuid.UUID, *uuid.UUID) {
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
	return positionID, tyreID
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

	positionID, tyreID := capturePositionAndTyre(t, ctx, admin, vehicleID)

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
	// FR-AUT-005: plantCaptureFixture deliberately plants no trip (its
	// docstring names this calling convention). Without it the
	// driver's own submit would 403 before ever reaching submit_inspection.
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
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
	// The technician is deliberately left on no trip: its 403 below must be
	// attributable to the missing CaptureInspection capability alone, and
	// require() fires before the FR-AUT-005 scope check ever runs.
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
	techID := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/inspections", tenantID.String(), techID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code,
		"a TECHNICIAN does not hold CaptureInspection")

	require.Equal(t, http.StatusBadRequest,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(), "{not json").Code)

	// This route decodes only vehicle_id, and it answers a vehicle_id of the
	// wrong type with the generic refusal and no field name, which
	// malformed_json's registry meaning says.
	rec := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), `{"vehicle_id":5}`)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, refusalBody{Code: "malformed_json", Message: "malformed json"}, ref)

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

// ADR-0013 decision 5: the submit hands its payload to SQL unparsed, and
// uuid.Parse reads two forms of the payload's vehicle_id that Postgres's
// ::uuid cast does not, a urn:uuid: prefix and a 38-byte form, the id with
// one byte on each side, unless those are { and }. Each body in the table
// below is a 400 naming vehicle_id here, where a whole payload would
// otherwise reach the cast as a 22P02 canned as a 422 that names no field
// (TYRE-379).
func TestSubmitRefusesAVehicleIDFormTheCastDoesNotRead(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "vehicle-id-forms")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// A whole payload, so a body that got past Go would reach the cast and
	// not stop at an earlier refusal for a missing field.
	payload := func(set map[string]string) string {
		var body map[string]any
		require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, vehicleID)), &body))
		for key, value := range set {
			body[key] = value
		}
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		return string(raw)
	}
	inspections := func() int {
		var n int
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT count(*) FROM app.inspection WHERE vehicle_id = $1`, vehicleID).Scan(&n))
		return n
	}
	planted := inspections()
	id := vehicleID.String()
	for _, tc := range []struct{ name, body string }{
		{"a urn and no other field", `{"vehicle_id":"urn:uuid:` + id + `"}`},
		{"a urn", payload(map[string]string{"vehicle_id": "urn:uuid:" + id})},
		{"an upper-case urn", payload(map[string]string{"vehicle_id": "URN:UUID:" + strings.ToUpper(id)})},
		{"square brackets", payload(map[string]string{"vehicle_id": "[" + id + "]"})},
		{"parentheses", payload(map[string]string{"vehicle_id": "(" + id + ")"})},
		{"a space each side", payload(map[string]string{"vehicle_id": " " + id + " "})},
		{"an opening brace and a closing bracket", payload(map[string]string{"vehicle_id": "{" + id + "]"})},
		// encoding/json matches the key without regard to case and Postgres
		// reads the exact one, so this urn is the vehicle_id the cast meets.
		{"a urn beside a canonical id under a key in capitals", payload(map[string]string{
			"vehicle_id": "urn:uuid:" + id, "VEHICLE_ID": id,
		})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), tc.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, refusalBody{
				Code:    "malformed_json",
				Message: "vehicle_id holds a uuid in a form this field does not accept",
			}, ref)
		})
	}
	require.Equal(t, planted, inspections(), "a refused submit lands no inspection")

	// The controls: three forms the cast reads go past Go. The braced one is
	// stored, and the two after it reach FR-INS-038's TY003, raised after
	// app.actor_could_capture and app.submit_inspection's declarations have
	// cast this payload's vehicle_id.
	braced := post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
		payload(map[string]string{"vehicle_id": "{" + id + "}"}))
	require.Equal(t, http.StatusCreated, braced.Code, braced.Body.String())
	require.Equal(t, planted+1, inspections(), "the braced id is stored as the unit's own")
	for _, form := range []string{strings.ToUpper(id), strings.ReplaceAll(id, "-", "")} {
		t.Run(form, func(t *testing.T) {
			rec := post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
				payload(map[string]string{"vehicle_id": form}))
			require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "TY003", ref.Code, "a 409 from the window check, not a unique or exclusion violation")
		})
	}
}

// TestSubmitUnknownVehicleIsUnprocessable pins TY007 ("vehicle not visible"):
// app.submit_inspection's own comment explains that SQLSTATE exists so an
// unrecognised or cross-tenant vehicle_id never falls through to the
// composite FK violation (23503), which is not in submitStatus and would
// otherwise surface as a 500, telling the outbox to retry forever something
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

// plantUnrelatedVehicle plants a second vehicle in tenantID with its own
// axle_configuration and single running position, coupled to nothing,
// on no trip. It exists to be the vehicle a driver has no route to
// through app.v_capture_vehicle, for the FR-AUT-005 per-reading check below.
func plantUnrelatedVehicle(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) (uuid.UUID, uuid.UUID) {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var configID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, $2, 'unrelated test rig', 1) RETURNING id`,
		tenantID, "UNRELATED-"+suffix,
	).Scan(&configID))

	var positionID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.position
		   (tenant_id, configuration_id, code, sequence, axle_number, axle_class, side, slot, is_spare)
		 VALUES ($1, $2, '1L', 1, 1, 'STEER'::app.axle_class, 'LEFT'::app.side, 'SINGLE'::app.fitment_slot, false)
		 RETURNING id`,
		tenantID, configID,
	).Scan(&positionID))

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind) VALUES ($1, $2, $3, 'HORSE'::app.unit_kind) RETURNING id`,
		tenantID, "UNRELATED-"+suffix, configID,
	).Scan(&vehicleID))

	return vehicleID, positionID
}

// TestSubmitAuthorizesEveryVehicleInASuperlinkPayload proves the FR-AUT-005
// fix does not break the platform's actual reason for existing: a driver
// responsible for a motive unit must be able to submit readings against its
// coupled trailer in the SAME payload (CLAUDE.md's "108 entries, not 52").
// The driver's trip is on the motive unit only. The trailer is reachable
// solely through the rig leg of app.v_unit_coverage.
func TestSubmitAuthorizesEveryVehicleInASuperlinkPayload(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, trailerID := plantCaptureFixture(t, ctx, admin, "superlink")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, motiveID)), &body))

	trailerPositionID, trailerTyreID := capturePositionAndTyre(t, ctx, admin, trailerID)
	readings, ok := body["readings"].([]any)
	require.True(t, ok)
	body["readings"] = append(readings, map[string]any{
		"vehicle_id":   trailerID.String(),
		"position_id":  trailerPositionID.String(),
		"tyre_id":      trailerTyreID,
		"pressure_kpa": 800,
		"treads":       []float64{7.0, 7.5, 7.2},
	})
	raw, err := json.Marshal(body)
	require.NoError(t, err)

	rec := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), string(raw))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

// TestSubmitRefusesReadingAgainstUnauthorizedVehicle is the negative half of
// the FR-AUT-005 fix: a payload whose top-level vehicle_id the driver may
// reach, but that embeds a reading against an unrelated vehicle in the same
// tenant, one on no trip and in no coupling, must be refused entirely,
// not silently accepted for the one unit that slipped past the top-level check.
//
// The statuses are pinned together deliberately: see errVehicleNotVisible in
// httpapi.go, and TestSubmitUnknownVehicleIsUnprocessable for the SQL-side
// half.
func TestSubmitRefusesReadingAgainstUnauthorizedVehicle(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "unauth-reading")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	unrelatedVehicleID, unrelatedPositionID := plantUnrelatedVehicle(t, ctx, admin, tenantID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, motiveID)), &body))
	readings, ok := body["readings"].([]any)
	require.True(t, ok)
	body["readings"] = append(readings, map[string]any{
		"vehicle_id":   unrelatedVehicleID.String(),
		"position_id":  unrelatedPositionID.String(),
		"pressure_kpa": 800,
		"treads":       []float64{7.0, 7.5, 7.2},
	})
	raw, err := json.Marshal(body)
	require.NoError(t, err)

	rec := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), string(raw))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

// TestSubmitEndpointIsRateLimited proves NFR-SEC-007's middleware is actually
// wired onto POST /api/inspections through the real New(...) router, not
// merely correct in isolation. A malformed body is deliberate: the limiter
// runs ahead of the handler in the chain, so it still consumes budget on a
// 400, which keeps this test fast and independent of the capture fixture. It
// also doubles as empirical proof that requireActor's identity is visible to
// the limiter. If it were not, every request here would 500 instead of 400,
// and none would ever reach 429 (see submitRateLimit's own doc comment).
func TestSubmitEndpointIsRateLimited(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderActorResolver{})
	tenant := uuid.NewString()
	user := uuid.NewString()

	var sawAllowed, saw429 bool
	for i := 0; i < 61 && !saw429; i++ {
		rec := post(t, h, "/api/inspections", tenant, user, "{not json")
		switch rec.Code {
		case http.StatusTooManyRequests:
			saw429 = true
		case http.StatusBadRequest:
			sawAllowed = true
		default:
			t.Fatalf("request %d: unexpected status %d: %s", i, rec.Code, rec.Body.String())
		}
	}
	require.True(t, sawAllowed, "an earlier request in the run must not have been refused")
	require.True(t, saw429, "the account limit must eventually refuse this single user")
}

// TestSubmitUnretryableShapesAreClientErrors is the endpoint-level half of the
// rule submitStatus states: a payload that can only ever fail must answer 4xx.
// Per ADR-0009 the outbox retries a 5xx with backoff to a 30-minute ceiling
// and never gives up, so a shape that reaches the transport unmapped is an
// inspection that can never be delivered, a queue FR-OFF-020 will nag about
// forever, and no recovery action the driver can take.
//
// The cases are deliberately of both kinds. app.submit_inspection refuses what
// it can name (FR-INS-030/031's ranges, an absent readings array) as TY005;
// what it cannot pre-empt, an id this tenant cannot see, a field that will
// not parse as its column's type, which the function's own DECLARE casts
// before any guard runs, arrives as a bare integrity SQLSTATE and is mapped
// here. Both halves are only observable through the endpoint, which is the
// only surface the outbox ever sees. Since both kinds answer the same 422,
// the code and the driver-facing message fragment together are what
// distinguish a named guard from the constraint behind it.
func TestSubmitUnretryableShapesAreClientErrors(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "unretryable")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
	controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	firstReading := func(body map[string]any) map[string]any {
		return body["readings"].([]any)[0].(map[string]any)
	}

	tests := []struct {
		name                string
		mutate              func(map[string]any)
		wantCode            string
		wantMessageContains string
		// A driver meets the own-units check before the insert, so a case
		// that exists to prove the insert's own mapping submits as a
		// tenant-wide role, which the check exempts.
		asController bool
	}{
		// An id this tenant cannot see arrives as a bare 23503, a
		// client_uuid that will not cast as a 22P02 from the function's own
		// DECLARE; both answer the canned invalid_submission (ADR-0012).
		{"a tyre_id this tenant cannot see", func(b map[string]any) {
			firstReading(b)["tyre_id"] = uuid.NewString()
		}, "invalid_submission", "refused as invalid", false},
		{"a combination_id this tenant cannot see", func(b map[string]any) {
			b["combination_id"] = uuid.NewString()
		}, "invalid_submission", "refused as invalid", true},
		{"a client_uuid that is not a uuid", func(b map[string]any) {
			b["client_uuid"] = "not-a-uuid"
		}, "invalid_submission", "refused as invalid", false},
		// The five TY005 shapes share a code; the fragment is the driver-facing
		// text FR-OFF-013 turns into a recovery action, and the only thing that
		// tells the guard from the constraint behind it (see the doc comment).
		{"a tread outside FR-INS-030's range", func(b map[string]any) {
			firstReading(b)["treads"] = []float64{8.0, 40.0, 8.2}
		}, "TY005", "is outside the accepted range of 0 to", false},
		{"a pressure outside FR-INS-031's range", func(b map[string]any) {
			firstReading(b)["pressure_kpa"] = 5000
		}, "TY005", "kPa is outside the accepted range", false},
		{"a null inside treads", func(b map[string]any) {
			firstReading(b)["treads"] = []any{8.0, nil, 8.2}
		}, "TY005", "is not a number", false},
		{"no readings at all", func(b map[string]any) {
			delete(b, "readings")
		}, "TY005", "carries no readings array", false},
		{"an empty readings array", func(b map[string]any) {
			b["readings"] = []any{}
		}, "TY005", "carries an empty readings array", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			require.NoError(t, json.Unmarshal(
				[]byte(captureFixture(t, ctx, admin, tenantID, vehicleID)), &body))
			tc.mutate(body)
			raw, err := json.Marshal(body)
			require.NoError(t, err)

			actor := driverID
			if tc.asController {
				actor = controllerID
			}
			rec := post(t, h, "/api/inspections", tenantID.String(), actor.String(), string(raw))
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			ref := decodeRefusal(t, rec.Body.Bytes())
			require.Equal(t, tc.wantCode, ref.Code, rec.Body.String())
			require.Contains(t, ref.Message, tc.wantMessageContains, rec.Body.String())
		})
	}
}

// FR-TYR-017: each position's previous reading carries its age in the
// fleet's calendar, beside FR-INS-034's previous figure. The fixture's
// sheets are months back, so a field left at zero cannot pass.
func TestCaptureContextCarriesPreviousReadingAge(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/capture/vehicles/"+seedID("veh1").String(), bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Positions []struct {
			Code                   string  `json:"code"`
			PreviousReadingAt      *string `json:"previousReadingAt"`
			PreviousReadingAgeDays *int    `json:"previousReadingAgeDays"`
		} `json:"positions"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	read := 0
	for _, p := range body.Positions {
		if p.PreviousReadingAt == nil {
			require.Nil(t, p.PreviousReadingAgeDays, p.Code)
			continue
		}
		want := tenantDaysSince(t, ctx, admin, uuid.MustParse(bacTenant), *p.PreviousReadingAt)
		require.GreaterOrEqual(t, want, 2, "the premise: %s was read days back", p.Code)
		require.NotNil(t, p.PreviousReadingAgeDays, p.Code)
		require.Equal(t, want, *p.PreviousReadingAgeDays, p.Code)
		read++
	}
	require.Positive(t, read, "the fixture's veh1 has read positions")
}

// TestCaptureContextServesTheLastOdometerReading pins the last odometer value
// AND the date it was taken: FR-INS-032 refuses a reading below the value,
// and the start screen names its age.
//
// The join that resolves them is a LEFT JOIN LATERAL taking one row ordered by
// reading_date DESC, then odometer_km DESC, so two things need proving and
// neither is visible from the fixture: that an absent reading serves null
// rather than a zero, and that "last" means the most recent by reading date
// rather than whichever row the planner happened to reach first.
//
// The same two rows settle FR-INS-020's pre-fill, which is why it is asserted
// here rather than apart: the projection the driver confirms is this reading
// carried forward at averageDailyKm, so the rate has to be derived from the
// odometer timeline and to be absent whenever the timeline cannot support one.
func TestCaptureContextServesTheLastOdometerReading(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "odometer")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	read := func(t *testing.T) struct {
		LastOdometerKm      *int64     `json:"lastOdometerKm"`
		LastOdometerAt      *time.Time `json:"lastOdometerAt"`
		LastOdometerAgeDays *int       `json:"lastOdometerAgeDays"`
		AverageDailyKm      *float64   `json:"averageDailyKm"`
	} {
		t.Helper()
		rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(),
			tenantID.String(), driverID.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			LastOdometerKm      *int64     `json:"lastOdometerKm"`
			LastOdometerAt      *time.Time `json:"lastOdometerAt"`
			LastOdometerAgeDays *int       `json:"lastOdometerAgeDays"`
			AverageDailyKm      *float64   `json:"averageDailyKm"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}

	// No unit has an odometer reading until an inspection writes one, and a
	// client cannot tell "never measured" from "measured as zero" (FR-INS-020).
	before := read(t)
	require.Nil(t, before.LastOdometerKm, "a vehicle with no reading served an odometer value")
	require.Nil(t, before.LastOdometerAt, "a vehicle with no reading served a reading date")
	require.Nil(t, before.LastOdometerAgeDays, "a vehicle with no reading served an age")
	require.Nil(t, before.AverageDailyKm,
		"a vehicle with no timeline served a rate, which FR-INS-020 would project from")

	// Planted oldest-last, so a join that ignored the ORDER BY would be as
	// likely to serve the older row. Both values are plausible and rising:
	// DR-020's trigger refuses a backwards or implausible reading outright.
	for _, r := range []struct {
		daysAgo int
		km      int64
	}{
		{5, 110000},
		{30, 100000},
	} {
		_, err := admin.Exec(ctx,
			`INSERT INTO app.vehicle_odometer_reading
			   (tenant_id, vehicle_id, reading_date, odometer_km, source)
			 VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, $4, 'MANUAL')`,
			tenantID, vehicleID, r.daysAgo, r.km)
		require.NoError(t, err)
	}

	after := read(t)
	require.NotNil(t, after.LastOdometerKm, "a planted odometer reading did not reach the capture context")
	require.NotNil(t, after.LastOdometerAt, "a planted odometer reading served no reading date")
	require.Equal(t, int64(110000), *after.LastOdometerKm, "the older reading was served as the last one")

	wantDate := time.Now().UTC().AddDate(0, 0, -5).Format("2006-01-02")
	require.Equal(t, wantDate, after.LastOdometerAt.UTC().Format("2006-01-02"))

	// 10 000 km over the 25 days between the two readings. Asserted as an
	// exact figure because the projection a driver is asked to confirm is only
	// as honest as this number: a rate derived from the wrong span pre-fills a
	// value the unit never reached, and confirming it is how FR-INS-020 would
	// put a fiction on an append-only timeline (DR-018).
	require.NotNil(t, after.AverageDailyKm, "two readings 25 days apart yielded no rate")
	require.InDelta(t, 400.0, *after.AverageDailyKm, 0.005)
}

// The unique key admits one reading per source per day, so two sources can
// share the last date. An odometer only rises, so the higher one is the later
// reading. The higher is planted first, so a pick in insertion order or its
// reverse would each serve the wrong one in one of the two runs.
func TestCaptureContextServesTheHigherOfTwoReadingsOnOneDay(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, order := range [][]int64{{125000, 120000}, {120000, 125000}} {
		t.Run(fmt.Sprintf("planted %d then %d", order[0], order[1]), func(t *testing.T) {
			tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin,
				fmt.Sprintf("odometer-tie-%d", order[0]))
			driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
			plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
			for i, km := range order {
				_, err := admin.Exec(ctx,
					`INSERT INTO app.vehicle_odometer_reading
					   (tenant_id, vehicle_id, reading_date, odometer_km, source)
					 VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - 2, $3, $4)`,
					tenantID, vehicleID, km, []string{"MANUAL", "FUEL_RECORD"}[i])
				require.NoError(t, err)
			}

			rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(),
				tenantID.String(), driverID.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var body struct {
				LastOdometerKm *int64 `json:"lastOdometerKm"`
				OdometerBaseKm *int64 `json:"odometerBaseKm"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			require.NotNil(t, body.LastOdometerKm)
			require.Equal(t, int64(125000), *body.LastOdometerKm,
				"the lower of two readings on the last day was served as the last one")
			require.NotNil(t, body.OdometerBaseKm)
			require.Equal(t, int64(125000), *body.OdometerBaseKm,
				"the lower of two readings on the base day was served as FR-INS-033's base")
		})
	}
}

// DR-020's trigger judges a reading against the last one dated before it
// (000021), so a reading already dated today is not FR-INS-033's base: the
// phone divides from yesterday's, as the trigger will once TYRE-244 dates
// the write on the tenant's day. Both are dated from the tenant's own today,
// so no Go clock is what the test measures.
func TestCaptureContextServesTheOdometerBaseFromAnEarlierDay(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "odometer-base")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	read := func(t *testing.T) (base *int64, age *int) {
		t.Helper()
		rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(),
			tenantID.String(), driverID.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body struct {
			OdometerBaseKm      *int64 `json:"odometerBaseKm"`
			OdometerBaseAgeDays *int   `json:"odometerBaseAgeDays"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body.OdometerBaseKm, body.OdometerBaseAgeDays
	}

	plant := func(t *testing.T, daysAgo int, km int64, source string) {
		t.Helper()
		_, err := admin.Exec(ctx,
			`INSERT INTO app.vehicle_odometer_reading
			   (tenant_id, vehicle_id, reading_date, odometer_km, source)
			 SELECT id, $2, app.tenant_today(timezone) - $3::int, $4, $5
			   FROM app.tenant WHERE id = $1`,
			tenantID, vehicleID, daysAgo, km, source)
		require.NoError(t, err)
	}

	// Today's reading alone has nothing before it to be judged against.
	plant(t, 0, 100500, "FUEL_RECORD")
	base, age := read(t)
	require.Nil(t, base, "a reading dated today was served as FR-INS-033's base")
	require.Nil(t, age, "no base, yet an age was served")

	plant(t, 1, 100000, "MANUAL")
	base, age = read(t)
	require.NotNil(t, base, "yesterday's reading did not reach FR-INS-033's base")
	require.Equal(t, int64(100000), *base, "today's reading was served as FR-INS-033's base")
	require.NotNil(t, age)
	require.Equal(t, 1, *age, "the base's age is counted in this fleet's own calendar")
}

// Rule 6 (TYRE-342): the age beside the last odometer reading is a count of
// the fleet's own calendar days, as the tread's is. Kiritimati and Midway sit
// 25 hours apart and never share a civil date, so a count taken on UTC's
// calendar, or the runner's, misses for one of them at any hour.
func TestCaptureContextCountsTheOdometerAgeInTheFleetsDays(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, zone := range []string{"Pacific/Kiritimati", "Pacific/Midway"} {
		t.Run(zone, func(t *testing.T) {
			tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "odometer-age")
			_, err := admin.Exec(ctx, `UPDATE app.tenant SET timezone = $2 WHERE id = $1`, tenantID, zone)
			require.NoError(t, err)
			driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
			plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)

			// Dated in SQL from the tenant's own today, so no Go clock is
			// what the test measures.
			_, err = admin.Exec(ctx,
				`INSERT INTO app.vehicle_odometer_reading
				   (tenant_id, vehicle_id, reading_date, odometer_km, source)
				 SELECT id, $2, app.tenant_today(timezone) - 3, 100000, 'MANUAL'
				   FROM app.tenant WHERE id = $1`,
				tenantID, vehicleID)
			require.NoError(t, err)

			rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(),
				tenantID.String(), driverID.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var body struct {
				LastOdometerAgeDays *int `json:"lastOdometerAgeDays"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			require.NotNil(t, body.LastOdometerAgeDays, "a dated reading served no age")
			require.Equal(t, 3, *body.LastOdometerAgeDays, "the age is counted in this fleet's own calendar")
		})
	}
}

// captureBetween is captureFixture's payload with its own started_at and
// submitted_at, for the capture-window cases (FR-OFF-015 as amended).
func captureBetween(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, vehicleID uuid.UUID,
	started, submitted time.Time) map[string]any {
	t.Helper()
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, vehicleID)), &body))
	body["started_at"] = started.UTC().Format(time.RFC3339)
	body["submitted_at"] = submitted.UTC().Format(time.RFC3339)
	return body
}

// plantTripSpan plants userID's trip on motiveID from startedAgo to endedAgo
// before now, as SQL intervals so the instants are the database's own clock.
func plantTripSpan(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, motiveID, userID uuid.UUID,
	startedAgo, endedAgo string) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
		 VALUES ($1, $2, $3, now() - $4::interval, now() - $5::interval)`,
		tenantID, motiveID, userID, startedAgo, endedAgo)
	require.NoError(t, err)
}

func postCapture(t *testing.T, h http.Handler, tenantID, actor uuid.UUID, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	return post(t, h, "/api/inspections", tenantID.String(), actor.String(), string(raw))
}

func requireNotVisible(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.Equal(t, "TY007", decodeRefusal(t, rec.Body.Bytes()).Code, rec.Body.String())
}

func TestSubmitAcceptsATripClosedDuringTheCapture(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-closed")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTripSpan(t, ctx, admin, tenantID, motiveID, driverID, "2 hours", "30 minutes")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	rec := postCapture(t, h, tenantID, driverID,
		captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-40*time.Minute), now.Add(-10*time.Minute)))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

func TestSubmitRefusesAUnitHeldAtNoInstantOfTheCapture(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-never")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTripSpan(t, ctx, admin, tenantID, motiveID, driverID, "3 hours", "2 hours")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	requireNotVisible(t, postCapture(t, h, tenantID, driverID,
		captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-time.Hour), now)))
}

// The task stays cancelled and closes on nothing: the submit's close skips a
// task that is not open (000060), and the nominee held the unit until the
// cancel, inside the capture.
func TestSubmitAcceptsANomineeWhoseTaskWasCancelled(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-cancelled")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var taskID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
		 VALUES ($1, $2, now() + interval '1 day', now() - interval '2 hours') RETURNING id`,
		tenantID, motiveID).Scan(&taskID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
		 VALUES ($1, $2, $3, now() - interval '1 hour')`, tenantID, taskID, driverID)
	require.NoError(t, err)

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-30*time.Minute), now)
	body["task_id"] = taskID.String()
	_, err = admin.Exec(ctx,
		`UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = 'test' WHERE id = $1`, taskID)
	require.NoError(t, err)

	rec := postCapture(t, h, tenantID, driverID, body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var state string
	var completedBy *uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text, completed_inspection_id FROM app.inspection_task WHERE id = $1`, taskID).
		Scan(&state, &completedBy))
	require.Equal(t, "CANCELLED", state)
	require.Nil(t, completedBy)
}

// U148: a capture is never refused for its length; its last
// inspection_max_duration_hours (12 by default) are judged.
func TestSubmitAcceptsALongCaptureOnItsLastPart(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-long")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	_, err := admin.Exec(ctx,
		`INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
		 VALUES ($1, $2, $3, now() - interval '5 hours')`, tenantID, motiveID, driverID)
	require.NoError(t, err)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	rec := postCapture(t, h, tenantID, driverID,
		captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-14*time.Hour), now))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

func TestSubmitRefusesALongCaptureHeldOnlyEarly(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-early")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTripSpan(t, ctx, admin, tenantID, motiveID, driverID, "14 hours", "13 hours")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	requireNotVisible(t, postCapture(t, h, tenantID, driverID,
		captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-14*time.Hour), now)))
}

func TestSubmitRefusesAPayloadWithNoStartedAt(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-nostart")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-2*time.Minute), now)
	delete(body, "started_at")
	rec := postCapture(t, h, tenantID, driverID, body)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY005", ref.Code)
	require.Equal(t, "the payload carries no started_at", ref.Message)
}

func TestSubmitRefusesAnAbsentSpareOnAnUnheldUnit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-spare")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	unrelatedID, unrelatedPos := plantUnrelatedVehicle(t, ctx, admin, tenantID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-2*time.Minute), now)
	body["absent_spares"] = []map[string]any{
		{"vehicle_id": unrelatedID.String(), "position_id": unrelatedPos.String()},
	}
	requireNotVisible(t, postCapture(t, h, tenantID, driverID, body))
}

func TestSubmitRefusesACombinationNotOfferedToTheUnit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-rig")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	unrelatedID, _ := plantUnrelatedVehicle(t, ctx, admin, tenantID)
	var otherRig uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
		 VALUES ($1, $2, now() - interval '1 hour') RETURNING id`, tenantID, unrelatedID).Scan(&otherRig))
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-2*time.Minute), now)
	body["combination_id"] = otherRig.String()
	requireNotVisible(t, postCapture(t, h, tenantID, driverID, body))
}

// The web sends "combination_id": null on every solo capture (payload.ts),
// and an explicit null is no rig.
func TestSubmitAcceptsASoloCaptureWithANullCombination(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-solo")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-2*time.Minute), now)
	body["combination_id"] = nil
	rec := postCapture(t, h, tenantID, driverID, body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

// FR-OFF-011: a replay writes nothing, so it is answered as one whoever holds
// the unit now. The unit is one the driver never held, so the answer comes
// from the replay step alone.
func TestSubmitReplayIsAnsweredAfterTheTripEnds(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-replay")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	body := captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-3*time.Hour), now.Add(-170*time.Minute))
	var stored uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at)
		 VALUES ($1, $2, $3, $4, now() - interval '3 hours', now() - interval '170 minutes') RETURNING id`,
		tenantID, motiveID, driverID, body["client_uuid"]).Scan(&stored))

	rec := postCapture(t, h, tenantID, driverID, body)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var got struct {
		InspectionID string `json:"inspectionId"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
	require.Equal(t, stored.String(), got.InspectionID)
}

// ScopeTenant stays exempt from the own-units check, in Go (spec, Capture).
func TestSubmitByAControllerNeedsNoTrip(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "window-controller")
	controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	now := time.Now()
	rec := postCapture(t, h, tenantID, controllerID,
		captureBetween(t, ctx, admin, tenantID, motiveID, now.Add(-2*time.Minute), now))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
}

// A draft resumed after its trip ended reads its unit through the submit's
// own window ending now, so it is never stranded (U148; spec, Capture). With
// no startedAt the read stays at now, as /api/my/vehicles does.
func TestCaptureContextAdmitsAResumedDraftsWindow(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantCaptureFixture(t, ctx, admin, "resume")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantTripSpan(t, ctx, admin, tenantID, horseID, driverID, "2 hours", "10 minutes")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	read := func(unit, actor uuid.UUID, startedAgo *time.Duration) int {
		t.Helper()
		path := "/api/capture/vehicles/" + unit.String()
		if startedAgo != nil {
			path += "?startedAt=" + url.QueryEscape(time.Now().Add(-*startedAgo).UTC().Format(time.RFC3339))
		}
		return get(t, h, path, tenantID.String(), actor.String()).Code
	}
	twenty, five := 20*time.Minute, 5*time.Minute

	require.Equal(t, http.StatusOK, read(horseID, driverID, &twenty), "the draft began while the driver held the horse")
	require.Equal(t, http.StatusOK, read(trailerID, driverID, &twenty), "and the trailer its rig tows")
	require.Equal(t, http.StatusForbidden, read(horseID, driverID, nil), "at now the trip has ended")
	require.Equal(t, http.StatusForbidden, read(horseID, driverID, &five), "a draft begun after the end")
	rec := get(t, h, "/api/capture/vehicles/"+horseID.String()+"?startedAt=yesterday", tenantID.String(), driverID.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "startedAt")

	// A nominee whose nomination a trip took over ten minutes ago.
	nominee := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	other := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	unrelated, _ := plantUnrelatedVehicle(t, ctx, admin, tenantID)
	var taskID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
		 VALUES ($1, $2, now() + interval '1 day', now() - interval '2 hours') RETURNING id`,
		tenantID, unrelated).Scan(&taskID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
		 VALUES ($1, $2, $3, now() - interval '1 hour')`, tenantID, taskID, nominee)
	require.NoError(t, err)
	_, err = admin.Exec(ctx,
		`INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
		 VALUES ($1, $2, $3, now() - interval '10 minutes')`, tenantID, unrelated, other)
	require.NoError(t, err)
	require.Equal(t, http.StatusOK, read(unrelated, nominee, &twenty))
	require.Equal(t, http.StatusForbidden, read(unrelated, nominee, nil))

	require.Equal(t, http.StatusOK, read(horseID, controllerID, nil), "a tenant-wide role reads the register")
	require.Equal(t, http.StatusOK, read(horseID, controllerID, &twenty))
}

// tenantInstant is the instant at clock on the tenant's own day daysAgo
// before its today, computed in SQL so no Go clock picks the day.
func tenantInstant(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, daysAgo int, clock string) time.Time {
	t.Helper()
	var at time.Time
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT ((app.tenant_today(timezone) - $2::int) + $3::time) AT TIME ZONE timezone
		   FROM app.tenant WHERE id = $1`,
		tenantID, daysAgo, clock,
	).Scan(&at))
	return at
}

// tenantDate is the tenant's day daysAgo before its today, as YYYY-MM-DD.
func tenantDate(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, daysAgo int) string {
	t.Helper()
	var day string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT (app.tenant_today(timezone) - $2::int)::text FROM app.tenant WHERE id = $1`,
		tenantID, daysAgo,
	).Scan(&day))
	return day
}

func contextPath(vehicleID uuid.UUID, startedAt *time.Time) string {
	path := "/api/capture/vehicles/" + vehicleID.String()
	if startedAt != nil {
		path += "?startedAt=" + url.QueryEscape(startedAt.UTC().Format(time.RFC3339))
	}
	return path
}

// U187: a resumed draft's read counts the odometer figures to the tenant day
// of its startedAt, from the readings dated on or before that day (U183).
// Each dated start is a clock time whose UTC date is not the tenant's, so a
// count to UTC's day misses. A start after now is counted to today, as no
// start is.
func TestCaptureContextCountsADraftsOdometerToItsStartDay(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	type odometer struct {
		LastOdometerKm      *int64     `json:"lastOdometerKm"`
		LastOdometerAt      *time.Time `json:"lastOdometerAt"`
		LastOdometerAgeDays *int       `json:"lastOdometerAgeDays"`
		OdometerBaseKm      *int64     `json:"odometerBaseKm"`
		OdometerBaseAgeDays *int       `json:"odometerBaseAgeDays"`
		AverageDailyKm      *float64   `json:"averageDailyKm"`
	}
	type want struct {
		lastKm, baseKm   int64
		lastAgo, lastAge int
		baseAge          int
		avg              float64
	}
	today := &want{lastKm: 103000, lastAgo: 0, lastAge: 0, baseKm: 102500, baseAge: 1, avg: 375}

	for _, zone := range []struct{ name, clock string }{
		{"Pacific/Kiritimati", "06:00"},
		{"Pacific/Midway", "20:00"},
	} {
		t.Run(zone.name, func(t *testing.T) {
			tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "draft-odometer")
			_, err := admin.Exec(ctx, `UPDATE app.tenant SET timezone = $2 WHERE id = $1`, tenantID, zone.name)
			require.NoError(t, err)
			driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
			plantTrip(t, ctx, admin, tenantID, vehicleID, driverID)
			controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)

			for _, r := range []struct {
				daysAgo int
				km      int64
			}{{8, 100000}, {5, 101200}, {3, 101500}, {1, 102500}, {0, 103000}} {
				_, err := admin.Exec(ctx,
					`INSERT INTO app.vehicle_odometer_reading
					   (tenant_id, vehicle_id, reading_date, odometer_km, source)
					 SELECT id, $2, app.tenant_today(timezone) - $3::int, $4, 'MANUAL'
					   FROM app.tenant WHERE id = $1`,
					tenantID, vehicleID, r.daysAgo, r.km)
				require.NoError(t, err)
			}

			startedOn := func(daysAgo int) *time.Time {
				at := tenantInstant(t, ctx, admin, tenantID, daysAgo, zone.clock)
				return &at
			}
			later := time.Now().Add(72 * time.Hour)
			for _, row := range []struct {
				name      string
				startedAt *time.Time
				want      *want
			}{
				{"no start", nil, today},
				{"started 3 days back", startedOn(3),
					&want{lastKm: 101500, lastAgo: 3, lastAge: 0, baseKm: 101200, baseAge: 2, avg: 300}},
				{"started 4 days back", startedOn(4),
					&want{lastKm: 101200, lastAgo: 5, lastAge: 1, baseKm: 101200, baseAge: 1, avg: 400}},
				{"started before every reading", startedOn(10), nil},
				{"started after now", &later, today},
			} {
				for _, actor := range []struct {
					name string
					id   uuid.UUID
				}{{"driver", driverID}, {"controller", controllerID}} {
					t.Run(row.name+"/"+actor.name, func(t *testing.T) {
						rec := get(t, h, contextPath(vehicleID, row.startedAt), tenantID.String(), actor.id.String())
						require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
						var got odometer
						require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
						if row.want == nil {
							require.Nil(t, got.LastOdometerKm, "a reading dated after the start day was served")
							require.Nil(t, got.LastOdometerAt)
							require.Nil(t, got.LastOdometerAgeDays)
							require.Nil(t, got.OdometerBaseKm)
							require.Nil(t, got.OdometerBaseAgeDays)
							require.Nil(t, got.AverageDailyKm, "a rate was served from readings after the start day")
							return
						}
						w := row.want
						require.NotNil(t, got.LastOdometerKm)
						require.Equal(t, w.lastKm, *got.LastOdometerKm, "the last reading on or before the start day")
						require.NotNil(t, got.LastOdometerAt)
						require.Equal(t, tenantDate(t, ctx, admin, tenantID, w.lastAgo),
							got.LastOdometerAt.UTC().Format("2006-01-02"))
						require.NotNil(t, got.LastOdometerAgeDays)
						require.Equal(t, w.lastAge, *got.LastOdometerAgeDays, "counted to the start day")
						require.NotNil(t, got.OdometerBaseKm)
						require.Equal(t, w.baseKm, *got.OdometerBaseKm, "the base is the last reading before the start day")
						require.NotNil(t, got.OdometerBaseAgeDays)
						require.Equal(t, w.baseAge, *got.OdometerBaseAgeDays, "counted to the start day")
						require.NotNil(t, got.AverageDailyKm)
						require.InDelta(t, w.avg, *got.AverageDailyKm, 0.005, "the rate ends at the start day")
					})
				}
			}

			// A reading dated the tenant's tomorrow, as submit_inspection's UTC
			// dating writes west of UTC until TYRE-244, stays the last one on
			// a read with no start, since FR-INS-032 refuses below it.
			_, err = admin.Exec(ctx,
				`INSERT INTO app.vehicle_odometer_reading
				   (tenant_id, vehicle_id, reading_date, odometer_km, source)
				 SELECT id, $2, app.tenant_today(timezone) + 1, 103400, 'MANUAL'
				   FROM app.tenant WHERE id = $1`,
				tenantID, vehicleID)
			require.NoError(t, err)
			for _, row := range []struct {
				startedAt *time.Time
				lastKm    int64
			}{{nil, 103400}, {startedOn(3), 101500}} {
				rec := get(t, h, contextPath(vehicleID, row.startedAt), tenantID.String(), driverID.String())
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				var got odometer
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &got))
				require.NotNil(t, got.LastOdometerKm)
				require.Equal(t, row.lastKm, *got.LastOdometerKm, "started %v", row.startedAt)
			}
		})
	}
}

// U187: a resumed draft's read takes each position's previous reading from
// the non-voided sheets submitted by its startedAt, or by now if startedAt is
// later, and counts its age to that instant's tenant day. The bound is the
// instant, not its day, so a sheet submitted later that day is not the
// previous one.
func TestCaptureContextServesADraftTheTreadHistoryItStartedOn(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	type position struct {
		Code                   string     `json:"code"`
		PreviousGoverningMm    *float64   `json:"previousGoverningMm"`
		PreviousReadingAt      *time.Time `json:"previousReadingAt"`
		PreviousReadingAgeDays *int       `json:"previousReadingAgeDays"`
	}

	// Each clock time below falls on a UTC date that is not the tenant's
	// (Kiritimati before 14:00, Midway from 14:00), so a count on UTC's
	// calendar misses. On the start day the early start, the later sheet and
	// the later start come in that order.
	for _, zone := range []struct{ name, sheet, early, late, later string }{
		{"Pacific/Kiritimati", "05:00", "02:00", "06:00", "09:00"},
		{"Pacific/Midway", "15:00", "14:00", "16:00", "20:00"},
	} {
		t.Run(zone.name, func(t *testing.T) {
			tenantID, motiveID, _ := plantCaptureFixture(t, ctx, admin, "draft-tread")
			_, err := admin.Exec(ctx, `UPDATE app.tenant SET timezone = $2 WHERE id = $1`, tenantID, zone.name)
			require.NoError(t, err)
			driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
			plantTrip(t, ctx, admin, tenantID, motiveID, driverID)
			controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)

			// Submitted by the controller, whom no trip window binds, on
			// 1L, the fixture's fitted position.
			sixBack := tenantInstant(t, ctx, admin, tenantID, 6, zone.sheet)
			threeBackLate := tenantInstant(t, ctx, admin, tenantID, 3, zone.late)
			oneBack := tenantInstant(t, ctx, admin, tenantID, 1, zone.sheet)
			for _, sheet := range []struct {
				at     time.Time
				treads []float64
			}{
				{sixBack, []float64{8.4, 8.6, 8.5}},
				{threeBackLate, []float64{8.2, 8.4, 8.3}},
				{oneBack, []float64{8.0, 8.5, 8.2}},
			} {
				body := captureBetween(t, ctx, admin, tenantID, motiveID, sheet.at.Add(-2*time.Minute), sheet.at)
				delete(body, "odometer_km")
				body["readings"].([]any)[0].(map[string]any)["treads"] = sheet.treads
				rec := postCapture(t, h, tenantID, controllerID, body)
				require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
			}

			threeBackEarly := tenantInstant(t, ctx, admin, tenantID, 3, zone.early)
			threeBackLater := tenantInstant(t, ctx, admin, tenantID, 3, zone.later)
			longBack := tenantInstant(t, ctx, admin, tenantID, 100, zone.early)
			later := time.Now().Add(72 * time.Hour)
			type want struct {
				mm  float64
				at  time.Time
				age int
			}
			today := &want{8.0, oneBack, 1}
			for _, row := range []struct {
				name      string
				startedAt *time.Time
				want      *want
			}{
				{"no start", nil, today},
				{"started before that day's later sheet", &threeBackEarly, &want{8.4, sixBack, 3}},
				{"started after that day's later sheet", &threeBackLater, &want{8.2, threeBackLate, 0}},
				{"started before every sheet", &longBack, nil},
				{"started after now", &later, today},
			} {
				for _, actor := range []struct {
					name string
					id   uuid.UUID
				}{{"driver", driverID}, {"controller", controllerID}} {
					t.Run(row.name+"/"+actor.name, func(t *testing.T) {
						rec := get(t, h, contextPath(motiveID, row.startedAt), tenantID.String(), actor.id.String())
						require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
						var body struct {
							Positions []position `json:"positions"`
						}
						require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
						var got *position
						for i := range body.Positions {
							if body.Positions[i].Code == "1L" {
								got = &body.Positions[i]
							}
						}
						require.NotNil(t, got, "the fixture's 1L was not served")
						if row.want == nil {
							require.Nil(t, got.PreviousGoverningMm, "a sheet submitted after the start was served")
							require.Nil(t, got.PreviousReadingAt)
							require.Nil(t, got.PreviousReadingAgeDays)
							return
						}
						require.NotNil(t, got.PreviousGoverningMm)
						require.InDelta(t, row.want.mm, *got.PreviousGoverningMm, 0.0001,
							"the previous sheet as at the start")
						require.NotNil(t, got.PreviousReadingAt)
						require.True(t, row.want.at.Equal(*got.PreviousReadingAt),
							"want %s, got %s", row.want.at, *got.PreviousReadingAt)
						require.NotNil(t, got.PreviousReadingAgeDays)
						require.Equal(t, row.want.age, *got.PreviousReadingAgeDays, "counted to the start day")
					})
				}
			}

			// A sheet submitted_at inside TYRE-166's skew after now is the
			// previous one on a read with no start, as the latest sheet.
			ahead := time.Now().Add(2 * time.Minute)
			body := captureBetween(t, ctx, admin, tenantID, motiveID, ahead.Add(-2*time.Minute), ahead)
			delete(body, "odometer_km")
			body["readings"].([]any)[0].(map[string]any)["treads"] = []float64{7.9, 8.1, 8.0}
			rec := postCapture(t, h, tenantID, controllerID, body)
			require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
			rec = get(t, h, contextPath(motiveID, nil), tenantID.String(), driverID.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var after struct {
				Positions []position `json:"positions"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &after))
			served := false
			for _, p := range after.Positions {
				if p.Code == "1L" {
					served = true
					require.NotNil(t, p.PreviousGoverningMm)
					require.InDelta(t, 7.9, *p.PreviousGoverningMm, 0.0001, "the sheet ahead of now was not served")
				}
			}
			require.True(t, served, "the fixture's 1L was not served")
		})
	}
}

// U186: a resumed draft's read serves the rig open at its startedAt, or at
// now if startedAt is later, as the record dates the rig, so a rig ended or
// replaced after that instant is the one served. A read with no startedAt
// serves the rig with no end. A driver who held a trailer only through a rig
// that ended before the start is refused the trailer's own read (FR-AUT-005).
func TestCaptureContextServesADraftTheRigOpenAtItsStart(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tenantID, horseID, trailerID := plantCaptureFixture(t, ctx, admin, "draft-rig")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, horseID, driverID)
	controllerID := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	// The fixture's rig, open from an hour ago, ends on a whole second, so a
	// start can be sent at exactly that instant. Its replacement swaps the
	// trailer and opens as it ends.
	var first, second, swapID uuid.UUID
	var ended time.Time
	require.NoError(t, admin.QueryRow(ctx,
		`UPDATE app.combination SET effective_to = date_trunc('second', now()) - interval '20 minutes'
		  WHERE motive_vehicle_id = $1 RETURNING id, effective_to`, horseID).Scan(&first, &ended))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 SELECT tenant_id, fleet_number || '-SWAP', configuration_id, unit_kind
		   FROM app.vehicle WHERE id = $1 RETURNING id`, trailerID).Scan(&swapID))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
		 VALUES ($1, $2, $3) RETURNING id`, tenantID, horseID, ended).Scan(&second))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence, descriptor)
		 VALUES ($1, $2, $3, 1, 'Horse'), ($1, $2, $4, 2, 'Swap')`,
		tenantID, second, horseID, swapID)
	require.NoError(t, err)

	type rig struct {
		ID      uuid.UUID `json:"id"`
		Members []struct {
			VehicleID uuid.UUID `json:"vehicleId"`
			Sequence  int       `json:"sequence"`
		} `json:"members"`
	}
	fromEnd := func(d time.Duration) *time.Time {
		at := ended.Add(d)
		return &at
	}
	later := time.Now().Add(72 * time.Hour)
	firstRig := []uuid.UUID{horseID, trailerID}
	secondRig := []uuid.UUID{horseID, swapID}
	for _, row := range []struct {
		name      string
		startedAt *time.Time
		want      *uuid.UUID
		members   []uuid.UUID
	}{
		{"no start", nil, &second, secondRig},
		{"started while the first rig was open", fromEnd(-20 * time.Minute), &first, firstRig},
		{"started a second before it ended", fromEnd(-time.Second), &first, firstRig},
		{"started the instant it ended", fromEnd(0), &second, secondRig},
		{"started after it ended", fromEnd(10 * time.Minute), &second, secondRig},
		{"started before any rig", fromEnd(-50 * time.Minute), nil, nil},
		{"started after now", &later, &second, secondRig},
	} {
		for _, actor := range []struct {
			name string
			id   uuid.UUID
		}{{"driver", driverID}, {"controller", controllerID}} {
			t.Run(row.name+"/"+actor.name, func(t *testing.T) {
				rec := get(t, h, contextPath(horseID, row.startedAt), tenantID.String(), actor.id.String())
				require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
				var body struct {
					Combination *rig `json:"combination"`
				}
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
				if row.want == nil {
					require.Nil(t, body.Combination, "a rig opened after the start was served")
					return
				}
				require.NotNil(t, body.Combination, "no rig was served")
				require.Equal(t, *row.want, body.Combination.ID, "the rig open at the start")
				var got []uuid.UUID
				for i, m := range body.Combination.Members {
					require.Equal(t, i+1, m.Sequence, "members in sequence")
					got = append(got, m.VehicleID)
				}
				require.Equal(t, row.members, got)
			})
		}
	}

	for _, row := range []struct {
		name      string
		actor     uuid.UUID
		startedAt *time.Time
		want      int
	}{
		{"driver, started while the first rig was open", driverID, fromEnd(-20 * time.Minute), http.StatusOK},
		{"driver, started after it ended", driverID, fromEnd(10 * time.Minute), http.StatusForbidden},
		{"controller, started after it ended", controllerID, fromEnd(10 * time.Minute), http.StatusOK},
	} {
		rec := get(t, h, contextPath(trailerID, row.startedAt), tenantID.String(), row.actor.String())
		require.Equal(t, row.want, rec.Code, row.name+": "+rec.Body.String())
	}
}
