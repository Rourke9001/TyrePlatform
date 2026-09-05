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

// The drivers read is FR-INS-053's chain as a list: the unit's own current
// drivers first, then — for a trailer in an open rig — the motive's, each row
// saying which unit the assignment is on. The horse's driver appears once
// for the horse (U4: the horse's own assignment satisfies the capture
// predicate directly, so the rig leg adds no second row for it), and a
// driver assigned to both units appears once for the trailer, own
// assignment first.
func TestUnitDriversListsOwnAndMotiveAssignments(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantRigUnits(t, ctx, admin, "drivers")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	horseDriver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	bothDriver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, horseID, horseDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, horseID, bothDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, trailerID, bothDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/combinations", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"motiveVehicleId":%q,"towed":[{"vehicleId":%q}]}`, horseID, trailerID))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var rig rigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rig))

	type driverRow struct {
		UserID       string `json:"userId"`
		DisplayName  string `json:"displayName"`
		ViaVehicleID string `json:"viaVehicleId"`
	}
	rec = get(t, h, "/api/vehicles/"+horseID.String()+"/drivers", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var horseRows []driverRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &horseRows))
	require.Len(t, horseRows, 2, "the horse lists its two drivers once each: %s", rec.Body.String())
	for _, row := range horseRows {
		require.Equal(t, horseID.String(), row.ViaVehicleID)
	}

	rec = get(t, h, "/api/vehicles/"+trailerID.String()+"/drivers", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var trailerRows []driverRow
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerRows))
	require.Len(t, trailerRows, 2, "the trailer lists the horse's driver and its own once each: %s", rec.Body.String())
	via := map[string]string{}
	for _, row := range trailerRows {
		via[row.UserID] = row.ViaVehicleID
	}
	require.Equal(t, horseID.String(), via[horseDriver.String()], "the horse's driver reaches the trailer through the rig")
	require.Equal(t, trailerID.String(), via[bothDriver.String()], "own assignment wins over the rig leg")
	require.Equal(t, bothDriver.String(), trailerRows[0].UserID, "own assignment lists first")

	// The rig leg's own active filter, with the rig still open and the
	// assignment untouched: a deactivated driver is not one a task may name
	// (ADR-0011), so they leave the list the rig put them on. The assertion
	// above is the control that they were on it a moment earlier.
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, horseDriver)
	require.NoError(t, err)
	rec = get(t, h, "/api/vehicles/"+trailerID.String()+"/drivers", tenantID.String(), controller.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerRows))
	require.Len(t, trailerRows, 1, "a deactivated driver still reaches the trailer through the rig: %s", rec.Body.String())
	require.Equal(t, bothDriver.String(), trailerRows[0].UserID)

	// Ending the rig removes the rig leg and nothing else.
	rec = post(t, h, "/api/combinations/"+rig.ID+"/end", tenantID.String(), controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	rec = get(t, h, "/api/vehicles/"+trailerID.String()+"/drivers", tenantID.String(), controller.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerRows))
	require.Len(t, trailerRows, 1)
	require.Equal(t, bothDriver.String(), trailerRows[0].UserID)
}

// The unit's task list: OPEN and ESCALATED by due date, each with its
// assignee, overdue computed by the view and never here. Fixed literals for
// the dates (lessons 2026-09-03); rows are planted directly rather than
// through the API, since the read is what is under test, not the write; the
// overdue row is due last year.
func TestUnitTasksListsOpenAndEscalatedWithAssignee(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "unit-tasks")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	plantTask := func(state string, dueAt string, assignee *uuid.UUID, reason *string) uuid.UUID {
		t.Helper()
		var id uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, state, completed_inspection_id, cancelled_reason)
			 VALUES ($1, $2, $3::timestamptz, $4, $5::app.task_state, NULL, $6) RETURNING id`,
			tenantID, horseID, dueAt, assignee, state, reason).Scan(&id))
		return id
	}
	overdue := plantTask("OPEN", "2025-01-01T21:59:59Z", &driver, nil)
	later := plantTask("OPEN", "2099-01-01T21:59:59Z", &driver, nil)
	escalated := plantTask("ESCALATED", "2099-06-01T21:59:59Z", nil, nil)
	cancelledReason := "test"
	// A CANCELLED task must carry a reason (cancellation_is_explained, 000012)
	// and must not appear in the read below — that is this row's whole point.
	_ = plantTask("CANCELLED", "2099-06-01T21:59:59Z", nil, &cancelledReason)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var rows []struct {
		ID                  string  `json:"id"`
		VehicleID           string  `json:"vehicleId"`
		FleetNumber         string  `json:"fleetNumber"`
		DueAt               string  `json:"dueAt"`
		State               string  `json:"state"`
		Overdue             bool    `json:"overdue"`
		AssignedUserID      *string `json:"assignedUserId"`
		AssignedDisplayName *string `json:"assignedDisplayName"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rows))
	require.Len(t, rows, 3, rec.Body.String())
	require.Equal(t, overdue.String(), rows[0].ID)
	require.True(t, rows[0].Overdue)
	require.Equal(t, "2025-01-01T21:59:59Z", rows[0].DueAt)
	require.NotNil(t, rows[0].AssignedUserID)
	require.NotNil(t, rows[0].AssignedDisplayName)
	require.Equal(t, driver.String(), *rows[0].AssignedUserID)
	require.NotEmpty(t, *rows[0].AssignedDisplayName)
	require.Equal(t, later.String(), rows[1].ID)
	require.False(t, rows[1].Overdue)
	require.Equal(t, escalated.String(), rows[2].ID)
	require.Equal(t, "ESCALATED", rows[2].State)
	require.Nil(t, rows[2].AssignedUserID)
	require.NotEmpty(t, rows[0].FleetNumber)
}

