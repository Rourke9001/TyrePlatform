package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// submitInspection's SQLSTATEs sort into three groups: TY-prefixed (ADR-0012's
// own vocabulary, never canned), the standard integrity violations below
// (canned as 422/409 so a client mistake never reads as a 500 the outbox
// retries forever, ADR-0009), and everything else (defaults to 500, the
// honest answer for an invariant breach). TY001/TY002 (DR-020 odometer
// plausibility) and TY010 never reach here by construction; see
// docs/architecture.md's refusal-vocabulary section for the full account.

// The refusal vocabulary (ADR-0012). A code names the reason, never the layer
// that found it, which is why codeVehicleNotVisible is TY007's own: the Go
// scope check in submitInspection and app.submit_inspection's TY007 guard
// answer the same condition, and ADR-0011 denies letting two roles learn
// different things about the same vehicle.
const (
	codeUnauthorized      = "unauthorized"
	codeForbidden         = "forbidden"
	codeVehicleNotVisible = "TY007"
	codeBadRequest        = "bad_request"
	codeMalformedJSON     = "malformed_json"
	codeInvalidSubmission = "invalid_submission"
	codeConflict          = "conflict"
	codeNotFound          = "not_found"
	codeMethodNotAllowed  = "method_not_allowed"
	codeRateLimited       = "rate_limited"
	codeInternal          = "internal"

	codeFleetNumberTaken    = "fleet_number_taken"
	codeEmailTaken          = "email_taken"
	codeEmailInactive       = "email_inactive"
	codeNothingToReactivate = "nothing_to_reactivate"
	codeAssignmentOverlaps  = "assignment_overlaps"
	codeStaffNumberTaken    = "staff_number_taken"
	codeDisplayCodeTaken    = "display_code_taken"
	codePositionOccupied    = "position_occupied"
	codeTyreAlreadyFitted   = "tyre_already_fitted"
	codeObservationResolved = "observation_resolved"
)

// Canned replacements for messages Postgres wrote. A driver's recovery action
// is the same for all of them, because the payload is wrong in a way the
// database declined to name and it fails identically on every retry, so one
// code covers the class (ADR-0012). msgConflict is separate only because it is a
// 409 and must be distinguishable from TY003's duplicate window (FR-INS-038).
const (
	msgInvalidSubmission = "the submission was refused as invalid"
	msgConflict          = "the submission conflicts with data already recorded"
	msgUnauthorized      = "the request does not identify a user"
	msgForbidden         = "this action is not permitted for this role"
	msgVehicleNotVisible = "vehicle not visible"
	msgInternal          = "internal error"

	msgFleetNumberTaken    = "a unit with that fleet number already exists"
	msgEmailTaken          = "a user with that email address already exists in this tenant"
	msgEmailInactive       = "a user with this email address was deactivated; reactivate them instead of adding a new one"
	msgNothingToReactivate = "no deactivated user holds that email address any more; refresh and add them as a new user if that is still the intent"
	msgAssignmentOverlaps  = "that driver already holds an overlapping assignment to this unit"
	msgStaffNumberTaken    = "another active user already has that staff number; give this one a different number"
	msgDisplayCodeTaken    = "an active tyre already carries that display code; two active tyres may never share one (FR-TYR-004/DR-002)"
	msgPositionOccupied    = "that position already carries a tyre; remove it first (FR-FIT-004)"
	msgTyreAlreadyFitted   = "that tyre is already fitted elsewhere; remove it first (D14)"
	msgObservationResolved = "someone has already applied or dismissed that report; refresh the list"
)

