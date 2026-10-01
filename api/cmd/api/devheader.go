//go:build devheader

package main

import (
	"context"
	"log/slog"
	"net/http"

	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/httpapi"
)

// devHeaderEnabled decides whether the trust-any-header resolver may exist in
// this process. Container Apps injects CONTAINER_APP_NAME into every deployed
// revision, so its PRESENCE vetoes the flag. Presence, not value, because a
// stray --set-env-vars CONTAINER_APP_NAME= would read as absent through
// os.Getenv and switch the dev path on in staging (TYRE-160). The accessor is
// injected so the table test can say "present and empty". It is the second
// layer: the release binary does not contain the resolver at all (U103).
func devHeaderEnabled(lookup func(string) (string, bool)) bool {
	if _, inContainerApps := lookup("CONTAINER_APP_NAME"); inContainerApps {
		return false
	}
	v, _ := lookup("APP_DEV_TENANT_HEADER")
	return v == "1"
}

// devResolver is a devheader build's wiring: the header resolver when the
// dev switch is on, otherwise whatever bearer resolver AUTH_* configured.
func devResolver(lookup func(string) (string, bool), bearerResolver httpapi.ActorResolver, logger *slog.Logger) httpapi.ActorResolver {
	if !devHeaderEnabled(lookup) {
		return bearerResolver
	}
	logger.Warn("X-Tenant-ID/X-User-ID header resolver enabled; anyone who can send a header is anyone")
	if bearerResolver == nil {
		return httpapi.HeaderActorResolver{}
	}
	return routedResolver{bearer: bearerResolver, header: httpapi.HeaderActorResolver{}}
}

// routedResolver lets one dev API serve both a token session and a
// header-driven one: a request that carries a token is the bearer resolver's
// to judge (spec section 1, Composing the resolvers).
type routedResolver struct{ bearer, header httpapi.ActorResolver }

func (r routedResolver) Identify(ctx context.Context, req *http.Request) (httpapi.Identity, error) {
	if req.Header.Get(bearer.HeaderName) != "" {
		return r.bearer.Identify(ctx, req)
	}
	return r.header.Identify(ctx, req)
}
