// The reconciliation surface (TYRE-75): a controller reads the FR-INS-063
// reports no one has acted on, and turns one into a dated rig change or
// dismisses it with a reason. What may be applied, at what instant, and what
// makes a report stale are app.apply_composition_observation's and
// app.dismiss_composition_observation's alone (000044); this file gates the
// capability, narrows by depot and projects the row (ADR-0013 decision 5).
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

// The report's own shape rather than combinationJSON's: this screen needs
// fleet numbers and nothing else about a member, and a shared response struct
// widened for one consumer is what the batch's design rules out.
type observationDriverJSON struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type observationRigJSON struct {
	ID                string   `json:"id"`
	MotiveFleetNumber string   `json:"motiveFleetNumber"`
	Members           []string `json:"members"`
}

type observationJSON struct {
	// The warning's id: a report is identified by the row that raised it,
	// because until it is resolved no other row exists to name it.
	ID           string                `json:"id"`
	InspectionID string                `json:"inspectionId"`
	StartedAt    string                `json:"startedAt"`
	SubmittedAt  string                `json:"submittedAt"`
	Driver       observationDriverJSON `json:"driver"`
	Rig          observationRigJSON    `json:"rig"`
	Observed     []string              `json:"observed"`
	Removed      []string              `json:"removed"`
	// The offered rig has ended, so applying can only be refused
	// (app.apply_composition_observation answers TY022 "stale"). Sent so the
	// screen can offer Dismiss alone rather than a button that always fails.
	Stale bool `json:"stale"`
}

type observationNoteRequest struct {
	Note *string `json:"note"`
}

