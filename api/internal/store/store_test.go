package store_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
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
		`INSERT INTO app.tenant (name, subdomain, state) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
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
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind) VALUES ($1, $2, $3, 'HORSE'::app.unit_kind)`,
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
			`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind) VALUES ($1, 'smuggled', $2, 'HORSE'::app.unit_kind)`,
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

// plantUser adds a user to a planted tenant via the admin connection. The
// role is bound like any other parameter; the cast is what tells Postgres the
// text is a user_role.
func plantUser(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, role auth.Role, active bool) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var userID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role, active)
		 VALUES ($1, $2, $3, $4::app.user_role, $5) RETURNING id`,
		tenantID, "store-test-"+suffix+"@example.invalid", "Store Test "+suffix, string(role), active,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func plantDepotFor(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, userID uuid.UUID) uuid.UUID {
	t.Helper()

	var depotID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		tenantID, "store-test-depot-"+uuid.NewString()[:8],
	).Scan(&depotID)
	require.NoError(t, err)

	_, err = admin.Exec(ctx,
		`INSERT INTO app.user_depot (tenant_id, user_id, depot_id) VALUES ($1, $2, $3)`,
		tenantID, userID, depotID,
	)
	require.NoError(t, err)
	return depotID
}

// singleConnStore pins the pool to one connection so a follow-up transaction
// runs where the previous one did, which is what a leak test needs.
func singleConnStore(t *testing.T, ctx context.Context) *store.Store {
	t.Helper()
	appURL, _ := testURLs(t)
	sep := "?"
	if strings.Contains(appURL, "?") {
		sep = "&"
	}
	s, err := store.New(ctx, appURL+sep+"pool_max_conns=1")
	require.NoError(t, err)
	t.Cleanup(s.Close)
	return s
}

// linkSubject gives a planted user an Entra subject the way the provisioning
// runbook does, through the admin connection: the app role cannot write the
// column (000052).
func linkSubject(t *testing.T, ctx context.Context, admin *pgx.Conn, userID uuid.UUID) uuid.UUID {
	t.Helper()
	subject := uuid.New()
	_, err := admin.Exec(ctx, `UPDATE app.app_user SET subject = $2 WHERE id = $1`, userID, subject)
	require.NoError(t, err)
	return subject
}

// ADR-0016: a bearer request names a subject, and the user and role come
// from the database under RLS.
func TestInActorTxResolvesASubjectToItsUser(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	subject := linkSubject(t, ctx, admin, userID)

	var got auth.Actor
	var boundActor string
	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, Subject: subject},
		func(tx pgx.Tx, actor auth.Actor) error {
			got = actor
			return tx.QueryRow(ctx, `SELECT current_setting('app.actor_id', true)`).Scan(&boundActor)
		}))
	require.Equal(t, userID, got.UserID)
	require.Equal(t, userID.String(), boundActor, "app.actor_id is the id the lookup found, not key.UserID")
	require.Equal(t, a.id, got.TenantID)
	require.Equal(t, auth.RoleDriver, got.Role)
}

// A tenant claim naming the wrong tenant finds no row (ADR-0016 decision 5).
// The control resolves the same subject in its own tenant, so the refusal is
// the tenant and not the subject.
func TestInActorTxRefusesASubjectClaimedForAnotherTenant(t *testing.T) {
	ctx := context.Background()
	s, admin, a, b := openFixtures(t, ctx)
	userInB := plantUser(t, ctx, admin, b.id, auth.RoleDriver, true)
	subject := linkSubject(t, ctx, admin, userInB)

	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: b.id, Subject: subject},
		func(pgx.Tx, auth.Actor) error { return nil }))
	err := s.InActorTx(ctx, store.ActorKey{TenantID: a.id, Subject: subject},
		func(pgx.Tx, auth.Actor) error {
			t.Fatal("fn must not run for a subject claimed for another tenant")
			return nil
		})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
}

func TestInActorTxRefusesAKeyWithBothOrNeitherIdentity(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)

	for name, key := range map[string]store.ActorKey{
		"both":    {TenantID: a.id, UserID: userID, Subject: uuid.New()},
		"neither": {TenantID: a.id},
	} {
		t.Run(name, func(t *testing.T) {
			err := s.InActorTx(ctx, key, func(pgx.Tx, auth.Actor) error {
				t.Fatal("fn must not run for a malformed key")
				return nil
			})
			require.Error(t, err)
			require.NotErrorIs(t, err, store.ErrNoSuchActor,
				"a malformed key is a programming mistake, not a refusal the client may read")
		})
	}
}

// app.session_id is what TYRE-201's trigger will read and
// app.record_session_start() reads (FR-AUD-002, FR-AUD-004). A dev-resolver key carries none.
func TestInActorTxSessionIDDoesNotLeakIntoTheNextTransaction(t *testing.T) {
	ctx := context.Background()
	_, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	subject := linkSubject(t, ctx, admin, userID)

	// One connection, so the second transaction runs where the first bound a
	// session: the Nil below then proves the binding died with it.
	s := singleConnStore(t, ctx)

	var bound *string
	readSession := func(tx pgx.Tx, _ auth.Actor) error {
		return tx.QueryRow(ctx, `SELECT nullif(current_setting('app.session_id', true), '')`).Scan(&bound)
	}
	session := "sid:" + uuid.NewString()
	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, Subject: subject, SessionID: session}, readSession))
	require.NotNil(t, bound)
	require.Equal(t, session, *bound)

	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userID}, readSession))
	require.Nil(t, bound)
}

// The role is read from app.app_user, never supplied by the caller
// (ADR-0011), so planting a role and reading it back is the whole contract.
func TestInActorTxResolvesRoleAndDepotsFromTheDatabase(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDepotManager, true)
	depotA := plantDepotFor(t, ctx, admin, a.id, userID)
	depotB := plantDepotFor(t, ctx, admin, a.id, userID)
	want := []uuid.UUID{depotA, depotB}
	sort.Slice(want, func(i, j int) bool { return want[i].String() < want[j].String() })

	var got auth.Actor
	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userID}, func(_ pgx.Tx, actor auth.Actor) error {
		got = actor
		return nil
	}))

	require.Equal(t, userID, got.UserID)
	require.Equal(t, a.id, got.TenantID)
	require.Equal(t, auth.RoleDepotManager, got.Role)
	require.Equal(t, want, got.DepotIDs)
	require.True(t, got.Can(auth.ManageAssets))
}

// FR-AUT-011: deactivation is the only way a user goes away, and it must bite
// on the next request rather than at token expiry.
func TestInActorTxRefusesDeactivatedUser(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleController, false)

	err := s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userID}, func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a deactivated user")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
}

// A tenant claimed wrongly, or forged, needs no special case: RLS hides the
// user row and the resolution simply finds nothing.
func TestInActorTxRefusesUserFromAnotherTenant(t *testing.T) {
	ctx := context.Background()
	s, admin, a, b := openFixtures(t, ctx)
	userInB := plantUser(t, ctx, admin, b.id, auth.RoleOrgAdmin, true)

	err := s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userInB}, func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a user outside the bound tenant")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
}

func TestInActorTxRefusesUnknownUser(t *testing.T) {
	ctx := context.Background()
	s, _, a, _ := openFixtures(t, ctx)

	err := s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: uuid.New()}, func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a user that does not exist")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
	require.True(t, errors.Is(err, store.ErrNoSuchActor))
}

// The actor binding must die with the transaction for exactly the reason the
// tenant binding does: a pooled connection must not carry one user's scope
// into the next request.
func TestActorContextDoesNotLeakAcrossTransactions(t *testing.T) {
	ctx := context.Background()
	_, adminURL := testURLs(t)

	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	a := plantTenant(t, ctx, admin, "actor-leak")
	userID := plantUser(t, ctx, admin, a.id, auth.RoleTechnician, true)
	plantDepotFor(t, ctx, admin, a.id, userID)

	s := singleConnStore(t, ctx)

	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userID}, func(_ pgx.Tx, actor auth.Actor) error {
		require.Len(t, actor.DepotIDs, 1, "the actor must see their own depot inside the transaction")
		return nil
	}))

	// Tenant bound, actor deliberately not, on the same physical connection.
	// v_actor_depot keys on app.actor_id, so a binding that outlived its
	// transaction would still show the previous actor's depot here. Querying
	// app.user_depot instead could not tell the two bindings apart: its policy
	// references only the tenant.
	var count int
	require.NoError(t, s.InTenantTx(ctx, a.id, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM app.v_actor_depot`).Scan(&count)
	}))
	require.Zero(t, count, "actor context must not survive the transaction on a pooled connection")
}

