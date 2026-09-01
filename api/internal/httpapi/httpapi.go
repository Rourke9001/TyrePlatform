// Package httpapi assembles the HTTP surface: routing, tenant resolution and
// the handlers. Handlers stay dumb — a business decision about tyres belongs
// in SQL, not here (api/CLAUDE.md).
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// Identity is who a request claims to be. It carries no role: the role is
// read from app.app_user on every request, so a stale or forged claim cannot
// grant anything (ADR-0011).
type Identity struct {
	TenantID uuid.UUID
	UserID   uuid.UUID
}

// ActorResolver names the identity a request acts as. The production
// implementation arrives with the identity provider (FR-AUT-001); until then
// only the dev header resolver exists, and main wires it in only when asked.
type ActorResolver interface {
	Identify(r *http.Request) (Identity, bool)
}

// HeaderActorResolver trusts X-Tenant-ID and X-User-ID verbatim. DEV ONLY:
// anyone who can send a header is anyone, in any tenant, so wiring this into
// a deployed environment is both a cross-tenant breach and an authentication
// bypass by construction (ADR-0011).
type HeaderActorResolver struct{}

func (HeaderActorResolver) Identify(r *http.Request) (Identity, bool) {
	tenantID, err := uuid.Parse(r.Header.Get("X-Tenant-ID"))
	if err != nil {
		return Identity{}, false
	}
	userID, err := uuid.Parse(r.Header.Get("X-User-ID"))
	if err != nil {
		return Identity{}, false
	}
	return Identity{TenantID: tenantID, UserID: userID}, true
}

// Option configures New. Variadic rather than a positional parameter: New
// has dozens of call sites, nearly all of them tests asserting behaviour
// that has nothing to do with proxy topology, and a rate-limiting knob
// should not force every one of them to state an opinion about it.
type Option func(*options)

type options struct {
	trustedProxyHops int
}

// WithTrustedProxyHops sets how many trusted L7 hops sit between the caller
// and this process, for NFR-SEC-007's per-source-address rate limit
// (ratelimit.go's clientAddress) to read the address the outermost trusted
// hop actually observed rather than one a caller can forge. Defaults to 1 —
// today's single Azure Container Apps ingress hop, infra/main.bicep's
// TRUSTED_PROXY_HOPS — for every call site that does not name one.
func WithTrustedProxyHops(n int) Option {
	return func(o *options) { o.trustedProxyHops = n }
}

func New(s *store.Store, resolver ActorResolver, opts ...Option) http.Handler {
	o := options{trustedProxyHops: 1}
	for _, opt := range opts {
		opt(&o)
	}

	r := chi.NewRouter()
	// chi answers both of these itself, in text/plain, unless they are
	// registered — the envelope's only escapees (ADR-0012).
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusNotFound, codeNotFound, "no such endpoint")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "that method is not allowed on this endpoint")
	})
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
		r.Post("/vehicles", createVehicle(s))
		r.Get("/my/vehicles", listMyVehicles(s))
		r.Get("/my/tasks", listMyTasks(s))
		r.Get("/capture/vehicles/{vehicleID}", captureContext(s))
		// NFR-SEC-007: rate-limited, unlike the reference read above — a
		// driver fetches capture context once per vehicle, but a bad outbox
		// retry loop or a hostile client can hammer a write. Built once
		// here, not per request (ratelimit.go's const comment).
		r.With(submitRateLimit(
			newRateLimiter(accountSubmitsPerMinute),
			newRateLimiter(addressSubmitsPerMinute),
			o.trustedProxyHops,
		)).Post("/inspections", submitInspection(s))
		r.Get("/org/branding", orgBranding(s))
		r.Get("/axle-configurations", listAxleConfigurations(s))
		r.Post("/users", createUser(s))
		r.Post("/vehicles/{vehicleID}/drivers", assignDriver(s))
	})
	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}

type identityKey struct{}

// requireActor refuses any request it cannot attribute to a user in a tenant.
// A nil resolver is the safe production default: with no way to name anyone,
// no scoped route answers at all.
func requireActor(resolver ActorResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if resolver == nil {
				writeError(r.Context(), w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
				return
			}
			id, ok := resolver.Identify(r)
			if !ok {
				writeError(r.Context(), w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
		})
	}
}

func identityFrom(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}