// Both reads are ViewFleet's (spec U2): a TECHNICIAN reads them, a DRIVER
// does not — the driver's own list is /api/my/tasks.
func TestUnitTaskReadsAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-reads-gate")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	for _, path := range []string{"/drivers", "/inspection-tasks"} {
		require.Equal(t, http.StatusOK,
			get(t, h, "/api/vehicles/"+horseID.String()+path, tenantID.String(), technician.String()).Code, path)
		require.Equal(t, http.StatusForbidden,
			get(t, h, "/api/vehicles/"+horseID.String()+path, tenantID.String(), driver.String()).Code, path)
	}
	require.Equal(t, http.StatusBadRequest,
		get(t, h, "/api/vehicles/not-a-uuid/drivers", tenantID.String(), technician.String()).Code)
}

// A unit another tenant owns answers an empty list, never its rows: both
// reads narrow through RLS on the views they select from, as listUnitFitments
// does. Tenant A's rows are planted first so a leak would return them.
func TestUnitTaskReadsCrossTenantAreEmpty(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, horseID, _ := plantRigUnits(t, ctx, admin, "task-reads-a")
	driverA := plantUser(t, ctx, admin, tenantA, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantA, horseID, driverA)
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id)
		 VALUES ($1, $2, '2099-01-01T21:59:59Z', $3)`, tenantA, horseID, driverA)
	require.NoError(t, err)
	tenantB, _ := plantTenant(t, ctx, admin, "task-reads-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	for _, path := range []string{"/drivers", "/inspection-tasks"} {
		rec := get(t, h, "/api/vehicles/"+horseID.String()+path, tenantB.String(), controllerB.String())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		require.JSONEq(t, `[]`, rec.Body.String(), "tenant B read tenant A's %s", path)
		rec = get(t, h, "/api/vehicles/"+horseID.String()+path, tenantA.String(), controllerA.String())
		var own []map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &own))
		require.NotEmpty(t, own, "the control: tenant A reads its own %s", path)
	}
}

// TYRE-90's DoD at the API: the controller schedules the task, the driver
// reads it on their own list, the capture they submit with its id closes
// it, and both lists are empty afterwards. The trailer's task goes to the
// horse's driver (U4) on the rig plantCaptureFixture opens.
func TestScheduleTaskIsSeenByTheDriverAndClosedBySubmit(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, trailerID := plantCaptureFixture(t, ctx, admin, "task-dod")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"assigneeUserId":%q}`, driver))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var task struct {
		ID                  string  `json:"id"`
		VehicleID           string  `json:"vehicleId"`
		DueAt               string  `json:"dueAt"`
		State               string  `json:"state"`
		Overdue             bool    `json:"overdue"`
		AssignedUserID      *string `json:"assignedUserId"`
		AssignedDisplayName *string `json:"assignedDisplayName"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.Equal(t, horseID.String(), task.VehicleID)
	require.Equal(t, "OPEN", task.State)
	require.False(t, task.Overdue)
	require.NotNil(t, task.AssignedUserID)
	require.Equal(t, driver.String(), *task.AssignedUserID)
	// The form renders this name back at the controller, so a POST answer
	// that omitted it would leave "Inspection scheduled for , due …".
	require.NotNil(t, task.AssignedDisplayName)
	require.NotEmpty(t, *task.AssignedDisplayName)
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

	rec = post(t, h, "/api/vehicles/"+trailerID.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"assigneeUserId":%q}`, driver))
	require.Equal(t, http.StatusCreated, rec.Code, "the horse's driver takes the trailer's task (U4): %s", rec.Body.String())
	var trailerTask struct {
		ID string `json:"id"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &trailerTask))

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
	// By id, not by count: the close is by task id (000023), so a close that
	// took the wrong one of two would leave the list the same length.
	require.Equal(t, trailerTask.ID, mine[0].ID)
	rec = get(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String())
	require.JSONEq(t, `[]`, rec.Body.String())
}

// TY018 forwarded verbatim (ADR-0012): the message the form renders.
func TestScheduleTaskRefusesAnUnassignedDriver(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-refuse")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	stranger := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"assigneeUserId":%q}`, stranger))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY018", ref.Code)
	require.Contains(t, ref.Message, "is not assigned to")
	require.Contains(t, ref.Message, "or to the horse pulling it")
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantID))
}

