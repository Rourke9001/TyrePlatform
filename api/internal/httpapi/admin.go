// The admin write surface: users, units and the assignment between them.
// Every handler here follows ADR-0013 — shape validated in Go before a
// transaction opens, the row's own rules left to the constraints that already
// state them, and tenant_id taken from the bound session and never from the
// request.

package httpapi

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

type axleConfigurationJSON struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// listAxleConfigurations serves the library a unit is created against
// (FR-CFG-001..007). Gated on ManageAssets rather than ViewFleet: the list is
// only useful to someone who may create a unit with it, and D8 puts that on
// ManageAssets.
//
// Authoring a configuration is not here and must not arrive here. D8 reserves
// it for ManageTemplates, ORG_ADMIN alone (TYRE-84), because a wrong template
// silently corrupts every position on every unit that uses it.
func listAxleConfigurations(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: writeJSON encodes what it is handed, and a
		// nil slice reaches the client as JSON `null` rather than `[]`.
		configs := []axleConfigurationJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT id, code, name, version, axle_count
				   FROM app.axle_configuration
				  WHERE active
				  ORDER BY code, version`)
			if err != nil {
				return fmt.Errorf("listing axle configurations: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var c axleConfigurationJSON
				var id uuid.UUID
				if err := rows.Scan(&id, &c.Code, &c.Name, &c.Version, &c.AxleCount); err != nil {
					return fmt.Errorf("scanning axle configuration: %w", err)
				}
				c.ID = id.String()
				configs = append(configs, c)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, configs)
	}
}
