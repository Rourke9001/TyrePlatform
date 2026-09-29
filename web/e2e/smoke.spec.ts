import { expect, test } from "@playwright/test";

import { actAs } from "./admin";
import { MELUSI_DRIVER, NOMSA_CONTROLLER, TENANT_BAC } from "./bac";

test("a controller lands on the dashboard and reaches the units from it", async ({ page }) => {
  await actAs(page, NOMSA_CONTROLLER, TENANT_BAC);
  await page.goto("/");
  // FR-DSH-001, U49: the dashboard is the landing, rendered at "/". The URL
  // is read once the page has rendered, so a redirect would have moved it.
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  // The API sends asAt with six fractional digits (Go's time.Time); this
  // project runs on WebKit too, where a Date that refused them would render
  // the invalid-instant marker (rule 6).
  const asAt = page.getByText(/^As at /);
  await expect(asAt).toBeVisible();
  await expect(asAt).not.toContainText("invalid date");
  // The dashboard has its own "Units" panel and a "Stale units" tile, so
  // the click is proved by the URL and the exact h1, not a loose name.
  await page.getByRole("link", { name: "Units", exact: true }).click();
  await expect(page).toHaveURL(/\/fleet$/);
  await expect(page.getByRole("heading", { level: 1, name: "Units", exact: true })).toBeVisible();
  await expect(page.getByText("HORSE", { exact: true }).first()).toBeVisible();
});

test("a driver lands on their own work, never the fleet", async ({ page }) => {
  await actAs(page, MELUSI_DRIVER, TENANT_BAC);
  await page.goto("/");
  // FR-DSH-012: a driver's landing view is their own outstanding work.
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.getByRole("heading", { name: "My inspections" })).toBeVisible();
  // The fixture seeds no inspection tasks, and an empty result renders as an
  // answer, never as an error (the fourth refusal layer is 200 []).
  await expect(page.getByText("Nothing due.")).toBeVisible();
});

test("the capability guard hides the fleet from a driver", async ({ page }) => {
  await actAs(page, MELUSI_DRIVER, TENANT_BAC);
  const settled = page.waitForResponse("**/api/me");
  await page.goto("/fleet");
  await settled;
  // RequireCapability renders nothing rather than an explanation; assert
  // after /api/me resolves so the count-0 cannot pass on an unrendered page.
  await expect(page.getByRole("heading", { name: "Units" })).toHaveCount(0);
});

test("the server, not the screen, is the control", async ({ request }) => {
  // NFR-SEC-006 / FR-AUT-005a: absence of a view is presentation; the
  // refusal must come from the API whatever the client renders. Requests go
  // through the same vite proxy the app uses.
  const asDriver = await request.get("/api/vehicles", {
    headers: { "X-Tenant-ID": TENANT_BAC, "X-User-ID": MELUSI_DRIVER },
  });
  expect(asDriver.status()).toBe(403);

  const asController = await request.get("/api/vehicles", {
    headers: { "X-Tenant-ID": TENANT_BAC, "X-User-ID": NOMSA_CONTROLLER },
  });
  expect(asController.status()).toBe(200);
  const vehicles = (await asController.json()) as { fleetNumber: string }[];
  expect(vehicles.length).toBeGreaterThan(0);
  expect(vehicles.map((v) => v.fleetNumber)).toContain("HORSE");
});
