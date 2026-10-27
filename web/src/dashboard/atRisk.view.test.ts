import { describe, expect, it } from "vitest";

import { atRiskTyre, dashboardBody } from "../test/fixtures";
import { atRiskClassView, atRiskLede, atRiskRows } from "./atRisk.view";

const instant = (at: string) => `I(${at})`;

describe("atRiskClassView", () => {
  // U47: the hero's words for the same breakdown; rule 2: the figure is the
  // wire string, handed on untouched with the set it sums (U36).
  it("hands the class's figure on as the wire string, worded as the hero words it", () => {
    const { running } = dashboardBody().valueAtRisk;
    expect(atRiskClassView(running)).toEqual({
      value: {
        value: "16537.50",
        visible: true,
        set: { tyreCount: 9, empty: "None at risk" },
      },
      detail: "9 tyres: 0 at actual cost, 9 estimated or audit, of which 9 audit; 0 unvalued",
    });
  });

  // U55: one tyre is singular; U27: each count is its own field.
  it("reads each count from its own field, one tyre in the singular", () => {
    const view = atRiskClassView({
      tyreCount: 1,
      actualCount: 2,
      estimatedOrAuditCount: 3,
      auditCount: 4,
      unvaluedCount: 5,
      casingValueAtRisk: null,
    });
    expect(view.detail).toBe(
      "1 tyre: 2 at actual cost, 3 estimated or audit, of which 4 audit; 5 unvalued",
    );
    expect(view.value.value).toBeNull();
  });
});

describe("atRiskLede", () => {
  it("names the clock, and the depot of a depot view", () => {
    expect(atRiskLede("TODAY", undefined, undefined)).toBe(
      "Tyres at or below the removal threshold, judged today",
    );
    expect(atRiskLede("TODAY", "d1", "Johannesburg")).toBe(
      "Tyres at or below the removal threshold, judged today, at Johannesburg",
    );
    expect(atRiskLede("TODAY", "d1", undefined)).toBe(
      "Tyres at or below the removal threshold, judged today, at one depot",
    );
  });
});

describe("atRiskRows", () => {
  // U18: tread against the threshold it was judged at; ADR-0010: the
  // casing value never stands without its basis.
  it("writes each tyre's tread, source, read time, value and basis", () => {
    const [row] = atRiskRows([atRiskTyre({ tyreId: "t1" })], instant);
    expect(row).toEqual({
      key: "t1",
      code: "2102BAC7",
      vehicleId: "v1",
      fleetNumber: "HORSE",
      position: "7",
      tread: "1.0 mm of 4.0 mm",
      source: "inspection reading",
      read: "I(2026-07-23T05:46:30Z), 90 days ago",
      value: { value: "1837.50", visible: true },
      basis: "audit valuation",
    });
  });

  // FR-TYR-017: a dated read with no age shows its time alone; an undated
  // one keeps its absence.
  it("shows a read's age only where the server sends one", () => {
    const [noAge, undated] = atRiskRows(
      [
        atRiskTyre({ tyreId: "t2", treadAgeDays: null }),
        atRiskTyre({ tyreId: "t3", readAt: null, treadAgeDays: null, treadSource: "AUDIT" }),
      ],
      instant,
    );
    expect(noAge.read).toBe("I(2026-07-23T05:46:30Z)");
    expect(undated.read).toBe("not dated");
    expect(undated.source).toBe("measured outside an inspection");
  });

  // U36: an unvalued casing is a null figure and its basis says so.
  it("hands an unvalued casing on as null with its basis in words", () => {
    const [row] = atRiskRows(
      [atRiskTyre({ tyreId: "t4", casingValue: null, casingBasis: "UNVALUED" })],
      instant,
    );
    expect(row.value).toEqual({ value: null, visible: true });
    expect(row.basis).toBe("not valued");
  });
});
