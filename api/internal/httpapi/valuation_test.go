package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type atRiskClass struct {
	TyreCount             int64   `json:"tyreCount"`
	ActualCount           int64   `json:"actualCount"`
	EstimatedOrAuditCount int64   `json:"estimatedOrAuditCount"`
	AuditCount            int64   `json:"auditCount"`
	UnvaluedCount         int64   `json:"unvaluedCount"`
	CasingValueAtRisk     *string `json:"casingValueAtRisk"`
}

type atRiskBody struct {
	Scope    map[string]any `json:"scope"`
	JudgedAt string         `json:"judgedAt"`
	Running  atRiskClass    `json:"running"`
	Spare    atRiskClass    `json:"spare"`
	Tyres    []struct {
		DisplayCode string  `json:"displayCode"`
		IsSpare     bool    `json:"isSpare"`
		CasingValue *string `json:"casingValue"`
		CasingBasis string  `json:"casingBasis"`
		TreadSource string  `json:"treadSource"`
	} `json:"tyres"`
}

func TestValueAtRiskIsGatedOnViewValuation(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "at-risk-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleTechnician, http.StatusForbidden},
		{auth.RoleController, http.StatusOK},
		{auth.RoleDepotManager, http.StatusOK},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/valuation/at-risk", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// Suite section 59d over HTTP: nine running tyres at risk, all nine AUDIT
// inside estimated_or_audit_count, R16,537.50; one spare, R1,837.50. The
// H.3 commercial gate is this number reaching the wire as a string.
func TestValueAtRiskRelaysTheFixtureToTheCent(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/valuation/at-risk", bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body atRiskBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "TODAY", body.JudgedAt)
	require.Equal(t, atRiskClass{TyreCount: 9, ActualCount: 0, EstimatedOrAuditCount: 9, AuditCount: 9, UnvaluedCount: 0, CasingValueAtRisk: ptr("16537.50")}, body.Running)
	require.Equal(t, int64(1), body.Spare.TyreCount)
	require.Equal(t, ptr("1837.50"), body.Spare.CasingValueAtRisk)
	require.Len(t, body.Tyres, 10)
	for _, ty := range body.Tyres {
		require.Equal(t, "AUDIT", ty.CasingBasis)
		require.NotNil(t, ty.CasingValue)
	}
	// The wire carries the decimal string, never a number: a JSON number here
	// would have been decoded as a double by every client (FR-VAL-005).
	require.Contains(t, rec.Body.String(), `"casingValueAtRisk":"16537.50"`)
}

func TestValueAtRiskSumsAcrossTheActorsDepots(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantDepotFixture(t, ctx, admin, "at-risk-scope")
	other, _ := plantTenant(t, ctx, admin, "at-risk-other")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	manager := plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	assignDepot(t, ctx, admin, f.Tenant, manager, f.DepotA)
	both := plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	assignDepot(t, ctx, admin, f.Tenant, both, f.DepotA)
	assignDepot(t, ctx, admin, f.Tenant, both, f.DepotB)
	stranger := plantUser(t, ctx, admin, other, auth.RoleController)

	read := func(path, tenant, user string) atRiskBody {
		rec := get(t, h, path, tenant, user)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body atRiskBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}
	b := read("/api/valuation/at-risk", f.Tenant.String(), controller.String())
	require.Equal(t, int64(2), b.Running.TyreCount)
	require.Equal(t, ptr("300.00"), b.Running.CasingValueAtRisk)
	require.Len(t, b.Tyres, 2)

	b = read("/api/valuation/at-risk", f.Tenant.String(), manager.String())
	require.Equal(t, int64(1), b.Running.TyreCount)
	require.Equal(t, ptr("100.00"), b.Running.CasingValueAtRisk)
	require.Equal(t, "DEPOTS", b.Scope["level"])
	require.Len(t, b.Tyres, 1)

	// Two depots, one figure, summed in SQL (U25): "across your 2 depots".
	b = read("/api/valuation/at-risk", f.Tenant.String(), both.String())
	require.Equal(t, ptr("300.00"), b.Running.CasingValueAtRisk)
	require.EqualValues(t, 2, b.Scope["depotCount"])

	b = read("/api/valuation/at-risk?depot="+f.DepotB.String(), f.Tenant.String(), controller.String())
	require.Equal(t, ptr("200.00"), b.Running.CasingValueAtRisk)
	// The manager of A naming B reads nothing, not B's figure.
	b = read("/api/valuation/at-risk?depot="+f.DepotB.String(), f.Tenant.String(), manager.String())
	require.Equal(t, int64(0), b.Running.TyreCount)
	require.Nil(t, b.Running.CasingValueAtRisk)

	b = read("/api/valuation/at-risk", other.String(), stranger.String())
	require.Equal(t, int64(0), b.Running.TyreCount)
	require.Empty(t, b.Tyres)
}

func ptr(s string) *string { return &s }

type estateRow struct {
	Level                string  `json:"level"`
	KeyName              *string `json:"keyName"`
	LocationClass        string  `json:"locationClass"`
	TyreCount            int64   `json:"tyreCount"`
	ActualCount          int64   `json:"actualCount"`
	EstimatedCount       int64   `json:"estimatedCount"`
	UnvaluedCount        int64   `json:"unvaluedCount"`
	CasingUnvaluedCount  int64   `json:"casingUnvaluedCount"`
	CasingActualCount    int64   `json:"casingActualCount"`
	CasingEstimatedCount int64   `json:"casingEstimatedCount"`
	CasingAuditCount     int64   `json:"casingAuditCount"`
	TreadValue           *string `json:"treadValue"`
	CasingValue          *string `json:"casingValue"`
	TotalValue           *string `json:"totalValue"`
}

type estateBody struct {
	Scope    map[string]any `json:"scope"`
	AsAt     string         `json:"asAt"`
	JudgedAt string         `json:"judgedAt"`
	Rows     []estateRow    `json:"rows"`
}

func TestEstateIsGatedOnViewValuation(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "estate-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	for _, tt := range []struct {
		role auth.Role
		want int
	}{{auth.RoleTechnician, http.StatusForbidden}, {auth.RoleDepotManager, http.StatusOK}, {auth.RoleController, http.StatusOK}} {
		userID := plantUser(t, ctx, admin, tenantID, tt.role)
		rec := get(t, h, "/api/valuation/estate", tenantID.String(), userID.String())
		require.Equal(t, tt.want, rec.Code, rec.Body.String())
	}
	user := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	rec := get(t, h, "/api/valuation/estate?level=CONTINENT", tenantID.String(), user.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	rec = get(t, h, "/api/valuation/estate?asAt=yesterday", tenantID.String(), user.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

// Suite section 17 over HTTP: 27 tyres, tread R20,571.00, casing
// R49,612.50, total R70,183.50, and the three casing partitions (0, 0, 27)
// that 59d pins as disjoint from the at-risk view's nested count (U27).
func TestEstateRelaysAppendixEToTheCent(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	nomsa := seedID("controller1").String()

	read := func(path string) estateBody {
		rec := get(t, h, path, bacTenant, nomsa)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body estateBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}
	all := func(rows []estateRow, key *string) estateRow {
		for _, r := range rows {
			if r.LocationClass == "ALL" && (key == nil && r.KeyName == nil || key != nil && r.KeyName != nil && *key == *r.KeyName) {
				return r
			}
		}
		t.Fatalf("no ALL row for key %v", key)
		return estateRow{}
	}

	body := read("/api/valuation/estate")
	require.Equal(t, "TODAY", body.JudgedAt)
	tenant := all(body.Rows, nil)
	require.Equal(t, "TENANT", tenant.Level)
	require.Equal(t, int64(27), tenant.TyreCount)
	require.Equal(t, ptr("20571.00"), tenant.TreadValue)
	require.Equal(t, ptr("49612.50"), tenant.CasingValue)
	require.Equal(t, ptr("70183.50"), tenant.TotalValue)
	require.Equal(t, [3]int64{0, 0, 27}, [3]int64{tenant.CasingActualCount, tenant.CasingEstimatedCount, tenant.CasingAuditCount})

	body = read("/api/valuation/estate?level=VEHICLE")
	require.Equal(t, ptr("11108.34"), all(body.Rows, ptr("HORSE")).TreadValue)
	require.Equal(t, ptr("8228.40"), all(body.Rows, ptr("LINK12")).TreadValue)
	require.Equal(t, ptr("1234.26"), all(body.Rows, ptr("LINK6")).TreadValue)

	// Section 18: as at 2026-07-01, 26 of 27 valued, tread R25,096.63. As at
	// 2026-06-01 no tyre is tread-valued yet, but the AUDIT casing fallback
	// (000036) carries no date gate, so all 27 casings still value and the
	// total is the casing side alone (TYRE-269, U36).
	body = read("/api/valuation/estate?asAt=2026-07-01")
	require.Equal(t, "2026-07-01", body.AsAt)
	july := all(body.Rows, nil)
	require.Equal(t, int64(1), july.UnvaluedCount)
	require.Equal(t, ptr("25096.63"), july.TreadValue)
	body = read("/api/valuation/estate?asAt=2026-06-01")
	june := all(body.Rows, nil)
	require.Equal(t, int64(27), june.UnvaluedCount)
	require.Nil(t, june.TreadValue)
	require.Equal(t, ptr("49612.50"), june.CasingValue)
	require.Equal(t, ptr("49612.50"), june.TotalValue)
}

// U35's drift guard: the handler's GROUP BY over app.tyre_valuation_asof
// is a copy of app.v_estate_valuation's, and this pins the copy to the view
// at the view's own day for every level, so the two cannot drift silently.
func TestEstateAtTodayMatchesTheViewForEveryLevel(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	nomsa := seedID("controller1").String()

	for _, level := range []string{"TENANT", "VEHICLE", "DEPOT", "SIZE", "BRAND", "PATTERN"} {
		t.Run(level, func(t *testing.T) {
			rec := get(t, h, "/api/valuation/estate?level="+level, bacTenant, nomsa)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			var body estateBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

			rows, err := admin.Query(ctx, `
				SELECT level, key_name, location_class, tyre_count, actual_count, estimated_count,
				       unvalued_count, casing_unvalued_count, casing_actual_count, casing_estimated_count,
				       casing_audit_count, tread_value::text, casing_value::text, total_value::text
				  FROM app.v_estate_valuation
				 WHERE tenant_id = $1 AND level = $2
				 ORDER BY key_name NULLS FIRST, location_class`, bacTenant, level)
			require.NoError(t, err)
			defer rows.Close()
			var want []estateRow
			for rows.Next() {
				var r estateRow
				require.NoError(t, rows.Scan(&r.Level, &r.KeyName, &r.LocationClass, &r.TyreCount, &r.ActualCount, &r.EstimatedCount,
					&r.UnvaluedCount, &r.CasingUnvaluedCount, &r.CasingActualCount, &r.CasingEstimatedCount,
					&r.CasingAuditCount, &r.TreadValue, &r.CasingValue, &r.TotalValue))
				want = append(want, r)
			}
			require.NoError(t, rows.Err())
			require.NotEmpty(t, want)
			require.Equal(t, want, body.Rows)
		})
	}
}

func TestEstateIsDepotScopedByDepotId(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantDepotFixture(t, ctx, admin, "estate-scope")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	manager := plantUser(t, ctx, admin, f.Tenant, auth.RoleDepotManager)
	assignDepot(t, ctx, admin, f.Tenant, manager, f.DepotA)

	read := func(path, user string) estateBody {
		rec := get(t, h, path, f.Tenant.String(), user)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body estateBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return body
	}
	tenantAll := read("/api/valuation/estate", controller.String()).Rows
	require.Equal(t, int64(2), tenantAll[0].TyreCount)
	require.Equal(t, ptr("300.00"), tenantAll[0].CasingValue)

	mine := read("/api/valuation/estate", manager.String()).Rows
	require.Equal(t, int64(1), mine[0].TyreCount)
	require.Equal(t, ptr("100.00"), mine[0].CasingValue)

	// SIZE, BRAND and PATTERN aggregate the whole tenant in the view; the
	// function path scopes them by depot_id before grouping (U35).
	sizes := read("/api/valuation/estate?level=SIZE", manager.String()).Rows
	require.Equal(t, int64(1), sizes[0].TyreCount)

	named := read("/api/valuation/estate?depot="+f.DepotB.String(), controller.String()).Rows
	require.Equal(t, ptr("200.00"), named[0].CasingValue)

	// The manager of A naming B reads the same answer an empty tenant reads,
	// which is what ADR-0011 asks for: ROLLUP emits its grand total over an
	// empty scope, so the row is there with no tyres in it and no money.
	outside := read("/api/valuation/estate?depot="+f.DepotB.String(), manager.String()).Rows
	require.Len(t, outside, 1)
	require.Equal(t, "ALL", outside[0].LocationClass)
	require.Equal(t, int64(0), outside[0].TyreCount)
	require.Nil(t, outside[0].CasingValue)
	require.Nil(t, outside[0].TreadValue)
	require.Nil(t, outside[0].TotalValue)
}
