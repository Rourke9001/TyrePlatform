// Package auth holds the authorisation vocabulary: who is acting, what role
// they hold, and what that role may do. It knows nothing of HTTP and nothing
// of SQL — the resolver supplies identity, the store supplies the role, and
// this package answers only "may they".
package auth

import "github.com/google/uuid"

// Role mirrors app.user_role. The database is the authority (ADR-0011); this
// type exists only so Go can hold the value it read.
type Role string

const (
	RoleDriver        Role = "DRIVER"
	RoleTechnician    Role = "TECHNICIAN"
	RoleController    Role = "CONTROLLER"
	RoleDepotManager  Role = "DEPOT_MANAGER"
	RoleOrgAdmin      Role = "ORG_ADMIN"
	RolePlatformAdmin Role = "PLATFORM_ADMIN"
)

// Capability is what a handler asserts. Handlers never test a role name: the
// fleet-controller and asset-controller jobs are one role (SRS §4.3,
// FR-FIT-018), and separating them later has to be an edit to the table
// below rather than a sweep through every handler.
type Capability string

const (
	ViewFleet         Capability = "ViewFleet"
	CaptureInspection Capability = "CaptureInspection"
	ManageAssignments Capability = "ManageAssignments"
	ManageAssets      Capability = "ManageAssets"
	LogRetread        Capability = "LogRetread"
	// ViewValuation gates every monetary field and its aggregates — purchase
	// price, rand/mm, casing value, tread value, total value, sale proceeds
	// (FR-AUT-005a). The restriction is enforced server-side by projection: a
	// client surface that omits the field is not the control (NFR-SEC-006).
	ViewValuation Capability = "ViewValuation"
	ManageConfig  Capability = "ManageConfig"
	// ManageTemplates is separate from ManageConfig on purpose (D8). A tenant
	// picks its axle configuration from the platform-seeded library
	// (FR-CFG-001..007); authoring one outside it is ORG_ADMIN's alone,
	// because a wrong template silently corrupts every position on every unit
	// that uses it. ManageConfig reaches thresholds, bands, rates and cadence
	// and is held by CONTROLLER and DEPOT_MANAGER — sharing a gate would hand
	// template authoring to both.
	ManageTemplates Capability = "ManageTemplates"
	ManageUsers     Capability = "ManageUsers"
)

// FR-AUT-005..009, carrying erratum D1. DEPOT_MANAGER holds everything
// CONTROLLER does: FR-AUT-008 narrows it by depot, and that narrowing lives in
// the scope views, not here. ManageConfig is the one capability with no
// narrowing to live anywhere — app.configuration is keyed by tenant, not by
// depot, so a depot manager holding it configures the whole tenant. D1 accepts
// that breadth deliberately; there is no depot-scoped variant to reach for, and
// template authoring is held away from it entirely (TYRE-84).
// PLATFORM_ADMIN holds nothing — its rows carry a NULL tenant_id and cannot be
// seen from inside a tenant session, so it is never the actor on a
// tenant-scoped request (ADR-0011). A role absent from this map holds nothing,
// which is what makes an unrecognised value fail closed.
var capabilities = map[Role][]Capability{
	RoleDriver:       {CaptureInspection},
	RoleTechnician:   {ViewFleet},
	RoleController:   {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig},
	RoleDepotManager: {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig},
	RoleOrgAdmin:     {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig, ManageUsers, ManageTemplates},
}

// Scope is how much of the tenant an actor reads. It is deliberately not a
// capability: CONTROLLER and DEPOT_MANAGER may do the same things
// (FR-AUT-008) and differ only in breadth, so folding breadth into the
// capability table would make two different questions share one answer.
// Handlers ask for the scope and compose the matching view; the role name
// stays in this package.
type Scope int

const (
	// ScopeDepot is the zero value on purpose. A role absent from the table
	// below reads only its own depots, so a role added later without a scope
	// entry is under-permissioned and visibly broken rather than silently
	// handed the whole tenant.
	ScopeDepot Scope = iota
	ScopeTenant
)

// FR-AUT-006/007/008. Only the tenant-wide roles appear; everything else
// takes the depot-narrowed zero value.
var scopes = map[Role]Scope{
	RoleController: ScopeTenant,
	RoleOrgAdmin:   ScopeTenant,
}

func (a Actor) Scope() Scope { return scopes[a.Role] }

// Actor is the resolved caller: who they are, which tenant they act for, and
// what the database says they may do.
type Actor struct {
	UserID      uuid.UUID
	TenantID    uuid.UUID
	DisplayName string
	Role        Role
	DepotIDs    []uuid.UUID
}

func (a Actor) Can(c Capability) bool {
	for _, held := range capabilities[a.Role] {
		if held == c {
			return true
		}
	}
	return false
}

// Capabilities lists what the actor may do, for GET /api/me. The client uses
// it to decide what to render; the server re-checks on every request
// (NFR-SEC-006). The copy is deliberate — the caller must not be able to
// edit the table through the slice it is handed.
func (a Actor) Capabilities() []Capability {
	held := capabilities[a.Role]
	out := make([]Capability, len(held))
	copy(out, held)
	return out
}
