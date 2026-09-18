import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-90's DoD (Jira). Submitted via POST /api/inspections; the screen
// walk lives in capture.spec.ts (avoids a second one to keep true).
// started_at/submitted_at are instants (FR-INS-038), outside the
// 2026-09-03 lesson.
//
// Sandbox Fleet, never BAC (TYRE-80). The unit is created by this run, not
// reused from the seed (U14): fitments.spec.ts disposes sbveh1 mid-suite.
//
// Serial, and Chromium desktop only gated on the device rather than on
// browserName. rigs.spec.ts carries why each is needed.
test.describe.configure({ mode: "serial" });

test.skip(
  ({ browserName, isMobile }) => browserName !== "chromium" || isMobile,
  "a writing spec runs on one project; this is the fleet screen, judged at desktop size",
);

// Unique per run: DR-003 refuses a reused fleet number, so a second run
// without a reseed still gets a fresh unit (admin.spec.ts's idiom).
const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `T6H-${RUN}`;

// Seed-derived ids, per admin.ts: md5('sbcontroller1') holds ViewFleet,
// ManageAssets and ManageAssignments, and md5('sbdriver1') is the Sandbox
// driver this run schedules and then submits as.
const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
const SANDBOX_DRIVER = "40f019ce-192e-92d1-5b15-2eb7b65369df";

// The dev actor headers a raw request has to state itself (admin.ts). ACTOR
// and postedResponse are rigs.spec.ts's, restated here rather than exported
// from it. A spec is not a module other specs import.
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
// read rather than assumed. Only the codes the Sandbox seed plants are.
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
  // Left as it mounts (rule 6, docs/lessons.md 2026-09-03; rigs.spec.ts).
  await expect(schedule.getByLabel("Due", { exact: true })).toHaveValue("");
  const [scheduled] = await Promise.all([
    postedResponse(page, /^\/api\/vehicles\/[^/]+\/inspection-tasks$/),
    schedule.getByRole("button", { name: "Schedule inspection", exact: true }).click(),
  ]);
  expect(scheduled.ok(), await scheduled.text()).toBeTruthy();
  const task = (await scheduled.json()) as { id: string };

  // Due date is not asserted here: it renders through useTenantDate in the
  // tenant's locale, and pinning a month spelling would fail on the runner's
  // Intl data, not the behaviour (rule 6).
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

  // FR-INS-048. Fresh context, not `page`: actAsUser re-stamps on every
  // navigation (admin.ts actAs).
  const driverContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const driverPage = await driverContext.newPage();
  await actAsUser(driverPage, SANDBOX_DRIVER);
  await driverPage.goto("/my");
  const link = driverPage.getByRole("link", { name: new RegExp(`^${HORSE_FLEET}, due `) });
  await expect(link).toBeVisible();
  // A task scheduled for the tenant's today is due at the last microsecond of
  // that day, so it is not overdue. The word is the whole signal, never
  // colour (NFR-USE-009).
  await expect(link).not.toContainText("(overdue)");

  // FR-INS-052: the link is what carries the task into the capture, and the
  // id in the query string is the one the schedule just created. A capture
  // opened against another task would close the wrong one.
  await link.click();
  await expect(driverPage).toHaveURL(new RegExp(`/capture/${horseId}\\?taskId=${task.id}$`));
  await expect(driverPage.getByRole("heading", { name: HORSE_FLEET })).toBeVisible();

  // Rule 5, capture width (observations.spec.ts). A running position, never a
  // spare: FR-CFG-013 gives a spare no pressure target.
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
  // Checked against the API, not a rendered empty state: this run's task is
  // gone, specifically. The Sandbox driver is shared, so an empty-state claim
  // could otherwise be poisoned by another run's open task.
  const mine = (await apiGet(driverPage, "/api/my/tasks", DRIVER_ACTOR)) as { id: string }[];
  expect(mine.map((t) => t.id)).not.toContain(task.id);
  // The screen's own query must settle: DriverHome's heading renders outside
  // the pending/error/success branches, so waiting on one of those is what
  // makes the absent link a statement about a rendered list.
  await expect(
    driverPage.getByText("Nothing due.").or(driverPage.getByRole("listitem").first()),
  ).toBeVisible();
  await expect(
    driverPage.getByRole("link", { name: new RegExp(`^${HORSE_FLEET}, due `) }),
  ).toHaveCount(0);
  await driverContext.close();

  // The controller's side of the same close: the API agrees, not just the
  // screen. The unit is this run's own, so the empty state is about this
  // task, not poisoned by another run.
  await page.reload();
  await expect(page.getByText("No open inspections.")).toBeVisible();
  expect(await apiGet(page, `/api/vehicles/${horseId}/inspection-tasks`)).toEqual([]);
});
