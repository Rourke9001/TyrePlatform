package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type tyreBody struct {
	ID            string  `json:"id"`
	DisplayCode   string  `json:"displayCode"`
	State         string  `json:"state"`
	Status        string  `json:"status"`
	RetreadCount  int     `json:"retreadCount"`
	SizeName      *string `json:"sizeName"`
	BrandName     *string `json:"brandName"`
	PatternName   *string `json:"patternName"`
	ReceivedDate  *string `json:"receivedDate"`
	AwaitingCost  bool    `json:"awaitingCost"`
	PurchasePrice *string `json:"purchasePrice"`
	RandPerMm     *string `json:"randPerMm"`
	CasingValue   *string `json:"casingValue"`
}

type tyresListBody struct {
	Tyres []tyreBody `json:"tyres"`
}

// plantTyre inserts a tyre directly through the admin connection, the way
// every other fixture in this package plants data (httpapi_test.go's
// plantCaptureFixture): app.receive_tyres needs a tenant bound in session
// state that the admin connection does not carry, so the register's own
// write path is not available to a test fixture yet — Task 8 builds it.
func plantTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, code string, purchasePrice *string) uuid.UUID {
	t.Helper()
	var tyreID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tyre (tenant_id, display_code, purchase_price, new_tread_mm, rand_per_mm)
		 VALUES ($1, $2, $3::numeric, 14.0, 250.0000) RETURNING id`,
		tenantID, code, purchasePrice,
	).Scan(&tyreID))
	return tyreID
}

// plantScrappedTyre plants a tyre with no purchase price that has already
// left the estate — the case that distinguishes app.v_tyre_awaiting_cost's
// actual predicate (migration 000012: purchase_price IS NULL AND state NOT
// IN ('SCRAPPED','LOST','SOLD')) from a bare "purchase_price IS NULL" check.
func plantScrappedTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, code string) uuid.UUID {
	t.Helper()
	var tyreID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tyre (tenant_id, display_code, new_tread_mm, state)
		 VALUES ($1, $2, 14.0, 'SCRAPPED') RETURNING id`,
		tenantID, code,
	).Scan(&tyreID))
	return tyreID
}

