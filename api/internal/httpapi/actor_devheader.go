//go:build devheader

package httpapi

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

// HeaderActorResolver trusts X-Tenant-ID and X-User-ID verbatim. DEV ONLY,
// and compiled only with -tags devheader (U103): anyone who can send a header
// is anyone, in any tenant, so in a deployed environment it would be a
// cross-tenant breach and an authentication bypass by construction
// (ADR-0011). A nil UUID names no one.
type HeaderActorResolver struct{}

func (HeaderActorResolver) Identify(_ context.Context, r *http.Request) (Identity, error) {
	tenantID, err := uuid.Parse(r.Header.Get("X-Tenant-ID"))
	if err != nil || tenantID == uuid.Nil {
		return Identity{}, fmt.Errorf("%w: X-Tenant-ID names no tenant", ErrUnauthenticated)
	}
	userID, err := uuid.Parse(r.Header.Get("X-User-ID"))
	if err != nil || userID == uuid.Nil {
		return Identity{}, fmt.Errorf("%w: X-User-ID names no user", ErrUnauthenticated)
	}
	return Identity{TenantID: tenantID, UserID: userID}, nil
}
