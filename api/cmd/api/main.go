// The API is deliberately thin: auth, tenant context, transport, sync
// reconciliation. Business rules about tyres live in SQL (see
// docs/architecture.md). Do not add them here.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// trustedProxyHops parses TRUSTED_PROXY_HOPS for NFR-SEC-007's per-source
// rate limit (httpapi.WithTrustedProxyHops). Absent defaults to 1
// (infra/main.bicep's documented default); present but not a positive
// integer fails loudly rather than silently collapsing every client into
// one bucket.
func trustedProxyHops(getenv func(string) string) (int, error) {
	raw := getenv("TRUSTED_PROXY_HOPS")
	if raw == "" {
		return 1, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0, fmt.Errorf("TRUSTED_PROXY_HOPS must be a positive integer, got %q", raw)
	}
	return n, nil
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Locally DATABASE_URL is set directly; in staging it is a Container Apps
	// secret that references kv-tyre-staging via the API's managed identity
	// (infra/main.bicep), so the credential never lives in this repo or CI.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		logger.Error("DATABASE_URL is not set")
		os.Exit(1)
	}

	hops, err := trustedProxyHops(os.Getenv)
	if err != nil {
		logger.Error("parsing TRUSTED_PROXY_HOPS", "err", err)
		os.Exit(1)
	}

	s, err := store.New(ctx, dsn)
	if err != nil {
		logger.Error("connecting to database", "err", err)
		os.Exit(1)
	}
	defer s.Close()

	// The bearer resolver is wired by a later task; until then only a devheader
	// build can have a resolver. A nil resolver answers 503 (ADR-0016).
	var bearerResolver httpapi.ActorResolver
	resolver := devResolver(os.LookupEnv, bearerResolver, logger)
	if resolver == nil {
		logger.Error("no identity resolver is configured; every /api call answers 503 auth_unavailable until AUTH_* is set (ADR-0016)")
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           httpapi.New(s, resolver, httpapi.WithTrustedProxyHops(hops)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Container Apps sends SIGTERM on scale-in; draining in-flight requests
	// here is what makes scale-to-zero invisible to clients.
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	logger.Info("listening", "port", port)

	select {
	case err := <-errCh:
		logger.Error("server failed", "err", err)
		os.Exit(1)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown incomplete", "err", err)
		os.Exit(1)
	}
}
