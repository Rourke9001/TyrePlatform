import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";
import { SANDBOX_DRIVER } from "./sandbox";

// TYRE-154 (U243): the install hint on "My inspections". Sandbox Fleet, never
// BAC; nothing here writes server-side, so it is safe in parallel.
const KEY = "tyre.install-hint";
const GLOVE_PX = 56;
const STEPS = "Add this app to your Home Screen";
const BUTTON = "Install this app";

async function openMyInspections(page: Page) {
  await actAsUser(page, SANDBOX_DRIVER);
  await page.goto("/my");
  await expect(page.getByRole("heading", { name: "My inspections" })).toBeVisible();
  await expect(page.getByText("Loading…")).toHaveCount(0);
}

async function expectGloveHigh(page: Page, name: string) {
  const box = await page.getByRole("button", { name, exact: true }).boundingBox();
  if (box === null) throw new Error(`"${name}" has no box on screen`);
  expect(box.height, `"${name}" height`).toBeGreaterThanOrEqual(GLOVE_PX);
}

// Chrome's own event, as a page receives it; true when the app cancelled it.
function offerInstall(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: () => Promise.resolve(),
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test.describe("on an iPhone", () => {
  test.skip(({ browserName }) => browserName !== "webkit", "the steps are for iOS Safari");

  test("shows the steps once, and 'Got it' ends them for good", async ({ page }) => {
    // Playwright's WebKit is not iOS Safari, so the two signals the hint reads
    // are defined here (spec, Testing).
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "standalone", {
        get: () => false,
        configurable: true,
      });
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
        get: () => 5,
        configurable: true,
      });
    });
    await openMyInspections(page);

    const region = page.getByRole("status", { name: STEPS });
    await expect(region).toBeVisible();
    await expectGloveHigh(page, "Got it");

    await page.getByRole("button", { name: "Got it" }).click();

    await expect(region).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "My inspections" })).toBeFocused();

    await page.reload();
    await expect(page.getByRole("heading", { name: "My inspections" })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), KEY)).toBe("dismissed");
    await expect(page.getByRole("status", { name: STEPS })).toHaveCount(0);
  });
});

test.describe("on Android", () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== "chromium" || !isMobile,
    "the button is for Chrome on a phone",
  );

  test("offers Chrome's dialog from a button, and 'No thanks' ends it for good", async ({
    page,
  }) => {
    await openMyInspections(page);
    expect(await offerInstall(page)).toBe(true);

    const region = page.getByRole("status", { name: BUTTON });
    await expect(region).toBeVisible();
    await expectGloveHigh(page, "Install");
    await expectGloveHigh(page, "No thanks");

    await page.getByRole("button", { name: "No thanks" }).click();

    await expect(region).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "My inspections" })).toBeFocused();

    await page.reload();
    await expect(page.getByRole("heading", { name: "My inspections" })).toBeVisible();
    await expect(page.getByText("Loading…")).toHaveCount(0);
    expect(await offerInstall(page)).toBe(true);
    expect(await page.evaluate((k) => window.localStorage.getItem(k), KEY)).toBe("dismissed");
    await expect(page.getByRole("status", { name: BUTTON })).toHaveCount(0);

    // The listener is the entry's, so it runs on the capture route too.
    await page.goto("/capture/00000000-0000-4000-8000-000000000000");
    expect(await offerInstall(page)).toBe(true);
  });
});
