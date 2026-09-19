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
