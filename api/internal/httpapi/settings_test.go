package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type fleetSettingsBody struct {
	Fleet struct {
		Timezone       string  `json:"timezone"`
		Currency       string  `json:"currency"`
		PressureUnit   string  `json:"pressureUnit"`
		DistanceUnit   string  `json:"distanceUnit"`
		HistoryHorizon *string `json:"historyHorizon"`
	} `json:"fleet"`
	Thresholds []struct {
		OperatingGroupName *string  `json:"operatingGroupName"`
		AxleClass          *string  `json:"axleClass"`
		RemovalThresholdMm float64  `json:"removalThresholdMm"`
		WarningThresholdMm *float64 `json:"warningThresholdMm"`
		MaxRetreads        int      `json:"maxRetreads"`
		RetreadsPermitted  bool     `json:"retreadsPermitted"`
		EffectiveFrom      *string  `json:"effectiveFrom"`
	} `json:"thresholds"`
	Consent []struct {
		Purpose       string `json:"purpose"`
		Granted       bool   `json:"granted"`
		NoticeVersion string `json:"noticeVersion"`
		GivenAt       string `json:"givenAt"`
	} `json:"consent"`
	PriceList []struct {
		SizeName      string  `json:"sizeName"`
		BrandName     *string `json:"brandName"`
		TypicalPrice  *string `json:"typicalPrice"`
		EffectiveFrom string  `json:"effectiveFrom"`
	} `json:"priceList"`
	Catalogue struct {
		Sizes []struct {
			Name                string  `json:"name"`
			PlatformCatalogueID *string `json:"platformCatalogueId"`
		} `json:"sizes"`
	} `json:"catalogue"`
	MoneyVisible bool `json:"moneyVisible"`
}

