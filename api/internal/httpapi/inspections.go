// The inspection correction surface (TYRE-164): the one write an immutable
// inspection has. What the void means is app.void_inspection's alone (000040):
// reason mandatory, tenant-bound, terminal, audited. This file validates the
// shape of the request and forwards its refusals (ADR-0013 decision 5).
package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
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
// intact; the handler adds only depot scope, which the function cannot see.
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
			if err := lockInspectionInScope(ctx, tx, a, inspectionID); err != nil {
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

// lockInspectionInScope is depot scope for the void (FR-AUT-008, U248 item
// 3): an actor who is not tenant-wide voids only an inspection that concerns
// at least one unit of their depots, by app.inspection_read_unit's test
// through app.v_unit_inspection, and any other answers 404 as one that does
// not exist (ADR-0011). Those units are held FOR SHARE in id order, the rig
// lock order (units.go), so the scope authorised is the scope the void lands
// in; app.void_inspection takes no unit lock, so this inverts none. A
// ScopeTenant actor meets the function's own TY012 instead.
func lockInspectionInScope(ctx context.Context, tx pgx.Tx, a auth.Actor, inspectionID uuid.UUID) error {
	if a.Scope() == auth.ScopeTenant {
		return nil
	}
	tag, err := tx.Exec(ctx, `
		SELECT v.id FROM app.vehicle v
		 WHERE v.id IN (SELECT ui.vehicle_id FROM app.v_unit_inspection ui WHERE ui.inspection_id = $1)
		   AND EXISTS (SELECT 1 FROM `+unitSource(a)+` s WHERE s.id = v.id)
		 ORDER BY v.id
		 FOR SHARE OF v`, inspectionID)
	if err != nil {
		return fmt.Errorf("resolving the units of inspection %s: %w", inspectionID, err)
	}
	if tag.RowsAffected() == 0 {
		return refusalError{refusal{status: http.StatusNotFound, code: codeNotFound, message: "no such inspection in this fleet"}}
	}
	return nil
}
