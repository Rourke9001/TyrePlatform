import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { actAs } from "./admin";

// Shared by capture.spec.ts and reach.spec.ts, not copied into each: a second
// copy would drift from the fixture's driver and its assignments.
// Seed-derived ids and dev actor headers, per admin.ts; the headers exist
// only under import.meta.env.DEV, hence vite dev, never a build.
const DRIVER = "b85aef08-6081-80db-9d4d-dad38ae40545";
// TYRE-80's rule is Sandbox-only; BAC is the one documented exception (TYRE-208
// F5). capture.spec.ts submits into BAC because its driver, their assignment
// and the superlink live there, not in Sandbox's fixture. Nothing else may
// write to BAC: its rows are the Appendix E/J acceptance fixture.
const TENANT = "11111111-1111-1111-1111-111111111111";

export const HEADERS = { "X-Tenant-ID": TENANT, "X-User-ID": DRIVER };

export async function actAsDriver(page: Page): Promise<void> {
  await actAs(page, DRIVER, TENANT);
}

export interface AssignedVehicle {
  id: string;
  fleetNumber: string;
}

// The only way into a capture: the fixture seeds no inspection_task rows, so
// /my has no link to follow. FR-AUT-005 scopes this endpoint to the driver's
// own units.
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