// The settings page is a manager's (ManageConfig): a TECHNICIAN and a
// DRIVER are refused, a CONTROLLER reads it.
func TestFleetSettingsIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "settings-gate")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	for _, tt := range []struct {
		role auth.Role
		want int
	}{
		{auth.RoleTechnician, http.StatusForbidden},
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleController, http.StatusOK},
	} {
		t.Run(string(tt.role), func(t *testing.T) {
			user := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/fleet-settings", tenantID.String(), user.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// Each section relays the database's own reading of what is in force
// (FR-TEN-021, FR-CFG-005, FR-CFG-012, FR-CFG-021, FR-CFG-022, FR-TEN-022,
// FR-CFG-042).
func TestFleetSettingsRelaysEachSection(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "settings-sections")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// The seed runs in one admin transaction that binds the tenant, so no
	// later query on the connection inherits it.
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String())
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT app.seed_tenant_catalogue()`)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
	plantNamed(t, ctx, admin, "tyre_size", tenantID, "T283 OWN", true)

	_, err = admin.Exec(ctx, `UPDATE app.tenant SET history_horizon = '2026-10-01' WHERE id = $1`, tenantID)
	require.NoError(t, err)
	// The baseline reaches back over all history, so it carries no date; a
	// STEER row starts now.
	_, err = admin.Exec(ctx,
		`INSERT INTO app.threshold_policy
		   (tenant_id, axle_class, retread_threshold_mm, warning_threshold_mm, max_retreads,
		    retreads_permitted, effective_from)
		 VALUES ($1, NULL, 4.0, 6.0, 2, true, '-infinity'),
		        ($1, 'STEER', 5.0, NULL, 0, false, now())`, tenantID)
	require.NoError(t, err)
	_, err = admin.Exec(ctx,
		`INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, occurred_at)
		 VALUES ($1, 'ANONYMISED_BENCHMARKING', true,  'T283 v1', '2026-09-01T00:00:00Z'),
		        ($1, 'ANONYMISED_BENCHMARKING', false, 'T283 v2', '2026-10-01T00:00:00Z')`, tenantID)
	require.NoError(t, err)
	var size uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.tyre_size WHERE tenant_id = $1 AND name = '315/80R22.5'`, tenantID).Scan(&size))
	_, err = admin.Exec(ctx,
		`INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
		 VALUES ($1, $2, NULL, 3000.00, '2026-01-01'), ($1, $2, NULL, 3500.00, '2026-09-01')`,
		tenantID, size)
	require.NoError(t, err)

	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	rec := get(t, h, "/api/fleet-settings", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var body fleetSettingsBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

	require.Equal(t, "Africa/Johannesburg", body.Fleet.Timezone)
	require.Equal(t, "ZAR", body.Fleet.Currency)
	require.Equal(t, "KPA", body.Fleet.PressureUnit)
	require.Equal(t, "KM", body.Fleet.DistanceUnit)
	require.NotNil(t, body.Fleet.HistoryHorizon)
	require.Equal(t, "2026-10-01", *body.Fleet.HistoryHorizon)

	require.Len(t, body.Thresholds, 2)
	fleetWide, steer := body.Thresholds[0], body.Thresholds[1]
	require.Nil(t, fleetWide.AxleClass, "the fleet-wide row comes first")
	require.Nil(t, fleetWide.OperatingGroupName)
	require.Equal(t, 4.0, fleetWide.RemovalThresholdMm)
	require.NotNil(t, fleetWide.WarningThresholdMm)
	require.Equal(t, 6.0, *fleetWide.WarningThresholdMm)
	require.Equal(t, 2, fleetWide.MaxRetreads)
	require.True(t, fleetWide.RetreadsPermitted)
	require.Nil(t, fleetWide.EffectiveFrom, "a -infinity baseline has no date")
	require.NotNil(t, steer.AxleClass)
	require.Equal(t, "STEER", *steer.AxleClass)
	require.Equal(t, 5.0, steer.RemovalThresholdMm)
	require.Nil(t, steer.WarningThresholdMm)
	require.False(t, steer.RetreadsPermitted)
	require.NotNil(t, steer.EffectiveFrom)

	require.Len(t, body.Consent, 1)
	require.Equal(t, "ANONYMISED_BENCHMARKING", body.Consent[0].Purpose)
	require.False(t, body.Consent[0].Granted, "the withdrawal is the latest")
	require.Equal(t, "T283 v2", body.Consent[0].NoticeVersion)
	require.Equal(t, "2026-10-01T00:00:00Z", body.Consent[0].GivenAt)

	require.Len(t, body.PriceList, 1, "the superseded 3000.00 row is not in force")
	require.Equal(t, "315/80R22.5", body.PriceList[0].SizeName)
	require.Nil(t, body.PriceList[0].BrandName)
	require.NotNil(t, body.PriceList[0].TypicalPrice)
	require.Equal(t, "3500.00", *body.PriceList[0].TypicalPrice)
	require.Equal(t, "2026-09-01", body.PriceList[0].EffectiveFrom)

	lineage := map[string]*string{}
	for _, e := range body.Catalogue.Sizes {
		lineage[e.Name] = e.PlatformCatalogueID
	}
	require.Contains(t, lineage, "T283 OWN")
	require.Nil(t, lineage["T283 OWN"])
	require.NotNil(t, lineage["315/80R22.5"])
	require.True(t, body.MoneyVisible)
}

// A tenant with nothing configured answers every section empty, never
// null, and no horizon.
func TestFleetSettingsAnswersEmptySectionsForABareTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "settings-bare")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	rec := get(t, h, "/api/fleet-settings", tenantID.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var raw struct {
		Fleet      map[string]json.RawMessage `json:"fleet"`
		Thresholds json.RawMessage            `json:"thresholds"`
		Consent    json.RawMessage            `json:"consent"`
		PriceList  json.RawMessage            `json:"priceList"`
		Catalogue  map[string]json.RawMessage `json:"catalogue"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
	require.JSONEq(t, `null`, string(raw.Fleet["historyHorizon"]))
	require.JSONEq(t, `[]`, string(raw.Thresholds))
	require.JSONEq(t, `[]`, string(raw.Consent))
	require.JSONEq(t, `[]`, string(raw.PriceList))
	for _, list := range []string{"sizes", "brands", "patterns"} {
		require.JSONEq(t, `[]`, string(raw.Catalogue[list]), list)
	}
}
