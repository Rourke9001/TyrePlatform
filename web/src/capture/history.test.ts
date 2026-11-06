import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import {
  historyWarnings,
  odometerRejection,
  odometerWarnings,
  projectedOdometerKm,
} from "./history";
import { unitLabels } from "../units/units";

const NOW = new Date("2026-08-25T06:00:00Z");
const metric = unitLabels("KPA", "KM");

const position: CapturePosition = {
  id: "p1",
  vehicleId: "v1",
  code: "1",
  sequence: 1,
  axleClass: "STEER",
  axleType: "FIXED",
  side: "LEFT",
  axleNumber: 1,
  isSpare: false,
  unitLabel: "Horse",
  tyreId: "t1",
  tyreCode: "BAC-04217",
  // One month earlier, so implied rates divide by roughly 1.0 months.
  previousGoverningMm: 12,
  previousReadingAt: "2026-07-26T06:00:00Z",
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
};

const ctx: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z", // six days before NOW
  lastOdometerAgeDays: 6,
  // From an earlier day, so the last reading is FR-INS-033's base too.
  odometerBaseKm: 412180,
  odometerBaseAgeDays: 6,
  averageDailyKm: null,
  combination: null,
  positions: [position],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
    captureSpares: true,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.8 },
};

const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

describe("historyWarnings", () => {
  it("says nothing about a normal month's wear", () => {
    expect(historyWarnings({ treads: [11, 11, 12], pressureKpa: 800 }, position, ctx, NOW)).toEqual(
      [],
    );
  });

  // FR-INS-034 / BR-INS-001: tread does not grow. An increase is a possible
  // unlogged replacement (FR-FIT-024), not a measurement to accept quietly.
  it("warns when tread has increased with no fitment to explain it", () => {
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-034");
    expect(w.find((x) => x.code === "FR-INS-034")?.requiresConfirmation).toBe(true);
  });

  // The unless-clause is the whole rule. A new tyre reads deeper and that is
  // not an anomaly. Warning anyway would train drivers to confirm blindly.
  it("stays silent when a fitment since the last reading explains the increase", () => {
    const fitted = { ...position, fitmentSincePrevious: true };
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, fitted, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-034");
  });

  // Boundary test: FR-INS-034 at exactly equal tread.
  // A governing tread exactly equal to previousGoverningMm with
  // fitmentSincePrevious: false → expect no FR-INS-034.
  it("does not warn when tread is exactly equal to the previous reading", () => {
    const w = historyWarnings({ treads: [12, 12, 12], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-034");
  });

  // Boundary test: FR-INS-034 boundary+1.
  // One millimetre deeper than previousGoverningMm → expect the warning.
  it("warns when tread is one mm deeper than the previous reading", () => {
    const w = historyWarnings({ treads: [13, 13, 13], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-034");
  });

  // FR-INS-035: 12mm -> 8mm in one month is 4mm/month against a 0.8 cohort
  // average and a multiple of 3, so the trigger is 2.4mm/month.
  it("warns when the implied wear rate exceeds the configured multiple", () => {
    const w = historyWarnings({ treads: [8, 8, 9], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-035");
    expect(w.find((x) => x.code === "FR-INS-035")?.requiresConfirmation).toBe(true);
  });

  it("does not warn just under the multiple", () => {
    // 12 -> 10 is 2mm/month, under the 2.4 trigger.
    const w = historyWarnings({ treads: [10, 10, 11], pressureKpa: 800 }, position, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // Boundary: FR-INS-035 at exactly the multiple (trigger 2.4mm/month);
  // previousReadingAt is set to exactly 30.44 days before NOW.
  it("does not warn when the implied wear rate exactly equals the trigger", () => {
    const exactlyOneMonthAgo = new Date(NOW.getTime() - 30.44 * 86_400_000);
    const adjustedPosition = { ...position, previousReadingAt: exactlyOneMonthAgo.toISOString() };

    const w = historyWarnings(
      { treads: [9.6, 9.6, 9.6], pressureKpa: 800 },
      adjustedPosition,
      ctx,
      NOW,
    );
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // FR-INS-035 just past the boundary. 9.5mm is 0.1mm under the 9.6mm that
  // wears at exactly the trigger, so the rate is 0.1mm/month above it.
  it("warns when the implied wear rate is just above the trigger", () => {
    const exactlyOneMonthAgo = new Date(NOW.getTime() - 30.44 * 86_400_000);
    const adjustedPosition = { ...position, previousReadingAt: exactlyOneMonthAgo.toISOString() };

    const w = historyWarnings(
      { treads: [9.5, 9.5, 9.5], pressureKpa: 800 },
      adjustedPosition,
      ctx,
      NOW,
    );
    expect(codes(w)).toContain("FR-INS-035");
  });

  // BR-ANL-009: a lifted axle is not touching the road, so no rate is
  // asserted for it at all. An absent cohort key is that answer, and
  // defaulting it to any number would invent the rule the rule forbids.
  it("asserts no wear rate where the cohort has none", () => {
    const lifting = { ...position, axleType: "LIFTING" };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, lifting, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // BR-ANL-004: a fitment between the readings makes the pair meaningless for
  // a rate, the same reason it excuses the increase.
  it("computes no rate across a fitment", () => {
    const fitted = { ...position, fitmentSincePrevious: true };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, fitted, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  it("says nothing about a position with no history", () => {
    const fresh = { ...position, previousGoverningMm: null, previousReadingAt: null };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, fresh, ctx, NOW);
    expect(w).toEqual([]);
  });

  // Guard: zero elapsed time (previousReadingAt exactly equal to now).
  // The months > 0 guard should prevent FR-INS-035 when there is no time interval.
  it("does not compute a wear rate when the previous reading timestamp equals now", () => {
    const sameTime = { ...position, previousReadingAt: NOW.toISOString() };
    const w = historyWarnings({ treads: [1, 1, 2], pressureKpa: 800 }, sameTime, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // Guard: negative elapsed time (clock skew). Without months > 0, a tread
  // increase over negative time gives a positive rate via double negation
  // and would wrongly warn.
  it("does not compute a wear rate when the previous reading is in the future", () => {
    const futureTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // one day in the future
    const skewedPosition = { ...position, previousReadingAt: futureTime.toISOString() };
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, skewedPosition, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });
});

describe("odometerRejection", () => {
  // FR-INS-032 says reject, not warn. BR-INS-002 is unconditional and the
  // server raises TY001 for it. Refusing here saves the driver finding out
  // after the walk-around.
  it("refuses a reading below the last recorded one", () => {
    expect(odometerRejection(412000, ctx, metric)).toBe("Lower than the last recorded 412,180 km.");
  });

  it("accepts a reading above it", () => {
    expect(odometerRejection(500000, ctx, metric)).toBeNull();
  });

  // Boundary test: FR-INS-032 at exactly equal.
  // An odometer exactly equal to lastOdometerKm → expect odometerRejection to return null.
  it("accepts a reading exactly equal to the last recorded one", () => {
    expect(odometerRejection(412180, ctx, metric)).toBeNull();
  });

  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  it("accepts an absent odometer", () => {
    expect(odometerRejection(null, ctx, metric)).toBeNull();
  });
});

describe("odometerWarnings", () => {
  // FR-INS-033: six days at a 1600km/day ceiling is 9600km of headroom.
  it("accepts a plausible distance", () => {
    expect(odometerWarnings(420000, ctx, metric)).toEqual([]);
  });

  // The transposed digit the requirement exists for.
  it("warns and requires confirmation on an implausible daily distance", () => {
    const w = odometerWarnings(512180, ctx, metric);
    expect(codes(w)).toEqual(["FR-INS-033"]);
    expect(w[0].requiresConfirmation).toBe(true);
    expect(w[0].enteredValue).toBe("512180");
    // 100000 km over six days is 16666.7 a day, rounded and grouped (U55).
    expect(w[0].message).toBe(
      "That is about 16,667 km a day since the 412,180 km reading 6 days ago. Check the digits.",
    );
  });

  // Boundary: FR-INS-033 exactly at the ceiling (6 days * 1600km/day = 9600km
  // headroom); lastOdometerKm + 9600 should not warn.
  it("does not warn when daily distance exactly equals the configured ceiling", () => {
    const exactDailyDistanceKm = ctx.lastOdometerKm! + 6 * ctx.config.odometerMaxDailyKm;
    const w = odometerWarnings(exactDailyDistanceKm, ctx, metric);
    expect(codes(w)).not.toContain("FR-INS-033");
  });

  // Boundary test: FR-INS-033 boundary+1.
  // One kilometre a day more → expect the warning.
  it("warns when daily distance exceeds the configured ceiling by one km", () => {
    const exceedsDaily = ctx.lastOdometerKm! + 6 * ctx.config.odometerMaxDailyKm + 1;
    const w = odometerWarnings(exceedsDaily, ctx, metric);
    expect(codes(w)).toContain("FR-INS-033");
  });

  it("says nothing when there is no earlier reading to divide from", () => {
    const fresh = { ...ctx, odometerBaseKm: null, odometerBaseAgeDays: null };
    expect(odometerWarnings(999999, fresh, metric)).toEqual([]);
  });

  // An API older than the base sends none, and the browser clock does not
  // stand in for the tenant's days (rule 6).
  it("says nothing when the server sends no base", () => {
    const unaged = { ...ctx, odometerBaseKm: undefined, odometerBaseAgeDays: undefined };
    expect(odometerWarnings(999999, unaged, metric)).toEqual([]);
  });

  // DR-020's trigger divides by whole days between reading dates, so 2,000 km
  // since a reading yesterday is 2,000 a day.
  it("divides by the served day count", () => {
    const yesterday = { ...ctx, odometerBaseAgeDays: 1 };
    expect(codes(odometerWarnings(ctx.lastOdometerKm! + 2000, yesterday, metric))).toEqual([
      "FR-INS-033",
    ]);
  });

  // The trigger judges against the last reading on an earlier day (000021),
  // so a fuel record already dated today is not the one it divides from:
  // 1,800 km since yesterday's reading, not 1,300 since today's.
  it("divides from the last reading on an earlier day", () => {
    const today = {
      ...ctx,
      lastOdometerKm: 412680,
      lastOdometerAgeDays: 0,
      odometerBaseAgeDays: 1,
    };
    const w = odometerWarnings(413980, today, metric);
    // The screen shows only today's reading, so the message names the one
    // it divides from.
    expect(w[0]?.message).toBe(
      "That is about 1,800 km a day since the 412,180 km reading 1 day ago. Check the digits.",
    );
  });
});

describe("projectedOdometerKm", () => {
  // FR-INS-020: the last reading carried forward at the unit's rate over the
  // count FR-INS-033 divides by.
  it("projects over the served day count", () => {
    const yesterday = { ...ctx, lastOdometerAgeDays: 1, averageDailyKm: 900 };
    expect(projectedOdometerKm(yesterday)).toBe(413080);
  });

  // A reading already taken today would be offered as itself, the one value
  // FR-INS-020 never pre-fills, so the field starts empty.
  it.each([0, -1])("offers nothing at a day count of %s", (age) => {
    expect(projectedOdometerKm({ ...ctx, lastOdometerAgeDays: age, averageDailyKm: 900 })).toBe(
      null,
    );
  });

  it("offers nothing without a served day count", () => {
    const unaged = { ...ctx, lastOdometerAgeDays: undefined, averageDailyKm: 900 };
    expect(projectedOdometerKm(unaged)).toBeNull();
  });
});

// FR-CFG-021: a distance in an odometer check is captioned with the
// tenant's unit. An unknown code is echoed (units.ts), so a hard-coded km
// fails.
describe("distance labels", () => {
  const xkm = unitLabels("KPA", "XKM");
  it("odometerRejection names the tenant's unit", () => {
    expect(odometerRejection(412000, ctx, xkm)).toBe("Lower than the last recorded 412,180 XKM.");
  });
  it("odometerWarnings names the tenant's unit", () => {
    expect(odometerWarnings(512180, ctx, xkm)[0]?.message).toBe(
      "That is about 16,667 XKM a day since the 412,180 XKM reading 6 days ago. Check the digits.",
    );
  });
});

// FR-TYR-017 beside FR-INS-034: the previous figure names its age when the
// server sends one, and only the figure when it does not.
describe("FR-INS-034's age", () => {
  it("FR-INS-034 names the previous reading's age", () => {
    const aged = { ...position, previousReadingAgeDays: 30 };
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, aged, ctx, NOW);
    expect(w.find((x) => x.code === "FR-INS-034")?.message).toBe(
      "Deeper than last time (12mm, 30 days ago). Was this tyre changed?",
    );
  });

  it("FR-INS-034 is unchanged when the age is absent", () => {
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, position, ctx, NOW);
    expect(w.find((x) => x.code === "FR-INS-034")?.message).toBe(
      "Deeper than last time (12mm). Was this tyre changed?",
    );
  });
});
