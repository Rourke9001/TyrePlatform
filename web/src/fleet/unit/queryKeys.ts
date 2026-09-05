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

// Both keyed by unit id like unitFitmentsKey above. The schedule write
// invalidates the tasks key alone: it adds a task and changes nothing about
// who may capture the unit. What moves the drivers list is a rig change or a
// new assignment, neither of them made from this screen, so it is refetched
// on mount rather than held or invalidated from here.
export function unitDriversKey(unitId: string): QueryKey {
  return ["unit-drivers", unitId];
}

export function unitTasksKey(unitId: string): QueryKey {
  return ["unit-tasks", unitId];
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

// The fleet-wide open fitments (fleet/FitmentList.tsx), which every fitment
// write makes stale even though none of them is made from that screen: a fit,
// a removal or a rotation changes which positions are occupied, and a key
// that only the list itself named would leave it showing a fitment that has
// since been closed for as long as gcTime holds the entry.
export function openFitmentsKey(tenantKey: string): QueryKey {
  return ["open-fitments", tenantKey];
}

export function retreadJobsKey(tenantKey: string): QueryKey {
  return ["retread-jobs", tenantKey];
}

// Same reasoning as openFitmentsKey above: a status change or a descriptive
// edit changes what VehicleList shows.
export function vehiclesKey(tenantKey: string): QueryKey {
  return ["vehicles", tenantKey];
}

// Same reasoning as openFitmentsKey above: a create or an end changes what
// the Rigs screen shows (D5).
export function rigsKey(tenantKey: string): QueryKey {
  return ["rigs", tenantKey];
}
