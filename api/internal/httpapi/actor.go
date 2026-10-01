package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/google/uuid"
)

// Identity is who a request claims to be. It carries no role: the role is
// read from app.app_user on every request, so a stale or forged claim cannot
// grant anything (ADR-0011). Exactly one of UserID and Subject is set.
type Identity struct {
	TenantID  uuid.UUID // the dev header, or the token's tenant claim: a hint RLS proves (ADR-0016)
	UserID    uuid.UUID // dev resolver only
	Subject   uuid.UUID // bearer resolver only: the Entra oid
	SessionID string    // bearer resolver only
}

// ActorResolver names the identity a request acts as. Its error wraps one of
// the three refusals below; any other error is a 500.
type ActorResolver interface {
	Identify(ctx context.Context, r *http.Request) (Identity, error)
}

// The refusals a resolver reports (ADR-0016). A 401 sends the client to sign
// in, so an identity provider that cannot be reached is a 503.
var (
	ErrUnauthenticated = errors.New("the request does not identify a user")
	ErrNotProvisioned  = errors.New("a valid token with no usable tenant claim")
	ErrAuthUnavailable = errors.New("the identity provider is unavailable")
)

// logAttrs is a resolver error that says what may be logged about it: the
// kid alone before the signature verifies, the verified claims after.
type logAttrs interface{ LogAttrs() []any }

// HeaderActorResolver trusts X-Tenant-ID and X-User-ID verbatim. DEV ONLY:
// anyone who can send a header is anyone, in any tenant, so wiring this into
// a deployed environment is both a cross-tenant breach and an authentication
// bypass by construction (ADR-0011). A nil UUID names no one.
type HeaderActorResolver struct{}

func (HeaderActorResolver) Identify(_ context.Context, r *http.Request) (Identity, error) {
	tenantID, err := uuid.Parse(r.Header.Get("X-Tenant-ID"))
	if err != nil || tenantID == uuid.Nil {
		return Identity{}, fmt.Errorf("%w: X-Tenant-ID is not a uuid", ErrUnauthenticated)
	}
	userID, err := uuid.Parse(r.Header.Get("X-User-ID"))
	if err != nil || userID == uuid.Nil {
		return Identity{}, fmt.Errorf("%w: X-User-ID is not a uuid", ErrUnauthenticated)
	}
	return Identity{TenantID: tenantID, UserID: userID}, nil
}

type identityKey struct{}

// requireActor refuses any request it cannot attribute to a user in a
// tenant. A nil resolver is a deployment with no AUTH_* configured: 503, not
// 401 (ADR-0016). Every refusal is logged with the client address, which is
// FR-AUD-004's record of a token the API refused.
func requireActor(resolver ActorResolver, trustedProxyHops int) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			if resolver == nil {
				writeError(ctx, w, http.StatusServiceUnavailable, codeAuthUnavailable, msgAuthUnavailable)
				return
			}
			id, err := resolver.Identify(ctx, r)
			if err == nil {
				next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, identityKey{}, id)))
				return
			}
			attrs := []any{"client", clientAddress(r, trustedProxyHops)}
			var la logAttrs
			if errors.As(err, &la) {
				attrs = append(attrs, la.LogAttrs()...)
			} else {
				attrs = append(attrs, "err", err.Error())
			}
			switch {
			case errors.Is(err, ErrUnauthenticated):
				slog.WarnContext(ctx, "refusing an unidentified request", attrs...)
				writeError(ctx, w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
			case errors.Is(err, ErrNotProvisioned):
				slog.WarnContext(ctx, "refusing a token with no platform tenant", attrs...)
				writeError(ctx, w, http.StatusForbidden, codeNotProvisioned, msgNotProvisioned)
			case errors.Is(err, ErrAuthUnavailable):
				slog.WarnContext(ctx, "identity provider unavailable", attrs...)
				writeError(ctx, w, http.StatusServiceUnavailable, codeAuthUnavailable, msgAuthUnavailable)
			default:
				slog.ErrorContext(ctx, "identity resolver failed", attrs...)
				writeError(ctx, w, http.StatusInternalServerError, codeInternal, msgInternal)
			}
		})
	}
}

func identityFrom(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}

// actorAttrs names the actor in a refusal log: the subject, or the user id
// under the dev resolver, with the tenant and the session (spec section 1).
func actorAttrs(id Identity) []any {
	return []any{"tenant", id.TenantID, "subject", id.Subject, "user", id.UserID, "session", id.SessionID}
}
