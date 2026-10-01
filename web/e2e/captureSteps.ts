import { expect, type Locator, type Page } from "@playwright/test";

// Shared by capture.spec.ts and auth.spec.ts, the way driver.ts is shared:
// specs never import each other (TYRE-80).

// The 23/07 sheet's own first-position readings, so what lands in the database
// after a run is what a real inspection contained.
export const TREADS = [
  ["1", "3"],
  ["1", "3"],
  ["1", "4"],
];
export const PRESSURE = ["8", "0", "0"];

// Solo capture: untick every coupled trailer so the submit specs consume one
// unit's window, not three. Unticking is FR-INS-063's observation, recorded
// by the server.
export async function startInspection(
  page: Page,
  vehicleId: string,
  rig: "solo" | "whole" = "solo",
) {
  await page.goto(`/capture/${vehicleId}`);
  const start = page.getByRole("button", { name: /start inspection/i });
  // NFR-AVL-002: the rig's checkboxes arrive with the served context. Counting
  // them before that resolves finds none and starts the WHOLE rig silently.
  await expect(start).toBeVisible();
  if (rig === "solo") {
    // getByRole's own disabled option, not filter({ hasNot }). hasNot matches
    // DESCENDANTS, and an <input> has none, so the motive unit's own disabled
    // checkbox would be included and uncheck() would hang on it.
    for (const box of await page.getByRole("checkbox", { disabled: false }).all()) {
      if (await box.isChecked()) await box.uncheck();
    }
    await expect(page.getByRole("checkbox", { disabled: false, checked: true })).toHaveCount(0);
  }
  await start.click();
}

// A field auto-advances 200ms after a digit that cannot grow further; one
// still growing needs the go key. A go press that lands after auto-advance
// skips the next reading silently.
export async function advanceTo(page: Page, next: Locator) {
  try {
    await expect(next).toHaveAttribute("aria-current", "true", { timeout: 500 });
  } catch {
    await page.getByRole("button", { name: /next ›/i }).click();
    await expect(next).toHaveAttribute("aria-current", "true");
  }
}

// Typing straight through piles every digit into field 1: past the second
// digit it overshoots the 35mm ceiling and restarts the buffer, a green run
// over corrupt data. Each field is confirmed live before the next starts.
export async function enterField(page: Page, digits: string[], next: Locator) {
  for (const d of digits) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  await advanceTo(page, next);
}

// The sheet for whichever position is open, named for that position (or, for
// a spare with no walk-around number, for the unit that owns it). Waiting on
// it by name distinguishes "the next position opened itself" from "nothing
// happened".
export const openSheet = (page: Page, named: string) => page.getByRole("region", { name: named });

// Enters the open position. A clean position closes itself off the pressure
// field; a warned one waits for the tap that records the FR-INS-040 response.
// That tap-per-warning is the arithmetic NFR-USE-001a's seven minutes rests
// on.
export async function capturePosition(page: Page, treads: string[][] = TREADS) {
  const named = await page
    .getByRole("region", { name: /^Position \d|^Spare, / })
    .getAttribute("aria-label");
  if (named === null) throw new Error("no position sheet is open");
  const field = (n: number) => page.getByLabel(`Tread reading ${n} of ${treads.length}`);
  await enterField(page, treads[0], field(2));
  await enterField(page, treads[1], field(3));
  await enterField(page, treads[2], page.getByLabel("Pressure"));
  for (const d of PRESSURE) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  // Poll for either outcome (closed, or "Seen it" appearing) to avoid a render
  // race; a fixed wait long enough for the hold would be paid on every warned
  // position.
  const sheet = openSheet(page, named);
  const answer = page.getByRole("button", { name: /seen it ›/i });
  await expect
    .poll(async () => (await sheet.count()) === 0 || (await answer.count()) > 0)
    .toBe(true);
  if ((await answer.count()) > 0) await answer.click();
  await expect(sheet).toBeHidden();
}

// Scoped to a heading, not just role, because OutboxIndicator and other
// banners also render role=status/alert under <main>; without the filter two
// elements can match and strict mode blames the product, not the spec.
export const done = (page: Page) =>
  page
    .locator("main")
    .getByRole("status")
    .filter({ has: page.getByRole("heading") });
export async function submit(page: Page) {
  await page.getByRole("button", { name: /review and submit/i }).click();
  await page.getByRole("button", { name: /submit inspection/i }).click();
}
