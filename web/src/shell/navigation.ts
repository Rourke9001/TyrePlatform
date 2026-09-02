// The menu's one list — navItemsFor drives which links render. It does not
// drive route enforcement: each route's RequireCapability checks its own
// capability independently, which it must, since a route can exist with no
// menu item (capture, added later, has none). This registry and every
// RequireCapability both read Me.capabilities from GET /api/me, so they
// cannot disagree about what the actor holds; hiding a menu item is a
// courtesy, never the boundary (NFR-SEC-006).
//
// Capabilities are strings, not a union: the server owns the vocabulary
// (web/src/auth/me.ts), and an unknown one degrades to a missing menu item
// rather than a crash on deploy ordering.
export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly capability: string | readonly string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/fleet", label: "Units", capability: "ViewFleet" },
  // Rigs joins this row when TYRE-72 builds it — no stub; a menu item that
  // 404s is worse than an absent one.
  { to: "/fleet/tyres", label: "Tyres", capability: "ManageAssets" },
  { to: "/fleet/fitments", label: "Fitments", capability: "ViewFleet" },
  { to: "/fleet/tyres/retreads", label: "Retreads", capability: "LogRetread" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
  // Add-a-unit and add-a-user stay two items, never one "Admin" group: a
  // CONTROLLER holds InviteDriver but not ManageAssets, so a merged group
  // would show them half a menu they cannot use.
  { to: "/admin/units/new", label: "Add a unit", capability: "ManageAssets" },
  // This item's gate is an array, not the single capability every other item
  // uses — see useCanAny's doc comment (web/src/auth/actorContext.ts) for
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
