import { expect, test, type Page } from "@playwright/test";

import { actAsDriver, assignedVehicle, HEADERS } from "./driver";
import { captureAll, capturePosition, done, startInspection, submit } from "./captureSteps";

// FR-INS-038's duplicate window is tenant state in one shared database: a
// second submit of the same vehicle is refused regardless of worker, so this
// file is serial and one-shot per seed. Thumb reach and target size are
// project-dependent and live in reach.spec.ts; the submit contract is not.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

// The failed-submit banner; scoped like done() in captureSteps.ts.
const failed = (page: Page) =>
  page
    .locator("main")
    .getByRole("alert")
    .filter({ has: page.getByRole("heading") });

interface CaptureContextBody {
  combination: { members: { vehicleId: string }[] } | null;
  positions: { previousGoverningMm: number | null }[];
  config: { removalThresholdMm: number };
}

test("a driver captures a whole vehicle, sees it confirmed, and agrees with the database", async ({
  page,
  request,
}) => {
  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id);

  // D-C: this test is the capture leg of the three-way agreement (one vehicle
  // at entry); the fleet-wide 19/11/9 leg is the dashboard's, not asserted
  // here. Capture the FIRST position below threshold and the rest above it:
  // all-below-or-all-above would make 0 === 0 pin nothing.
  const total = await captureAll(page, [["3"], ["3"], ["4"]]);

  await page.getByRole("button", { name: /review and submit/i }).click();
  // Keyed on the code, which CaptureReview carries as a data attribute because
  // CR-010 keeps it out of the driver-facing wording. Scoped that way it also
  // cannot pick up the per-unit tally rows, which are list items too.
  const flagged = await page.locator("[data-warning-code='FR-INS-036']").count();
  // Asserted, not merely compared below: a matcher that has gone dead counts
  // zero, and zero would agree with a database that also found nothing.
  expect(flagged).toBe(1);
  await page.getByRole("button", { name: /submit inspection/i }).click();

  // NFR-USE-010: stated, not inferred from the absence of an error.
  await expect(done(page)).toContainText(/sent|recorded/i);

  // Re-read the context the way the dashboard will. previousGoverningMm is now
  // the reading just submitted, so this compares what the app flagged against
  // what the database holds, not the app against itself.
  const res = await request.get(`/api/capture/vehicles/${horse.id}`, { headers: HEADERS });
  const ctx = (await res.json()) as CaptureContextBody;
  const below = ctx.positions.filter(
    (p) => p.previousGoverningMm !== null && p.previousGoverningMm <= ctx.config.removalThresholdMm,
  ).length;

  expect(below).toBe(flagged);
  expect(total).toBe(ctx.positions.length);
});

test("capture continues with the network cut and syncs on reconnect", async ({
  page,
  context,
  request,
}) => {
  const link = await assignedVehicle(request, "LINK12");
  await startInspection(page, link.id);

  // FR-OFF-001: no connectivity at any point AFTER reference data has loaded.
  // Cut it here, not before. Starting requires the server (NFR-AVL-002).
  await context.setOffline(true);
  await captureAll(page);
  await submit(page);

  // FR-OFF-005 / FR-OFF-014: queued, safe, and said so.
  await expect(done(page)).toContainText(/saved|will send/i);
  await expect(page.getByText(/waiting to send/i)).toBeVisible();

  // FR-OFF-009 / FR-OFF-010: on reconnect, while the app is open.
  await context.setOffline(false);
  await page.getByRole("button", { name: /sync now/i }).click();
  await expect(page.getByText(/waiting to send/i)).toBeHidden();
});

test("an inspection survives a browser restart mid-capture", async ({ page, request }) => {
  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id);
  await page.locator("[data-position-id]").first().click();
  await capturePosition(page);
  await capturePosition(page);
  await capturePosition(page);

  // FR-OFF-006 / NFR-USE-011: a reload is a restart as far as the buffer is
  // concerned. The store is the source of truth, not React state.
  await page.reload();

  await expect(page.getByText(/3 of/i)).toBeVisible();
  // The readings themselves, not just the count: a resumed inspection that kept
  // its progress bar and lost its numbers would pass a weaker check.
  await page.locator("[data-position-id]").first().click();
  await expect(page.getByLabel(/Tread reading 1 of 3/)).toContainText("13");
});

