import { describe, expect, it } from "vitest";

import {
  readDashboardParams,
  settlePeriod,
  withDepot,
  writeDashboardParams,
} from "./dashboardParams";

describe("dashboard params", () => {
  // U52: from and to travel together or not at all; the API 400s otherwise.
  it("keeps a period only when both bounds are present", () => {
    expect(readDashboardParams(new URLSearchParams("from=2026-07-01"))).toEqual({});
    expect(
      readDashboardParams(new URLSearchParams("depot=d1&from=2026-07-01&to=2026-08-01")),
    ).toEqual({ depot: "d1", from: "2026-07-01", to: "2026-08-01" });
  });

  // U52: two whole, ordered dates are a period; two empty fields, or one
  // empty beside a whole date, carry neither. Anything else is still being
  // typed or is wrong, and the request stays as it was.
  it("settles a period only from whole, ordered dates", () => {
    expect(settlePeriod("2026-08-01", "2026-09-01")).toEqual({
      kind: "set",
      from: "2026-08-01",
      to: "2026-09-01",
    });
    expect(settlePeriod("", "")).toEqual({ kind: "none" });
    expect(settlePeriod("2026-08-01", "")).toEqual({ kind: "none" });
    expect(settlePeriod("", "2026-09-01")).toEqual({ kind: "none" });
  });

  // A date input reports each keystroke of a year as a date: typing 2026
  // gives 0002, 0020 and 0202 on the way.
  it("waits on a year still being typed", () => {
    for (const partial of ["0002-08-01", "0020-08-01", "0202-08-01"]) {
      expect(settlePeriod(partial, "2026-09-01")).toEqual({ kind: "wait", misordered: false });
      expect(settlePeriod(partial, "")).toEqual({ kind: "wait", misordered: false });
    }
  });

  // to is exclusive, so a period whose from is not before its to is empty.
  it("refuses a from that is not before the to", () => {
    expect(settlePeriod("2026-09-01", "2026-09-01")).toEqual({ kind: "wait", misordered: true });
    expect(settlePeriod("2026-09-15", "2026-09-01")).toEqual({ kind: "wait", misordered: true });
  });

  it("writes only the set parameters", () => {
    expect(writeDashboardParams({ depot: "d1" }).toString()).toBe("depot=d1");
    expect(writeDashboardParams({}).toString()).toBe("");
  });

  // A tile and the list it opens count the same units (U17).
  it("carries the chosen depot onto a link, and nothing when none is chosen", () => {
    expect(withDepot("/at-risk", "d1")).toBe("/at-risk?depot=d1");
    expect(withDepot("/exceptions?severity=CRITICAL", "d1")).toBe(
      "/exceptions?severity=CRITICAL&depot=d1",
    );
    expect(withDepot("/at-risk")).toBe("/at-risk");
  });
});
