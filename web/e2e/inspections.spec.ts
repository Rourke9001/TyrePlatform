import { expect, test } from "@playwright/test";

import { actAsUser } from "./admin";
import {
  apiGet,
  configFor,
  createUnit,
  nominateSandboxDriver,
  postedResponse,
  submitMinimalInspection,
  CONTROLLER,
  DRIVER_ACTOR,
  type AxleConfiguration,
} from "./sandbox";

// TYRE-325: a manager reads a submitted inspection and voids it (FR-INS-012
// as amended, U248). Sandbox Fleet, never BAC (TYRE-80), on a unit this run
// creates. Serial, and Chromium desktop only (rigs.spec.ts says why).
test.describe.configure({ mode: "serial" });

test.skip(
  ({ browserName, isMobile }) => browserName !== "chromium" || isMobile,
  "a writing spec runs on one project; this is the fleet screen, judged at desktop size",
);

// Unique per run: DR-003 refuses a reused fleet number.
const RUN = Date.now().toString().slice(-6);
const FLEET = `T325-${RUN}`;

// The capture context's positions carry their code as well (capture.go).
interface Context {
  positions: { id: string; code: string; isSpare: boolean }[];
  config: { treadReadingCount: number };
}

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller reads a submitted inspection and voids it", async ({ page }) => {
  // Setup through the API: the capture walk is capture.spec.ts's.
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const unitId = await createUnit(page, FLEET, "HORSE", configFor(configs, "HORSE_6X4"));
  const task = await nominateSandboxDriver(page, unitId);
  const context = (await apiGet(page, `/api/capture/vehicles/${unitId}`, DRIVER_ACTOR)) as Context;
  const running = context.positions.filter((p) => !p.isSpare);
  expect(running, `no running position on ${FLEET}`).not.toHaveLength(0);
  const submitted = await submitMinimalInspection(page, DRIVER_ACTOR, {
    vehicleId: unitId,
    positionId: running[0].id,
    treadCount: context.config.treadReadingCount,
    task_id: task.id,
    odometer_km: 1000,
  });
  expect(submitted.status(), await submitted.text()).toBe(201);

  // Exact: Playwright matches a name by substring, and the "Open
  // inspections" card would match too.
  await page.goto(`/fleet/units/${unitId}`);
  const list = page.getByRole("region", { name: "Inspections", exact: true });
  const row = list.getByRole("row").filter({ hasText: "Sandbox Driver" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Latest");
  await expect(row).toContainText("1,000 km");

  await row.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/fleet/units/${unitId}/inspections/[0-9a-f-]{36}$`));
  const readings = page.getByRole("region", { name: "Readings", exact: true });
  const reading = readings
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: running[0].code, exact: true }) });
  // submitMinimalInspection's treads start at 8.0 and rise, so 8.0 is the
  // stored minimum (CR-011).
  await expect(reading.getByRole("cell", { name: "8.0 mm", exact: true })).toBeVisible();
  await expect(reading).toContainText("800");

  await page.getByRole("button", { name: "Void inspection" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(FLEET);
  await dialog.getByRole("textbox", { name: "Reason" }).fill("e2e: wrong unit");
  const [voided] = await Promise.all([
    postedResponse(page, /^\/api\/inspections\/[^/]+\/void$/),
    dialog.getByRole("button", { name: "Void inspection" }).click(),
  ]);
  // A 204 carries no body to read.
  expect(voided.status()).toBe(204);
  await expect(page.getByText("Inspection voided.", { exact: false })).toBeVisible();
  await expect(page.getByText(/Reason: e2e: wrong unit\./)).toBeVisible();

  await page.goto(`/fleet/units/${unitId}`);
  const after = page
    .getByRole("region", { name: "Inspections", exact: true })
    .getByRole("row")
    .filter({ hasText: "Sandbox Driver" });
  await expect(after).toContainText("Voided");
  await expect(after).not.toContainText("Latest");
});
