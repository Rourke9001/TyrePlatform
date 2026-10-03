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

var analyticsRoutes = []string{
	"/api/analytics/tread-distribution",
	"/api/analytics/irregular-wear",
	"/api/analytics/inflation-compliance",
	"/api/analytics/wear-rate",
	"/api/analytics/removal-forecast",
	"/api/spares",
}

func TestAnalyticsRoutesAreGatedOnViewFleet(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "analytics-gate")
	other, _ := plantTenant(t, ctx, admin, "analytics-other")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	stranger := plantUser(t, ctx, admin, other, auth.RoleController)
	for _, route := range analyticsRoutes {
		t.Run(route, func(t *testing.T) {
			require.Equal(t, http.StatusForbidden, get(t, h, route, tenantID.String(), driver.String()).Code)
			require.Equal(t, http.StatusUnauthorized, get(t, h, route, "", "").Code)
			// A technician on an empty tenant reads 200 from every route: an
			// unconfigured tile answers with a named absence, and inflation
			// answers TENANT_ONLY for a depot actor (U32). That the routes
			// open for ViewFleet at all is what this proves.
			rec := get(t, h, route, tenantID.String(), technician.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			// A stranger's tenant has nothing: every list is [] and no BAC
			// row leaks through any of the six (NFR-SEC-004).
			rec = get(t, h, route, other.String(), stranger.String())
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			require.NotContains(t, rec.Body.String(), "2102BAC")
		})
	}
}

type bandRow struct {
	KeyName          *string  `json:"keyName"`
	BandOrdinal      int      `json:"bandOrdinal"`
	BandLabel        string   `json:"bandLabel"`
	LowerMm          float64  `json:"lowerMm"`
	UpperExclusiveMm *float64 `json:"upperExclusiveMm"`
	TyreCount        int64    `json:"tyreCount"`
	PctOfGroup       float64  `json:"pctOfGroup"`
}

func TestTreadDistributionRelaysTheViewAndSumsDepots(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var body struct {
		Bands []bandRow `json:"bands"`
	}
	rec := get(t, h, "/api/analytics/tread-distribution", bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Bands, 5)

	// Relay fidelity: the TENANT/RUNNING rows of the view, band for band.
	rows, err := admin.Query(ctx, `
		SELECT band_ordinal, band_label, lower_mm::float8, upper_exclusive_mm::float8, tyre_count, pct_of_group::float8
		  FROM app.v_tread_distribution
		 WHERE tenant_id = $1 AND level = 'TENANT' AND position_class = 'ALL'
		 ORDER BY band_ordinal`, bacTenant)
	require.NoError(t, err)
	defer rows.Close()
	var want []bandRow
	for rows.Next() {
		var r bandRow
		require.NoError(t, rows.Scan(&r.BandOrdinal, &r.BandLabel, &r.LowerMm, &r.UpperExclusiveMm, &r.TyreCount, &r.PctOfGroup))
		want = append(want, r)
	}
	require.NoError(t, rows.Err())
	require.Equal(t, want, body.Bands)

	// Depot scope on a name-keyed view: the planted tenant's two 3.0 mm
	// tyres land in the first band; the technician of depot A sees one.
	f := plantDepotFixture(t, ctx, admin, "bands-scope")
	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	technician := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	assignDepot(t, ctx, admin, f.Tenant, technician, f.DepotA)
	rec = get(t, h, "/api/analytics/tread-distribution", f.Tenant.String(), controller.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(2), body.Bands[0].TyreCount)
	require.Equal(t, 100.0, body.Bands[0].PctOfGroup)
	rec = get(t, h, "/api/analytics/tread-distribution", f.Tenant.String(), technician.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(1), body.Bands[0].TyreCount)
	require.Equal(t, 100.0, body.Bands[0].PctOfGroup)
	rec = get(t, h, "/api/analytics/tread-distribution?level=DEPOT", f.Tenant.String(), controller.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Bands, 10)
}

