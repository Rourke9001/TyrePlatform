package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type dashboard struct {
	AsAt         string         `json:"asAt"`
	MoneyVisible bool           `json:"moneyVisible"`
	Scope        map[string]any `json:"scope"`
	ValueAtRisk  struct {
		JudgedAt string      `json:"judgedAt"`
		Running  atRiskClass `json:"running"`
		Spare    atRiskClass `json:"spare"`
	} `json:"valueAtRisk"`
	Estate     estateRow `json:"estate"`
	Exceptions struct {
		JudgedAt   string           `json:"judgedAt"`
		Open       int64            `json:"open"`
		Urgent     int64            `json:"urgent"`
		Total      int64            `json:"total"`
		BySeverity map[string]int64 `json:"bySeverity"`
		ByRule     []struct {
			RuleCode string `json:"ruleCode"`
			Open     int64  `json:"open"`
		} `json:"byRule"`
		RulesConfigured int64 `json:"rulesConfigured"`
	} `json:"exceptions"`
	BelowThreshold struct {
		JudgedAt string `json:"judgedAt"`
		Running  int64  `json:"running"`
		Spare    int64  `json:"spare"`
	} `json:"belowThreshold"`
	Units struct {
		JudgedAt     string `json:"judgedAt"`
		Total        int64  `json:"total"`
		Scheduled    int64  `json:"scheduled"`
		Covered      int64  `json:"covered"`
		Unscheduled  int64  `json:"unscheduled"`
		Stale        int64  `json:"stale"`
		StaleUnknown int64  `json:"staleUnknown"`
	} `json:"units"`
	OverdueTasks              int64 `json:"overdueTasks"`
	PendingCompositionReports int64 `json:"pendingCompositionReports"`
	InflationCompliance       struct {
		WindowDays  *int    `json:"windowDays"`
		Unavailable *string `json:"unavailable"`
		Bands       []any   `json:"bands"`
	} `json:"inflationCompliance"`
	TreadDistribution []bandRow `json:"treadDistribution"`
	RemovalForecast   struct {
		HorizonDays *int    `json:"horizonDays"`
		From        string  `json:"from"`
		Unavailable *string `json:"unavailable"`
		DueCount    *int64  `json:"dueCount"`
	} `json:"removalForecast"`
	IrregularWear struct {
		SpreadWarnMm *float64 `json:"spreadWarnMm"`
		Running      int64    `json:"running"`
		Spare        int64    `json:"spare"`
	} `json:"irregularWear"`
}

func readDashboard(t *testing.T, h http.Handler, path, tenant, user string) dashboard {
	t.Helper()
	rec := get(t, h, path, tenant, user)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var d dashboard
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &d))
	return d
}

func TestDashboardIsGatedOnViewFleet(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dashboard-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/dashboard", tenantID.String(), driver.String()).Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/dashboard", "", "").Code)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	d := readDashboard(t, h, "/api/dashboard", tenantID.String(), technician.String())
	require.False(t, d.MoneyVisible)
	// An empty tenant answers with figures, not errors: zero counts, null
	// money, and every "not configured" named (NFR-PRO-002).
	require.Equal(t, int64(0), d.Exceptions.Open)
	require.Nil(t, d.ValueAtRisk.Running.CasingValueAtRisk)
	require.Equal(t, "NO_HORIZON", *d.RemovalForecast.Unavailable)
	require.Nil(t, d.IrregularWear.SpreadWarnMm)
	_, err := time.Parse(time.RFC3339Nano, d.AsAt)
	require.NoError(t, err)
}

