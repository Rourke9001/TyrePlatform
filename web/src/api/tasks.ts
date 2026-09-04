import { apiGet, apiPost } from "./client";

// Wire shapes of the inspection-task surface (api/internal/httpapi/tasks.go —
// TYRE-90). UnitTask is a superset of DriverHome's own inline task type: a
// shared shape is not widened for one consumer (spec U13's reasoning),
// so the driver's list keeps its own type and stays untouched here.
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

// fetchUnitDrivers is FR-INS-053's chain, read as a list (spec U4): who may
// capture this unit, and through which assignment.
export function fetchUnitDrivers(unitId: string): Promise<UnitDriver[]> {
  return apiGet<UnitDriver[]>(`/api/vehicles/${unitId}/drivers`);
}

// fetchUnitTasks is the controller's read of one unit's open work (spec U2).
export function fetchUnitTasks(unitId: string): Promise<UnitTask[]> {
  return apiGet<UnitTask[]>(`/api/vehicles/${unitId}/inspection-tasks`);
}

// scheduleTask is FR-INS-051's write. dueOn omitted means the tenant's
// today, resolved by app.create_inspection_task in the tenant's own zone
// (rule 6) — this module carries the request verbatim rather than filling
// in a browser-computed day.
export function scheduleTask(unitId: string, body: NewTask): Promise<UnitTask> {
  return apiPost<UnitTask>(`/api/vehicles/${unitId}/inspection-tasks`, body);
}
