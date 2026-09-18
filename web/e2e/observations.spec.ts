import { expect, test } from "@playwright/test";

import { actAsUser } from "./admin";
import {
  apiGet,
  apiPost,
  configFor,
  createUnit,
  posted,
  submitMinimalInspection,
  ACTOR,
  CONTROLLER,
  DRIVER_ACTOR,
  SANDBOX_DRIVER,
  type AxleConfiguration,
  type CaptureContext,
} from "./sandbox";

// TYRE-75's DoD (Jira). Submitted via POST /api/inspections, not walked
// through capture screens, to avoid a second walk (capture.spec.ts owns
// that; tasks.spec.ts precedent).
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

  // Rule 5: capture width is tenant configuration, read from the served
  // context. A running position, never a spare: FR-CFG-013 gives a spare no
  // pressure target, and this reading carries one.
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
  const submitted = await submitMinimalInspection(page, DRIVER_ACTOR, {
    vehicleId: horseId,
    positionId: running[0].id,
    treadCount,
    combination_id: rig.id,
    observed_member_vehicle_ids: [horseId, keptId],
    // The rig's own instant, not a browser one: one clock fewer (lesson
    // 2026-09-03) and deterministic, since 000044 bounds the observed
    // instant into [effective_from, received_at]. app.submit_inspection
    // never compares started_at to submitted_at (000041).
    started_at: rig.effectiveFrom,
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
