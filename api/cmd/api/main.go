// The API is deliberately thin: auth, tenant context, transport, sync
// reconciliation. Business rules about tyres live in SQL (see
// docs/architecture.md) — do not add them here.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// devHeaderEnabled decides whether the trust-any-header tenant resolver may
// exist in this process. Container Apps injects CONTAINER_APP_NAME into every
// deployed revision, so its presence vetoes the flag: the dev path cannot be
// switched on in staging with a stray --set-env-vars, only run locally.
func devHeaderEnabled(getenv func(string) string) bool {
	return getenv("APP_DEV_TENANT_HEADER") == "1" && getenv("CONTAINER_APP_NAME") == ""
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
	s, err := store.New(ctx, dsn)
	if err != nil {
		logger.Error("connecting to database", "err", err)
		os.Exit(1)
	}
	defer s.Close()

	// Tenant context has no production source until the IdP integration
	// (epic TYRE-2); the dev header resolver must be asked for by name and
	// defaults to off. httpapi.requireTenant documents what a nil resolver
	// means.
	var resolver httpapi.TenantResolver
	if devHeaderEnabled(os.Getenv) {
		logger.Warn("X-Tenant-ID header resolver enabled; never do this in a deployed environment")
		resolver = httpapi.HeaderTenantResolver{}
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           httpapi.New(s, resolver),
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
