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
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
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
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			id, ok := resolver.Identify(r)
			if !ok {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
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
// TY001/TY002 (odometer plausibility, Task 1) are deliberately absent: both
// are trapped inside app.submit_inspection's own exception block and turned
// into an app.inspection_warning row, so they never escape as an error for
// this map to see. TY010 (no tenant/actor bound) is also deliberately
// absent — that is a genuine invariant breach, not a client mistake, so the
// default 500 is the honest answer.
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
}

func statusForPgError(err error) (int, string, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return 0, "", false
	}
	if code, found := submitStatus[pgErr.Code]; found {
		return code, pgErr.Message, true
	}
	return 0, "", false
}

// withActor is the one place a handler turns an identity into an actor. It
// owns the refusal vocabulary so no handler invents its own: 401 means we do
// not know who you are, 403 means we do and you may not.
func withActor(w http.ResponseWriter, r *http.Request, s *store.Store, fn func(pgx.Tx, auth.Actor) error) bool {
	ctx := r.Context()
	id, ok := identityFrom(ctx)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	err := s.InActorTx(ctx, id.TenantID, id.UserID, fn)
	code, msg, isClient := statusForPgError(err)
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrNoSuchActor):
		// Deliberately indistinguishable to the client: whether the user is
		// deactivated or simply not in this tenant is not theirs to learn.
		slog.WarnContext(ctx, "refusing unresolvable actor", "tenant", id.TenantID, "user", id.UserID)
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	case errors.Is(err, errForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	case isClient:
		http.Error(w, msg, code)
		return false
	default:
		slog.ErrorContext(ctx, "actor transaction failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return false
	}
}

// errForbidden lets a handler refuse from inside the transaction and have
// withActor shape the response, so the capability check reads inline with the
// query it guards rather than as a separate pre-flight.
var errForbidden = errors.New("capability not held")

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
}

// me tells the client what to render. Presentation only — every other
// endpoint re-checks server-side, because a client-side control is a
// convenience and never a boundary (NFR-SEC-006).
func me(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body meJSON
		ok := withActor(w, r, s, func(_ pgx.Tx, a auth.Actor) error {
			body = meJSON{
				UserID:       a.UserID.String(),
				DisplayName:  a.DisplayName,
				Role:         string(a.Role),
				Capabilities: []string{},
				Depots:       []string{},
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
