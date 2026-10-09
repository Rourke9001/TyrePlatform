package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

// readyTimeout sits under app.bicep's readiness probe timeout (3s), so a
// slow database reports unready rather than timing the probe out.
const readyTimeout = 2 * time.Second

type pinger interface {
	Ping(ctx context.Context) error
}

// sha and revision together tell this replica from one of the revision it
// replaces, even on the same commit.
type readiness struct {
	Status   string `json:"status"`
	SHA      string `json:"sha"`
	Revision string `json:"revision"`
}

// readyz backs the readiness probe and the deploy gate (TYRE-79, spec
// section 2). Its database ping is NFR-OBS-005's one critical dependency.
func readyz(p pinger, sha, revision string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), readyTimeout)
		defer cancel()
		body, code := readiness{Status: "ready", SHA: sha, Revision: revision}, http.StatusOK
		if err := p.Ping(ctx); err != nil {
			slog.WarnContext(r.Context(), "readiness ping failed", "err", err)
			// The route is public, so the ping error never reaches the body.
			body.Status, code = "unready", http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}
}
