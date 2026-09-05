// The inspection task (TYRE-90): a controller schedules an ad-hoc inspection
// for a driver on a unit. Who may capture which unit, which day a task may
// be due on, and what is overdue are app.v_user_capture_vehicle's,
// app.create_inspection_task's and app.v_inspection_task's alone (000038);
// this file validates shape, gates the capability and projects rows
// (ADR-0013 decision 5). It decides nothing about tasks. The U-codes cited
// below are docs/superpowers/specs/2026-09-03-b6-rig-setup-design.md's.
package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// unitDriverJSON is one person who can capture the unit, and through which
// assignment: their own on this unit, or the motive's when this unit is a
// trailer in an open rig (FR-INS-053, spec U4).
type unitDriverJSON struct {
	UserID         string  `json:"userId"`
	DisplayName    string  `json:"displayName"`
	StaffNumber    *string `json:"staffNumber"`
	ViaVehicleID   string  `json:"viaVehicleId"`
	ViaFleetNumber string  `json:"viaFleetNumber"`
}

// unitTaskJSON is the controller's row: the driver's own shape (listMyTasks's
// taskJSON) plus who it is assigned to. Embedded rather than widened, so the
// driver's list keeps its bytes (U13's reasoning).
type unitTaskJSON struct {
	taskJSON
	AssignedUserID      *string `json:"assignedUserId"`
	AssignedDisplayName *string `json:"assignedDisplayName"`
}

// listUnitDrivers is FR-INS-053's chain, read as a list (U4). Neither this
// read nor listUnitTasks narrows by depot scope, mirroring getUnit and
// listUnitFitments: a depot-scoped role that already reached this unit by id
// may read its drivers and its tasks.
func listUnitDrivers(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		out := []unitDriverJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			// DISTINCT ON folds a driver assigned to both the horse and its
			// trailer, who holds two rows in v_user_capture_vehicle (U4:
			// assignment, or the motive's assignment), into one row, own
			// assignment first. No existence check on the unit beyond RLS —
			// an id this tenant cannot see matches no rows and answers [],
			// as listUnitFitments does.
			rows, err := tx.Query(ctx, `
				SELECT d.user_id, d.display_name, d.staff_number, d.via_vehicle_id, d.via_fleet_number
				  FROM (SELECT DISTINCT ON (ucv.user_id)
				               ucv.user_id, u.display_name, u.staff_number, ucv.via_vehicle_id, vv.fleet_number AS via_fleet_number
				          FROM app.v_user_capture_vehicle ucv
				          JOIN app.app_user u ON u.id = ucv.user_id
				          JOIN app.vehicle vv ON vv.id = ucv.via_vehicle_id
				         WHERE ucv.vehicle_id = $1
				         ORDER BY ucv.user_id, (ucv.via_vehicle_id = $1) DESC) d
				 ORDER BY (d.via_vehicle_id = $1) DESC, d.display_name, d.user_id`, vehicleID)
			if err != nil {
				return fmt.Errorf("listing drivers for unit %s: %w", vehicleID, err)
			}
			defer rows.Close()
			for rows.Next() {
				var (
					userID, viaVehicleID uuid.UUID
					displayName          string
					staffNumber          *string
					viaFleetNumber       string
				)
				if err := rows.Scan(&userID, &displayName, &staffNumber, &viaVehicleID, &viaFleetNumber); err != nil {
					return fmt.Errorf("scanning driver row: %w", err)
				}
				out = append(out, unitDriverJSON{
					UserID: userID.String(), DisplayName: displayName, StaffNumber: staffNumber,
					ViaVehicleID: viaVehicleID.String(), ViaFleetNumber: viaFleetNumber,
				})
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// loadUnitTasks answers OPEN and ESCALATED tasks, by due date, with each
// task's assignee — either the unit's (vehicleID bound, taskID nil) or one
// task by id (taskID bound, so a write that creates one can read its own row
// back through it, as combinationByID does for rigs). Both filters are bound
// parameters, so a nil id is every task and there is one statement to read.
func loadUnitTasks(ctx context.Context, tx pgx.Tx, vehicleID *uuid.UUID, taskID *uuid.UUID) ([]unitTaskJSON, error) {
	out := []unitTaskJSON{}
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.vehicle_id, v.fleet_number, t.due_at, t.state::text, t.overdue,
		       t.assigned_user_id, u.display_name
		  FROM app.v_inspection_task t
		  JOIN app.vehicle v ON v.id = t.vehicle_id
		  LEFT JOIN app.app_user u ON u.id = t.assigned_user_id
		 WHERE ($1::uuid IS NULL OR t.vehicle_id = $1)
		   AND ($2::uuid IS NULL OR t.id = $2)
		   AND t.outstanding
		 ORDER BY t.due_at, t.id`, vehicleID, taskID)
	if err != nil {
		return nil, fmt.Errorf("listing unit tasks: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			t                   unitTaskJSON
			id, taskVehicleID   uuid.UUID
			due                 time.Time
			assignedUserID      *uuid.UUID
			assignedDisplayName *string
		)
		if err := rows.Scan(&id, &taskVehicleID, &t.FleetNumber, &due, &t.State, &t.Overdue,
			&assignedUserID, &assignedDisplayName); err != nil {
			return nil, fmt.Errorf("scanning unit task row: %w", err)
		}
		t.ID = id.String()
		t.VehicleID = taskVehicleID.String()
		t.DueAt = due.UTC().Format(time.RFC3339)
		if assignedUserID != nil {
			s := assignedUserID.String()
			t.AssignedUserID = &s
		}
		t.AssignedDisplayName = assignedDisplayName
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading unit tasks: %w", err)
	}
	return out, nil
}

// listUnitTasks is the controller's read of one unit's open work, gated on
// ViewFleet like every other fleet read (spec U2); the depot-scope reasoning
// is listUnitDrivers's, above.
func listUnitTasks(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		out := []unitTaskJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			loaded, err := loadUnitTasks(ctx, tx, &vehicleID, nil)
			if err != nil {
				return err
			}
			out = loaded
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

type scheduleTaskRequest struct {
	AssigneeUserID string `json:"assigneeUserId"`
	// Omitted means the tenant's today, resolved by app.create_inspection_task
	// in the tenant's own zone; a Go clock's today is the runner's day, not
	// the fleet's (rule 6, lessons 2026-09-03).
	DueOn *string `json:"dueOn"`
}

// scheduleInspectionTask is FR-INS-051's write. The task it answers with is
// read back through loadUnitTasks rather than assembled from the request, so
// the caller sees the row as stored — the due instant the tenant's zone
// resolved, and overdue as the view computes it.
func scheduleInspectionTask(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var body scheduleTaskRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		assignee, err := uuidField("assigneeUserId", body.AssigneeUserID)
		if refuseInvalid(w, r, err) {
			return
		}
		dueOn, err := dateField("dueOn", body.DueOn)
		if refuseInvalid(w, r, err) {
			return
		}
		var task unitTaskJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			var taskID uuid.UUID
			if err := tx.QueryRow(ctx,
				`SELECT app.create_inspection_task($1, $2, $3::date)`,
				vehicleID, assignee, dueOn).Scan(&taskID); err != nil {
				return fmt.Errorf("scheduling inspection on unit %s: %w", vehicleID, err)
			}
			created, err := loadUnitTasks(ctx, tx, nil, &taskID)
			if err != nil {
				return fmt.Errorf("reading back task %s: %w", taskID, err)
			}
			if len(created) != 1 {
				return fmt.Errorf("reading back task %s: %d rows", taskID, len(created))
			}
			task = created[0]
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, task)
	}
}
