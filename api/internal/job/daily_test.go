package job

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/store"
)

// No test here runs over every tenant in the database: other packages plant
// ACTIVE tenants in the same database at the same time and count what the
// generator returns (internal/httpapi/units_test.go), so each test hands the
// run the tenants it planted.

// jobFixtures opens the store as app_job through the production pool and an
// admin connection that plants fixtures across tenants.
func jobFixtures(t *testing.T, ctx context.Context) (*store.Store, *pgx.Conn) {
	t.Helper()
	jobURL := os.Getenv("TEST_JOB_DATABASE_URL")
	adminURL := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if jobURL == "" || adminURL == "" {
		t.Skip("TEST_JOB_DATABASE_URL / TEST_ADMIN_DATABASE_URL not set; the job's tests need a migrated Postgres")
	}
	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	s, err := openStore(ctx, jobURL)
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s, admin
}

// plantTenant inserts an ACTIVE tenant in the zone given, deleted on cleanup.
func plantTenant(t *testing.T, ctx context.Context, admin *pgx.Conn, tz string) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]
	var id uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.tenant (name, subdomain, state, timezone) VALUES ($1, $2, 'ACTIVE', $3) RETURNING id`,
		"job-test-"+suffix, "job-test-"+suffix, tz).Scan(&id))
	t.Cleanup(func() {
		_, err := admin.Exec(context.Background(), `DELETE FROM app.tenant WHERE id = $1`, id)
		require.NoError(t, err)
	})
	return id
}

// plantFleet plants a tenant with one ACTIVE unit on a weekly schedule, so
// the generator owes it one task.
func plantFleet(t *testing.T, ctx context.Context, admin *pgx.Conn, tz string) uuid.UUID {
	t.Helper()
	tenant := plantTenant(t, ctx, admin, tz)
	var configID, vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, 'JOBTEST', 'job test rig', 2) RETURNING id`, tenant).Scan(&configID))
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
		 VALUES ($1, 'JOB-1', $2, 'HORSE'::app.unit_kind) RETURNING id`, tenant, configID).Scan(&vehicleID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.inspection_schedule (tenant_id, vehicle_id, interval_days, active) VALUES ($1, $2, 7, true)`,
		tenant, vehicleID)
	require.NoError(t, err)
	return tenant
}

func given(ids ...uuid.UUID) func(context.Context) ([]uuid.UUID, error) {
	return func(context.Context) ([]uuid.UUID, error) { return ids, nil }
}

func logInto(buf *bytes.Buffer) *slog.Logger { return slog.New(slog.NewJSONHandler(buf, nil)) }

// lines parses every line the run wrote, and fails on one that is not JSON.
func lines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		require.NoError(t, json.Unmarshal([]byte(l), &m), "not a JSON line: %s", l)
		out = append(out, m)
	}
	return out
}

func withEvent(ls []map[string]any, event string) []map[string]any {
	var out []map[string]any
	for _, l := range ls {
		if l["event"] == event {
			out = append(out, l)
		}
	}
	return out
}

func taskCount(t *testing.T, ctx context.Context, admin *pgx.Conn, tenant uuid.UUID) int {
	t.Helper()
	var n int
	require.NoError(t, admin.QueryRow(ctx, `SELECT count(*) FROM app.inspection_task WHERE tenant_id = $1`, tenant).Scan(&n))
	return n
}

func TestListActiveTenantsListsOnlyActiveTenants(t *testing.T) {
	ctx := context.Background()
	s, admin := jobFixtures(t, ctx)
	active := plantTenant(t, ctx, admin, "Africa/Johannesburg")
	suspended := plantTenant(t, ctx, admin, "Africa/Johannesburg")
	_, err := admin.Exec(ctx, `UPDATE app.tenant SET state = 'SUSPENDED' WHERE id = $1`, suspended)
	require.NoError(t, err)

	ids, err := ListActiveTenants(s)(ctx)
	require.NoError(t, err)
	require.Contains(t, ids, active)
	require.NotContains(t, ids, suspended)

	// The control: the API's own role is refused the same call (ADR-0025).
	appURL := os.Getenv("TEST_DATABASE_URL")
	require.NotEmpty(t, appURL)
	api, err := store.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(api.Close)
	_, err = ListActiveTenants(api)(ctx)
	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	require.Equal(t, "42501", pgErr.Code)
}

