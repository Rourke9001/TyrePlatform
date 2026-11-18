package job

import (
	"context"
	"io"
	"log/slog"
	"time"

	"tyreplatform/api/internal/store"
)

// poolSize is set in code, not in the DSN the vault holds: four API replicas
// at 7 and this job's 2 make 30 of B1ms's 35 user connections (ADR-0005's
// 2026-11-18 amendment).
const poolSize int32 = 2

// runDeadline is below infra/app.bicep's replicaTimeout of 600 s, so the run
// ends by its own exit code and its own failure line, never by Azure killing
// it (spec section 4).
const runDeadline = 9 * time.Minute

func openStore(ctx context.Context, dsn string) (*store.Store, error) {
	return store.New(ctx, dsn, store.WithMaxConns(poolSize))
}

// RunDaily is the process entry for `api job daily`: it reads DATABASE_URL
// and nothing else, and returns the exit code. The DSN is app_job's.
func RunDaily(ctx context.Context, getenv func(string) string, out io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(out, nil))
	log := logger.With("job", Name)
	ctx, cancel := context.WithTimeout(ctx, runDeadline)
	defer cancel()

	dsn := getenv("DATABASE_URL")
	if dsn == "" {
		log.Error(EventFailed, "event", EventFailed, "stage", "config")
		return 1
	}
	s, err := openStore(ctx, dsn)
	if err != nil {
		log.Error(EventFailed, append([]any{"event", EventFailed, "stage", "connect"}, failureAttrs(err)...)...)
		return 1
	}
	defer s.Close()
	if err := (Daily{Store: s, Tenants: ListActiveTenants(s), Steps: DailySteps, Log: logger}).Run(ctx); err != nil {
		return 1
	}
	return 0
}
