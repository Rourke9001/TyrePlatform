import { describe, expect, it } from "vitest";

import type { CaptureConfig, CapturePosition } from "./captureContext";
import {
  governingTread,
  isComplete,
  positionWarnings,
  severityFor,
  treadsRead,
  widthSpread,
} from "./warnings";

const config: CaptureConfig = {
  treadReadingCount: 3,
  treadGranularityMm: 1.0,
  widthSpreadWarnMm: 4,
  odometerMaxDailyKm: 1600,
  wearRateAlertMultiple: 3,
  removalThresholdMm: 4.0,
};

const steer: CapturePosition = {
  id: "p1",
  vehicleId: "v1",
  code: "1",
  sequence: 1,
  axleClass: "STEER",
  axleType: "FIXED",
  axleNumber: 1,
  isSpare: false,
  unitLabel: "Horse",
  tyreId: "t1",
  tyreCode: "BAC-04217",
  previousGoverningMm: 12,
  previousReadingAt: "2026-07-23T06:00:00Z",
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
};

const spare: CapturePosition = {
  ...steer,
  id: "p27",
  code: "S",
  isSpare: true,
  axleClass: "SPARE",
  axleNumber: null,
  targetKpa: null,
  warnUnderPct: null,
  criticalUnderPct: null,
  warnOverPct: null,
  criticalOverPct: null,
};

const codes = (ws: { code: string }[]) => ws.map((w) => w.code).sort();

describe("governingTread", () => {
  // BR-INS-003, and the client never sends it — the trigger derives it. This
  // exists so the driver sees the same number the database will store.
  it("is the minimum of the width-wise readings", () => {
    expect(governingTread([7.4, 7.1, 6.9])).toBe(6.9);
  });

  it("is null until every reading is entered", () => {
    expect(governingTread([7.4, null, 6.9])).toBeNull();
  });
});

describe("widthSpread", () => {
  it("is max minus min (BR-ANL-007)", () => {
    expect(widthSpread([15, 11, 15])).toBe(4);
  });
});