// listObservations is D5's "Reported differences": every FR-INS-063 warning
// on a capture that still stands, whose motive unit this actor can see, that
// nobody has resolved. Newest capture first — a controller works the fresh
// reports and dismisses the old ones.
//
// One statement. The observed set is the raw JSON array 000041 stored, and the
// removed set is the offered membership minus it; both are resolved to fleet
// numbers in SQL rather than folded in Go, because a second round trip would
// buy nothing here: neither list is a shared shape any other handler reads.
func listObservations(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil — see listAxleConfigurations (admin.go).
		out := []observationJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT w.id, i.id, i.started_at, i.submitted_at,
				       u.id, u.display_name,
				       c.id, mv.fleet_number,
				       (SELECT coalesce(array_agg(v.fleet_number ORDER BY cm.sequence), '{}')
				          FROM app.combination_member cm
				          JOIN app.vehicle v ON v.id = cm.vehicle_id
				         WHERE cm.combination_id = c.id),
				       -- LEFT JOIN, as app.apply_composition_observation reads the
				       -- same array: an id that names no visible unit is shown as
				       -- its id, never dropped, so the card and the refusal agree.
				       --
				       -- Both sets below are NULL-safe on an element the register
				       -- cannot name. 000041 stores the phone's array as the raw
				       -- payload text and casts each element ::uuid, so a JSON
				       -- null survives as a NULL id in a warning raised for it;
				       -- FILTER drops it from the display set and NOT EXISTS keeps
				       -- the removed set from collapsing to NULL. Rendered rather
				       -- than skipped: a warning is never updated or deleted, and
				       -- a row this list withholds is a report no controller can
				       -- reach to dismiss (TYRE-75).
				       (SELECT coalesce(array_agg(coalesce(v.fleet_number, o.id) ORDER BY coalesce(v.fleet_number, o.id))
				                        FILTER (WHERE o.id IS NOT NULL), '{}')
				          FROM jsonb_array_elements_text(w.entered_value::jsonb) o(id)
				          LEFT JOIN app.vehicle v ON v.id = o.id::uuid),
				       (SELECT coalesce(array_agg(v.fleet_number ORDER BY cm.sequence), '{}')
				          FROM app.combination_member cm
				          JOIN app.vehicle v ON v.id = cm.vehicle_id
				         WHERE cm.combination_id = c.id
				           AND NOT EXISTS (
				                 SELECT 1 FROM jsonb_array_elements_text(w.entered_value::jsonb) e
				                  WHERE e = cm.vehicle_id::text)),
				       c.effective_to IS NOT NULL
				  FROM app.inspection_warning w
				  JOIN app.inspection i  ON i.id = w.inspection_id
				  JOIN app.combination c ON c.id = i.combination_id
				  JOIN app.vehicle mv    ON mv.id = c.motive_vehicle_id
				  JOIN app.app_user u    ON u.id = i.user_id
				 WHERE w.warning_code = 'FR-INS-063'
				   AND i.state <> 'VOIDED'
				   AND NOT EXISTS (SELECT 1 FROM app.composition_observation o
				                    WHERE o.warning_id = w.id)
				   AND EXISTS (SELECT 1 FROM `+unitSource(a)+` v WHERE v.id = i.vehicle_id)
				 ORDER BY i.started_at DESC`)
			if err != nil {
				return fmt.Errorf("listing composition reports: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var o observationJSON
				var started, submitted time.Time
				if err := rows.Scan(&o.ID, &o.InspectionID, &started, &submitted,
					&o.Driver.ID, &o.Driver.DisplayName,
					&o.Rig.ID, &o.Rig.MotiveFleetNumber, &o.Rig.Members,
					&o.Observed, &o.Removed, &o.Stale); err != nil {
					return fmt.Errorf("scanning composition report: %w", err)
				}
				o.StartedAt = started.UTC().Format(time.RFC3339)
				o.SubmittedAt = submitted.UTC().Format(time.RFC3339)
				out = append(out, o)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// reachableObservation is FR-AUT-008's narrowing for the two writes. A rig is
// homed where its horse is, so the report is reachable when the inspection's
// motive unit is (ledger ruling, 7 Sep 2026). A ScopeTenant actor skips it and
// meets the function's own TY012, so the controller's contract is unchanged.
// The vehicle row is locked because the resolution runs in a separate
// statement: a concurrent PATCH moving the unit to another depot waits on this
// lock, and one that committed first is what the check sees, so the scope the
// write was authorised against is the scope it lands in (setUnitStatus's
// reasoning, units.go).
func reachableObservation(ctx context.Context, tx pgx.Tx, a auth.Actor, warningID uuid.UUID) error {
	if a.Scope() == auth.ScopeTenant {
		return nil
	}
	var locked uuid.UUID
	err := tx.QueryRow(ctx,
		`SELECT v.id
		   FROM app.inspection_warning w
		   JOIN app.inspection i ON i.id = w.inspection_id
		   JOIN app.vehicle v    ON v.id = i.vehicle_id
		  WHERE w.id = $1
		    AND EXISTS (SELECT 1 FROM `+unitSource(a)+` s WHERE s.id = v.id)
		  FOR UPDATE OF v`, warningID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return refusalError{refusal{
			status:  http.StatusNotFound,
			code:    codeNotFound,
			message: "no such report in this fleet",
		}}
	}
	if err != nil {
		return fmt.Errorf("resolving composition report %s: %w", warningID, err)
	}
	return nil
}

type applyObservationResponse struct {
	// Null when the observed set was the motive alone: the rig ends and none
	// opens (U10 declines a one-member rig). The client invalidates its rig
	// list either way.
	ResultingRigID *string `json:"resultingRigId"`
}

// applyObservation turns the report into the dated composition change
// app.apply_composition_observation writes. 200 rather than 201: the resource
// the caller named is the report, and what it answers with is the outcome.
func applyObservation(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		warningID, ok := pathID(w, r, "observationID")
		if !ok {
			return
		}
		var body observationNoteRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		note, err := text("note", body.Note)
		if refuseInvalid(w, r, err) {
			return
		}

		var out applyObservationResponse
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			if err := reachableObservation(ctx, tx, a, warningID); err != nil {
				return err
			}
			// TY012 and TY022 arrive through refusalForPgError with their
			// messages intact; each names what the controller must do next,
			// which is the whole reason those sentences are written in SQL.
			var rigID *uuid.UUID
			if err := tx.QueryRow(ctx,
				`SELECT app.apply_composition_observation($1, $2)`,
				warningID, note).Scan(&rigID); err != nil {
				return fmt.Errorf("applying composition report %s: %w", warningID, err)
			}
			if rigID != nil {
				id := rigID.String()
				out.ResultingRigID = &id
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// dismissObservation records the other answer. 204: the note is the caller's
// own text and the report simply leaves the list, so there is nothing to
// project back.
func dismissObservation(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		warningID, ok := pathID(w, r, "observationID")
		if !ok {
			return
		}
		var body observationNoteRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		// The note is required, and that rule is the function's: a blank one
		// answers TY022 "a dismissal carries a reason", which is the sentence
		// the screen renders. text() only bounds and trims it.
		note, err := text("note", body.Note)
		if refuseInvalid(w, r, err) {
			return
		}

		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			if err := reachableObservation(ctx, tx, a, warningID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`SELECT app.dismiss_composition_observation($1, $2)`,
				warningID, note); err != nil {
				return fmt.Errorf("dismissing composition report %s: %w", warningID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
