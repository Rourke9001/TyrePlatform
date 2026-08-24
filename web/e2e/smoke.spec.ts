import { expect, test } from "@playwright/test";

// Seed constants, not fetched: src/api/devTenant.ts carries the same ids for
// the same reason — a cross-tenant listing endpoint deliberately does not
// exist. Ids are md5-derived in db/seeds/gen_seed_fixture.py, so they are
// stable across reseeds.
const TENANT_BAC = "11111111-1111-1111-1111-111111111111";
const NOMSA_CONTROLLER = "14fc2c61-398c-3508-084e-d61e615e695e";
const MELUSI_DRIVER = "b85aef08-6081-80db-9d4d-dad38ae40545";

// The dev actor switcher reads these keys before anything renders, so
// seeding localStorage ahead of the first script is a real login as far as
// the app can tell.
async function actAs(page: import("@playwright/test").Page, userId: string) {
  await page.addInitScript(
    ([tenant, user]) => {
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
      window.localStorage.setItem("tyre.dev.user-id", user);
    },
    [TENANT_BAC, userId],
  );
}

test("a controller lands on the fleet and sees seeded vehicles", async ({ page }) => {
  await actAs(page, NOMSA_CONTROLLER);
  await page.goto("/");
  // FR-DSH-001: the landing view follows the role.
  await expect(page).toHaveURL(/\/fleet$/);
  await expect(page.getByRole("heading", { name: "Vehicles" })).toBeVisible();
  // Seeded fixture fleet numbers (db/seeds/gen_seed_fixture.py).
  await expect(page.getByText("HORSE", { exact: true }).first()).toBeVisible();
});

test("a driver lands on their own work, never the fleet", async ({ page }) => {
  await actAs(page, MELUSI_DRIVER);
  await page.goto("/");
  // FR-DSH-012: a driver's landing view is their own outstanding work.
  await expect(page).toHaveURL(/\/my$/);
  await expect(page.getByRole("heading", { name: "My inspections" })).toBeVisible();
  // The fixture seeds no inspection tasks, and an empty result renders as an
  // answer, never as an error (the fourth refusal layer is 200 []).
  await expect(page.getByText("Nothing due.")).toBeVisible();
});

test("the capability guard hides the fleet from a driver", async ({ page }) => {
  await actAs(page, MELUSI_DRIVER);
  const settled = page.waitForResponse("**/api/me");
  await page.goto("/fleet");
  await settled;
  // RequireCapability renders nothing rather than an explanation; assert
  // after /api/me resolves so the count-0 cannot pass on an unrendered page.
  await expect(page.getByRole("heading", { name: "Vehicles" })).toHaveCount(0);
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
