// The rig surface (TYRE-72): a controller sets a dated combination — one
// motive unit and its towed units in walk order — and ends one. What may be
// coupled to what, which day a rig may start on, and that a unit is in at most
// one open rig are app.create_combination's and app.end_combination's alone
// (000037); this file validates shape, gates the capability and projects the
// row (ADR-0013 decision 5). It decides nothing about rigs.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// combinationMemberJSON is one unit in the rig. UnitKind is nullable because
// app.vehicle.unit_kind still is for the rows 000011's backfill could not
// derive; a rig created through this surface never contains one, since
// app.create_combination refuses a unit without a kind.
type combinationMemberJSON struct {
	VehicleID   string  `json:"vehicleId"`
	FleetNumber string  `json:"fleetNumber"`
	Sequence    int     `json:"sequence"`
	Descriptor  *string `json:"descriptor"`
	UnitKind    *string `json:"unitKind"`
}

type combinationJSON struct {
	ID                string                  `json:"id"`
	MotiveVehicleID   string                  `json:"motiveVehicleId"`
	MotiveFleetNumber string                  `json:"motiveFleetNumber"`
	EffectiveFrom     string                  `json:"effectiveFrom"`
	EffectiveTo       *string                 `json:"effectiveTo"`
	Members           []combinationMemberJSON `json:"members"`
}

type towedRequest struct {
	VehicleID  string  `json:"vehicleId"`
	Descriptor *string `json:"descriptor"`
}

type createCombinationRequest struct {
	MotiveVehicleID string         `json:"motiveVehicleId"`
	Towed           []towedRequest `json:"towed"`
	// Omitted means the tenant's today, resolved by app.tenant_day_instant
	// (000037); a Go clock's today is the runner's day, not the fleet's
	// (rule 6, lessons 2026-09-03).
	EffectiveOn *string `json:"effectiveOn"`
}

type endCombinationRequest struct {
	EndedOn *string `json:"endedOn"`
}

// loadCombinations answers the rigs the session's tenant can see, in D3's
// order: open first, then most recently started. Both filters are bound
// parameters rather than SQL assembled per call — a nil id is every rig, and
// openOnly narrows to the open ones — so there is one statement to read and no
// string ever reaches the planner from a request.
//
// Two round trips, never one per rig: the members of every rig just read come
// back in a second query and are folded in by combination id.
func loadCombinations(ctx context.Context, tx pgx.Tx, id *uuid.UUID, openOnly bool) ([]combinationJSON, error) {
	// Same reasoning as listAxleConfigurations (admin.go): initialised, not
	// nil, so writeJSON never answers `null` for an empty list.
	rigs := []combinationJSON{}
	ids := []uuid.UUID{}
	at := map[uuid.UUID]int{}

	rows, err := tx.Query(ctx, `
		SELECT c.id, c.motive_vehicle_id, mv.fleet_number, c.effective_from, c.effective_to
		  FROM app.combination c
		  JOIN app.vehicle mv ON mv.id = c.motive_vehicle_id
		 WHERE ($1::uuid IS NULL OR c.id = $1)
		   AND (NOT $2::boolean OR c.effective_to IS NULL)
		 ORDER BY c.effective_to IS NULL DESC, c.effective_from DESC`, id, openOnly)
	if err != nil {
		return nil, fmt.Errorf("listing rigs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var rig combinationJSON
		var rigID uuid.UUID
		var from time.Time
		var to *time.Time
		if err := rows.Scan(&rigID, &rig.MotiveVehicleID, &rig.MotiveFleetNumber, &from, &to); err != nil {
			return nil, fmt.Errorf("scanning rig: %w", err)
		}
		rig.ID = rigID.String()
		rig.EffectiveFrom = from.UTC().Format(time.RFC3339)
		if to != nil {
			ended := to.UTC().Format(time.RFC3339)
			rig.EffectiveTo = &ended
		}
		rig.Members = []combinationMemberJSON{}
		at[rigID] = len(rigs)
		ids = append(ids, rigID)
		rigs = append(rigs, rig)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading rigs: %w", err)
	}
	if len(ids) == 0 {
		return rigs, nil
	}

	mrows, err := tx.Query(ctx, `
		SELECT cm.combination_id, cm.vehicle_id, v.fleet_number, cm.sequence,
		       cm.descriptor, v.unit_kind::text
		  FROM app.combination_member cm
		  JOIN app.vehicle v ON v.id = cm.vehicle_id
		 WHERE cm.combination_id = ANY($1)
		 ORDER BY cm.combination_id, cm.sequence`, ids)
	if err != nil {
		return nil, fmt.Errorf("listing rig members: %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var rigID uuid.UUID
		var m combinationMemberJSON
		if err := mrows.Scan(&rigID, &m.VehicleID, &m.FleetNumber, &m.Sequence,
			&m.Descriptor, &m.UnitKind); err != nil {
			return nil, fmt.Errorf("scanning rig member: %w", err)
		}
		i, found := at[rigID]
		if !found {
			continue
		}
		rigs[i].Members = append(rigs[i].Members, m)
	}
	if err := mrows.Err(); err != nil {
		return nil, fmt.Errorf("reading rig members: %w", err)
	}
	return rigs, nil
}

// combinationByID is the projection both writes answer with, shared with the
// list so one shape has one implementation. pgx.ErrNoRows for a rig the
// session cannot see, which is what a caller that just wrote one never meets.
func combinationByID(ctx context.Context, tx pgx.Tx, id uuid.UUID) (combinationJSON, error) {
	rigs, err := loadCombinations(ctx, tx, &id, false)
	if err != nil {
		return combinationJSON{}, err
	}
	if len(rigs) == 0 {
		return combinationJSON{}, pgx.ErrNoRows
	}
	return rigs[0], nil
}

// listCombinations is the register the Rigs screen reads (D3). ?open=true is
// the only narrowing: an ended rig is history a controller still needs, so the
// default is everything.
func listCombinations(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		openOnly := r.URL.Query().Get("open") == "true"
		rigs := []combinationJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			loaded, err := loadCombinations(ctx, tx, nil, openOnly)
			if err != nil {
				return err
			}
			rigs = loaded
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, rigs)
	}
}