var submitStatus = map[string]int{
	"TY003": http.StatusConflict,
	"TY004": http.StatusUnprocessableEntity,
	"TY005": http.StatusUnprocessableEntity,
	"TY006": http.StatusUnprocessableEntity,
	// TY007: an unrecognised or cross-tenant vehicle_id (migration 000023).
	// Reachable in practice only by a ScopeTenant actor, who skips the
	// Go-side v_capture_vehicle check.
	"TY007": http.StatusUnprocessableEntity,

	// TY009/011-019: fitment (TYRE-92), tyre-lifecycle, unit-status, rig and
	// task refusals. TY020 and TY008 have no entry; no route can reach
	// either. See docs/architecture.md's refusal-vocabulary table for the
	// migration each one came from.
	"TY009": http.StatusUnprocessableEntity,
	"TY011": http.StatusUnprocessableEntity,
	"TY012": http.StatusUnprocessableEntity,
	"TY013": http.StatusUnprocessableEntity,
	"TY014": http.StatusUnprocessableEntity,
	"TY015": http.StatusUnprocessableEntity,
	"TY016": http.StatusUnprocessableEntity,
	"TY017": http.StatusUnprocessableEntity,
	"TY018": http.StatusUnprocessableEntity,
	"TY019": http.StatusUnprocessableEntity,

	// TY021 is the future-skew refusal (000041); 422 like TY005 on the wire, but
	// its own code so the outbox can tell it apart and retry (TYRE-215).
	"TY021": http.StatusUnprocessableEntity,

	// TY022 is a composition observation refused (000044): a report already
	// resolved, stale, on a voided capture, or naming a composition the
	// register cannot be moved to. 422 like its neighbours. The request is
	// well formed and the answer is permanent, so a client shows the message
	// and stops (ADR-0012).
	"TY022": http.StatusUnprocessableEntity,

	// TY008 has no entry and never will unless configuration editing is
	// reopened: the unit PATCH is what keeps it unreachable from the API
	// (units.go's patchUnitRequest). An entry could carry no test able to
	// fail (ADR-0012).

	"23502": http.StatusUnprocessableEntity, // not-null violation
	"23503": http.StatusUnprocessableEntity, // foreign key: an id this tenant cannot see
	"23514": http.StatusUnprocessableEntity, // check: FR-INS-030/031's hard ranges
	"22P02": http.StatusUnprocessableEntity, // a field that will not parse as its type
	"22023": http.StatusUnprocessableEntity, // a scalar where the payload promised an array
	// 22007/22008: a date or instant Postgres cannot read or that is out of
	// range. Every route validates its dates in Go first (dateField,
	// instantField), so these are canned like 22P02 for the surface that
	// forgets. The client mistake stays a 422, never a 500 the outbox
	// retries forever (ADR-0012, TYRE-174).
	"22007": http.StatusUnprocessableEntity, // invalid datetime format
	"22008": http.StatusUnprocessableEntity, // datetime field overflow
	// A duplicate client_uuid is FR-OFF-011's replay and app.submit_inspection
	// answers it as one, including when two concurrent drains race for the
	// same unique index. This entry catches any OTHER unique violation, which
	// is a conflict rather than a fault and, like the classes above, must
	// not become a 500 the outbox retries to no end.
	"23505": http.StatusConflict,

	// 23P01 is vehicle_driver_no_overlap (000026). Unmapped it would answer
	// 500, which for a form is a spinner that never resolves and for the
	// capture outbox is a retry that never stops (ADR-0009).
	"23P01": http.StatusConflict,
}

// refusal is what the wire carries for a client mistake (ADR-0012).
type refusal struct {
	status  int
	code    string
	message string
}

// The conflicts a client acts on differently, keyed by the constraint that
// detects them (ADR-0013): DR-003 (fleet number), D10 (email), B1's
// exclusion (assignment). Translated, never forwarded (ADR-0012); an
// unrecognised constraint keeps the generic conflict.
// TestConflictCodesNameLiveSchemaObjects asserts every key names a live
// constraint (TYRE-95).
var conflictCodes = map[string]string{
	"vehicle_tenant_id_fleet_number_key": codeFleetNumberTaken,
	"app_user_tenant_email_key":          codeEmailTaken,
	"vehicle_driver_no_overlap":          codeAssignmentOverlaps,
	// A rehire preserves the returning employee's staff_number rather than
	// blanking it (admin.go's COALESCE, FR-AUT-022), and 000019's partial
	// index permits another active user to hold that same number once the
	// original left (D2), so the two legitimate rules collide on
	// reactivation. That is a state an admin must be told how to resolve,
	// not a bare conflict.
	"one_active_staff_number_per_tenant": codeStaffNumberTaken,
	// one_active_display_code_per_tenant is a unique index, not a table
	// constraint (000011), scoped to ACTIVE tyres only. Historical reuse
	// across a scrapped/sold/lost tyre is valid and does not collide
	// (FR-TYR-004/DR-002).
	"one_active_display_code_per_tenant": codeDisplayCodeTaken,
	// one_open_fitment_per_position and one_open_fitment_per_tyre are partial
	// unique indexes, not table constraints, scoped to an open fitment
	// (removed_at IS NULL), so a tyre's fitment history does not collide with
	// itself once removed.
	"one_open_fitment_per_position": codePositionOccupied,
	"one_open_fitment_per_tyre":     codeTyreAlreadyFitted,
	// composition_observation_once is the UNIQUE both resolution functions
	// take a FOR UPDATE on the offered rig to stay off (000044). It answers
	// only the race two controllers acting on one report can still lose, and
	// a bare 409 there reads to a form as a failure it should retry.
	"composition_observation_once": codeObservationResolved,
}

