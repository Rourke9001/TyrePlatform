import { expect, test } from "@playwright/test";

import { actAsUser } from "./admin";
import {
  apiGet,
  apiPost,
  configFor,
  createUnit,
  posted,
  CONTROLLER,
  TENANT,
  type AxleConfiguration,
} from "./sandbox";

// FR-VEH-007 as amended: a controller starts a trip on the unit screen, the
// driver's phone shows it, and the end takes the reach away while the rig
// stays coupled (spec, Starting and ending a trip).
//
// Sandbox Fleet, never BAC (TYRE-80). Every unit and the driver are this
// run's own, so no seeded trip or task decides the outcome, and the new units
// carry no task, so U148's start gate has nothing to hold.
//
// Serial, and Chromium desktop only, for the reasons tasks.spec.ts gives: a
// writing spec runs on one project, and this is the fleet screen, judged at
// desktop size.
test.describe.configure({ mode: "serial" });

test.skip(
  ({ browserName, isMobile }) => browserName !== "chromium" || isMobile,
  "a writing spec runs on one project; this is the fleet screen, judged at desktop size",
);

// Unique per run: DR-003 refuses a reused fleet number and D10 a reused
// email, so a second run without a reseed still gets fresh rows.
const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `P6H-${RUN}`;
const TRAILER_FLEET = `P6T-${RUN}`;
const DRIVER_NAME = `Trip Driver ${RUN}`;

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller starts and ends a trip, and the driver's phone follows it", async ({
  page,
  browser,
}) => {
  // The units and the driver are setup, not the thing under test, so they go
  // through the API rather than through three more screens.
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const horseId = await createUnit(page, HORSE_FLEET, "HORSE", configFor(configs, "HORSE_6X4"));
  const trailerId = await createUnit(
    page,
    TRAILER_FLEET,
    "TRAILER",
    configFor(configs, "TRAILER_2AXLE"),
  );
  const driver = (await apiPost(page, "/api/users", {
    email: `trip-driver-${RUN}@example.invalid`,
    displayName: DRIVER_NAME,
    role: "DRIVER",
  })) as { id: string };
  const driverHeaders = { "X-Tenant-ID": TENANT, "X-User-ID": driver.id };

  await page.goto(`/fleet/units/${horseId}`);
  const panel = page.getByRole("region", { name: "Trip", exact: true });
  await expect(panel.getByText("Not on a trip.")).toBeVisible();
  await panel.getByLabel("Driver", { exact: true }).selectOption(driver.id);
  await panel.getByLabel("Add a trailer", { exact: true }).selectOption({ label: TRAILER_FLEET });
  await panel.getByRole("button", { name: "Add", exact: true }).click();
  await Promise.all([
    posted(page, /^\/api\/trips$/),
    panel.getByRole("button", { name: "Start trip", exact: true }).click(),
  ]);
  await expect(panel.getByText(`Driver: ${DRIVER_NAME}`)).toBeVisible();
  await expect(panel.getByText(`Towing ${TRAILER_FLEET}`)).toBeVisible();

  // FR-DSH-012 and FR-AUT-005 as amended. Fresh context, not `page`:
  // actAsUser re-stamps on every navigation (admin.ts actAs).
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, driver.id);
  await driverPage.goto("/my");
  const yourTrip = driverPage.getByRole("region", { name: "Your trip" });
  await expect(yourTrip.getByRole("listitem")).toHaveText([HORSE_FLEET, TRAILER_FLEET]);
  const vehicles = (await apiGet(driverPage, "/api/my/vehicles", driverHeaders)) as {
    id: string;
  }[];
  expect(vehicles.map((v) => v.id).sort()).toEqual([horseId, trailerId].sort());

  // The end takes the driver off the unit and leaves the rig as it stands:
  // what is coupled to what is the rig register's, not the trip's.
  await Promise.all([
    posted(page, /^\/api\/trips\/[^/]+\/end$/),
    panel.getByRole("button", { name: "End trip", exact: true }).click(),
  ]);
  await expect(panel.getByText("Not on a trip.")).toBeVisible();
  const open = (await apiGet(page, "/api/combinations?open=true")) as {
    motiveVehicleId: string;
    members: { vehicleId: string }[];
  }[];
  const rig = open.find((r) => r.motiveVehicleId === horseId);
  expect(rig?.members.map((m) => m.vehicleId)).toContain(trailerId);

  await driverPage.reload();
  await expect(driverPage.getByText("You are not on a trip.")).toBeVisible();
  expect(await apiGet(driverPage, "/api/my/vehicles", driverHeaders)).toEqual([]);
  await driverContext.close();
});