// app.tread_band_list closes each band at the next one's lower bound, so the
// bands leave one gap and it is below the lowest: a tyre worn under it is in
// the population the view divides by and in no band. The summed reading has
// to divide by that population too, or a share of the banded tyres is
// reported as a share of the fleet (FR-ANL-024).
func TestTreadDistributionDividesByThePopulationNotTheBands(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	// Bands from 4 mm up, so the fixture's two 3.0 mm tyres are unbanded,
	// and one 5.0 mm tyre in depot A is the only banded one.
	f := plantDepotFixture(t, ctx, admin, "bands-gap")
	_, err := admin.Exec(ctx,
		`INSERT INTO app.configuration (tenant_id, key, value, effective_from)
		 VALUES ($1, 'tread_bands', '[[4,7],[7,null]]'::jsonb, now() - interval '300 days')`, f.Tenant)
	require.NoError(t, err)
	plantBandedTyre(t, ctx, admin, f)
	controller := plantUser(t, ctx, admin, f.Tenant, auth.RoleController)
	technician := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	assignDepot(t, ctx, admin, f.Tenant, technician, f.DepotA)

	var body struct {
		Bands []bandRow `json:"bands"`
	}
	rec := get(t, h, "/api/analytics/tread-distribution", f.Tenant.String(), controller.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(1), body.Bands[0].TyreCount)
	require.Equal(t, 33.33, body.Bands[0].PctOfGroup)

	// One group, so every figure the API returns is the view's own.
	rows, err := admin.Query(ctx, `
		SELECT pct_of_group::float8
		  FROM app.v_tread_distribution
		 WHERE tenant_id = $1 AND level = 'TENANT' AND position_class = 'ALL'
		 ORDER BY band_ordinal`, f.Tenant)
	require.NoError(t, err)
	defer rows.Close()
	var want []float64
	for rows.Next() {
		var pct float64
		require.NoError(t, rows.Scan(&pct))
		want = append(want, pct)
	}
	require.NoError(t, rows.Err())
	require.Len(t, body.Bands, len(want))
	for i, band := range body.Bands {
		require.Equal(t, want[i], band.PctOfGroup, "band %d", i)
	}

	// The depot actor sums its own DEPOT rows, and depot A holds two tyres
	// of which one is banded.
	rec = get(t, h, "/api/analytics/tread-distribution", f.Tenant.String(), technician.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, int64(1), body.Bands[0].TyreCount)
	require.Equal(t, 50.0, body.Bands[0].PctOfGroup)
}

// plantBandedTyre fits a 5.0 mm tyre on a new unit in the fixture's depot A.
func plantBandedTyre(t *testing.T, ctx context.Context, admin *pgx.Conn, f depotFixture) {
	t.Helper()
	suffix := uuid.NewString()[:8]
	var configID, posID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT v.configuration_id, p.id
		   FROM app.vehicle v JOIN app.position p ON p.configuration_id = v.configuration_id
		  WHERE v.id = $1`, f.VehicleA).Scan(&configID, &posID))

	var vehicleID, tyreID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind, home_depot_id)
		 VALUES ($1, $2, $3, 'HORSE'::app.unit_kind, $4) RETURNING id`,
		f.Tenant, "GAP-"+suffix, configID, f.DepotA).Scan(&vehicleID))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tyre (tenant_id, display_code, purchase_price, cost_source, new_tread_mm, rand_per_mm, casing_value, state)
		 VALUES ($1, $2, 1000.00, 'INVOICE'::app.cost_source, 14.0, 100.0000, 100.00, 'FITTED') RETURNING id`,
		f.Tenant, "GAP-TYRE-"+suffix).Scan(&tyreID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
		 VALUES ($1, $2, $3, $4, now() - interval '90 days', 0)`,
		f.Tenant, tyreID, vehicleID, posID)
	require.NoError(t, err)

	driver := plantUser(t, ctx, admin, f.Tenant, auth.RoleDriver)
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	var inspID, readingID uuid.UUID
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
		 VALUES ($1, $2, $3, $4, now() - interval '30 days', now() - interval '30 days', 50000) RETURNING id`,
		f.Tenant, vehicleID, driver, uuid.New()).Scan(&inspID))
	require.NoError(t, tx.QueryRow(ctx,
		`INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
		 VALUES ($1, $2, $3, $4, $5, 800) RETURNING id`,
		f.Tenant, inspID, vehicleID, posID, tyreID).Scan(&readingID))
	_, err = tx.Exec(ctx,
		`INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm)
		 VALUES ($1, $2, 1, 'OUTER'::app.tread_position, 5.0),
		        ($1, $2, 2, 'CENTRE'::app.tread_position, 5.1),
		        ($1, $2, 3, 'INNER'::app.tread_position, 5.2)`,
		f.Tenant, readingID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

// The ranking at or over the configured 4 mm spread, the spare disclosed
// only on request. Section 8 pins FR-EXC-035 at five running positions on
// the July sheet; the ranking judges each tyre's latest reading, so the
// count is read from the view rather than assumed to be that five.
func TestIrregularWearAppliesTheConfiguredSpread(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	var body struct {
		SpreadWarnMm *float64 `json:"spreadWarnMm"`
		RankScope    string   `json:"rankScope"`
		Tyres        []struct {
			IsSpare       bool      `json:"isSpare"`
			WidthSpreadMm float64   `json:"widthSpreadMm"`
			Measurements  []float64 `json:"measurements"`
			Rank          int       `json:"rank"`
		} `json:"tyres"`
	}
	rec := get(t, h, "/api/analytics/irregular-wear", bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 4.0, *body.SpreadWarnMm)
	require.Equal(t, "TENANT", body.RankScope)
	var running int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.v_irregular_wear_ranking WHERE tenant_id = $1 AND NOT is_spare AND width_spread_mm >= 4`, bacTenant).Scan(&running))
	require.Positive(t, running)
	require.Len(t, body.Tyres, running)
	for _, ty := range body.Tyres {
		require.False(t, ty.IsSpare)
		require.GreaterOrEqual(t, ty.WidthSpreadMm, 4.0)
		require.Len(t, ty.Measurements, 3)
	}
	rec = get(t, h, "/api/analytics/irregular-wear?includeSpares=true", bacTenant, seedID("controller1").String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	var all int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.v_irregular_wear_ranking WHERE tenant_id = $1 AND width_spread_mm >= 4`, bacTenant).Scan(&all))
	require.Greater(t, all, running)
	require.Len(t, body.Tyres, all)
}

func TestWearRateRelaysEveryFittedTyre(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	var body struct {
		Tyres []struct {
			DisplayCode         string   `json:"displayCode"`
			WearRateStatus      string   `json:"wearRateStatus"`
			WearRateMmPer1000Km *float64 `json:"wearRateMmPer1000Km"`
			DistanceKm          *int64   `json:"distanceKm"`
		} `json:"tyres"`
	}
	rec := get(t, h, "/api/analytics/wear-rate", bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.v_tyre_wear_rate WHERE tenant_id = $1`, bacTenant).Scan(&n))
	require.Len(t, body.Tyres, n)
	measured := 0
	for _, ty := range body.Tyres {
		if ty.WearRateStatus == "MEASURED" {
			measured++
			require.NotNil(t, ty.WearRateMmPer1000Km)
			require.NotNil(t, ty.DistanceKm)
		}
	}
	require.Positive(t, measured)
}

