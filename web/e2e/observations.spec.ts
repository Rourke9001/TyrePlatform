import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-75's definition of done, walked: a driver's capture reports a trailer
// uncoupled, and the controller turns that report into a dated rig change on
// /fleet/rigs. The offered rig closes, a new one opens without the trailer,
// and the trailer is free to be coupled elsewhere. The capture is submitted
// through POST /api/inspections as the driver rather than walked through the
// screens: the untick lives in capture.spec.ts, which runs on the android
// project alone with file-private helpers, and a copy of it here would be a
// second walk to keep true (tasks.spec.ts's precedent). started_at is the
// server's own instant for the rig, read back from the create; submitted_at is
// an instant compared to instants, not a tenant day, so a clock here is
// outside the 2026-09-03 lesson.
//
// Sandbox Fleet, never BAC: see admin.ts (TYRE-80). Every unit is created by
// this run rather than reused from the seed (U14).
//
// Serial, and Chromium desktop only gated on the device rather than on
// browserName. rigs.spec.ts carries why each is needed.
test.describe.configure({ mode: "serial" });

test.skip(
  ({ browserName, isMobile }) => browserName !== "chromium" || isMobile,
  "a writing spec runs on one project; this is the fleet screen, judged at desktop size",
);

const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `O6H-${RUN}`;
const KEPT_FLEET = `O6A-${RUN}`;
const DROPPED_FLEET = `O6B-${RUN}`;
const SPARE_HORSE_FLEET = `O6X-${RUN}`;

const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
const SANDBOX_DRIVER = "40f019ce-192e-92d1-5b15-2eb7b65369df";

const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };
const DRIVER_ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": SANDBOX_DRIVER };

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

test("a controller applies the difference a driver reported", async ({ page }) => {
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const horseConfig = configFor(configs, "HORSE_6X4");
  const trailerConfig = configFor(configs, "TRAILER_2AXLE");

  const horseId = await createUnit(page, HORSE_FLEET, "HORSE", horseConfig);
  const keptId = await createUnit(page, KEPT_FLEET, "TRAILER", trailerConfig);
  const droppedId = await createUnit(page, DROPPED_FLEET, "TRAILER", trailerConfig);
  const spareHorseId = await createUnit(page, SPARE_HORSE_FLEET, "HORSE", horseConfig);

  // FR-AUT-005: the assignment on the motive is what lets the driver capture
  // the rig at all (app.v_capture_vehicle unions the coupled units onto it).
  await apiPost(page, `/api/vehicles/${horseId}/drivers`, { userId: SANDBOX_DRIVER });

  // effectiveFrom is read back, not assumed: POST /api/combinations answers
  // combinationJSON (api/internal/httpapi/combinations.go), and the instant
  // the server stamped is what the capture below has to start at.
  const rig = (await apiPost(page, "/api/combinations", {
    motiveVehicleId: horseId,
    towed: [{ vehicleId: keptId }, { vehicleId: droppedId }],
  })) as { id: string; effectiveFrom: string };

  // Rule 5: the width of a capture is tenant configuration, read from the
  // context the driver was served rather than assumed. A running position,
  // never a spare. FR-CFG-013 gives a spare no pressure target and the
  // reading below carries one.
  const captureContext = (await apiGet(
    page,
    `/api/capture/vehicles/${horseId}`,
    DRIVER_ACTOR,
  )) as CaptureContext;
  const running = captureContext.positions.filter((p) => !p.isSpare);
  expect(running, `no running position on ${HORSE_FLEET}`).not.toHaveLength(0);
  const treadCount = captureContext.config.treadReadingCount;

  // The untick, on the wire: the driver confirmed the horse and one trailer.
  // 000041 raises exactly one FR-INS-063 warning against the offered rig.
  const submitted = await page.request.post("/api/inspections", {
    headers: DRIVER_ACTOR,
    data: {
      client_uuid: randomUUID(),
      vehicle_id: horseId,
      combination_id: rig.id,
      observed_member_vehicle_ids: [horseId, keptId],
      // The rig's own instant, read back from the server. A browser instant
      // would be accepted too, 000044 bounds the observed instant into
      // [rig.effective_from, received_at] rather than refusing outside it,
      // but the server's is kept for two reasons: it is one clock fewer in
      // the walk (lesson 2026-09-03), and it makes the outcome deterministic,
      // because the bound then lands exactly on the offered rig's own start
      // whatever this machine's clock reads. app.submit_inspection makes no
      // comparison between started_at and submitted_at (000041, checked
      // 8 Sep 2026), so the two clocks are never compared.
      started_at: rig.effectiveFrom,
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

  await page.goto("/fleet/rigs");
  const card = page
    .getByRole("listitem")
    .filter({ hasText: `was not coupled to ${HORSE_FLEET}'s rig` });
  await expect(card).toContainText(DROPPED_FLEET);
  await card.getByLabel("Note").fill("checked the yard");
  await Promise.all([
    posted(page, /^\/api\/combinations\/observations\/[^/]+\/apply$/),
    card.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);

  // The report leaves the list because it is resolved, not because the card
  // hid itself: the list re-fetches and the server omits a resolved report.
  await expect(card).toHaveCount(0);

  // The register underneath: one open rig on this horse, carrying the kept
  // trailer and not the dropped one.
  const untilHeader = page.getByRole("columnheader", { name: "Until", exact: true });
  const openTable = page.getByRole("table").filter({ hasNot: untilHeader });
  const openRow = openTable.getByRole("row").filter({ hasText: HORSE_FLEET });
  await expect(openRow.getByRole("cell").first()).toHaveText(`${HORSE_FLEET} › ${KEPT_FLEET}`);

  // The control the whole apply turns on: the dropped trailer is free, which
  // is only observable by coupling it somewhere else. Without this, the row
  // above would pass even if the old rig had never been ended.
  const freed = await page.request.post("/api/combinations", {
    headers: ACTOR,
    data: { motiveVehicleId: spareHorseId, towed: [{ vehicleId: droppedId }] },
  });
  expect(freed.status(), await freed.text()).toBe(201);
});
