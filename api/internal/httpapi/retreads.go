// The retread queue (TYRE-93/D6): what a workshop currently has out with a
// retreader, and the write that closes one of those jobs when the casing
// comes back. Dispatching a casing to the retreader is what opens a job, and
// it lives on the tyre itself (tyres.go's dispatchTyre) because a dispatch
// names a casing, not a job that does not exist yet.
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

// retreadReturnRequest is app.log_retread_return's body (D3). The three
// money-and-tread figures are *string: money is numeric in SQL and a string
// on the wire, never a JSON number and never parsed in Go (rule 2), and the
// pointer is what carries "the retreader gave no figure" to a function whose
// accepted branch names each missing one separately.
//
// CasingAccepted is *bool rather than bool deliberately. A missing key
// decodes into a bare bool as false, and false here means the retreader
// rejected the casing — which SCRAPS it and writes a zero valuation against
// an append-only event log, so the default must not be silently reachable.
// Absence is refused in Go beside the other two required fields: whether a
// key is present is the request's shape, not a rule about tyres (ADR-0013
// decision 5), and a form gets one error vocabulary rather than one field
// answering invalid_submission and its neighbour TY014.
// app.log_retread_return's own TY014 stays the backstop for every caller
// that is not this handler.
type retreadReturnRequest struct {
	ReturnedOn      string  `json:"returnedOn"`
	CasingAccepted  *bool   `json:"casingAccepted"`
	ReportReference string  `json:"reportReference"`
	RetreadCost     *string `json:"retreadCost"`
	PostTreadMm     *string `json:"postTreadMm"`
	CasingValue     *string `json:"casingValue"`
	NewPatternID    *string `json:"newPatternId"`
}

// logRetreadReturn is FR-FIT-021/022's write: the casing comes back from the
// retreader, the job closes with its turnaround, and FR-TYR-018/019 re-rate
// the casing at what the new tread cost. It is the first use of the
// LogRetread capability B2 defined (ADR-0011) — a fleet may let a workshop
// log a retread without letting it manage assets at large, so this is the
// one write on the surface not gated on ManageAssets.
//
// The arithmetic is app.log_retread_return's alone: the rate comes from
// app.rand_per_mm, the same implementation Appendix E is pinned against
// (FR-VAL-006), on figures it rounds into their stored types first. Nothing
// here computes, parses or even inspects an amount.
func logRetreadReturn(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		jobID, ok := pathID(w, r, "jobID")
		if !ok {
			return
		}
		var body retreadReturnRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		if body.CasingAccepted == nil {
			refuseInvalid(w, r, invalid("casingAccepted", "is required"))
			return
		}
		reportReference, err := requiredText("reportReference", body.ReportReference)
		if refuseInvalid(w, r, err) {
			return
		}
		rawReturnedOn, err := requiredText("returnedOn", body.ReturnedOn)
		if refuseInvalid(w, r, err) {
			return
		}
		returnedOn, err := dateField("returnedOn", &rawReturnedOn)
		if refuseInvalid(w, r, err) {
			return
		}
		var newPatternID *uuid.UUID
		if body.NewPatternID != nil {
			parsed, err := uuidField("newPatternId", *body.NewPatternID)
			if refuseInvalid(w, r, err) {
				return
			}
			newPatternID = &parsed
		}

		ok = withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.LogRetread); err != nil {
				return err
			}
			// TY012, TY014 and TY015 arrive via refusalForPgError with their
			// messages intact — including the cap re-checked on the way back,
			// which a policy lowered while the casing was away can fail.
			if _, err := tx.Exec(ctx,
				`SELECT app.log_retread_return($1, $2::date, $3, $4,
				                               $5::numeric, $6::numeric, $7::numeric, $8)`,
				jobID, returnedOn, body.CasingAccepted, reportReference,
				body.RetreadCost, body.PostTreadMm, body.CasingValue, newPatternID); err != nil {
				return fmt.Errorf("logging the return of retread job %s: %w", jobID, err)
			}
			return nil
		})
		if !ok {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
