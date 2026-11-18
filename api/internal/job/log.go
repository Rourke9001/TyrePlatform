// Package job runs the platform's scheduled work. `api job daily` connects
// as app_job, lists the ACTIVE tenants and runs each daily step inside one
// transaction bound to each tenant (ADR-0025, TYRE-371). Nothing outside
// this package writes a line with a `job` field.
package job

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Every line is JSON with `job` set to Name and `event` set to one of these,
// and msg equal to the event. The success line is a contract with the alert
// in infra/platform.bicep, which scripts/check-job-log-contract.mjs holds.
const (
	Name              = "daily" // the `job` field of every line; the alert matches it
	EventStarted      = "daily_job_started"
	EventTenantDone   = "daily_job_tenant_done"
	EventTenantFailed = "daily_job_tenant_failed"
	EventSucceeded    = "daily_job_succeeded" // the alert matches it
	EventFailed       = "daily_job_failed"
)

// failureAttrs names a failure by its SQLSTATE and constraint, or by its Go
// type, and never by its text: this schema's messages name people
// (db/migrations/000060_per_trip_assignment.up.sql:148), and a constraint
// error's detail quotes the row (NFR-PRV-007).
func failureAttrs(err error) []any {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		attrs := []any{"sqlstate", pgErr.Code}
		if pgErr.ConstraintName != "" {
			attrs = append(attrs, "constraint", pgErr.ConstraintName)
		}
		return attrs
	}
	inner := err
	for next := errors.Unwrap(inner); next != nil; next = errors.Unwrap(inner) {
		inner = next
	}
	return []any{"error_type", fmt.Sprintf("%T", inner)}
}
