package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// receiptFixture is a GENERATED tenant ready to receive sets of tyres: a
// catalogue, the fleet-wide 4.0 mm threshold a priced receive needs (U129),
// and a CONTROLLER to act. GENERATED because a FREE fleet's hand-typed code
// names one tyre, and a receipt's point is the set.
type receiptFixture struct {
	tenantID   uuid.UUID
	cat        receiveCatalogue
	controller uuid.UUID
	h          http.Handler
}

func plantReceiptFixture(t *testing.T, ctx context.Context, s *store.Store, admin *pgx.Conn, label string) receiptFixture {
	t.Helper()
	tenantID := plantGeneratedPolicyTenant(t, ctx, admin, label, "RCP")
	f := receiptFixture{
		tenantID:   tenantID,
		cat:        plantReceiveCatalogue(t, ctx, admin, tenantID),
		controller: plantUser(t, ctx, admin, tenantID, auth.RoleController),
		h:          httpapi.New(s, httpapi.HeaderActorResolver{}),
	}
	plantFleetRetreadPolicy(t, ctx, admin, tenantID, 2, "4.0")
	return f
}

// plantPrice adds one price list row on the admin connection. brandID nil
// is the size's price with no brand named (FR-CFG-040).
func (f receiptFixture) plantPrice(t *testing.T, ctx context.Context, admin *pgx.Conn, brandID *uuid.UUID, price, from string) {
	t.Helper()
	_, err := admin.Exec(ctx,
		`INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
		 VALUES ($1, $2, $3, $4::numeric, $5::date)`,
		f.tenantID, f.cat.sizeID, brandID, price, from)
	require.NoError(t, err)
}

// receive posts one receive and answers its receipt's id, read back on the
// admin connection.
func (f receiptFixture) receive(t *testing.T, ctx context.Context, admin *pgx.Conn, fields map[string]any) uuid.UUID {
	t.Helper()
	rec := post(t, f.h, "/api/tyres", f.tenantID.String(), f.controller.String(), f.cat.body(t, fields))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var out receivedTyresBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.NotEmpty(t, out.Tyres)
	var receipt uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT receipt_id FROM app.tyre WHERE id = $1`, out.Tyres[0].ID).Scan(&receipt))
	return receipt
}

// state reads a receipt's price state and invoice number.
func receiptState(t *testing.T, ctx context.Context, admin *pgx.Conn, receipt uuid.UUID) (string, *string) {
	t.Helper()
	var state string
	var number *string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT price_state::text, invoice_number FROM app.tyre_receipt WHERE id = $1`, receipt).
		Scan(&state, &number))
	return state, number
}

type moveResultBody struct {
	Priced    int `json:"priced"`
	LeftFleet int `json:"leftFleet"`
}

