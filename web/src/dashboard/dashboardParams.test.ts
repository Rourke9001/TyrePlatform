import { describe, expect, it } from "vitest";

import { readDashboardParams, withDepot, writeDashboardParams } from "./dashboardParams";

describe("dashboard params", () => {
  // U52: from and to travel together or not at all; the API 400s otherwise.
  it("keeps a period only when both bounds are present", () => {
    expect(readDashboardParams(new URLSearchParams("from=2026-07-01"))).toEqual({});
    expect(
      readDashboardParams(new URLSearchParams("depot=d1&from=2026-07-01&to=2026-08-01")),
    ).toEqual({ depot: "d1", from: "2026-07-01", to: "2026-08-01" });
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
