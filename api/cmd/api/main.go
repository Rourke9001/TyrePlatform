// The API is deliberately thin: auth, tenant context, transport, sync
// reconciliation. Business rules about tyres live in SQL (see
// docs/architecture.md). Do not add them here.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/httpapi"
	"tyreplatform/api/internal/store"
)

// buildSHA is set at link time by api/Dockerfile (-X main.buildSHA) and
// reported by /readyz (TYRE-79).
var buildSHA = "dev"

// trustedProxyHops parses TRUSTED_PROXY_HOPS for NFR-SEC-007's per-source
// rate limit (httpapi.WithTrustedProxyHops). Absent defaults to 1
// (infra/app.bicep's documented default); present but not a positive
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

// authVars are ADR-0016's six settings for the bearer resolver.
var authVars = []string{
	"AUTH_DISCOVERY_URL", "AUTH_ISSUER", "AUTH_TENANT_ID",
	"AUTH_AUDIENCE", "AUTH_CLIENT_ID", "AUTH_TENANT_CLAIM",
}

// authConfig reads ADR-0016's AUTH_* variables. All set wires the bearer
// resolver and none set wires none; a partial set is a deploy mistake and
// stops startup, as a malformed TRUSTED_PROXY_HOPS does. A variable counts as
// set when it is non-empty.
func authConfig(getenv func(string) string) (bearer.Config, bool, error) {
	var unset []string
	for _, name := range authVars {
		if getenv(name) == "" {
			unset = append(unset, name)
		}
	}
	set := len(authVars) - len(unset)
	switch set {
	case 0:
		return bearer.Config{}, false, nil
	case len(authVars):
	default:
		return bearer.Config{}, false, fmt.Errorf("%d of the %d AUTH_* variables are set; set all of them or none (unset: %s)", set, len(authVars), strings.Join(unset, ", "))
	}
	cfg := bearer.Config{TenantClaim: getenv("AUTH_TENANT_CLAIM")}
	if strings.ContainsAny(cfg.TenantClaim, " \t\r\n") {
		return bearer.Config{}, false, fmt.Errorf("AUTH_TENANT_CLAIM must be a claim name, got %q", cfg.TenantClaim)
	}
	var err error
	if cfg.DiscoveryURL, err = authURL(getenv, "AUTH_DISCOVERY_URL"); err != nil {
		return bearer.Config{}, false, err
	}
	if cfg.Issuer, err = authURL(getenv, "AUTH_ISSUER"); err != nil {
		return bearer.Config{}, false, err
	}
	if cfg.TenantID, err = authUUID(getenv, "AUTH_TENANT_ID"); err != nil {
		return bearer.Config{}, false, err
	}
	if cfg.Audience, err = authUUID(getenv, "AUTH_AUDIENCE"); err != nil {
		return bearer.Config{}, false, err
	}
	if cfg.ClientID, err = authUUID(getenv, "AUTH_CLIENT_ID"); err != nil {
		return bearer.Config{}, false, err
	}
	// Without ?appid= naming tyre-api, Entra's discovery document lists keys
	// that never sign these tokens, so every token reads as an unknown kid and
	// a configuration failure would answer 401 (spec section 1, Configuration).
	if err := checkDiscoveryAppID(cfg.DiscoveryURL, cfg.Audience); err != nil {
		return bearer.Config{}, false, err
	}
	return cfg, true, nil
}

func checkDiscoveryAppID(discoveryURL, audience string) error {
	u, err := url.Parse(discoveryURL)
	if err != nil {
		return fmt.Errorf("AUTH_DISCOVERY_URL: %w", err)
	}
	raw := u.Query().Get("appid")
	if raw == "" {
		return fmt.Errorf("AUTH_DISCOVERY_URL must carry ?appid=<AUTH_AUDIENCE>, got %q", discoveryURL)
	}
	id, err := uuid.Parse(raw)
	if err != nil || id.String() != audience {
		return fmt.Errorf("AUTH_DISCOVERY_URL appid %q must equal AUTH_AUDIENCE", raw)
	}
	return nil
}

// authURL takes an absolute https URL, or http on a loopback host so a test
// identity provider can serve one. The value is returned unchanged.
func authURL(getenv func(string) string, name string) (string, error) {
	raw := getenv(name)
	u, err := url.Parse(raw)
	// Compared with iss byte for byte (ADR-0016), so a non-exact value is
	// refused, not normalised. url.Parse lower-cases the scheme, hence the
	// check on raw. Userinfo is refused so a secret never reaches an error.
	if err != nil || raw != strings.TrimSpace(raw) || !u.IsAbs() || u.Hostname() == "" ||
		u.User != nil || u.Fragment != "" || strings.Contains(raw, "#") {
		return "", fmt.Errorf("%s must be an absolute URL with a host, no userinfo, fragment or surrounding space", name)
	}
	if strings.HasPrefix(raw, "https://") || (strings.HasPrefix(raw, "http://") && isLoopback(u.Hostname())) {
		return raw, nil
	}
	return "", fmt.Errorf("%s must be lower-case https (http only on a loopback host)", name)
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authUUID returns the canonical form, which is how Entra writes tid, aud
// and azp.
func authUUID(getenv func(string) string, name string) (string, error) {
	id, err := uuid.Parse(getenv(name))
	if err != nil {
		return "", fmt.Errorf("%s must be a uuid, got %q", name, getenv(name))
	}
	return id.String(), nil
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
	// (infra/app.bicep), so the credential never lives in this repo or CI.
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

	authCfg, haveAuth, err := authConfig(os.Getenv)
	if err != nil {
		logger.Error("reading AUTH_* configuration", "err", err)
		os.Exit(1)
	}

	s, err := store.New(ctx, dsn)
	if err != nil {
		logger.Error("connecting to database", "err", err)
		os.Exit(1)
	}
	defer s.Close()

	// A typed nil must not reach the interface, or requireActor would call
	// it instead of answering 503 (ADR-0016).
	var bearerResolver httpapi.ActorResolver
	if haveAuth {
		br := bearer.New(authCfg)
		defer br.Close()
		bearerResolver = br
		logger.Info("bearer resolver wired",
			"AUTH_DISCOVERY_URL", authCfg.DiscoveryURL, "AUTH_ISSUER", authCfg.Issuer,
			"AUTH_TENANT_ID", authCfg.TenantID, "AUTH_AUDIENCE", authCfg.Audience,
			"AUTH_CLIENT_ID", authCfg.ClientID, "AUTH_TENANT_CLAIM", authCfg.TenantClaim)
	}
	resolver := devResolver(os.LookupEnv, bearerResolver, logger)
	if resolver == nil {
		logger.Error("no identity resolver is configured; every /api call answers 503 auth_unavailable until AUTH_* is set (ADR-0016)")
	}

	srv := &http.Server{
		Addr: ":" + port,
		Handler: httpapi.New(s, resolver, httpapi.WithTrustedProxyHops(hops),
			httpapi.WithBuildSHA(buildSHA),
			// Set by Container Apps in every container; empty locally.
			httpapi.WithRevision(os.Getenv("CONTAINER_APP_REVISION"))),
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
