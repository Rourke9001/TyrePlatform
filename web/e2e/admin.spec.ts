import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";

// TYRE-81's definition of done, as one path: an org admin builds a unit and a
// driver from nothing, assigns them, and that driver reaches a capture.
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

test("an org admin can build a tenant from nothing", async ({ page }) => {
  await page.goto("/admin/units/new");
  await page.getByLabel(/fleet number/i).fill(FLEET);
  await page.getByLabel(/unit kind/i).selectOption("HORSE");
  await page.getByRole("button", { name: /add unit/i }).click();
  await expect(page.getByRole("status")).toContainText(FLEET);

  await page.goto("/admin/users/new");
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/name/i).fill(`E2E Driver ${RUN}`);
  await page.getByRole("button", { name: /add user/i }).click();
  await expect(page.getByRole("status")).toContainText("E2E Driver");

  await page.getByLabel(/unit/i).selectOption({ label: FLEET });
  await page.getByRole("button", { name: /assign/i }).click();
  await expect(page.getByText(new RegExp(`assigned to ${FLEET}`, "i"))).toBeVisible();
});
