package httpapi_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
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
// state that the admin connection does not carry, so a fixture cannot drive
// it directly regardless of which handlers exist.
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

// CFL-002: listTyres's doc comment (tyres.go — the awaitingCost filter and
// the per-row flag must agree) is what this pins, for both a costed and a
// disposed tyre.
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

// The handler-level half of tyreJSONFor's projection (tyres.go's doc
// comment): money is genuinely sent, not merely absent because the fixture
// forgot to check. tyres_internal_test.go proves the hidden half.
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

// An out-of-range quantity must reach app.receive_tyres and be refused as its
// own TY011, not be silently coerced to the COALESCE default of 1 by
// payload()'s omission logic — the bound is the function's rule, and a client
// that sends garbage is told so rather than having a tyre minted from it
// (ADR-0013 decision 5: the bound is not re-checked in Go, but it must not be
// swallowed either). Zero is the case that made Quantity a pointer: it is
// both out of range and Go's zero value, so an int field could not tell it
// apart from an absent key and answered 201 with a tyre minted and a display
// code burned.
func TestReceiveTyresOutOfRangeQuantityIsRefusedNotCoerced(t *testing.T) {
	for _, tc := range []struct {
		name     string
		quantity string
	}{
		{"negative", "-5"},
		{"zero", "0"},
		{"above the bulk bound", "201"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			s, admin := testStore(t, ctx)
			tenantID, _ := plantTenant(t, ctx, admin, "receive-qty-"+tc.name)
			h := httpapi.New(s, httpapi.HeaderActorResolver{})
			controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

			code := "QTY-" + uuid.NewString()[:8]
			rec := post(t, h, "/api/tyres", tenantID.String(), controller.String(),
				`{"quantity":`+tc.quantity+`,"displayCode":"`+code+`"}`)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "TY011", ref.Code)
			require.Equal(t, "a receive is between 1 and 200 tyres", ref.Message)

			var landed int
			require.NoError(t, admin.QueryRow(ctx,
				`SELECT count(*) FROM app.tyre WHERE tenant_id = $1`, tenantID).Scan(&landed))
			require.Zero(t, landed, "a refused receive must not have minted a tyre from the coerced default")
		})
	}
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

// U7: a path id that does not even parse as a uuid is a malformed request,
// not an invalid submission, so it never reaches app.set_tyre_cost or
// app.dispose_tyre (pathID, TYRE-92).
func TestTyreWriteMalformedIDIsBadRequest(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "malformed-id")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	for _, tt := range []struct{ name, path, body string }{
		{"cost", "/api/tyres/not-a-uuid/cost", `{"price":"1.00","source":"INVOICE"}`},
		{"dispose", "/api/tyres/not-a-uuid/dispose", `{"disposal":"SCRAPPED","reason":"x"}`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, tt.path, tenantID.String(), controller.String(), tt.body)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "bad_request", ref.Code)
		})
	}
}