// Every tile against the figure the suite pins for the same relation
// (sections 8, 17, 59b, 59d, 59e), read in one transaction by the actor
// B7.3's dashboard will use. This is the three-tier agreement's middle
// tier: the numbers are relayed, so a change in the view moves this test
// and the suite together, and a Go-side sum could never have matched.
func TestDashboardRelaysEveryPinnedFigure(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	d := readDashboard(t, h, "/api/dashboard", bacTenant, seedID("controller1").String())

	require.True(t, d.MoneyVisible)
	require.Equal(t, "TENANT", d.Scope["level"])

	require.Equal(t, "TODAY", d.ValueAtRisk.JudgedAt)
	require.Equal(t, ptr("16537.50"), d.ValueAtRisk.Running.CasingValueAtRisk)
	require.Equal(t, int64(9), d.ValueAtRisk.Running.AuditCount)
	require.Equal(t, ptr("1837.50"), d.ValueAtRisk.Spare.CasingValueAtRisk)

	require.Equal(t, "ALL", d.Estate.LocationClass)
	require.Equal(t, int64(27), d.Estate.TyreCount)
	require.Equal(t, ptr("70183.50"), d.Estate.TotalValue)
	require.Equal(t, int64(27), d.Estate.CasingAuditCount)
	require.Equal(t, int64(0), d.Estate.CasingEstimatedCount)

	require.Equal(t, "SUBMITTED_AT", d.Exceptions.JudgedAt)
	require.Equal(t, int64(19), d.Exceptions.Open)
	require.Equal(t, int64(11), d.Exceptions.Urgent)
	require.Equal(t, int64(19), d.Exceptions.Total)
	require.Equal(t, int64(11), d.Exceptions.BySeverity["CRITICAL"])
	byRule := map[string]int64{}
	for _, r := range d.Exceptions.ByRule {
		byRule[r.RuleCode] = r.Open
	}
	require.Equal(t, int64(9), byRule["FR-EXC-020"])
	require.Equal(t, int64(6), byRule["FR-EXC-035"])
	var rules int64
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.exception_rule WHERE tenant_id = $1 AND enabled`, bacTenant).Scan(&rules))
	require.Equal(t, rules, d.Exceptions.RulesConfigured)

	require.Equal(t, "TODAY", d.BelowThreshold.JudgedAt)
	require.Equal(t, int64(9), d.BelowThreshold.Running)
	require.Equal(t, int64(1), d.BelowThreshold.Spare)

	require.Equal(t, "TENANT_TODAY", d.Units.JudgedAt)
	require.Equal(t, int64(3), d.Units.Total)
	require.Equal(t, int64(0), d.Units.Scheduled)
	require.Equal(t, int64(3), d.Units.Unscheduled)

	require.Equal(t, int64(0), d.OverdueTasks)
	require.Equal(t, int64(0), d.PendingCompositionReports)

	require.Equal(t, 30, *d.InflationCompliance.WindowDays)
	require.Nil(t, d.InflationCompliance.Unavailable)
	require.Len(t, d.InflationCompliance.Bands, 5)

	require.Len(t, d.TreadDistribution, 5)

	require.Equal(t, 30, *d.RemovalForecast.HorizonDays)
	require.Nil(t, d.RemovalForecast.Unavailable)
	require.NotNil(t, d.RemovalForecast.DueCount)

	require.Equal(t, 4.0, *d.IrregularWear.SpreadWarnMm)
	var irrRunning, irrSpare int64
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE NOT is_spare), count(*) FILTER (WHERE is_spare)
		   FROM app.v_irregular_wear_ranking WHERE tenant_id = $1 AND width_spread_mm >= 4`, bacTenant).Scan(&irrRunning, &irrSpare))
	require.Equal(t, irrRunning, d.IrregularWear.Running)
	require.Equal(t, irrSpare, d.IrregularWear.Spare)

	// The period parameters reach the inflation tile and nothing else.
	d = readDashboard(t, h, "/api/dashboard?from=2026-07-01&to=2026-08-01", bacTenant, seedID("controller1").String())
	require.Nil(t, d.InflationCompliance.WindowDays)
	require.Len(t, d.InflationCompliance.Bands, 5)
	require.Equal(t, int64(19), d.Exceptions.Open)
}

// The TECHNICIAN control the spec asks for: a depot actor never sees the
// tenant-wide hero, and a holder of ViewFleet alone never sees a rand.
func TestDashboardDepotActorsSeeTheirDepotsAndNoMoneyWithoutViewValuation(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantDepotFixture(t, ctx, admin, "dashboard-scope")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	technician := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	assignDepot(t, ctx, admin, f.Tenant, technician, f.DepotA)
	manager := plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	assignDepot(t, ctx, admin, f.Tenant, manager, f.DepotA)

	whole := readDashboard(t, h, "/api/dashboard", f.Tenant.String(), controller.String())
	require.Equal(t, int64(2), whole.ValueAtRisk.Running.TyreCount)
	require.Equal(t, ptr("300.00"), whole.ValueAtRisk.Running.CasingValueAtRisk)
	require.Equal(t, int64(2), whole.Exceptions.Open)
	require.Equal(t, int64(2), whole.Units.Total)
	require.Equal(t, int64(2), whole.TreadDistribution[0].TyreCount)
	require.Nil(t, whole.InflationCompliance.Unavailable)

	tech := readDashboard(t, h, "/api/dashboard", f.Tenant.String(), technician.String())
	require.False(t, tech.MoneyVisible)
	require.Equal(t, "DEPOTS", tech.Scope["level"])
	require.Equal(t, int64(1), tech.ValueAtRisk.Running.TyreCount)
	require.Nil(t, tech.ValueAtRisk.Running.CasingValueAtRisk)
	require.Nil(t, tech.Estate.TotalValue)
	require.Equal(t, int64(1), tech.Estate.TyreCount)
	require.Equal(t, int64(1), tech.Exceptions.Open)
	require.Equal(t, int64(1), tech.BelowThreshold.Running)
	require.Equal(t, int64(1), tech.Units.Total)
	require.Equal(t, int64(1), tech.TreadDistribution[0].TyreCount)
	require.Equal(t, "TENANT_ONLY", *tech.InflationCompliance.Unavailable)

	mgr := readDashboard(t, h, "/api/dashboard", f.Tenant.String(), manager.String())
	require.True(t, mgr.MoneyVisible)
	require.Equal(t, ptr("100.00"), mgr.ValueAtRisk.Running.CasingValueAtRisk)
	require.Equal(t, ptr("100.00"), mgr.Estate.CasingValue)

	// The tenant-wide actor narrowing to one depot reads that depot alone.
	one := readDashboard(t, h, "/api/dashboard?depot="+f.DepotB.String(), f.Tenant.String(), controller.String())
	require.Equal(t, "DEPOT", one.Scope["level"])
	require.Equal(t, ptr("200.00"), one.ValueAtRisk.Running.CasingValueAtRisk)
	require.Equal(t, int64(1), one.Exceptions.Open)
	// The inflation function has no depot dimension, so a body whose scope
	// says DEPOT must not carry the tenant's figure beside depot figures
	// (U32, NFR-PRO-002).
	require.Equal(t, "TENANT_ONLY", *one.InflationCompliance.Unavailable)
	require.Empty(t, one.InflationCompliance.Bands)
}
