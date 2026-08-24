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
	ManageConfig      Capability = "ManageConfig"
	ManageUsers       Capability = "ManageUsers"
)

// FR-AUT-005..009. DEPOT_MANAGER holds everything CONTROLLER does: FR-AUT-008
// narrows it by depot, and that narrowing lives in the scope views, not here.
// PLATFORM_ADMIN holds nothing — its rows carry a NULL tenant_id and cannot be
// seen from inside a tenant session, so it is never the actor on a
// tenant-scoped request (ADR-0011). A role absent from this map holds nothing,
// which is what makes an unrecognised value fail closed.
var capabilities = map[Role][]Capability{
	RoleDriver:       {CaptureInspection},
	RoleTechnician:   {ViewFleet},
	RoleController:   {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread},
	RoleDepotManager: {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread},
	RoleOrgAdmin:     {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ManageConfig, ManageUsers},
}

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
