package store_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/store"
)

// The suite needs a real Postgres with the migrations applied: a mocked
// database cannot fail an RLS policy, and the policy is the thing under test.
// TEST_DATABASE_URL must connect as app_login; TEST_ADMIN_DATABASE_URL is a
// superuser used only to plant fixtures across tenants, which RLS would
// (correctly) prevent app_login from doing.
func testURLs(t *testing.T) (appURL, adminURL string) {
	t.Helper()
	appURL = os.Getenv("TEST_DATABASE_URL")
	adminURL = os.Getenv("TEST_ADMIN_DATABASE_URL")
	if appURL == "" || adminURL == "" {
		t.Skip("TEST_DATABASE_URL / TEST_ADMIN_DATABASE_URL not set; integration test needs a migrated Postgres")
	}
	return appURL, adminURL
}

type tenantFixture struct {
	id          uuid.UUID
	fleetNumber string
}

// plantTenant creates a tenant with one vehicle and removes both on cleanup.
func plantTenant(t *testing.T, ctx context.Context, admin *pgx.Conn, label string) tenantFixture {
	t.Helper()

	suffix := uuid.NewString()[:8]
	fleet := fmt.Sprintf("%s-%s", label, suffix)

	var tenantID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.tenant (name, subdomain) VALUES ($1, $2) RETURNING id`,
		"store-test-"+label, "store-test-"+suffix,
	).Scan(&tenantID)
	require.NoError(t, err)
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(), `DELETE FROM app.tenant WHERE id = $1`, tenantID)
		require.NoError(t, err)
	})

	var configID uuid.UUID
	err = admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, 'STORETEST', 'store test rig', 2) RETURNING id`,
		tenantID,
	).Scan(&configID)
	require.NoError(t, err)

	_, err = admin.Exec(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id) VALUES ($1, $2, $3)`,
		tenantID, fleet, configID,
	)
	require.NoError(t, err)

	return tenantFixture{id: tenantID, fleetNumber: fleet}
}

func openFixtures(t *testing.T, ctx context.Context) (*store.Store, *pgx.Conn, tenantFixture, tenantFixture) {
	t.Helper()
	appURL, adminURL := testURLs(t)

	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })

	a := plantTenant(t, ctx, admin, "a")
	b := plantTenant(t, ctx, admin, "b")

	s, err := store.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(s.Close)

	return s, admin, a, b
}

func listFleetNumbers(ctx context.Context, tx pgx.Tx) ([]string, error) {
	rows, err := tx.Query(ctx, `SELECT fleet_number FROM app.vehicle ORDER BY fleet_number`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fleets []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		fleets = append(fleets, f)
	}
	return fleets, rows.Err()
}

func TestInTenantTxSeesOnlyOwnTenant(t *testing.T) {
	ctx := context.Background()
	s, _, a, b := openFixtures(t, ctx)

	var fleets []string
	err := s.InTenantTx(ctx, a.id, func(tx pgx.Tx) error {
		var err error
		fleets, err = listFleetNumbers(ctx, tx)
		return err
	})
	require.NoError(t, err)
	require.Equal(t, []string{a.fleetNumber}, fleets,
		"tenant A must see exactly its own vehicle and never tenant B's (%s)", b.fleetNumber)
}

func TestInTenantTxCannotWriteIntoOtherTenant(t *testing.T) {
	ctx := context.Background()
	s, admin, a, b := openFixtures(t, ctx)

	err := s.InTenantTx(ctx, a.id, func(tx pgx.Tx) error {
		var configID uuid.UUID
		if err := tx.QueryRow(ctx,
			`SELECT id FROM app.axle_configuration WHERE tenant_id = $1`, a.id,
		).Scan(&configID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id) VALUES ($1, 'smuggled', $2)`,
			b.id, configID,
		)
		return err
	})
	require.Error(t, err, "WITH CHECK must reject a row written into another tenant")

	var count int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = 'smuggled'`, b.id,
	).Scan(&count))
	require.Zero(t, count, "the rejected row must not exist")
}

func TestQueryWithoutTenantContextSeesNoRows(t *testing.T) {
	ctx := context.Background()
	s, _, a, _ := openFixtures(t, ctx)

	var count int
	err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM app.vehicle`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "no tenant context must mean no rows, not all rows (tenant %s planted one)", a.id)
}

func TestTenantContextDoesNotLeakAcrossTransactions(t *testing.T) {
	ctx := context.Background()
	appURL, adminURL := testURLs(t)

	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	a := plantTenant(t, ctx, admin, "leak")

	// pool_max_conns=1 forces the follow-up query onto the same physical
	// connection the transaction used; zero rows proves the tenant binding
	// died with the transaction rather than lingering on the connection.
	sep := "?"
	if strings.Contains(appURL, "?") {
		sep = "&"
	}
	s, err := store.New(ctx, appURL+sep+"pool_max_conns=1")
	require.NoError(t, err)
	t.Cleanup(s.Close)

	require.NoError(t, s.InTenantTx(ctx, a.id, func(tx pgx.Tx) error { return nil }))

	var count int
	err = s.Pool().QueryRow(ctx, `SELECT count(*) FROM app.vehicle`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "tenant context must not survive the transaction on a pooled connection")
}