var conflictMessages = map[string]string{
	codeFleetNumberTaken:    msgFleetNumberTaken,
	codeEmailTaken:          msgEmailTaken,
	codeAssignmentOverlaps:  msgAssignmentOverlaps,
	codeStaffNumberTaken:    msgStaffNumberTaken,
	codeDisplayCodeTaken:    msgDisplayCodeTaken,
	codePositionOccupied:    msgPositionOccupied,
	codeTyreAlreadyFitted:   msgTyreAlreadyFitted,
	codeObservationResolved: msgObservationResolved,
}

// Forwarding is decided by the TY class, not a list of safe codes: a TY
// message is ours (app.submit_inspection wrote it, names no schema object).
// Everything else is Postgres's, can name a constraint or table, and is
// canned by default (the safe direction). No standard SQLSTATE class begins
// with T.
func refusalForPgError(err error) (refusal, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return refusal{}, false
	}
	status, found := submitStatus[pgErr.Code]
	if !found {
		return refusal{}, false
	}
	switch {
	case strings.HasPrefix(pgErr.Code, "TY"):
		return refusal{status: status, code: pgErr.Code, message: pgErr.Message}, true
	case pgErr.Code == "23505" || pgErr.Code == "23P01":
		if code, found := conflictCodes[pgErr.ConstraintName]; found {
			return refusal{status: status, code: code, message: conflictMessages[code]}, true
		}
		return refusal{status: status, code: codeConflict, message: msgConflict}, true
	default:
		return refusal{status: status, code: codeInvalidSubmission, message: msgInvalidSubmission}, true
	}
}

// withActor is the one place a handler turns an identity into an actor. It
// owns the refusal vocabulary so no handler invents its own: 401 means we do
// not know who you are, 403 means we do and you may not.
func withActor(w http.ResponseWriter, r *http.Request, s *store.Store, fn func(pgx.Tx, auth.Actor) error) bool {
	ctx := r.Context()
	id, ok := identityFrom(ctx)
	if !ok {
		writeError(ctx, w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
		return false
	}
	err := s.InActorTx(ctx, id.TenantID, id.UserID, fn)
	pgRef, isClient := refusalForPgError(err)
	var ref refusalError
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrNoSuchActor):
		// Deliberately indistinguishable to the client: whether the user is
		// deactivated or simply not in this tenant is not theirs to learn.
		slog.WarnContext(ctx, "refusing unresolvable actor", "tenant", id.TenantID, "user", id.UserID)
		writeError(ctx, w, http.StatusForbidden, codeForbidden, msgForbidden)
		return false
	case errors.Is(err, errForbidden):
		writeError(ctx, w, http.StatusForbidden, codeForbidden, msgForbidden)
		return false
	case errors.Is(err, errVehicleNotVisible):
		writeError(ctx, w, http.StatusUnprocessableEntity, codeVehicleNotVisible, msgVehicleNotVisible)
		return false
	case errors.As(err, &ref):
		writeError(ctx, w, ref.status, ref.code, ref.message)
		return false
	case isClient:
		writeError(ctx, w, pgRef.status, pgRef.code, pgRef.message)
		return false
	default:
		slog.ErrorContext(ctx, "actor transaction failed", "err", err)
		writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
		return false
	}
}

// errForbidden lets a handler refuse from inside the transaction and have
// withActor shape the response, so the capability check reads inline with the
// query it guards rather than as a separate pre-flight.
var errForbidden = errors.New("capability not held")

// refusalError lets a handler refuse from inside its transaction with a
// refusal it composes, the way errForbidden does for a fixed 403. ADR-0012 is
// unchanged by it: the message is written in Go, names a request field and no
// schema object, and is never one Postgres wrote.
type refusalError struct{ refusal }

func (e refusalError) Error() string { return e.code + ": " + e.message }

// errVehicleNotVisible is FR-AUT-005's write-path narrowing, answered 422
// (TY007's own status), not 403: a ScopeTenant actor meets the identical
// condition at app.submit_inspection's TY007 guard, and the two roles must
// learn the same thing about the same vehicle (ADR-0011).
var errVehicleNotVisible = errors.New("vehicle not visible")

// require refuses unless the actor's role carries the capability. Handlers
// assert capabilities, never role names (auth.Capability).
func require(a auth.Actor, c auth.Capability) error {
	if !a.Can(c) {
		return fmt.Errorf("%w: %s lacks %s", errForbidden, a.Role, c)
	}
	return nil
}
