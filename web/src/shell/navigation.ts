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
  { to: "/", label: "Dashboard", capability: "ViewFleet" },
  { to: "/exceptions", label: "Exceptions", capability: "ViewFleet" },
  { to: "/fleet", label: "Units", capability: "ViewFleet" },
  { to: "/fleet/tyres", label: "Tyres", capability: "ManageAssets" },
  { to: "/fleet/tyres/receipts", label: "Receipts", capability: "ManageAssets" },
  { to: "/fleet/rigs", label: "Rigs", capability: "ViewFleet" },
  { to: "/fleet/fitments", label: "Fitments", capability: "ViewFleet" },
  { to: "/fleet/tyres/retreads", label: "Retreads", capability: "LogRetread" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
  { to: "/settings", label: "Fleet settings", capability: "ManageConfig" },
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

// ADR-0020's grouping of the same items, by path, so the labels and gates
// stay NAV_ITEMS's own. "My inspections" sits alone and unnamed, where the
// registry already puts it, for a manager who also captures.
export interface NavGroupSpec {
  readonly label?: string;
  readonly paths: readonly string[];
}

export const NAV_GROUPS: readonly NavGroupSpec[] = [
  { label: "Overview", paths: ["/", "/exceptions"] },
  {
    label: "Fleet",
    paths: [
      "/fleet",
      "/fleet/tyres",
      "/fleet/tyres/receipts",
      "/fleet/rigs",
      "/fleet/fitments",
      "/fleet/tyres/retreads",
    ],
  },
  { paths: ["/my"] },
  { label: "Organisation", paths: ["/settings", "/admin/units/new", "/admin/users/new"] },
];

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export function navGroupsFor(capabilities: string[]): NavGroup[] {
  const held = navItemsFor(capabilities);
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: held.filter((item) => group.paths.includes(item.to)),
  })).filter((group) => group.items.length > 0);
}
