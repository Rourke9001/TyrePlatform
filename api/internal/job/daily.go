package job

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/store"
)

// Step is one statement run inside a tenant's transaction, returning one row
// of one int: the rows it created. TYRE-243's exception pass is a second
// entry in DailySteps.
type Step struct {
	Name string // logged as `step`
	SQL  string
}

// DailySteps is what the daily run does for each tenant. The tenant's day
// comes from SQL in the tenant's own zone, never from Go (rule 6).
var DailySteps = []Step{{
	Name: "generate_inspection_tasks",
	SQL:  `SELECT app.generate_inspection_tasks(app.tenant_today((SELECT timezone FROM app.tenant)))`,
}}

// Daily is one run over the tenants Tenants lists. Tests hand it the tenants
// they planted, since other packages share the database.
type Daily struct {
	Store   *store.Store
	Tenants func(context.Context) ([]uuid.UUID, error)
	Steps   []Step
	Log     *slog.Logger // Run adds the job field
}

// lockClass is the first key of the per-tenant advisory lock; the second is
// hashtext of the tenant id. Azure has no setting that stops two executions
// overlapping, so two runs take turns per tenant, and a transaction lock
// needs no connection held for the whole run (ADR-0025, spec Lead's call 4).
const lockClass int32 = 371

func lockTenant(ctx context.Context, tx pgx.Tx, tenant uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1::int4, hashtext($2::text))`,
		lockClass, tenant.String()); err != nil {
		return fmt.Errorf("taking tenant lock: %w", err)
	}
	return nil
}

// Run visits every tenant even after one fails, and fails the run if any did.
// Zero tenants is a success: production starts with none.
func (d Daily) Run(ctx context.Context) error {
	log := d.Log.With("job", Name)
	log.Info(EventStarted, "event", EventStarted)
	ids, err := d.Tenants(ctx)
	if err != nil {
		log.Error(EventFailed, append([]any{"event", EventFailed, "stage", "list"}, failureAttrs(err)...)...)
		return fmt.Errorf("listing tenants: %w", err)
	}
	ids = slices.Clone(ids)
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })

	failed, created := 0, 0
	for _, id := range ids {
		counts, step, err := d.visit(ctx, id)
		if err != nil {
			failed++
			log.Error(EventTenantFailed, append([]any{"event", EventTenantFailed, "tenant_id", id.String(), "step", step},
				failureAttrs(err)...)...)
			continue
		}
		for i, s := range d.Steps {
			log.Info(EventTenantDone, "event", EventTenantDone, "tenant_id", id.String(), "step", s.Name, "created", counts[i])
			created += counts[i]
		}
	}
	if failed > 0 {
		log.Error(EventFailed, "event", EventFailed, "failed_tenants", failed)
		return fmt.Errorf("%d of %d tenants failed", failed, len(ids))
	}
	log.Info(EventSucceeded, "event", EventSucceeded, "tenants", len(ids), "created", created)
	return nil
}

// visit runs every step for one tenant in one transaction, so a later step's
// failure rolls an earlier one back with it. It reports what each step
// created, or the stage that failed: a step's name, `lock`, or `transaction`
// for the begin, the tenant binding or the commit.
func (d Daily) visit(ctx context.Context, tenant uuid.UUID) ([]int, string, error) {
	stage := "transaction"
	counts := make([]int, len(d.Steps))
	err := d.Store.InTenantTx(ctx, tenant, func(tx pgx.Tx) error {
		stage = "lock"
		if err := lockTenant(ctx, tx, tenant); err != nil {
			return err
		}
		for i, s := range d.Steps {
			stage = s.Name
			if err := tx.QueryRow(ctx, s.SQL).Scan(&counts[i]); err != nil {
				return fmt.Errorf("step %s: %w", s.Name, err)
			}
		}
		stage = "transaction"
		return nil
	})
	return counts, stage, err
}

// ListActiveTenants is the one statement the job runs with no tenant bound
// (spec, Anti-goals). Only app_job may call the function (ADR-0025).
func ListActiveTenants(s *store.Store) func(context.Context) ([]uuid.UUID, error) {
	return func(ctx context.Context) ([]uuid.UUID, error) {
		rows, err := s.Pool().Query(ctx, `SELECT id FROM app.active_tenant_ids() AS id`)
		if err != nil {
			return nil, fmt.Errorf("listing active tenants: %w", err)
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
		if err != nil {
			return nil, fmt.Errorf("listing active tenants: %w", err)
		}
		return ids, nil
	}
}
