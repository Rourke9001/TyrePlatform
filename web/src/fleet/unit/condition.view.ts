import type { ExceptionRow } from "../../api/dashboard";
import type { InspectionReading, UnitCondition } from "../../api/inspections";
import type { Unit } from "../../api/units";
import type { Condition } from "../../ui/condition";

// The unit screen's condition per position (TYRE-325 spec section 3), a pure
// view model (ADR-0022). app.v_exception judges; this maps its rows onto the
// plan and compares no measurement with any threshold (rule 5).

// A display mapping of the server's severity, not a judgement.
export function severityCondition(severity: string): Condition | null {
  if (severity === "CRITICAL") return "limit";
  if (severity === "WARNING") return "near";
  return null;
}

// Why the position reads as it does, for the panel's words.
export type PositionWhy = "absent" | "empty" | "never" | "not-read" | "other-tyre" | "read";

export interface PositionState {
  condition: Condition | null;
  why: PositionWhy;
  reading: InspectionReading | null;
  exceptions: ExceptionRow[];
}

function rowsAt(unitId: string, code: string, rows: ExceptionRow[]): ExceptionRow[] {
  // A dual-mate row names both ends (positionCode2). Codes repeat across a
  // rig's units, so a row counts on its own unit only (lessons 2026-08-26).
  return rows.filter(
    (r) => r.vehicleId === unitId && (r.positionCode === code || r.positionCode2 === code),
  );
}

function judged(rows: ExceptionRow[]): Condition {
  const severities = rows.map((r) => severityCondition(r.severity));
  if (severities.includes("limit")) return "limit";
  if (severities.includes("near")) return "near";
  return "ok";
}

// The spec's table, first row that fits. The detail is the unit's own, so a
// reading is found by position id within it.
export function positionStates(unit: Unit, condition: UnitCondition): Map<string, PositionState> {
  const { latest, exceptions } = condition;
  const states = new Map<string, PositionState>();
  for (const position of unit.positions) {
    const rows = rowsAt(unit.id, position.code, exceptions);
    const state = (
      why: PositionWhy,
      c: Condition | null,
      reading: InspectionReading | null = null,
    ) => states.set(position.id, { condition: c, why, reading, exceptions: rows });
    if (latest?.absentSpares.some((a) => a.positionId === position.id)) {
      state("absent", "nospare");
      continue;
    }
    if (position.fitment === null) {
      state("empty", null);
      continue;
    }
    if (latest === null) {
      state("never", "unread");
      continue;
    }
    const reading = latest.readings.find((r) => r.positionId === position.id);
    if (reading === undefined) {
      state("not-read", "unread");
      continue;
    }
    // A stale reading on a moved tyre reads unread, never a stale limit
    // (TYRE-325 Lead's call 9).
    if (reading.tyreId !== position.fitment.tyreId) {
      state("other-tyre", "unread");
      continue;
    }
    state("read", judged(rows), reading);
  }
  return states;
}

// A rule that names no position, such as the unit's pressure spread, is a
// line beside the plan.
export function unitLevelExceptions(condition: UnitCondition): ExceptionRow[] {
  return condition.exceptions.filter((r) => r.positionCode === null);
}
