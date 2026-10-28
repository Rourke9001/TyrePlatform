import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";

export interface MyTask {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
  // The unit the task is captured through: a coupled trailer's motive, so
  // the rig is captured whole. Optional: an API older than the web sends
  // none, and the task's own unit stands in.
  captureVehicleId?: string;
}

// The fields of GET /api/my/trip this screen renders, declared here rather
// than imported: api/trips.ts is the fleet screens' and stays out of the
// capture entry (web/CLAUDE.md, The design system).
export interface TripUnit {
  vehicleId: string;
  fleetNumber: string;
}

export interface MyTrip {
  trip: { motive: TripUnit; trailers: TripUnit[] } | null;
}

const tenantKey = () => getDevTenantId() ?? "default";

export function useMyTasks() {
  return useQuery({
    queryKey: ["my-tasks", tenantKey()],
    queryFn: () => apiGet<MyTask[]>("/api/my/tasks"),
  });
}

export function useMyTrip() {
  return useQuery({
    queryKey: ["my-trip", tenantKey()],
    queryFn: () => apiGet<MyTrip>("/api/my/trip"),
  });
}
