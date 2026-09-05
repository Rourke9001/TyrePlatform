import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-90's definition of done on Sandbox Fleet: a controller schedules the
// Sandbox driver on a unit this run creates; the driver's home lists it; the
// link opens the capture carrying the task; a submit closes it; both lists
// read empty. The capture itself is submitted through POST /api/inspections
// as the driver rather than walked through the screens: the walk lives in
// capture.spec.ts, which runs on the android project alone
// (playwright.config.ts testIgnore) with file-private helpers, and a copy of
// it here would be a second walk to keep true. This spec proves the task
// round trip; capture.spec.ts proves the walk. The payload is
// captureFixture's (capture_test.go): one reading on the unit's first
// position with the tenant's tread count, no odometer. started_at and
// submitted_at are instants compared to instants (FR-INS-038's window), not
// tenant days, so a clock here is outside the 2026-09-03 lesson.
//
// Sandbox Fleet, never BAC: BAC's rows are the Appendix E/J acceptance
// fixture and a spec that couples its units changes what they reproduce
// (TYRE-80). The unit is created by this run rather than reused from the
// seed (U14) — playwright.config.ts is fullyParallel and fitments.spec.ts
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
// without a reseed still gets a fresh unit (admin.spec.ts's idiom).
const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `T6H-${RUN}`;

// Ids are md5-derived in db/seeds/gen_seed_fixture.py, so they survive a
// reseed: md5('sbcontroller1') holds ViewFleet, ManageAssets and
// ManageAssignments, and md5('sbdriver1') is the Sandbox driver this run
// schedules and then submits as. admin.ts pins the org admin the same way,
// and the tenant uuid is the sandbox tenant's fixed one.
const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
const SANDBOX_DRIVER = "40f019ce-192e-92d1-5b15-2eb7b65369df";

// The dev actor headers the API resolves identity from (APP_DEV_TENANT_HEADER;
// src/api/devTenant.ts is the browser's half). A raw request carries no
// localStorage, so it has to state them itself. ACTOR and postedResponse are
// rigs.spec.ts's, restated here rather than exported from it — a spec is not
// a module other specs import.
const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };
const DRIVER_ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": SANDBOX_DRIVER };

function postedResponse(page: Page, path: RegExp) {
  return page.waitForResponse(
    (res) => path.test(new URL(res.url()).pathname) && res.request().method() === "POST",
  );
}

