// The manager's reads of a unit's inspections (TYRE-325, spec section 2): the
// list, and one inspection as it concerns the unit, voided ones included
// (U248). Both relay app.v_unit_inspection, app.v_inspection_reading and
// app.v_unit_inspection_warning (000065) and compute nothing (api/CLAUDE.md,
// Analytics reads). A unit outside the actor's scope, or an inspection that
// does not concern the unit, answers 404, never 403 (ADR-0011).
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

const inspectionPageSize = 20

type inspectionDriverJSON struct {
	ID          uuid.UUID `json:"id"`
	DisplayName string    `json:"displayName"`
}

// addressedUnitJSON is the unit the capture was addressed to, whose odometer
// the inspection holds (FR-INS-064, U249). Its id is null when that unit is
// outside the actor's scope.
type addressedUnitJSON struct {
	FleetNumber string     `json:"fleetNumber"`
	VehicleID   *uuid.UUID `json:"vehicleId"`
}

type unitInspectionJSON struct {
	InspectionID uuid.UUID `json:"inspectionId"`
	FleetNumber  string    `json:"fleetNumber"`
	State        string    `json:"state"`
	Latest       bool      `json:"latest"`
	VoidReason   *string   `json:"voidReason"`
	// A display name, never a user id (spec section 1).
	VoidedBy    *string `json:"voidedBy"`
	VoidedAt    *string `json:"voidedAt"`
	StartedAt   string  `json:"startedAt"`
	SubmittedAt string  `json:"submittedAt"`
	ReceivedAt  string  `json:"receivedAt"`
	// FR-TYR-017: days since SubmittedAt in the tenant's calendar
	// (app.tenant_days_since, rule 6).
	AgeDays       int                  `json:"ageDays"`
	Driver        inspectionDriverJSON `json:"driver"`
	AddressedHere bool                 `json:"addressedHere"`
	AddressedUnit addressedUnitJSON    `json:"addressedUnit"`
	// The addressed unit's reading and whether its timeline took it (DR-020);
	// null with its id, out of scope.
	OdometerKm       *int64  `json:"odometerKm"`
	OdometerOnRecord *bool   `json:"odometerOnRecord"`
	Comment          *string `json:"comment"`
	DefectReport     *string `json:"defectReport"`
	PositionsRead    int     `json:"positionsRead"`
	WarningCount     int     `json:"warningCount"`
}

type unitInspectionPageJSON struct {
	Inspections []unitInspectionJSON `json:"inspections"`
	NextAfter   *uuid.UUID           `json:"nextAfter"`
	// app.v_latest_unit_inspection's answer, whatever page holds it, so a
	// client never takes the latest from a page (TYRE-325 Review Focus 1).
	LatestInspectionID *uuid.UUID `json:"latestInspectionId"`
}

type inspectionUnitJSON struct {
	FleetNumber string     `json:"fleetNumber"`
	VehicleID   *uuid.UUID `json:"vehicleId"`
	InScope     bool       `json:"inScope"`
	Addressed   bool       `json:"addressed"`
}

// inspectionReadingJSON carries millimetres as numbers, as exceptions.go
// does. GoverningIndex is zero-based and found in SQL: it locates the stored
// minimum and computes none (rule 4, CR-011).
type inspectionReadingJSON struct {
	ReadingID        uuid.UUID  `json:"readingId"`
	PositionID       uuid.UUID  `json:"positionId"`
	PositionCode     string     `json:"positionCode"`
	Sequence         int        `json:"sequence"`
	AxleNumber       *int       `json:"axleNumber"`
	AxleClass        string     `json:"axleClass"`
	Side             *string    `json:"side"`
	Slot             *string    `json:"slot"`
	IsSpare          bool       `json:"isSpare"`
	TyreID           *uuid.UUID `json:"tyreId"`
	DisplayCode      *string    `json:"displayCode"`
	GoverningTreadMm *float64   `json:"governingTreadMm"`
	TreadsMm         []float64  `json:"treadsMm"`
	TreadAnatomy     []string   `json:"treadAnatomy"`
	OrientationKnown *bool      `json:"orientationKnown"`
	GoverningIndex   *int       `json:"governingIndex"`
	PressureKpa      *int       `json:"pressureKpa"`
	PressureBasis    string     `json:"pressureBasis"`
	// The tenant's target on the inspection's day; nothing here judges the
	// pressure against it (TYRE-325 Lead's call 11).
	TargetKpa   *int    `json:"targetKpa"`
	DamageFlag  bool    `json:"damageFlag"`
	DamageType  *string `json:"damageType"`
	WearPattern *string `json:"wearPattern"`
	Note        *string `json:"note"`
}

