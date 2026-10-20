package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type catalogueEntryBody struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type cataloguePatternBody struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	BrandID   *string `json:"brandId"`
	AppliesTo string  `json:"appliesTo"`
}

type tyreCatalogueBody struct {
	Sizes    []catalogueEntryBody   `json:"sizes"`
	Brands   []catalogueEntryBody   `json:"brands"`
	Patterns []cataloguePatternBody `json:"patterns"`
}

// plantNamed inserts one size or brand row through the admin connection.
// table is a constant at every call site.
func plantNamed(t *testing.T, ctx context.Context, admin *pgx.Conn, table string, tenantID uuid.UUID, name string, active bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.`+table+` (tenant_id, name, active) VALUES ($1, $2, $3) RETURNING id`,
		tenantID, name, active).Scan(&id))
	return id
}

func plantPattern(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, name string, brandID *uuid.UUID, appliesTo string, active bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tyre_pattern (tenant_id, name, brand_id, applies_to, active)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		tenantID, name, brandID, appliesTo, active).Scan(&id))
	return id
}

// ViewFleet, not ManageAssets: a TECHNICIAN reads the catalogue and a DRIVER
// does not (the receive spec's Q2).
func TestTyreCatalogueIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "catalogue-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleTechnician, http.StatusOK},
		{auth.RoleController, http.StatusOK},
		{auth.RoleDepotManager, http.StatusOK},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/tyre-catalogue", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// Active rows of one tenant, in order (spec Q4, NFR-USE-012, rule 1).
// The names are ones where length-then-name and natural order agree and
// lexicographic order does not: 11R22.5 and 315/80R22.5 sort before 9R22.5
// as text, B10 before B2, SP43 before SP9.
func TestTyreCatalogueOffersOneTenantsActiveRowsInOrder(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "catalogue")
	otherID, _ := plantTenant(t, ctx, admin, "catalogue-other")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	for _, name := range []string{"315/80R22.5", "11R22.5", "9R22.5"} {
		plantNamed(t, ctx, admin, "tyre_size", tenantID, name, true)
	}
	plantNamed(t, ctx, admin, "tyre_size", tenantID, "10R22.5", false)
	b10 := plantNamed(t, ctx, admin, "tyre_brand", tenantID, "B10", true)
	plantNamed(t, ctx, admin, "tyre_brand", tenantID, "B2", true)
	retired := plantNamed(t, ctx, admin, "tyre_brand", tenantID, "B3", false)
	sp431 := plantPattern(t, ctx, admin, tenantID, "SP431", &b10, "NEW", true)
	sp43 := plantPattern(t, ctx, admin, tenantID, "SP43", nil, "BOTH", true)
	sp9 := plantPattern(t, ctx, admin, tenantID, "SP9", nil, "RETREAD", true)
	plantPattern(t, ctx, admin, tenantID, "SP5", nil, "NEW", false)
	plantPattern(t, ctx, admin, tenantID, "SP6", &retired, "NEW", true)
	otherSize := plantNamed(t, ctx, admin, "tyre_size", otherID, "7R22.5", true)

	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	rec := get(t, h, "/api/tyre-catalogue", tenantID.String(), tech.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body tyreCatalogueBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	sizes := []string{}
	for _, e := range body.Sizes {
		sizes = append(sizes, e.Name)
	}
	require.Equal(t, []string{"9R22.5", "11R22.5", "315/80R22.5"}, sizes,
		"active sizes only, and never another tenant's 7R22.5")
	brands := []string{}
	for _, e := range body.Brands {
		brands = append(brands, e.Name)
	}
	require.Equal(t, []string{"B2", "B10"}, brands, "B3 is deactivated")
	b10ID := b10.String()
	require.Equal(t, []cataloguePatternBody{
		{ID: sp9.String(), Name: "SP9", BrandID: nil, AppliesTo: "RETREAD"},
		{ID: sp43.String(), Name: "SP43", BrandID: nil, AppliesTo: "BOTH"},
		{ID: sp431.String(), Name: "SP431", BrandID: &b10ID, AppliesTo: "NEW"},
	}, body.Patterns, "SP5 is deactivated, and SP6's brand is, so neither is offered")

	// The other tenant reads its own row, and an empty list is [] on the
	// wire, never null.
	otherTech := plantUser(t, ctx, admin, otherID, auth.RoleTechnician)
	rec = get(t, h, "/api/tyre-catalogue", otherID.String(), otherTech.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.JSONEq(t,
		`{"sizes":[{"id":"`+otherSize.String()+`","name":"7R22.5","platformCatalogueId":null}],"brands":[],"patterns":[]}`,
		rec.Body.String())
}

// FR-CFG-005: each row says whether it came from the platform catalogue,
// by the platform entry it was seeded from, or was added for this fleet.
// The seed runs on the admin connection inside one transaction that binds
// the tenant, so no later query on that connection inherits the binding.
func TestTyreCatalogueCarriesPlatformLineage(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "catalogue-lineage")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String())
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT app.seed_tenant_catalogue()`)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	plantNamed(t, ctx, admin, "tyre_size", tenantID, "T283 OWN", true)

	var platformSize, platformPattern string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT md5('platform_tyre_size:315/80R22.5')::uuid::text, md5('platform_tyre_pattern:SP431')::uuid::text`).
		Scan(&platformSize, &platformPattern))

	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	rec := get(t, h, "/api/tyre-catalogue", tenantID.String(), tech.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body struct {
		Sizes []struct {
			ID                  string  `json:"id"`
			Name                string  `json:"name"`
			PlatformCatalogueID *string `json:"platformCatalogueId"`
		} `json:"sizes"`
		Patterns []struct {
			Name                string  `json:"name"`
			PlatformCatalogueID *string `json:"platformCatalogueId"`
		} `json:"patterns"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	lineage := map[string]*string{}
	for _, e := range body.Sizes {
		lineage[e.Name] = e.PlatformCatalogueID
	}
	require.Contains(t, lineage, "T283 OWN")
	require.Nil(t, lineage["T283 OWN"], "a size added for this fleet has no lineage")
	require.NotNil(t, lineage["315/80R22.5"])
	require.Equal(t, platformSize, *lineage["315/80R22.5"])
	var sp431 *string
	for _, p := range body.Patterns {
		if p.Name == "SP431" {
			sp431 = p.PlatformCatalogueID
		}
	}
	require.NotNil(t, sp431, "the seeded SP431 is offered with its lineage")
	require.Equal(t, platformPattern, *sp431)
}
