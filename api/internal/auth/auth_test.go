package auth_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
)

func TestRoleCapabilities(t *testing.T) {
	tests := []struct {
		name string
		role auth.Role
		can  []auth.Capability
		cant []auth.Capability
	}{
		{
			// FR-AUT-005: a driver captures, and does nothing else.
			// FR-AUT-005a: no monetary fields either.
			name: "driver",
			role: auth.RoleDriver,
			can:  []auth.Capability{auth.CaptureInspection},
			cant: []auth.Capability{auth.ViewFleet, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.ManageUsers, auth.ManageTemplates},
		},
		{
			// FR-AUT-006 with §4.7: a technician reads, and has no lifecycle
			// screens at all.
			name: "technician",
			role: auth.RoleTechnician,
			can:  []auth.Capability{auth.ViewFleet},
			cant: []auth.Capability{auth.CaptureInspection, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.ManageTemplates},
		},
		{
			// FR-AUT-007 with FR-FIT-018: both controller jobs are this role.
			// FR-AUT-005a: a controller carries the commercial picture.
			// FR-AUT-007 carries erratum D1 — the cadence belongs to whoever
			// is responsible for the drivers, and an ORG_ADMIN is not.
			name: "controller",
			role: auth.RoleController,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig},
			cant: []auth.Capability{auth.ManageUsers, auth.ManageTemplates},
		},
		{
			// FR-AUT-008: every CONTROLLER permission, ViewValuation included.
			// The narrowing is by depot in the scope views, never by
			// withholding a capability — and ManageConfig has no narrowing at
			// all, since app.configuration is keyed by tenant (D1).
			name: "depot manager",
			role: auth.RoleDepotManager,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig},
			cant: []auth.Capability{auth.ManageUsers, auth.ManageTemplates},
		},
		{
			// FR-AUT-009 with erratum D1: configuration is shared, user
			// management is not. ManageTemplates is ORG_ADMIN's alone for a
			// different reason than ManageUsers — see D8 and the constant.
			name: "org admin",
			role: auth.RoleOrgAdmin,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.ManageUsers, auth.ManageTemplates},
			cant: nil,
		},
		{
			// ADR-0011: platform admin rows carry a NULL tenant_id and are
			// invisible in a tenant session, so it can never be the actor on
			// a tenant-scoped request.
			name: "platform admin",
			role: auth.RolePlatformAdmin,
			can:  nil,
			cant: []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ViewValuation, auth.ManageUsers},
		},
		{
			// A value the database grew and Go has not learned yet must fail
			// closed, not open.
			name: "unknown role",
			role: auth.Role("NOT_A_ROLE"),
			can:  nil,
			cant: []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssets, auth.ViewValuation},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := auth.Actor{Role: tt.role}
			for _, c := range tt.can {
				require.True(t, a.Can(c), "%s must hold %s", tt.role, c)
			}
			for _, c := range tt.cant {
				require.False(t, a.Can(c), "%s must not hold %s", tt.role, c)
			}
			require.Len(t, a.Capabilities(), len(tt.can), "Capabilities must list exactly what Can allows")
		})
	}
}

// Capabilities feeds GET /api/me, so a caller mutating the returned slice
// must not be able to grant itself something on the next request.
func TestCapabilitiesIsACopy(t *testing.T) {
	a := auth.Actor{Role: auth.RoleDriver}
	got := a.Capabilities()
	require.Equal(t, []auth.Capability{auth.CaptureInspection}, got)

	got[0] = auth.ManageUsers
	require.Equal(t, []auth.Capability{auth.CaptureInspection}, a.Capabilities())
	require.False(t, a.Can(auth.ManageUsers))
}

func TestScopeDefaultsToDepot(t *testing.T) {
	tests := []struct {
		role auth.Role
		want auth.Scope
	}{
		{auth.RoleController, auth.ScopeTenant},
		{auth.RoleOrgAdmin, auth.ScopeTenant},
		{auth.RoleTechnician, auth.ScopeDepot},
		{auth.RoleDepotManager, auth.ScopeDepot},
		{auth.RoleDriver, auth.ScopeDepot},
		{auth.RolePlatformAdmin, auth.ScopeDepot},
		{auth.Role("SOMETHING_ADDED_LATER"), auth.ScopeDepot},
		{auth.Role(""), auth.ScopeDepot},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			require.Equal(t, tt.want, auth.Actor{Role: tt.role}.Scope())
		})
	}
}