type absentSpareJSON struct {
	PositionID   uuid.UUID `json:"positionId"`
	PositionCode string    `json:"positionCode"`
}

type inspectionWarningJSON struct {
	Code         string  `json:"code"`
	Source       string  `json:"source"`
	EnteredValue *string `json:"enteredValue"`
	Response     *string `json:"response"`
	RaisedAt     string  `json:"raisedAt"`
	PositionCode *string `json:"positionCode"`
}

type inspectionDetailJSON struct {
	Inspection   unitInspectionJSON      `json:"inspection"`
	Units        []inspectionUnitJSON    `json:"units"`
	Readings     []inspectionReadingJSON `json:"readings"`
	AbsentSpares []absentSpareJSON       `json:"absentSpares"`
	Warnings     []inspectionWarningJSON `json:"warnings"`
}

// unitInspectionSelect is one row of app.v_unit_inspection with the addressed
// unit's id and odometer kept only when that unit is in the actor's scope, so
// a depot manager reads another depot's horse by fleet number alone (spec
// section 2, U249). The scope test is a join in the query, as the units are.
func unitInspectionSelect(a auth.Actor) string {
	return `
		SELECT ui.inspection_id, ui.fleet_number, ui.state::text, ui.is_latest,
		       ui.void_reason, ui.voided_by_name, ui.voided_at,
		       ui.started_at, ui.submitted_at, ui.received_at, app.tenant_days_since(ui.submitted_at),
		       ui.driver_id, ui.driver_name, ui.addressed_here, ui.addressed_fleet_number,
		       CASE WHEN sc.in_scope THEN ui.addressed_vehicle_id END,
		       CASE WHEN sc.in_scope THEN ui.odometer END,
		       CASE WHEN sc.in_scope THEN ui.odometer_on_record END,
		       ui.comment, ui.defect_report, ui.positions_read, ui.warning_count
		  FROM app.v_unit_inspection ui
		 CROSS JOIN LATERAL (
		       SELECT EXISTS (SELECT 1 FROM ` + unitSource(a) + ` s WHERE s.id = ui.addressed_vehicle_id) AS in_scope) sc`
}

func scanUnitInspection(row pgx.Row) (unitInspectionJSON, error) {
	var (
		u                            unitInspectionJSON
		voidedAt                     *time.Time
		started, submitted, received time.Time
	)
	if err := row.Scan(&u.InspectionID, &u.FleetNumber, &u.State, &u.Latest,
		&u.VoidReason, &u.VoidedBy, &voidedAt,
		&started, &submitted, &received, &u.AgeDays,
		&u.Driver.ID, &u.Driver.DisplayName, &u.AddressedHere, &u.AddressedUnit.FleetNumber,
		&u.AddressedUnit.VehicleID, &u.OdometerKm, &u.OdometerOnRecord,
		&u.Comment, &u.DefectReport, &u.PositionsRead, &u.WarningCount); err != nil {
		return u, err
	}
	if voidedAt != nil {
		s := voidedAt.UTC().Format(time.RFC3339)
		u.VoidedAt = &s
	}
	u.StartedAt = started.UTC().Format(time.RFC3339)
	u.SubmittedAt = submitted.UTC().Format(time.RFC3339)
	u.ReceivedAt = received.UTC().Format(time.RFC3339)
	return u, nil
}

func requireUnitInScope(ctx context.Context, tx pgx.Tx, a auth.Actor, vehicleID uuid.UUID) error {
	in, err := unitInScope(ctx, tx, a, vehicleID)
	if err != nil {
		return err
	}
	if !in {
		return refusalError{refusal{status: http.StatusNotFound, code: codeNotFound, message: "no such unit in this fleet"}}
	}
	return nil
}

