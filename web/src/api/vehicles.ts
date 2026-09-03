import { apiGet } from "./client";
import type { UnitKind } from "./admin";

// Wire shape of GET /api/vehicles (api/internal/httpapi, fleetUnitJSON —
// U13). unitKind and status are what the rig form filters motive from towed
// and hides retired units with (D5); both are nullable/non-nullable exactly
// as the server projects them, never coerced to a default.
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
