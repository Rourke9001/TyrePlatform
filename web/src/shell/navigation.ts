// The one list. The menu renders it and the route guard reads the same
// capability strings, so a surface an actor cannot reach is never offered and
// the two cannot drift (NFR-SEC-006 — hiding is a courtesy, the server
// refuses regardless).
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
