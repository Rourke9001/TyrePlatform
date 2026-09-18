import type { QueryKey } from "@tanstack/react-query";

// The unit screen's cache keys in one module: react-refresh's rule refuses
// a non-component export beside a component, and every form here
// invalidates keys it does not own the query for.

// admin/AddUnit.tsx's library read; kept here since that screen already
// imports vehiclesKey from this module (TYRE-260).
export function axleConfigurationsKey(tenantId: string): QueryKey {
  return ["axle-configurations", tenantId];
}

export function unitKey(unitId: string): QueryKey {
  return ["unit", unitId];
}

export function unitFitmentsKey(unitId: string): QueryKey {
  return ["unit-fitments", unitId];
}

// Both keyed by unit id. The schedule write invalidates only the tasks
// key; nothing here changes who may capture the unit.
export function unitDriversKey(unitId: string): QueryKey {
  return ["unit-drivers", unitId];
}

export function unitTasksKey(unitId: string): QueryKey {
  return ["unit-tasks", unitId];
}

// A prefix, not a whole key: TyreList carries its filter object as a third
// element, and invalidating the prefix reaches that query and this
// screen's stock read together.
export function tyresKey(tenantKey: string): QueryKey {
  return ["tyres", tenantKey];
}

export function depotsKey(tenantKey: string): QueryKey {
  return ["depots", tenantKey];
}

// The fleet-wide open fitments list (FitmentList.tsx), made stale by any
// fitment write even though none of them are made from that screen.
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

// Same reasoning as openFitmentsKey above: applying or dismissing a report
// changes what the Rigs screen shows, both this list and the register below
// it (D5, TYRE-75).
export function observationsKey(tenantKey: string): QueryKey {
  return ["observations", tenantKey];
}
