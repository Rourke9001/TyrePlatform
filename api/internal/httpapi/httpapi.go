// Package httpapi assembles the HTTP surface: routing, tenant resolution and
// the handlers. Handlers stay dumb. A business decision about tyres belongs
// in SQL, not here (api/CLAUDE.md).
package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"tyreplatform/api/internal/store"
)

// Option configures New. Variadic rather than a positional parameter: New
// has dozens of call sites, nearly all of them tests asserting behaviour
// that has nothing to do with proxy topology, and a rate-limiting knob
// should not force every one of them to state an opinion about it.
type Option func(*options)

type options struct {
	trustedProxyHops int
}

// WithTrustedProxyHops sets how many trusted L7 hops sit between the caller
// and this process, for NFR-SEC-007's per-source-address rate limit
// (ratelimit.go's clientAddress) to read the address the outermost trusted
// hop actually observed rather than one a caller can forge. Every call site
// that does not name one defaults to 1: today's single Azure Container Apps
// ingress hop, infra/main.bicep's TRUSTED_PROXY_HOPS.
func WithTrustedProxyHops(n int) Option {
	return func(o *options) { o.trustedProxyHops = n }
}

func New(s *store.Store, resolver ActorResolver, opts ...Option) http.Handler {
	o := options{trustedProxyHops: 1}
	for _, opt := range opts {
		opt(&o)
	}

	r := chi.NewRouter()
	// chi answers both of these itself, in text/plain, unless they are
	// registered. They are the envelope's only escapees (ADR-0012).
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusNotFound, codeNotFound, "no such endpoint")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(r.Context(), w, http.StatusMethodNotAllowed, codeMethodNotAllowed, "that method is not allowed on this endpoint")
	})
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
		r.Post("/vehicles", createVehicle(s))
		r.Get("/vehicles/{vehicleID}", getUnit(s))
		r.Patch("/vehicles/{vehicleID}", patchUnit(s))
		r.Post("/vehicles/{vehicleID}/status", setUnitStatus(s))
		r.Get("/vehicles/{vehicleID}/fitments", listUnitFitments(s))
		r.Get("/vehicles/{vehicleID}/drivers", listUnitDrivers(s))
		r.Get("/vehicles/{vehicleID}/inspection-tasks", listUnitTasks(s))
		r.Get("/fitments", listOpenFitments(s))
		r.Get("/combinations", listCombinations(s))
		r.Get("/depots", listDepots(s))
		r.Get("/retread-jobs", listRetreadJobs(s))
		r.Get("/my/vehicles", listMyVehicles(s))
		r.Get("/my/tasks", listMyTasks(s))
		r.Get("/capture/vehicles/{vehicleID}", captureContext(s))
		// NFR-SEC-007: rate-limited, unlike the reference read above. A
		// driver fetches capture context once per vehicle, but a bad outbox
		// retry loop or a hostile client can hammer a write. Built once
		// here, not per request (ratelimit.go's const comment).
		r.With(submitRateLimit(
			newRateLimiter(accountSubmitsPerMinute),
			newRateLimiter(addressSubmitsPerMinute),
			o.trustedProxyHops,
		)).Post("/inspections", submitInspection(s))
		// Unlike the submit above, no rate limiter: FR-INS-012 gates this on
		// VoidInspection, a human role, not on an unattended outbox retrying
		// a capture (ADR-0013).
		r.Post("/inspections/{inspectionID}/void", voidInspection(s))
		r.Get("/org/branding", orgBranding(s))
		r.Get("/axle-configurations", listAxleConfigurations(s))
		r.Get("/tyres", listTyres(s))

		// B7.2, the analytics read API (TYRE-36): read-only relays of the
		// B7.1 views. Nothing here computes a figure.
		r.Get("/exceptions", listExceptions(s))
		r.Get("/valuation/at-risk", valueAtRisk(s))
		r.Get("/valuation/estate", estateValuation(s))
		r.Get("/analytics/tread-distribution", treadDistribution(s))
		r.Get("/analytics/irregular-wear", irregularWear(s))
		r.Get("/analytics/inflation-compliance", inflationCompliance(s))
		r.Get("/analytics/wear-rate", wearRate(s))
		r.Get("/analytics/removal-forecast", removalForecast(s))
		r.Get("/spares", listSpares(s))

		r.Post("/tyres", receiveTyres(s))
		r.Post("/tyres/{tyreID}/cost", setTyreCost(s))
		r.Post("/tyres/{tyreID}/dispose", disposeTyre(s))
		r.Post("/tyres/{tyreID}/dispatch", dispatchTyre(s))
		r.Post("/tyres/{tyreID}/return", returnTyreToStock(s))
		r.Post("/retread-jobs/{jobID}/return", logRetreadReturn(s))
		r.Post("/vehicles/{vehicleID}/fitments", fitTyre(s))
		r.Post("/fitments/{fitmentID}/remove", removeFitment(s))
		r.Post("/vehicles/{vehicleID}/rotations", rotateTyres(s))
		r.Post("/users", createUser(s))
		r.Post("/vehicles/{vehicleID}/drivers", assignDriver(s))
		r.Post("/vehicles/{vehicleID}/inspection-tasks", scheduleInspectionTask(s))
		r.Post("/combinations", createCombination(s))
		r.Post("/combinations/{combinationID}/end", endCombination(s))
		r.Get("/combinations/observations", listObservations(s))
		r.Post("/combinations/observations/{observationID}/apply", applyObservation(s))
		r.Post("/combinations/observations/{observationID}/dismiss", dismissObservation(s))
	})
	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}