// The cross-tenant probe (B4's TestWriteAimedAtAnotherTenantIsRefused shape,
// adapted): every function-backed write here takes the tyre id from the URL
// and the tenant only from the session, so RLS's USING half — not WITH CHECK
// — is what has to refuse a tenant-2 actor naming a tenant-1 id. All four
// functions answer 422 TY012 "no such tyre in this fleet" for both a
// genuinely missing id and one RLS has hidden (db/tests/004_tests.sql
// section 39l/39m), so each fixture below is planted so that a leak — RLS
// letting the row through — would make the call SUCCEED instead of merely
// changing the error text: tenant A's tyre is deliberately uncosted for the
// costing probe, deliberately REMOVED (a legal SOLD source) for the disposal
// probe and (with tenant B's own cap and retreader) for the dispatch probe,
// and deliberately AT_BREAKDOWN_SUPPLIER for the return probe. Any endpoint
// answering anything but 422 TY012 here means the row leaked.
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

	// A leak would let this one get all the way to its INSERT: tenant A's
	// casing is REMOVED and has never been retreaded, and the depot named is
	// tenant B's own active RETREADER under tenant B's own cap of 2, so every
	// branch app.dispatch_tyre checks after the tyre lookup passes. The
	// message is pinned as well as the code because a leak answers a
	// DIFFERENT refusal rather than this one reworded — past the lookup it
	// would reach retread_job's composite (tenant_id, tyre_id) FK, whose pair
	// is unsatisfiable across tenants, and answer 23503.
	t.Run("dispatch", func(t *testing.T) {
		removedA := plantRemovedTyre(t, ctx, admin, tenantA, "XTEN-DISPATCH-"+uuid.NewString()[:8])
		plantFleetRetreadPolicy(t, ctx, admin, tenantB, 2)
		retreaderB, _ := plantDepotOfType(t, ctx, admin, tenantB, "RETREADER")

		rec := post(t, h, "/api/tyres/"+removedA.String()+"/dispatch", tenantB.String(), controllerB.String(),
			fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q}`, retreaderB))
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
			"tenant B dispatched tenant A's tyre: RLS leaked the row (got %s)", rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY012", ref.Code)
		require.Equal(t, "no such tyre in this fleet", ref.Message)

		var state string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT state::text FROM app.tyre WHERE id = $1`, removedA).Scan(&state))
		require.Equal(t, "REMOVED", state, "tenant A's casing did not leave its workshop")
		var jobs int
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT count(*) FROM app.retread_job WHERE tyre_id = $1`, removedA).Scan(&jobs))
		require.Zero(t, jobs, "no job was opened against another fleet's casing")
	})

	// A leak would let this one SUCCEED outright: tenant A's casing is at a
	// breakdown supplier, which is one of the two states that restock, and
	// the depot named is tenant B's own active STORE, so the tyre lookup is
	// the only thing left that can refuse it.
	t.Run("return", func(t *testing.T) {
		awayA := plantTyre(t, ctx, admin, tenantA, "XTEN-RETURN-"+uuid.NewString()[:8], nil)
		_, err := admin.Exec(ctx,
			`UPDATE app.tyre SET state = 'AT_BREAKDOWN_SUPPLIER' WHERE id = $1`, awayA)
		require.NoError(t, err)
		storeB, _ := plantDepotOfType(t, ctx, admin, tenantB, "STORE")

		rec := post(t, h, "/api/tyres/"+awayA.String()+"/return", tenantB.String(), controllerB.String(),
			fmt.Sprintf(`{"depotId":%q}`, storeB))
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code,
			"tenant B restocked tenant A's tyre: RLS leaked the row (got %s)", rec.Body.String())
		var ref refusalBody
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
		require.Equal(t, "TY012", ref.Code)
		require.Equal(t, "no such tyre in this fleet", ref.Message)

		var state string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT state::text FROM app.tyre WHERE id = $1`, awayA).Scan(&state))
		require.Equal(t, "AT_BREAKDOWN_SUPPLIER", state, "tenant A's casing is still away")
	})
}

// dispatchedBody is POST /api/tyres/{id}/dispatch's answer. The pointer is
// the point: a dispatch to the breakdown supplier opens no retread job, and
// the key is absent rather than null for it.
type dispatchedBody struct {
	RetreadJobID *string `json:"retreadJobId"`
}

// plantRemovedTyre is plantTyre for a casing already off a unit — the one
// state app.dispatch_tyre accepts (Appendix C lists no dispatch out of
// stock, 000033).
func plantRemovedTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, code string) uuid.UUID {
	t.Helper()
	tyreID := plantTyre(t, ctx, admin, tenantID, code, nil)
	_, err := admin.Exec(ctx, `UPDATE app.tyre SET state = 'REMOVED' WHERE id = $1`, tyreID)
	require.NoError(t, err)
	return tyreID
}

// plantFleetRetreadPolicy plants the tenant-wide cap app.dispatch_tyre and
// app.log_retread_return both resolve (U5: a REMOVED casing has no axle
// class, so the per-class rows cannot govern it). A Go-planted tenant has no
// threshold_policy row at all, and an absent cap is TY015 rather than
// unlimited, so every dispatch fixture needs this one.
//
// effective_from is backdated for plantRetreadPolicy's reason: both
// resolvers require effective_from <= now(), and a row stamped by its own
// DEFAULT now() in an earlier statement is not reliably earlier than the
// now() the handler's transaction reads.
func plantFleetRetreadPolicy(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, maxRetreads int) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.threshold_policy (tenant_id, operating_group_id, axle_class, max_retreads, effective_from)
		 VALUES ($1, NULL, NULL, $2, now() - interval '1 hour')`,
		tenantID, maxRetreads)
	require.NoError(t, err)
}

// plantDepotOfType plants one depot of a named type. A dispatch is refused
// unless the depot's type matches the destination (FR-FIT-012/013), so the
// type is this fixture's whole point and never left to the column default.
func plantDepotOfType(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, depotType string) (uuid.UUID, string) {
	t.Helper()
	name := strings.ToLower(depotType) + "-" + uuid.NewString()[:8]
	var depotID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, $3::app.depot_type) RETURNING id`,
		tenantID, name, depotType,
	).Scan(&depotID))
	return depotID, name
}

