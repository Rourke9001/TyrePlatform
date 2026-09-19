package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// GET /api/exceptions: app.v_exception relayed row for row (B7 spec B7.2).
// Every row is judged at its own sheet's submitted_at, not at now (U18),
// which is why the body says judgedAt SUBMITTED_AT and each row carries the
// threshold it was judged against. Open means not resolved_by_fitment
// (U14); resolved rows are served only on request, since a dashboard that
// keeps shouting about a tyre replaced last week trains users to ignore it.
type exceptionJSON struct {
	RuleCode      string     `json:"ruleCode"`
	RuleName      string     `json:"ruleName"`
	Severity      string     `json:"severity"`
	Urgent        bool       `json:"urgent"`
	SubjectType   string     `json:"subjectType"`
	SubjectID     uuid.UUID  `json:"subjectId"`
	VehicleID     uuid.UUID  `json:"vehicleId"`
	FleetNumber   string     `json:"fleetNumber"`
	UnitLabel     *string    `json:"unitLabel"`
	DepotID       *uuid.UUID `json:"depotId"`
	AxleClass     *string    `json:"axleClass"`
	PositionCode  *string    `json:"positionCode"`
	PositionCode2 *string    `json:"positionCode2"`
	IsSpare       bool       `json:"isSpare"`
	TyreID        *uuid.UUID `json:"tyreId"`
	DisplayCode   *string    `json:"displayCode"`
	InspectionID  uuid.UUID  `json:"inspectionId"`
	ObservedAt    time.Time  `json:"observedAt"`
	// Millimetres and percentages, not money: float64 is the house type for
	// a measurement (capture.go). Null where the rule has no such measure.
	MeasureMm    *float64 `json:"measureMm"`
	MeasurePct   *float64 `json:"measurePct"`
	ThresholdMm  *float64 `json:"thresholdMm"`
	ThresholdPct *float64 `json:"thresholdPct"`
	// Rule-specific (000045 lists the keys per rule); relayed as-is rather
	// than typed, since one struct would have to lie about every other rule.
	Detail            json.RawMessage `json:"detail"`
	ResolvedByFitment bool            `json:"resolvedByFitment"`
}

type exceptionFilter struct {
	depot           *uuid.UUID
	severity        *string
	rule            *string
	vehicle         *uuid.UUID
	includeResolved bool
}

func listExceptions(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		var f exceptionFilter
		var err error
		if f.depot, err = uuidParam(q, "depot"); refuseInvalid(w, r, err) {
			return
		}
		if f.vehicle, err = uuidParam(q, "vehicle"); refuseInvalid(w, r, err) {
			return
		}
		if raw := q.Get("severity"); raw != "" {
			f.severity = &raw
		}
		if raw := q.Get("rule"); raw != "" {
			f.rule = &raw
		}
		f.includeResolved = boolParam(q, "includeResolved")

		var out []exceptionJSON
		var scope scopeJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			scope = scopeFor(a, f.depot)
			out, err = loadExceptions(ctx, tx, a, f)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, map[string]any{"scope": scope, "judgedAt": "SUBMITTED_AT", "exceptions": out})
	}
}

// loadExceptions composes the scope predicate and the filters onto the view.
// The severity is bound as $2::app.severity so an unknown value is judged by
// the cast (22P02, the canned 422), as listDepots does with ?type=. Position
// code orders by length then text so '10' follows '9' (NFR-USE-012).
func loadExceptions(ctx context.Context, tx pgx.Tx, a auth.Actor, f exceptionFilter) ([]exceptionJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT e.rule_code, e.rule_name, e.severity::text, e.urgent,
		       e.subject_type, e.subject_id, e.vehicle_id, e.fleet_number, e.unit_label,
		       e.depot_id, e.axle_class::text, e.position_code, e.position_code_2, e.is_spare,
		       e.tyre_id, e.display_code, e.inspection_id, e.observed_at,
		       e.measure_mm::float8, e.measure_pct::float8, e.threshold_mm::float8, e.threshold_pct::float8,
		       e.detail, e.resolved_by_fitment
		  FROM app.v_exception e
		 WHERE ($2::app.severity IS NULL OR e.severity = $2::app.severity)
		   AND ($3::text IS NULL OR e.rule_code = $3)
		   AND ($4::uuid IS NULL OR e.vehicle_id = $4)
		   AND ($5::boolean OR NOT e.resolved_by_fitment)`+unitScope(a, "e.vehicle_id")+`
		 ORDER BY e.fleet_number, length(e.position_code), e.position_code, e.rule_code`,
		f.depot, f.severity, f.rule, f.vehicle, f.includeResolved)
	if err != nil {
		return nil, fmt.Errorf("listing exceptions: %w", err)
	}
	defer rows.Close()
	// Initialised, not nil: an empty result is [], never null.
	out := []exceptionJSON{}
	for rows.Next() {
		var e exceptionJSON
		if err := rows.Scan(&e.RuleCode, &e.RuleName, &e.Severity, &e.Urgent,
			&e.SubjectType, &e.SubjectID, &e.VehicleID, &e.FleetNumber, &e.UnitLabel,
			&e.DepotID, &e.AxleClass, &e.PositionCode, &e.PositionCode2, &e.IsSpare,
			&e.TyreID, &e.DisplayCode, &e.InspectionID, &e.ObservedAt,
			&e.MeasureMm, &e.MeasurePct, &e.ThresholdMm, &e.ThresholdPct,
			&e.Detail, &e.ResolvedByFitment); err != nil {
			return nil, fmt.Errorf("scanning exception: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
