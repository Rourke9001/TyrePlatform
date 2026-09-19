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

// GET /api/dashboard: the landing page's figures in one transaction, so
// every tile shares an as-at instant (B7 spec U17). Each figure is a SQL
// column relayed as it came; the 19/11/9 agreement rests on this handler
// adding nothing up (CLAUDE.md, Testing). Three clocks meet here and every
// section names its own (U18). Money is null when hidden or unvalued, and
// moneyVisible says which (U36).
type dashboardBody struct {
	AsAt                      time.Time                `json:"asAt"`
	MoneyVisible              bool                     `json:"moneyVisible"`
	Scope                     scopeJSON                `json:"scope"`
	ValueAtRisk               valueAtRiskJSON          `json:"valueAtRisk"`
	Estate                    estateRowJSON            `json:"estate"`
	Exceptions                exceptionSummaryJSON     `json:"exceptions"`
	BelowThreshold            belowThresholdJSON       `json:"belowThreshold"`
	Units                     unitStatusSummaryJSON    `json:"units"`
	OverdueTasks              int64                    `json:"overdueTasks"`
	PendingCompositionReports int64                    `json:"pendingCompositionReports"`
	InflationCompliance       inflationComplianceJSON  `json:"inflationCompliance"`
	TreadDistribution         []treadBandJSON          `json:"treadDistribution"`
	RemovalForecast           forecastSummaryJSON      `json:"removalForecast"`
	IrregularWear             irregularWearSummaryJSON `json:"irregularWear"`
}

// exceptionSummaryJSON counts app.v_exception rows (FR-DSH-003): open is
// NOT resolved_by_fitment (U14), total includes the resolved.
// rulesConfigured is the enabled catalogue, so a page can say "0 of 9 rules
// fired" rather than a bare zero.
type exceptionSummaryJSON struct {
	JudgedAt        string           `json:"judgedAt"`
	Open            int64            `json:"open"`
	Urgent          int64            `json:"urgent"`
	Total           int64            `json:"total"`
	BySeverity      map[string]int64 `json:"bySeverity"`
	ByRule          []ruleCountJSON  `json:"byRule"`
	RulesConfigured int64            `json:"rulesConfigured"`
}

type ruleCountJSON struct {
	RuleCode string `json:"ruleCode"`
	RuleName string `json:"ruleName"`
	Severity string `json:"severity"`
	Open     int64  `json:"open"`
	Total    int64  `json:"total"`
}

// belowThresholdJSON is the register's count (FR-DSH-004, U18): tyres at or
// below the threshold in force today, a different population from the
// exception rows judged at their sheet. The page says "today" beside it.
type belowThresholdJSON struct {
	JudgedAt string `json:"judgedAt"`
	Running  int64  `json:"running"`
	Spare    int64  `json:"spare"`
}

// unitStatusSummaryJSON counts app.v_unit_inspection_status (FR-DSH-005,
// FR-DSH-006, FR-EXC-027). covered and stale are nullable in the view:
// unscheduled units have no coverage to report and a tenant without
// reading_staleness_days has no staleness, so both absences are counted
// rather than folded into false (NFR-PRO-003).
type unitStatusSummaryJSON struct {
	JudgedAt     string `json:"judgedAt"`
	Total        int64  `json:"total"`
	Scheduled    int64  `json:"scheduled"`
	Covered      int64  `json:"covered"`
	Unscheduled  int64  `json:"unscheduled"`
	Stale        int64  `json:"stale"`
	StaleUnknown int64  `json:"staleUnknown"`
}

// forecastSummaryJSON is FR-DSH-009's tile: how many running tyres reach
// the threshold within the configured horizon of the from date (U34),
// counted with the predicate suite section 59e pins. dueCount is null, not
// 0, when no horizon is configured.
type forecastSummaryJSON struct {
	forecastWindowJSON
	JudgedAt string `json:"judgedAt"`
	DueCount *int64 `json:"dueCount"`
}

