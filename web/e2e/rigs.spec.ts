import { expect, test } from "@playwright/test";

import { actAsUser } from "./admin";
import {
  apiGet,
  apiPost,
  configFor,
  createUnit,
  posted,
  ACTOR,
  CONTROLLER,
  SANDBOX_DRIVER,
  type AxleConfiguration,
} from "./sandbox";

// TYRE-72's DoD (Jira). Sandbox Fleet, never BAC (TYRE-80); units created
// fresh (U14) since fitments.spec.ts disposes sbveh1 mid-suite. Serial.
test.describe.configure({ mode: "serial" });

// Chromium desktop only, gated on device not browserName: android's Pixel 7
// also reports chromium as its browser, so a browserName check alone would
// repeat this whole run of writes there. The config's testIgnore is the real
// gate; this restates the same intent from inside the file.
test.skip(
  ({ browserName, isMobile }) => browserName !== "chromium" || isMobile,
  "a writing spec runs on one project; this is the fleet screen, judged at desktop size",
);

// Unique per run: DR-003 refuses a reused fleet number, so a second run
// without a reseed still gets three fresh units (admin.spec.ts's idiom).
const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `R6H-${RUN}`;
const TRAILER_FLEET = `R6T-${RUN}`;
const OTHER_FLEET = `R6X-${RUN}`;
const DESCRIPTOR = "front";

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller sets a rig on Sandbox and the driver is offered it", async ({
  page,
  browser,
}) => {
  // The units and the assignment are setup, not the thing under test, so they
  // go through the API rather than through three more screens.
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const horseConfig = configFor(configs, "HORSE_6X4");
  const trailerConfig = configFor(configs, "TRAILER_2AXLE");

  const horseId = await createUnit(page, HORSE_FLEET, "HORSE", horseConfig);
  const trailerId = await createUnit(page, TRAILER_FLEET, "TRAILER", trailerConfig);
  const otherHorseId = await createUnit(page, OTHER_FLEET, "HORSE", horseConfig);

  // FR-AUT-005: the assignment on the motive is what lets the driver read the
  // rig at all (app.v_capture_vehicle unions the coupled units onto it).
  await apiPost(page, `/api/vehicles/${horseId}/drivers`, { userId: SANDBOX_DRIVER });

  // Scoped by the heading each table carries rather than by position: the two
  // tables differ only in the Until column, which is exactly what "open" and
  // "ended" mean here.
  const untilHeader = page.getByRole("columnheader", { name: "Until", exact: true });
  const openTable = page.getByRole("table").filter({ hasNot: untilHeader });
  const endedTable = page.getByRole("table").filter({ has: untilHeader });

  await page.goto("/fleet/rigs");
  await page.getByLabel("Motive unit", { exact: true }).selectOption({ label: HORSE_FLEET });
  await page.getByLabel("Trailer", { exact: true }).selectOption({ label: TRAILER_FLEET });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel(`Descriptor for ${TRAILER_FLEET}`).fill(DESCRIPTOR);
  // Left as it mounts: browser "today" is not the tenant's (rule 6,
  // docs/lessons.md 2026-09-03).
  await expect(page.getByLabel("Effective from", { exact: true })).toHaveValue("");
  await Promise.all([
    posted(page, /^\/api\/combinations$/),
    page.getByRole("button", { name: "Set rig", exact: true }).click(),
  ]);

  // RigForm's success line stays for the life of the screen, so both status
  // lines are matched by their text rather than by being the only one.
  await expect(
    page.getByRole("status").filter({ hasText: `Rig set for ${HORSE_FLEET}.` }),
  ).toBeVisible();
  const openRow = openTable.getByRole("row").filter({ hasText: HORSE_FLEET });
  // The Motive cell is a <th scope="row">, so the first "cell" is the train.
  await expect(openRow.getByRole("cell").first()).toHaveText(
    `${HORSE_FLEET} › ${TRAILER_FLEET} (${DESCRIPTOR})`,
  );

  // INV-4, client side: RigForm narrows the trailer list by open-rig
  // membership. toHaveCount(0)'s own retry re-reads the option list until the
  // vehicles query settles, rather than trusting the state right after select
  // fires.
  await page.getByLabel("Motive unit", { exact: true }).selectOption({ label: OTHER_FLEET });
  await expect(
    page.getByLabel("Trailer", { exact: true }).getByRole("option", { name: TRAILER_FLEET }),
  ).toHaveCount(0);

  // Then the rule itself, which the client narrowing only hides: the trigger
  // app.combination_member_in_order refuses the raw write and names the rig
  // to end (000037; suite section 45b pins the same sentence).
  const refused = await page.request.post("/api/combinations", {
    headers: ACTOR,
    data: { motiveVehicleId: otherHorseId, towed: [{ vehicleId: trailerId }] },
  });
  expect(refused.status()).toBe(422);
  const refusal = (await refused.json()) as { code: string; message: string };
  expect(refusal.code).toBe("TY017");
  expect(refusal.message).toBe(
    `${TRAILER_FLEET} is in the rig headed by ${HORSE_FLEET}; end that rig first`,
  );

  // FR-INS-062. Fresh context, not `page`: actAsUser re-stamps on every
  // navigation (admin.ts actAs).
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, SANDBOX_DRIVER);
  await driverPage.goto(`/capture/${horseId}`);
  await expect(driverPage.getByRole("heading", { name: HORSE_FLEET })).toBeVisible();
  const yourRig = driverPage.getByRole("group", { name: "Your rig" });
  await expect(yourRig).toBeVisible();
  // The checkbox takes its accessible name from the label wrapping it, which
  // carries the descriptor as well as the fleet number, so this matches on
  // the fleet number as a substring, not exactly.
  await expect(yourRig.getByRole("checkbox", { name: TRAILER_FLEET })).toBeChecked();
  await driverContext.close();

  await Promise.all([
    posted(page, /^\/api\/combinations\/[^/]+\/end$/),
    openRow.getByRole("button", { name: "End rig", exact: true }).click(),
  ]);
  await expect(
    page.getByRole("status").filter({ hasText: `Rig ended for ${HORSE_FLEET}.` }),
  ).toBeVisible();
  const endedRow = endedTable.getByRole("row").filter({ hasText: HORSE_FLEET });
  await expect(endedRow.getByRole("cell").first()).toHaveText(
    `${HORSE_FLEET} › ${TRAILER_FLEET} (${DESCRIPTOR})`,
  );
  // Since, then Until. The tenant's own rendering of the date is
  // useTenantDate's (en-ZA), so what is asserted is that a date is there.
  await expect(endedRow.getByRole("cell").nth(2)).toHaveText(/\d{4}/);
  await expect(openTable.getByRole("row").filter({ hasText: HORSE_FLEET })).toHaveCount(0);

  // An ended rig is not a rig the capture offers: CaptureStart draws the
  // fieldset only for an open one. Asserted after the heading, so a page that
  // never rendered could not satisfy a count of zero.
  const afterContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const afterPage = await afterContext.newPage();
  await actAsUser(afterPage, SANDBOX_DRIVER);
  await afterPage.goto(`/capture/${horseId}`);
  await expect(afterPage.getByRole("heading", { name: HORSE_FLEET })).toBeVisible();
  await expect(afterPage.getByRole("group", { name: "Your rig" })).toHaveCount(0);
  await afterContext.close();
});
