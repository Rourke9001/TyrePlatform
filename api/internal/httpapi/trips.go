// The trip (TYRE-326): a controller puts a driver on a motive unit at now,
// adding free trailers, and ends the trip; a driver reads their own. What
// may go on a trip, which trailers may be added, what a start closes and
// when a due inspection holds the start are app.start_trip's,
// app.end_trip's and app.trip_start_blockers' alone (000060). This file
// validates shape, gates the capability, applies depot scope and projects
// rows (ADR-0013 decision 5). It decides nothing about trips.
package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

type tripUnitJSON struct {
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
}

type tripPersonJSON struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
}

// tripJSON's trailers are the motive's open rig now, after the motive, in
// sequence: a rig ended and reopened mid-trip is read as it stands, never
// through trip.combination_id (spec, The trip).
type tripJSON struct {
	ID        string          `json:"id"`
	Motive    tripUnitJSON    `json:"motive"`
	Driver    tripPersonJSON  `json:"driver"`
	StartedAt string          `json:"startedAt"`
	StartedBy *tripPersonJSON `json:"startedBy"`
	EndedAt   *string         `json:"endedAt"`
	Trailers  []tripUnitJSON  `json:"trailers"`
}

// unitTripJSON is one unit's panel: a motive's open trip; a towed trailer's
// motive and that motive's open trip; nothing for a free trailer.
type unitTripJSON struct {
	Trip     *tripJSON     `json:"trip"`
	PulledBy *tripUnitJSON `json:"pulledBy"`
}

type driverJSON struct {
	UserID      string        `json:"userId"`
	DisplayName string        `json:"displayName"`
	StaffNumber *string       `json:"staffNumber"`
	OnTrip      *tripUnitJSON `json:"onTrip"`
}

type startTripRequest struct {
	MotiveVehicleID string `json:"motiveVehicleId"`
	DriverUserID    string `json:"driverUserId"`
	// Absent is none.
	AddTrailers []string `json:"addTrailers"`
}

// tripBlockerJSON is one task that holds a start (U148). dueAt is the
// instant, which the web renders as a day in the tenant's zone (rule 6).
type tripBlockerJSON struct {
	TaskID      string `json:"taskId"`
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
	DueAt       string `json:"dueAt"`
}

