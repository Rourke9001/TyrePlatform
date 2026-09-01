// The tyre register (TYRE-91): listTyres reads it, and receiveTyres,
// setTyreCost and disposeTyre write to it through the lifecycle functions in
// migration 000031. Every business rule any of these four
// depends on — the dated code lookup, the awaiting-cost set, the
// display-code policy, the disposal transition table — lives in SQL, per
// db/CLAUDE.md; nothing here does more than shape a request and read back a
// result.
package httpapi

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
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
// enforce itself (NFR-SEC-006). web/src/api/tyres.ts's Tyre type mirrors
// this one.
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
// TestTyreJSONForProjectsMoneyByCapability.
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
// tyres received with no purchase price recorded and not yet disposed; the
// per-row flag on every other request reads the same view, so a disposed,
// never-costed tyre never claims to be awaiting cost in the unfiltered list.
//
// Depot scope is deliberately not applied here, unlike listVehicles:
// v_depot_tyre (migration 000014) exists and is intentionally unused by this
// endpoint, which answers tenant-wide regardless of actor scope.
// Widening or narrowing this read is TYRE-76's open scope question to
// answer, not this slice's — see design D6. Do not "fix" this in passing.
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
		// Validated before any transaction opens (ADR-0013 decision 5,
		// admin.go's assignDriver does the same for fromDate): a malformed
		// on would otherwise reach $2::date as a raw string, and Postgres's
		// resulting 22007/22008 is not in submitStatus, so withActor would
		// answer 500 for what is really a client typo.
		if on != "" {
			if _, err := time.Parse(isoDate, on); err != nil {
				refuseInvalid(w, r, invalid("on", "must be a date as YYYY-MM-DD"))
				return
			}
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
			// v_tyre_awaiting_cost is joined rather than reimplemented inline
			// (WHERE purchase_price IS NULL AND state NOT IN
			// ('SCRAPPED','LOST','SOLD'), migration 000012) — see this
			// function's doc comment for why the flag and the filter share it.
			sql := `SELECT t.id, t.display_code, t.state::text, t.status::text,
			               t.retread_count, s.name, b.name, p.name,
			               t.received_date::text, (v.tyre_id IS NOT NULL),
			               t.purchase_price::text, t.rand_per_mm::text, t.casing_value::text
			          FROM app.tyre t
			          LEFT JOIN app.tyre_size    s ON s.id = t.size_id
			          LEFT JOIN app.tyre_brand   b ON b.id = t.brand_id
			          LEFT JOIN app.tyre_pattern p ON p.id = t.pattern_id
			          LEFT JOIN app.v_tyre_awaiting_cost v ON v.tyre_id = t.id`
			var args []any
			switch {
			case code != "":
				sql += ` WHERE t.id IN (SELECT app.tyre_for_code($1, $2::date))`
				args = append(args, code, on)
			case awaitingOnly:
				sql += ` WHERE v.tyre_id IS NOT NULL`
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

// receiveTyresRequest is FR-TYR-040's intake body. Every field but Quantity
// is optional — most of what a tenant eventually knows about a tyre (its
// size, its cost) is often not known at receipt, which is exactly the
// awaiting-cost backlog CFL-002 names. Quantity is a plain int rather than
// *int: the zero value doubles as "not specified" in payload() below, which
// lets app.receive_tyres's own COALESCE supply its default of 1. The
// function's 1..200 bound is its rule, not one this struct duplicates
// (ADR-0013 decision 5 — no threshold in a Go validator).
type receiveTyresRequest struct {
	Quantity      int     `json:"quantity"`
	DisplayCode   *string `json:"displayCode"`
	SizeID        *string `json:"sizeId"`
	BrandID       *string `json:"brandId"`
	PatternID     *string `json:"patternId"`
	PurchaseDate  *string `json:"purchaseDate"`
	PurchasePrice *string `json:"purchasePrice"` // money stays a string end to end
	CostSource    *string `json:"costSource"`
	NewTreadMm    *string `json:"newTreadMm"`
	ReceivedDate  *string `json:"receivedDate"`
	DepotID       *string `json:"depotId"`
}

// payload builds app.receive_tyres's jsonb argument, snake_case and omitting
// every field the caller did not send. A present key with a NULL value and
// an absent key mean different things to the function's own COALESCE/NULLIF
// logic — quantity's default of 1 only applies when the key is missing
// entirely, so a zero (Quantity's unset value) is left out rather than sent
// as 0. A negative value is still forwarded: refusing it here would be a
// bound check this struct does not own (ADR-0013 decision 5), so an
// out-of-range quantity reaches app.receive_tyres and comes back as its own
// TY011 rather than being silently coerced to the default.
func (b receiveTyresRequest) payload() map[string]any {
	p := map[string]any{}
	if b.Quantity != 0 {
		p["quantity"] = b.Quantity
	}
	if b.DisplayCode != nil {
		p["display_code"] = *b.DisplayCode
	}
	if b.SizeID != nil {
		p["size_id"] = *b.SizeID
	}
	if b.BrandID != nil {
		p["brand_id"] = *b.BrandID
	}
	if b.PatternID != nil {
		p["pattern_id"] = *b.PatternID
	}
	if b.PurchaseDate != nil {
		p["purchase_date"] = *b.PurchaseDate
	}
	if b.PurchasePrice != nil {
		p["purchase_price"] = *b.PurchasePrice
	}
	if b.CostSource != nil {
		p["cost_source"] = *b.CostSource
	}
	if b.NewTreadMm != nil {
		p["new_tread_mm"] = *b.NewTreadMm
	}
	if b.ReceivedDate != nil {
		p["received_date"] = *b.ReceivedDate
	}
	if b.DepotID != nil {
		p["depot_id"] = *b.DepotID
	}
	return p
}

// receivedTyreJSON is what a receive answers per tyre minted — enough for a
// caller to display or immediately act on what it just created, nothing
// more (ADR-0013 decision 9's 201-with-projection shape).
type receivedTyreJSON struct {
	ID          string `json:"id"`
	DisplayCode string `json:"displayCode"`
}

// receiveTyres is FR-TYR-040's intake, the first write over the lifecycle
// functions in migration 000031. Every rule — the display-code
// policy refusal (D12/TY011), the 1..200 bulk bound, the code's own
// uniqueness (one_active_display_code_per_tenant) — belongs to
// app.receive_tyres, not here: this handler only decodes the request shape,
// translates it to the function's jsonb argument, and reads back what it
// minted (ADR-0013 decision 5).
func receiveTyres(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body receiveTyresRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		raw, err := json.Marshal(body.payload())
		if err != nil {
			// Unreachable in practice — every value above is a string or an
			// int — but a handler never panics (api/CLAUDE.md), so the
			// failure still answers rather than crashing.
			slog.ErrorContext(ctx, "marshalling receive payload", "err", err)
			writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
			return
		}

		received := []receivedTyreJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT tyre_id, display_code FROM app.receive_tyres($1::jsonb)`, raw)
			if err != nil {
				return fmt.Errorf("receiving tyres: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var id uuid.UUID
				var code string
				if err := rows.Scan(&id, &code); err != nil {
					return fmt.Errorf("scanning received tyre: %w", err)
				}
				received = append(received, receivedTyreJSON{ID: id.String(), DisplayCode: code})
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, map[string]any{"tyres": received})
	}
}

// setTyreCost is FR-TYR-041's costing step, the discharge for the
// awaiting-cost backlog CFL-002 names. The tyre id is the URL's, refused
// before any transaction opens if it does not even parse as a uuid — every
// actual rule (a second costing, a negative amount, and TY012's RLS-hidden
// tyre) is app.set_tyre_cost's alone (ADR-0013 decision 5).
func setTyreCost(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tyreID, err := uuid.Parse(chi.URLParam(r, "tyreID"))
		if err != nil {
			writeError(ctx, w, http.StatusUnprocessableEntity, codeInvalidSubmission, msgInvalidSubmission)
			return
		}
		var body struct {
			Price  string `json:"price"` // money stays a string; the DB casts and refuses
			Source string `json:"source"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`SELECT app.set_tyre_cost($1, $2::numeric, $3::app.cost_source)`,
				tyreID, body.Price, body.Source); err != nil {
				return fmt.Errorf("costing tyre %s: %w", tyreID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// disposeTyre is the disposal step (Appendix C's transition table): scrap,
// sale or loss. The tyre id is the URL's, refused before any
// transaction opens if it does not parse. Everything else — which
// transitions are legal from which state, that a scrap records its reason,
// that a sale records its proceeds, and TY012's cross-tenant/RLS-hidden
// case — is app.dispose_tyre's alone (ADR-0013 decision 5). A cross-tenant
// actor naming another tenant's tyre id meets the identical "no such tyre in
// this fleet" refusal a genuinely missing id would, because RLS makes the
// two indistinguishable by construction (db/tests/004_tests.sql section 39).
func disposeTyre(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tyreID, err := uuid.Parse(chi.URLParam(r, "tyreID"))
		if err != nil {
			writeError(ctx, w, http.StatusUnprocessableEntity, codeInvalidSubmission, msgInvalidSubmission)
			return
		}
		var body struct {
			Disposal string  `json:"disposal"`
			Reason   *string `json:"reason"`
			Proceeds *string `json:"proceeds"`
		}
		if !decodeJSON(w, r, &body) {
			return
		}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			// TY012 arrives via refusalForPgError with the message intact.
			if _, err := tx.Exec(ctx,
				`SELECT app.dispose_tyre($1, $2::app.tyre_state, $3, $4::numeric, now())`,
				tyreID, body.Disposal, body.Reason, body.Proceeds); err != nil {
				return fmt.Errorf("disposing tyre %s: %w", tyreID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
