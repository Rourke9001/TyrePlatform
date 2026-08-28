// The admin write surface: users, units and the assignment between them.
// Every handler here follows ADR-0013 — shape validated in Go before a
// transaction opens, the row's own rules left to the constraints that already
// state them, and tenant_id taken from the bound session and never from the
// request.

package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

type axleConfigurationJSON struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// listAxleConfigurations serves the library a unit is created against
// (FR-CFG-001..007). Gated on ManageAssets rather than ViewFleet: the list is
// only useful to someone who may create a unit with it, and D8 puts that on
// ManageAssets.
//
// Authoring a configuration is not here and must not arrive here. D8 reserves
// it for ManageTemplates, ORG_ADMIN alone (TYRE-84), because a wrong template
// silently corrupts every position on every unit that uses it.
func listAxleConfigurations(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: writeJSON encodes what it is handed, and a
		// nil slice reaches the client as JSON `null` rather than `[]`.
		configs := []axleConfigurationJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT id, code, name, version, axle_count
				   FROM app.axle_configuration
				  WHERE active
				  ORDER BY code, version`)
			if err != nil {
				return fmt.Errorf("listing axle configurations: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var c axleConfigurationJSON
				var id uuid.UUID
				if err := rows.Scan(&id, &c.Code, &c.Name, &c.Version, &c.AxleCount); err != nil {
					return fmt.Errorf("scanning axle configuration: %w", err)
				}
				c.ID = id.String()
				configs = append(configs, c)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, configs)
	}
}

// maxCreateBytes caps an admin create body. It is a transport limit, not a
// policy one: the largest of these requests is a handful of short strings.
const maxCreateBytes = 16 << 10

// maxTextLen caps every free-text field on a create. A transport limit for the
// same reason — the columns are unbounded text, and the database is not the
// place to discover that a client sent a megabyte of description.
const maxTextLen = 200

// errInvalidRequest is a request that is malformed as a request: a missing
// field, an unparseable id, a value outside an enum. It is answered 422 with
// the message forwarded, which is safe because the message is ours — written
// here, naming no schema object (ADR-0013). A message Postgres wrote is
// canned, and that distinction is the whole of ADR-0012.
var errInvalidRequest = errors.New("invalid request")

func invalid(field, why string) error {
	return fmt.Errorf("%w: %s %s", errInvalidRequest, field, why)
}

// decodeJSON answers the refusal itself when a body cannot be read. Validation
// runs before any transaction opens (ADR-0013): a malformed request has no
// business reaching the database, and opening a transaction to reject one is
// work a caller can ask for freely.
func decodeJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCreateBytes))
	if err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "body too large or unreadable")
		return false
	}
	if err := json.Unmarshal(raw, into); err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	return true
}

// refuseInvalid answers a validation failure and reports whether it did, so a
// handler reads as a straight line of guard clauses.
func refuseInvalid(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	writeError(r.Context(), w, http.StatusUnprocessableEntity, codeInvalidSubmission, err.Error())
	return true
}

// text trims and length-checks an optional free-text field, answering nil for
// an absent or blank one so the column holds NULL rather than an empty string.
func text(field string, in *string) (*string, error) {
	if in == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*in)
	if trimmed == "" {
		return nil, nil
	}
	if len(trimmed) > maxTextLen {
		return nil, invalid(field, "is too long")
	}
	return &trimmed, nil
}

type createVehicleRequest struct {
	FleetNumber     string  `json:"fleetNumber"`
	Registration    *string `json:"registration"`
	Description     *string `json:"description"`
	ConfigurationID string  `json:"configurationId"`
	UnitKind        string  `json:"unitKind"`
	HomeDepotID     *string `json:"homeDepotId"`
}

type vehicleInsert struct {
	fleetNumber     string
	registration    *string
	description     *string
	configurationID uuid.UUID
	unitKind        string
	homeDepotID     *uuid.UUID
}

// unitKinds mirrors app.unit_kind. The database is the authority (ADR-0011);
// this list exists so an unknown kind is refused as a malformed request rather
// than reaching the enum cast as a Postgres error a client cannot read.
var unitKinds = map[string]bool{"HORSE": true, "TRAILER": true, "RIGID": true, "LIGHT": true}

// FR-VEH-002 requires a unit's kind to be recorded, and 000025's TY009 trigger
// passes a NULL kind — so a unit created without one is a unit whose
// fitment-odometer rule silently cannot fire. The schema still permits NULL
// for the rows 000011's backfill could not derive; requiring it here stops the
// set growing through the product (ADR-0013's accepted gap, owned by TYRE-88).
func (b createVehicleRequest) validate() (vehicleInsert, error) {
	var v vehicleInsert

	// FR-VEH-003: alphanumeric fleet numbers, with no numeric assumption. The
	// only check is that there is one — a pattern here would reject real data.
	v.fleetNumber = strings.TrimSpace(b.FleetNumber)
	if v.fleetNumber == "" {
		return v, invalid("fleetNumber", "is required")
	}
	if len(v.fleetNumber) > maxTextLen {
		return v, invalid("fleetNumber", "is too long")
	}

	if b.UnitKind == "" {
		return v, invalid("unitKind", "is required")
	}
	if !unitKinds[b.UnitKind] {
		return v, invalid("unitKind", "must be one of HORSE, TRAILER, RIGID, LIGHT")
	}
	v.unitKind = b.UnitKind

	id, err := uuid.Parse(b.ConfigurationID)
	if err != nil {
		return v, invalid("configurationId", "must be a uuid")
	}
	v.configurationID = id

	if b.HomeDepotID != nil && strings.TrimSpace(*b.HomeDepotID) != "" {
		depot, err := uuid.Parse(*b.HomeDepotID)
		if err != nil {
			return v, invalid("homeDepotId", "must be a uuid")
		}
		v.homeDepotID = &depot
	}

	if v.registration, err = text("registration", b.Registration); err != nil {
		return v, err
	}
	if v.description, err = text("description", b.Description); err != nil {
		return v, err
	}
	return v, nil
}

// createVehicle is D8's add-a-unit, gated on ManageAssets and never on a role
// name. A DEPOT_MANAGER holding it writes tenant-wide: the scope views narrow
// reads, and write-side depot scoping is deferred deliberately (D8).
func createVehicle(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body createVehicleRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		ins, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var created vehicleJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			var id uuid.UUID
			// tenant_id comes from the bound session, never from the request:
			// the WITH CHECK half of tenant_isolation is the guarantee, and a
			// request-supplied tenant is the thing it exists to refuse
			// (non-negotiable rule 1). created_by needs no mention — it
			// defaults to app.current_actor_id() (DR-013, 000017).
			err := tx.QueryRow(ctx,
				`INSERT INTO app.vehicle
				   (tenant_id, fleet_number, registration, description,
				    configuration_id, unit_kind, home_depot_id)
				 VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5::app.unit_kind, $6)
				 RETURNING id, fleet_number, registration`,
				ins.fleetNumber, ins.registration, ins.description,
				ins.configurationID, ins.unitKind, ins.homeDepotID).
				Scan(&id, &created.FleetNumber, &created.Registration)
			if err != nil {
				return fmt.Errorf("creating vehicle: %w", err)
			}
			created.ID = id.String()
			return nil
		})
		if !ok {
			return
		}
		// Content-Type before WriteHeader: WriteHeader locks the header map
		// in, so writeJSON's own Set would be dropped and the response would
		// go out as text/plain with the status assertion still green.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}
