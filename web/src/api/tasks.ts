import { apiGet, apiPost } from "./client";

// Wire shapes of the inspection-task surface (api/internal/httpapi/tasks.go —
// TYRE-90). UnitTask is a superset of DriverHome's own inline task type: a
// shared shape is not widened for one consumer (spec U13's reasoning), so
// the driver's list keeps its own type.
export interface UnitDriver {
  userId: string;
  displayName: string;
  staffNumber: string | null;
  viaVehicleId: string;
  viaFleetNumber: string;
}

export interface UnitTask {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
  assignedUserId: string | null;
  assignedDisplayName: string | null;
}

export interface NewTask {
  assigneeUserId: string;
  dueOn?: string;
}

// What both reads answer, and who may ask, is api/internal/httpapi/tasks.go's.
export function fetchUnitDrivers(unitId: string): Promise<UnitDriver[]> {
  return apiGet<UnitDriver[]>(`/api/vehicles/${unitId}/drivers`);
}

export function fetchUnitTasks(unitId: string): Promise<UnitTask[]> {
  return apiGet<UnitTask[]>(`/api/vehicles/${unitId}/inspection-tasks`);
}

// scheduleTask is FR-INS-051's write. An omitted dueOn is the tenant's today,
// resolved server-side (api/internal/httpapi/tasks.go) — never a
// browser-computed day.
export function scheduleTask(unitId: string, body: NewTask): Promise<UnitTask> {
  return apiPost<UnitTask>(`/api/vehicles/${unitId}/inspection-tasks`, body);
}