// payload builds app.create_combination's jsonb argument, translating the
// wire's camelCase to the snake_case keys 000037 reads. An absent towed key is
// refused here rather than sent as an empty array: "a rig has at least one
// towed unit" is the function's rule (U10) and it is not restated, but "the
// request said nothing about what is being towed" is a shape problem this side
// owns, and a form needs the field named.
func (b createCombinationRequest) payload() ([]map[string]any, error) {
	if b.Towed == nil {
		return nil, invalid("towed", "is required")
	}
	towed := make([]map[string]any, 0, len(b.Towed))
	for i, t := range b.Towed {
		vehicleID, err := uuidField(fmt.Sprintf("towed[%d].vehicleId", i), t.VehicleID)
		if err != nil {
			return nil, err
		}
		descriptor, err := text(fmt.Sprintf("towed[%d].descriptor", i), t.Descriptor)
		if err != nil {
			return nil, err
		}
		towed = append(towed, map[string]any{
			"vehicle_id": vehicleID.String(),
			"descriptor": descriptor,
		})
	}
	return towed, nil
}

// createCombination is FR-VEH-030's write. The rig it answers with is read
// back through combinationByID rather than assembled from the request, so the
// caller sees the row as stored — including the start instant the tenant's own
// zone resolved and the member sequence the function assigned.
func createCombination(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body createCombinationRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		motive, err := uuidField("motiveVehicleId", body.MotiveVehicleID)
		if refuseInvalid(w, r, err) {
			return
		}
		towed, err := body.payload()
		if refuseInvalid(w, r, err) {
			return
		}
		effectiveOn, err := dateField("effectiveOn", body.EffectiveOn)
		if refuseInvalid(w, r, err) {
			return
		}
		raw, err := json.Marshal(towed)
		if err != nil {
			// Unreachable in practice — every value above is a string or nil —
			// but a handler never panics (api/CLAUDE.md).
			slog.ErrorContext(ctx, "marshalling rig payload", "err", err)
			writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
			return
		}

		var rig combinationJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			// tenant_id is never bound here: app.create_combination reads it
			// from app.current_tenant_id() inside this session's transaction
			// (rule 1, ADR-0013 decision 2). TY012 and TY017 arrive through
			// refusalForPgError with their messages intact.
			var rigID uuid.UUID
			if err := tx.QueryRow(ctx,
				`SELECT app.create_combination($1, $2::jsonb, $3::date)`,
				motive, raw, effectiveOn).Scan(&rigID); err != nil {
				return fmt.Errorf("creating rig headed by unit %s: %w", motive, err)
			}
			created, err := combinationByID(ctx, tx, rigID)
			if err != nil {
				return fmt.Errorf("reading back rig %s: %w", rigID, err)
			}
			rig = created
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, rig)
	}
}

// endCombination closes a rig (D4). It answers 200 with the rig rather than
// 204 because the end instant is the tenant's own zone's, resolved in SQL, and
// the screen has nowhere else to read it. A rig already ended, an end before
// the start and a rig this tenant cannot see are all app.end_combination's
// refusals.
func endCombination(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		rigID, ok := pathID(w, r, "combinationID")
		if !ok {
			return
		}
		var body endCombinationRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		endedOn, err := dateField("endedOn", body.EndedOn)
		if refuseInvalid(w, r, err) {
			return
		}

		var rig combinationJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`SELECT app.end_combination($1, $2::date)`, rigID, endedOn); err != nil {
				return fmt.Errorf("ending rig %s: %w", rigID, err)
			}
			ended, err := combinationByID(ctx, tx, rigID)
			if err != nil {
				return fmt.Errorf("reading back rig %s: %w", rigID, err)
			}
			rig = ended
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, rig)
	}
}