// Section 59e over HTTP, at the date it pins (U34): six running tyres reach
// the threshold within the configured 30 days of 2026-08-01; two within 7.
func TestRemovalForecastPinsTheHorizonAtADate(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	var body struct {
		HorizonDays *int    `json:"horizonDays"`
		From        string  `json:"from"`
		Unavailable *string `json:"unavailable"`
		Tyres       []struct {
			ForecastStatus      string  `json:"forecastStatus"`
			EarliestRemovalDate *string `json:"earliestRemovalDate"`
			IsSpare             bool    `json:"isSpare"`
		} `json:"tyres"`
	}
	nomsa := seedID("controller1").String()
	rec := get(t, h, "/api/analytics/removal-forecast?from=2026-08-01", bacTenant, nomsa)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 30, *body.HorizonDays)
	require.Equal(t, "2026-08-01", body.From)
	require.Nil(t, body.Unavailable)
	require.Len(t, body.Tyres, 6)
	for _, ty := range body.Tyres {
		require.Equal(t, "FORECAST", ty.ForecastStatus)
		require.False(t, ty.IsSpare)
		require.LessOrEqual(t, *ty.EarliestRemovalDate, "2026-08-31")
	}
	rec = get(t, h, "/api/analytics/removal-forecast?from=2026-08-01&horizonDays=7", bacTenant, nomsa)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Tyres, 2)

	// Without a horizon key the tile is not configured, never 30 by default.
	bare, _ := plantTenant(t, ctx, admin, "forecast-bare")
	user := plantUser(t, ctx, admin, bare, auth.RoleController)
	rec = get(t, h, "/api/analytics/removal-forecast", bare.String(), user.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Nil(t, body.HorizonDays)
	require.Equal(t, "NO_HORIZON", *body.Unavailable)
	require.Empty(t, body.Tyres)
}

