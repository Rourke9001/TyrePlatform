import { expect, type APIRequestContext, type Page } from "@playwright/test";

// Shared by capture.spec.ts and reach.spec.ts rather than copied into each:
// these are seed-derived ids and one entry path, and a second copy would drift
// the moment the fixture's driver or its assignments change.
//
// Ids are md5-derived in db/seeds/gen_seed_fixture.py, so they are stable
// across reseeds. Identity is the dev actor headers (src/api/devTenant.ts),
// which exist only under import.meta.env.DEV — hence vite dev, never a build.
const DRIVER = "b85aef08-6081-80db-9d4d-dad38ae40545";
const TENANT = "11111111-1111-1111-1111-111111111111";

export const HEADERS = { "X-Tenant-ID": TENANT, "X-User-ID": DRIVER };

// The dev actor switcher reads these keys before anything renders, so seeding
// localStorage ahead of the first script is a real login as far as the app can
// tell.
export async function actAsDriver(page: Page): Promise<void> {
  await page.addInitScript(
    ([user, tenant]) => {
      window.localStorage.setItem("tyre.dev.user-id", user);
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
    },
    [DRIVER, TENANT],
  );
}

export interface AssignedVehicle {
  id: string;
  fleetNumber: string;
}

// The way into a capture. The fixture seeds no inspection_task rows — which is
// what smoke.spec.ts's "Nothing due." asserts — so DriverHome renders no link
// to follow and /my cannot be the entry point. FR-AUT-005 scopes this endpoint
// to the driver's own units, which makes it both the entry point and a check
// that the scope predicate still holds.
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
      `${fleetNumber} is not assigned to the seeded driver — got ${vehicles
        .map((v) => v.fleetNumber)
        .join(", ")}`,
    );
  }
  return found;
}
