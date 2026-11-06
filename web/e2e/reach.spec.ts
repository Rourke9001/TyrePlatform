import { expect, test, type Locator } from "@playwright/test";

import { actAsDriver, assignedVehicle } from "./driver";

// Runs on every project, unlike capture.spec.ts: a target clearing 44px on
// desktop says nothing about a gloved thumb on a phone. Nothing here writes
// server-side, so it stays safe in parallel.
test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

// NFR-USE-004: 44px floors every control. The rig's card checkboxes and the
// bottom sheet's Close declare tokens.ts's glove target, 56px.
const FLOOR_PX = 44;
const GLOVE_PX = 56;

async function expectAtLeast(target: Locator, px: number, what: string) {
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${what} has no box on screen`);
  expect(box.height, `${what} height`).toBeGreaterThanOrEqual(px);
  expect(box.width, `${what} width`).toBeGreaterThanOrEqual(px);
}

test("every capture target is thumb-sized", async ({ page, request }) => {
  const horse = await assignedVehicle(request, "HORSE");
  await page.goto(`/capture/${horse.id}`);
  const start = page.getByRole("button", { name: /start inspection/i });
  // The rig's boxes arrive with the served context, so a count taken before
  // Start shows would find none (captureSteps.ts).
  await expect(start).toBeVisible();

  // The input is 1px and transparent (ui/Checkbox.css); the thumb's target
  // is the card label that wraps it.
  const boxes = await page.getByRole("group", { name: "Your rig" }).getByRole("checkbox").all();
  expect(boxes.length, "the HORSE heads a rig with boxes to tick").toBeGreaterThan(0);
  for (const box of boxes) {
    const card = box.locator("..");
    await expectAtLeast(card, GLOVE_PX, `rig box "${(await card.innerText()).trim()}"`);
  }

  await start.click();
  await page.locator("[data-position-id]").first().click();

  // The go key is measured with the digits because it is pressed once per
  // position, 27 times on a superlink.
  const keys = [
    page.getByRole("button", { name: "1", exact: true }),
    page.getByRole("button", { name: "5", exact: true }),
    page.getByRole("button", { name: "0", exact: true }),
    page.getByRole("button", { name: /next ›|done ›|seen it ›/i }),
  ];
  for (const key of keys) {
    await expectAtLeast(key, FLOOR_PX, `key "${await key.innerText()}"`);
  }

  // Scoped to the open position's sheet, so no other Close can answer.
  const close = page
    .getByRole("region", { name: /^Position \d+$/ })
    .getByRole("button", { name: "Close", exact: true });
  await expectAtLeast(close, GLOVE_PX, "the position sheet's Close");
});
