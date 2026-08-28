import { expect, test } from "@playwright/test";

import { actAsOrgAdmin, actAsUser } from "./admin";

// TYRE-81's definition of done, as one path: an org admin builds a unit and a
// driver from nothing, assigns them, and that driver reaches a capture for
// the unit just built.
//
// Serial, and unique per run: these are writes into a shared database, and a
// fleet number or email reused across runs is refused by design (DR-003, D10).
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString().slice(-6);
const FLEET = `E2E-${RUN}`;
const EMAIL = `e2e-driver-${RUN}@example.invalid`;

test.beforeEach(async ({ page }) => {
  await actAsOrgAdmin(page);
});

test("an org admin can build a tenant from nothing", async ({ page, browser }) => {
  await page.goto("/admin/units/new");
  const [unitRes] = await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/vehicles" && res.request().method() === "POST",
    ),
    (async () => {
      await page.getByLabel(/fleet number/i).fill(FLEET);
      await page.getByLabel(/unit kind/i).selectOption("HORSE");
      await page.getByRole("button", { name: /add unit/i }).click();
    })(),
  ]);
  await expect(page.getByRole("status")).toContainText(FLEET);
  const vehicleId = ((await unitRes.json()) as { id: string }).id;

  await page.goto("/admin/users/new");
  const [userRes] = await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/users" && res.request().method() === "POST",
    ),
    (async () => {
      await page.getByLabel(/email/i).fill(EMAIL);
      await page.getByLabel(/name/i).fill(`E2E Driver ${RUN}`);
      await page.getByRole("button", { name: /add user/i }).click();
    })(),
  ]);
  await expect(page.getByRole("status")).toContainText("E2E Driver");
  const userId = ((await userRes.json()) as { id: string }).id;

  await page.getByLabel(/unit/i).selectOption({ label: FLEET });
  await page.getByRole("button", { name: /assign/i }).click();
  await expect(page.getByText(new RegExp(`assigned to ${FLEET}`, "i"))).toBeVisible();

  // The DoD's last clause: the assignment above is what lets this driver
  // reach a capture at all (FR-AUT-005, app.v_capture_vehicle). A fresh
  // context rather than `page`: actAsOrgAdmin's init script re-stamps the
  // org admin on every navigation, so a localStorage overwrite would not
  // survive the goto. A context made by hand takes none of the config's
  // `use` options, so baseURL is passed through explicitly.
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, userId);
  await driverPage.goto(`/capture/${vehicleId}`);
  // CaptureStart's own heading (src/capture/CaptureStart.tsx) names the unit
  // the driver was just assigned to.
  await expect(driverPage.getByRole("heading", { name: FLEET })).toBeVisible();
  await driverContext.close();
});