// The submit function raises its refusals with SQLSTATEs in a private class so
// the transport can tell a client mistake from a server fault. The 409 is
// load-bearing beyond politeness: the outbox retries a 5xx with backoff and
// surfaces FR-OFF-013's recovery action on a 409, so conflating the two would
// have a phone hammer a refusal that will never change.
//
// TY001/TY002 (DR-020 odometer plausibility) are deliberately absent: both
// are trapped inside app.submit_inspection's own exception block and turned
// into an app.inspection_warning row, so they never escape as an error for
// this map to see. TY010 (no tenant/actor bound) is also deliberately
// absent — that is a genuine invariant breach, not a client mistake, so the
// default 500 is the honest answer.
//
// The integrity classes below the private ones are the backstop to that rule
// rather than a second vocabulary. app.submit_inspection guards the shapes it
// can name and refuses them as TY005, but it cannot pre-empt every constraint
// the payload reaches — an unknown tyre_id or combination_id arrives as a
// foreign-key violation, and a value that will not parse as its column's type
// never reaches a guard at all, because the function's own DECLARE casts it.
// Each of those means "this body is wrong" and can only ever mean that: the
// identical payload fails identically on every retry. Left unmapped they are
// 500s, and a 500 is the one answer ADR-0009's outbox cannot survive.
//
// A blanket 23503 is safe across every write path because the message is
// canned (ADR-0012): a foreign-key violation means the request named
// something that does not exist, and 422 with no schema object in it is the
// honest answer wherever it is raised. A refusal a client must branch on
// earns a code of its own instead — raised as a TY in SQL where a rule is
// being evaluated, or translated from the constraint that detects it where
// the schema already states the rule (ADR-0013).

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
)

// Canned replacements for messages Postgres wrote. A driver's recovery action
// is the same for all of them — the payload is wrong in a way the database
// declined to name, and it fails identically on every retry — so one code
// covers the class (ADR-0012). msgConflict is separate only because it is a
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
)