// irregularWearSummaryJSON is FR-DSH-016's count: tyres whose latest
// reading's width spread is at or over width_spread_warn_mm, running, with
// the spare disclosed beside it rather than mixed in.
type irregularWearSummaryJSON struct {
	JudgedAt     string   `json:"judgedAt"`
	SpreadWarnMm *float64 `json:"spreadWarnMm"`
	Running      int64    `json:"running"`
	Spare        int64    `json:"spare"`
}

func dashboard(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		depot, err := uuidParam(q, "depot")
		if refuseInvalid(w, r, err) {
			return
		}
		from, err := dateParam(q, "from")
		if refuseInvalid(w, r, err) {
			return
		}
		to, err := dateParam(q, "to")
		if refuseInvalid(w, r, err) {
			return
		}
		if (from == nil) != (to == nil) {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"a period names both from and to (to is exclusive), or neither for the configured window")
			return
		}
		var body dashboardBody
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			return loadDashboard(ctx, tx, a, depot, from, to, &body)
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, body)
	}
}

// loadDashboard runs the tiles' queries on one transaction. Each block
// composes the same scope clause its list route composes, so a tile and the
// list it links to can never disagree about what is in scope.
func loadDashboard(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID, from, to *string, out *dashboardBody) error {
	out.MoneyVisible = a.Can(auth.ViewValuation)
	out.Scope = scopeFor(a, depot)
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&out.AsAt); err != nil {
		return fmt.Errorf("reading the as-at instant: %w", err)
	}

	var err error
	if out.ValueAtRisk, err = loadValueAtRisk(ctx, tx, a, depot, out.MoneyVisible); err != nil {
		return err
	}

	estate, err := loadEstate(ctx, tx, a, depot, "TENANT", nil, out.MoneyVisible)
	if err != nil {
		return err
	}
	// The ALL row is the ROLLUP's grand total, present even over an empty
	// estate; the zero-valued struct stands if a future shape drops it.
	out.Estate = estateRowJSON{Level: "TENANT", LocationClass: "ALL"}
	for _, row := range estate {
		if row.LocationClass == "ALL" {
			out.Estate = row
			break
		}
	}

	if err := loadExceptionSummary(ctx, tx, a, depot, &out.Exceptions); err != nil {
		return err
	}

	out.BelowThreshold.JudgedAt = "TODAY"
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE NOT r.is_spare)::bigint, count(*) FILTER (WHERE r.is_spare)::bigint
		  FROM app.v_tyre_at_risk r
		 WHERE true`+unitScope(a, "r.vehicle_id"), depot).Scan(&out.BelowThreshold.Running, &out.BelowThreshold.Spare); err != nil {
		return fmt.Errorf("counting tyres below threshold: %w", err)
	}

	out.Units.JudgedAt = "TENANT_TODAY"
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::bigint,
		       count(*) FILTER (WHERE s.scheduled)::bigint,
		       count(*) FILTER (WHERE s.covered)::bigint,
		       count(*) FILTER (WHERE NOT s.scheduled)::bigint,
		       count(*) FILTER (WHERE s.stale)::bigint,
		       count(*) FILTER (WHERE s.stale IS NULL)::bigint
		  FROM app.v_unit_inspection_status s
		 WHERE true`+unitScope(a, "s.vehicle_id"), depot).Scan(&out.Units.Total, &out.Units.Scheduled, &out.Units.Covered,
		&out.Units.Unscheduled, &out.Units.Stale, &out.Units.StaleUnknown); err != nil {
		return fmt.Errorf("counting unit inspection status: %w", err)
	}

	// overdue is the view's expression, never restated here (000038).
	if err := tx.QueryRow(ctx, `
		SELECT count(*)::bigint FROM app.v_inspection_task t
		 WHERE t.overdue`+unitScope(a, "t.vehicle_id"), depot).Scan(&out.OverdueTasks); err != nil {
		return fmt.Errorf("counting overdue tasks: %w", err)
	}

	if err := tx.QueryRow(ctx, `
		SELECT count(*)::bigint
		  FROM app.inspection_warning w
		  JOIN app.inspection i  ON i.id = w.inspection_id
		  JOIN app.combination c ON c.id = i.combination_id
		 WHERE `+pendingObservationWhere+unitScope(a, "c.motive_vehicle_id"), depot).Scan(&out.PendingCompositionReports); err != nil {
		return fmt.Errorf("counting pending composition reports: %w", err)
	}

	if out.InflationCompliance, err = loadInflationCompliance(ctx, tx, a, depot, from, to); err != nil {
		return err
	}

	if out.TreadDistribution, err = loadTreadDistribution(ctx, tx, a, depot, "TENANT", "RUNNING"); err != nil {
		return err
	}

	out.RemovalForecast.JudgedAt = "TODAY"
	if out.RemovalForecast.forecastWindowJSON, err = resolveForecastWindow(ctx, tx, a, nil, nil); err != nil {
		return err
	}
	if out.RemovalForecast.HorizonDays != nil {
		var due int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*)::bigint FROM app.v_removal_forecast f
			 WHERE `+forecastWithinWhere+unitScope(a, "f.vehicle_id"),
			depot, *out.RemovalForecast.HorizonDays, out.RemovalForecast.From, false).Scan(&due); err != nil {
			return fmt.Errorf("counting the removal forecast: %w", err)
		}
		out.RemovalForecast.DueCount = &due
	}

	out.IrregularWear.JudgedAt = "LATEST_READING"
	if err := tx.QueryRow(ctx,
		`SELECT (app.config_for($1, 'width_spread_warn_mm', now()) #>> '{}')::float8`, a.TenantID).Scan(&out.IrregularWear.SpreadWarnMm); err != nil {
		return fmt.Errorf("resolving width_spread_warn_mm: %w", err)
	}
	if out.IrregularWear.SpreadWarnMm != nil {
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE NOT r.is_spare)::bigint, count(*) FILTER (WHERE r.is_spare)::bigint
			  FROM app.v_irregular_wear_ranking r
			 WHERE r.width_spread_mm >= $2::numeric`+unitScope(a, "r.vehicle_id"),
			depot, *out.IrregularWear.SpreadWarnMm).Scan(&out.IrregularWear.Running, &out.IrregularWear.Spare); err != nil {
			return fmt.Errorf("counting irregular wear: %w", err)
		}
	}
	return nil
}

// loadExceptionSummary takes the per-rule, per-severity and grand totals
// from one GROUPING SETS statement, so the three agree by construction and
// nothing is added up in Go. GROUPING() says which row is which: 0 a rule
// row, 2 a severity subtotal, 3 the grand total.
func loadExceptionSummary(ctx context.Context, tx pgx.Tx, a auth.Actor, depot *uuid.UUID, out *exceptionSummaryJSON) error {
	out.JudgedAt = "SUBMITTED_AT"
	out.BySeverity = map[string]int64{}
	out.ByRule = []ruleCountJSON{}
	rows, err := tx.Query(ctx, `
		SELECT GROUPING(e.rule_code, e.severity), e.rule_code, e.rule_name, e.severity::text,
		       count(*) FILTER (WHERE NOT e.resolved_by_fitment)::bigint,
		       count(*)::bigint,
		       count(*) FILTER (WHERE e.urgent AND NOT e.resolved_by_fitment)::bigint
		  FROM app.v_exception e
		 WHERE true`+unitScope(a, "e.vehicle_id")+`
		 GROUP BY GROUPING SETS ((e.rule_code, e.rule_name, e.severity), (e.severity), ())
		 ORDER BY e.severity NULLS LAST, e.rule_code NULLS LAST`, depot)
	if err != nil {
		return fmt.Errorf("summarising exceptions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var grouping int
		var code, name, severity *string
		var open, total, urgent int64
		if err := rows.Scan(&grouping, &code, &name, &severity, &open, &total, &urgent); err != nil {
			return fmt.Errorf("scanning exception summary: %w", err)
		}
		switch grouping {
		case 0:
			out.ByRule = append(out.ByRule, ruleCountJSON{RuleCode: *code, RuleName: *name, Severity: *severity, Open: open, Total: total})
		case 2:
			out.BySeverity[*severity] = open
		case 3:
			out.Open, out.Total, out.Urgent = open, total, urgent
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return tx.QueryRow(ctx, `SELECT count(*)::bigint FROM app.exception_rule WHERE enabled`).Scan(&out.RulesConfigured)
}
