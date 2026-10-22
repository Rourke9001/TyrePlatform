// The inspection task (TYRE-90): a controller schedules an ad-hoc inspection
// on a unit and may nominate a driver for it (FR-INS-051 as amended). Who
// holds a task is app.task_driver_at's (000060), which day it may be due on
// is app.create_inspection_task's, and what is overdue is
// app.v_inspection_task's. This file validates shape, gates the capability,
// applies depot scope and projects rows (ADR-0013 decision 5), and applies
// the one role rule the schema cannot (refuseNonCapturer, admin.go; ADR-0013,
// decision 1 as amended 2026-10-21). The U-codes cited below are
// docs/superpowers/specs/2026-09-03-b6-rig-setup-design.md's.
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// taskJSON is the driver's own shape (listMyTasks). unitTaskJSON embeds it
// rather than widening it, so the driver's list keeps its bytes (U13's
// reasoning).
type taskJSON struct {
	ID          string `json:"id"`
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
	DueAt       string `json:"dueAt"`
	State       string `json:"state"`
	Overdue     bool   `json:"overdue"`
}

// unitTaskJSON is the controller's row: taskJSON plus who is responsible for
// it now and how, TRIP, NOMINATION or MOTIVE_NOMINATION, and escalated, an
// outstanding task nobody holds (FR-INS-053 as amended).
type unitTaskJSON struct {
	taskJSON
	ResponsibleUserID      *string `json:"responsibleUserId"`
	ResponsibleDisplayName *string `json:"responsibleDisplayName"`
	ResponsibleVia         *string `json:"responsibleVia"`
	Escalated              bool    `json:"escalated"`
}

// loadUnitTasks answers outstanding tasks, by due date, with each task's
// responsible driver, either the unit's (vehicleID bound, taskID nil) or one
// task by id (taskID bound, so a write that creates one can read its own row
// back through it, as combinationByID does for rigs). Both filters are bound
// parameters, so a nil id is every task and there is one statement to read.
func loadUnitTasks(ctx context.Context, tx pgx.Tx, vehicleID *uuid.UUID, taskID *uuid.UUID) ([]unitTaskJSON, error) {
	out := []unitTaskJSON{}
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.vehicle_id, v.fleet_number, t.due_at, t.state::text, t.overdue,
		       t.escalated, t.responsible_user_id, u.display_name, t.responsible_via
		  FROM app.v_inspection_task_driver t
		  JOIN app.vehicle v ON v.id = t.vehicle_id
		  LEFT JOIN app.app_user u ON u.id = t.responsible_user_id
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
			t                 unitTaskJSON
			id, taskVehicleID uuid.UUID
			due               time.Time
			responsibleUserID *uuid.UUID
		)
		if err := rows.Scan(&id, &taskVehicleID, &t.FleetNumber, &due, &t.State, &t.Overdue,
			&t.Escalated, &responsibleUserID, &t.ResponsibleDisplayName, &t.ResponsibleVia); err != nil {
			return nil, fmt.Errorf("scanning unit task row: %w", err)
		}
		t.ID = id.String()
		t.VehicleID = taskVehicleID.String()
		t.DueAt = due.UTC().Format(time.RFC3339)
		if responsibleUserID != nil {
			s := responsibleUserID.String()
			t.ResponsibleUserID = &s
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading unit tasks: %w", err)
	}
	return out, nil
}

