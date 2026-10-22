package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// unitTaskRow is the controller's row as a test reads it.
type unitTaskRow struct {
	ID                     string  `json:"id"`
	VehicleID              string  `json:"vehicleId"`
	FleetNumber            string  `json:"fleetNumber"`
	DueAt                  string  `json:"dueAt"`
	State                  string  `json:"state"`
	Overdue                bool    `json:"overdue"`
	ResponsibleUserID      *string `json:"responsibleUserId"`
	ResponsibleDisplayName *string `json:"responsibleDisplayName"`
	ResponsibleVia         *string `json:"responsibleVia"`
	Escalated              bool    `json:"escalated"`
}

func unitTasks(t *testing.T, h http.Handler, tenantID, actor, unitID uuid.UUID) []unitTaskRow {
	t.Helper()
	rec := get(t, h, "/api/vehicles/"+unitID.String()+"/inspection-tasks", tenantID.String(), actor.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var rows []unitTaskRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
	return rows
}

func plantOpenTask(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, unitID uuid.UUID, dueAt string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
		 VALUES ($1, $2, $3::timestamptz, now() - interval '2 hours') RETURNING id`,
		tenantID, unitID, dueAt).Scan(&id))
	return id
}

// The unit's task list names who holds each task from app.task_driver_at,
// and says escalated for one nobody holds (FR-INS-053 as amended). Fixed
// literals for the dates (lessons 2026-09-03); rows are planted directly,
// since the read is what is under test; the overdue row is due last year.
func TestUnitTasksNameTheResponsibleDriver(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "unit-tasks")
	idle := plantRigUnit(t, ctx, admin, tenantID, "HORSE")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	nominee := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	trip := plantOpenTask(t, ctx, admin, tenantID, horseID, "2099-01-01T21:59:59Z")
	nominated := plantOpenTask(t, ctx, admin, tenantID, trailerID, "2099-01-01T21:59:59Z")
	plantNomination(t, ctx, admin, tenantID, nominated, nominee)
	later := plantOpenTask(t, ctx, admin, tenantID, idle, "2099-06-01T21:59:59Z")
	overdue := plantOpenTask(t, ctx, admin, tenantID, idle, "2025-01-01T21:59:59Z")
	reason := "test"
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, state, cancelled_reason)
		 VALUES ($1, $2, '2099-06-01T21:59:59Z', 'CANCELLED', $3)`, tenantID, idle, reason)
	require.NoError(t, err)

	rows := unitTasks(t, h, tenantID, controller, horseID)
	require.Len(t, rows, 1)
	require.Equal(t, trip.String(), rows[0].ID)
	require.Equal(t, driver.String(), *rows[0].ResponsibleUserID)
	require.Equal(t, displayNameOf(t, ctx, admin, driver), *rows[0].ResponsibleDisplayName)
	require.Equal(t, "TRIP", *rows[0].ResponsibleVia)
	require.False(t, rows[0].Escalated)

	rows = unitTasks(t, h, tenantID, controller, trailerID)
	require.Len(t, rows, 1)
	require.Equal(t, nominated.String(), rows[0].ID)
	require.Equal(t, nominee.String(), *rows[0].ResponsibleUserID)
	require.Equal(t, "NOMINATION", *rows[0].ResponsibleVia)
	require.False(t, rows[0].Escalated)

	// By due, and the cancelled task is not listed.
	rows = unitTasks(t, h, tenantID, controller, idle)
	require.Len(t, rows, 2)
	require.Equal(t, overdue.String(), rows[0].ID)
	require.True(t, rows[0].Overdue)
	require.Equal(t, "2025-01-01T21:59:59Z", rows[0].DueAt)
	require.Equal(t, later.String(), rows[1].ID)
	require.False(t, rows[1].Overdue)
	for _, row := range rows {
		require.Equal(t, "OPEN", row.State)
		require.Nil(t, row.ResponsibleUserID)
		require.Nil(t, row.ResponsibleDisplayName)
		require.Nil(t, row.ResponsibleVia)
		require.True(t, row.Escalated)
		require.NotEmpty(t, row.FleetNumber)
	}
}

