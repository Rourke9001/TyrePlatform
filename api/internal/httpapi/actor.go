package httpapi

import (
	"context"
	"net/http"

	"github.com/google/uuid"
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
