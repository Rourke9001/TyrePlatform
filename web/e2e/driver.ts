import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { actAs } from "./admin";
import { MELUSI_DRIVER, NOMSA_CONTROLLER, TENANT_BAC } from "./bac";

// Shared by capture.spec.ts and reach.spec.ts, not copied into each: a second
// copy would drift from the fixture's driver and its assignments.
// Seed-derived ids and dev actor headers, per admin.ts; the headers exist
// only under import.meta.env.DEV, hence vite dev, never a build.
//
// TYRE-80's rule is Sandbox-only; BAC is the one documented exception (TYRE-208
// F5). capture.spec.ts submits into BAC because its driver, their assignment
// and the superlink live there, not in Sandbox's fixture, and
// bacTasks.setup.ts plants the standing task every BAC capture opens through.
// Nothing else may write to BAC: its rows are the Appendix E/J acceptance
// fixture.
export const HEADERS = { "X-Tenant-ID": TENANT_BAC, "X-User-ID": MELUSI_DRIVER };
export const CONTROLLER_HEADERS = { "X-Tenant-ID": TENANT_BAC, "X-User-ID": NOMSA_CONTROLLER };

// A literal day no run reaches, so no tenant date comes from the browser or
// CI clock (docs/lessons.md, 2026-09-03), no submit's close of the day's
// tasks (U150) and no trip start's gate (U148) ever meets the task.
export const STANDING_DUE_ON = "2099-12-31";

export async function actAsDriver(page: Page): Promise<void> {
  await actAs(page, MELUSI_DRIVER, TENANT_BAC);
}

export interface AssignedVehicle {
  id: string;
  fleetNumber: string;
}

// FR-AUT-005 scopes this endpoint to the driver's own units. The way into a
// capture is a task (TYRE-319): the standing task below, or one a spec
// schedules.
//
// Selected by fleet number, never by index: the endpoint is ORDER BY
// fleet_number, so one added unit would silently repoint every spec and with it
// the FR-INS-038 window each one consumes.
export async function assignedVehicle(
  request: APIRequestContext,
  fleetNumber: string,
): Promise<AssignedVehicle> {
  const res = await request.get("/api/my/vehicles", { headers: HEADERS });
  expect(res.ok()).toBeTruthy();
  const vehicles = (await res.json()) as AssignedVehicle[];
  const found = vehicles.find((v) => v.fleetNumber === fleetNumber);
  if (!found) {
    throw new Error(
      `${fleetNumber} is not assigned to the seeded driver: got ${vehicles
        .map((v) => v.fleetNumber)
        .join(", ")}`,
    );
  }
  return found;
}

interface TaskRow {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
}

// BAC's driver's open task on HORSE, planted by bacTasks.setup.ts. A capture
// that never lands a submit opens through it, so it stays open for the run.
export async function standingTask(request: APIRequestContext): Promise<{ id: string }> {
  const res = await request.get("/api/my/tasks", { headers: HEADERS });
  expect(res.ok()).toBeTruthy();
  const tasks = (await res.json()) as TaskRow[];
  const found = tasks.find((t) => t.fleetNumber === "HORSE" && t.dueAt.startsWith(STANDING_DUE_ON));
  if (!found) {
    throw new Error(
      `the driver holds no task on HORSE due ${STANDING_DUE_ON}; bacTasks.setup.ts plants it`,
    );
  }
  return { id: found.id };
}

// A task due the tenant's today on a unit of the trip, which goes to the trip
// driver. For a capture whose submit lands and closes it.
export async function scheduleTask(
  request: APIRequestContext,
  unitId: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/vehicles/${unitId}/inspection-tasks`, {
    headers: CONTROLLER_HEADERS,
    data: {},
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}
