import { expect, test, type Locator, type Page } from "@playwright/test";

import { actAsDriver, assignedVehicle, HEADERS } from "./driver";

// FR-INS-038's duplicate window is tenant state in one shared database, so
// these cannot run in parallel: the second submit of a vehicle is refused by
// design, whichever worker gets there first. The refusal spec depends on the
// first spec having submitted HORSE, and serial mode makes that dependency
// explicit rather than accidental. Thumb reach and target size are the
// project-dependent half and live in reach.spec.ts; the submit contract is not.
//
// The same window makes this file one-shot per seed: a second run inside the
// configured hours is refused at the first spec, which is why `make e2e`
// reseeds before it starts.
test.describe.configure({ mode: "serial" });

// The 23/07 sheet's own first-position readings, so what lands in the database
// after a run is what a real inspection contained.
const TREADS = [
  ["1", "3"],
  ["1", "3"],
  ["1", "4"],
];
const PRESSURE = ["8", "0", "0"];

test.beforeEach(async ({ page }) => {
  await actAsDriver(page);
});

// Solo capture: untick every trailer the controller has coupled to this unit,
// so the specs that submit consume one unit's window rather than three.
// Unticking is FR-INS-063's observation and the server records it — which these
// specs also, incidentally, exercise.
async function startInspection(page: Page, vehicleId: string, rig: "solo" | "whole" = "solo") {
  await page.goto(`/capture/${vehicleId}`);
  const start = page.getByRole("button", { name: /start inspection/i });
  // NFR-AVL-002: the start screen renders only once the served context has
  // arrived, and the rig's checkboxes arrive with it. Counting them before then
  // finds none and starts the WHOLE rig — three windows consumed instead of
  // one, with nothing on screen to say so.
  await expect(start).toBeVisible();
  if (rig === "solo") {
    // getByRole's own disabled option, not filter({ hasNot }) — hasNot matches
    // DESCENDANTS, and an <input> has none, so the motive unit's own disabled
    // checkbox would be included and uncheck() would hang on it.
    for (const box of await page.getByRole("checkbox", { disabled: false }).all()) {
      if (await box.isChecked()) await box.uncheck();
    }
    await expect(page.getByRole("checkbox", { disabled: false, checked: true })).toHaveCount(0);
  }
  await start.click();
}

// A field advances itself 200ms after a digit no further digit could change
// (PositionSheet's hold); a field whose value can still grow never advances at
// all and needs the go key. Wait past the hold before deciding which case this
// is — a go press aimed at a field that has already advanced lands on the NEXT
// one and silently skips a reading.
async function advanceTo(page: Page, next: Locator) {
  try {
    await expect(next).toHaveAttribute("aria-current", "true", { timeout: 500 });
  } catch {
    await page.getByRole("button", { name: /next ›/i }).click();
    await expect(next).toHaveAttribute("aria-current", "true");
  }
}

// Typing straight through would pile every digit into field 1, where each one
// past the second overshoots the 35mm ceiling and restarts the buffer — a green
// run over corrupt data. Each field is entered and then confirmed live before
// the next one starts.
async function enterField(page: Page, digits: string[], next: Locator) {
  for (const d of digits) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  await advanceTo(page, next);
}

async function capturePosition(page: Page, index: number, treads: string[][] = TREADS) {
  await page.locator("[data-position-id]").nth(index).click();
  const field = (n: number) => page.getByLabel(`Tread reading ${n} of ${treads.length}`);
  await enterField(page, treads[0], field(2));
  await enterField(page, treads[1], field(3));
  await enterField(page, treads[2], page.getByLabel("Pressure"));
  for (const d of PRESSURE) {
    await page.getByRole("button", { name: d, exact: true }).click();
  }
  // One tap, not two: "Seen it ›" records the FR-INS-040 response and finishes
  // the position in the same press.
  await page.getByRole("button", { name: /done ›|seen it ›/i }).click();
}

async function captureAll(page: Page): Promise<number> {
  await expect(page.locator("[data-position-id]").first()).toBeVisible();
  const total = await page.locator("[data-position-id]").count();
  for (let i = 0; i < total; i++) await capturePosition(page, i);
  return total;
}

// CaptureDone is the only region in the flow that pairs a live role with a
// heading. Scoping on <main> alone is not enough: the shell's OutboxIndicator
// renders role=status above <main>, and inside it CaptureFlow's storage-fault
// banner, its two load-failure branches and every standing position warning all
// render bare role=alert. A storage fault coinciding with a refusal would then
// resolve two elements, and strict mode would report that as though the product
// had two errors rather than the spec two matches.
const done = (page: Page) =>
  page
    .locator("main")
    .getByRole("status")
    .filter({ has: page.getByRole("heading") });
