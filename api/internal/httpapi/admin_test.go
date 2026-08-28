package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type axleConfigBody struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// The library a create form picks from. Gated on ManageAssets — the capability
// that can act on the answer — so a driver is refused the list as well as the
// write (FR-AUT-005 is about what may be asked for, not only what comes back).
func TestAxleConfigurationsAreCapabilityGatedAndTenantScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg")
	otherID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg-other")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	require.Equal(t, http.StatusForbidden,
		get(t, h, "/api/axle-configurations", tenantID.String(), driver.String()).Code)

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/axle-configurations", tenantID.String(), orgAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var configs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &configs))
	require.Len(t, configs, 1, "the fixture plants exactly one configuration per tenant")
	require.Equal(t, "HTTPTEST", configs[0].Code)
	require.Equal(t, 2, configs[0].AxleCount)

	// The other tenant's configuration is not reachable, and the refusal is
	// emptiness rather than an error: RLS answers the question honestly.
	otherAdmin := plantUser(t, ctx, admin, otherID, auth.RoleOrgAdmin)
	rec = get(t, h, "/api/axle-configurations", otherID.String(), otherAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code)
	var otherConfigs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &otherConfigs))
	require.Len(t, otherConfigs, 1)
	require.NotEqual(t, configs[0].ID, otherConfigs[0].ID)
}
