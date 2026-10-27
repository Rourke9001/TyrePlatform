import { expect, test } from "@playwright/test";

import { startInspection } from "./captureSteps";
import { actAsDriver, assignedVehicle } from "./driver";

// A whole rig's tiles stay glove-sized with no sideways scroll on the
// smallest supported phone (NFR-USE-004, TYRE-220). Read-only on BAC, as
// sheetFit.spec.ts is: it starts an inspection and submits nothing.
test.skip(({ isMobile }) => !isMobile, "the rig is judged at phone width");

test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

const PHONE = { width: 360, height: 780 };

// The capture tiles sit at 56 to 64px for gloves, above NFR-USE-004's 44px.
const GLOVE_PX = 56;

test("every tile of the whole HORSE rig is glove-sized on a 360px phone", async ({
  page,
  request,
}) => {
  await page.setViewportSize(PHONE);
  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id, "whole");
  const tiles = page.locator("[data-position-id]");
  await expect(tiles.first()).toBeVisible();
  // Atkinson's metrics, not a fallback face's, decide whether a tile spills.
  await page.evaluate(() => document.fonts.ready);

  expect(await page.evaluate(() => window.innerWidth)).toBe(PHONE.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    PHONE.width,
  );

  const all = await tiles.all();
  expect(all.length).toBeGreaterThan(0);
  for (const tile of all) {
    const name = (await tile.getAttribute("aria-label")) ?? "a tile";
    await tile.scrollIntoViewIfNeeded();
    const box = await tile.boundingBox();
    if (box === null) throw new Error(`${name} has no box on screen`);
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(GLOVE_PX);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(GLOVE_PX);
    expect(box.x, `${name} starts off the phone`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} runs off the phone`).toBeLessThanOrEqual(PHONE.width);
  }
});