async function apiGet(page: Page, path: string, headers = ACTOR): Promise<unknown> {
  const res = await page.request.get(path, { headers });
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

interface CaptureContext {
  positions: { id: string; isSpare: boolean }[];
  config: { treadReadingCount: number };
}

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller schedules the Sandbox driver and the driver's submit closes the task", async ({
  page,
  browser,
}) => {
  // The unit and the assignment are setup, not the thing under test, so they
  // go through the API rather than through two more screens.
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const horseId = await createUnit(page, HORSE_FLEET, "HORSE", configFor(configs, "HORSE_6X4"));

  // FR-INS-053, spec U4: only a driver assigned to the unit can be scheduled
  // on it, so without this the form offers nobody.
  await apiPost(page, `/api/vehicles/${horseId}/drivers`, { userId: SANDBOX_DRIVER });

  await page.goto(`/fleet/units/${horseId}`);
  const schedule = page.getByRole("region", { name: "Schedule an inspection" });
  await schedule.getByLabel("Driver", { exact: true }).selectOption({ label: "Sandbox Driver" });
  // The date input is left as it mounts. A browser's "today" is the viewer's
  // calendar day, not the fleet's (rule 6, lessons 2026-09-03): omitting dueOn
  // is what makes the server resolve the due day in the tenant's own zone.
  await expect(schedule.getByLabel("Due", { exact: true })).toHaveValue("");
  const [scheduled] = await Promise.all([
    postedResponse(page, /^\/api\/vehicles\/[^/]+\/inspection-tasks$/),
    schedule.getByRole("button", { name: "Schedule inspection", exact: true }).click(),
  ]);
  expect(scheduled.ok(), await scheduled.text()).toBeTruthy();
  const task = (await scheduled.json()) as { id: string };

  // The due date itself is not asserted anywhere in this file: it is rendered
  // through useTenantDate in the tenant's locale, and pinning a month spelling
  // would make this spec fail on the runner's Intl data rather than on the
  // behaviour (rule 6).
  await expect(schedule.getByRole("status")).toHaveText(
    /Inspection scheduled for Sandbox Driver, due /,
  );

  // Scoped by the column heading only this table carries: the unit screen also
  // renders the fitment history as a table.
  const taskTable = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Driver", exact: true }) });
  const taskRow = taskTable.getByRole("row").filter({ hasText: "Sandbox Driver" });
  await expect(taskRow).toContainText("Open");

  // FR-INS-048: the driver's own landing view is the one place the task is
  // reachable from. A fresh context rather than `page` — actAsUser's init
  // script re-stamps its actor on every navigation, so an overwrite would not
  // survive the goto — and a hand-made context takes none of the config's
  // `use` options, so baseURL is passed through (admin.spec.ts).
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, SANDBOX_DRIVER);
  await driverPage.goto("/my");
  const link = driverPage.getByRole("link", { name: new RegExp(`^${HORSE_FLEET} — due `) });
  await expect(link).toBeVisible();
  // A task scheduled for the tenant's today is due at the last microsecond of
  // that day, so it is not overdue — the word is the whole signal, never
  // colour (NFR-USE-009).
  await expect(link).not.toContainText("(overdue)");

  // FR-INS-052: the link is what carries the task into the capture, and the
  // id in the query string is the one the schedule just created — a capture
  // opened against another task would close the wrong one.
  await link.click();
  await expect(driverPage).toHaveURL(new RegExp(`/capture/${horseId}\\?taskId=${task.id}$`));
  await expect(driverPage.getByRole("heading", { name: HORSE_FLEET })).toBeVisible();

  // Rule 5: the width of a capture is tenant configuration, so the payload
  // reads it from the context the driver was served rather than assuming
  // three. A running position, never a spare — FR-CFG-013 gives a spare no
  // pressure target and the reading below carries one.
  const captureContext = (await apiGet(
    driverPage,
    `/api/capture/vehicles/${horseId}`,
    DRIVER_ACTOR,
  )) as CaptureContext;
  const running = captureContext.positions.filter((p) => !p.isSpare);
  expect(running, `no running position on ${HORSE_FLEET}`).not.toHaveLength(0);
  const treadCount = captureContext.config.treadReadingCount;
  expect(typeof treadCount, "the tenant's configured tread_reading_count").toBe("number");

  const submitted = await driverPage.request.post("/api/inspections", {
    headers: DRIVER_ACTOR,
    data: {
      client_uuid: randomUUID(),
      vehicle_id: horseId,
      task_id: task.id,
      started_at: new Date(Date.now() - 120_000).toISOString(),
      submitted_at: new Date().toISOString(),
      duration_seconds: 120,
      readings: [
        {
          vehicle_id: horseId,
          position_id: running[0].id,
          tyre_id: null,
          pressure_kpa: 800,
          treads: Array.from({ length: treadCount }, (_, i) => 8 + i * 0.2),
        },
      ],
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(201);

  await driverPage.goto("/my");
  // This run's own task is gone, never "the driver has nothing" — the Sandbox
  // driver is shared, so an earlier run's open task would make the empty
  // state a claim about the tenant rather than about this close. The heading
  // is the positive control that the list rendered at all.
  await expect(driverPage.getByRole("heading", { name: "My inspections" })).toBeVisible();
  await expect(
    driverPage.getByRole("link", { name: new RegExp(`^${HORSE_FLEET} — due `) }),
  ).toHaveCount(0);
  await driverContext.close();

  // The controller's side of the same close: the task leaves the outstanding
  // work view, and the API it reads agrees rather than the screen having
  // merely dropped a row. The unit is this run's own, so its empty state is
  // a statement about this task and cannot be poisoned by another run.
  await page.reload();
  await expect(page.getByText("No open inspections.")).toBeVisible();
  expect(await apiGet(page, `/api/vehicles/${horseId}/inspection-tasks`)).toEqual([]);
});