func TestInflationComplianceWindowAndScope(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	var body struct {
		From        *string `json:"from"`
		To          *string `json:"to"`
		WindowDays  *int    `json:"windowDays"`
		Unavailable *string `json:"unavailable"`
		Bands       []struct {
			BandOrdinal  int    `json:"bandOrdinal"`
			BandKey      string `json:"bandKey"`
			ReadingCount int64  `json:"readingCount"`
		} `json:"bands"`
	}
	nomsa := seedID("controller1").String()

	// An explicit period is relayed from app.inflation_compliance directly;
	// five bands always, zero-filled (BR-RPT-004).
	rec := get(t, h, "/api/analytics/inflation-compliance?from=2026-07-01&to=2026-08-01", bacTenant, nomsa)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Len(t, body.Bands, 5)
	var wantTotal int64
	for _, b := range body.Bands {
		wantTotal += b.ReadingCount
	}
	// The control binds the tenant itself: the function reads
	// current_setting('app.tenant_id'), which the admin connection does not
	// carry, so an unbound control counts nothing and passes vacuously.
	var readings int64
	tx, err := admin.Begin(ctx)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, bacTenant)
	require.NoError(t, err)
	require.NoError(t, tx.QueryRow(ctx,
		`SELECT sum(reading_count) FROM app.inflation_compliance(DATE '2026-07-01', DATE '2026-08-01')`).Scan(&readings))
	require.NoError(t, tx.Rollback(ctx))
	require.Positive(t, readings)
	require.Equal(t, readings, wantTotal)

	// The default period is the configured window ending tomorrow, exclusive.
	rec = get(t, h, "/api/analytics/inflation-compliance", bacTenant, nomsa)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 30, *body.WindowDays)
	require.NotNil(t, body.From)
	require.NotNil(t, body.To)
	require.Len(t, body.Bands, 5)

	// Narrowing to a depot is refused the same way a depot-scoped actor is,
	// so this route and the dashboard's tile answer alike (U32).
	f2 := plantDepotFixture(t, ctx, admin, "inflation-depot-filter")
	owner := plantUser(t, ctx, admin, f2.Tenant, auth.RoleController)
	rec = get(t, h, "/api/analytics/inflation-compliance?depot="+f2.DepotA.String(), f2.Tenant.String(), owner.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "TENANT_ONLY", *body.Unavailable)
	require.Empty(t, body.Bands)

	// One bound without the other is a client mistake.
	rec = get(t, h, "/api/analytics/inflation-compliance?from=2026-07-01", bacTenant, nomsa)
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())

	// No window key, no default (rule 5, U28).
	bare, _ := plantTenant(t, ctx, admin, "inflation-bare")
	user := plantUser(t, ctx, admin, bare, auth.RoleController)
	rec = get(t, h, "/api/analytics/inflation-compliance", bare.String(), user.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "NO_WINDOW", *body.Unavailable)
	require.Empty(t, body.Bands)

	// The function has no depot dimension, so a depot actor is told so
	// rather than shown the tenant's figure (U32).
	f := plantDepotFixture(t, ctx, admin, "inflation-scope")
	technician := plantUser(t, ctx, admin, f.Tenant, auth.RoleTechnician)
	assignDepot(t, ctx, admin, f.Tenant, technician, f.DepotA)
	rec = get(t, h, "/api/analytics/inflation-compliance?from=2026-07-01&to=2026-08-01", f.Tenant.String(), technician.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "TENANT_ONLY", *body.Unavailable)
	require.Empty(t, body.Bands)
}

// Section 59e's spare row: 2102BACS, measured by a reading on 2026-07-23,
// 2.0 mm, and an age in whole days (FR-RPT-041: a spare is judged on age).
func TestSparesRelayTheFixtureSpare(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	requireSeed(t, ctx, admin)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	var body struct {
		JudgedAt string `json:"judgedAt"`
		Spares   []struct {
			DisplayCode       string   `json:"displayCode"`
			AgeDays           int      `json:"ageDays"`
			MeasuredSource    *string  `json:"measuredSource"`
			LastMeasuredAt    *string  `json:"lastMeasuredAt"`
			CurrentTreadMm    *float64 `json:"currentTreadMm"`
			DaysSinceMeasured *int     `json:"daysSinceMeasured"`
		} `json:"spares"`
	}
	rec := get(t, h, "/api/spares", bacTenant, seedID("controller1").String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "TENANT_TODAY", body.JudgedAt)
	require.Len(t, body.Spares, 1)
	sp := body.Spares[0]
	require.Equal(t, "2102BACS", sp.DisplayCode)
	require.Equal(t, "READING", *sp.MeasuredSource)
	require.Equal(t, 2.0, *sp.CurrentTreadMm)
	require.True(t, len(*sp.LastMeasuredAt) >= 10 && (*sp.LastMeasuredAt)[:10] == "2026-07-23", *sp.LastMeasuredAt)
	require.GreaterOrEqual(t, sp.AgeDays, 0)
}
