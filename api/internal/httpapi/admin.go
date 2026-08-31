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
	"time"

	"github.com/go-chi/chi/v5"
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

// invalidError is a request that is malformed as a request — a missing field,
// an unparseable id, a value outside an enum — answered 422 with this message
// forwarded verbatim. That is safe because the message is ours: written here,
// naming the request field and never a schema object (ADR-0013). A message
// Postgres wrote is canned, and that distinction is the whole of ADR-0012.
type invalidError struct {
	field, why string
}

func (e invalidError) Error() string { return e.field + " " + e.why }

func invalid(field, why string) error {
	return invalidError{field: field, why: why}
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

type createUserRequest struct {
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	StaffNumber *string `json:"staffNumber"`
	Role        string  `json:"role"`
	// D10's rehire answer. Absent means "add a new user"; true means the
	// admin has been shown the deactivated row and asked for it back.
	Reactivate bool `json:"reactivate"`
}

type userInsert struct {
	email       string
	displayName string
	staffNumber *string
	role        string
	reactivate  bool
}

// tenantRoles is app.user_role minus PLATFORM_ADMIN. Platform staff carry a
// NULL tenant_id and are never the subject of a tenant-scoped request any more
// than they are its actor (ADR-0011); platform_admin_has_no_tenant would
// refuse the row anyway, and a refusal that depends on a constraint firing is
// an accident that happens to be safe rather than a decision.
//
// D9 narrows this per actor: CONTROLLER and DEPOT_MANAGER may create DRIVER
// alone, through a finer capability. That narrowing is an edit to this map's
// use in createUser and to nothing else (TYRE-83).
var tenantRoles = map[string]bool{
	"DRIVER": true, "TECHNICIAN": true, "CONTROLLER": true,
	"DEPOT_MANAGER": true, "ORG_ADMIN": true,
}

func (b createUserRequest) validate() (userInsert, error) {
	var u userInsert

	u.email = strings.TrimSpace(b.Email)
	if u.email == "" {
		return u, invalid("email", "is required")
	}
	if len(u.email) > maxTextLen {
		return u, invalid("email", "is too long")
	}

	u.displayName = strings.TrimSpace(b.DisplayName)
	if u.displayName == "" {
		return u, invalid("displayName", "is required")
	}
	if len(u.displayName) > maxTextLen {
		return u, invalid("displayName", "is too long")
	}

	if b.Role == "" {
		return u, invalid("role", "is required")
	}
	if !tenantRoles[b.Role] {
		return u, invalid("role", "is not a role this tenant may create")
	}
	u.role = b.Role

	// FR-AUT-022: a durable identifier independent of the display name, and
	// optional — R13 identifies its driver as "Melusi" and nothing else.
	var err error
	if u.staffNumber, err = text("staffNumber", b.StaffNumber); err != nil {
		return u, err
	}
	u.reactivate = b.Reactivate
	return u, nil
}

// mayCreateRole answers D9. ManageUsers creates any role tenantRoles allows;
// InviteDriver creates a DRIVER and nothing else. Both are capability
// questions — the actor's role name never appears, so separating the
// controller jobs later stays an edit to auth's table (ADR-0011).
//
// The pairing is what makes the guardrail hold: an actor without ManageUsers
// cannot create an administrator, so no path here promotes anyone.
func mayCreateRole(a auth.Actor, role string) error {
	if a.Can(auth.ManageUsers) {
		return nil
	}
	if a.Can(auth.InviteDriver) && role == string(auth.RoleDriver) {
		return nil
	}
	return fmt.Errorf("%w: %s may not create %s", errForbidden, a.Role, role)
}

// createUser is FR-AUT-010's invite, gated on ManageUsers, or on InviteDriver
// for a DRIVER alone (D9). It creates an active user and nothing else: leaving
// a company is active = false and never a delete (D10, FR-VEH-008), and that
// surface is TYRE-83's.
func createUser(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body createUserRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		ins, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var created userJSON
		var createdID uuid.UUID
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := mayCreateRole(a, ins.role); err != nil {
				return err
			}

			// Classify the collision before inserting, because the unique
			// index spans inactive rows and Postgres cannot say which kind it
			// caught. RLS scopes this lookup, so another tenant's address is
			// simply not here and the request proceeds as a create — which is
			// the honest answer for this tenant.
			var existingActive bool
			lookup := tx.QueryRow(ctx,
				`SELECT active FROM app.app_user WHERE email = $1`, ins.email).
				Scan(&existingActive)
			switch {
			case lookup == nil && existingActive:
				return refusalError{refusal{http.StatusConflict, codeEmailTaken, msgEmailTaken}}
			case lookup == nil && !ins.reactivate:
				return refusalError{refusal{http.StatusConflict, codeEmailInactive, msgEmailInactive}}
			case lookup == nil:
				// A rehire is the same person: updating in place keeps the id
				// their inspections are attributed through (FR-VEH-008).
				// UPDATE is granted on app_user — only DELETE was revoked
				// (000002, 000018) — because a person is not an event.
				//
				// staff_number is COALESCEd: the reactivate form never pre-fills
				// it, so an absent field means "not supplied," not "clear it" —
				// FR-AUT-022's identifier must survive a rehire that omits it.
				err := tx.QueryRow(ctx,
					`UPDATE app.app_user
					    SET active = true, display_name = $2,
					        staff_number = COALESCE($3, staff_number),
					        role = $4::app.user_role
					  WHERE email = $1 AND NOT active
					 RETURNING id, email, display_name, role::text, staff_number, active`,
					ins.email, ins.displayName, ins.staffNumber, ins.role).
					Scan(&createdID, &created.Email, &created.DisplayName, &created.Role,
						&created.StaffNumber, &created.Active)
				if errors.Is(err, pgx.ErrNoRows) {
					// Reactivated by someone else between the lookup and this
					// update. That is an active collision now, and the admin's
					// next action is the same as for any other one.
					return refusalError{refusal{http.StatusConflict, codeEmailTaken, msgEmailTaken}}
				}
				if err != nil {
					return fmt.Errorf("reactivating user: %w", err)
				}
				created.ID = createdID.String()
				return nil
			case errors.Is(lookup, pgx.ErrNoRows):
				// Nothing here holds the address; fall through to the insert.
			default:
				return fmt.Errorf("checking for an existing user: %w", lookup)
			}

			err := tx.QueryRow(ctx,
				`INSERT INTO app.app_user
				   (tenant_id, email, display_name, staff_number, role)
				 VALUES (app.current_tenant_id(), $1, $2, $3, $4::app.user_role)
				 RETURNING id, email, display_name, role::text, staff_number, active`,
				ins.email, ins.displayName, ins.staffNumber, ins.role).
				Scan(&createdID, &created.Email, &created.DisplayName, &created.Role,
					&created.StaffNumber, &created.Active)
			if err != nil {
				return fmt.Errorf("creating user: %w", err)
			}
			created.ID = createdID.String()
			return nil
		})
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}

