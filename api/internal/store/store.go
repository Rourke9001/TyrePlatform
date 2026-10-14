// Package store owns the database connection and the request-context
// transaction pattern. Every query in the API goes through InActorTx, which
// binds the tenant and the actor together and resolves the role from
// app_user; InTenantTx binds the tenant alone, for work with no actor to
// resolve. A query on the bare pool has neither bound, and RLS returns it
// nothing (non-negotiable rule 1, api/CLAUDE.md).
package store

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"tyreplatform/api/internal/auth"
)

// defaultMaxConns is applied only when the DSN carries no pool_max_conns of
// its own (store_test.go's =1 override for connection-identity tests must
// keep working). The arithmetic it satisfies, replicas x pool + headroom <=
// the server's max_connections, is recorded once in ADR-0005 next to the
// scale block rather than here (TYRE-184 F8).
const defaultMaxConns = 10

type Store struct {
	pool     *pgxpool.Pool
	sessions *sessionSet
}

func New(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing database url: %w", err)
	}
	// Rule 6: the schema's date predicates (the two effective_from defaults,
	// receive_tyres's least() clamp) follow the session TimeZone, and a
	// managed Postgres exposes that as a server parameter nothing here
	// controls. Pinning it per connection makes the value a property of this
	// process rather than of whichever server it is pointed at (TYRE-170).
	// Tenant-day resolution is a separate concern (app.tenant_today) and is
	// unaffected.
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	// pgxpool.ParseConfig already applied a DSN's own pool_max_conns, if it
	// named one; only an unsized pool falls back to the recorded default.
	if !strings.Contains(dsn, "pool_max_conns") {
		cfg.MaxConns = defaultMaxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}
	return &Store{pool: pool, sessions: newSessionSet(sessionLimit)}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

// Ping reports whether the database answers. /readyz calls it on every
// readiness probe (NFR-OBS-005, TYRE-79).
func (s *Store) Ping(ctx context.Context) error {
	if err := s.pool.Ping(ctx); err != nil {
		return fmt.Errorf("pinging database: %w", err)
	}
	return nil
}

// MaxConns reports the pool's configured ceiling: defaultMaxConns unless the
// DSN named its own pool_max_conns (TYRE-184 F8). Exported so a test can
// prove the default actually took effect, not only that New succeeded.
func (s *Store) MaxConns() int32 {
	return s.pool.Config().MaxConns
}

// Pool is for tenant-free work only. Nothing on the request path takes it;
// its only callers are the tests proving what an unbound query sees. Any
// tenant-scoped query on it runs with no tenant bound, and RLS returns zero
// rows, which looks like a data bug and is actually a missing transaction.
func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}

// InTenantTx runs fn with app.tenant_id bound for RLS via set_config(...,
// true), the parameterisable SET LOCAL: the binding dies with the
// transaction so a pooled connection cannot carry one tenant's context into
// the next request (rule 1).
func (s *Store) InTenantTx(ctx context.Context, tenantID uuid.UUID, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning tenant transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
		return fmt.Errorf("binding tenant context: %w", err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing tenant transaction: %w", err)
	}
	return nil
}

// ErrNoSuchActor means the key resolved to no user this tenant can see, or to
// one that has been deactivated: an unknown or wrong-tenant user id, or a
// subject linked to no visible user. All are the same refusal to a client and
// distinguishable only in the log (FR-AUT-011, ADR-0011).
var ErrNoSuchActor = errors.New("actor not found or inactive")

// ErrTenantInactive means the actor resolved but their tenant is not ACTIVE.
// FR-TEN-009 names SUSPENDED and CLOSED; a PROVISIONING tenant is refused
// too, because its users are not yet meant to sign in (TYRE-376).
var ErrTenantInactive = errors.New("tenant is not active")

// ActorSetupError is a failure in one of InActorTx's own steps, before fn
// runs. Those steps act on the identity the resolver verified, not on what
// the request asks for, so withActor answers 500 whatever SQLSTATE it wraps,
// and a held capture is retried rather than failed for good (TYRE-383,
// ADR-0009).
type ActorSetupError struct{ Err error }

func (e *ActorSetupError) Error() string { return e.Err.Error() }
func (e *ActorSetupError) Unwrap() error { return e.Err }

// ActorKey names who a request acts as and where it came from. Exactly one
// of UserID and Subject is set (spec section 2, ADR-0016). Its fields are
// httpapi.Identity's, in the same order, so withActor converts one to the
// other.
type ActorKey struct {
	TenantID  uuid.UUID
	UserID    uuid.UUID
	Subject   uuid.UUID
	SessionID string
	Source    netip.Addr // bound as app.source_ip only when valid (FR-AUD-002)
}

var errActorKeyShape = errors.New("actor key must set exactly one of UserID and Subject")

