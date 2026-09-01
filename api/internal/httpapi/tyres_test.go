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

type receivedTyresBody struct {
	Tyres []struct {
		ID          string `json:"id"`
		DisplayCode string `json:"displayCode"`
	} `json:"tyres"`
}

// plantGeneratedPolicyTenant is a tenant under D12's GENERATED display-code
// scheme (BAC's own policy) — the counter row app.receive_tyres's issuing
// branch reads is seeded here rather than relying on a seed fixture, per
// plantTenant's own rationale: the Go suite runs against a migrated but
// unseeded database.
//
// display_code_counter.tenant_id (000030) is the one tenant-scoped FK in the
// whole schema with no ON DELETE CASCADE — every other one has it. Without
// this explicit cleanup, plantTenant's own t.Cleanup (already registered)
// tries to delete the tenant first and dies on
// display_code_counter_tenant_id_fkey; t.Cleanup runs LIFO, so registering
// this one after plantTenant's runs it first.
func plantGeneratedPolicyTenant(t *testing.T, ctx context.Context, admin *pgx.Conn, label, prefix string) uuid.UUID {
	t.Helper()
	tenantID, _ := plantTenant(t, ctx, admin, label)
	_, err := admin.Exec(ctx,
		`UPDATE app.tenant SET display_code_policy = 'GENERATED' WHERE id = $1`, tenantID)
	require.NoError(t, err)
	_, err = admin.Exec(ctx,
		`INSERT INTO app.display_code_counter (tenant_id, prefix) VALUES ($1, $2)`, tenantID, prefix)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(),
			`DELETE FROM app.display_code_counter WHERE tenant_id = $1`, tenantID)
		require.NoError(t, err)
	})
	return tenantID
}

