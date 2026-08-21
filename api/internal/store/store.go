// Package store owns the database connection and the tenant-context
// transaction pattern. Every tenant-scoped query in the API goes through
// InTenantTx; a query on the bare pool has no tenant bound and RLS returns
// it nothing (non-negotiable rule 1, api/CLAUDE.md).
package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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
