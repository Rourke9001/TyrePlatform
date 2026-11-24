import { describe, expect, it } from "vitest";

import {
  positionStates,
  severityCondition,
  unitLevelExceptions,
  type PositionState,
} from "./condition.view";
import type { UnitCondition } from "../../api/inspections";
import {
  exceptionRow,
  inspectionDetail,
  inspectionReading,
  openFitment,
  unit,
  unitPosition,
} from "../../test/fixtures";

// The spec's condition table (section 3), one case per row, on a unit with
// tyre t1 fitted at p1 unless the case says otherwise.
const UNIT = unit({
  id: "u9",
  positions: [unitPosition({ id: "p1", code: "1", fitment: openFitment({ tyreId: "t1" }) })],
});

const READ = inspectionReading({ positionId: "p1", positionCode: "1", tyreId: "t1" });

function condition(overrides: Partial<UnitCondition> = {}): UnitCondition {
  return {
    latest: inspectionDetail({ readings: [READ] }),
    exceptions: [],
    ...overrides,
  };
}

function at(state: Map<string, PositionState>, id: string): PositionState {
  const s = state.get(id);
  if (s === undefined) throw new Error(`no state for ${id}`);
  return s;
}

describe("severityCondition", () => {
  it("maps a severity to a tile's condition, and nothing else", () => {
    expect(severityCondition("CRITICAL")).toBe("limit");
    expect(severityCondition("WARNING")).toBe("near");
    expect(severityCondition("INFO")).toBeNull();
  });
});

describe("positionStates", () => {
  it("row 1: a spare the latest inspection reported absent is nospare, even with a tyre fitted", () => {
    const s = at(
      positionStates(
        UNIT,
        condition({
          latest: inspectionDetail({ absentSpares: [{ positionId: "p1", positionCode: "1" }] }),
        }),
      ),
      "p1",
    );
    expect(s.condition).toBe("nospare");
    expect(s.why).toBe("absent");
  });

  it("row 2: a position with no tyre fitted carries no condition", () => {
    const empty = unit({ id: "u9", positions: [unitPosition({ id: "p1", code: "1" })] });
    const s = at(positionStates(empty, condition()), "p1");
    expect(s.condition).toBeNull();
    expect(s.why).toBe("empty");
  });

  it("row 3: no latest inspection, one that did not read it, or another tyre read, is unread", () => {
    expect(at(positionStates(UNIT, condition({ latest: null })), "p1")).toMatchObject({
      condition: "unread",
      why: "never",
    });
    expect(at(positionStates(UNIT, condition({ latest: inspectionDetail() })), "p1")).toMatchObject(
      { condition: "unread", why: "not-read" },
    );
    const other = inspectionDetail({ readings: [{ ...READ, tyreId: "t9" }] });
    expect(at(positionStates(UNIT, condition({ latest: other })), "p1")).toMatchObject({
      condition: "unread",
      why: "other-tyre",
    });
    const none = inspectionDetail({ readings: [{ ...READ, tyreId: null }] });
    expect(at(positionStates(UNIT, condition({ latest: none })), "p1")).toMatchObject({
      condition: "unread",
      why: "other-tyre",
    });
  });

  it("row 4: an open CRITICAL row naming it is limit, with the row and the reading", () => {
    const row = exceptionRow({
      subjectId: "t1",
      vehicleId: "u9",
      positionCode: "1",
      severity: "CRITICAL",
    });
    const s = at(positionStates(UNIT, condition({ exceptions: [row] })), "p1");
    expect(s.condition).toBe("limit");
    expect(s.why).toBe("read");
    expect(s.exceptions).toEqual([row]);
    expect(s.reading).toEqual(READ);
  });

  it("row 5: only a WARNING row is near", () => {
    const row = exceptionRow({
      subjectId: "t1",
      vehicleId: "u9",
      positionCode: "1",
      severity: "WARNING",
    });
    expect(at(positionStates(UNIT, condition({ exceptions: [row] })), "p1").condition).toBe("near");
  });

  it("row 6: no row, or only an INFO row, is ok, the INFO row still listed", () => {
    expect(at(positionStates(UNIT, condition()), "p1").condition).toBe("ok");
    const info = exceptionRow({
      subjectId: "t1",
      vehicleId: "u9",
      positionCode: "1",
      severity: "INFO",
    });
    const s = at(positionStates(UNIT, condition({ exceptions: [info] })), "p1");
    expect(s.condition).toBe("ok");
    expect(s.exceptions).toEqual([info]);
  });

  it("a dual-mate row marks both positions it names", () => {
    const dual = unit({
      id: "u9",
      positions: [
        unitPosition({ id: "p7", code: "7", fitment: openFitment({ tyreId: "t7" }) }),
        unitPosition({ id: "p8", code: "8", fitment: openFitment({ tyreId: "t8" }) }),
      ],
    });
    const latest = inspectionDetail({
      readings: [
        inspectionReading({ positionId: "p7", positionCode: "7", tyreId: "t7" }),
        inspectionReading({ positionId: "p8", positionCode: "8", tyreId: "t8" }),
      ],
    });
    const row = exceptionRow({
      subjectId: "t7",
      vehicleId: "u9",
      ruleCode: "FR-EXC-036",
      severity: "WARNING",
      positionCode: "7",
      positionCode2: "8",
    });
    const states = positionStates(dual, { latest, exceptions: [row] });
    expect(at(states, "p7").condition).toBe("near");
    expect(at(states, "p8").condition).toBe("near");
  });

  it("matches positions within the unit, so another unit's row at the same code never reaches it", () => {
    const elsewhere = exceptionRow({
      subjectId: "t5",
      vehicleId: "u5",
      positionCode: "1",
      severity: "CRITICAL",
    });
    const s = at(positionStates(UNIT, condition({ exceptions: [elsewhere] })), "p1");
    expect(s.condition).toBe("ok");
    expect(s.exceptions).toEqual([]);
  });
});

describe("unitLevelExceptions", () => {
  it("returns the rows that name no position", () => {
    const unitRow = exceptionRow({
      subjectId: "u9",
      vehicleId: "u9",
      ruleCode: "FR-EXC-039",
      subjectType: "VEHICLE",
      positionCode: null,
    });
    const positionRow = exceptionRow({ subjectId: "t1", vehicleId: "u9", positionCode: "1" });
    expect(unitLevelExceptions(condition({ exceptions: [unitRow, positionRow] }))).toEqual([
      unitRow,
    ]);
  });
});
