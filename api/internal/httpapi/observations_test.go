// TYRE-75's surface, at the wire: the reports a controller can see, the two
// answers they can give, and FR-AUT-008's narrowing on all three (TYRE-226's
// rule applied to a route built after the decision, so it is narrowed from the
// first commit rather than added later).
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

// observationRow mirrors the handler's own response shape. The package under
// test does not export it, and a test that re-states the wire contract is what
// makes a silent rename of a JSON tag a failure rather than a green run.
type observationRow struct {
	ID           string `json:"id"`
	InspectionID string `json:"inspectionId"`
	StartedAt    string `json:"startedAt"`
	SubmittedAt  string `json:"submittedAt"`
	Driver       struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"driver"`
	Rig struct {
		ID                string   `json:"id"`
		MotiveFleetNumber string   `json:"motiveFleetNumber"`
		Members           []string `json:"members"`
	} `json:"rig"`
	Observed []string `json:"observed"`
	Removed  []string `json:"removed"`
	Stale    bool     `json:"stale"`
}

type applyResult struct {
	ResultingRigID *string `json:"resultingRigId"`
}

// plantMotive plants an axle configuration and the HORSE that heads one rig.
// Its own configuration per call: app.axle_configuration carries
// UNIQUE (tenant_id, code, version), so two rigs in one tenant collide on a
// shared code (plantDepotWithVehicle's reasoning).
func plantMotive(t *testing.T, ctx context.Context, admin *pgx.Conn,
	tenantID uuid.UUID,
) (motiveID uuid.UUID, fleet string, configID uuid.UUID) {
	t.Helper()
	suffix := uuid.NewString()[:8]
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, $2, 'observation test rig', 2) RETURNING id`,
		tenantID, "OBSTEST-"+suffix).Scan(&configID))
	fleet = "OBS-H-" + suffix
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, $2, $3, 'HORSE'::app.unit_kind) RETURNING id`,
		tenantID, fleet, configID).Scan(&motiveID))
	return motiveID, fleet, configID
}

func plantTrailer(t *testing.T, ctx context.Context, admin *pgx.Conn,
	tenantID, configID uuid.UUID,
) (trailerID uuid.UUID, fleet string) {
	t.Helper()
	fleet = "OBS-T-" + uuid.NewString()[:8]
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, $2, $3, 'TRAILER'::app.unit_kind) RETURNING id`,
		tenantID, fleet, configID).Scan(&trailerID))
	return trailerID, fleet
}

// plantReport plants a rig, a submitted inspection on its motive and the
// FR-INS-063 warning the submit would have raised, and answers with the ids of
// all three. The warning is planted rather than produced by
// app.submit_inspection: the submit's half is suite section 58b's and
// section 31's, and planting is what lets a Go test choose the observed set,
// the instant and the depot the report hangs off.
//
// Every call needs units of its own. 000037 holds a unit in at most one open
// rig, and an applied report leaves the motive in a fresh one, so a second rig
// built on the same horse is refused TY017 before any assertion runs.
func plantReport(t *testing.T, ctx context.Context, admin *pgx.Conn,
	tenantID, motiveID, driverID uuid.UUID, observed []uuid.UUID, trailers ...uuid.UUID,
) (warningID, rigID, inspectionID uuid.UUID) {
	t.Helper()
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
		 VALUES ($1, $2, now() - interval '2 hours') RETURNING id`,
		tenantID, motiveID).Scan(&rigID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
		 VALUES ($1, $2, $3, 1)`,
		tenantID, rigID, motiveID)
	require.NoError(t, err)
	for i, trailer := range trailers {
		_, err := admin.Exec(ctx,
			`INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
			 VALUES ($1, $2, $3, $4)`,
			tenantID, rigID, trailer, i+2)
		require.NoError(t, err)
	}

	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection
		   (tenant_id, vehicle_id, combination_id, user_id, client_uuid,
		    started_at, submitted_at, state)
		 VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - interval '55 minutes', 'SYNCED')
		 RETURNING id`,
		tenantID, motiveID, rigID, driverID, uuid.New()).Scan(&inspectionID))

	ids := make([]string, 0, len(observed))
	for _, id := range observed {
		ids = append(ids, id.String())
	}
	raw, err := json.Marshal(ids)
	require.NoError(t, err)
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection_warning
		   (tenant_id, inspection_id, warning_code, entered_value, source)
		 VALUES ($1, $2, 'FR-INS-063', $3, 'SERVER') RETURNING id`,
		tenantID, inspectionID, string(raw)).Scan(&warningID))
	return warningID, rigID, inspectionID
}