test("a rig walks as one sequence and attributes every reading to its own unit", async ({
  page,
  context,
  request,
}) => {
  // FR-INS-060/061, BR-VEH-003: the driver sees a continuous 1..n across the
  // rig, but what is SENT is (vehicle_id, position_id) per unit; a leaked
  // projection would file every trailer's tyres against the horse.
  // Extended timeout: 29 cells of round trips exceeds the default 30s budget.
  // NFR-USE-001a's seven minutes is a target for a driver, not for this test.
  test.setTimeout(180_000);

  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id, "whole");

  // FR-INS-062: the composition a controller set, pre-ticked.
  const res = await request.get(`/api/capture/vehicles/${horse.id}`, { headers: HEADERS });
  const combination = ((await res.json()) as CaptureContextBody).combination;
  expect(combination?.members).toHaveLength(3);

  const total = await captureAll(page);
  // Pinned exactly (TYRE-173): a horse plus two links is 26 running positions
  // and one spare per unit, 29 cells. A halved configuration must fail here,
  // not pass a ">20".
  expect(total).toBe(29);

  // FR-VEH-034: count RUNNING positions only. Spares carry no rig number and
  // are drawn separately, so total includes one per unit and there is no
  // "Position 29".
  const running = await page.getByRole("button", { name: /^Position \d+,/ }).count();
  expect(running).toBe(26);
  await expect(page.getByRole("button", { name: /^Position 1,/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Position ${running},`) }),
  ).toBeVisible();

  // Cut the network to stop at the outbox rather than letting the submit go
  // through: reading the payload off a refusal would depend on which windows
  // earlier specs happened to consume.
  await context.setOffline(true);
  await submit(page);
  // The queue is written inside queueDraft's transaction; reading IndexedDB
  // before the outcome is on screen races it.
  await expect(done(page)).toContainText(/saved|will send/i);

  const queued = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tyre-capture");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise<unknown[]>((resolve) => {
      const all = db.transaction("outbox").objectStore("outbox").getAll();
      all.onsuccess = () => resolve(all.result);
    });
  });

  const payload = (queued as { payload: { readings: Record<string, unknown>[] } }[])[0].payload;
  const units = new Set(payload.readings.map((r) => r.vehicle_id as string));
  expect(units.size).toBe(combination?.members.length);
  for (const member of combination?.members ?? []) {
    expect(units.has(member.vehicleId)).toBe(true);
  }

  // BR-VEH-003 as amended by E2: never stored AND never transmitted. The regex
  // catches the two leak shapes; the wire contract is pinned key by key too.
  expect(JSON.stringify(payload)).not.toMatch(/rig_position|"sequence"/);
  expect(Object.keys(payload.readings[0]).sort()).toEqual([
    "damage_flag",
    "granularity_mm",
    "note",
    "position_id",
    "pressure_kpa",
    "pressure_temperature",
    "seconds",
    "treads",
    "tyre_id",
    "vehicle_id",
    "warnings",
  ]);
});

test("a second inspection inside the window is refused permanently", async ({ page, request }) => {
  // Depends on the first spec having submitted the horse (serial mode).
  // FR-INS-038 is about the VEHICLE and a wall-clock window, not this
  // browser; a replayed client_uuid is not a second inspection.
  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id);
  await captureAll(page);
  await submit(page);

  // FR-OFF-013: presented, named, and with something the driver can act on.
  await expect(failed(page)).toContainText(/already inspected/i);
  await expect(failed(page)).toContainText(/saved/i);

  // The outbox must NOT retry: a permanent refusal is not "waiting to send".
  await expect(page.getByText(/waiting to send/i)).toBeHidden();
  // The shell says the same thing outside the flow, so a driver who has walked
  // away still sees it. Scoped to role=status because the refusal screen
  // carries those words too, under role=alert.
  await expect(page.getByRole("status").getByText(/needs the office/i)).toBeVisible();
});
