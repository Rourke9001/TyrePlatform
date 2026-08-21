import { apiGet } from "./client";

// Wire shape of GET /api/vehicles (api/internal/httpapi).
export interface Vehicle {
  id: string;
  fleetNumber: string;
  registration: string | null;
}

export function fetchVehicles(): Promise<Vehicle[]> {
  return apiGet<Vehicle[]>("/api/vehicles");
}
