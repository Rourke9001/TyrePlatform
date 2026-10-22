import { apiGet, apiPost } from "./client";

// Wire shapes of the inspection-task surface (TYRE-90, TYRE-326). UnitTask is
// a superset of DriverHome's inline task type; not widened for one consumer
// (U13).

// How the responsible driver holds the task: the trip that covers its unit,
// its own nomination, or the nomination of its rig's motive (FR-INS-053 as
// amended). Who it is, and whether anyone is, is app.task_driver_at's.
export type ResponsibleVia = "TRIP" | "NOMINATION" | "MOTIVE_NOMINATION";

export interface UnitTask {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
  escalated: boolean;
  responsibleUserId: string | null;
  responsibleDisplayName: string | null;
  responsibleVia: ResponsibleVia | null;
}

// Both optional: an omitted dueOn is the tenant's today, resolved
// server-side, never a browser-computed day (rule 6); an omitted nominee
// leaves the task to whoever holds the unit, or escalated.
export interface NewTask {
  dueOn?: string;
  nomineeUserId?: string;
}

// What the read answers, and who may ask, is api/internal/httpapi/tasks.go's.
export function fetchUnitTasks(unitId: string): Promise<UnitTask[]> {
  return apiGet<UnitTask[]>(`/api/vehicles/${unitId}/inspection-tasks`);
}

// FR-INS-051's write (api/internal/httpapi/tasks.go).
export function scheduleTask(unitId: string, body: NewTask): Promise<UnitTask> {
  return apiPost<UnitTask>(`/api/vehicles/${unitId}/inspection-tasks`, body);
}

// FR-INS-051 as amended: a driver for a task nobody holds, or a new one for
// a nominated task. Every rule is app.nominate_for_task's.
export function nominate(taskId: string, body: { userId: string }): Promise<UnitTask> {
  return apiPost<UnitTask>(`/api/inspection-tasks/${taskId}/nominations`, body);
}
