// The menu's one list; it does not drive route enforcement, since each
// route's RequireCapability checks independently (capture has no menu item
// at all). Both read Me.capabilities from GET /api/me, so they cannot
// disagree; hiding is a courtesy, never the boundary (NFR-SEC-006).
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly capability: string | readonly string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/fleet", label: "Units", capability: "ViewFleet" },
  { to: "/fleet/tyres", label: "Tyres", capability: "ManageAssets" },
  { to: "/fleet/rigs", label: "Rigs", capability: "ViewFleet" },
  { to: "/fleet/fitments", label: "Fitments", capability: "ViewFleet" },
  { to: "/fleet/tyres/retreads", label: "Retreads", capability: "LogRetread" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
  // Add-a-unit and add-a-user stay two items, never one "Admin" group: they
  // gate on different capabilities, and the second's is an any-of array
  // (D9, ADR-0011). A merged group has no single capability to gate on.
  { to: "/admin/units/new", label: "Add a unit", capability: "ManageAssets" },
  // This item's gate is an array, not the single capability every other item
  // uses. See useCanAny's doc comment (web/src/auth/actorContext.ts) for
  // why this one needs an any-of gate (D9, ADR-0011).
  { to: "/admin/users/new", label: "Add a user", capability: ["ManageUsers", "InviteDriver"] },
] as const;

export function navItemsFor(capabilities: string[]): NavItem[] {
  const held = new Set(capabilities);
  return NAV_ITEMS.filter((item) =>
    typeof item.capability === "string"
      ? held.has(item.capability)
      : item.capability.some((capability) => held.has(capability)),
  );
}