// The read is ViewFleet's (spec U2): a TECHNICIAN reads it, a DRIVER does
// not, the driver's own list is /api/my/tasks.
func TestUnitTaskReadsAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-reads-gate")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + horseID.String() + "/inspection-tasks"
	require.Equal(t, http.StatusOK, get(t, h, path, tenantID.String(), technician.String()).Code)
	require.Equal(t, http.StatusForbidden, get(t, h, path, tenantID.String(), driver.String()).Code)
	require.Equal(t, http.StatusBadRequest,
		get(t, h, "/api/vehicles/not-a-uuid/inspection-tasks", tenantID.String(), technician.String()).Code)
}

// A unit another tenant owns answers an empty list, never its rows: the read
// narrows through RLS on the view it selects from, as listUnitFitments does.
// Tenant A's rows are planted first so a leak would return them.
func TestUnitTaskReadsCrossTenantAreEmpty(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, horseID, _ := plantRigUnits(t, ctx, admin, "task-reads-a")
	driverA := plantUser(t, ctx, admin, tenantA, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantA, horseID, driverA)
	plantOpenTask(t, ctx, admin, tenantA, horseID, "2099-01-01T21:59:59Z")
	tenantB, _ := plantTenant(t, ctx, admin, "task-reads-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + horseID.String() + "/inspection-tasks"
	rec := get(t, h, path, tenantB.String(), controllerB.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t, `[]`, rec.Body.String(), "tenant B read tenant A's tasks")
	rec = get(t, h, path, tenantA.String(), controllerA.String())
	var own []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &own))
	require.NotEmpty(t, own, "the control: tenant A reads its own tasks")
}

// TYRE-90's DoD at the API: the controller schedules the task, the trip
// driver reads it on their own list, the capture they submit with its id
// closes it, and both lists are empty afterwards. The trailer's task goes to
// the horse's driver (U4, FR-INS-053) on the rig plantCaptureFixture opens,
// and stays open: the capture read the horse alone (U150).
func TestScheduleTaskIsSeenByTheDriverAndClosedBySubmit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantCaptureFixture(t, ctx, admin, "task-dod")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var task unitTaskRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.Equal(t, horseID.String(), task.VehicleID)
	require.Equal(t, "OPEN", task.State)
	require.False(t, task.Overdue)
	require.NotNil(t, task.ResponsibleUserID)
	require.Equal(t, driver.String(), *task.ResponsibleUserID)
	require.Equal(t, "TRIP", *task.ResponsibleVia)
	// The form renders this name back at the controller, so a POST answer
	// that omitted it would leave "Inspection scheduled for , due ...".
	require.NotNil(t, task.ResponsibleDisplayName)
	require.NotEmpty(t, *task.ResponsibleDisplayName)
	// Due at the tenant-local end of today: the same instant SQL computes,
	// read back here as a check rather than re-derived from a Go clock.
	var wantDue time.Time
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT ((app.tenant_today(t.timezone) + 1)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond'
		   FROM app.tenant t WHERE t.id = $1`, tenantID).Scan(&wantDue))
	gotDue, err := time.Parse(time.RFC3339, task.DueAt)
	require.NoError(t, err)
	// RFC3339 drops the fractional second, so the wire instant sits 0.999999 s
	// before the stored one; two seconds is the tolerance that pins the day
	// boundary without failing on the format.
	require.WithinDuration(t, wantDue, gotDue, 2*time.Second)

	rec = post(t, h, "/api/vehicles/"+trailerID.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var trailerTask unitTaskRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerTask))
	require.Equal(t, driver.String(), *trailerTask.ResponsibleUserID, "the horse's driver takes the trailer's task (U4)")

	rec = get(t, h, "/api/my/tasks", tenantID.String(), driver.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var mine []struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &mine))
	require.Len(t, mine, 2)

	var payload map[string]any
	require.NoError(t, json.Unmarshal([]byte(captureFixture(t, ctx, admin, tenantID, horseID)), &payload))
	payload["task_id"] = task.ID
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	rec = post(t, h, "/api/inspections", tenantID.String(), driver.String(), string(raw))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = get(t, h, "/api/my/tasks", tenantID.String(), driver.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &mine))
	require.Len(t, mine, 1, "the horse's task closed and the trailer's stayed: %s", rec.Body.String())
	require.Equal(t, trailerTask.ID, mine[0].ID)
	rec = get(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String())
	require.JSONEq(t, `[]`, rec.Body.String())
}

// A rig captured through the motive's task completes the trailer's due task
// too, since an inspection covers the configuration as a whole (U150).
func TestSubmitCompletesTheRigsDueTasks(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantCaptureFixture(t, ctx, admin, "task-rig")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var horseTask, trailerTask unitTaskRow
	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &horseTask))
	rec = post(t, h, "/api/vehicles/"+trailerID.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerTask))

	// submitted_at a second ahead: RFC3339 drops the fraction, and a capture
	// stamped before the tasks were created would answer neither (U150).
	now := time.Now()
	payload := captureBetween(t, ctx, admin, tenantID, horseID, now.Add(-2*time.Minute), now.Add(time.Second))
	positionID, tyreID := capturePositionAndTyre(t, ctx, admin, trailerID)
	payload["readings"] = append(payload["readings"].([]any), map[string]any{
		"vehicle_id": trailerID.String(), "position_id": positionID.String(), "tyre_id": tyreID,
		"pressure_kpa": 800, "treads": []float64{8.0, 8.5, 8.2},
	})
	payload["task_id"] = horseTask.ID
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	rec = post(t, h, "/api/inspections", tenantID.String(), driver.String(), string(raw))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	require.Empty(t, unitTasks(t, h, tenantID, controller, trailerID))
	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.inspection_task WHERE id = $1`, trailerTask.ID).Scan(&state))
	require.Equal(t, "COMPLETED", state)
}

