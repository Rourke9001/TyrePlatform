// Recording that a code the platform issued is marked on the sidewall
// (TYRE-99, B22). Every rule is app.mark_code_on_sidewall's (000062): which
// tyres are pending, the day, and the refusals, all TY012. The capability is
// U224's reading of who marks: ManageAssets, which the controller, the depot
// manager and the administrator hold and a driver and a technician do not.
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// codeMarkedRequest carries the day the marking was made; absent is the
// tenant's today, decided by the function (rule 6).
type codeMarkedRequest struct {
	MarkedOn *string `json:"markedOn"`
}

func markTyreCode(s *store.Store) http.HandlerFunc {
	return markCodes(s, "tyreID",
		`SELECT m.tyre_id, m.display_code FROM app.mark_code_on_sidewall($1::uuid, NULL::uuid, $2::date) m`)
}

// markReceiptCodes marks every tyre on the receipt still waiting.
func markReceiptCodes(s *store.Store) http.HandlerFunc {
	return markCodes(s, "receiptID",
		`SELECT m.tyre_id, m.display_code FROM app.mark_code_on_sidewall(NULL::uuid, $1::uuid, $2::date) m`)
}

// markCodes answers the tyres the function marked, in receivedTyreJSON's
// shape (ADR-0013 decision 9, as amended).
func markCodes(s *store.Store, param, sql string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id, ok := pathID(w, r, param)
		if !ok {
			return
		}
		var body codeMarkedRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		markedOn, err := dateField("markedOn", body.MarkedOn)
		if refuseInvalid(w, r, err) {
			return
		}

		out := []receivedTyreJSON{}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, sql, id, markedOn)
			if err != nil {
				return fmt.Errorf("marking codes for %s %s: %w", param, id, err)
			}
			defer rows.Close()
			for rows.Next() {
				var t receivedTyreJSON
				if err := rows.Scan(&t.ID, &t.DisplayCode); err != nil {
					return fmt.Errorf("scanning a marked tyre: %w", err)
				}
				out = append(out, t)
			}
			if err := rows.Err(); err != nil {
				return fmt.Errorf("marking codes for %s %s: %w", param, id, err)
			}
			return nil
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, map[string]any{"tyres": out})
	}
}
