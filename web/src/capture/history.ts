import type { CaptureContext, CapturePosition } from "./captureContext";
import type { PositionEntry, Warning } from "./warnings";
import { governingTread } from "./warnings";
import { groupThousands } from "../format/groupThousands";
import { formatTreadAge } from "../format/treadAge";
import type { UnitLabels } from "../units/units";

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
      // FR-TYR-017: the previous figure's age. Loose equality, so an API
      // that predates the field reads as absent, not undefined.
      message:
        position.previousReadingAgeDays == null
          ? `Deeper than last time (${previous}mm). Was this tyre changed?`
          : `Deeper than last time (${previous}mm, ${formatTreadAge(position.previousReadingAgeDays)}). Was this tyre changed?`,
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
// wherever an input is missing, or the last reading is today's and would be
// offered as itself (NFR-PRO-003 prefers absence to invention); the caller
// decides what an unconfirmed projection means.
export function projectedOdometerKm(ctx: CaptureContext): number | null {
  if (ctx.lastOdometerKm === null || ctx.lastOdometerAgeDays == null) return null;
  if (ctx.averageDailyKm === null || ctx.lastOdometerAgeDays <= 0) return null;
  // The served whole days FR-INS-033 divides by, so an offer at a rate at or
  // under the ceiling passes its own check.
  return Math.round(ctx.lastOdometerKm + ctx.averageDailyKm * ctx.lastOdometerAgeDays);
}

// FR-INS-032 is a rejection, not a warning: BR-INS-002 is unconditional and
// the timeline raises TY001 for it on submit. Refusing at entry means the
// driver finds out while standing at the cab, not after the walk-around.
export function odometerRejection(
  odometerKm: number | null,
  ctx: CaptureContext,
  units: UnitLabels,
): string | null {
  if (odometerKm === null || ctx.lastOdometerKm === null) return null;
  if (odometerKm >= ctx.lastOdometerKm) return null;
  return `Lower than the last recorded ${groupThousands(String(ctx.lastOdometerKm))} ${units.distance}.`;
}

// FR-INS-033's confirmation governs capture only; DR-020 governs the
// append-only timeline (DR-018), so a confirmed implausible value submits
// but is preserved on the warning record, not written to the odometer.
export function odometerWarnings(
  odometerKm: number | null,
  ctx: CaptureContext,
  units: UnitLabels,
): Warning[] {
  const base = ctx.odometerBaseKm;
  const days = ctx.odometerBaseAgeDays;
  if (odometerKm === null || base == null || days == null) return [];

  // The trigger's pair in whole tenant days (000021), so the driver is asked
  // about a reading the timeline would refuse as implausible (TY002). The
  // phone judges against the start screen's copy, and the trigger against the
  // timeline at the write and the ceiling in force at the end of the
  // reading's UTC date, so they can part wherever those differ. Causes
  // include this reading dated on another day than the copy counted to (UTC
  // dating until TYRE-244, or a later submit such as a resumed draft's), an
  // earlier-dated reading landing after the copy was read (an outbox, an
  // import), a base day two sources share (TYRE-244), and a ceiling taking
  // effect after the copy was read (TYRE-244 for one after the submit).
  const perDay = (odometerKm - base) / days;
  if (perDay <= ctx.config.odometerMaxDailyKm) return [];

  return [
    {
      code: "FR-INS-033",
      requiresConfirmation: true,
      // Names the reading it divides from: with one already taken today, the
      // start screen shows only that one.
      message: `That is about ${groupThousands(String(Math.round(perDay)))} ${units.distance} a day since the ${groupThousands(String(base))} ${units.distance} reading ${formatTreadAge(days)}. Check the digits.`,
      enteredValue: String(odometerKm),
    },
  ];
}
