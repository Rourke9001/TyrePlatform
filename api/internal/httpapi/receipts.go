package httpapi

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// Every rule here is migration 000059's: the price list match, which moves
// a receipt allows, and what each refuses. This file shapes the requests
// and reads the results back (ADR-0013 decision 5). Every route is gated as
// Receive tyres is (ManageAssets), and money leaves only for a holder of
// ViewValuation (FR-AUT-005a).

type priceEstimateRow struct {
	typicalPrice  string
	effectiveFrom string
	brandSpecific bool
}

type priceEstimateJSON struct {
	TypicalPrice  string `json:"typicalPrice"`
	EffectiveFrom string `json:"effectiveFrom"`
	BrandSpecific bool   `json:"brandSpecific"`
}

// estimateJSONFor answers no estimate for no list entry, and for an actor
// who may not see money, since an estimate is a price.
func estimateJSONFor(row *priceEstimateRow, canSeeMoney bool) *priceEstimateJSON {
	if row == nil || !canSeeMoney {
		return nil
	}
	return &priceEstimateJSON{
		TypicalPrice:  row.typicalPrice,
		EffectiveFrom: row.effectiveFrom,
		BrandSpecific: row.brandSpecific,
	}
}

// priceEstimate relays app.price_list_estimate to the receive form, asked
// with the size, pattern, brand and received date the receive will send,
// so the figure shown is the figure the receive accepts (FR-CFG-041). A
// blank date is the tenant's today, decided in SQL (rule 6).
func priceEstimate(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		sizeID, err := uuidParam(q, "sizeId")
		if refuseInvalid(w, r, err) {
			return
		}
		if sizeID == nil {
			refuseInvalid(w, r, invalid("sizeId", "is required"))
			return
		}
		patternID, err := uuidParam(q, "patternId")
		if refuseInvalid(w, r, err) {
			return
		}
		brandID, err := uuidParam(q, "brandId")
		if refuseInvalid(w, r, err) {
			return
		}
		receivedDate, err := dateParam(q, "receivedDate")
		if refuseInvalid(w, r, err) {
			return
		}

		var out *priceEstimateJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			var row priceEstimateRow
			err := tx.QueryRow(ctx,
				`SELECT e.typical_price::text, e.effective_from::text, e.brand_id IS NOT NULL
				   FROM app.price_list_estimate($1, $2, $3::date, $4) e`,
				*sizeID, brandID, receivedDate, patternID).
				Scan(&row.typicalPrice, &row.effectiveFrom, &row.brandSpecific)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			if err != nil {
				return fmt.Errorf("reading the price list estimate: %w", err)
			}
			out = estimateJSONFor(&row, a.Can(auth.ViewValuation))
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, map[string]any{"estimate": out})
	}
}

type openReceiptRow struct {
	id           uuid.UUID
	priceState   string
	receivedDate string
	depotName    *string
	sizeName     string
	brandName    *string
	patternName  string
	quantity     int
	inFleet      int
	displayCodes []string
	unitPrice    *string
}

// openReceiptJSON's unitPrice carries omitempty for the reason tyreJSON's
// money fields do (tyres.go).
type openReceiptJSON struct {
	ID           string   `json:"id"`
	PriceState   string   `json:"priceState"`
	ReceivedDate string   `json:"receivedDate"`
	DepotName    *string  `json:"depotName"`
	SizeName     string   `json:"sizeName"`
	BrandName    *string  `json:"brandName"`
	PatternName  string   `json:"patternName"`
	Quantity     int      `json:"quantity"`
	InFleet      int      `json:"inFleet"`
	DisplayCodes []string `json:"displayCodes"`
	UnitPrice    *string  `json:"unitPrice,omitempty"`
}

