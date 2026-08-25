package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// The capture context is everything FR-OFF-002 requires on the device before
// FR-OFF-001 takes connectivity away. It is one round trip on purpose: a
// driver on a depot forecourt gets one good moment of signal.
type capturePosition struct {
	ID        uuid.UUID `json:"id"`
	VehicleID uuid.UUID `json:"vehicleId"`
	Code      string    `json:"code"`
	Sequence  int       `json:"sequence"`
	AxleClass string    `json:"axleClass"`
	AxleType  string    `json:"axleType"`
	// The diagram groups running positions by (vehicle, axle) to draw one row
	// per axle. Position codes are flat in the fixture, so there is nothing to
	// parse out of them. Null on a spare, which has no axle geometry.
	AxleNumber *int       `json:"axleNumber"`
	IsSpare    bool       `json:"isSpare"`
	UnitLabel  *string    `json:"unitLabel"`
	TyreID     *uuid.UUID `json:"tyreId"`
	TyreCode   *string    `json:"tyreCode"`

	// FR-INS-034 evaluates offline against this position's own history, so
	// both halves of the rule travel: the previous governing value and
	// whether a fitment since then explains an increase (BR-INS-001).
	PreviousMm           *float64   `json:"previousGoverningMm"`
	PreviousAt           *time.Time `json:"previousReadingAt"`
	FitmentSincePrevious bool       `json:"fitmentSincePrevious"`

	// FR-INS-037 and FR-INS-031a both need the position's own resolved
	// target, not a tenant scalar. Null for a spare: FR-CFG-013 as amended
	// gives SPARE no target, and a recorded-but-unclassified spare pressure
	// is deliberate (BR-RPT-001, NFR-PRO-003) — never a zero.
	TargetKpa        *int     `json:"targetKpa"`
	WarnUnderPct     *float64 `json:"warnUnderPct"`
	CriticalUnderPct *float64 `json:"criticalUnderPct"`
	WarnOverPct      *float64 `json:"warnOverPct"`
	CriticalOverPct  *float64 `json:"criticalOverPct"`
}

// FR-INS-062: the composition a CONTROLLER set, for the driver to confirm.
// Managing it is a controller surface and not part of this phase — the
// driver confirms or reports a difference, never edits the fleet's record
// of what is coupled to what.
type captureMember struct {
	VehicleID   uuid.UUID `json:"vehicleId"`
	FleetNumber string    `json:"fleetNumber"`
	Sequence    int       `json:"sequence"`
	Descriptor  *string   `json:"descriptor"`
}

type captureCombination struct {
	ID      uuid.UUID       `json:"id"`
	Members []captureMember `json:"members"`
}

type captureContextBody struct {
	VehicleID    uuid.UUID `json:"vehicleId"`
	FleetNumber  string    `json:"fleetNumber"`
	Registration *string   `json:"registration"`
	// FR-INS-020: a trailer-only inspection has no odometer field at all, and
	// the client cannot infer that from an absent reading — no unit has one
	// until the first inspection writes it.
	UnitKind       string `json:"unitKind"`
	LastOdometerKm *int64 `json:"lastOdometerKm"`
	// FR-INS-033 divides by the gap since this date. Serving the value
	// without it leaves the plausibility warning with no denominator.
	LastOdometerAt *time.Time        `json:"lastOdometerAt"`
	Positions      []capturePosition `json:"positions"`
	// Null unless this vehicle heads a current combination. A trailer asked
	// for its own context gets null and is captured as a solo unit, which is
	// correct: the rig is entered through its motive unit.
	Combination *captureCombination `json:"combination"`
	Config      map[string]any      `json:"config"`

	// FR-INS-035's denominator, cohorted per BR-ANL-006 (position class) and
	// BR-ANL-009 (never blend axle types). Keyed "AXLE_CLASS:AXLE_TYPE" so
	// the client looks up by the two fields each position already carries.
	// A map rather than a field per position: at most a dozen entries for a
	// whole tenant, against 26 repetitions of the same number on a rig
	// (NFR-CST-010, the driver's own airtime).
	CohortWearRateMmPerMonth map[string]float64 `json:"cohortWearRateMmPerMonth"`
}

func captureContext(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vehicleID, err := uuid.Parse(chi.URLParam(r, "vehicleID"))
		if err != nil {
			http.Error(w, "bad vehicle id", http.StatusBadRequest)
			return
		}
		var body captureContextBody
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			return loadCaptureContext(r.Context(), tx, a, vehicleID, &body)
		})
		if !ok {
			return
		}
		writeJSON(r.Context(), w, body)
	}
}

