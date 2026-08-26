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
  readonly capability: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/fleet", label: "Vehicles", capability: "ViewFleet" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
] as const;

export function navItemsFor(capabilities: string[]): NavItem[] {
  const held = new Set(capabilities);
  return NAV_ITEMS.filter((item) => held.has(item.capability));
}
