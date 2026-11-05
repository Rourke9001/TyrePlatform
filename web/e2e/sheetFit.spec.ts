import { expect, test, type Locator } from "@playwright/test";

import { actAsDriver, assignedVehicle } from "./driver";

// A running position's four entry tiles (IR-UI-013, NFR-USE-004, TYRE-241)
// and its go key (TYRE-220) stay on a phone screen with no sideways scroll.
// Read-only on BAC, as reach.spec.ts is, because Sandbox's driver has no unit
// until a spec assigns one.
//
// innerWidth must equal the phone's width. Under Pixel 7 emulation a page
// wider than the phone widens the layout viewport and the fixed sheet with
// it, and every other check would then pass against the wider width.
test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

// iPhone 14's width, and the smallest supported phone (TYRE-220), taken as
// 360x780.
const PHONES = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];

// The capture tiles sit at 56 to 64px for gloves, above NFR-USE-004's 44px.
const GLOVE_PX = 56;

async function boxOf(target: Locator, what: string) {
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${what} has no box on screen`);
  return box;
}

for (const phone of PHONES) {
  test(`the entry tiles and the go key fit a ${phone.width}x${phone.height} phone`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(phone);
    const horse = await assignedVehicle(request, "HORSE");
    await page.goto(`/capture/${horse.id}`);
    await page.getByRole("button", { name: /start inspection/i }).click();
    await page.locator("[data-position-id]").first().click();
    // A running position. The glyph and hint take height a spare's sheet does not.
    await expect(page.getByText("Enter left to right, as seen from above.")).toBeVisible();
    // The spill check measures Atkinson. A fallback face has other metrics, and the tiles have a few px of room at 360.
    await page.evaluate(() => document.fonts.ready);

    expect(await page.evaluate(() => window.innerWidth)).toBe(phone.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      phone.width,
    );
    // The sheet scrolls in a fixed layer of its own, so sideways overflow
    // would scroll that layer and leave the document's width alone.
    const sheet = page.getByRole("region", { name: /^Position \d+$/ });
    const scrollsSideways = await sheet.evaluate((el) => {
      const found: string[] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth) found.push(node.tagName);
      }
      return found;
    });
    expect(scrollsSideways).toEqual([]);

    // IR-UI-013: every reading for the position on screen at once, in entry order.
    const tiles = [
      ...(await page.getByRole("button", { name: /^Tread reading \d+ of \d+$/ }).all()),
      page.getByRole("button", { name: "Pressure", exact: true }),
    ];
    expect(tiles).toHaveLength(4);
    let previousRight = 0;
    for (const tile of tiles) {
      const name = (await tile.getAttribute("aria-label")) ?? "a tile";
      const box = await boxOf(tile, name);
      expect(box.x, `${name} starts left of the tile before it`).toBeGreaterThanOrEqual(
        previousRight,
      );
      expect(box.x + box.width, `${name} runs off the phone`).toBeLessThanOrEqual(phone.width);
      expect(box.width, `${name} width`).toBeGreaterThanOrEqual(GLOVE_PX);
      expect(box.height, `${name} height`).toBeGreaterThanOrEqual(GLOVE_PX);
      // A row that fits only because a label spills inside its tile does not fit.
      expect(
        await tile.evaluate((el) => el.scrollWidth <= el.clientWidth),
        `${name} content overflows the tile`,
      ).toBe(true);
      previousRight = box.x + box.width;
    }

    // TYRE-220: pressed once per position, so it is on screen without a scroll.
    const go = await boxOf(
      page.getByRole("button", { name: /next ›|done ›|seen it ›/i }),
      "go key",
    );
    expect(go.x).toBeGreaterThanOrEqual(0);
    expect(go.y).toBeGreaterThanOrEqual(0);
    expect(go.x + go.width).toBeLessThanOrEqual(phone.width);
    expect(go.y + go.height).toBeLessThanOrEqual(phone.height);

    // The widest value a tile holds: FR-INS-031's 1200 kPa ceiling, grouped
    // to "1,200" (U55). scrollWidth misses a spill under a pixel, so the
    // value's box is held inside the tile's border.
    const pressure = page.getByRole("button", { name: "Pressure", exact: true });
    await pressure.click();
    for (const d of "1200") await page.getByRole("button", { name: d, exact: true }).click();
    await expect(pressure).toContainText("1,200");
    const spill = await pressure.evaluate((tile) => {
      const val = tile.querySelector(".tr-tread__val");
      if (val === null) return "no value";
      const t = tile.getBoundingClientRect();
      const v = val.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(tile).borderLeftWidth);
      return v.left >= t.left + border && v.right <= t.right - border ? null : "spills";
    });
    expect(spill, "1,200 inside the pressure tile").toBeNull();
  });
}

// WCAG 2.4.11: the sheet's layer covers the rig and the shell bars, so no
// Tab or Shift+Tab from inside it may land on a control it hides
// (CaptureFlow.tsx, ui/inertOutside.ts). Leaving the page is fine.
test("Tab and Shift+Tab never reach a control the open sheet hides", async ({ page, request }) => {
  await page.setViewportSize(PHONES[0]);
  const horse = await assignedVehicle(request, "HORSE");
  await page.goto(`/capture/${horse.id}`);
  await page.getByRole("button", { name: /start inspection/i }).click();
  await page.locator("[data-position-id]").first().click();
  const layer = page.locator(".cap-sheet-layer");
  await expect(layer).toBeVisible();

  const hidden = () =>
    page.evaluate(() => {
      const at = document.activeElement;
      const inLayer = document.querySelector(".cap-sheet-layer")?.contains(at) ?? false;
      return at === null || at === document.body || inLayer
        ? null
        : `${at.tagName} "${at.getAttribute("aria-label") ?? at.textContent ?? ""}"`;
    });
  await layer.getByRole("button").first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await hidden(), "Shift+Tab from the sheet's first control").toBeNull();
  await layer.getByRole("button").first().focus();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    expect(await hidden(), `Tab ${i + 1} from the sheet's first control`).toBeNull();
  }
});