// Rule 6 (TYRE-170): five predicates in the schema read current_date or cast
// a timestamptz to a date, and every one of them follows the session
// TimeZone. Nothing in the deployment pins that value, so the pool pins it.
// The DSN below asks for another zone on purpose: against a UTC server a
// bare "reads UTC" assertion passes with or without the pin.
func TestPoolPinsSessionTimeZoneToUTC(t *testing.T) {
	ctx := context.Background()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	s, err := store.New(ctx, dsn+sep+"timezone=Africa/Johannesburg")
	require.NoError(t, err)
	t.Cleanup(s.Close)

	var tz string
	require.NoError(t, s.Pool().QueryRow(ctx, `SHOW TimeZone`).Scan(&tz))
	require.Equal(t, "UTC", tz, "the pool must override any zone the DSN or the server supplies")
}

// TestMaxConnsDefaultsWhenDSNNamesNone proves store.New's recorded default
// (TYRE-184 F8, ADR-0005) actually takes effect, not only that New succeeds.
func TestMaxConnsDefaultsWhenDSNNamesNone(t *testing.T) {
	ctx := context.Background()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	s, err := store.New(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(s.Close)

	require.EqualValues(t, 10, s.MaxConns())
}

// TestMaxConnsHonoursDSNOverride is TestTenantContextDoesNotLeakAcrossTransactions's
// pool_max_conns=1 read from the other side: a DSN's own value must win over
// the recorded default, not just happen to also be small enough to work.
func TestMaxConnsHonoursDSNOverride(t *testing.T) {
	ctx := context.Background()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	s, err := store.New(ctx, dsn+sep+"pool_max_conns=3")
	require.NoError(t, err)
	t.Cleanup(s.Close)

	require.EqualValues(t, 3, s.MaxConns())
}

func setTenantState(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, state string) {
	t.Helper()
	_, err := admin.Exec(ctx, `UPDATE app.tenant SET state = $2::app.tenant_state WHERE id = $1`, tenantID, state)
	require.NoError(t, err)
}

// FR-TEN-009 (TYRE-376): a user of a tenant that is not ACTIVE is refused,
// PROVISIONING included, and an ACTIVE tenant still resolves.
func TestInActorTxRefusesATenantThatIsNotActive(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	key := store.ActorKey{TenantID: a.id, UserID: userID}

	require.NoError(t, s.InActorTx(ctx, key, func(pgx.Tx, auth.Actor) error { return nil }),
		"control: an ACTIVE tenant resolves")
	for _, state := range []string{"SUSPENDED", "CLOSED", "PROVISIONING"} {
		t.Run(state, func(t *testing.T) {
			setTenantState(t, ctx, admin, a.id, state)
			err := s.InActorTx(ctx, key, func(pgx.Tx, auth.Actor) error {
				t.Fatal("fn must not run for a tenant that is not ACTIVE")
				return nil
			})
			require.ErrorIs(t, err, store.ErrTenantInactive)
		})
	}
}

// Only a linked user learns the tenant's state: anyone else gets the
// ordinary refusal (TYRE-376).
func TestInActorTxHidesTheTenantStateFromAnUnknownUser(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	setTenantState(t, ctx, admin, a.id, "SUSPENDED")

	err := s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: uuid.New()},
		func(pgx.Tx, auth.Actor) error { return nil })
	require.ErrorIs(t, err, store.ErrNoSuchActor)
	require.NotErrorIs(t, err, store.ErrTenantInactive)
}