// FR-TYR-040: receiving a tyre is the point it becomes trackable. A FREE
// tenant (plantTenant's default policy, migration 000030) brands its own,
// so a hand-typed code is required and forwarded straight through.
func TestReceiveTyresHappyPath(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "receive-happy")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	code := "RECV-" + uuid.NewString()[:8]
	body := `{"displayCode":"` + code + `","newTreadMm":"14.0"}`
	rec := post(t, h, "/api/tyres", tenantID.String(), controller.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var out receivedTyresBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Len(t, out.Tyres, 1)
	require.Equal(t, code, out.Tyres[0].DisplayCode)
	require.NotEmpty(t, out.Tyres[0].ID)

	var landedTenant, state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id, state::text FROM app.tyre WHERE id = $1`, out.Tyres[0].ID).
		Scan(&landedTenant, &state))
	require.Equal(t, tenantID.String(), landedTenant)
	require.Equal(t, "IN_STOCK", state)
}

// Gated on ManageAssets like the other write paths — a TECHNICIAN holds
// ViewFleet and no more.
func TestReceiveTyresIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "receive-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	body := `{"displayCode":"GATE-` + uuid.NewString()[:8] + `"}`
	rec := post(t, h, "/api/tyres", tenantID.String(), tech.String(), body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// D12: the display-code policy is enforced by app.receive_tyres itself
// (TY011), and its own message is forwarded verbatim (ADR-0012's TY class) —
// this pins both directions of the policy through the handler.
func TestReceiveTyresDisplayCodePolicyRefusals(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// GENERATED (BAC's own policy): a hand-typed code is refused outright,
	// never merely warned about (D12).
	genTenant := plantGeneratedPolicyTenant(t, ctx, admin, "receive-gen", "GEN")
	genController := plantUser(t, ctx, admin, genTenant, auth.RoleController)
	rec := post(t, h, "/api/tyres", genTenant.String(), genController.String(),
		`{"displayCode":"HAND-TYPED"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY011", ref.Code)
	require.Equal(t,
		"this fleet's display codes are issued by the platform; leave the code blank and the next one is assigned",
		ref.Message)

	// FREE (the default): the tenant brands its own, so omitting the code
	// is refused rather than silently generating one.
	freeTenant, _ := plantTenant(t, ctx, admin, "receive-free")
	freeController := plantUser(t, ctx, admin, freeTenant, auth.RoleController)
	rec = post(t, h, "/api/tyres", freeTenant.String(), freeController.String(), `{}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY011", ref.Code)
	require.Equal(t, "this fleet brands its own tyres; enter the code branded on the sidewall", ref.Message)
}

// one_active_display_code_per_tenant (000011) scopes uniqueness to ACTIVE
// tyres, but a second receive of the same code while the first is still
// active collides, and ADR-0013 decision 3 names it its own wire code rather
// than a bare conflict.
func TestReceiveTyresDuplicateDisplayCodeIsConflict(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "receive-dup")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	code := "DUP-" + uuid.NewString()[:8]
	body := `{"displayCode":"` + code + `"}`
	rec := post(t, h, "/api/tyres", tenantID.String(), controller.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/tyres", tenantID.String(), controller.String(), body)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "display_code_taken", ref.Code)
	require.NotContains(t, rec.Body.String(), "one_active_display_code_per_tenant",
		"the constraint name is translated, never forwarded (ADR-0012)")
}

// A negative quantity must reach app.receive_tyres and be refused as its own
// TY011, not be silently coerced to the COALESCE default of 1 by payload()'s
// omission logic — the bound is the function's rule, and a client that sends
// garbage is told so rather than having a tyre minted from it (ADR-0013
// decision 5: the bound is not re-checked in Go, but it must not be swallowed
// either).
func TestReceiveTyresNegativeQuantityIsRefusedNotCoerced(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "receive-negqty")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	code := "NEGQTY-" + uuid.NewString()[:8]
	rec := post(t, h, "/api/tyres", tenantID.String(), controller.String(),
		`{"quantity":-5,"displayCode":"`+code+`"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY011", ref.Code)
	require.Equal(t, "a receive is between 1 and 200 tyres", ref.Message)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.tyre WHERE display_code = $1`, code).Scan(&landed))
	require.Zero(t, landed, "a refused receive must not have minted a tyre from the coerced default")
}

// FR-TYR-041: costing discharges the awaiting-cost backlog CFL-002 names.
func TestSetTyreCostHappyPath(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "cost-happy")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	tyreID := plantTyre(t, ctx, admin, tenantID, "COST-"+uuid.NewString()[:8], nil)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/cost", tenantID.String(), controller.String(),
		`{"price":"1500.00","source":"INVOICE"}`)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	var price string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT purchase_price::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&price))
	require.Equal(t, "1500.00", price)
}

func TestSetTyreCostIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "cost-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	tyreID := plantTyre(t, ctx, admin, tenantID, "COSTGATE-"+uuid.NewString()[:8], nil)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/cost", tenantID.String(), tech.String(),
		`{"price":"1500.00","source":"INVOICE"}`)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// app.set_tyre_cost's own TY013: a second costing is refused rather than
// silently overwriting provenance already recorded (000031's own comment —
// a correction is a decision this surface does not take).
func TestSetTyreCostTwiceIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "cost-twice")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	price := "900.00"
	tyreID := plantTyre(t, ctx, admin, tenantID, "COSTTWICE-"+uuid.NewString()[:8], &price)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/cost", tenantID.String(), controller.String(),
		`{"price":"1.00","source":"INVOICE"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY013", ref.Code)
	require.Equal(t, "this tyre's cost is already recorded", ref.Message)
}

// Appendix C's disposal vocabulary: a scrap moves a tyre out of the estate
// and records why.
func TestDisposeTyreHappyPath(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispose-happy")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	tyreID := plantTyre(t, ctx, admin, tenantID, "DISPOSE-"+uuid.NewString()[:8], nil)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispose", tenantID.String(), controller.String(),
		`{"disposal":"SCRAPPED","reason":"sidewall breach"}`)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())

	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "SCRAPPED", state)
}

func TestDisposeTyreIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispose-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	tyreID := plantTyre(t, ctx, admin, tenantID, "DISPOSEGATE-"+uuid.NewString()[:8], nil)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispose", tenantID.String(), tech.String(),
		`{"disposal":"SCRAPPED","reason":"sidewall breach"}`)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