func TestScheduleTaskWithoutADriverIsEscalated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-escalated")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var task unitTaskRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.Nil(t, task.ResponsibleUserID)
	require.Nil(t, task.ResponsibleVia)
	require.True(t, task.Escalated)
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.inspection_task_nomination WHERE task_id = $1`, task.ID).Scan(&n))
	require.Zero(t, n)
}

// A nominee reads the task on their own list and closes it with the capture
// that names it (FR-INS-051 as amended, FR-AUT-005).
func TestScheduleTaskNominatesADriver(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _, _ := plantCaptureFixture(t, ctx, admin, "task-nominate")
	idle, _ := plantUnrelatedVehicle(t, ctx, admin, tenantID)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	nominee := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+idle.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"nomineeUserId":%q}`, nominee))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var task unitTaskRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.Equal(t, nominee.String(), *task.ResponsibleUserID)
	require.Equal(t, displayNameOf(t, ctx, admin, nominee), *task.ResponsibleDisplayName)
	require.Equal(t, "NOMINATION", *task.ResponsibleVia)
	require.False(t, task.Escalated)

	rec = get(t, h, "/api/my/tasks", tenantID.String(), nominee.String())
	var mine []struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &mine))
	require.Len(t, mine, 1)
	require.Equal(t, task.ID, mine[0].ID)

	// submitted_at a second ahead: RFC3339 drops the fraction, and a capture
	// ending before the nomination was made is one the nominee did not hold.
	now := time.Now()
	payload := captureBetween(t, ctx, admin, tenantID, idle, now.Add(-2*time.Minute), now.Add(time.Second))
	payload["task_id"] = task.ID
	raw, err := json.Marshal(payload)
	require.NoError(t, err)
	rec = post(t, h, "/api/inspections", tenantID.String(), nominee.String(), string(raw))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = get(t, h, "/api/my/tasks", tenantID.String(), nominee.String())
	require.JSONEq(t, `[]`, rec.Body.String())
}

// TY018 forwarded verbatim (ADR-0012): the task already goes to the trip
// driver, and nothing is written.
func TestScheduleTaskRefusesANomineeOnACoveredUnit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-covered")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	other := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTrip(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"nomineeUserId":%q}`, other))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY018", ref.Code)
	require.Equal(t, fmt.Sprintf("%s is on %s's trip; the inspection already goes to them",
		fleetNumberOf(t, ctx, admin, horseID), displayNameOf(t, ctx, admin, driver)), ref.Message)
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantID))
}

// A TECHNICIAN holds no CaptureInspection, so a nomination would give them a
// unit they are refused on opening (ADR-0013, Accepted gaps).
func TestScheduleTaskRefusesANomineeWhoCannotCapture(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-capturer")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"nomineeUserId":%q}`, technician))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "invalid_submission", ref.Code)
	require.Equal(t, "nomineeUserId names a user whose role cannot capture inspections", ref.Message)
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantID))
}