// The estimate is money and part of receiving, so it is gated as Receive
// tyres is (ManageAssets): a TECHNICIAN and a DRIVER are refused.
func TestPriceEstimateIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "estimate-gate")
	path := "/api/tyre-price-estimate?sizeId=" + f.cat.sizeID.String()
	for _, role := range []auth.Role{auth.RoleTechnician, auth.RoleDriver} {
		t.Run(string(role), func(t *testing.T) {
			user := plantUser(t, ctx, admin, f.tenantID, role)
			rec := get(t, f.h, path, f.tenantID.String(), user.String())
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		})
	}
	rec := get(t, f.h, path, f.tenantID.String(), f.controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

// The handler relays app.price_list_estimate (FR-CFG-041): a brand row
// beats a size-only row, a branded pattern supplies the brand, a date
// before every row and a size with none answer null.
func TestPriceEstimateRelaysTheMatch(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "estimate-match")
	brand := plantNamed(t, ctx, admin, "tyre_brand", f.tenantID, "T283 BRAND", true)
	branded := plantPattern(t, ctx, admin, f.tenantID, "T283 BRANDED", &brand, "NEW", true)
	bare := plantNamed(t, ctx, admin, "tyre_size", f.tenantID, "T283 BARE", true)
	f.plantPrice(t, ctx, admin, nil, "3500.00", "2026-01-01")
	f.plantPrice(t, ctx, admin, &brand, "4319.91", "2026-06-01")

	size := f.cat.sizeID.String()
	tests := []struct {
		name, query, want string
	}{
		{"brand row", "sizeId=" + size + "&brandId=" + brand.String(),
			`{"estimate":{"typicalPrice":"4319.91","effectiveFrom":"2026-06-01","brandSpecific":true}}`},
		{"size only", "sizeId=" + size,
			`{"estimate":{"typicalPrice":"3500.00","effectiveFrom":"2026-01-01","brandSpecific":false}}`},
		{"the pattern's brand", "sizeId=" + size + "&patternId=" + branded.String(),
			`{"estimate":{"typicalPrice":"4319.91","effectiveFrom":"2026-06-01","brandSpecific":true}}`},
		{"before every row", "sizeId=" + size + "&receivedDate=2025-12-31", `{"estimate":null}`},
		{"a size with no row", "sizeId=" + bare.String(), `{"estimate":null}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := get(t, f.h, "/api/tyre-price-estimate?"+tt.query, f.tenantID.String(), f.controller.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			require.JSONEq(t, tt.want, rec.Body.String())
		})
	}
}

// Each parameter is read before a transaction opens and refused naming
// itself (ADR-0013 decision 5).
func TestPriceEstimateRefusesMalformedParams(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "estimate-params")
	size := f.cat.sizeID.String()
	tests := []struct {
		name, query, want string
	}{
		{"no size", "", "sizeId is required"},
		{"size", "sizeId=x", "sizeId must be a uuid"},
		{"pattern", "sizeId=" + size + "&patternId=x", "patternId must be a uuid"},
		{"brand", "sizeId=" + size + "&brandId=x", "brandId must be a uuid"},
		{"date", "sizeId=" + size + "&receivedDate=31/12/2026", "receivedDate must be a date as YYYY-MM-DD"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := get(t, f.h, "/api/tyre-price-estimate?"+tt.query, f.tenantID.String(), f.controller.String())
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Equal(t, tt.want, ref.Message)
		})
	}
}

// An open receipt is UNPRICED or ESTIMATED; one received with an invoice
// is final and absent.
func TestOpenReceiptsListsUnpricedAndEstimated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "open-receipts")
	f.plantPrice(t, ctx, admin, nil, "4319.91", "2026-01-01")
	unpriced := f.receive(t, ctx, admin, map[string]any{"quantity": 2, "receivedDate": "2026-10-01"})
	estimated := f.receive(t, ctx, admin, map[string]any{
		"receivedDate": "2026-10-02", "purchasePrice": "4319.91", "costSource": "PRICE_LIST_ESTIMATE",
	})
	invoiced := f.receive(t, ctx, admin, map[string]any{
		"receivedDate": "2026-10-03", "purchasePrice": "4100.00", "costSource": "INVOICE",
	})

	rec := get(t, f.h, "/api/tyre-receipts/open", f.tenantID.String(), f.controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Receipts []struct {
			ID           string   `json:"id"`
			PriceState   string   `json:"priceState"`
			ReceivedDate string   `json:"receivedDate"`
			SizeName     string   `json:"sizeName"`
			PatternName  string   `json:"patternName"`
			Quantity     int      `json:"quantity"`
			InFleet      int      `json:"inFleet"`
			DisplayCodes []string `json:"displayCodes"`
			UnitPrice    *string  `json:"unitPrice"`
		} `json:"receipts"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Receipts, 2, "the invoiced receipt %s is final and not listed", invoiced)
	// Newest received first.
	require.Equal(t, estimated.String(), body.Receipts[0].ID)
	require.Equal(t, "ESTIMATED", body.Receipts[0].PriceState)
	require.NotNil(t, body.Receipts[0].UnitPrice)
	require.Equal(t, "4319.91", *body.Receipts[0].UnitPrice)
	require.Equal(t, unpriced.String(), body.Receipts[1].ID)
	require.Equal(t, "UNPRICED", body.Receipts[1].PriceState)
	require.Equal(t, "2026-10-01", body.Receipts[1].ReceivedDate)
	require.Equal(t, "315/80R22.5", body.Receipts[1].SizeName)
	require.Equal(t, "RECEIVE-TEST", body.Receipts[1].PatternName)
	require.Equal(t, 2, body.Receipts[1].Quantity)
	require.Equal(t, 2, body.Receipts[1].InFleet)
	require.Len(t, body.Receipts[1].DisplayCodes, 2)
	require.Nil(t, body.Receipts[1].UnitPrice)
}

// FR-CFG-041, D3: one invoice prices the whole set, with its number and
// date, and the receipt is final.
func TestRecordReceiptInvoicePricesTheSet(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "receipt-invoice")
	receipt := f.receive(t, ctx, admin, map[string]any{"quantity": 3, "receivedDate": "2026-10-01"})

	rec := post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/invoice", f.tenantID.String(), f.controller.String(),
		`{"price":"4500.00","invoiceNumber":" INV-7 ","invoiceDate":"2026-10-02"}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out moveResultBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Equal(t, moveResultBody{Priced: 3, LeftFleet: 0}, out)

	var priced int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.tyre
		  WHERE receipt_id = $1 AND purchase_price = 4500.00 AND cost_source = 'INVOICE'
		    AND purchase_date = '2026-10-02'`, receipt).Scan(&priced))
	require.Equal(t, 3, priced)
	state, number := receiptState(t, ctx, admin, receipt)
	require.Equal(t, "INVOICED", state)
	require.NotNil(t, number)
	require.Equal(t, "INV-7", *number)
}

