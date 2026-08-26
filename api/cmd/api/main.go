// The API is deliberately thin: auth, tenant context, transport, sync
// reconciliation. Business rules about tyres live in SQL (see
// docs/architecture.md) — do not add them here.
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

// devHeaderEnabled decides whether the trust-any-header resolver may exist in
// this process. Container Apps injects CONTAINER_APP_NAME into every deployed
// revision, so its presence vetoes the flag: the dev path cannot be switched
// on in staging with a stray --set-env-vars, only run locally.
func devHeaderEnabled(getenv func(string) string) bool {
	return getenv("APP_DEV_TENANT_HEADER") == "1" && getenv("CONTAINER_APP_NAME") == ""
}

// trustedProxyHops parses TRUSTED_PROXY_HOPS (infra/main.bicep documents the
// operational default) for NFR-SEC-007's per-source-address rate limit
// (httpapi.WithTrustedProxyHops). getenv-injected like devHeaderEnabled
// above, so parsing is unit-testable without touching the process
// environment. Absent is the documented default of 1 and is not a deploy
// mistake — every environment that has not added an L7 hop in front of the
// ingress leaves this unset. Present but not a positive integer IS a
// mistake worth failing loudly for: silently falling back to 1 on a typo
// would collapse the per-address limit into one bucket shared by every
// client on the internet with nothing in the logs to explain why.
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

	// Identity has no production source until the identity provider lands
	// (FR-AUT-001); the dev header resolver must be asked for by name and
	// defaults to off. httpapi.requireActor documents what a nil resolver
	// means.
	var resolver httpapi.ActorResolver
	if devHeaderEnabled(os.Getenv) {
		logger.Warn("X-Tenant-ID/X-User-ID header resolver enabled; anyone who can send a header is anyone")
		resolver = httpapi.HeaderActorResolver{}
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
