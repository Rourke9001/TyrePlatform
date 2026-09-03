import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-72's definition of done, walked: a new tenant reaches a working rig
// capture without touching the fixture. The Sandbox controller builds a horse
// and two trailers-worth of units through the API, sets a rig on the Rigs
// screen, is refused a second rig naming the same trailer, and the driver
// assigned to the horse is offered that trailer on the capture start —
// pre-ticked. Ending the rig moves it to Ended rigs and the driver's capture
// stops offering it.
//
// Sandbox Fleet, never BAC: BAC's rows are the Appendix E/J acceptance
// fixture and a spec that couples its units changes what they reproduce
// (TYRE-80). The three units are created by this run rather than reused from
// the seed (U14) — playwright.config.ts is fullyParallel and fitments.spec.ts
// disposes sbveh1 mid-suite, so sharing a seeded unit would be an ordering
// dependency the config does not promise.
//
// Serial: every step reads what the step before it wrote, into one shared
// database.
test.describe.configure({ mode: "serial" });

// Chromium desktop only, and gated on the device rather than on browserName:
// the android project is devices["Pixel 7"], whose defaultBrowserType is
// "chromium" too, so a browserName test alone would let this whole run of
// writes repeat there. The config's own way of keeping a writing spec on one
// project is a testIgnore entry per project (capture/admin/tyres/fitments);
// this file cannot edit that, so it states the same intent from the inside.
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

// Ids are md5-derived in db/seeds/gen_seed_fixture.py, so they survive a
// reseed: md5('sbcontroller1') holds ViewFleet, ManageAssets and
// ManageAssignments, and md5('sbdriver1') is the Sandbox driver whose reach
// into a capture the last two steps read. admin.ts pins the org admin the
// same way, and the tenant uuid is the sandbox tenant's fixed one.
const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
const SANDBOX_DRIVER = "40f019ce-192e-92d1-5b15-2eb7b65369df";

// The dev actor headers the API resolves identity from (APP_DEV_TENANT_HEADER;
// src/api/devTenant.ts is the browser's half). A raw request carries no
// localStorage, so it has to state them itself. ACTOR, posted and
// postedRefusal are fitments.spec.ts's, restated here rather than exported
// from it — a spec is not a module other specs import.
const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };

function postedResponse(page: Page, path: RegExp) {
  return page.waitForResponse(
    (res) => path.test(new URL(res.url()).pathname) && res.request().method() === "POST",
  );
}

// Without the res.ok() check a step chained under this promise could pass on
// a 422 refusal as readily as on a real write (fitments.spec.ts).
function posted(page: Page, path: RegExp): Promise<unknown> {
  return postedResponse(page, path).then((res) => {
    expect(res.ok()).toBeTruthy();
    return res;
  });
}

async function apiGet(page: Page, path: string): Promise<unknown> {
  const res = await page.request.get(path, { headers: ACTOR });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

async function apiPost(page: Page, path: string, data: unknown): Promise<unknown> {
  const res = await page.request.post(path, { headers: ACTOR, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

interface AxleConfiguration {
  id: string;
  code: string;
}

// A fleet's axle configurations are tenant data (FR-VEH-002), so the ids are
// read rather than assumed — only the codes the Sandbox seed plants are.
function configFor(configs: AxleConfiguration[], code: string): string {
  const found = configs.filter((c) => c.code === code);
  expect(found, `no ${code} axle configuration in Sandbox Fleet`).not.toHaveLength(0);
  return found[0].id;
}

async function createUnit(
  page: Page,
  fleetNumber: string,
  unitKind: string,
  configurationId: string,
): Promise<string> {
  const created = (await apiPost(page, "/api/vehicles", {
    fleetNumber,
    unitKind,
    configurationId,
  })) as { id: string };
  return created.id;
}

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
  // The date input is left as it mounts. A browser's "today" is the viewer's
  // calendar day, not the fleet's (rule 6, lessons 2026-09-03): omitting
  // effectiveOn is what makes app.tenant_day_instant resolve it in the
  // tenant's own zone.
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

  // INV-4 twice over. First the client: RigForm narrows the trailer list by
  // open-rig membership, so a trailer already in an open rig is absent from
  // the list under any other motive. Selecting the other horse first is what
  // makes the count-of-zero meaningful — it proves the vehicle list has
  // reloaded, and the same locator found this trailer a few lines above.
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

  // FR-INS-062: the driver confirms the rig they were given. A fresh context
  // rather than `page` — actAsUser's init script re-stamps its actor on every
  // navigation, so an overwrite would not survive the goto — and a hand-made
  // context takes none of the config's `use` options, so baseURL is passed
  // through (admin.spec.ts).
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, SANDBOX_DRIVER);
  await driverPage.goto(`/capture/${horseId}`);
  await expect(driverPage.getByRole("heading", { name: HORSE_FLEET })).toBeVisible();
  const yourRig = driverPage.getByRole("group", { name: "Your rig" });
  await expect(yourRig).toBeVisible();
  // The checkbox takes its accessible name from the label wrapping it, which
  // carries the descriptor as well as the fleet number — so this matches on
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
