import { describe, expect, it } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { historyWarnings, odometerRejection, odometerWarnings } from "./history";

const NOW = new Date("2026-08-25T06:00:00Z");

const position: CapturePosition = {
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
  combination: null,
  positions: [position],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
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
  // not an anomaly — warning anyway would train drivers to confirm blindly.
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

  // Boundary test: FR-INS-035 at exactly the multiple.
  // previousGoverningMm: 12, cohort 0.8, wearRateAlertMultiple: 3, so trigger = 2.4.
  // Governing of 9.6mm over exactly one month (30.44 days) gives implied rate of exactly 2.4.
  // Exactly one month means previousReadingAt is exactly 30.44 days before NOW.
  // previousReadingAt is "2026-07-26T06:00:00Z", NOW is "2026-08-25T06:00:00Z"
  // That's 30 days. We need to adjust previousReadingAt to be exactly 30.44 days before NOW.
  it("does not warn when the implied wear rate exactly equals the trigger", () => {
    // Calculate: need to go back exactly DAYS_PER_MONTH from NOW
    // DAYS_PER_MONTH = 30.44 days
    const exactlyOneMonthAgo = new Date(NOW.getTime() - 30.44 * 86_400_000);
    const adjustedPosition = { ...position, previousReadingAt: exactlyOneMonthAgo.toISOString() };

    // 12 - 9.6 = 2.4, which is exactly the trigger (0.8 * 3 = 2.4)
    const w = historyWarnings(
      { treads: [9.6, 9.6, 9.6], pressureKpa: 800 },
      adjustedPosition,
      ctx,
      NOW,
    );
    expect(codes(w)).not.toContain("FR-INS-035");
  });

  // Boundary test: FR-INS-035 boundary-1.
  // One mm less than the exact multiple should trigger the warning.
  it("warns when the implied wear rate is one mm above the trigger", () => {
    // Calculate: need to go back exactly DAYS_PER_MONTH from NOW
    const exactlyOneMonthAgo = new Date(NOW.getTime() - 30.44 * 86_400_000);
    const adjustedPosition = { ...position, previousReadingAt: exactlyOneMonthAgo.toISOString() };

    // 12 - 9.5 = 2.5, which exceeds the trigger (0.8 * 3 = 2.4)
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

  // Guard: negative elapsed time (previousReadingAt after now, clock skew on device).
  // The months > 0 guard is what suppresses the warning. A tread increase over
  // negative time produces a positive rate (two negatives): (12 - 14) / -0.0329 ≈ +60.88.
  // Without the guard, this would exceed the 2.4 trigger and warn. With the guard, it does not.
  it("does not compute a wear rate when the previous reading is in the future", () => {
    const futureTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // one day in the future
    const skewedPosition = { ...position, previousReadingAt: futureTime.toISOString() };
    // Treads deeper than previousGoverningMm (14 > 12) produce a positive implied rate over negative time
    const w = historyWarnings({ treads: [14, 14, 15], pressureKpa: 800 }, skewedPosition, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-035");
  });
});

describe("odometerRejection", () => {
  // FR-INS-032 says reject, not warn. BR-INS-002 is unconditional and the
  // server raises TY001 for it — refusing here saves the driver finding out
  // after the walk-around.
  it("refuses a reading below the last recorded one", () => {
    // toLocaleString("en-ZA") groups with a non-breaking space, and a
    // small-ICU build may group differently again — so match any single
    // non-digit rather than guessing which separator shipped.
    expect(odometerRejection(412000, ctx)).toMatch(/412\D?180/);
  });

  it("accepts a reading at or above it", () => {
    expect(odometerRejection(412180, ctx)).toBeNull();
    expect(odometerRejection(500000, ctx)).toBeNull();
  });

  // Boundary test: FR-INS-032 at exactly equal.
  // An odometer exactly equal to lastOdometerKm → expect odometerRejection to return null.
  it("accepts a reading exactly equal to the last recorded one", () => {
    expect(odometerRejection(412180, ctx)).toBeNull();
  });

  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  it("accepts an absent odometer", () => {
    expect(odometerRejection(null, ctx)).toBeNull();
  });
});

describe("odometerWarnings", () => {
  // FR-INS-033: six days at a 1600km/day ceiling is 9600km of headroom.
  it("accepts a plausible distance", () => {
    expect(odometerWarnings(420000, ctx, NOW)).toEqual([]);
  });

  // The transposed digit the requirement exists for.
  it("warns and requires confirmation on an implausible daily distance", () => {
    const w = odometerWarnings(512180, ctx, NOW);
    expect(codes(w)).toEqual(["FR-INS-033"]);
    expect(w[0].requiresConfirmation).toBe(true);
    expect(w[0].enteredValue).toBe("512180");
  });

  // Boundary test: FR-INS-033 at exactly the ceiling.
  // A perDay landing exactly on odometerMaxDailyKm → expect no warning.
  // lastOdometerKm: 412180, lastOdometerAt: 2026-08-19T06:00:00Z (6 days before NOW)
  // odometerMaxDailyKm: 1600
  // 6 days * 1600 km/day = 9600 km of headroom
  // So exactly 412180 + 9600 = 421780 km should not warn.
  it("does not warn when daily distance exactly equals the configured ceiling", () => {
    const exactDailyDistanceKm = ctx.lastOdometerKm! + 6 * ctx.config.odometerMaxDailyKm;
    const w = odometerWarnings(exactDailyDistanceKm, ctx, NOW);
    expect(codes(w)).not.toContain("FR-INS-033");
  });

  // Boundary test: FR-INS-033 boundary+1.
  // One kilometre a day more → expect the warning.
  it("warns when daily distance exceeds the configured ceiling by one km", () => {
    const exceedsDaily = ctx.lastOdometerKm! + 6 * ctx.config.odometerMaxDailyKm + 1;
    const w = odometerWarnings(exceedsDaily, ctx, NOW);
    expect(codes(w)).toContain("FR-INS-033");
  });

  it("says nothing when there is no previous reading to divide by", () => {
    const fresh = { ...ctx, lastOdometerKm: null, lastOdometerAt: null };
    expect(odometerWarnings(999999, fresh, NOW)).toEqual([]);
  });

  // Guard: zero elapsed time (lastOdometerAt exactly equal to now).
  // The days <= 0 guard should prevent FR-INS-033 when there is no time interval.
  it("does not compute daily distance when the last odometer timestamp equals now", () => {
    const sameTimeCtx = { ...ctx, lastOdometerAt: NOW.toISOString() };
    const w = odometerWarnings(500000, sameTimeCtx, NOW);
    expect(codes(w)).not.toContain("FR-INS-033");
  });

  // Guard: negative elapsed time (lastOdometerAt after now, clock skew on device).
  // The days <= 0 guard is what suppresses the warning. An odometer decrease over
  // negative time produces a positive distance (two negatives): (400000 - 412180) / -1 = +12,180.
  // Without the guard, this would exceed the 1,600 ceiling and warn. With the guard, it does not.
  it("does not compute daily distance when the last odometer is in the future", () => {
    const futureTime = new Date(NOW.getTime() + 24 * 60 * 60 * 1000); // one day in the future
    const skewedCtx = { ...ctx, lastOdometerAt: futureTime.toISOString() };
    // Odometer below lastOdometerKm (400,000 < 412,180) produces a positive perDay over negative time
    const w = odometerWarnings(400000, skewedCtx, NOW);
    expect(codes(w)).not.toContain("FR-INS-033");
  });
});
