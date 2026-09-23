package httpapi

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	req "github.com/stretchr/testify/require" // aliased: see ratelimit_test.go
)

// schemaFunctions and schemaViews are every app.<name>( and app.v_<name>
// literal this package's own SQL strings name (excluding _test.go files,
// which is why this list is shorter than a whole-repo grep: a test fixture's
// setup query is covered transitively by the integration tests that run it,
// not by this catalogue). TYRE-184 F6: conflictCodes and the two enum
// mirrors already had a live-schema check (TestConflictCodesNameLiveSchemaObjects,
// TestEnumMirrorsMatchTheLiveSchema); nothing checked a renamed function or
// view, which fails loudly only when a test happens to drive that route, and
// only at run time (docs/lessons.md, 2026-09-01, TYRE-95).
var schemaFunctions = []string{
	"apply_composition_observation",
	"config_for",
	"create_combination",
	"create_inspection_task",
	"current_actor_id",
	"current_tenant_id",
	"dismiss_composition_observation",
	"dispatch_tyre",
	"dispose_tyre",
	"end_combination",
	"fit_tyre",
	"inflation_compliance",
	"log_retread_return",
	"receive_tyres",
	"remove_tyre",
	"removal_threshold_mm_for",
	"return_tyre_to_stock",
	"rotate_tyres",
	"set_tyre_cost",
	"set_vehicle_status",
	"submit_inspection",
	"target_pressure_for",
	"tenant_today",
	"tyre_for_code",
	"tyre_valuation_asof",
	"void_inspection",
	"wear_rate_mm_per_month",
}

// Ten of these are read only by the B7.2 analytics endpoints (analytics.go,
// dashboard.go, valuation.go, exceptions.go): v_casing_value_at_risk,
// v_estate_valuation, v_exception, v_irregular_wear_ranking,
// v_spare_tyre_age, v_tread_distribution, v_tread_summary, v_tyre_at_risk,
// v_tyre_wear_rate, v_unit_inspection_status.
var schemaViews = []string{
	"v_actor_depot",
	"v_capture_vehicle",
	"v_casing_value_at_risk",
	"v_depot_vehicle",
	"v_driver_vehicle",
	"v_estate_valuation",
	"v_exception",
	"v_inspection_task",
	"v_irregular_wear_ranking",
	"v_my_inspection_task",
	"v_removal_forecast",
	"v_spare_tyre_age",
	"v_tread_distribution",
	"v_tread_summary",
	"v_tyre_at_risk",
	"v_tyre_awaiting_cost",
	"v_tyre_wear_rate",
	"v_unit_inspection_status",
	"v_user_capture_vehicle",
}

// TestSchemaFunctionsAndViewsExistLive is TestConflictCodesNameLiveSchemaObjects'
// sibling for the objects a constraint-name check does not reach: a function
// call or a view name that this package's SQL strings hardcode. Worth doing
// for the views especially, since a renamed scope view is an ADR-0006 seam a
// misnamed one would silently widen or narrow. Add a name to either list with
// no matching object in app and this goes red.
func TestSchemaFunctionsAndViewsExistLive(t *testing.T) {
	ctx := context.Background()
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if adminURL == "" {
		t.Skip("TEST_ADMIN_DATABASE_URL not set; this check needs a migrated Postgres")
	}
	conn, err := pgx.Connect(ctx, adminURL)
	req.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close(context.Background()) })

	for _, name := range schemaFunctions {
		var exists bool
		req.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			                 WHERE n.nspname = 'app' AND p.proname = $1)`,
			name).Scan(&exists))
		req.True(t, exists, "schemaFunctions names app.%s(), which no live function carries", name)
	}

	for _, name := range schemaViews {
		var exists bool
		req.NoError(t, conn.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			                 WHERE n.nspname = 'app' AND c.relname = $1 AND c.relkind = 'v')`,
			name).Scan(&exists))
		req.True(t, exists, "schemaViews names app.%s, which no live view carries", name)
	}
}