// listUnitInspections pages a unit's inspections newest first, in
// app.v_latest_unit_inspection's order (000045), on a keyset cursor: an
// offset would repeat a row when a capture lands between two pages.
func listUnitInspections(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		after, err := uuidParam(r.URL.Query(), "after")
		if refuseInvalid(w, r, err) {
			return
		}
		body := unitInspectionPageJSON{Inspections: []unitInspectionJSON{}}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			if err := requireUnitInScope(ctx, tx, a, vehicleID); err != nil {
				return err
			}
			var afterSubmitted, afterReceived *time.Time
			if after != nil {
				var sub, rec time.Time
				err := tx.QueryRow(ctx,
					`SELECT submitted_at, received_at FROM app.v_unit_inspection
					  WHERE vehicle_id = $1 AND inspection_id = $2`, vehicleID, *after).Scan(&sub, &rec)
				if errors.Is(err, pgx.ErrNoRows) {
					return refusalError{refusal{
						status:  http.StatusUnprocessableEntity,
						code:    codeInvalidSubmission,
						message: "after names no inspection of this unit",
					}}
				}
				if err != nil {
					return fmt.Errorf("reading the cursor inspection %s: %w", *after, err)
				}
				afterSubmitted, afterReceived = &sub, &rec
			}
			rows, err := tx.Query(ctx, unitInspectionSelect(a)+`
				 WHERE ui.vehicle_id = $1
				   AND ($2::timestamptz IS NULL
				        OR (ui.submitted_at, ui.received_at) < ($2, $3::timestamptz)
				        OR ((ui.submitted_at, ui.received_at) = ($2, $3::timestamptz) AND ui.inspection_id > $4))
				 ORDER BY ui.submitted_at DESC, ui.received_at DESC, ui.inspection_id
				 LIMIT $5`,
				vehicleID, afterSubmitted, afterReceived, after, inspectionPageSize+1)
			if err != nil {
				return fmt.Errorf("listing inspections of unit %s: %w", vehicleID, err)
			}
			defer rows.Close()
			for rows.Next() {
				u, err := scanUnitInspection(rows)
				if err != nil {
					return fmt.Errorf("scanning unit inspection: %w", err)
				}
				body.Inspections = append(body.Inspections, u)
			}
			if err := rows.Err(); err != nil {
				return fmt.Errorf("reading inspections of unit %s: %w", vehicleID, err)
			}
			if len(body.Inspections) > inspectionPageSize {
				body.Inspections = body.Inspections[:inspectionPageSize]
				next := body.Inspections[inspectionPageSize-1].InspectionID
				body.NextAfter = &next
			}
			var latest uuid.UUID
			err = tx.QueryRow(ctx,
				`SELECT inspection_id FROM app.v_latest_unit_inspection WHERE vehicle_id = $1`, vehicleID).Scan(&latest)
			switch {
			case errors.Is(err, pgx.ErrNoRows):
			case err != nil:
				return fmt.Errorf("reading the latest inspection of unit %s: %w", vehicleID, err)
			default:
				body.LatestInspectionID = &latest
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// getUnitInspection answers one inspection as it concerns the unit in the
// path: its row, every unit it concerns, and this unit's readings, spares
// reported absent and warnings. Position codes order by length then text so
// '10' follows '9' (NFR-USE-012).
func getUnitInspection(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, ok := pathID(w, r, "vehicleID")
		if !ok {
			return
		}
		inspectionID, ok := pathID(w, r, "inspectionID")
		if !ok {
			return
		}
		body := inspectionDetailJSON{
			Units:        []inspectionUnitJSON{},
			Readings:     []inspectionReadingJSON{},
			AbsentSpares: []absentSpareJSON{},
			Warnings:     []inspectionWarningJSON{},
		}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			if err := requireUnitInScope(ctx, tx, a, vehicleID); err != nil {
				return err
			}
			header, err := scanUnitInspection(tx.QueryRow(ctx, unitInspectionSelect(a)+`
				 WHERE ui.vehicle_id = $1 AND ui.inspection_id = $2`, vehicleID, inspectionID))
			if errors.Is(err, pgx.ErrNoRows) {
				return refusalError{refusal{status: http.StatusNotFound, code: codeNotFound, message: "no such inspection on this unit"}}
			}
			if err != nil {
				return fmt.Errorf("loading inspection %s of unit %s: %w", inspectionID, vehicleID, err)
			}
			body.Inspection = header
			if body.Units, err = loadInspectionUnits(ctx, tx, a, inspectionID); err != nil {
				return err
			}
			if body.Readings, err = loadInspectionReadings(ctx, tx, vehicleID, inspectionID); err != nil {
				return err
			}
			if body.AbsentSpares, err = loadAbsentSpares(ctx, tx, vehicleID, inspectionID); err != nil {
				return err
			}
			body.Warnings, err = loadInspectionWarnings(ctx, tx, vehicleID, inspectionID)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

func loadInspectionUnits(ctx context.Context, tx pgx.Tx, a auth.Actor, inspectionID uuid.UUID) ([]inspectionUnitJSON, error) {
	out := []inspectionUnitJSON{}
	rows, err := tx.Query(ctx, `
		SELECT ui.fleet_number, CASE WHEN sc.in_scope THEN ui.vehicle_id END, sc.in_scope, ui.addressed_here
		  FROM app.v_unit_inspection ui
		 CROSS JOIN LATERAL (
		       SELECT EXISTS (SELECT 1 FROM `+unitSource(a)+` s WHERE s.id = ui.vehicle_id) AS in_scope) sc
		 WHERE ui.inspection_id = $1
		 ORDER BY ui.addressed_here DESC, length(ui.fleet_number), ui.fleet_number`, inspectionID)
	if err != nil {
		return nil, fmt.Errorf("listing the units of inspection %s: %w", inspectionID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var u inspectionUnitJSON
		if err := rows.Scan(&u.FleetNumber, &u.VehicleID, &u.InScope, &u.Addressed); err != nil {
			return nil, fmt.Errorf("scanning an inspection unit: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func loadInspectionReadings(ctx context.Context, tx pgx.Tx, vehicleID, inspectionID uuid.UUID) ([]inspectionReadingJSON, error) {
	out := []inspectionReadingJSON{}
	rows, err := tx.Query(ctx, `
		SELECT reading_id, position_id, position_code, sequence, axle_number, axle_class::text,
		       side::text, slot::text, is_spare, tyre_id, display_code,
		       governing_tread_mm::float8, COALESCE(measurements::float8[], '{}'), COALESCE(anatomy::text[], '{}'),
		       orientation_known, governing_ordinal - 1, pressure_kpa, pressure_temperature::text, target_kpa,
		       damage_flag, damage_type, wear_pattern, note
		  FROM app.v_inspection_reading
		 WHERE inspection_id = $2 AND vehicle_id = $1
		 ORDER BY length(position_code), position_code`, vehicleID, inspectionID)
	if err != nil {
		return nil, fmt.Errorf("listing the readings of inspection %s: %w", inspectionID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var x inspectionReadingJSON
		if err := rows.Scan(&x.ReadingID, &x.PositionID, &x.PositionCode, &x.Sequence, &x.AxleNumber, &x.AxleClass,
			&x.Side, &x.Slot, &x.IsSpare, &x.TyreID, &x.DisplayCode,
			&x.GoverningTreadMm, &x.TreadsMm, &x.TreadAnatomy,
			&x.OrientationKnown, &x.GoverningIndex, &x.PressureKpa, &x.PressureBasis, &x.TargetKpa,
			&x.DamageFlag, &x.DamageType, &x.WearPattern, &x.Note); err != nil {
			return nil, fmt.Errorf("scanning an inspection reading: %w", err)
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func loadAbsentSpares(ctx context.Context, tx pgx.Tx, vehicleID, inspectionID uuid.UUID) ([]absentSpareJSON, error) {
	out := []absentSpareJSON{}
	rows, err := tx.Query(ctx, `
		SELECT a.position_id, p.code
		  FROM app.inspection_absent_spare a
		  JOIN app.position p ON p.id = a.position_id
		 WHERE a.inspection_id = $2 AND a.vehicle_id = $1
		 ORDER BY length(p.code), p.code`, vehicleID, inspectionID)
	if err != nil {
		return nil, fmt.Errorf("listing the absent spares of inspection %s: %w", inspectionID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var x absentSpareJSON
		if err := rows.Scan(&x.PositionID, &x.PositionCode); err != nil {
			return nil, fmt.Errorf("scanning an absent spare: %w", err)
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func loadInspectionWarnings(ctx context.Context, tx pgx.Tx, vehicleID, inspectionID uuid.UUID) ([]inspectionWarningJSON, error) {
	out := []inspectionWarningJSON{}
	rows, err := tx.Query(ctx, `
		SELECT warning_code, source::text, entered_value, response, raised_at, position_code
		  FROM app.v_unit_inspection_warning
		 WHERE inspection_id = $2 AND vehicle_id = $1
		 ORDER BY raised_at, warning_id`, vehicleID, inspectionID)
	if err != nil {
		return nil, fmt.Errorf("listing the warnings of inspection %s: %w", inspectionID, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			x      inspectionWarningJSON
			raised time.Time
		)
		if err := rows.Scan(&x.Code, &x.Source, &x.EnteredValue, &x.Response, &raised, &x.PositionCode); err != nil {
			return nil, fmt.Errorf("scanning an inspection warning: %w", err)
		}
		x.RaisedAt = raised.UTC().Format(time.RFC3339)
		out = append(out, x)
	}
	return out, rows.Err()
}
