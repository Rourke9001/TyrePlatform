import type { CaptureConfig, CapturePosition } from "./captureContext";

// The code IS the requirement id: it travels in the submit payload to
// app.inspection_warning (DR-021) and is what a controller reads months later
// when asking why a driver was stopped. A private enum here would need a
// mapping table nobody maintains.
export type WarningCode =
  | "FR-INS-031a"
  | "FR-INS-032"
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
  // recorded under FR-INS-040 — this only decides which response is written.
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

const complete = (e: PositionEntry, count: number) =>
  e.treads.length === count && e.treads.every((t) => t !== null) && e.pressureKpa !== null;

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
  // Warning on a half-entered position would fire on the first digit of a
  // number that is about to become fine, which trains drivers to dismiss
  // warnings without reading them.
  if (!complete(entry, config.treadReadingCount)) return [];

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

    // At most one pressure warning. FR-INS-031a's confirmation supersedes
    // FR-INS-037's band: both are true beyond the critical tolerance, and two
    // rows about one number costs seconds the three-minute budget has not got.
    // Strict on the under side, inclusive on the over side — not a style
    // choice: app.inflation_pressure_summary (000013) bands with
    // `pct < 100 - critical_under_pct`, so at exactly -20% the database says
    // WARN and an inclusive client here would say CONFIRM. Same drift the
    // FR-INS-036/041 boundaries are pinned against.
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

// Colour is never the only encoding (NFR-USE-009) — this names the state and
// the component pairs it with a text badge. The names are the fixed band names
// in theme/tokens.ts; the millimetres that reach them are tenant configuration.
export function severityFor(warnings: Warning[], isComplete: boolean): Severity {
  if (!isComplete) return "unmeasured";
  if (warnings.some((w) => w.code === "FR-INS-036")) return "below-removal";
  return warnings.length > 0 ? "caution" : "roadworthy";
}
