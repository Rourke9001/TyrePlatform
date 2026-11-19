import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { fetchNow } from "../api/fetchNow";

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

// The fields of GET /api/my/trip DriverHome renders; api/trips.ts says why
// they are not imported.
export interface TripUnit {
  vehicleId: string;
  fleetNumber: string;
}

export interface MyTrip {
  trip: { motive: TripUnit; trailers: TripUnit[] } | null;
}

const tenantKey = () => getDevTenantId() ?? "default";

export const myTasksQuery = () => ({
  queryKey: ["my-tasks", tenantKey()],
  queryFn: () => apiGet<MyTask[]>("/api/my/tasks"),
});

export const myTripQuery = () => ({
  queryKey: ["my-trip", tenantKey()],
  queryFn: () => apiGet<MyTrip>("/api/my/trip"),
});

// The route error screen's escalated retry on /my (TYRE-340): both reads the
// page renders from.
export async function refreshDriverHome(client: QueryClient): Promise<void> {
  await Promise.all([fetchNow(client, myTasksQuery()), fetchNow(client, myTripQuery())]);
}

export function useMyTasks() {
  return useQuery(myTasksQuery());
}

export function useMyTrip() {
  return useQuery(myTripQuery());
}
