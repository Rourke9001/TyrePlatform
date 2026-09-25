import type { CaptureContext, CapturePosition } from "./captureContext";
import type { PositionEntry, Warning } from "./warnings";
import { governingTread } from "./warnings";
import { groupThousands } from "../format/groupThousands";

// The same figure app.wear_rate_mm_per_month uses to convert days to
// months: a unit conversion, not a threshold, but it must match the
// database exactly.
const DAYS_PER_MONTH = 30.44;

const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

export function historyWarnings(
  entry: PositionEntry,
  position: CapturePosition,
  ctx: CaptureContext,
  now: Date,
): Warning[] {
  const governing = governingTread(entry.treads);
  if (governing === null) return [];
  if (position.previousGoverningMm === null || position.previousReadingAt === null) return [];

  const out: Warning[] = [];
  const previous = position.previousGoverningMm;

  // FR-INS-034 / BR-INS-001. The unless-clause is the rule: a fitment since
  // the last reading is exactly what a deeper tyre means, and warning through
  // it teaches drivers to confirm without reading.
  if (governing > previous && !position.fitmentSincePrevious) {
    out.push({
      code: "FR-INS-034",
      requiresConfirmation: true,
      message: `Deeper than last time (${previous}mm). Was this tyre changed?`,
      enteredValue: String(governing),
    });
  }

  // FR-INS-035. BR-ANL-004 refuses a rate across a fitment and BR-ANL-009
  // asserts none at all for a lifting axle. An absent cohort key is that
  // answer, and defaulting it would manufacture the comparison the rule bans.
  const cohort = ctx.cohortWearRateMmPerMonth[`${position.axleClass}:${position.axleType}`];
  const months = daysBetween(new Date(position.previousReadingAt), now) / DAYS_PER_MONTH;
  if (cohort !== undefined && cohort > 0 && months > 0 && !position.fitmentSincePrevious) {
    const implied = (previous - governing) / months;
    const trigger = cohort * ctx.config.wearRateAlertMultiple;
    if (implied > trigger) {
      out.push({
        code: "FR-INS-035",
        requiresConfirmation: true,
        message: `Wearing far faster than this fleet's ${position.axleClass.toLowerCase()} tyres. Check the reading.`,
        enteredValue: String(governing),
      });
    }
  }

  return out;
}

// FR-INS-020's pre-fill, verbatim: a projection, never the raw last
// reading, which cannot manufacture a zero-distance interval FR-INS-032/033
// would misread. Confirming beats typing six digits (sponsor Q6). Null
// wherever an input is missing (NFR-PRO-003 prefers absence to invention);
// the caller decides what an unconfirmed projection means.
export function projectedOdometerKm(ctx: CaptureContext, now: Date): number | null {
  if (ctx.lastOdometerKm === null || ctx.lastOdometerAt === null) return null;
  if (ctx.averageDailyKm === null) return null;
  const days = daysBetween(new Date(ctx.lastOdometerAt), now);
  if (days <= 0) return ctx.lastOdometerKm;
  return Math.round(ctx.lastOdometerKm + ctx.averageDailyKm * days);
}

// FR-INS-032 is a rejection, not a warning: BR-INS-002 is unconditional and
// the timeline raises TY001 for it on submit. Refusing at entry means the
// driver finds out while standing at the cab, not after the walk-around.
export function odometerRejection(odometerKm: number | null, ctx: CaptureContext): string | null {
  if (odometerKm === null || ctx.lastOdometerKm === null) return null;
  if (odometerKm >= ctx.lastOdometerKm) return null;
  return `Lower than the last recorded ${groupThousands(String(ctx.lastOdometerKm))} km.`;
}

// FR-INS-033's confirmation governs capture only; DR-020 governs the
// append-only timeline (DR-018), so a confirmed implausible value submits
// but is preserved on the warning record, not written to the odometer.
export function odometerWarnings(
  odometerKm: number | null,
  ctx: CaptureContext,
  now: Date,
): Warning[] {
  if (odometerKm === null || ctx.lastOdometerKm === null || ctx.lastOdometerAt === null) return [];
  const days = daysBetween(new Date(ctx.lastOdometerAt), now);
  if (days <= 0) return [];

  const perDay = (odometerKm - ctx.lastOdometerKm) / days;
  if (perDay <= ctx.config.odometerMaxDailyKm) return [];

  return [
    {
      code: "FR-INS-033",
      requiresConfirmation: true,
      message: `That is about ${groupThousands(String(Math.round(perDay)))} km a day since the last reading. Check the digits.`,
      enteredValue: String(odometerKm),
    },
  ];
}
