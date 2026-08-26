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
  combination: null,
  positions: positions.map((p) => ({ ...p, vehicleId })),
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
  },
  cohortWearRateMmPerMonth: {},
});

const horse = unit("v-horse", "BAC039SP", [
  // Deliberately not in sequence order: the projection must sort by the
  // configuration's own sequence, not by the order the API returned, and a
  // fixture already in order cannot tell the two apart.
  position({ id: "hs", sequence: 99, isSpare: true, axleClass: "SPARE" }),
  position({ id: "h2", sequence: 2, axleClass: "STEER" }),
  position({ id: "h1", sequence: 1, axleClass: "STEER" }),
]);

const link = unit("v-link", "BAC040SP", [
  position({ id: "l2", sequence: 2, axleClass: "TRAILER" }),
  position({ id: "l1", sequence: 1, axleClass: "TRAILER" }),
]);

// The second link of a superlink, on the SAME axle configuration as the first,
// so it carries the very same position ids. app.position belongs to a
// configuration and not to a vehicle, which makes this the ordinary shape of a
// three-unit rig rather than a contrived one.
const link2 = unit("v-link2", "BAC041SP", [
  position({ id: "l1", sequence: 1, axleClass: "TRAILER" }),
  position({ id: "l2", sequence: 2, axleClass: "TRAILER" }),
]);

describe("rigPositions", () => {
  // FR-VEH-034 / BR-VEH-001: 1..n across member units, computed from member
  // order and each unit's own sequence. Never stored, never transmitted — the
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
    // render and never stored.
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
  // FR-INS-065: per member unit as well as for the rig. A driver who has
  // finished the horse and not the trailer needs to be told which, not a
  // single "18 of 26 done" that hides where the gap is.
  // Two units sharing every position id: keyed by id alone one unit's readings
  // count for the other's, the rig submits fewer readings than the driver
  // entered, and nothing on screen says so (BR-VEH-003, and app.reading's
  // (inspection_id, position_id, vehicle_id) unique key).
  it("tells two units of the same configuration apart", () => {
    const rig = rigPositions([link, link2]);
    expect(new Set(rig.map((r) => r.key)).size).toBe(rig.length);
    expect(rig.filter((r) => r.position.id === "l1").map((r) => r.key)).toEqual([
      cellKey("v-link", "l1"),
      cellKey("v-link2", "l1"),
    ]);

    const done = new Set([cellKey("v-link", "l1"), cellKey("v-link", "l2")]);
    expect(completenessByUnit([link, link2], done)).toEqual([
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
    expect(completenessByUnit([horse, link], done)).toEqual([
      { vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 2, total: 3 },
      { vehicleId: "v-link", fleetNumber: "BAC040SP", done: 1, total: 2 },
    ]);
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

  // Forward first, then wrap — in that order. A driver who left a seized wheel
  // for later should finish the walk and be brought back to it, not dragged
  // backwards after every position, so a plain "first outstanding" is wrong
  // even though it agrees with this one on the wrap itself.
  it("skips an earlier gap on the way forward and returns to it at the end", () => {
    const done = new Set([at("v-horse", "h2"), at("v-link", "l1")]);
    expect(nextOutstanding(rig, done, at("v-horse", "h2"))?.position.id).toBe("l2");
    const all = new Set([...done, at("v-link", "l2"), at("v-horse", "hs")]);
    expect(nextOutstanding(rig, all, at("v-horse", "hs"))?.position.id).toBe("h1");
  });

  // The spare sits last, where the diagram draws it, not at its own sequence
  // inside the unit that owns it. rigPositions puts the horse's spare BEFORE
  // the link's wheels, so an order taken from it unchanged would send the
  // driver to the boot between two units.
  it("leaves the spares until after every running position", () => {
    const done = new Set([at("v-horse", "h1"), at("v-horse", "h2")]);
    expect(nextOutstanding(rig, done, at("v-horse", "h2"))?.position.id).toBe("l1");
    const running = new Set([...done, at("v-link", "l1"), at("v-link", "l2")]);
    expect(nextOutstanding(rig, running, at("v-link", "l2"))?.key).toBe(at("v-horse", "hs"));
  });

  // The defect this exists to prevent. Both links carry position ids l1 and l2
  // because app.position belongs to an axle configuration, so a search that
  // asked "is l1 done?" would find the first link's l1 and skip the second
  // link's wheels entirely — 8 positions filed nowhere, with nothing on screen
  // to say so (BR-VEH-003, draft.cellKey).
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