// countSessionStarts names the tenant in its WHERE on the admin connection,
// so the count cannot read empty for want of a binding (docs/lessons.md,
// 2026-09-19).
func countSessionStarts(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, session string) int {
	t.Helper()
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.audit_log
		  WHERE tenant_id = $1 AND session_id = $2 AND action = 'SESSION_START'`,
		tenantID, session).Scan(&n))
	return n
}

func noop(pgx.Tx, auth.Actor) error { return nil }

// FR-AUD-004: a session's first use is recorded once. With the row removed
// behind the store's back, a second request writes nothing, which shows the
// store remembered the session instead of calling the function again.
func TestASessionStartIsWrittenOncePerSession(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	key := store.ActorKey{TenantID: a.id, Subject: linkSubject(t, ctx, admin, userID), SessionID: "sid:" + uuid.NewString()}

	require.NoError(t, s.InActorTx(ctx, key, noop))
	require.Equal(t, 1, countSessionStarts(t, ctx, admin, a.id, key.SessionID), "the first request records the start")

	_, err := admin.Exec(ctx, `DELETE FROM app.audit_log WHERE tenant_id = $1 AND session_id = $2`, a.id, key.SessionID)
	require.NoError(t, err)
	require.NoError(t, s.InActorTx(ctx, key, noop))
	require.Zero(t, countSessionStarts(t, ctx, admin, a.id, key.SessionID))
}

// A second replica has not seen the session, so it calls the function; the
// unique index makes that a no-op (000052). The deleted row shows the call
// happened, since only the replica could have written it back.
func TestASecondReplicaDoesNotDuplicateASessionStart(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	appURL, _ := testURLs(t)
	replica, err := store.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(replica.Close)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	key := store.ActorKey{TenantID: a.id, Subject: linkSubject(t, ctx, admin, userID), SessionID: "sid:" + uuid.NewString()}

	require.NoError(t, s.InActorTx(ctx, key, noop))
	require.NoError(t, replica.InActorTx(ctx, key, noop))
	require.Equal(t, 1, countSessionStarts(t, ctx, admin, a.id, key.SessionID), "the index absorbed the repeat")

	_, err = admin.Exec(ctx, `DELETE FROM app.audit_log WHERE tenant_id = $1 AND session_id = $2`, a.id, key.SessionID)
	require.NoError(t, err)
	third, err := store.New(ctx, appURL)
	require.NoError(t, err)
	t.Cleanup(third.Close)
	require.NoError(t, third.InActorTx(ctx, key, noop))
	require.Equal(t, 1, countSessionStarts(t, ctx, admin, a.id, key.SessionID), "a replica that has not seen the session records it")
}

// A request that rolls back loses its session start with it, and must not
// mark the session recorded, or the event would never be written.
func TestARolledBackRequestNeitherRecordsNorRemembersItsSession(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)
	key := store.ActorKey{TenantID: a.id, Subject: linkSubject(t, ctx, admin, userID), SessionID: "sid:" + uuid.NewString()}

	err := s.InActorTx(ctx, key, func(pgx.Tx, auth.Actor) error { return errors.New("handler refused") })
	require.Error(t, err)
	require.Zero(t, countSessionStarts(t, ctx, admin, a.id, key.SessionID))

	require.NoError(t, s.InActorTx(ctx, key, noop))
	require.Equal(t, 1, countSessionStarts(t, ctx, admin, a.id, key.SessionID))
}

func TestADevKeyRecordsNoSessionStart(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDriver, true)

	require.NoError(t, s.InActorTx(ctx, store.ActorKey{TenantID: a.id, UserID: userID}, noop))
	var n int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.audit_log WHERE tenant_id = $1 AND action = 'SESSION_START'`, a.id).Scan(&n))
	require.Zero(t, n)
}
