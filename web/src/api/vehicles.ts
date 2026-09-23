import { apiGet } from "./client";

// Mirrors app.unit_kind. A union rather than string: the server refuses an
// unknown kind, and a form that can express one is a form that can send a
// request it knows will fail.
export type UnitKind = "HORSE" | "TRAILER" | "RIGID" | "LIGHT";

// Wire shape of GET /api/vehicles (api/internal/httpapi, fleetUnitJSON,
// U13). unitKind and status are what the rig form filters motive from towed
// and hides retired units with (D5); both are nullable/non-nullable exactly
// as the server projects them, never coerced to a default. POST
// /api/vehicles answers the same shape (ADR-0013 decision 9; api/admin.ts's
// CreatedUnit aliases it).
export interface Vehicle {
  id: string;
  fleetNumber: string;
  registration: string | null;
  unitKind: UnitKind | null;
  status: string;
}

export function fetchVehicles(): Promise<Vehicle[]> {
  return apiGet<Vehicle[]>("/api/vehicles");
}
