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

type exceptionsBody struct {
	Scope      map[string]any `json:"scope"`
	JudgedAt   string         `json:"judgedAt"`
	Exceptions []struct {
		RuleCode          string          `json:"ruleCode"`
		Severity          string          `json:"severity"`
		Urgent            bool            `json:"urgent"`
		SubjectType       string          `json:"subjectType"`
		FleetNumber       string          `json:"fleetNumber"`
		PositionCode      *string         `json:"positionCode"`
		ThresholdMm       *float64        `json:"thresholdMm"`
		Detail            json.RawMessage `json:"detail"`
		ResolvedByFitment bool            `json:"resolvedByFitment"`
	} `json:"exceptions"`
}

func TestListExceptionsIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "exceptions-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleTechnician, http.StatusOK},
		{auth.RoleController, http.StatusOK},
		{auth.RoleDepotManager, http.StatusOK},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/exceptions", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
	// No identity at all is 401, not an empty list.
	rec := get(t, h, "/api/exceptions", "", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}

// The three-tier agreement (CLAUDE.md, Testing): the API relays exactly
// what suite section 59b pins, 19 rows, 11 urgent, 9 on FR-EXC-020, and
// the per-rule breakdown 020:9, 021:1, 022:1, 035:6, 036:1, 038:1.
func TestListExceptionsRelaysTheAppendixJFixture(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	nomsa := seedID("controller1").String()

	rec := get(t, h, "/api/exceptions", bacTenant, nomsa)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body exceptionsBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "SUBMITTED_AT", body.JudgedAt)
	require.Len(t, body.Exceptions, 19)

	byRule := map[string]int{}
	urgent := 0
	for _, e := range body.Exceptions {
		byRule[e.RuleCode]++
		if e.Urgent {
			urgent++
		}
		require.False(t, e.ResolvedByFitment)
		require.NotEmpty(t, e.Detail)
	}
	require.Equal(t, 11, urgent)
	require.Equal(t, map[string]int{"FR-EXC-020": 9, "FR-EXC-021": 1, "FR-EXC-022": 1, "FR-EXC-035": 6, "FR-EXC-036": 1, "FR-EXC-038": 1}, byRule)

	// Every 020 row carries the threshold it was judged against (U18).
	for _, e := range body.Exceptions {
		if e.RuleCode == "FR-EXC-020" {
			require.NotNil(t, e.ThresholdMm)
			require.Equal(t, 4.0, *e.ThresholdMm)
		}
	}

	// Filters narrow, never widen.
	rec = get(t, h, "/api/exceptions?rule=FR-EXC-020", bacTenant, nomsa)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Exceptions, 9)
	rec = get(t, h, "/api/exceptions?severity=CRITICAL", bacTenant, nomsa)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Exceptions, 11)
	rec = get(t, h, "/api/exceptions?vehicle="+seedID("veh1").String(), bacTenant, nomsa)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.NotEmpty(t, body.Exceptions)
	for _, e := range body.Exceptions {
		require.Equal(t, "HORSE", e.FleetNumber)
	}
}

func TestListExceptionsRefusesMalformedFilters(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "exceptions-params")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	user := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	rec := get(t, h, "/api/exceptions?vehicle=not-a-uuid", tenantID.String(), user.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Equal(t, "vehicle must be a uuid", ref.Message)
	// A severity outside the enum is judged by the cast, canned 422
	// (listDepots does the same with ?type=).
	rec = get(t, h, "/api/exceptions?severity=LOUD", tenantID.String(), user.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}

func TestListExceptionsIsTenantAndDepotScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantDepotFixture(t, ctx, admin, "exceptions-scope")
	other, _ := plantTenant(t, ctx, admin, "exceptions-other")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	technician := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	assignDepot(t, ctx, admin, f.Tenant, technician, f.DepotA)
	unassigned := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	stranger := plantUser(t, ctx, admin, other, auth.RoleController)

	count := func(path, tenant, user string) (int, map[string]any) {
		rec := get(t, h, path, tenant, user)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var body exceptionsBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		return len(body.Exceptions), body.Scope
	}

	n, scope := count("/api/exceptions", f.Tenant.String(), controller.String())
	require.Equal(t, 2, n)
	require.Equal(t, "TENANT", scope["level"])

	n, scope = count("/api/exceptions", f.Tenant.String(), technician.String())
	require.Equal(t, 1, n)
	require.Equal(t, "DEPOTS", scope["level"])
	require.EqualValues(t, 1, scope["depotCount"])

	n, _ = count("/api/exceptions?depot="+f.DepotB.String(), f.Tenant.String(), controller.String())
	require.Equal(t, 1, n)
	// A depot outside the technician's own reads as nothing, not as 403
	// (ADR-0011: not yours and does not exist are the same answer).
	n, _ = count("/api/exceptions?depot="+f.DepotB.String(), f.Tenant.String(), technician.String())
	require.Equal(t, 0, n)
	n, _ = count("/api/exceptions", f.Tenant.String(), unassigned.String())
	require.Equal(t, 0, n)
	n, _ = count("/api/exceptions", other.String(), stranger.String())
	require.Equal(t, 0, n)
}