// Appendix C: a sale is REMOVED -> SOLD only. A freshly received tyre sits
// IN_STOCK, so a sale attempt is refused by app.dispose_tyre's own
// transition check.
func TestDisposeTyreSaleFromInStockIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispose-sale")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	tyreID := plantTyre(t, ctx, admin, tenantID, "SALEBAD-"+uuid.NewString()[:8], nil)
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispose", tenantID.String(), controller.String(),
		`{"disposal":"SOLD","proceeds":"100.00"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "a tyre is sold from REMOVED only; this one is IN_STOCK (Appendix C)", ref.Message)
}

// The cross-tenant probe (B4's TestWriteAimedAtAnotherTenantIsRefused shape,
// adapted): these two endpoints take the tyre id from the URL and the tenant
// only from the session, so RLS's USING half — not WITH CHECK — is what has
// to refuse a tenant-2 actor naming a tenant-1 id. app.set_tyre_cost and
// app.dispose_tyre answer 422 TY012 "no such tyre in this fleet" for both a
// genuinely missing id and one RLS has hidden (db/tests/004_tests.sql
// section 39l/39m), so each fixture below is planted so that a leak — RLS
// letting the row through — would make the call SUCCEED instead of merely
// changing the error text: tenant A's tyre is deliberately uncosted for the
// costing probe, and deliberately REMOVED (a legal SOLD source) for the
// disposal probe. Either endpoint answering anything but 422 TY012 here
// means the row leaked.
func TestTyreWriteCrossTenantIsInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "crosstenant-a")
	tenantB, _ := plantTenant(t, ctx, admin, "crosstenant-b")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controllerB := plantUser(t, ctx, admin, tenantB, auth.RoleController)

	t.Run("costing", func(t *testing.T) {
		uncostedA := plantTyre(t, ctx, admin, tenantA, "XTEN-COST-"+uuid.NewString()[:8], nil)
		rec := post(t, h, "/api/tyres/"+uncostedA.String()+"/cost", tenantB.String(), controllerB.String(),
			`{"price":"50.00","source":"INVOICE"}`)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
			"tenant B costed tenant A's tyre: RLS leaked the row (got %s)", rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY012", ref.Code)
		require.Equal(t, "no such tyre in this fleet", ref.Message)

		var stillUncosted *string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT purchase_price::text FROM app.tyre WHERE id = $1`, uncostedA).Scan(&stillUncosted))
		require.Nil(t, stillUncosted, "tenant A's tyre must not have been priced by tenant B's request")
	})

	t.Run("disposal", func(t *testing.T) {
		removedA := plantTyre(t, ctx, admin, tenantA, "XTEN-DISP-"+uuid.NewString()[:8], nil)
		_, err := admin.Exec(ctx, `UPDATE app.tyre SET state = 'REMOVED' WHERE id = $1`, removedA)
		require.NoError(t, err)

		rec := post(t, h, "/api/tyres/"+removedA.String()+"/dispose", tenantB.String(), controllerB.String(),
			`{"disposal":"SOLD","proceeds":"100.00"}`)
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
			"tenant B disposed tenant A's tyre: RLS leaked the row (got %s)", rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY012", ref.Code)
		require.Equal(t, "no such tyre in this fleet", ref.Message)

		var state string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT state::text FROM app.tyre WHERE id = $1`, removedA).Scan(&state))
		require.Equal(t, "REMOVED", state, "tenant A's tyre must not have been disposed by tenant B's request")
	})
}