func TestNominateForTask(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "nominate")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	first := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	second := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	mineDepot, mineFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, mineDepot)
	_, elsewhereFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)
	unitID := func(fleet string) uuid.UUID {
		var id uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet).Scan(&id))
		return id
	}
	mine, elsewhere := unitID(mineFleet), unitID(elsewhereFleet)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	nominate := func(actor, taskID, userID uuid.UUID) *unitTaskRow {
		t.Helper()
		rec := post(t, h, "/api/inspection-tasks/"+taskID.String()+"/nominations", tenantID.String(), actor.String(),
			fmt.Sprintf(`{"userId":%q}`, userID))
		if rec.Code != http.StatusCreated {
			return nil
		}
		var row unitTaskRow
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &row))
		return &row
	}

	task := plantOpenTask(t, ctx, admin, tenantID, mine, "2099-01-01T21:59:59Z")
	row := nominate(controller, task, first)
	require.NotNil(t, row)
	require.Equal(t, first.String(), *row.ResponsibleUserID)
	require.Equal(t, "NOMINATION", *row.ResponsibleVia)
	row = nominate(manager, task, second)
	require.NotNil(t, row, "a depot manager nominates on their own depot's unit")
	require.Equal(t, second.String(), *row.ResponsibleUserID, "a newer nomination replaces the nominee")

	rec := post(t, h, "/api/inspection-tasks/"+task.String()+"/nominations", tenantID.String(), first.String(),
		fmt.Sprintf(`{"userId":%q}`, first))
	require.Equal(t, http.StatusForbidden, rec.Code, "a DRIVER holds no ManageAssignments")

	rec = post(t, h, "/api/inspection-tasks/"+uuid.NewString()+"/nominations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"userId":%q}`, first))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref := decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "no such inspection task in this fleet", ref.Message)

	away := plantOpenTask(t, ctx, admin, tenantID, elsewhere, "2099-01-01T21:59:59Z")
	rec = post(t, h, "/api/inspection-tasks/"+away.String()+"/nominations", tenantID.String(), manager.String(),
		fmt.Sprintf(`{"userId":%q}`, first))
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	require.Equal(t, "no such inspection task in this fleet", decodeRefusal(t, rec.Body.Bytes()).Message)
	require.NotNil(t, nominate(controller, away, first), "the control: a controller reaches the same task")

	var insp uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at)
		 VALUES ($1, $2, $3, gen_random_uuid(), now() - interval '1 hour', now() - interval '50 minutes')
		 RETURNING id`, tenantID, mine, first).Scan(&insp))
	done := plantOpenTask(t, ctx, admin, tenantID, mine, "2099-02-01T21:59:59Z")
	_, err := admin.Exec(ctx,
		`UPDATE app.inspection_task SET state = 'COMPLETED', completed_inspection_id = $2 WHERE id = $1`, done, insp)
	require.NoError(t, err)
	rec = post(t, h, "/api/inspection-tasks/"+done.String()+"/nominations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"userId":%q}`, first))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	ref = decodeRefusal(t, rec.Body.Bytes())
	require.Equal(t, "TY018", ref.Code)
	require.Equal(t, "this inspection is completed; only an open one takes a driver", ref.Message)
}

