// The tyre register read (TYRE-91). listTyres is the first handler over the
// lifecycle functions Task 4 landed in migration 000031: it never writes, and
// every business rule it depends on (the dated code lookup, the awaiting-cost
// set) already lives in SQL, per db/CLAUDE.md.
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// tyreRow is what the register query scans into. Nullable columns are
// *string: size/brand/pattern are optional references, received_date is
// unset until the tyre is received, and purchase_price/rand_per_mm/
// casing_value are absent until a cost is recorded (CFL-002) or the tyre is
// never costed at all.
type tyreRow struct {
	id            uuid.UUID
	displayCode   string
	state         string
	status        string
	retreadCount  int
	sizeName      *string
	brandName     *string
	patternName   *string
	receivedDate  *string
	awaitingCost  bool
	purchasePrice *string
	randPerMm     *string
	casingValue   *string
}

// tyreJSON is the wire shape. Money fields carry omitempty: a nil pointer
// must vanish from the payload rather than round-trip as a JSON null, which
// is what "hidden" means for a projection a client cannot be trusted to
// enforce itself (NFR-SEC-006). Task 10's wire type mirrors this one.
type tyreJSON struct {
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
	PurchasePrice *string `json:"purchasePrice,omitempty"`
	RandPerMm     *string `json:"randPerMm,omitempty"`
	CasingValue   *string `json:"casingValue,omitempty"`
}

// tyreJSONFor is the FR-AUT-005a projection: every field copies straight
// across except the three money fields, which are nilled unless the actor
// holds ViewValuation. It is a pure function of its two arguments so the
// no-money branch is unit-testable directly — every role that can reach
// listTyres today (gated on ManageAssets) also holds ViewValuation, so that
// branch is not reachable by driving the handler; see
// TestTyreJSONForHidesMoneyWithoutViewValuation.
func tyreJSONFor(row tyreRow, canSeeMoney bool) tyreJSON {
	j := tyreJSON{
		ID:            row.id.String(),
		DisplayCode:   row.displayCode,
		State:         row.state,
		Status:        row.status,
		RetreadCount:  row.retreadCount,
		SizeName:      row.sizeName,
		BrandName:     row.brandName,
		PatternName:   row.patternName,
		ReceivedDate:  row.receivedDate,
		AwaitingCost:  row.awaitingCost,
		PurchasePrice: row.purchasePrice,
		RandPerMm:     row.randPerMm,
		CasingValue:   row.casingValue,
	}
	if !canSeeMoney {
		j.PurchasePrice = nil
		j.RandPerMm = nil
		j.CasingValue = nil
	}
	return j
}

// listTyres is the register read (FR-TYR-040..042). Gated on ManageAssets,
// like the other asset reads (admin.go's listAxleConfigurations) — the
// register is only useful to someone who may act on what it shows.
//
// code+on together resolve through app.tyre_for_code (FR-TYR-042): a display
// code is reissued after a tyre leaves the estate, so "which tyre carried
// this code" is only answerable for a specific date, never the code alone.
// awaitingCost narrows to app.v_tyre_awaiting_cost, the CFL-002 backlog of
// tyres received with no purchase price recorded yet.
func listTyres(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		q := r.URL.Query()
		code, on := q.Get("code"), q.Get("on")
		awaitingOnly := q.Get("awaitingCost") == "true"
		if (code == "") != (on == "") {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"a code lookup names both code and on (FR-TYR-042 resolves by date)")
			return
		}

		var out []tyreJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			// Money leaves the server only for a holder of ViewValuation
			// (FR-AUT-005a, NFR-SEC-006): projected out here, never filtered
			// client-side.
			canSeeMoney := a.Can(auth.ViewValuation)
			sql := `SELECT t.id, t.display_code, t.state::text, t.status::text,
			               t.retread_count, s.name, b.name, p.name,
			               t.received_date::text, (t.purchase_price IS NULL),
			               t.purchase_price::text, t.rand_per_mm::text, t.casing_value::text
			          FROM app.tyre t
			          LEFT JOIN app.tyre_size    s ON s.id = t.size_id
			          LEFT JOIN app.tyre_brand   b ON b.id = t.brand_id
			          LEFT JOIN app.tyre_pattern p ON p.id = t.pattern_id`
			var args []any
			switch {
			case code != "":
				sql += ` WHERE t.id IN (SELECT app.tyre_for_code($1, $2::date))`
				args = append(args, code, on)
			case awaitingOnly:
				// tyre_id, not id: app.v_tyre_awaiting_cost's identifying
				// column (000012), confirmed against the view's own
				// definition rather than assumed.
				sql += ` WHERE t.id IN (SELECT tyre_id FROM app.v_tyre_awaiting_cost)`
			}
			sql += ` ORDER BY t.received_date DESC NULLS LAST, t.display_code`
			rows, err := tx.Query(ctx, sql, args...)
			if err != nil {
				return fmt.Errorf("listing tyres: %w", err)
			}
			defer rows.Close()
			out = []tyreJSON{}
			for rows.Next() {
				var row tyreRow
				if err := rows.Scan(&row.id, &row.displayCode, &row.state, &row.status,
					&row.retreadCount, &row.sizeName, &row.brandName, &row.patternName,
					&row.receivedDate, &row.awaitingCost,
					&row.purchasePrice, &row.randPerMm, &row.casingValue); err != nil {
					return fmt.Errorf("scanning tyre: %w", err)
				}
				out = append(out, tyreJSONFor(row, canSeeMoney))
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, map[string]any{"tyres": out})
	}
}
