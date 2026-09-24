// The inspection correction surface (TYRE-164): the one write an immutable
// inspection has. What the void means is app.void_inspection's alone (000040):
// reason mandatory, tenant-bound, terminal, audited. This file validates the
// shape of the request and forwards its refusals (ADR-0013 decision 5).
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// voidInspectionRequest is app.void_inspection's body. The reason is
// mandatory (FR-INS-012); the shape check here is transport only, the rule
// is SQL's (ADR-0013 decision 5).
type voidInspectionRequest struct {
	Reason string `json:"reason"`
}

// voidInspection is the one correction an inspection has (rule 3, FR-INS-012).
// TY012 and TY019 arrive through refusalForPgError with their messages
// intact; the handler adds nothing the function does not already say.
func voidInspection(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		inspectionID, ok := pathID(w, r, "inspectionID")
		if !ok {
			return
		}
		var body voidInspectionRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		reason, err := requiredText("reason", body.Reason)
		if refuseInvalid(w, r, err) {
			return
		}
		// requiredText answers presence, not size, so maxTextLen is checked
		// here.
		if len(reason) > maxTextLen {
			refuseInvalid(w, r, invalid("reason", "is too long"))
			return
		}
		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.VoidInspection); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `SELECT app.void_inspection($1, $2)`, inspectionID, reason); err != nil {
				return fmt.Errorf("voiding inspection %s: %w", inspectionID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
