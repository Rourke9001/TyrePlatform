import type { QueryKey } from "@tanstack/react-query";

import type { DashboardParams, ExceptionsParams } from "../../api/dashboard";

// The fleet and dashboard screens' cache keys in one module: react-refresh's
// rule refuses a non-component export beside a component, and every form
// and refresh here invalidates keys it does not own the query for.

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

export function unitTasksKey(unitId: string): QueryKey {
  return ["unit-tasks", unitId];
}

// A trip write changes who holds the tasks of every unit it covers, so the
// trip panel invalidates every unit's tasks, not one.
export function unitTasksPrefix(): QueryKey {
  return ["unit-tasks"];
}

export function unitTripKey(unitId: string): QueryKey {
  return ["unit-trip", unitId];
}

// A start or an end changes the motive's panel and each of its trailers'.
export function unitTripsPrefix(): QueryKey {
  return ["unit-trip"];
}

// The driver picker names who is on a trip, so a trip write makes it stale.
export function driversKey(tenantKey: string): QueryKey {
  return ["drivers", tenantKey];
}

// What holds a start (U148), keyed on the trailers the form would add. A new
// task, a task closing, a trip write or a rig write changes it; a nomination
// does not, since the read takes none into account.
export function tripBlockersKey(unitId: string, addTrailers: string[]): QueryKey {
  return ["trip-blockers", unitId, addTrailers];
}

export function tripBlockersPrefix(): QueryKey {
  return ["trip-blockers"];
}

// A prefix, not a whole key: TyreList carries its filter object as a third
// element, and invalidating the prefix reaches that query and this
// screen's stock read together.
export function tyresKey(tenantKey: string): QueryKey {
  return ["tyres", tenantKey];
}

// The receive form's pickers (TYRE-318). No screen writes the catalogue yet
// (TYRE-417), so nothing invalidates it.
export function tyreCatalogueKey(tenantKey: string): QueryKey {
  return ["tyre-catalogue", tenantKey];
}

// The receive form's price list estimate (TYRE-283), keyed on everything
// the match reads, so a change of any of them reads it again.
export function priceEstimateKey(
  tenantKey: string,
  sizeId: string,
  patternId: string,
  brandId: string,
  receivedDate: string,
): QueryKey {
  return ["price-estimate", tenantKey, sizeId, patternId, brandId, receivedDate];
}

// The receipts still waiting for their price (TYRE-283), made stale by every
// move on one.
export function openReceiptsKey(tenantKey: string): QueryKey {
  return ["tyre-receipts", tenantKey, "open"];
}

// The read-only fleet settings page (TYRE-283). Nothing in the app writes a
// setting, so nothing invalidates it.
export function fleetSettingsKey(tenantKey: string): QueryKey {
  return ["fleet-settings", tenantKey];
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

// U17: the dashboard is one call whose parameters are part of its identity,
// so a different depot or period is a different query. The tenant prefix
// lets the refresh invalidate every variant at once (FR-DSH-013).
export function dashboardKey(tenantKey: string, params: DashboardParams = {}): QueryKey {
  return ["dashboard", tenantKey, params];
}

export function exceptionsKey(tenantKey: string, params: ExceptionsParams = {}): QueryKey {
  return ["exceptions", tenantKey, params];
}

export function atRiskKey(tenantKey: string, depot?: string): QueryKey {
  return ["at-risk", tenantKey, depot ?? null];
}

export function sparesKey(tenantKey: string, depot?: string): QueryKey {
  return ["spares", tenantKey, depot ?? null];
}