// loadTrips answers the trips the session's tenant can see, newest first.
// Every filter is a bound parameter, so a nil one is every trip and there is
// one statement to read. Two round trips, never one per trip, as
// loadCombinations does: the trailers of every motive just read come back in
// a second query and are folded in by motive.
func loadTrips(ctx context.Context, tx pgx.Tx, tripID, motiveID, userID *uuid.UUID, openOnly bool) ([]tripJSON, error) {
	trips := []tripJSON{}
	motives := []uuid.UUID{}
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.vehicle_id, mv.fleet_number, t.user_id, u.display_name,
		       t.started_at, t.started_by, sb.display_name, t.ended_at
		  FROM app.trip t
		  JOIN app.vehicle mv ON mv.id = t.vehicle_id
		  JOIN app.app_user u ON u.id = t.user_id
		  LEFT JOIN app.app_user sb ON sb.id = t.started_by
		 WHERE ($1::uuid IS NULL OR t.id = $1)
		   AND ($2::uuid IS NULL OR t.vehicle_id = $2)
		   AND ($3::uuid IS NULL OR t.user_id = $3)
		   AND (NOT $4::boolean OR t.ended_at IS NULL)
		 ORDER BY t.started_at DESC, t.id`, tripID, motiveID, userID, openOnly)
	if err != nil {
		return nil, fmt.Errorf("listing trips: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			trip               tripJSON
			id, motive, driver uuid.UUID
			started            time.Time
			startedBy          *uuid.UUID
			startedByName      *string
			ended              *time.Time
		)
		if err := rows.Scan(&id, &motive, &trip.Motive.FleetNumber, &driver, &trip.Driver.DisplayName,
			&started, &startedBy, &startedByName, &ended); err != nil {
			return nil, fmt.Errorf("scanning trip: %w", err)
		}
		trip.ID = id.String()
		trip.Motive.VehicleID = motive.String()
		trip.Driver.UserID = driver.String()
		trip.StartedAt = started.UTC().Format(time.RFC3339)
		if startedBy != nil && startedByName != nil {
			trip.StartedBy = &tripPersonJSON{UserID: startedBy.String(), DisplayName: *startedByName}
		}
		if ended != nil {
			at := ended.UTC().Format(time.RFC3339)
			trip.EndedAt = &at
		}
		trip.Trailers = []tripUnitJSON{}
		trips = append(trips, trip)
		motives = append(motives, motive)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading trips: %w", err)
	}
	if len(trips) == 0 {
		return trips, nil
	}

	trows, err := tx.Query(ctx, `
		SELECT c.motive_vehicle_id, cm.vehicle_id, v.fleet_number
		  FROM app.combination c
		  JOIN app.combination_member cm ON cm.combination_id = c.id
		  JOIN app.vehicle v ON v.id = cm.vehicle_id
		 WHERE c.motive_vehicle_id = ANY($1) AND c.effective_to IS NULL
		   AND cm.vehicle_id <> c.motive_vehicle_id
		 ORDER BY c.motive_vehicle_id, cm.sequence`, motives)
	if err != nil {
		return nil, fmt.Errorf("listing trip trailers: %w", err)
	}
	defer trows.Close()
	towed := map[string][]tripUnitJSON{}
	for trows.Next() {
		var motive uuid.UUID
		var unit tripUnitJSON
		if err := trows.Scan(&motive, &unit.VehicleID, &unit.FleetNumber); err != nil {
			return nil, fmt.Errorf("scanning trip trailer: %w", err)
		}
		towed[motive.String()] = append(towed[motive.String()], unit)
	}
	if err := trows.Err(); err != nil {
		return nil, fmt.Errorf("reading trip trailers: %w", err)
	}
	for i := range trips {
		if units, found := towed[trips[i].Motive.VehicleID]; found {
			trips[i].Trailers = units
		}
	}
	return trips, nil
}

func tripByID(ctx context.Context, tx pgx.Tx, id uuid.UUID) (tripJSON, error) {
	trips, err := loadTrips(ctx, tx, &id, nil, nil, false)
	if err != nil {
		return tripJSON{}, err
	}
	if len(trips) != 1 {
		return tripJSON{}, fmt.Errorf("reading back trip %s: %d rows", id, len(trips))
	}
	return trips[0], nil
}

// getUnitTrip is the unit screen's trip panel, read by every ViewFleet role
// (spec, Trip screens). A unit outside the actor's depots is 404, as every
// by-id unit route answers it (ADR-0006). The motive pulling a trailer is
// read whatever its depot, since the trailer's panel names it (U149).
func getUnitTrip(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		var out unitTripJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			if err := checkUnitInScope(ctx, tx, a, vehicleID, "no such unit in this fleet"); err != nil {
				return err
			}
			holder := vehicleID
			var pulledBy tripUnitJSON
			var motive uuid.UUID
			err := tx.QueryRow(ctx, `
				SELECT c.motive_vehicle_id, mv.fleet_number
				  FROM app.combination_member cm
				  JOIN app.combination c ON c.id = cm.combination_id
				  JOIN app.vehicle mv ON mv.id = c.motive_vehicle_id
				 WHERE cm.vehicle_id = $1 AND cm.vehicle_id <> c.motive_vehicle_id
				   AND c.effective_to IS NULL`, vehicleID).Scan(&motive, &pulledBy.FleetNumber)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
			case err != nil:
				return fmt.Errorf("reading the rig pulling unit %s: %w", vehicleID, err)
			default:
				pulledBy.VehicleID = motive.String()
				out.PulledBy = &pulledBy
				holder = motive
			}
			trips, err := loadTrips(ctx, tx, nil, &holder, nil, true)
			if err != nil {
				return err
			}
			if len(trips) > 0 {
				out.Trip = &trips[0]
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// listDrivers is the driver picker: every active user whose role holds
// CaptureInspection, each with the truck of their open trip, so the
// controller sees what a start will close. It is not narrowed by depot
// (spec, Depot scope), and the capability map lives in Go (auth.go).
func listDrivers(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		drivers := []driverJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT u.id, u.display_name, u.staff_number, u.role::text, t.vehicle_id, v.fleet_number
				  FROM app.app_user u
				  LEFT JOIN app.trip t ON t.user_id = u.id AND t.ended_at IS NULL
				  LEFT JOIN app.vehicle v ON v.id = t.vehicle_id
				 WHERE u.active
				 ORDER BY u.display_name, u.id`)
			if err != nil {
				return fmt.Errorf("listing drivers: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var (
					d       driverJSON
					id      uuid.UUID
					role    string
					motive  *uuid.UUID
					onFleet *string
				)
				if err := rows.Scan(&id, &d.DisplayName, &d.StaffNumber, &role, &motive, &onFleet); err != nil {
					return fmt.Errorf("scanning driver: %w", err)
				}
				if !auth.Holds(auth.Role(role), auth.CaptureInspection) {
					continue
				}
				d.UserID = id.String()
				if motive != nil && onFleet != nil {
					d.OnTrip = &tripUnitJSON{VehicleID: motive.String(), FleetNumber: *onFleet}
				}
				drivers = append(drivers, d)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, drivers)
	}
}