// tenantToday is the tenant's own civil date (rule 6), which is what
// app.dispatch_tyre and app.log_retread_return compare a sentOn/returnedOn
// against. A test sending the runner's own now()::date instead would pass
// for most of the day and fail either side of a tenant's midnight.
func tenantToday(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID) string {
	t.Helper()
	var today string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT app.tenant_today(tn.timezone)::text FROM app.tenant tn WHERE tn.id = $1`,
		tenantID).Scan(&today))
	return today
}

// FR-FIT-011: sending a casing to the retreader is what opens the job the
// retread queue reads, so the two are asserted together — the id the
// dispatch answers is the id the queue lists, and it reads zero days out
// because it left today.
func TestDispatchToRetreaderOpensAJob(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispatch-opens-job")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	retreader, retreaderName := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "DISPATCH-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispatch", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q}`, retreader))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created dispatchedBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.NotNil(t, created.RetreadJobID, "a dispatch to the retreader opens a job")

	jobsRec := get(t, h, "/api/retread-jobs?open=true", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, jobsRec.Code, jobsRec.Body.String())
	var jobs []retreadJobBody
	require.NoError(t, json.Unmarshal(jobsRec.Body.Bytes(), &jobs))
	require.Len(t, jobs, 1)
	require.Equal(t, *created.RetreadJobID, jobs[0].ID, "the queue lists the job the dispatch answered")
	require.Equal(t, tyreID.String(), jobs[0].TyreID)
	require.Equal(t, retreaderName, jobs[0].DepotName)
	require.Equal(t, 0, jobs[0].DaysOut, "a casing sent today has been out no days")

	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "AT_RETREADER", state)
}

// U2: Appendix C lists no dispatch out of stock, so a casing still in the
// store is refused by the transition table rather than by anything here. The
// cap is planted so that state refusal is the only one this request can meet
// — without it an unconfigured policy would answer TY015 and the test would
// pass for the wrong reason.
func TestDispatchFromInStockIsTY012(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispatch-in-stock")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	retreader, _ := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	tyreID := plantTyre(t, ctx, admin, tenantID, "IN-STOCK-"+uuid.NewString()[:8], nil)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispatch", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q}`, retreader))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY012", ref.Code)
	require.Equal(t, "this tyre is IN_STOCK; a dispatch is from REMOVED only", ref.Message)

	var jobs int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.retread_job WHERE tyre_id = $1`, tyreID).Scan(&jobs))
	require.Zero(t, jobs, "a refused dispatch opens no job")
}

