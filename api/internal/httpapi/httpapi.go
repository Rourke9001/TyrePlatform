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

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

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

func New(s *store.Store, resolver ActorResolver) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
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
//
//lint:ignore U1000 called by the capability gates TYRE-56 Task 5 adds
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

func listVehicles(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, _ auth.Actor) error {
			rows, err := tx.Query(ctx,
				`SELECT id, fleet_number, registration FROM app.vehicle ORDER BY fleet_number`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var v vehicleJSON
				if err := rows.Scan(&v.ID, &v.FleetNumber, &v.Registration); err != nil {
					return err
				}
				vehicles = append(vehicles, v)
			}
			return rows.Err()
		})
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(vehicles); err != nil {
			slog.ErrorContext(ctx, "encoding vehicles", "err", err)
		}
	}
}