// getMyTrip is the driver's own open trip, or null (FR-DSH-012 as amended).
func getMyTrip(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var out struct {
			Trip *tripJSON `json:"trip"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			trips, err := loadTrips(ctx, tx, nil, nil, &a.UserID, true)
			if err != nil {
				return err
			}
			if len(trips) > 0 {
				out.Trip = &trips[0]
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// startTrip is FR-VEH-007's start. Depot scope is the motive's, and the
// added trailers are judged through it (spec, Depot scope). app.start_trip
// reaches create_combination_at, which locks every member FOR UPDATE in id
// order, so no unit lock is taken ahead of it (reachableObservation,
// observations.go, records the 40P01 that order risks). The scope is
// checked before the write, so an out-of-depot motive answers 404 before
// any rule speaks, and again after it under the locks the write took, so the
// scope authorised is the scope the write landed in. A start ends the
// driver's open trip elsewhere, so that trip's truck must be in scope too.
func startTrip(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body startTripRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		motive, err := uuidField("motiveVehicleId", body.MotiveVehicleID)
		if refuseInvalid(w, r, err) {
			return
		}
		driver, err := uuidField("driverUserId", body.DriverUserID)
		if refuseInvalid(w, r, err) {
			return
		}
		trailers := make([]uuid.UUID, 0, len(body.AddTrailers))
		for i, raw := range body.AddTrailers {
			id, err := uuidField(fmt.Sprintf("addTrailers[%d]", i), raw)
			if refuseInvalid(w, r, err) {
				return
			}
			trailers = append(trailers, id)
		}

		var trip tripJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			const notFound = "no such unit in this fleet"
			if a.Scope() != auth.ScopeTenant {
				if err := checkUnitInScope(ctx, tx, a, motive, notFound); err != nil {
					return err
				}
			}
			if err := refuseDriverTripOutOfScope(ctx, tx, a, driver); err != nil {
				return err
			}
			if err := refuseNonCapturer(ctx, tx, "driverUserId", driver); err != nil {
				return err
			}
			var tripID uuid.UUID
			if err := tx.QueryRow(ctx, `SELECT app.start_trip($1, $2, $3::uuid[])`,
				motive, driver, trailers).Scan(&tripID); err != nil {
				return fmt.Errorf("starting a trip on unit %s: %w", motive, err)
			}
			if a.Scope() != auth.ScopeTenant {
				if err := checkUnitInScope(ctx, tx, a, motive, notFound); err != nil {
					return err
				}
				if err := refuseEndedTripsOutOfScope(ctx, tx, a); err != nil {
					return err
				}
			}
			read, err := tripByID(ctx, tx, tripID)
			if err != nil {
				return err
			}
			trip = read
			return nil
		})
		if !ok {
			return
		}
		writeStatus(ctx, w, http.StatusCreated, trip)
	}
}

// refuseDriverTripOutOfScope refuses a depot-scoped start whose driver's open
// trip is on a truck outside the actor's depots: the start would end it.
func refuseDriverTripOutOfScope(ctx context.Context, tx pgx.Tx, a auth.Actor, driver uuid.UUID) error {
	if a.Scope() == auth.ScopeTenant {
		return nil
	}
	var motive uuid.UUID
	var fleet string
	err := tx.QueryRow(ctx, `
		SELECT t.vehicle_id, v.fleet_number FROM app.trip t JOIN app.vehicle v ON v.id = t.vehicle_id
		 WHERE t.user_id = $1 AND t.ended_at IS NULL`, driver).Scan(&motive, &fleet)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading the open trip of user %s: %w", driver, err)
	}
	return refuseOutOfScopeTrip(ctx, tx, a, motive, fleet)
}

// refuseEndedTripsOutOfScope re-checks, under the start's locks, every trip
// this start ended.
func refuseEndedTripsOutOfScope(ctx context.Context, tx pgx.Tx, a auth.Actor) error {
	rows, err := tx.Query(ctx, `
		SELECT t.vehicle_id, v.fleet_number FROM app.trip t JOIN app.vehicle v ON v.id = t.vehicle_id
		 WHERE t.ended_at = now() AND t.ended_by = app.current_actor_id()`)
	if err != nil {
		return fmt.Errorf("reading the trips the start ended: %w", err)
	}
	type ended struct {
		motive uuid.UUID
		fleet  string
	}
	var all []ended
	for rows.Next() {
		var e ended
		if err := rows.Scan(&e.motive, &e.fleet); err != nil {
			rows.Close()
			return fmt.Errorf("scanning an ended trip: %w", err)
		}
		all = append(all, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading the trips the start ended: %w", err)
	}
	for _, e := range all {
		if err := refuseOutOfScopeTrip(ctx, tx, a, e.motive, e.fleet); err != nil {
			return err
		}
	}
	return nil
}

func refuseOutOfScopeTrip(ctx context.Context, tx pgx.Tx, a auth.Actor, motive uuid.UUID, fleet string) error {
	in, err := unitInScope(ctx, tx, a, motive)
	if err != nil {
		return err
	}
	if in {
		return nil
	}
	return refusalError{refusal{
		status:  http.StatusUnprocessableEntity,
		code:    codeInvalidSubmission,
		message: "driverUserId is on the trip with " + fleet + ", outside your depots; end it there first",
	}}
}

// endTrip is FR-VEH-007's end. It answers 200 with the trip, since the end
// instant is the server's and the panel has nowhere else to read it. Depot
// scope is the trip's motive's, held FOR SHARE (lockUnitInScope).
func endTrip(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tripID, ok := pathID(w, r, "tripID")
		if !ok {
			return
		}
		var trip tripJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			const notFound = "no such trip in this fleet"
			if a.Scope() != auth.ScopeTenant {
				var motive uuid.UUID
				err := tx.QueryRow(ctx, `SELECT vehicle_id FROM app.trip WHERE id = $1`, tripID).Scan(&motive)
				if errors.Is(err, pgx.ErrNoRows) {
					return refusalError{refusal{status: http.StatusNotFound, code: codeNotFound, message: notFound}}
				}
				if err != nil {
					return fmt.Errorf("resolving trip %s: %w", tripID, err)
				}
				if err := lockUnitInScope(ctx, tx, a, motive, notFound); err != nil {
					return err
				}
			}
			if _, err := tx.Exec(ctx, `SELECT app.end_trip($1)`, tripID); err != nil {
				return fmt.Errorf("ending trip %s: %w", tripID, err)
			}
			read, err := tripByID(ctx, tx, tripID)
			if err != nil {
				return err
			}
			trip = read
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, trip)
	}
}

// listTripBlockers relays app.trip_start_blockers, so the start form names
// each task that holds a start before the controller taps Start (U148). It
// has no rule of its own.
func listTripBlockers(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		trailers := []uuid.UUID{}
		if raw := strings.TrimSpace(r.URL.Query().Get("addTrailers")); raw != "" {
			for i, part := range strings.Split(raw, ",") {
				id, err := uuidField(fmt.Sprintf("addTrailers[%d]", i), strings.TrimSpace(part))
				if refuseInvalid(w, r, err) {
					return
				}
				trailers = append(trailers, id)
			}
		}
		blockers := []tripBlockerJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			if err := checkUnitInScope(ctx, tx, a, vehicleID, "no such unit in this fleet"); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT task_id, vehicle_id, fleet_number, due_at
				  FROM app.trip_start_blockers($1, $2::uuid[])
				 ORDER BY walk_order, due_on`, vehicleID, trailers)
			if err != nil {
				return fmt.Errorf("listing what holds a trip on unit %s: %w", vehicleID, err)
			}
			defer rows.Close()
			for rows.Next() {
				var b tripBlockerJSON
				var task, unit uuid.UUID
				var due time.Time
				if err := rows.Scan(&task, &unit, &b.FleetNumber, &due); err != nil {
					return fmt.Errorf("scanning a trip blocker: %w", err)
				}
				b.TaskID = task.String()
				b.VehicleID = unit.String()
				b.DueAt = due.UTC().Format(time.RFC3339)
				blockers = append(blockers, b)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, blockers)
	}
}