type userJSON struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	StaffNumber *string `json:"staffNumber"`
	Active      bool    `json:"active"`
}

type assignDriverRequest struct {
	UserID   string `json:"userId"`
	FromDate string `json:"fromDate"`
}

type assignmentJSON struct {
	ID        string `json:"id"`
	VehicleID string `json:"vehicleId"`
	UserID    string `json:"userId"`
	FromDate  string `json:"fromDate"`
}

// isoDate is the only date format the API accepts or emits. A locale-sensitive
// parse is a defect waiting for a tenant in another timezone (rule 6).
const isoDate = "2006-01-02"

// assignDriver opens a driver-to-unit assignment (FR-VEH-007). It is what
// app.v_capture_vehicle reads, so it is the step between a created driver and
// a capture they can reach.
//
// The assignee's role is deliberately unchecked: no constraint says an
// assignment names a DRIVER, and asserting it here would put a rule in Go that
// the schema does not hold (ADR-0013). Every assignable role already holds
// CaptureInspection, so the gap grants nothing.
//
// to_date is left NULL — an open assignment. Closing one is a different
// action and does not belong on a create.
func assignDriver(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, err := uuid.Parse(chi.URLParam(r, "vehicleID"))
		if err != nil {
			refuseInvalid(w, r, invalid("vehicleId", "must be a uuid"))
			return
		}
		var body assignDriverRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		userID, err := uuid.Parse(strings.TrimSpace(body.UserID))
		if err != nil {
			refuseInvalid(w, r, invalid("userId", "must be a uuid"))
			return
		}
		// Absent means "today in the tenant's zone", computed in SQL where
		// that zone lives (rule 6). A browser's calendar day is the admin's,
		// not the tenant's, and the two differ for most of every day.
		// Malformed is still refused — only absence defaults.
		var from *time.Time
		if raw := strings.TrimSpace(body.FromDate); raw != "" {
			parsed, err := time.Parse(isoDate, raw)
			if err != nil {
				refuseInvalid(w, r, invalid("fromDate", "must be a date as YYYY-MM-DD"))
				return
			}
			from = &parsed
		}

		created := assignmentJSON{VehicleID: vehicleID.String(), UserID: userID.String()}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			var id uuid.UUID
			var fromDate time.Time
			err := tx.QueryRow(ctx,
				`INSERT INTO app.vehicle_driver
				   (tenant_id, vehicle_id, user_id, from_date)
				 VALUES (app.current_tenant_id(), $1, $2,
				         COALESCE($3::date,
				                  app.tenant_today((SELECT timezone FROM app.tenant
				                                     WHERE id = app.current_tenant_id()))))
				 RETURNING id, from_date`,
				vehicleID, userID, from).Scan(&id, &fromDate)
			if err != nil {
				return fmt.Errorf("assigning driver: %w", err)
			}
			created.ID = id.String()
			created.FromDate = fromDate.Format(isoDate)
			return nil
		})
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}