func listReports(t *testing.T, h http.Handler, tenant, user string) []observationRow {
	t.Helper()
	rec := get(t, h, "/api/combinations/observations", tenant, user)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out []observationRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

func displayNameOf(t *testing.T, ctx context.Context, admin *pgx.Conn, userID uuid.UUID) string {
	t.Helper()
	var name string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT display_name FROM app.app_user WHERE id = $1`, userID).Scan(&name))
	return name
}

func rigIsOpen(t *testing.T, ctx context.Context, admin *pgx.Conn, rigID uuid.UUID) bool {
	t.Helper()
	var open bool
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT effective_to IS NULL FROM app.combination WHERE id = $1`, rigID).Scan(&open))
	return open
}

// The list projects what the card renders: who reported, against which rig,
// what they saw, and what is therefore missing.
func TestObservationListProjectsTheReport(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "obs-list")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	motive, motiveFleet, configID := plantMotive(t, ctx, admin, tenantID)
	trailer1, trailer1Fleet := plantTrailer(t, ctx, admin, tenantID, configID)
	trailer2, trailer2Fleet := plantTrailer(t, ctx, admin, tenantID, configID)

	warning, rig, inspection := plantReport(t, ctx, admin, tenantID, motive, driver,
		[]uuid.UUID{motive, trailer1}, trailer1, trailer2)

	tn, ctl := tenantID.String(), controller.String()
	got := listReports(t, h, tn, ctl)
	require.Len(t, got, 1)
	require.Equal(t, warning.String(), got[0].ID)
	require.Equal(t, inspection.String(), got[0].InspectionID)
	_, err := time.Parse(time.RFC3339, got[0].StartedAt)
	require.NoError(t, err)
	_, err = time.Parse(time.RFC3339, got[0].SubmittedAt)
	require.NoError(t, err)
	require.Equal(t, driver.String(), got[0].Driver.ID)
	require.Equal(t, displayNameOf(t, ctx, admin, driver), got[0].Driver.DisplayName)
	require.Equal(t, rig.String(), got[0].Rig.ID)
	require.Equal(t, motiveFleet, got[0].Rig.MotiveFleetNumber)
	require.Equal(t, []string{motiveFleet, trailer1Fleet, trailer2Fleet}, got[0].Rig.Members)
	require.ElementsMatch(t, []string{motiveFleet, trailer1Fleet}, got[0].Observed)
	// The sentence the card carries: what the offered rig held and the driver
	// did not see. A projection that answered the observed set instead would
	// tell the controller to uncouple the units still on the vehicle.
	require.Equal(t, []string{trailer2Fleet}, got[0].Removed)
	require.False(t, got[0].Stale)

	// A stale report is still listed: dismissing it is exactly what it is for.
	_, err = admin.Exec(ctx, `UPDATE app.combination SET effective_to = now() WHERE id = $1`, rig)
	require.NoError(t, err)
	got = listReports(t, h, tn, ctl)
	require.Len(t, got, 1)
	require.True(t, got[0].Stale)

	// A resolved report leaves the list. Inserted rather than applied: the
	// admin connection binds no tenant, so the resolution functions cannot run
	// on it, and the list's predicate is what is under test either way.
	_, err = admin.Exec(ctx,
		`INSERT INTO app.composition_observation
		   (tenant_id, warning_id, combination_id, action, note, created_by)
		 VALUES ($1, $2, $3, 'DISMISSED', 'settled by hand', $4)`,
		tenantID, warning, rig, controller)
	require.NoError(t, err)
	require.Empty(t, listReports(t, h, tn, ctl))

	// A voided capture is not evidence of a coupling (FR-INS-012), and its
	// report can never be resolved, so it must not sit in the list forever.
	voidMotive, _, voidConfig := plantMotive(t, ctx, admin, tenantID)
	voidTrailer, _ := plantTrailer(t, ctx, admin, tenantID, voidConfig)
	_, _, voidInspection := plantReport(t, ctx, admin, tenantID, voidMotive, driver,
		[]uuid.UUID{voidMotive}, voidTrailer)
	require.Len(t, listReports(t, h, tn, ctl), 1)
	_, err = admin.Exec(ctx,
		`UPDATE app.inspection SET state = 'VOIDED', void_reason = 'captured on the wrong unit' WHERE id = $1`,
		voidInspection)
	require.NoError(t, err)
	require.Empty(t, listReports(t, h, tn, ctl))
}