// An unpriced receipt takes the list price, and an estimated one keeps it
// as final.
func TestApplyReceiptListPriceAndKeepTheEstimate(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "receipt-list-price")
	f.plantPrice(t, ctx, admin, nil, "4319.91", "2026-01-01")
	receipt := f.receive(t, ctx, admin, map[string]any{"quantity": 2, "receivedDate": "2026-10-01"})

	rec := post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/list-price", f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out moveResultBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	require.Equal(t, moveResultBody{Priced: 2, LeftFleet: 0}, out)
	state, _ := receiptState(t, ctx, admin, receipt)
	require.Equal(t, "ESTIMATED", state)

	rec = post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/keep-estimate", f.tenantID.String(), f.controller.String(), `{}`)
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	state, _ = receiptState(t, ctx, admin, receipt)
	require.Equal(t, "ESTIMATE_KEPT", state)
}

// A refused move is 000059's TY026, forwarded verbatim (ADR-0012).
func TestReceiptMoveRefusalIsTY026(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "receipt-refusal")
	receipt := f.receive(t, ctx, admin, map[string]any{"purchasePrice": "4100.00", "costSource": "INVOICE"})

	rec := post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/invoice", f.tenantID.String(), f.controller.String(),
		`{"price":"4200.00"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "TY026", ref.Code)
	require.Equal(t, "this receipt's price is final and does not change", ref.Message)
}

// Tenant B naming tenant A's receipt meets the answer a missing id gets,
// and A's receipt is untouched. A's receipt is unpriced with a list price
// in force, so a leak would make each move succeed rather than merely
// change the message.
func TestReceiptMovesCrossTenantAreInvisible(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	a := plantReceiptFixture(t, ctx, s, admin, "receipt-tenant-a")
	a.plantPrice(t, ctx, admin, nil, "4319.91", "2026-01-01")
	receipt := a.receive(t, ctx, admin, map[string]any{"receivedDate": "2026-10-01"})
	b := plantReceiptFixture(t, ctx, s, admin, "receipt-tenant-b")

	for _, tt := range []struct{ move, body string }{
		{"invoice", `{"price":"4500.00"}`},
		{"list-price", `{}`},
	} {
		t.Run(tt.move, func(t *testing.T) {
			rec := post(t, b.h, "/api/tyre-receipts/"+receipt.String()+"/"+tt.move,
				b.tenantID.String(), b.controller.String(), tt.body)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "TY012", ref.Code)
			require.Equal(t, "no such receipt in this fleet", ref.Message)
		})
	}
	state, _ := receiptState(t, ctx, admin, receipt)
	require.Equal(t, "UNPRICED", state)
	var priced int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.tyre WHERE receipt_id = $1 AND purchase_price IS NOT NULL`, receipt).Scan(&priced))
	require.Zero(t, priced)
}

// Every receipt route is gated as Receive tyres is (ManageAssets).
func TestReceiptRoutesAreCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "receipt-gate")
	receipt := f.receive(t, ctx, admin, map[string]any{})
	for _, role := range []auth.Role{auth.RoleTechnician, auth.RoleDriver} {
		user := plantUser(t, ctx, admin, f.tenantID, role)
		t.Run(string(role)+" open", func(t *testing.T) {
			rec := get(t, f.h, "/api/tyre-receipts/open", f.tenantID.String(), user.String())
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
		})
		for _, move := range []string{"invoice", "list-price", "keep-estimate"} {
			t.Run(string(role)+" "+move, func(t *testing.T) {
				rec := post(t, f.h, "/api/tyre-receipts/"+receipt.String()+"/"+move,
					f.tenantID.String(), user.String(), `{"price":"1.00"}`)
				require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			})
		}
	}
	state, _ := receiptState(t, ctx, admin, receipt)
	require.Equal(t, "UNPRICED", state)
}

// A receipt id that does not parse is a malformed request, as a tyre id is
// (U7).
func TestReceiptMoveMalformedIDIsBadRequest(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	f := plantReceiptFixture(t, ctx, s, admin, "receipt-malformed")
	for _, move := range []string{"invoice", "list-price", "keep-estimate"} {
		t.Run(move, func(t *testing.T) {
			rec := post(t, f.h, "/api/tyre-receipts/not-a-uuid/"+move,
				f.tenantID.String(), f.controller.String(), `{"price":"1.00"}`)
			require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "bad_request", ref.Code)
		})
	}
}
