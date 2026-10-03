//go:build devheader

package main

import (
	"context"
	"log/slog"
	"net/http"

	"tyreplatform/api/internal/bearer"
	"tyreplatform/api/internal/httpapi"
)

// CONTAINER_APP_NAME is injected into every Container Apps revision, so its
// presence vetoes the flag. Presence, not value: an empty
// --set-env-vars CONTAINER_APP_NAME= reads as absent through os.Getenv
// (TYRE-160). Second layer behind the build tag (U103).
func devHeaderEnabled(lookup func(string) (string, bool)) bool {
	if _, inContainerApps := lookup("CONTAINER_APP_NAME"); inContainerApps {
		return false
	}
	v, _ := lookup("APP_DEV_TENANT_HEADER")
	return v == "1"
}

// devResolver is a devheader build's wiring. Switch off: whatever bearer
// resolver AUTH_* configured. Switch on: the header resolver alone, or, when
// a bearer resolver is configured too, a routedResolver that sends requests
// carrying Authorization to the bearer one.
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