// Shape is Go's (ADR-0013 decision 5); the due-day rule is SQL's.
func TestScheduleTaskShapeAndDate(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-shape")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantID, horseID, driver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/vehicles/" + horseID.String() + "/inspection-tasks"

	cases := []struct {
		name, body, field string
	}{
		{"assigneeUserId missing", `{}`, "assigneeUserId"},
		{"assigneeUserId not a uuid", `{"assigneeUserId":"nope"}`, "assigneeUserId"},
		{"dueOn not a date", fmt.Sprintf(`{"assigneeUserId":%q,"dueOn":"tomorrow"}`, driver), "dueOn"},
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

	// A fixed far-future literal, never clock arithmetic (lessons 2026-09-03).
	rec := post(t, h, path, tenantID.String(), controller.String(),
		fmt.Sprintf(`{"assigneeUserId":%q,"dueOn":"2099-01-01"}`, driver))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = post(t, h, path, tenantID.String(), controller.String(),
		fmt.Sprintf(`{"assigneeUserId":%q,"dueOn":"2000-01-01"}`, driver))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY018", ref.Code)
	require.Equal(t, "a task is due today or later, never in the past", ref.Message)
}

// ManageAssignments gates the write (spec U2): a TECHNICIAN holds ViewFleet
// alone and is refused; a DRIVER is refused. The positive control is
// TestScheduleTaskIsSeenByTheDriverAndClosedBySubmit above, where a
// CONTROLLER posts the same body and is answered 201 — so a 403 here is the
// capability and not the route refusing everyone.
func TestScheduleTaskIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, horseID, _ := plantRigUnits(t, ctx, admin, "task-gate")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	body := fmt.Sprintf(`{"assigneeUserId":%q}`, driver)
	for _, actor := range []uuid.UUID{technician, driver} {
		require.Equal(t, http.StatusForbidden,
			post(t, h, "/api/vehicles/"+horseID.String()+"/inspection-tasks", tenantID.String(), actor.String(), body).Code)
	}
}

// Tenant B's controller names tenant A's unit, then tenant A's driver on a
// unit of its own. Neither probe can succeed under a leak, and neither can
// answer TY012, which is what makes the code and the message the
// discriminating assert. Should RLS start returning tenant A's rows here,
// the first probe reaches the insert and dies as 23503 on
// app.inspection_task's composite tenant FKs (000012:366-369, on 000004's
// parent keys) because the row stamps tenant B's tenant_id against tenant
// A's vehicle — FK checks bypass RLS. The second dies earlier and as TY018:
// tenant A's driver holds no assignment to tenant B's unit, so
// app.user_can_capture answers false before any row is written. Each
// tenant's own identical call is the control that the refusal was
// tenant-caused, not a fixture that could refuse anyone.
func TestScheduleTaskCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, horseA, _ := plantRigUnits(t, ctx, admin, "task-xten-a")
	driverA := plantUser(t, ctx, admin, tenantA, auth.RoleDriver)
	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	assignVehicleDriver(t, ctx, admin, tenantA, horseA, driverA)
	tenantB, horseB, _ := plantRigUnits(t, ctx, admin, "task-xten-b")
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	body := fmt.Sprintf(`{"assigneeUserId":%q}`, driverA)

	rec := post(t, h, "/api/vehicles/"+horseA.String()+"/inspection-tasks", tenantB.String(), controllerB.String(), body)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code, "tenant B scheduled on tenant A's unit: RLS leaked the row (got %s)", rec.Body.String())
	require.Equal(t, "no such unit in this fleet", ref.Message)

	rec = post(t, h, "/api/vehicles/"+horseB.String()+"/inspection-tasks", tenantB.String(), controllerB.String(), body)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code, "tenant B named tenant A's driver: RLS leaked the row (got %s)", rec.Body.String())
	require.Equal(t, "no such user in this fleet", ref.Message)
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantA))
	require.Equal(t, 0, countTasks(t, ctx, admin, tenantB))

	rec = post(t, h, "/api/vehicles/"+horseA.String()+"/inspection-tasks", tenantA.String(), controllerA.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, "the control: the unit's own tenant schedules it: %s", rec.Body.String())

	// Tenant B's own control for its own probe: the same controller, on the
	// same unit, with an assignee of its own succeeds — so the second refusal
	// was the assignee's tenant and not something standing about horseB.
	driverB := plantUser(t, ctx, admin, tenantB, auth.RoleDriver)
	assignVehicleDriver(t, ctx, admin, tenantB, horseB, driverB)
	rec = post(t, h, "/api/vehicles/"+horseB.String()+"/inspection-tasks", tenantB.String(), controllerB.String(),
		fmt.Sprintf(`{"assigneeUserId":%q}`, driverB))
	require.Equal(t, http.StatusCreated, rec.Code, "the control: tenant B schedules its own driver: %s", rec.Body.String())
}

func countTasks(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.inspection_task WHERE tenant_id = $1`, tenantID).Scan(&n))
	return n
}
