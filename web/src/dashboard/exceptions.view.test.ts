import { describe, expect, it } from "vitest";

import { exceptionRow } from "../test/fixtures";
import {
  exceptionRows,
  exceptionsLede,
  readExceptionsParams,
  ruleOptions,
  severityOptions,
  writeExceptionsParams,
} from "./exceptions.view";

const instant = (at: string) => `I(${at})`;

describe("the exceptions URL", () => {
  // The order the params are read in is the order the request URL carries
  // them, so a link and a picked filter ask for the same URL.
  it("reads every filter in a fixed order, resolved as includeResolved", () => {
    const params = readExceptionsParams(
      new URLSearchParams("resolved=true&depot=d1&rule=FR-EXC-020&severity=CRITICAL"),
    );
    expect(params).toEqual({
      severity: "CRITICAL",
      rule: "FR-EXC-020",
      depot: "d1",
      includeResolved: true,
    });
    expect(Object.keys(params)).toEqual(["severity", "rule", "depot", "includeResolved"]);
  });

  it("drops an empty filter and any resolved but true", () => {
    expect(readExceptionsParams(new URLSearchParams("severity=&resolved=yes"))).toEqual({});
  });

  it("writes resolved for includeResolved, and nothing for an unset filter", () => {
    expect(
      writeExceptionsParams({
        depot: "d1",
        severity: "CRITICAL",
        includeResolved: true,
      }).toString(),
    ).toBe("severity=CRITICAL&depot=d1&resolved=true");
    expect(writeExceptionsParams({ includeResolved: false }).toString()).toBe("");
  });
});

describe("exceptionsLede", () => {
  // U18, U55: the count and the clock it is judged at; one is singular.
  it("counts the rows and names the clock", () => {
    expect(exceptionsLede(4, "SUBMITTED_AT", undefined, undefined)).toBe(
      "4 exceptions, as inspected",
    );
    expect(exceptionsLede(1, "SUBMITTED_AT", undefined, undefined)).toBe(
      "1 exception, as inspected",
    );
  });

  // U17: a depot view names its depot, or says one depot until it is known.
  it("names the depot of a depot view", () => {
    expect(exceptionsLede(4, "SUBMITTED_AT", "d1", "Johannesburg")).toBe(
      "4 exceptions, as inspected, at Johannesburg",
    );
    expect(exceptionsLede(4, "SUBMITTED_AT", "d1", undefined)).toBe(
      "4 exceptions, as inspected, at one depot",
    );
  });
});

describe("the filter options", () => {
  it("offers every severity in words after all of them", () => {
    expect(severityOptions()).toEqual([
      { value: "", label: "All severities" },
      { value: "CRITICAL", label: "Critical" },
      { value: "WARNING", label: "Warning" },
      { value: "INFO", label: "Info" },
    ]);
  });

  // A link from a tile always finds its rule in the list, even when no row
  // carries it.
  it("offers the codes present plus the one chosen, once each, sorted", () => {
    const rows = [
      exceptionRow({ subjectId: "a", ruleCode: "FR-EXC-035" }),
      exceptionRow({ subjectId: "b", ruleCode: "FR-EXC-020" }),
      exceptionRow({ subjectId: "c", ruleCode: "FR-EXC-035" }),
    ];
    expect(ruleOptions(rows, "FR-EXC-022")).toEqual([
      { value: "", label: "All rules" },
      { value: "FR-EXC-020", label: "FR-EXC-020" },
      { value: "FR-EXC-022", label: "FR-EXC-022" },
      { value: "FR-EXC-035", label: "FR-EXC-035" },
    ]);
    expect(ruleOptions([], undefined)).toEqual([{ value: "", label: "All rules" }]);
  });
});

describe("exceptionRows", () => {
  // U18: the measure and the threshold it was judged against share a unit.
  it("writes the measure against its threshold, in mm or in %", () => {
    const [mm, pct, none] = exceptionRows(
      [
        exceptionRow({ subjectId: "a" }),
        exceptionRow({
          subjectId: "b",
          measureMm: null,
          thresholdMm: null,
          measurePct: 26.666666666666668,
          thresholdPct: 80,
        }),
        exceptionRow({ subjectId: "c", measureMm: null, thresholdMm: null }),
      ],
      instant,
    );
    expect(mm.measure).toBe("1.0 mm of 4.0 mm");
    expect(pct.measure).toBe("27% of 80%");
    expect(none.measure).toBe("not measured");
  });

  // FR-TYR-017: the sheet's age joins its time; rule 6: the instant is the
  // tenant's, through the formatter the screen passes.
  it("gives each row its key, subject, time with age and replaced flag", () => {
    const [row] = exceptionRows(
      [
        exceptionRow({
          subjectId: "c",
          subjectType: "POSITION_PAIR",
          positionCode: "8",
          positionCode2: "7",
          resolvedByFitment: true,
        }),
      ],
      instant,
    );
    expect(row).toEqual({
      key: "FR-EXC-020:c:i1",
      ruleName: "Tread below removal threshold",
      ruleCode: "FR-EXC-020",
      severity: "CRITICAL",
      tone: "critical",
      vehicleId: "v1",
      fleetNumber: "HORSE",
      position: "8 and 7",
      measure: "1.0 mm of 4.0 mm",
      seen: "I(2026-07-23T05:46:30Z), 90 days ago",
      replaced: "Yes",
    });
  });

  // The critical edge sits beside the badge's word, never instead of it.
  it("marks only a critical row with the critical edge", () => {
    const [warning] = exceptionRows(
      [exceptionRow({ subjectId: "w", severity: "WARNING" })],
      instant,
    );
    expect(warning.tone).toBeUndefined();
    expect(warning.replaced).toBe("No");
  });
});