func TestDailyIssuesEachTenantsTaskFromItsOwnDay(t *testing.T) {
	ctx := context.Background()
	s, admin := jobFixtures(t, ctx)
	// At every instant Pago Pago (UTC-11) or Kiritimati (UTC+14) is on
	// another date than UTC, so a step that read the day in UTC fails one.
	west := plantFleet(t, ctx, admin, "Pacific/Pago_Pago")
	east := plantFleet(t, ctx, admin, "Pacific/Kiritimati")
	var buf bytes.Buffer
	d := Daily{Store: s, Tenants: given(west, east), Steps: DailySteps, Log: logInto(&buf)}
	require.NoError(t, d.Run(ctx))

	for _, id := range []uuid.UUID{west, east} {
		require.Equal(t, 1, taskCount(t, ctx, admin, id))
		// Reads the day the step passed back off the generator's due instant,
		// UTC midnight plus the interval (000060:1366). TYRE-133 replaces that
		// instant, and this assertion with it.
		var fromTenantDay bool
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT (k.due_at AT TIME ZONE 'UTC')::date - 7 = app.tenant_today(t.timezone, k.created_at)
			   FROM app.inspection_task k JOIN app.tenant t ON t.id = k.tenant_id
			  WHERE k.tenant_id = $1`, id).Scan(&fromTenantDay))
		require.True(t, fromTenantDay, "tenant %s's task is not due seven days from its own today (rule 6)", id)
	}
	got := lines(t, &buf)
	for _, l := range got {
		require.Equal(t, "daily", l["job"])
	}
	require.Len(t, withEvent(got, EventStarted), 1)
	done := withEvent(got, EventTenantDone)
	require.Len(t, done, 2)
	require.ElementsMatch(t, []any{west.String(), east.String()}, []any{done[0]["tenant_id"], done[1]["tenant_id"]})
	for _, l := range done {
		require.Equal(t, "generate_inspection_tasks", l["step"])
		require.EqualValues(t, 1, l["created"])
	}
	ok := withEvent(got, EventSucceeded)
	require.Len(t, ok, 1)
	require.EqualValues(t, 2, ok[0]["tenants"])
	require.EqualValues(t, 2, ok[0]["created"])

	// A retry runs every tenant again and issues nothing (spec section 4).
	buf.Reset()
	require.NoError(t, d.Run(ctx))
	require.Equal(t, 1, taskCount(t, ctx, admin, west))
	require.Equal(t, 1, taskCount(t, ctx, admin, east))
	require.EqualValues(t, 0, withEvent(lines(t, &buf), EventSucceeded)[0]["created"])
}

func TestDailyCarriesOnPastAFailingTenant(t *testing.T) {
	ctx := context.Background()
	s, admin := jobFixtures(t, ctx)
	a := plantFleet(t, ctx, admin, "Africa/Johannesburg")
	b := plantFleet(t, ctx, admin, "Africa/Johannesburg")
	first, second := a, b
	if b.String() < a.String() {
		first, second = b, a
	}
	// The failing tenant is visited first, so the run must carry on past it.
	name := "Nomvula Failstep " + uuid.NewString()[:8]
	_, err := admin.Exec(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role) VALUES ($1, $2, $3, 'DRIVER')`,
		first, "failstep-"+uuid.NewString()[:8]+"@example.invalid", name)
	require.NoError(t, err)
	// Postgres quotes the value a cast refuses, so this step's error message
	// names a person (NFR-PRV-007).
	probe := Step{Name: "probe", SQL: `SELECT count(*)::int FROM app.app_user WHERE display_name::int > 0`}
	// The premise: the database's own message carries the name, so the
	// NotContains below can fail.
	premise := s.InTenantTx(ctx, first, func(tx pgx.Tx) error {
		var n int
		return tx.QueryRow(ctx, probe.SQL).Scan(&n)
	})
	var pgErr *pgconn.PgError
	require.ErrorAs(t, premise, &pgErr)
	require.Contains(t, pgErr.Message, name)

	var buf bytes.Buffer
	err = Daily{Store: s, Tenants: given(first, second),
		Steps: append(append([]Step{}, DailySteps...), probe), Log: logInto(&buf)}.Run(ctx)
	require.Error(t, err)

	require.Zero(t, taskCount(t, ctx, admin, first), "the failing tenant's earlier step rolled back with it")
	require.Equal(t, 1, taskCount(t, ctx, admin, second))
	require.NotContains(t, buf.String(), name)
	got := lines(t, &buf)
	failed := withEvent(got, EventTenantFailed)
	require.Len(t, failed, 1)
	require.Equal(t, first.String(), failed[0]["tenant_id"])
	require.Equal(t, "probe", failed[0]["step"])
	require.Equal(t, "22P02", failed[0]["sqlstate"])
	require.NotContains(t, failed[0], "constraint")
	for _, l := range withEvent(got, EventTenantDone) {
		require.Equal(t, second.String(), l["tenant_id"], "no done line claims the rolled-back tenant")
	}
	require.Empty(t, withEvent(got, EventSucceeded))
	f := withEvent(got, EventFailed)
	require.Len(t, f, 1)
	require.EqualValues(t, 1, f[0]["failed_tenants"])
}