const failed = (page: Page) =>
  page
    .locator("main")
    .getByRole("alert")
    .filter({ has: page.getByRole("heading") });

async function submit(page: Page) {
  await page.getByRole("button", { name: /review and submit/i }).click();
  await page.getByRole("button", { name: /submit inspection/i }).click();
}

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

  // Decision D-C: the capture app's leg of the three-way agreement is one
  // vehicle at the moment of entry. The fleet-wide 19/11/9 leg is the
  // dashboard's; do not assert it here.
  //
  // Capture the FIRST position below the threshold and the rest above it.
  // Capturing everything at 13/13/14 against a 4mm threshold makes both sides
  // of the comparison zero, and 0 === 0 pins nothing at all.
  await capturePosition(page, 0, [["3"], ["3"], ["4"]]);
  const total = await page.locator("[data-position-id]").count();
  for (let i = 1; i < total; i++) await capturePosition(page, i);

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
  // what the database holds — not the app against itself.
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
  // Cut it here, not before — starting requires the server (NFR-AVL-002).
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
  await capturePosition(page, 0);
  await capturePosition(page, 1);
  await capturePosition(page, 2);

  // FR-OFF-006 / NFR-USE-011: the flat-battery case, and the one a driver will
  // never forgive. A reload is a restart as far as the buffer is concerned —
  // the store is the source of truth, not React state.
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
  // FR-INS-060/061 and BR-VEH-003, which is the one that breaks silently. The
  // driver sees a continuous 1..n across the horse and both trailers; what is
  // SENT is (vehicle_id, position_id) per unit, and the rig number appears
  // nowhere. If the projection ever leaked into the payload, every trailer's
  // tyres would be filed against the horse.
  // Twenty-nine cells at roughly a second of browser round trips each. The
  // default 30s is a budget for a test; this one walks a whole superlink, and
  // NFR-USE-001a's seven minutes is the figure that governs a driver — not
  // this.
  test.setTimeout(180_000);

  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id, "whole");

  // FR-INS-062: the composition a controller set, pre-ticked.
  const res = await request.get(`/api/capture/vehicles/${horse.id}`, { headers: HEADERS });
  const combination = ((await res.json()) as CaptureContextBody).combination;
  expect(combination?.members).toHaveLength(3);

  const total = await captureAll(page);
  expect(total).toBeGreaterThan(20); // a superlink, not one unit

  // FR-VEH-034: continuous across member units, computed for the screen. Count
  // the RUNNING positions, not every cell — spares carry no rig number and are
  // drawn separately, so total includes one per unit and there is no
  // "Position 29".
  const running = await page.getByRole("button", { name: /^Position \d+,/ }).count();
  await expect(page.getByRole("button", { name: /^Position 1,/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: new RegExp(`^Position ${running},`) }),
  ).toBeVisible();

  // Stop at the outbox, and cut the network to make that literally true. The
  // alternative — letting the submit go and reading the payload off a refusal —
  // would make what this spec can assert depend on which windows the specs
  // before it happened to consume.
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
  // names the two shapes a leak would take and nothing legitimate in the
  // payload contains either, so it can fail — but only for those two names,
  // which is why the wire contract is pinned key by key as well.
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
  // Depends on the first spec having submitted the horse, which serial mode
  // guarantees. FR-INS-038 is about the VEHICLE and a wall-clock window, not
  // about this browser — and a replayed client_uuid is not a second inspection,
  // which is the distinction the whole outbox turns on.
  const horse = await assignedVehicle(request, "HORSE");
  await startInspection(page, horse.id);
  await captureAll(page);
  await submit(page);

  // FR-OFF-013: presented, named, and with something the driver can act on.
  await expect(failed(page)).toContainText(/already inspected/i);
  await expect(failed(page)).toContainText(/saved/i);

  // The outbox must NOT be retrying it — a permanent refusal is not "waiting to
  // send", and a phone hammering it helps nobody.
  await expect(page.getByText(/waiting to send/i)).toBeHidden();
  // The shell says the same thing outside the flow, so a driver who has walked
  // away still sees it. Scoped to role=status because the refusal screen
  // carries those words too, under role=alert.
  await expect(page.getByRole("status").getByText(/needs the office/i)).toBeVisible();
});