// loadCaptureContext runs four queries on the transaction: the vehicle
// header, the positions, the cohort wear rates, and the tenant
// configuration. It composes the matching scope view so a driver reads only
// assigned units, exactly as listVehicles and listMyVehicles already do
// (ADR-0006).
func loadCaptureContext(ctx context.Context, tx pgx.Tx, a auth.Actor, vehicleID uuid.UUID, out *captureContextBody) error {
	// ADR-0006: the scope predicate lives in SQL and the handler composes the
	// matching view. A DRIVER reaches only currently assigned units
	// (FR-AUT-005); a tenant-scoped role reads the register. Refusing through
	// an empty result is what keeps "you may not see this" and "this does not
	// exist" indistinguishable (ADR-0011).
	from := `app.vehicle v`
	if a.Scope() != auth.ScopeTenant {
		// v_capture_vehicle, not v_driver_vehicle: a driver must reach the
		// trailers of a rig they are responsible for, or a superlink cannot
		// be inspected at all (migration 000022).
		from = `app.v_capture_vehicle cv JOIN app.vehicle v ON v.id = cv.vehicle_id`
	}
	err := tx.QueryRow(ctx, `
		SELECT v.id, v.fleet_number, v.registration, v.unit_kind::text, o.odometer_km, o.reading_date
		  FROM `+from+`
		  LEFT JOIN LATERAL (
		       SELECT vo.odometer_km, vo.reading_date
		         FROM app.vehicle_odometer_reading vo
		        WHERE vo.vehicle_id = v.id
		        ORDER BY vo.reading_date DESC LIMIT 1) o ON true
		 WHERE v.id = $1`, vehicleID).
		Scan(&out.VehicleID, &out.FleetNumber, &out.Registration, &out.UnitKind,
			&out.LastOdometerKm, &out.LastOdometerAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errForbidden
	}
	if err != nil {
		return fmt.Errorf("loading capture vehicle: %w", err)
	}

	// One row per position, carrying everything the phone needs to identify
	// the tyre (FR-INS-026) and to evaluate FR-INS-034/037/031a with no
	// signal. Target resolution is most-specific-wins — a row naming both
	// size and axle class beats one naming only the class — which is the
	// order app.inflation_compliance already resolves in; keep them agreeing.
	rows, err := tx.Query(ctx, `
		SELECT p.id, v.id, p.code, p.sequence, p.axle_class::text, p.axle_type::text,
		       p.axle_number, p.is_spare, p.unit_label, f.tyre_id, t.display_code,
		       prev.governing_tread_mm, prev.submitted_at,
		       EXISTS (SELECT 1 FROM app.fitment fx
		                WHERE fx.position_id = p.id AND fx.vehicle_id = v.id
		                  AND prev.submitted_at IS NOT NULL
		                  AND (fx.fitted_at > prev.submitted_at
		                       OR (fx.removed_at IS NOT NULL AND fx.removed_at > prev.submitted_at))),
		       tgt.target_kpa, tgt.warn_under_pct, tgt.critical_under_pct,
		       tgt.warn_over_pct, tgt.critical_over_pct
		  FROM app.vehicle v
		  JOIN app.position p ON p.configuration_id = v.configuration_id
		  LEFT JOIN app.fitment f
		         ON f.position_id = p.id AND f.vehicle_id = v.id AND f.removed_at IS NULL
		  LEFT JOIN app.tyre t ON t.id = f.tyre_id
		  LEFT JOIN LATERAL (
		       SELECT r.governing_tread_mm, i.submitted_at
		         FROM app.reading r
		         JOIN app.inspection i ON i.id = r.inspection_id
		        WHERE r.position_id = p.id AND r.vehicle_id = v.id AND i.state <> 'VOIDED'
		        ORDER BY i.submitted_at DESC LIMIT 1) prev ON true
		  LEFT JOIN LATERAL (
		       SELECT tp.target_kpa, tp.warn_under_pct, tp.critical_under_pct,
		              tp.warn_over_pct, tp.critical_over_pct
		         FROM app.target_pressure tp
		        WHERE tp.tenant_id = v.tenant_id
		          AND tp.effective_from <= now()
		          AND p.axle_class <> 'SPARE'
		          AND (tp.axle_class IS NULL OR tp.axle_class = p.axle_class)
		          AND (tp.size_id   IS NULL OR tp.size_id   = t.size_id)
		        ORDER BY (tp.size_id IS NOT NULL) DESC,
		                 (tp.axle_class IS NOT NULL) DESC,
		                 tp.effective_from DESC
		        LIMIT 1) tgt ON true
		 WHERE v.id = $1
		 ORDER BY p.sequence`, vehicleID)
	if err != nil {
		return fmt.Errorf("loading capture positions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p capturePosition
		if err := rows.Scan(&p.ID, &p.VehicleID, &p.Code, &p.Sequence, &p.AxleClass,
			&p.AxleType, &p.AxleNumber, &p.IsSpare, &p.UnitLabel, &p.TyreID, &p.TyreCode,
			&p.PreviousMm, &p.PreviousAt, &p.FitmentSincePrevious,
			&p.TargetKpa, &p.WarnUnderPct, &p.CriticalUnderPct,
			&p.WarnOverPct, &p.CriticalOverPct); err != nil {
			return fmt.Errorf("scanning capture position: %w", err)
		}
		out.Positions = append(out.Positions, p)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading capture positions: %w", err)
	}

	// FR-INS-035's fleet average, over app.wear_rate_mm_per_month so the
	// regression rule (BR-ANL-001) keeps exactly one implementation. Spares
	// are excluded (BR-RPT-007 judges them on age, not wear) and LIFTING
	// axles assert no rate at all (BR-ANL-009) rather than a flatteringly low
	// one — a raised axle is not touching the road.
	out.CohortWearRateMmPerMonth = map[string]float64{}
	crows, err := tx.Query(ctx, `
		SELECT p.axle_class::text || ':' || p.axle_type::text, avg(w.rate_mm_per_month)
		  FROM app.fitment f
		  JOIN app.position p ON p.id = f.position_id
		  CROSS JOIN LATERAL app.wear_rate_mm_per_month(f.tyre_id) w
		 WHERE f.removed_at IS NULL
		   AND NOT p.is_spare
		   AND p.axle_type <> 'LIFTING'
		   AND w.rate_mm_per_month IS NOT NULL
		 GROUP BY p.axle_class, p.axle_type`)
	if err != nil {
		return fmt.Errorf("loading cohort wear rates: %w", err)
	}
	defer crows.Close()
	for crows.Next() {
		var key string
		var rate float64
		if err := crows.Scan(&key, &rate); err != nil {
			return fmt.Errorf("scanning cohort wear rate: %w", err)
		}
		out.CohortWearRateMmPerMonth[key] = rate
	}
	if err := crows.Err(); err != nil {
		return fmt.Errorf("reading cohort wear rates: %w", err)
	}

	// FR-INS-062's composition, for the driver to confirm before starting.
	// Ordered by member sequence, which with each unit's own position
	// sequence is all FR-VEH-034 needs to compute the rig's 1..n at render
	// time — nothing about that numbering is stored here or anywhere.
	var combo captureCombination
	mrows, err := tx.Query(ctx, `
		SELECT c.id, cm.vehicle_id, mv.fleet_number, cm.sequence, cm.descriptor
		  FROM app.combination c
		  JOIN app.combination_member cm ON cm.combination_id = c.id
		  JOIN app.vehicle mv ON mv.id = cm.vehicle_id
		 WHERE c.motive_vehicle_id = $1 AND c.effective_to IS NULL
		 ORDER BY cm.sequence`, vehicleID)
	if err != nil {
		return fmt.Errorf("loading combination: %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var m captureMember
		if err := mrows.Scan(&combo.ID, &m.VehicleID, &m.FleetNumber, &m.Sequence, &m.Descriptor); err != nil {
			return fmt.Errorf("scanning combination member: %w", err)
		}
		combo.Members = append(combo.Members, m)
	}
	if err := mrows.Err(); err != nil {
		return fmt.Errorf("reading combination: %w", err)
	}
	if len(combo.Members) > 0 {
		out.Combination = &combo
	}

	// Every threshold the client evaluates against, read through the same
	// tenant-configuration accessor the database uses. Rule 5: none of these
	// may become a literal on the device.
	return tx.QueryRow(ctx, `
		SELECT jsonb_build_object(
		         'treadReadingCount',     app.config_for($1, 'tread_reading_count',      now()),
		         'treadGranularityMm',    app.config_for($1, 'tread_capture_granularity_mm', now()),
		         'widthSpreadWarnMm',     app.config_for($1, 'width_spread_warn_mm',     now()),
		         'odometerMaxDailyKm',    app.config_for($1, 'odometer_max_daily_km',    now()),
		         'wearRateAlertMultiple', app.config_for($1, 'wear_rate_alert_multiple', now()),
		         'removalThresholdMm',    app.removal_threshold_mm_for($1, now()))`,
		a.TenantID).Scan(&out.Config)
}