// BR-FIT-009 on the way out, and the fail-without-it test for TY015's entry
// in submitStatus: remove that entry and this answers 500. The message is
// pinned as well as the code because "no retread policy is configured for
// this fleet" is also TY015 — a code-only assertion would pass against a
// tenant that merely has no policy row, which is the opposite claim.
func TestDispatchAtCapIsTY015(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispatch-at-cap")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 0)
	retreader, _ := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "AT-CAP-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispatch", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q}`, retreader))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY015", ref.Code)
	require.Equal(t,
		"this casing has been retreaded 0 time(s), at a cap of 0; at its cap it is a purchase, not a retread candidate",
		ref.Message)

	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "REMOVED", state, "a casing at its cap did not leave the workshop")
}

// FR-FIT-013's receipt back, over the round trip a breakdown supplier makes.
// The dispatch is driven through the API too, so the absent retreadJobId is
// asserted on the answer that actually produces one — a breakdown dispatch
// opens no retread job (000033) — and the return then puts the casing back
// in stock at the store it names.
func TestReturnToStockFromBreakdownSupplier(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "return-to-stock")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	supplier, _ := plantDepotOfType(t, ctx, admin, tenantID, "BREAKDOWN_SUPPLIER")
	storeDepot, _ := plantDepotOfType(t, ctx, admin, tenantID, "STORE")
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "RETURN-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	out := post(t, h, "/api/tyres/"+tyreID.String()+"/dispatch", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"AT_BREAKDOWN_SUPPLIER","depotId":%q}`, supplier))
	require.Equal(t, http.StatusCreated, out.Code, out.Body.String())
	var dispatched dispatchedBody
	require.NoError(t, json.Unmarshal(out.Body.Bytes(), &dispatched))
	require.Nil(t, dispatched.RetreadJobID, "a breakdown supplier is not a retreader; no job is opened")
	// omitempty, pinned on the wire: the key must be absent rather than a
	// null a client has to special-case, and the struct's nil pointer alone
	// cannot tell the two apart.
	require.NotContains(t, out.Body.String(), "retreadJobId")

	back := post(t, h, "/api/tyres/"+tyreID.String()+"/return", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"depotId":%q}`, storeDepot))
	require.Equal(t, http.StatusNoContent, back.Code, back.Body.String())

	var state string
	var depotID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text, current_depot_id FROM app.tyre WHERE id = $1`, tyreID).Scan(&state, &depotID))
	require.Equal(t, "IN_STOCK", state)
	require.Equal(t, storeDepot, depotID, "the return moved the casing to the store it named")

	var jobs int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.retread_job WHERE tyre_id = $1`, tyreID).Scan(&jobs))
	require.Zero(t, jobs)
}

// sentOn is parsed in Go before the transaction opens, the way listTyres
// parses its on: a raw "yesterday" reaching $4::date is Postgres's
// 22007/22008, which submitStatus does not map, so a client typo would come
// back as a 500 the caller cannot act on.
func TestDispatchRefusesMalformedSentOn(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispatch-bad-date")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	retreader, _ := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "BAD-DATE-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	rec := post(t, h, "/api/tyres/"+tyreID.String()+"/dispatch", tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"AT_RETREADER","depotId":%q,"sentOn":"yesterday"}`, retreader))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "sentOn")

	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "REMOVED", state, "the refusal never reached the database")
}

// Which states are a dispatch destination is app.dispatch_tyre's list and
// app.tyre_state's, never a second one kept in step in Go (ADR-0013 d.5), so
// the two ways of getting it wrong arrive by two different routes: a real
// tyre state that is not a destination reaches the function and comes back
// as its own TY012 naming both destinations, while a value outside the enum
// never survives the cast and arrives as 22P02, canned as invalid_submission
// because the message Postgres wrote is not ours to forward (ADR-0012).
func TestDispatchRefusesADestinationThatIsNotOne(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "dispatch-destination")
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2)
	retreader, _ := plantDepotOfType(t, ctx, admin, tenantID, "RETREADER")
	tyreID := plantRemovedTyre(t, ctx, admin, tenantID, "DEST-"+uuid.NewString()[:8])

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	path := "/api/tyres/" + tyreID.String() + "/dispatch"

	inEnum := post(t, h, path, tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"FITTED","depotId":%q}`, retreader))
	require.Equal(t, http.StatusUnprocessableEntity, inEnum.Code, inEnum.Body.String())
	var enumRef refusalBody
	require.NoError(t, json.Unmarshal(inEnum.Body.Bytes(), &enumRef))
	require.Equal(t, "TY012", enumRef.Code)
	require.Equal(t, "a dispatch is to the retreader or to the breakdown supplier", enumRef.Message)

	outsideEnum := post(t, h, path, tenantID.String(), controller.String(),
		fmt.Sprintf(`{"destination":"THE MOON","depotId":%q}`, retreader))
	require.Equal(t, http.StatusUnprocessableEntity, outsideEnum.Code, outsideEnum.Body.String())
	var castRef refusalBody
	require.NoError(t, json.Unmarshal(outsideEnum.Body.Bytes(), &castRef))
	require.Equal(t, "invalid_submission", castRef.Code)

	var state string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT state::text FROM app.tyre WHERE id = $1`, tyreID).Scan(&state))
	require.Equal(t, "REMOVED", state, "neither refusal moved the casing")
}
