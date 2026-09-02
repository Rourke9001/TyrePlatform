// The retread queue read (TYRE-93/D6): what a workshop currently has out
// with a retreader. Dispatching a casing and logging its return (TYRE-93)
// is a separate write surface; this is reads only.
package httpapi

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// retreadJobJSON is one row of GET /api/retread-jobs?open=true. DaysOut is
// computed in SQL against the tenant's own civil today (rule 6), the same
// app.tenant_today the fleet fitments read uses, never time.Now() in Go.
type retreadJobJSON struct {
	ID          string `json:"id"`
	TyreID      string `json:"tyreId"`
	DisplayCode string `json:"displayCode"`
	DepotName   string `json:"depotName"`
	SentAt      string `json:"sentAt"`
	DaysOut     int    `json:"daysOut"`
}

// listRetreadJobs is the retread queue (D6). Gated on LogRetread, which today
// only CONTROLLER, DEPOT_MANAGER and ORG_ADMIN hold — a TECHNICIAN reads the
// fleet but does not act on the retread queue, so it is refused here exactly
// as it is on the register (tyres.go's listTyres). open=true is required for
// the same reason listOpenFitments requires it: an unfiltered "every job
// ever sent" read is not a screen this slice builds.
func listRetreadJobs(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if r.URL.Query().Get("open") != "true" {
			writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
				"only ?open=true is supported for now")
			return
		}
		out := []retreadJobJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.LogRetread); err != nil {
				return err
			}
			rows, err := tx.Query(ctx, `
				SELECT rj.id, rj.tyre_id, t.display_code, d.name, rj.sent_at::text,
				       (app.tenant_today(tn.timezone) - rj.sent_at)::int
				  FROM app.retread_job rj
				  JOIN app.tyre t    ON t.id = rj.tyre_id
				  -- retreader_depot_id is nullable on the column, but an inner join is
				  -- safe: app.dispatch_tyre (000033:594-599) refuses a dispatch whose
				  -- depot does not resolve, so every row this surface can see has one.
				  JOIN app.depot d   ON d.id = rj.retreader_depot_id
				  JOIN app.tenant tn ON tn.id = rj.tenant_id
				 WHERE rj.returned_at IS NULL
				 ORDER BY rj.sent_at`)
			if err != nil {
				return fmt.Errorf("listing open retread jobs: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var (
					id, tyreID             uuid.UUID
					displayCode, depotName string
					sentAt                 string
					daysOut                int
				)
				if err := rows.Scan(&id, &tyreID, &displayCode, &depotName, &sentAt, &daysOut); err != nil {
					return fmt.Errorf("scanning retread job: %w", err)
				}
				out = append(out, retreadJobJSON{
					ID: id.String(), TyreID: tyreID.String(), DisplayCode: displayCode,
					DepotName: depotName, SentAt: sentAt, DaysOut: daysOut,
				})
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, out)
	}
}
