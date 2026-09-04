package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

// The drivers read is FR-INS-053's chain as a list: the unit's own current
// drivers first, then — for a trailer in an open rig — the motive's, each row
// saying which unit the assignment is on. The horse's driver appears once
// for the horse (R5), and a driver assigned to both units appears once for
// the trailer, own assignment first.
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
// the dates (lessons 2026-09-03), planted directly because the write does
// not exist until Task 7; the overdue row is due last year.
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
