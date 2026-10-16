package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

// readyTimeout sits under app.bicep's readiness probe timeout (3s), so a
// slow database reports unready rather than timing the probe out.
const readyTimeout = 2 * time.Second

// readyFor is how long one ping's answer stands, success or failure. Half
// the gate's 10s poll and the probe's period, so a failure that starts just
// after a fresh "ready" shows within one poll (TYRE-405, section 7 of
// docs/superpowers/specs/2026-10-16-platform-readiness-design.md).
const readyFor = 5 * time.Second

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

// readinessProbe answers every /readyz inside readyFor from one ping, so an
// anonymous caller cannot spend a pooled connection per request (TYRE-405).
type readinessProbe struct {
	pinger pinger
	now    func() time.Time
	// onJoin is a test hook, nil in production: it lets a test tell a
	// request that waited on a ping in flight from one served from cache.
	onJoin func()

	mu     sync.Mutex
	flight *pingFlight
}

// err is written before done closes, so a reader that has seen done closed
// reads it without the lock.
type pingFlight struct {
	started time.Time
	done    chan struct{}
	err     error
}

func newReadinessProbe(p pinger, now func() time.Time) *readinessProbe {
	return &readinessProbe{pinger: p, now: now}
}

func (p *readinessProbe) check(ctx context.Context) error {
	p.mu.Lock()
	f := p.flight
	joined := false
	switch {
	case f == nil:
		f = p.start()
	case isClosed(f.done):
		if p.now().Sub(f.started) < readyFor {
			p.mu.Unlock()
			return f.err
		}
		f = p.start()
	default:
		// A ping in flight is joined whatever its age: it lasts at most
		// readyTimeout.
		joined = true
	}
	p.mu.Unlock()
	if joined && p.onJoin != nil {
		p.onJoin()
	}
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// start runs with p.mu held.
func (p *readinessProbe) start() *pingFlight {
	f := &pingFlight{started: p.now(), done: make(chan struct{})}
	p.flight = f
	go func() {
		// Its own context, never a request's: one client disconnecting must
		// not cancel the answer the others wait on.
		ctx, cancel := context.WithTimeout(context.Background(), readyTimeout)
		defer cancel()
		f.err = p.pinger.Ping(ctx)
		if f.err != nil {
			slog.WarnContext(ctx, "readiness ping failed", "err", f.err)
		}
		close(f.done)
	}()
	return f
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// readyz backs the readiness probe and the deploy gate (TYRE-79, section 3
// of docs/superpowers/specs/2026-10-09-staging-deploy-path-design.md). Its
// database ping is NFR-OBS-005's one critical dependency.
func readyz(probe *readinessProbe, sha, revision string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, code := readiness{Status: "ready", SHA: sha, Revision: revision}, http.StatusOK
		if err := probe.check(r.Context()); err != nil {
			// The route is public, so the ping error never reaches the body.
			body.Status, code = "unready", http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(body)
	}
}
