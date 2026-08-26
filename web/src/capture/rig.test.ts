import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { completenessByUnit, rigPositions } from "./rig";

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
    const solo = rigPositions([horse]);
    expect(solo.filter((r) => !r.position.isSpare).map((r) => r.displayNumber)).toEqual([1, 2]);
  });
});

describe("completenessByUnit", () => {
  // FR-INS-065: per member unit as well as for the rig. A driver who has
  // finished the horse and not the trailer needs to be told which, not a
  // single "18 of 26 done" that hides where the gap is.
  it("reports progress for each member unit", () => {
    const done = new Set(["h1", "hs", "l1"]);
    expect(completenessByUnit([horse, link], done)).toEqual([
      { vehicleId: "v-horse", fleetNumber: "BAC039SP", done: 2, total: 3 },
      { vehicleId: "v-link", fleetNumber: "BAC040SP", done: 1, total: 2 },
    ]);
  });
});