// The two answers, and the code and message each refusal carries. Asserting
// the code alone would pass with the message replaced by the canned one, and
// the message is what the controller acts on (ADR-0012, R4's standard).
func TestObservationApplyAndDismiss(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "obs-write")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	motive, _, configID := plantMotive(t, ctx, admin, tenantID)
	trailer1, _ := plantTrailer(t, ctx, admin, tenantID, configID)
	trailer2, _ := plantTrailer(t, ctx, admin, tenantID, configID)
	warning, rig, _ := plantReport(t, ctx, admin, tenantID, motive, driver,
		[]uuid.UUID{motive, trailer1}, trailer1, trailer2)

	tn, ctl := tenantID.String(), controller.String()
	applyPath := func(id uuid.UUID) string {
		return "/api/combinations/observations/" + id.String() + "/apply"
	}
	dismissPath := func(id uuid.UUID) string {
		return "/api/combinations/observations/" + id.String() + "/dismiss"
	}

	applied := post(t, h, applyPath(warning), tn, ctl, `{"note":"seen in the yard"}`)
	require.Equal(t, http.StatusOK, applied.Code, applied.Body.String())
	var result applyResult
	require.NoError(t, json.Unmarshal(applied.Body.Bytes(), &result))
	require.NotNil(t, result.ResultingRigID)
	require.False(t, rigIsOpen(t, ctx, admin, rig), "the offered rig ends at the observed instant")

	again := post(t, h, applyPath(warning), tn, ctl, `{"note":"again"}`)
	require.Equal(t, http.StatusUnprocessableEntity, again.Code, again.Body.String())
	ref := decodeRefusal(t, again.Body.Bytes())
	require.Equal(t, "TY022", ref.Code)
	require.Contains(t, ref.Message, "already applied")

	// The other answer, on a report of its own.
	dMotive, _, dConfig := plantMotive(t, ctx, admin, tenantID)
	dTrailer, _ := plantTrailer(t, ctx, admin, tenantID, dConfig)
	dWarning, dRig, _ := plantReport(t, ctx, admin, tenantID, dMotive, driver,
		[]uuid.UUID{dMotive}, dTrailer)

	blank := post(t, h, dismissPath(dWarning), tn, ctl, `{"note":"  "}`)
	require.Equal(t, http.StatusUnprocessableEntity, blank.Code, blank.Body.String())
	ref = decodeRefusal(t, blank.Body.Bytes())
	require.Equal(t, "TY022", ref.Code)
	require.Contains(t, ref.Message, "a dismissal carries a reason")

	dismissed := post(t, h, dismissPath(dWarning), tn, ctl, `{"note":"the link was there"}`)
	require.Equal(t, http.StatusNoContent, dismissed.Code, dismissed.Body.String())
	require.True(t, rigIsOpen(t, ctx, admin, dRig), "a dismissal touches no rig")

	// A well-formed uuid of the wrong kind: the function refuses it in its own
	// words, which is what makes TY012 reachable on the wire for a ScopeTenant
	// actor who skips the handler's depot narrowing.
	wrongKind := post(t, h, applyPath(dRig), tn, ctl, `{"note":"x"}`)
	require.Equal(t, http.StatusUnprocessableEntity, wrongKind.Code, wrongKind.Body.String())
	ref = decodeRefusal(t, wrongKind.Body.Bytes())
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such observation in this fleet", ref.Message)

	// FR-AUT-005/ADR-0011: the capability, not the role name. A DRIVER holds
	// neither ViewFleet nor ManageAssignments; a TECHNICIAN holds the first
	// alone, so the read answers and both writes do not.
	drv := driver.String()
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/combinations/observations", tn, drv).Code)
	require.Equal(t, http.StatusForbidden, post(t, h, applyPath(dWarning), tn, drv, `{"note":"x"}`).Code)
	require.Equal(t, http.StatusForbidden, post(t, h, dismissPath(dWarning), tn, drv, `{"note":"x"}`).Code)

	tech := technician.String()
	require.Equal(t, http.StatusOK, get(t, h, "/api/combinations/observations", tn, tech).Code)
	require.Equal(t, http.StatusForbidden, post(t, h, applyPath(dWarning), tn, tech, `{"note":"x"}`).Code)
	require.Equal(t, http.StatusForbidden, post(t, h, dismissPath(dWarning), tn, tech, `{"note":"x"}`).Code)
}