func TestTwoRunsAtOnceIssueOneTaskPerUnit(t *testing.T) {
	ctx := context.Background()
	s, admin := jobFixtures(t, ctx)
	tenant := plantFleet(t, ctx, admin, "Africa/Johannesburg")

	// Run A holds the tenant's lock with its task issued and not yet committed.
	// The release is a cleanup too, registered after jobFixtures' so it runs
	// first: a failed assertion must not leave A holding a connection while
	// the store's Close waits for it.
	locked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	releaseA := func() { once.Do(func() { close(release) }) }
	t.Cleanup(releaseA)
	aErr := make(chan error, 1)
	go func() {
		aErr <- s.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
			if err := lockTenant(ctx, tx, tenant); err != nil {
				return err
			}
			var n int
			if err := tx.QueryRow(ctx, DailySteps[0].SQL).Scan(&n); err != nil {
				return err
			}
			if n != 1 {
				return fmt.Errorf("run A issued %d tasks", n)
			}
			close(locked)
			<-release
			return nil
		})
	}()
	select {
	case <-locked:
	case err := <-aErr:
		t.Fatalf("run A ended before taking the lock: %v", err)
	}

	var buf bytes.Buffer
	bErr := make(chan error, 1)
	go func() {
		bErr <- Daily{Store: s, Tenants: given(tenant), Steps: DailySteps, Log: logInto(&buf)}.Run(ctx)
	}()
	// B is seen waiting on the lock, unless it ran straight through, which is
	// the failure this test exists for.
	// The condition runs off the test goroutine, so a query error is a false,
	// never a require.
	require.Eventually(t, func() bool {
		var waiting int
		if err := admin.QueryRow(ctx,
			`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::int8::oid AND NOT granted`,
			int64(lockClass)).Scan(&waiting); err != nil {
			return false
		}
		return waiting > 0 || len(bErr) > 0
	}, 10*time.Second, 50*time.Millisecond)
	releaseA()
	require.NoError(t, <-aErr)
	require.NoError(t, <-bErr)

	require.Equal(t, 1, taskCount(t, ctx, admin, tenant))
	done := withEvent(lines(t, &buf), EventTenantDone)
	require.Len(t, done, 1)
	require.EqualValues(t, 0, done[0]["created"])
}

func TestDailyWithNoTenantsSucceeds(t *testing.T) {
	ctx := context.Background()
	s, _ := jobFixtures(t, ctx)
	var buf bytes.Buffer
	require.NoError(t, Daily{Store: s, Tenants: given(), Steps: DailySteps, Log: logInto(&buf)}.Run(ctx))
	ok := withEvent(lines(t, &buf), EventSucceeded)
	require.Len(t, ok, 1)
	require.EqualValues(t, 0, ok[0]["tenants"])
	require.EqualValues(t, 0, ok[0]["created"])
}

// A tenant deleted between the listing and its visit binds no row: the step
// reads no zone and no schedule, issues nothing, and the run succeeds.
func TestDailyVisitsAVanishedTenantWithoutFailing(t *testing.T) {
	ctx := context.Background()
	s, _ := jobFixtures(t, ctx)
	gone := uuid.New()
	var buf bytes.Buffer
	require.NoError(t, Daily{Store: s, Tenants: given(gone), Steps: DailySteps, Log: logInto(&buf)}.Run(ctx))
	got := lines(t, &buf)
	done := withEvent(got, EventTenantDone)
	require.Len(t, done, 1)
	require.Equal(t, gone.String(), done[0]["tenant_id"])
	require.EqualValues(t, 0, done[0]["created"])
	ok := withEvent(got, EventSucceeded)
	require.Len(t, ok, 1)
	require.EqualValues(t, 1, ok[0]["tenants"])
	require.EqualValues(t, 0, ok[0]["created"])
}

func TestDailyPastItsDeadlineFailsEveryTenantAndLogsNoSuccess(t *testing.T) {
	ctx := context.Background()
	s, admin := jobFixtures(t, ctx)
	a := plantFleet(t, ctx, admin, "Africa/Johannesburg")
	b := plantFleet(t, ctx, admin, "Africa/Johannesburg")
	past, cancel := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer cancel()
	var buf bytes.Buffer
	require.Error(t, Daily{Store: s, Tenants: given(a, b), Steps: DailySteps, Log: logInto(&buf)}.Run(past))
	got := lines(t, &buf)
	failed := withEvent(got, EventTenantFailed)
	require.Len(t, failed, 2)
	for _, l := range failed {
		require.NotEmpty(t, l["error_type"])
		require.NotContains(t, l, "sqlstate")
	}
	require.Empty(t, withEvent(got, EventSucceeded))
	f := withEvent(got, EventFailed)
	require.Len(t, f, 1)
	require.EqualValues(t, 2, f[0]["failed_tenants"])
	require.Zero(t, taskCount(t, ctx, admin, a))
	require.Zero(t, taskCount(t, ctx, admin, b))
}

func TestDailyLogsNoSuccessWhenListingFails(t *testing.T) {
	ctx := context.Background()
	s, _ := jobFixtures(t, ctx)
	refuse := func(context.Context) ([]uuid.UUID, error) { return nil, errors.New("listing refused") }
	var buf bytes.Buffer
	require.Error(t, Daily{Store: s, Tenants: refuse, Steps: DailySteps, Log: logInto(&buf)}.Run(ctx))
	require.NotContains(t, buf.String(), "listing refused")
	got := lines(t, &buf)
	f := withEvent(got, EventFailed)
	require.Len(t, f, 1)
	require.Equal(t, "list", f[0]["stage"])
	require.Equal(t, "*errors.errorString", f[0]["error_type"])
	require.Empty(t, withEvent(got, EventSucceeded))
}
