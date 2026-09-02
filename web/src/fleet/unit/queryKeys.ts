import type { QueryKey } from "@tanstack/react-query";

// The unit screen's cache keys in one module rather than beside the screen:
// react-refresh's only-export-components rule refuses a non-component export
// from a file that also exports a component, and every form on the screen
// invalidates keys it does not own the query for.

export function unitKey(unitId: string): QueryKey {
  return ["unit", unitId];
}

export function unitFitmentsKey(unitId: string): QueryKey {
  return ["unit-fitments", unitId];
}

// A prefix, not a whole key: TyreList's own query carries its filter object
// as a third element (fleet/tyres/TyreList.tsx), and invalidating the prefix
// reaches that query and this screen's stock read together. A key spelled to
// match only one of them would leave the other showing a tyre that has since
// been fitted.
export function tyresKey(tenantKey: string): QueryKey {
  return ["tyres", tenantKey];
}

export function depotsKey(tenantKey: string): QueryKey {
  return ["depots", tenantKey];
}