describe("positionWarnings", () => {
  it("raises nothing on a healthy position", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 800 }, steer, config);
    expect(w).toEqual([]);
  });

  // FR-INS-036 with BR-RPT-006's boundary: at the threshold is already a
  // problem, not the last safe millimetre.
  it("warns at the removal threshold, not one below it", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(codes(w)).toContain("FR-INS-036");
  });

  it("does not warn just above the threshold", () => {
    const w = positionWarnings({ treads: [5, 5, 6], pressureKpa: 800 }, steer, config);
    expect(codes(w)).not.toContain("FR-INS-036");
  });

  // FR-INS-041 with BR-ANL-007's boundary, and it must ask for a photograph.
  it("warns at the configured spread and prompts for a photograph", () => {
    const w = positionWarnings({ treads: [15, 11, 15], pressureKpa: 800 }, steer, config);
    const spread = w.find((x) => x.code === "FR-INS-041");
    expect(spread).toBeDefined();
    expect(spread?.promptPhoto).toBe(true);
  });

  // FR-INS-037: outside the warn band at 10% of an 800kPa target is <720 or
  // >880. Every number here comes from the payload; none is a literal in src.
  it("warns on a pressure outside the correct band", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 700 }, steer, config);
    expect(codes(w)).toContain("FR-INS-037");
  });

  // FR-INS-031a supersedes FR-INS-037 rather than stacking with it: at 20%
  // under, both rules are true, and showing a gloved driver two rows about
  // one number costs seconds the three-minute budget does not have.
  it("escalates to a confirmation instead of stacking two pressure warnings", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 600 }, steer, config);
    expect(codes(w)).toContain("FR-INS-031a");
    expect(codes(w)).not.toContain("FR-INS-037");
    expect(w.find((x) => x.code === "FR-INS-031a")?.requiresConfirmation).toBe(true);
  });

  // FR-CFG-013 as amended: SPARE carries no target. An unclassified spare
  // pressure is deliberate (BR-RPT-001, NFR-PRO-003) — inventing a band for
  // it would create a spare-pressure exception the SRS does not have.
  it("never raises a pressure warning on a spare", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 200 }, spare, config);
    expect(codes(w)).toEqual([]);
  });

  // BR-RPT-006 is the carve-out: spares are excluded from exception reports
  // by default, but a spare at threshold is the one that matters — it is the
  // vehicle's only replacement.
  it("still raises the tread warning on a spare", () => {
    const w = positionWarnings({ treads: [3, 4, 4], pressureKpa: 200 }, spare, config);
    expect(codes(w)).toEqual(["FR-INS-036"]);
  });

  it("raises nothing until the position is complete", () => {
    const w = positionWarnings({ treads: [3, null, null], pressureKpa: null }, steer, config);
    expect(w).toEqual([]);
  });

  // A position whose treads are read and whose pressure was never taken is a
  // designed case — 000023 accepts a NULL pressure and payload.ts sends the
  // reading — and the tread bands are final the moment the last reading is in.
  // Gating them on a pressure would hide FR-INS-036 on a position that may
  // never get one, on the diagram as well as here.
  it("raises the tread warning as soon as the treads are read, with no pressure", () => {
    const w = positionWarnings({ treads: [3, 4, 4], pressureKpa: null }, steer, config);
    expect(codes(w)).toEqual(["FR-INS-036"]);
  });

  // The other half of the same rule, and the half that keeps it honest: a
  // pressure band must never be asserted from a reading that does not exist.
  it("bands no pressure when no pressure was taken", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: null }, steer, config);
    expect(w).toEqual([]);
  });

  // FR-INS-040: the record needs the value that provoked the warning, not
  // just that one happened.
  it("carries the entered value that provoked it", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(w.find((x) => x.code === "FR-INS-036")?.enteredValue).toBe("4");
  });

  // Pressure boundary tests: target 800, warnUnderPct 10, criticalUnderPct 20,
  // warnOverPct 10, criticalOverPct 20. Boundaries are 720/640 under, 880/960
  // over. The operators (< vs >=) create asymmetry that must be pinned: the
  // database bands with strict inequality on the under side to match this.
  // (db/migrations/000013: `pct < 100 - critical_under_pct` not <=)
  it("at exactly -20% critical under (640 kPa) stays in warn band", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 640 }, steer, config);
    expect(codes(w)).toContain("FR-INS-037");
    expect(codes(w)).not.toContain("FR-INS-031a");
  });

  it("just under -20% critical (639 kPa) escalates to confirmation", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 639 }, steer, config);
    expect(codes(w)).toContain("FR-INS-031a");
    expect(codes(w)).not.toContain("FR-INS-037");
  });

  it("at exactly +10% warn over (880 kPa) stays in warn band", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 880 }, steer, config);
    expect(codes(w)).toContain("FR-INS-037");
    expect(codes(w)).not.toContain("FR-INS-031a");
  });

  it("at exactly +20% critical over (960 kPa) escalates to confirmation", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 960 }, steer, config);
    expect(codes(w)).toContain("FR-INS-031a");
    expect(codes(w)).not.toContain("FR-INS-037");
  });
});

// The two predicates exist to disagree in exactly one place. Pinning the
// disagreement makes it a decision rather than the drift it was: a position
// with its treads read and no pressure is done for counting, banding and
// submitting, and not finished for the sheet, which still has a field to hold
// the driver on (FR-INS-040).
describe("treadsRead and isComplete", () => {
  it("call a tread-complete position with no pressure read, but not finished", () => {
    const entry = { treads: [10, 10, 11], pressureKpa: null };
    expect(treadsRead(entry.treads)).toBe(true);
    expect(isComplete(entry, 3)).toBe(false);
  });

  it("agree that a half-entered position is neither", () => {
    const entry = { treads: [10, null, null], pressureKpa: null };
    expect(treadsRead(entry.treads)).toBe(false);
    expect(isComplete(entry, 3)).toBe(false);
  });

  // treadReadingCount is tenant configuration (FR-CFG-027), so three readings
  // against a four-reading tenant is a short position, not a finished one.
  it("do not call a position finished against a longer configured tread count", () => {
    expect(isComplete({ treads: [10, 10, 11], pressureKpa: 800 }, 4)).toBe(false);
  });
});

describe("severityFor", () => {
  it("is unmeasured until the treads have been read", () => {
    expect(severityFor([], false)).toBe("unmeasured");
  });

  it("is roadworthy when a complete position raised nothing", () => {
    expect(severityFor([], true)).toBe("roadworthy");
  });

  it("is below-removal whenever the tread rule fired", () => {
    const w = positionWarnings({ treads: [4, 5, 6], pressureKpa: 800 }, steer, config);
    expect(severityFor(w, true)).toBe("below-removal");
  });

  it("is caution for any other warning", () => {
    const w = positionWarnings({ treads: [12, 12, 13], pressureKpa: 700 }, steer, config);
    expect(severityFor(w, true)).toBe("caution");
  });
});