// FR-AUT-008: a rig is homed where its horse is, so a report on a motive
// outside the actor's depots is not theirs to see or act on. The controller
// reading and writing the same report is the control — without it, a handler
// that refused everyone would pass.
func TestObservationSurfaceIsDepotScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "obs-depot")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	mineDepot, mineFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, mineDepot)
	_, elsewhereFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)

	horse := func(fleet string) (uuid.UUID, uuid.UUID) {
		var id, configID uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT id, configuration_id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`,
			tenantID, fleet).Scan(&id, &configID))
		return id, configID
	}
	mine, mineConfig := horse(mineFleet)
	elsewhere, elsewhereConfig := horse(elsewhereFleet)
	mineTrailer, _ := plantTrailer(t, ctx, admin, tenantID, mineConfig)
	elsewhereTrailer, _ := plantTrailer(t, ctx, admin, tenantID, elsewhereConfig)

	// A report on each horse, so an empty list is the narrowing and not an
	// empty fixture. The observed set is the motive alone, which is the one
	// resolution that opens no rig (U10) — the controller's apply below is
	// therefore also the null-result path's only proof.
	mineWarning, _, _ := plantReport(t, ctx, admin, tenantID, mine, driver,
		[]uuid.UUID{mine}, mineTrailer)
	elsewhereWarning, elsewhereRig, _ := plantReport(t, ctx, admin, tenantID, elsewhere, driver,
		[]uuid.UUID{elsewhere}, elsewhereTrailer)

	tn, mgr, ctl := tenantID.String(), manager.String(), controller.String()
	applyPath := func(id uuid.UUID) string {
		return "/api/combinations/observations/" + id.String() + "/apply"
	}
	dismissPath := func(id uuid.UUID) string {
		return "/api/combinations/observations/" + id.String() + "/dismiss"
	}

	mineOnly := listReports(t, h, tn, mgr)
	require.Len(t, mineOnly, 1)
	require.Equal(t, mineFleet, mineOnly[0].Rig.MotiveFleetNumber)
	require.Len(t, listReports(t, h, tn, ctl), 2, "a controller reads the whole tenant (FR-AUT-007)")

	refusedApply := post(t, h, applyPath(elsewhereWarning), tn, mgr, `{"note":"x"}`)
	require.Equal(t, http.StatusNotFound, refusedApply.Code, refusedApply.Body.String())
	require.Equal(t, "not_found", decodeRefusal(t, refusedApply.Body.Bytes()).Code)
	refusedDismiss := post(t, h, dismissPath(elsewhereWarning), tn, mgr, `{"note":"x"}`)
	require.Equal(t, http.StatusNotFound, refusedDismiss.Code, refusedDismiss.Body.String())
	require.Equal(t, "not_found", decodeRefusal(t, refusedDismiss.Body.Bytes()).Code)
	require.True(t, rigIsOpen(t, ctx, admin, elsewhereRig), "a refused write writes nothing")

	own := post(t, h, applyPath(mineWarning), tn, mgr, `{"note":"walked the yard"}`)
	require.Equal(t, http.StatusOK, own.Code, own.Body.String())
	reach := post(t, h, applyPath(elsewhereWarning), tn, ctl, `{"note":"walked the yard"}`)
	require.Equal(t, http.StatusOK, reach.Code, reach.Body.String())
	var result applyResult
	require.NoError(t, json.Unmarshal(reach.Body.Bytes(), &result))
	require.Nil(t, result.ResultingRigID, "the motive alone ends the rig and opens none (U10)")
	require.False(t, rigIsOpen(t, ctx, admin, elsewhereRig))
}
