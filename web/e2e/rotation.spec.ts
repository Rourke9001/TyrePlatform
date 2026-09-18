import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-101 (Jira). Sandbox Fleet, never BAC (TYRE-80); units, rig and
// tyres created fresh (U14), not reused (fitments.spec.ts disposes seeded
// units mid-suite).

// Unique per run: DR-003 refuses a reused fleet number, so a second run
// without a reseed still gets two fresh units (admin.spec.ts's idiom).
const RUN = Date.now().toString().slice(-6);
const HORSE_FLEET = `R3H-${RUN}`;
const TRAILER_FLEET = `R3T-${RUN}`;

// Seed-derived ids, per admin.ts: md5('sbcontroller1') holds ViewFleet and
// ManageAssets, which is every write this flow makes.
const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";

// The dev actor headers a raw request has to state itself (admin.ts). These
// helpers are fitments.spec.ts's and rigs.spec.ts's, restated here rather than
// exported from either. A spec is not a module other specs import.
const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };

function postedResponse(page: Page, path: RegExp) {
  return page.waitForResponse(
    (res) => path.test(new URL(res.url()).pathname) && res.request().method() === "POST",
  );
}

// Without the res.ok() check a step chained under this promise could pass on a
// 422 refusal as readily as on a real write (fitments.spec.ts).
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

interface Position {
  id: string;
  code: string;
  isSpare: boolean;
}

// A fleet's axle configurations are tenant data (FR-VEH-002), so the ids are
// read rather than assumed. Only the codes the Sandbox seed plants are
// (rigs.spec.ts).
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

