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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"tyreplatform/api/internal/auth"
)

type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

// Pool is for tenant-free work only (health checks, connection stats). Any
// tenant-scoped query on it runs with no tenant bound, and RLS returns zero
// rows — which looks like a data bug and is actually a missing transaction.
func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}

// InTenantTx runs fn inside a transaction with app.tenant_id bound for RLS.
//
// set_config(..., is_local => true) is the parameterisable form of SET LOCAL:
// the binding dies with the transaction, so a pooled connection cannot carry
// one tenant's context into the next request. SET LOCAL itself cannot take a
// bind parameter, and string-interpolating the tenant id is exactly the kind
// of shortcut rule 1 exists to forbid.
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

// ErrNoSuchActor means the request named a user this tenant cannot see, or
// one that has been deactivated. The two are the same refusal to a client and
// distinguishable only in the log (FR-AUT-011, ADR-0011).
var ErrNoSuchActor = errors.New("actor not found or inactive")

// InActorTx runs fn inside a transaction with app.tenant_id and app.actor_id
// both bound, having first resolved the actor from app.app_user under RLS.
//
// The role is never taken from the caller. A token can be stale and a header
// can be forged; app.app_user is the register of record, and reading it here
// is what makes deactivation bite on the next request rather than at token
// expiry (ADR-0011, NFR-SEC-006).
func (s *Store) InActorTx(ctx context.Context, tenantID, userID uuid.UUID, fn func(pgx.Tx, auth.Actor) error) error {
	// READ COMMITTED is pinned, not assumed: createUser's reactivate race is
	// a 409 only because the losing UPDATE re-evaluates its WHERE against the
	// winner's committed row and matches nothing — under REPEATABLE READ the
	// same interleaving raises 40001, which submitStatus does not map, so a
	// form would see a 500. default_transaction_isolation is a server
	// parameter a DBA can flip with no test failing; a guarantee handlers
	// lean on is stated here, the way append-only is enforced by revoked
	// grants rather than convention (TYRE-95).
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("beginning actor transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
		tenantID.String(), userID.String()); err != nil {
		return fmt.Errorf("binding actor context: %w", err)
	}

	actor := auth.Actor{UserID: userID, TenantID: tenantID}
	var roleName string
	var active bool
	// The tenant_isolation policy does the tenant check: a user belonging to
	// another tenant is not visible here, so a wrong tenant needs no branch.
	// role is cast to text because the enum's OID is not in pgx's type map.
	err = tx.QueryRow(ctx,
		`SELECT display_name, role::text, active FROM app.app_user WHERE id = $1`, userID).
		Scan(&actor.DisplayName, &roleName, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoSuchActor
	}
	if err != nil {
		return fmt.Errorf("resolving actor: %w", err)
	}
	if !active {
		return ErrNoSuchActor
	}
	actor.Role = auth.Role(roleName)

	depots, err := actorDepots(ctx, tx)
	if err != nil {
		return err
	}
	actor.DepotIDs = depots

	if err := fn(tx, actor); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing actor transaction: %w", err)
	}
	return nil
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
