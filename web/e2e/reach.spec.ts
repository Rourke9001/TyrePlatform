import { expect, test } from "@playwright/test";

import { actAsDriver, assignedVehicle } from "./driver";

// Runs on every project, unlike capture.spec.ts: a target clearing 44px on
// desktop says nothing about a gloved thumb on a phone. Nothing here writes
// server-side, so it stays safe in parallel.
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
  // position, 27 times on a superlink.
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