// The mounted positions in the server's own order. Spares are excluded because
// a rotation onto one is a different flow (FR-FIT-010 moves running tyres), and
// which codes a unit carries is tenant data, so they are read rather than named.
async function mountedPositions(page: Page, unitId: string): Promise<Position[]> {
  const unit = (await apiGet(page, `/api/vehicles/${unitId}`)) as { positions: Position[] };
  const mounted = unit.positions.filter((p) => !p.isSpare);
  expect(mounted.length, `${unitId} has fewer than two mounted positions`).toBeGreaterThan(1);
  return mounted;
}

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller rotates a casing onto the trailer of its own rig", async ({ page }) => {
  // The units, the rig, the stock and the three fits are the setup this flow
  // rotates from, not the thing under test, so they go through the API rather
  // than through four more screens (rigs.spec.ts).
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const horseId = await createUnit(page, HORSE_FLEET, "HORSE", configFor(configs, "HORSE_6X4"));
  const trailerId = await createUnit(
    page,
    TRAILER_FLEET,
    "TRAILER",
    configFor(configs, "TRAILER_2AXLE"),
  );

  // effectiveOn omitted so app.tenant_day_instant resolves it in the
  // tenant's own zone, not the browser's (rule 6, docs/lessons.md 2026-09-03).
  await apiPost(page, "/api/combinations", {
    motiveVehicleId: horseId,
    towed: [{ vehicleId: trailerId }],
  });

  // Sandbox seeds no tyres. The codes are the platform's under a GENERATED
  // policy (D12), so they are captured rather than chosen.
  const stock = (await apiPost(page, "/api/tyres", { quantity: 3 })) as {
    tyres: { id: string; displayCode: string }[];
  };
  const [travelling, staying, onTrailer] = stock.tyres;

  const horsePositions = await mountedPositions(page, horseId);
  const trailerPositions = await mountedPositions(page, trailerId);
  const [horseFirst, horseSecond] = horsePositions;
  const [trailerOccupied, trailerTarget] = trailerPositions;

  // FR-FIT-002: 000025's trigger refuses an odometer write that disagrees
  // with the unit (horse records one, trailer does not). Orientation is
  // asserted, not left unknown, so the move below has a mounting fact to
  // carry (CHG-010).
  await apiPost(page, `/api/vehicles/${horseId}/fitments`, {
    tyreId: travelling.id,
    positionId: horseFirst.id,
    treadMm: "16",
    mountOrientation: "MARK_INBOARD",
    odometer: 250100,
  });
  await apiPost(page, `/api/vehicles/${horseId}/fitments`, {
    tyreId: staying.id,
    positionId: horseSecond.id,
    treadMm: "16",
    mountOrientation: "UNKNOWN",
    odometer: 250100,
  });
  await apiPost(page, `/api/vehicles/${trailerId}/fitments`, {
    tyreId: onTrailer.id,
    positionId: trailerOccupied.id,
    treadMm: "14",
    mountOrientation: "UNKNOWN",
  });

  await page.goto(`/fleet/units/${horseId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(HORSE_FLEET);
  // The unit screen names the open rig, which is what tells a controller that
  // the rotate form's unit column has somewhere to send a casing.
  await expect(page.getByRole("link", { name: TRAILER_FLEET })).toHaveAttribute(
    "href",
    "/fleet/rigs",
  );

  // One casing crosses to the trailer, the other takes the position it
  // leaves. Names matched exactly: a 6x4's codes run past 9, so a non-exact
  // match resolves two rows and fails strict mode (fitments.spec.ts).
  const rotate = page.getByRole("region", { name: "Rotate" });
  await rotate.getByRole("checkbox", { name: `Rotate ${horseFirst.code}`, exact: true }).check();
  await rotate.getByRole("checkbox", { name: `Rotate ${horseSecond.code}`, exact: true }).check();

  // The unit column exists only for a member of an open rig (U15), and the
  // target list is the destination unit's own empty positions (TYRE-127), so
  // the occupied trailer position must not be on offer.
  const unitPicker = rotate.getByRole("combobox", { name: `Unit for ${horseFirst.code}` });
  await expect(unitPicker).toBeVisible();
  await unitPicker.selectOption({ label: TRAILER_FLEET });
  const targetPicker = rotate.getByRole("combobox", {
    name: `Target for ${horseFirst.code}`,
    exact: true,
  });
  await expect(targetPicker.getByRole("option", { name: trailerOccupied.code })).toHaveCount(0);
  await targetPicker.selectOption(trailerTarget.id);

  // The position the first move vacates is offerable to the second: the
  // statement closes every row in the set before opening any (TYRE-127).
  await rotate
    .getByRole("combobox", { name: `Target for ${horseSecond.code}`, exact: true })
    .selectOption(horseFirst.id);

  await rotate.getByLabel(`Tread for ${horseFirst.code}`, { exact: true }).fill("15");
  await rotate.getByLabel(`Tread for ${horseSecond.code}`, { exact: true }).fill("15");
  // U20: the reading belongs to the unit, so the field names the unit it is
  // asked for, and the trailer, having no odometer, is asked for none.
  await expect(rotate.getByLabel(`Odometer for ${TRAILER_FLEET}`)).toHaveCount(0);
  await rotate.getByLabel(`Odometer for ${HORSE_FLEET}`).fill("251000");

  await Promise.all([
    posted(page, new RegExp(`^/api/vehicles/${horseId}/rotations$`)),
    rotate.getByRole("button", { name: "Rotate" }).click(),
  ]);
  await expect(rotate.getByText("The rotation was applied.", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("button", {
      name: `Position ${horseFirst.code}: ${staying.displayCode}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Position ${horseSecond.code}: empty`, exact: true }),
  ).toBeVisible();

  // Two legs closed as a rotation; the crossed casing has no open leg here,
  // only on the trailer. Keyed on the Reason cell, not row text
  // (fitments.spec.ts).
  const closedByRotation = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "rotation", exact: true }) });
  await expect(closedByRotation).toHaveCount(2);
  await expect(closedByRotation.filter({ hasText: travelling.displayCode })).toHaveCount(1);
  const stillFitted = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "Still fitted", exact: true }) });
  await expect(stillFitted.filter({ hasText: travelling.displayCode })).toHaveCount(0);
  await expect(stillFitted.filter({ hasText: staying.displayCode })).toHaveCount(1);

  // The other half of the same write, on the other unit: one statement closed a
  // fitment on the horse and opened one here (FR-FIT-010).
  await page.goto(`/fleet/units/${trailerId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(TRAILER_FLEET);
  await expect(page.getByRole("link", { name: HORSE_FLEET })).toHaveAttribute(
    "href",
    "/fleet/rigs",
  );
  await expect(
    page.getByRole("button", {
      name: `Position ${trailerTarget.code}: ${travelling.displayCode}`,
      exact: true,
    }),
  ).toBeVisible();

  const arrived = page.getByRole("row").filter({ hasText: travelling.displayCode });
  await expect(arrived).toHaveCount(1);
  await expect(arrived.getByRole("cell", { name: trailerTarget.code, exact: true })).toBeVisible();
  await expect(arrived.getByRole("cell", { name: "Still fitted", exact: true })).toBeVisible();
  // CHG-010: the mounting travels with the casing, not with the position, so
  // the leg the rotation opened on this unit carries what the horse's fit
  // asserted.
  await expect(arrived.getByRole("cell", { name: "Mark inboard", exact: true })).toBeVisible();
});
