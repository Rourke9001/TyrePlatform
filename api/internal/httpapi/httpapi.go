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

	"tyreplatform/api/internal/store"
)

// TenantResolver names the tenant a request acts for. The production
// implementation arrives with the IdP integration under epic TYRE-2; until
// then only the dev header resolver exists, and main only wires it in when
// explicitly asked to.
type TenantResolver interface {
	TenantID(r *http.Request) (uuid.UUID, bool)
}

// HeaderTenantResolver trusts X-Tenant-ID verbatim. DEV ONLY: anyone who can
// send a header can pick a tenant, so wiring this into a deployed environment
// is a cross-tenant breach by construction.
type HeaderTenantResolver struct{}

func (HeaderTenantResolver) TenantID(r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.Header.Get("X-Tenant-ID"))
	if err != nil {
		return uuid.Nil, false
	}
	return id, true
}

func New(s *store.Store, resolver TenantResolver) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireTenant(resolver))
		r.Get("/vehicles", listVehicles(s))
		r.Get("/org/branding", orgBranding(s))
	})
	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}

type tenantKey struct{}

// requireTenant refuses any request it cannot attribute to a tenant. A nil
// resolver is the safe production default: with no way to name a tenant, no
// tenant-scoped route answers at all.
func requireTenant(resolver TenantResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if resolver == nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			id, ok := resolver.TenantID(r)
			if !ok {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), tenantKey{}, id)))
		})
	}
}

func tenantFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(tenantKey{}).(uuid.UUID)
	return id, ok
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
		tenantID, ok := tenantFrom(ctx)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		var b brandingJSON
		err := s.InTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
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
		if err != nil {
			slog.ErrorContext(ctx, "reading branding", "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
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
		tenantID, ok := tenantFrom(ctx)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		vehicles := []vehicleJSON{}
		err := s.InTenantTx(ctx, tenantID, func(tx pgx.Tx) error {
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
		if err != nil {
			slog.ErrorContext(ctx, "listing vehicles", "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(vehicles); err != nil {
			slog.ErrorContext(ctx, "encoding vehicles", "err", err)
		}
	}
}