// InActorTx runs fn inside a transaction with app.tenant_id and app.actor_id
// both bound, having first resolved the actor from app.app_user under RLS.
//
// The role is never taken from the caller. A token can be stale and a header
// can be forged; app.app_user is the register of record, and reading it here
// is what makes deactivation bite on the next request rather than at token
// expiry (ADR-0011, NFR-SEC-006).
//
// A failure in its own steps is an *ActorSetupError, except ErrNoSuchActor,
// ErrTenantInactive and a key of the wrong shape. An error from fn comes back
// as fn returned it, and a commit error is wrapped but not marked.
func (s *Store) InActorTx(ctx context.Context, key ActorKey, fn func(pgx.Tx, auth.Actor) error) error {
	if (key.UserID == uuid.Nil) == (key.Subject == uuid.Nil) {
		return errActorKeyShape
	}
	// READ COMMITTED is pinned: submitStatus maps createUser's reactivate
	// race to a 409 only because the loser's UPDATE re-evaluates its WHERE
	// against the winner's committed row. Under REPEATABLE READ the same
	// interleaving raises 40001, which submitStatus does not map (TYRE-95).
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return &ActorSetupError{Err: fmt.Errorf("beginning actor transaction: %w", err)}
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	actor, recordSession, err := s.bindActor(ctx, tx, key)
	switch {
	case errors.Is(err, ErrNoSuchActor), errors.Is(err, ErrTenantInactive):
		return err
	case err != nil:
		return &ActorSetupError{Err: err}
	}

	if err := fn(tx, actor); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing actor transaction: %w", err)
	}
	// Remembered only once committed, so a rolled-back request cannot lose
	// the event (spec section 3, FR-AUD-004).
	if recordSession {
		s.sessions.add(sessionKey(key))
	}
	return nil
}

// sessionKey is keyed on the tenant too, as the unique index is (000052).
func sessionKey(key ActorKey) string {
	return key.TenantID.String() + "/" + key.SessionID
}

// bindActor is every step of InActorTx before fn, so InActorTx marks all of
// their failures in one place. It reports whether it recorded the session's
// first use, which InActorTx remembers only once the transaction commits.
func (s *Store) bindActor(ctx context.Context, tx pgx.Tx, key ActorKey) (auth.Actor, bool, error) {
	// app.session_id is bound only for a bearer request and app.source_ip only
	// for a valid address, never to an empty or placeholder value. The audit
	// trigger and app.record_session_start() read both (FR-AUD-002, FR-AUD-004).
	source := ""
	if key.Source.IsValid() {
		source = key.Source.String()
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1::text, true),
		        CASE WHEN $2::text <> '' THEN set_config('app.session_id', $2::text, true) END,
		        CASE WHEN $3::text <> '' THEN set_config('app.source_ip', $3::text, true) END`,
		key.TenantID.String(), key.SessionID, source); err != nil {
		return auth.Actor{}, false, fmt.Errorf("binding tenant context: %w", err)
	}

	lookup, arg := `SELECT id, display_name, role::text, active FROM app.app_user WHERE id = $1`, key.UserID
	if key.Subject != uuid.Nil {
		lookup, arg = `SELECT id, display_name, role::text, active FROM app.app_user WHERE subject = $1`, key.Subject
	}
	actor := auth.Actor{TenantID: key.TenantID}
	var roleName string
	var active bool
	// The tenant_isolation policy does the tenant check: a user of another
	// tenant, or a subject claimed for the wrong one, is not visible here, so
	// a wrong or forged tenant needs no branch (ADR-0016 decision 5). role is
	// cast to text because the enum's OID is not in pgx's type map.
	err := tx.QueryRow(ctx, lookup, arg).Scan(&actor.UserID, &actor.DisplayName, &roleName, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Actor{}, false, ErrNoSuchActor
	}
	if err != nil {
		return auth.Actor{}, false, fmt.Errorf("resolving actor: %w", err)
	}
	if !active {
		return auth.Actor{}, false, ErrNoSuchActor
	}
	actor.Role = auth.Role(roleName)

	if _, err := tx.Exec(ctx, `SELECT set_config('app.actor_id', $1, true)`, actor.UserID.String()); err != nil {
		return auth.Actor{}, false, fmt.Errorf("binding actor context: %w", err)
	}

	// Checked after the actor resolves, so only a linked user learns the
	// tenant's state (TYRE-376). tenant_self shows a session its own row.
	var state string
	if err := tx.QueryRow(ctx,
		`SELECT state::text FROM app.tenant WHERE id = app.current_tenant_id()`).Scan(&state); err != nil {
		return auth.Actor{}, false, fmt.Errorf("reading tenant state: %w", err)
	}
	if state != "ACTIVE" {
		return auth.Actor{}, false, ErrTenantInactive
	}

	depots, err := actorDepots(ctx, tx)
	if err != nil {
		return auth.Actor{}, false, err
	}
	actor.DepotIDs = depots

	recordSession := key.SessionID != "" && !s.sessions.has(sessionKey(key))
	if recordSession {
		if _, err := tx.Exec(ctx, `SELECT app.record_session_start()`); err != nil {
			return auth.Actor{}, false, fmt.Errorf("recording session start: %w", err)
		}
	}
	return actor, recordSession, nil
}

// actorDepots reads the depot scope through the single view that defines it
// (ADR-0006). The view keys on app.actor_id, already bound above, so this
// cannot read another user's scope.
func actorDepots(ctx context.Context, tx pgx.Tx) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT depot_id FROM app.v_actor_depot ORDER BY depot_id`)
	if err != nil {
		return nil, fmt.Errorf("reading actor depots: %w", err)
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("reading actor depots: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading actor depots: %w", err)
	}
	return ids, nil
}
