import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { actAs } from "./admin";
import { MELUSI_DRIVER, TENANT_BAC } from "./bac";

// TYRE-80's rule is Sandbox-only; BAC is the one documented exception (TYRE-208
// F5). capture.spec.ts submits into BAC because its driver, their assignment
// and the superlink live there, not in Sandbox's fixture. Nothing else may
// write to BAC: its rows are the Appendix E/J acceptance fixture.
export const HEADERS = { "X-Tenant-ID": TENANT_BAC, "X-User-ID": MELUSI_DRIVER };

export async function actAsDriver(page: Page): Promise<void> {
  await actAs(page, MELUSI_DRIVER, TENANT_BAC);
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
