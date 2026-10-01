//go:build !devheader

package main

import (
	"log/slog"

	"tyreplatform/api/internal/httpapi"
)

// devResolver in a release build wires the bearer resolver or nothing: the
// dev header resolver is not compiled in (U103).
func devResolver(_ func(string) (string, bool), bearerResolver httpapi.ActorResolver, _ *slog.Logger) httpapi.ActorResolver {
	return bearerResolver
}