// plantBrandedEvent records the dated event app.tyre_for_code resolves
// through (FR-TYR-042), in the same shape app.receive_tyres writes it
// (migration 000031).
func plantBrandedEvent(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, tyreID uuid.UUID, code string, occurredAt time.Time) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
		 VALUES ($1, $2, 'BRANDED', $3, jsonb_build_object('display_code', $4::text))`,
		tenantID, tyreID, occurredAt, code)
	require.NoError(t, err)
}

// The register is gated on ManageAssets, not ViewFleet: a TECHNICIAN reads
// the fleet but does not act on assets, so it is refused here exactly like a
// DRIVER (FR-AUT-005's "what may be asked for", not only what comes back).
func TestListTyresIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tyres-gate")
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
			rec := get(t, h, "/api/tyres", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// Tenant isolation lives in the database (CLAUDE.md rule 1); this is the
// handler-level proof that the register never crosses it.
func TestListTyresScopedToTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "tyres-a")
	tenantB, _ := plantTenant(t, ctx, admin, "tyres-b")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	suffix := uuid.NewString()[:8]
	codeA, codeB := "TYRE-A-"+suffix, "TYRE-B-"+suffix
	plantTyre(t, ctx, admin, tenantA, codeA, nil)
	plantTyre(t, ctx, admin, tenantB, codeB, nil)

	controllerA := plantUser(t, ctx, admin, tenantA, auth.RoleController)
	rec := get(t, h, "/api/tyres", tenantA.String(), controllerA.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	var codes []string
	for _, ty := range body.Tyres {
		codes = append(codes, ty.DisplayCode)
	}
	require.Contains(t, codes, codeA)
	require.NotContains(t, codes, codeB, "tenant A's response must never contain tenant B's tyre")
}

// FR-TYR-042: a display code is reissued once a tyre leaves the estate, so
// resolving one to a tyre only makes sense for a specific date.
func TestListTyresCodeAndDateLookup(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tyres-code")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	suffix := uuid.NewString()[:8]
	code := "CODE-" + suffix
	tyreID := plantTyre(t, ctx, admin, tenantID, code, nil)
	brandedAt := time.Now().AddDate(0, 0, -30)
	plantBrandedEvent(t, ctx, admin, tenantID, tyreID, code, brandedAt)

	// On or after the branding event, the code resolves to this tyre alone.
	on := brandedAt.AddDate(0, 0, 1).Format("2006-01-02")
	rec := get(t, h, "/api/tyres?code="+code+"&on="+on, tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Tyres, 1)
	require.Equal(t, tyreID.String(), body.Tyres[0].ID)

	// Before the branding event, the code names nobody yet.
	before := brandedAt.AddDate(0, 0, -1).Format("2006-01-02")
	rec = get(t, h, "/api/tyres?code="+code+"&on="+before, tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Empty(t, body.Tyres)

	// code and on are named together or not at all.
	rec = get(t, h, "/api/tyres?code="+code, tenantID.String(), controller.String())
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	rec = get(t, h, "/api/tyres?on="+on, tenantID.String(), controller.String())
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	// A malformed on is a client mistake refused before any query runs — not
	// a 500 from Postgres failing to cast it to ::date (ADR-0013 decision 5).
	rec = get(t, h, "/api/tyres?code="+code+"&on=not-a-date", tenantID.String(), controller.String())
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Equal(t, "on must be a date as YYYY-MM-DD", ref.Message)
}

// CFL-002: a tyre received with no purchase price yet is the awaiting-cost
// backlog app.v_tyre_awaiting_cost names — but that view also excludes a
// disposed tyre (SCRAPPED/LOST/SOLD), so a never-costed tyre that has since
// left the estate must not be reported as awaiting cost either by the filter
// or by the per-row flag in the unfiltered list; the two must agree, because
// they read the same view (migration 000012).
func TestListTyresAwaitingCostFilter(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tyres-awaiting")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	suffix := uuid.NewString()[:8]
	costed := "COSTED-" + suffix
	price := "1500.00"
	plantTyre(t, ctx, admin, tenantID, costed, &price)
	uncosted := "UNCOSTED-" + suffix
	plantTyre(t, ctx, admin, tenantID, uncosted, nil)
	scrapped := "SCRAPPED-" + suffix
	plantScrappedTyre(t, ctx, admin, tenantID, scrapped)

	rec := get(t, h, "/api/tyres?awaitingCost=true", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	var codes []string
	for _, ty := range body.Tyres {
		codes = append(codes, ty.DisplayCode)
	}
	require.Contains(t, codes, uncosted)
	require.NotContains(t, codes, costed, "a tyre with a recorded purchase price is not awaiting cost")
	require.NotContains(t, codes, scrapped, "a disposed tyre is not awaiting cost even with no purchase price recorded")

	// Unfiltered, all three tyres are visible, and each one's own flag must
	// match the set the filter above just proved.
	rec = get(t, h, "/api/tyres", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	byCode := map[string]tyreBody{}
	for _, ty := range body.Tyres {
		byCode[ty.DisplayCode] = ty
	}
	require.Contains(t, byCode, uncosted)
	require.Contains(t, byCode, costed, "the unfiltered list still shows a costed tyre")
	require.Contains(t, byCode, scrapped, "the unfiltered list still shows a disposed tyre")
	require.True(t, byCode[uncosted].AwaitingCost)
	require.False(t, byCode[costed].AwaitingCost)
	require.False(t, byCode[scrapped].AwaitingCost,
		"a disposed tyre's own flag must not claim it is awaiting cost, even though purchase_price IS NULL alone would say so")
}

// Every role that can reach this endpoint (ManageAssets) also holds
// ViewValuation today, so this is the handler-level half of the money
// projection: money is genuinely sent, not merely absent because the
// fixture forgot to check. tyres_internal_test.go proves the hidden half,
// which no handler-driven test can reach (FR-AUT-005a).
func TestListTyresIncludesMoneyForAViewValuationHolder(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tyres-money")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	suffix := uuid.NewString()[:8]
	code := "MONEY-" + suffix
	price := "2000.00"
	plantTyre(t, ctx, admin, tenantID, code, &price)

	rec := get(t, h, "/api/tyres", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body tyresListBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	var found *tyreBody
	for i := range body.Tyres {
		if body.Tyres[i].DisplayCode == code {
			found = &body.Tyres[i]
		}
	}
	require.NotNil(t, found, "the planted tyre must appear in the list")
	require.NotNil(t, found.PurchasePrice)
	require.Equal(t, "2000.00", *found.PurchasePrice)
}