// FR-AUT-008's depot narrowing for a write that predates it; TestFitTyreIsDepotScoped
// carries why, and why the controller is the control (TYRE-226).
func TestScheduleInspectionTaskIsDepotScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "task-depot")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	manager := plantUser(t, ctx, admin, tenantID, auth.RoleDepotManager)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	mineDepot, mineFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)
	joinDepot(t, ctx, admin, tenantID, manager, mineDepot)
	_, elsewhereFleet := plantDepotWithVehicle(t, ctx, admin, tenantID)

	unitID := func(fleet string) uuid.UUID {
		var id uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet).Scan(&id))
		return id
	}
	mine, elsewhere := unitID(mineFleet), unitID(elsewhereFleet)

	rec := post(t, h, "/api/vehicles/"+elsewhere.String()+"/inspection-tasks", tenantID.String(), manager.String(), `{}`)
	require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "not_found", ref.Code)

	// the refused write must not have written
	var open int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.inspection_task WHERE vehicle_id = $1`, elsewhere).Scan(&open))
	require.Zero(t, open)

	// control: the same call on the manager's own unit, and the controller's
	// on the out-of-depot one, both land
	require.Equal(t, http.StatusCreated,
		post(t, h, "/api/vehicles/"+mine.String()+"/inspection-tasks", tenantID.String(), manager.String(), `{}`).Code)
	require.Equal(t, http.StatusCreated,
		post(t, h, "/api/vehicles/"+elsewhere.String()+"/inspection-tasks", tenantID.String(), controller.String(), `{}`).Code)
}

// Shape is Go's (ADR-0013 decision 5); the due-day rule is SQL's.
func TestScheduleTaskShapeAndDate(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-shape")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + horseID.String() + "/inspection-tasks"

	cases := []struct {
		name, body, field string
	}{
		{"nomineeUserId not a uuid", `{"nomineeUserId":"nope"}`, "nomineeUserId"},
		{"dueOn not a date", `{"dueOn":"tomorrow"}`, "dueOn"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := post(t, h, path, tenantID.String(), controller.String(), tc.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Contains(t, ref.Message, tc.field)
		})
	}
	require.Equal(t, http.StatusBadRequest,
		post(t, h, "/api/vehicles/not-a-uuid/inspection-tasks", tenantID.String(), controller.String(), `{}`).Code)

	// An explicit null is no nominee.
	rec := post(t, h, path, tenantID.String(), controller.String(), `{"nomineeUserId":null}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	// A fixed far-future literal, never clock arithmetic (lessons 2026-09-03).
	rec = post(t, h, path, tenantID.String(), controller.String(), `{"dueOn":"2099-01-01"}`)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = post(t, h, path, tenantID.String(), controller.String(), `{"dueOn":"2000-01-01"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY018", ref.Code)
	require.Equal(t, "a task is due today or later, never in the past", ref.Message)
}

// ManageAssignments gates the write (spec U2): a TECHNICIAN holds ViewFleet
// alone and is refused; a DRIVER is refused. The positive control is
// TestScheduleTaskIsSeenByTheDriverAndClosedBySubmit above, where a
// CONTROLLER posts the same body and is answered 201, so a 403 here is the
// capability and not the route refusing everyone.
func TestScheduleTaskIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-gate")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	for _, actor := range []uuid.UUID{technician, driver} {
		require.Equal(t, http.StatusForbidden,
			post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), actor.String(), `{}`).Code)
	}
}

// Tenant B's controller names tenant A's unit, then nominates tenant A's
// driver on a unit of its own. Neither probe can succeed under a leak, and
// neither can answer TY012, which is what makes the code and the message the
// discriminating assert. Each tenant's own identical call is the control
// that the refusal was tenant-caused, not a fixture that could refuse anyone.
func TestScheduleTaskCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, horseA, _ := plantRigUnits(t, ctx, admin, "task-xten-a")
	driverA := plantUser(t, ctx, admin, tenantA, auth.RoleDriver)
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	tenantB, horseB, _ := plantRigUnits(t, ctx, admin, "task-xten-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	body := fmt.Sprintf(`{"nomineeUserId":%q}`, driverA)

	rec := post(t, h, "/api/vehicles/"+horseA.String()+"/inspection-tasks", tenantB.String(), controllerB.String(), `{}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code, "tenant B scheduled on tenant A's unit: RLS leaked the row (got %s)", rec.Body.String())
	require.Equal(t, "no such unit in this fleet", ref.Message)

	rec = post(t, h, "/api/vehicles/"+horseB.String()+"/inspection-tasks", tenantB.String(), controllerB.String(), body)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code, "tenant B nominated tenant A's driver: RLS leaked the row (got %s)", rec.Body.String())
	require.Equal(t, "no such user in this fleet", ref.Message)
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantA))
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantB))

	rec = post(t, h, "/api/vehicles/"+horseA.String()+"/inspection-tasks", tenantA.String(), controllerA.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, "the control: the unit's own tenant schedules it: %s", rec.Body.String())

	// Tenant B's own control for its own probe: the same controller, on the
	// same unit, with a nominee of its own succeeds, so the second refusal
	// was the nominee's tenant and not something standing about horseB.
	driverB := plantUser(t, ctx, admin, tenantB, auth.RoleDriver)
	rec = post(t, h, "/api/vehicles/"+horseB.String()+"/inspection-tasks", tenantB.String(), controllerB.String(),
		fmt.Sprintf(`{"nomineeUserId":%q}`, driverB))
	require.Equal(t, http.StatusCreated, rec.Code, "the control: tenant B nominates its own driver: %s", rec.Body.String())
}

func countTasks(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.inspection_task WHERE tenant_id = $1`, tenantID).Scan(&n))
	return n
}