// listUnitTasks is the controller's read of one unit's open work, gated on
// ViewFleet like every other fleet read (spec U2). Depot scope is the unit's
// (unitSource), as for every by-id unit route (ADR-0006, FR-AUT-008): a unit
// outside the actor's depots answers [] here exactly as listUnitFitments
// does.
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
			var visible bool
			if err := tx.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM `+unitSource(a)+` s WHERE s.id = $1)`, vehicleID).Scan(&visible); err != nil {
				return fmt.Errorf("resolving unit %s: %w", vehicleID, err)
			}
			if !visible {
				return nil
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

// listMyTasks is the driver's outstanding work (FR-DSH-012). Overdue is
// computed in the view, not here: it is an OPEN task past its due date and
// never a state the client may infer for itself.
func listMyTasks(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tasks := []taskJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			// The scope view must stay the driving relation: app.vehicle is
			// reached only through v_my_inspection_task's already-narrowed
			// rows, never joined the other way round (ADR-0006).
			rows, err := tx.Query(ctx,
				`SELECT t.id, t.vehicle_id, v.fleet_number, t.due_at, t.state::text, t.overdue
				   FROM app.v_my_inspection_task t
				   JOIN app.vehicle v ON v.id = t.vehicle_id
				  ORDER BY t.due_at`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var t taskJSON
				var due time.Time
				if err := rows.Scan(&t.ID, &t.VehicleID, &t.FleetNumber, &due, &t.State, &t.Overdue); err != nil {
					return err
				}
				t.DueAt = due.UTC().Format(time.RFC3339)
				tasks = append(tasks, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, tasks)
	}
}

type scheduleTaskRequest struct {
	// Omitted means the tenant's today, resolved by app.create_inspection_task
	// in the tenant's own zone; a Go clock's today is the runner's day, not
	// the fleet's (rule 6, lessons 2026-09-03).
	DueOn *string `json:"dueOn"`
	// Absent or null is no nominee: the task goes to whoever holds the unit,
	// or reads escalated (FR-INS-051 as amended).
	NomineeUserID *string `json:"nomineeUserId"`
}

// scheduleInspectionTask is FR-INS-051's write. The task it answers with is
// read back through loadUnitTasks rather than assembled from the request, so
// the caller sees the row as stored: the due instant the tenant's zone
// resolved, overdue as the view computes it, and who holds it.
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
		var nominee *uuid.UUID
		if body.NomineeUserID != nil {
			id, err := uuidField("nomineeUserId", *body.NomineeUserID)
			if refuseInvalid(w, r, err) {
				return
			}
			nominee = &id
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
			if err := lockUnitInScope(ctx, tx, a, vehicleID, "no such unit in this fleet"); err != nil {
				return err
			}
			if nominee != nil {
				if err := refuseNonCapturer(ctx, tx, "nomineeUserId", *nominee); err != nil {
					return err
				}
			}
			var taskID uuid.UUID
			if err := tx.QueryRow(ctx,
				`SELECT app.create_inspection_task($1, $2::date, $3::uuid)`,
				vehicleID, dueOn, nominee).Scan(&taskID); err != nil {
				return fmt.Errorf("scheduling inspection on unit %s: %w", vehicleID, err)
			}
			created, err := loadTask(ctx, tx, taskID)
			if err != nil {
				return err
			}
			task = created
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, task)
	}
}

type nominationRequest struct {
	UserID string `json:"userId"`
}

// nominateForTask names a driver for an outstanding task, the later route by
// which a "no driver" row gets one (FR-INS-051 as amended). Every rule is
// app.nominate_for_task's. Depot scope is the task's unit's: a depot actor's
// task elsewhere answers 404, and a tenant actor's unknown task is left to
// the function's TY012 (ADR-0011).
func nominateForTask(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		taskID, ok := pathID(w, r, "taskID")
		if !ok {
			return
		}
		var body nominationRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		userID, err := uuidField("userId", body.UserID)
		if refuseInvalid(w, r, err) {
			return
		}
		const notFound = "no such inspection task in this fleet"
		var task unitTaskJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			if a.Scope() != auth.ScopeTenant {
				var vehicleID uuid.UUID
				err := tx.QueryRow(ctx,
					`SELECT vehicle_id FROM app.inspection_task WHERE id = $1`, taskID).Scan(&vehicleID)
				if errors.Is(err, pgx.ErrNoRows) {
					return refusalError{refusal{status: http.StatusNotFound, code: codeNotFound, message: notFound}}
				}
				if err != nil {
					return fmt.Errorf("resolving task %s: %w", taskID, err)
				}
				if err := lockUnitInScope(ctx, tx, a, vehicleID, notFound); err != nil {
					return err
				}
			}
			if err := refuseNonCapturer(ctx, tx, "userId", userID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT app.nominate_for_task($1, $2)`, taskID, userID); err != nil {
				return fmt.Errorf("nominating for task %s: %w", taskID, err)
			}
			read, err := loadTask(ctx, tx, taskID)
			if err != nil {
				return err
			}
			task = read
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, task)
	}
}

// loadTask reads one task back through loadUnitTasks, as combinationByID does
// for rigs, so a write answers with the row as stored.
func loadTask(ctx context.Context, tx pgx.Tx, taskID uuid.UUID) (unitTaskJSON, error) {
	rows, err := loadUnitTasks(ctx, tx, nil, &taskID)
	if err != nil {
		return unitTaskJSON{}, fmt.Errorf("reading back task %s: %w", taskID, err)
	}
	if len(rows) != 1 {
		return unitTaskJSON{}, fmt.Errorf("reading back task %s: %d rows", taskID, len(rows))
	}
	return rows[0], nil
}
