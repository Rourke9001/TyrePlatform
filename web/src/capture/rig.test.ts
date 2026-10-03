import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { cellKey } from "./draft";
import { completenessByUnit, nextOutstanding, rigPositions } from "./rig";

const position = (
  over: Partial<CapturePosition> & { id: string; sequence: number },
): CapturePosition => ({
  vehicleId: "v",
  code: String(over.sequence),
  axleClass: "DRIVE",
  axleType: "FIXED",
  side: "LEFT",
  axleNumber: 1,
  isSpare: false,
  unitLabel: null,
  tyreId: null,
  tyreCode: null,
  previousGoverningMm: null,
  previousReadingAt: null,
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
  ...over,
});

const unit = (
  vehicleId: string,
  fleetNumber: string,
  positions: CapturePosition[],
): CaptureContext => ({
  vehicleId,
  fleetNumber,
  registration: null,
  unitKind: "HORSE",
  lastOdometerKm: null,
  lastOdometerAt: null,
  averageDailyKm: null,
  combination: null,
  positions: positions.map((p) => ({ ...p, vehicleId })),
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
    captureSpares: true,
  },
  cohortWearRateMmPerMonth: {},
});

const horse = unit("v-horse", "BAC039SP", [
  // Deliberately not in sequence order: the projection must sort by the
  // configuration's own sequence, not by the order the API returned, and a
  // fixture already in order cannot tell the two apart.
  position({ id: "hs", sequence: 99, isSpare: true, axleClass: "SPARE", side: null }),
  position({ id: "h2", sequence: 2, axleClass: "STEER" }),
  position({ id: "h1", sequence: 1, axleClass: "STEER" }),
]);

const link = unit("v-link", "BAC040SP", [
  position({ id: "l2", sequence: 2, axleClass: "TRAILER" }),
  position({ id: "l1", sequence: 1, axleClass: "TRAILER" }),
]);

// The second link of a superlink shares position ids with the first, since
// app.position belongs to a configuration, not a vehicle (BR-VEH-003):
// the ordinary shape of a three-unit rig, not a contrived one.
const link2 = unit("v-link2", "BAC041SP", [
  position({ id: "l1", sequence: 1, axleClass: "TRAILER" }),
  position({ id: "l2", sequence: 2, axleClass: "TRAILER" }),
]);

describe("rigPositions", () => {
  // FR-VEH-034 / BR-VEH-001: 1..n across member units, computed from member
  // order and each unit's own sequence. Never stored, never transmitted: the
  // payload names (vehicle_id, position_id) and this number is display only.
  it("numbers running positions continuously across member units", () => {
    const rig = rigPositions([horse, link]);
    const running = rig.filter((r) => !r.position.isSpare);
    expect(running.map((r) => r.displayNumber)).toEqual([1, 2, 3, 4]);
    expect(running.map((r) => r.position.id)).toEqual(["h1", "h2", "l1", "l2"]);
  });

  // Composition order is the whole projection: the same units in a different
  // order are a different rig and a different set of numbers.
  it("renumbers when the composition order changes", () => {
    const running = rigPositions([link, horse]).filter((r) => !r.position.isSpare);
    expect(running.map((r) => r.position.id)).toEqual(["l1", "l2", "h1", "h2"]);
    expect(running.map((r) => r.displayNumber)).toEqual([1, 2, 3, 4]);
    // The sharp end of FR-VEH-034: the same position carries a different
    // number under a different composition, which is why it is computed at
    // render, never stored.
    const inOneOrder = rigPositions([horse, link]).find((r) => r.position.id === "l1");
    const inTheOther = rigPositions([link, horse]).find((r) => r.position.id === "l1");
    expect(inOneOrder?.displayNumber).toBe(3);
    expect(inTheOther?.displayNumber).toBe(1);
  });

  // Spares carry no running number: they are not in the walk-around sequence
  // and BR-RPT-001/BR-RPT-007 treat them as a separate population entirely.
  it("gives a spare no running number", () => {
    const spare = rigPositions([horse, link]).find((r) => r.position.isSpare);
    expect(spare?.displayNumber).toBeNull();
  });

  it("keeps each position bound to the unit that owns it", () => {
    const rig = rigPositions([horse, link]);
    expect(rig.find((r) => r.position.id === "l1")?.context.fleetNumber).toBe("BAC040SP");
    expect(rig.find((r) => r.position.id === "l1")?.position.vehicleId).toBe("v-link");
  });

  it("handles a solo unit without inventing a rig", () => {
    const running = rigPositions([horse]).filter((r) => !r.position.isSpare);
    expect(running.map((r) => r.displayNumber)).toEqual([1, 2]);
    // displayNumber alone is [1, 2] whether or not rigPositions sorts by
    // sequence first; the horse fixture is deliberately out of order, so only
    // the id order tells a sorted result from an unsorted one.
    expect(running.map((r) => r.position.id)).toEqual(["h1", "h2"]);
  });
});