var submitStatus = map[string]int{
	"TY003": http.StatusConflict,
	"TY004": http.StatusUnprocessableEntity,
	"TY005": http.StatusUnprocessableEntity,
	"TY006": http.StatusUnprocessableEntity,
	// TY007: an unrecognised or cross-tenant vehicle_id. Migration 000023's
	// own comment on this SQLSTATE explains why it exists — without an entry
	// here, the alternative is the composite FK violation (23503) reaching
	// this map unmapped and surfacing as a 500, which tells the outbox to
	// retry forever a submit that will never succeed. Reachable in practice
	// by a ScopeTenant actor (CONTROLLER/ORG_ADMIN), who skips the Go-side
	// v_capture_vehicle check above.
	"TY007": http.StatusUnprocessableEntity,

	"23502": http.StatusUnprocessableEntity, // not-null violation
	"23503": http.StatusUnprocessableEntity, // foreign key: an id this tenant cannot see
	"23514": http.StatusUnprocessableEntity, // check: FR-INS-030/031's hard ranges
	"22P02": http.StatusUnprocessableEntity, // a field that will not parse as its type
	"22023": http.StatusUnprocessableEntity, // a scalar where the payload promised an array
	// A duplicate client_uuid is FR-OFF-011's replay and app.submit_inspection
	// answers it as one, including when two concurrent drains race for the
	// same unique index. This entry catches any OTHER unique violation, which
	// is a conflict rather than a fault — and, like the classes above, must
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

// The conflicts a client acts on differently from any other conflict, keyed by
// the constraint that detects them (ADR-0013). The rule is the constraint's —
// DR-003 for a fleet number, D10 for an email, B1's exclusion for an
// assignment — and this map only names the refusal for a caller. The name is
// translated, never forwarded, so ADR-0012 holds; an unrecognised constraint
// keeps the generic conflict, which is the safe direction.
//
// These names are consulted only on the race the pre-insert classification
// misses, so no integration test reaches them in anger.
// TestConflictCodesNameLiveSchemaObjects asserts every key here names a live
// constraint or index, which is the guarantee the suite actually provides
// (TYRE-95).
var conflictCodes = map[string]string{
	"vehicle_tenant_id_fleet_number_key": codeFleetNumberTaken,
	"app_user_tenant_email_key":          codeEmailTaken,
	"vehicle_driver_no_overlap":          codeAssignmentOverlaps,
	// A rehire preserves the returning employee's staff_number rather than
	// blanking it (admin.go's COALESCE, FR-AUT-022), and 000019's partial
	// index permits another active user to hold that same number once the
	// original left (D2) — so the two legitimate rules collide on
	// reactivation. That is a state an admin must be told how to resolve,
	// not a bare conflict.
	"one_active_staff_number_per_tenant": codeStaffNumberTaken,
}

var conflictMessages = map[string]string{
	codeFleetNumberTaken:   msgFleetNumberTaken,
	codeEmailTaken:         msgEmailTaken,
	codeAssignmentOverlaps: msgAssignmentOverlaps,
	codeStaffNumberTaken:   msgStaffNumberTaken,
}

// Forwarding is decided by the TY class rather than by a list of safe codes.
// A message in that class is ours: app.submit_inspection writes it, it names
// no table or constraint, and it interpolates values a Go constant could not
// state — TY003's window is tenant configuration (rule 5, FR-INS-038). Every
// other message is Postgres's and can name a constraint and a table
// (reading_tyre_id_fkey), so it is canned. A SQLSTATE added to submitStatus
// without a case below is canned by default, which is the safe direction.
//
// No standard Postgres SQLSTATE class begins with T, so the class is ours
// alone and the prefix cannot collide.
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

// errVehicleNotVisible is the write path's FR-AUT-005 narrowing, answered as
// 422 and not 403 — the status and the wording are TY007's, deliberately.
// A ScopeTenant actor skips the Go-side check and meets the same condition at
// app.submit_inspection's TY007 guard, which answers 422 "vehicle not
// visible"; a driver refused here with 403 would tell the two roles different
// things about the same vehicle, which is the distinction ADR-0011 exists to
// deny. 422 says nothing about whether the vehicle exists elsewhere, so
// indistinguishability is preserved either way — and it is the status the
// capture design's refusal table already names for this row.
var errVehicleNotVisible = errors.New("vehicle not visible")

// require refuses unless the actor's role carries the capability. Handlers
// assert capabilities, never role names (auth.Capability).
func require(a auth.Actor, c auth.Capability) error {
	if !a.Can(c) {
		return fmt.Errorf("%w: %s lacks %s", errForbidden, a.Role, c)
	}
	return nil
}

type meJSON struct {
	UserID       string   `json:"userId"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Depots       []string `json:"depots"`
	// The tenant's IANA zone, so the client can render a stored UTC instant
	// as the tenant's civil time (rule 6, FR-TEN-005). Sent here rather than
	// per-response because it changes about never and every screen needs it.
	Timezone string `json:"timezone"`
	// The tenant's display code policy, either "FREE" or "GENERATED".
	DisplayCodePolicy string `json:"displayCodePolicy"`
}

// me tells the client what to render. Presentation only — every other
// endpoint re-checks server-side, because a client-side control is a
// convenience and never a boundary (NFR-SEC-006).
func me(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body meJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			body = meJSON{
				UserID:       a.UserID.String(),
				DisplayName:  a.DisplayName,
				Role:         string(a.Role),
				Capabilities: []string{},
				Depots:       []string{},
			}
			// In the actor's own transaction, so RLS answers for this tenant
			// and the row cannot be another's.
			if err := tx.QueryRow(ctx,
				`SELECT timezone, display_code_policy FROM app.tenant WHERE id = app.current_tenant_id()`).
				Scan(&body.Timezone, &body.DisplayCodePolicy); err != nil {
				return fmt.Errorf("reading tenant timezone and display-code policy: %w", err)
			}
			for _, c := range a.Capabilities() {
				body.Capabilities = append(body.Capabilities, string(c))
			}
			for _, d := range a.DepotIDs {
				body.Depots = append(body.Depots, d.String())
			}
			return nil
		})
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(body); err != nil {
			slog.ErrorContext(ctx, "encoding me", "err", err)
		}
	}
}

// defaultPrimaryColor is the platform's own brand blue, used until a tenant
// configures one. Chrome only — never a status colour, and not a threshold,
// so hard-coding it does not touch rule 5. The web's design tokens (TYRE-27)
// carry the same value as their default.
const defaultPrimaryColor = "#14586E"

type brandingJSON struct {
	DisplayName  string  `json:"displayName"`
	PrimaryColor string  `json:"primaryColor"`
	LogoURL      *string `json:"logoUrl"`
}

// orgBranding serves the tenant's branding from configuration key "branding"
// (FR-TEN-011; stored per rule 5 in app.configuration). The governing row is
// the newest effective_from not in the future — FR-CFG-051, prospective only.
// An absent key is not an error: the tenant simply has not branded yet, so
// the response falls back to its registered name and the platform colour.
func orgBranding(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var b brandingJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, _ auth.Actor) error {
			var raw []byte
			err := tx.QueryRow(ctx,
				`SELECT value FROM app.configuration
				  WHERE key = 'branding' AND effective_from <= now()
				  ORDER BY effective_from DESC LIMIT 1`).Scan(&raw)
			if err == nil {
				return json.Unmarshal(raw, &b)
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			// The tenant_self RLS policy scopes this to the session's own row.
			if err := tx.QueryRow(ctx,
				`SELECT name FROM app.tenant`).Scan(&b.DisplayName); err != nil {
				return fmt.Errorf("reading tenant name for branding fallback: %w", err)
			}
			b.PrimaryColor = defaultPrimaryColor
			return nil
		})
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(b); err != nil {
			slog.ErrorContext(ctx, "encoding branding", "err", err)
		}
	}
}

type vehicleJSON struct {
	ID           string  `json:"id"`
	FleetNumber  string  `json:"fleetNumber"`
	Registration *string `json:"registration"`
}

// listVehicles is the management fleet list. A DRIVER does not hold ViewFleet
// and is refused here rather than filtered — FR-AUT-005 is about what they
// may ask for, not only about what comes back. Their route is /api/my/vehicles.
//
// The source relation is chosen by auth.Actor.Scope, never by role name
// (ADR-0006): the depot-narrowed app.v_depot_vehicle is the default and
// app.vehicle — the whole tenant — is the exception earned only by
// ScopeTenant. A role added later without a scope entry lands on the narrow
// default rather than silently reading everything (FR-AUT-006/007/008).
func listVehicles(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: writeJSON encodes whatever it is handed, so an
		// empty result must already be []T{} here or the client gets JSON
		// `null` instead of `[]` for "no rows" (repeated below and in
		// listMyVehicles/listMyTasks — same reason each time).
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			source := `app.v_depot_vehicle`
			if a.Scope() == auth.ScopeTenant {
				source = `app.vehicle`
			}
			var err error
			vehicles, err = scanVehicles(ctx, tx,
				`SELECT id, fleet_number, registration FROM `+source+` ORDER BY fleet_number`)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, vehicles)
	}
}

// listMyVehicles is the driver's own list, through the single predicate that
// defines "currently assigned to me" (FR-AUT-005, app.v_driver_vehicle).
// A driver assigned nothing gets an empty list: asking is legitimate, and the
// answer is legitimately nothing.
func listMyVehicles(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			var err error
			vehicles, err = scanVehicles(ctx, tx,
				`SELECT DISTINCT vehicle_id, fleet_number, registration
				   FROM app.v_driver_vehicle ORDER BY fleet_number`)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, vehicles)
	}
}

type taskJSON struct {
	ID          string `json:"id"`
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
	DueAt       string `json:"dueAt"`
	State       string `json:"state"`
	Overdue     bool   `json:"overdue"`
}

// listMyTasks is the driver's outstanding work (FR-DSH-012). Overdue is
// computed in the view, not here: it is an OPEN task past its due date and
// never a state the client may infer for itself.
func listMyTasks(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tasks := []taskJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			// The scope view must stay the driving relation: app.vehicle is
			// reached only through v_my_inspection_task's already-narrowed
			// rows, never joined the other way round (ADR-0006).
			rows, err := tx.Query(ctx,
				`SELECT t.id, t.vehicle_id, v.fleet_number, t.due_at, t.state::text, t.overdue
				   FROM app.v_my_inspection_task t
				   JOIN app.vehicle v ON v.id = t.vehicle_id
				  ORDER BY t.due_at`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var t taskJSON
				var due time.Time
				if err := rows.Scan(&t.ID, &t.VehicleID, &t.FleetNumber, &due, &t.State, &t.Overdue); err != nil {
					return err
				}
				t.DueAt = due.UTC().Format(time.RFC3339)
				tasks = append(tasks, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, tasks)
	}
}

func scanVehicles(ctx context.Context, tx pgx.Tx, query string) ([]vehicleJSON, error) {
	rows, err := tx.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	vehicles := []vehicleJSON{}
	for rows.Next() {
		var v vehicleJSON
		if err := rows.Scan(&v.ID, &v.FleetNumber, &v.Registration); err != nil {
			return nil, err
		}
		vehicles = append(vehicles, v)
	}
	return vehicles, rows.Err()
}

// writeJSON is the one encode-and-log path shared by the list handlers. It
// encodes exactly what it is handed — the empty-vs-null guarantee belongs to
// each caller's slice initialisation, not to this function.
func writeJSON(ctx context.Context, w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.ErrorContext(ctx, "encoding response", "err", err)
	}
}

// errorBody is the refusal envelope every endpoint answers with (ADR-0012).
// Code is the machine-readable reason a client branches on.
// Message's audience depends on who wrote it (ADR-0013): a message written in
// Go or raised as a TY in SQL is ours and may be rendered, and a message
// Postgres wrote is canned before it ever reaches this struct. A driver's
// sentence is still the client's, keyed on Code — that is FR-OFF-013's
// recovery action and not a diagnostic.
type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeError is the only way a refusal reaches the wire, so that one shape
// covers every endpoint rather than each inventing its own (ADR-0012).
//
// Content-Type is set before WriteHeader: WriteHeader locks the header map in,
// so writeJSON's own Set would be dropped and the response would go out as
// text/plain with every status assertion still green.
func writeError(ctx context.Context, w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	writeJSON(ctx, w, errorBody{Code: code, Message: message})
}