func openReceiptJSONFor(row openReceiptRow, canSeeMoney bool) openReceiptJSON {
	j := openReceiptJSON{
		ID:           row.id.String(),
		PriceState:   row.priceState,
		ReceivedDate: row.receivedDate,
		DepotName:    row.depotName,
		SizeName:     row.sizeName,
		BrandName:    row.brandName,
		PatternName:  row.patternName,
		Quantity:     row.quantity,
		InFleet:      row.inFleet,
		DisplayCodes: row.displayCodes,
		UnitPrice:    row.unitPrice,
	}
	if !canSeeMoney {
		j.UnitPrice = nil
	}
	return j
}

// listOpenReceipts serves the receipts still waiting for their price,
// newest received first.
func listOpenReceipts(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		out := []openReceiptJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			canSeeMoney := a.Can(auth.ViewValuation)
			rows, err := tx.Query(ctx,
				`SELECT v.receipt_id, v.price_state::text, v.received_date::text, v.depot_name,
				        v.size_name, v.brand_name, v.pattern_name, v.quantity, v.in_fleet,
				        v.display_codes, v.unit_price::text
				   FROM app.v_open_tyre_receipt v
				  ORDER BY v.received_date DESC, v.created_at DESC`)
			if err != nil {
				return fmt.Errorf("listing open receipts: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var row openReceiptRow
				if err := rows.Scan(&row.id, &row.priceState, &row.receivedDate, &row.depotName,
					&row.sizeName, &row.brandName, &row.patternName, &row.quantity, &row.inFleet,
					&row.displayCodes, &row.unitPrice); err != nil {
					return fmt.Errorf("scanning open receipt: %w", err)
				}
				out = append(out, openReceiptJSONFor(row, canSeeMoney))
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, map[string]any{"receipts": out})
	}
}

// moveResultJSON says what a move did to the set: how many tyres it priced
// and how many had left the fleet and kept what they had.
type moveResultJSON struct {
	Priced    int `json:"priced"`
	LeftFleet int `json:"leftFleet"`
}

// recordReceiptInvoiceRequest is the invoice's body, so a test can name
// the request shape (D6).
type recordReceiptInvoiceRequest struct {
	Price         string  `json:"price"` // money stays a string; the DB casts and refuses
	InvoiceNumber *string `json:"invoiceNumber"`
	InvoiceDate   *string `json:"invoiceDate"`
}

// recordReceiptInvoice prices the whole set from its invoice, once
// (FR-CFG-041, spec D2 and D3).
func recordReceiptInvoice(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		receiptID, ok := pathID(w, r, "receiptID")
		if !ok {
			return
		}
		var body recordReceiptInvoiceRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		price, err := requiredText("price", body.Price)
		if refuseInvalid(w, r, err) {
			return
		}
		number, err := text("invoiceNumber", body.InvoiceNumber)
		if refuseInvalid(w, r, err) {
			return
		}
		invoiceDate, err := dateField("invoiceDate", body.InvoiceDate)
		if refuseInvalid(w, r, err) {
			return
		}

		var out moveResultJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx,
				`SELECT m.priced, m.left_fleet FROM app.record_receipt_invoice($1, $2::numeric, $3, $4::date) m`,
				receiptID, price, number, invoiceDate).Scan(&out.Priced, &out.LeftFleet); err != nil {
				return fmt.Errorf("recording the invoice on receipt %s: %w", receiptID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// applyReceiptListPrice prices an unpriced set from the price list in
// force on the day it was received.
func applyReceiptListPrice(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		receiptID, ok := pathID(w, r, "receiptID")
		if !ok {
			return
		}
		var out moveResultJSON
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx,
				`SELECT m.priced, m.left_fleet FROM app.apply_receipt_list_price($1) m`,
				receiptID).Scan(&out.Priced, &out.LeftFleet); err != nil {
				return fmt.Errorf("applying the list price to receipt %s: %w", receiptID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}

// keepReceiptEstimate records that no invoice will come, so the estimate
// is final.
func keepReceiptEstimate(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		receiptID, ok := pathID(w, r, "receiptID")
		if !ok {
			return
		}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT app.keep_receipt_estimate($1)`, receiptID); err != nil {
				return fmt.Errorf("keeping the estimate on receipt %s: %w", receiptID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