describe("completenessByUnit", () => {
  // FR-INS-065: per-unit as well as rig-wide, so a driver knows which unit
  // is short. Two units sharing every position id would otherwise let
  // one's readings count for the other's (BR-VEH-003).
  it("tells two units of the same configuration apart", () => {
    const rig = rigPositions([link, link2]);
    expect(new Set(rig.map((r) => r.key)).size).toBe(rig.length);
    expect(rig.filter((r) => r.position.id === "l1").map((r) => r.key)).toEqual([
      cellKey("v-link", "l1"),
      cellKey("v-link2", "l1"),
    ]);

    const done = new Set([cellKey("v-link", "l1"), cellKey("v-link", "l2")]);
    expect(completenessByUnit([link, link2], done, new Set())).toEqual([
      { vehicleId: "v-link", fleetNumber: "BAC040SP", done: 2, total: 2 },
      { vehicleId: "v-link2", fleetNumber: "BAC041SP", done: 0, total: 2 },
    ]);
  });

  it("reports progress for each member unit", () => {
    const done = new Set([
      cellKey("v-horse", "h1"),
      cellKey("v-horse", "hs"),
      cellKey("v-link", "l1"),
    ]);
    expect(completenessByUnit([horse, link], done, new Set())).toEqual([
      { vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 2, total: 3 },
      { vehicleId: "v-link", fleetNumber: "BAC040SP", done: 1, total: 2 },
    ]);
  });
});

describe("spares as tenant configuration and as observations (TYRE-155)", () => {
  const noSpares = (u: CaptureContext): CaptureContext => ({
    ...u,
    config: { ...u.config, captureSpares: false },
  });

  // Rule 5: a tenant that has switched spare capture off gets no spare cell
  // and no spare in the denominator. Nothing else about the walk changes.
  it("drops the spare cell when the tenant does not capture spares", () => {
    const cells = rigPositions([noSpares(horse), link]);
    expect(cells.map((r) => r.position.id)).toEqual(["h1", "h2", "l1", "l2"]);
    const [h] = completenessByUnit([noSpares(horse), link], new Set(), new Set());
    expect(h.total).toBe(2);
  });

  // FR-INS-066: a spare the unit does not carry leaves the denominator, so a
  // fully walked unit reads "all done" instead of "1 left" for ever.
  it("takes an absent spare out of the unit's total and reports the unit done", () => {
    const done = new Set([cellKey("v-horse", "h1"), cellKey("v-horse", "h2")]);
    const absent = new Set([cellKey("v-horse", "hs")]);
    const [h] = completenessByUnit([horse], done, absent);
    expect(h).toEqual({ vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 2, total: 2 });
  });

  it("does not count an absent spare as done on a unit that is not", () => {
    const absent = new Set([cellKey("v-horse", "hs")]);
    const [h] = completenessByUnit([horse], new Set(), absent);
    expect(h).toEqual({ vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 0, total: 2 });
  });
});

describe("nextOutstanding", () => {
  const rig = rigPositions([horse, link]);
  const at = (vehicleId: string, id: string) => cellKey(vehicleId, id);

  // NFR-USE-001. Finishing a position puts the driver in front of the next one
  // instead of back on the diagram to find it, which is the interaction the
  // prototype defines and the tap it saves on every one of a superlink's 27.
  it("goes forward to the next position still outstanding", () => {
    const done = new Set([at("v-horse", "h1")]);
    expect(nextOutstanding(rig, done, at("v-horse", "h1"))?.position.id).toBe("h2");
  });

  // Forward first, then wrap, in that order. A driver who left a seized wheel
  // for later should finish the walk and be brought back to it, not dragged
  // backwards after every position, so a plain "first outstanding" is wrong
  // even though it agrees with this one on the wrap itself.
  it("skips an earlier gap on the way forward and returns to it at the end", () => {
    const done = new Set([at("v-horse", "h2"), at("v-link", "l1")]);
    expect(nextOutstanding(rig, done, at("v-horse", "h2"))?.position.id).toBe("l2");
    const all = new Set([...done, at("v-link", "l2"), at("v-horse", "hs")]);
    expect(nextOutstanding(rig, all, at("v-horse", "hs"))?.position.id).toBe("h1");
  });

  // The spare sits last, where the diagram draws it, not at its own
  // sequence inside its unit: rigPositions puts the horse's spare before
  // the link's wheels.
  it("leaves the spares until after every running position", () => {
    const done = new Set([at("v-horse", "h1"), at("v-horse", "h2")]);
    expect(nextOutstanding(rig, done, at("v-horse", "h2"))?.position.id).toBe("l1");
    const running = new Set([...done, at("v-link", "l1"), at("v-link", "l2")]);
    expect(nextOutstanding(rig, running, at("v-link", "l2"))?.key).toBe(at("v-horse", "hs"));
  });

  // The defect this prevents: both links carry ids l1/l2 (app.position
  // belongs to a configuration, not a vehicle), so asking "is l1 done?"
  // would find the first link's l1 and skip the second link's wheels
  // entirely (BR-VEH-003, draft.cellKey).
  it("asks by cell, so a second unit of the same configuration is not skipped", () => {
    const superlink = rigPositions([link, link2]);
    const done = new Set([at("v-link", "l1"), at("v-link", "l2")]);
    expect(nextOutstanding(superlink, done, at("v-link", "l2"))?.key).toBe(at("v-link2", "l1"));
  });

  it("gives back nothing once every position is captured", () => {
    const done = new Set(rig.map((r) => r.key));
    expect(nextOutstanding(rig, done, at("v-link", "l2"))).toBeNull();
  });
});
