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

// atRiskClassJSON carries app.v_casing_value_at_risk's own names (U27):
// estimatedOrAuditCount nests the audit share, auditCount discloses it, so
// the page renders "of which N audit" rather than subtracting (D4).
// casingValueAtRisk is null when every member casing is unvalued (59d pins
// the NULL; never COALESCE it) and null when the actor lacks ViewValuation;
// moneyVisible says which (U36) and unvaluedCount says how many.
type atRiskClassJSON struct {
	TyreCount             int64   `json:"tyreCount"`
	ActualCount           int64   `json:"actualCount"`
	EstimatedOrAuditCount int64   `json:"estimatedOrAuditCount"`
	AuditCount            int64   `json:"auditCount"`
	UnvaluedCount         int64   `json:"unvaluedCount"`
	CasingValueAtRisk     *string `json:"casingValueAtRisk"`
}

// valueAtRiskJSON is FR-VAL-031 as the register sees it today (U18): a tyre
// is at risk when its current tread is at or below the threshold in force
// now, a different population from the exception rows judged at their
// sheet. The dashboard names both.
type valueAtRiskJSON struct {
	JudgedAt string          `json:"judgedAt"`
	Running  atRiskClassJSON `json:"running"`
	Spare    atRiskClassJSON `json:"spare"`
}

// loadValueAtRisk sums the aggregate view's rows the actor may read
// (aggregateScope): one TENANT row, one DEPOT row, or a ScopeDepot actor's
// set of DEPOT rows, each per position class. Summing several is the
// composition U25 asks for, done where the numbers are, not in Go.
func loadValueAtRisk(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID, moneyVisible bool) (valueAtRiskJSON, error) {
	out := valueAtRiskJSON{JudgedAt: "TODAY"}
	rows, err := tx.Query(ctx, `
		SELECT v.position_class,
		       COALESCE(sum(v.tyre_count), 0)::bigint,
		       COALESCE(sum(v.actual_count), 0)::bigint,
		       COALESCE(sum(v.estimated_or_audit_count), 0)::bigint,
		       COALESCE(sum(v.audit_count), 0)::bigint,
		       COALESCE(sum(v.unvalued_count), 0)::bigint,
		       sum(v.casing_value_at_risk)::text
		  FROM app.v_casing_value_at_risk v
		 WHERE true`+aggregateScope(a, depotByID)+`
		 GROUP BY v.position_class`, depot)
	if err != nil {
		return out, fmt.Errorf("loading value at risk: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var class string
		var c atRiskClassJSON
		if err := rows.Scan(&class, &c.TyreCount, &c.ActualCount, &c.EstimatedOrAuditCount,
			&c.AuditCount, &c.UnvaluedCount, &c.CasingValueAtRisk); err != nil {
			return out, fmt.Errorf("scanning value at risk: %w", err)
		}
		if !moneyVisible {
			c.CasingValueAtRisk = nil
		}
		switch class {
		case "RUNNING":
			out.Running = c
		case "SPARE":
			out.Spare = c
		}
	}
	return out, rows.Err()
}

// tyreAtRiskJSON is one app.v_tyre_at_risk row: the register's own tread,
// its source (READING, or AUDIT for a depth measured outside an inspection,
// U29), and the casing figure with its basis.
type tyreAtRiskJSON struct {
	TyreID             uuid.UUID  `json:"tyreId"`
	DisplayCode        string     `json:"displayCode"`
	VehicleID          uuid.UUID  `json:"vehicleId"`
	FleetNumber        string     `json:"fleetNumber"`
	DepotID            *uuid.UUID `json:"depotId"`
	PositionCode       string     `json:"positionCode"`
	IsSpare            bool       `json:"isSpare"`
	CurrentTreadMm     float64    `json:"currentTreadMm"`
	RemovalThresholdMm float64    `json:"removalThresholdMm"`
	TreadSource        string     `json:"treadSource"`
	ReadAt             *time.Time `json:"readAt"`
	CasingValue        *string    `json:"casingValue"`
	CasingBasis        string     `json:"casingBasis"`
}

func loadTyresAtRisk(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID) ([]tyreAtRiskJSON, error) {
	rows, err := tx.Query(ctx, `
		SELECT r.tyre_id, r.display_code, r.vehicle_id, r.fleet_number, r.depot_id, r.position_code, r.is_spare,
		       r.current_tread_mm::float8, r.removal_threshold_mm::float8, r.tread_source, r.read_at,
		       r.casing_value::text, r.casing_basis
		  FROM app.v_tyre_at_risk r
		 WHERE true`+unitScope(a, "r.vehicle_id")+`
		 ORDER BY r.fleet_number, length(r.position_code), r.position_code`, depot)
	if err != nil {
		return nil, fmt.Errorf("listing tyres at risk: %w", err)
	}
	defer rows.Close()
	out := []tyreAtRiskJSON{}
	for rows.Next() {
		var t tyreAtRiskJSON
		if err := rows.Scan(&t.TyreID, &t.DisplayCode, &t.VehicleID, &t.FleetNumber, &t.DepotID, &t.PositionCode, &t.IsSpare,
			&t.CurrentTreadMm, &t.RemovalThresholdMm, &t.TreadSource, &t.ReadAt, &t.CasingValue, &t.CasingBasis); err != nil {
			return nil, fmt.Errorf("scanning tyre at risk: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GET /api/valuation/at-risk: the value-at-risk figure and the tyres behind
// it (FR-RPT-040). ViewValuation for the whole route: the list is money
// through and through, and a holder of ViewFleet alone reads the count on
// the dashboard instead.
func valueAtRisk(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		depot, err := uuidParam(r.URL.Query(), "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		var body struct {
			Scope    scopeJSON        `json:"scope"`
			JudgedAt string           `json:"judgedAt"`
			Running  atRiskClassJSON  `json:"running"`
			Spare    atRiskClassJSON  `json:"spare"`
			Tyres    []tyreAtRiskJSON `json:"tyres"`
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewValuation); err != nil {
				return err
			}
			body.Scope = scopeFor(a, depot)
			v, err := loadValueAtRisk(ctx, tx, a, depot, true)
			if err != nil {
				return err
			}
			body.JudgedAt, body.Running, body.Spare = v.JudgedAt, v.Running, v.Spare
			body.Tyres, err = loadTyresAtRisk(ctx, tx, a, depot)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}
