import type { CaptureConfig, CapturePosition } from "./captureContext";

// The code IS the requirement id, travelling to app.inspection_warning
// (DR-021) for a controller to read later. FR-INS-032 is deliberately
// absent: it is a rejection, never a warning, so it never travels here.
export type WarningCode =
  | "FR-INS-031a"
  | "FR-INS-033"
  | "FR-INS-034"
  | "FR-INS-035"
  | "FR-INS-036"
  | "FR-INS-037"
  | "FR-INS-041";

export interface Warning {
  code: WarningCode;
  // Where the SRS says "warn and require confirmation" the driver must act;
  // where it says "warn immediately" an acknowledgement is enough. Both are
  // recorded under FR-INS-040. This only decides which response is written.
  requiresConfirmation: boolean;
  // NFR-USE-005: what happened and what to do, in plain language. Never the
  // words legal, roadworthy or minimum (CR-010, OR-LEG-001).
  message: string;
  enteredValue: string | null;
  promptPhoto?: boolean;
}

export interface PositionEntry {
  treads: (number | null)[];
  pressureKpa: number | null;
}

export type Severity = "roadworthy" | "caution" | "below-removal" | "unmeasured";

// The one definition of "done": every surface that counts, bands or submits
// reads it. Pressure is deliberately excluded, since 000023 accepts a NULL
// pressure and calling such a position unmeasured would hide a tread band
// the app already holds.
export function treadsRead(treads: (number | null)[]): boolean {
  return treads.length > 0 && treads.every((t) => t !== null);
}

// Every field on the sheet answered; only the sheet needs this. Kept apart
// from treadsRead so the difference is a decision, not a drift.
export function isComplete(entry: PositionEntry, treadReadingCount: number): boolean {
  return (
    entry.treads.length === treadReadingCount &&
    treadsRead(entry.treads) &&
    entry.pressureKpa !== null
  );
}

// BR-INS-003. The client shows this; the database derives its own from the
// measurements and the payload never carries it (CR-011, DR-017).
export function governingTread(treads: (number | null)[]): number | null {
  if (treads.length === 0 || treads.some((t) => t === null)) return null;
  return Math.min(...(treads as number[]));
}

// BR-ANL-007, a property of this inspection rather than of the tyre.
export function widthSpread(treads: (number | null)[]): number | null {
  if (treads.length === 0 || treads.some((t) => t === null)) return null;
  const t = treads as number[];
  return Math.max(...t) - Math.min(...t);
}

export function positionWarnings(
  entry: PositionEntry,
  position: CapturePosition,
  config: CaptureConfig,
): Warning[] {
  // Gated on treads, not the whole sheet: warning on a half-entered
  // position trains drivers to dismiss warnings, and holding FR-INS-036
  // back until pressure is typed would hide it on a position that may
  // never get one.
  if (entry.treads.length !== config.treadReadingCount || !treadsRead(entry.treads)) return [];

  const out: Warning[] = [];
  const governing = governingTread(entry.treads);
  const spread = widthSpread(entry.treads);

  // FR-INS-036 at BR-RPT-006's boundary (<=, matching db/tests/004_tests.sql).
  // The threshold is the tenant's configured policy and is never described as
  // a legal limit (CR-010).
  if (governing !== null && governing <= config.removalThresholdMm) {
    out.push({
      code: "FR-INS-036",
      requiresConfirmation: false,
      message: `At or below this fleet's ${config.removalThresholdMm}mm replacement point. Report it.`,
      enteredValue: String(governing),
    });
  }

  // FR-INS-041 at BR-ANL-007's boundary (>=). The photograph is part of the
  // requirement, not an extra: uneven wear across the width is diagnosed from
  // the tyre, not from three numbers.
  if (spread !== null && spread >= config.widthSpreadWarnMm) {
    out.push({
      code: "FR-INS-041",
      requiresConfirmation: false,
      message: `${spread}mm difference across this tyre. Take a photo of the tread.`,
      enteredValue: String(spread),
      promptPhoto: true,
    });
  }

  // FR-CFG-013 as amended gives SPARE no target, so there is nothing to
  // compare against and the reading stays deliberately unclassified.
  if (entry.pressureKpa !== null && position.targetKpa !== null) {
    const target = position.targetKpa;
    const pct = ((entry.pressureKpa - target) / target) * 100;
    const criticalUnder = position.criticalUnderPct ?? Infinity;
    const criticalOver = position.criticalOverPct ?? Infinity;
    const warnUnder = position.warnUnderPct ?? Infinity;
    const warnOver = position.warnOverPct ?? Infinity;

    // At most one pressure warning: FR-INS-031a supersedes FR-INS-037's
    // band rather than stacking. Strict under, inclusive over, matching
    // app.inflation_compliance's `pct < 100 - critical_under_pct` (000013),
    // the same drift FR-INS-036/041 are pinned against.
    if (pct < -criticalUnder || pct >= criticalOver) {
      out.push({
        code: "FR-INS-031a",
        requiresConfirmation: true,
        message: `${entry.pressureKpa} kPa against a ${target} kPa target. Check the gauge and confirm.`,
        enteredValue: String(entry.pressureKpa),
      });
    } else if (pct < -warnUnder || pct >= warnOver) {
      out.push({
        code: "FR-INS-037",
        requiresConfirmation: false,
        message: `${entry.pressureKpa} kPa against a ${target} kPa target.`,
        enteredValue: String(entry.pressureKpa),
      });
    }
  }

  return out;
}

// Colour is never the only encoding (NFR-USE-009); names pair with a text
// badge. `measured` asks whether treads were read, not whether the sheet is
// fully filled, since a position with three readings has one whether or
// not pressure was taken.
export function severityFor(warnings: Warning[], measured: boolean): Severity {
  if (!measured) return "unmeasured";
  if (warnings.some((w) => w.code === "FR-INS-036")) return "below-removal";
  return warnings.length > 0 ? "caution" : "roadworthy";
}
