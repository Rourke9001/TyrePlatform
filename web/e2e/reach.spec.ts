import { expect, test } from "@playwright/test";

import { actAsDriver, assignedVehicle } from "./driver";

// Unlike capture.spec.ts this runs on every project, which is what the mobile
// viewports exist for: a target that clears 44px on a desktop viewport says
// nothing about a gloved thumb on a phone. Nothing here submits or writes
// anything server-side — starting an inspection writes only to the browser's
// own storage — so it is safe in parallel and must stay that way.
test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

test("every capture target is thumb-sized", async ({ page, request }) => {
  const horse = await assignedVehicle(request, "HORSE");
  await page.goto(`/capture/${horse.id}`);
  await page.getByRole("button", { name: /start inspection/i }).click();
  await page.locator("[data-position-id]").first().click();

  // NFR-USE-004: gloves. 44px is the smallest a gloved thumb hits reliably, and
  // the go key is measured with the digits because it is pressed once per
  // position — 27 times on a superlink.
  const targets = [
    page.getByRole("button", { name: "1", exact: true }),
    page.getByRole("button", { name: "5", exact: true }),
    page.getByRole("button", { name: "0", exact: true }),
    page.getByRole("button", { name: /next ›|done ›|seen it ›/i }),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
});
