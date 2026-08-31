import { describe, expect, it } from "vitest";

import { formatTenantDate } from "./tenantTime";

// A fixed instant in two zones 25 hours apart. Their civil dates can never
// agree, so this asserts the zone is honoured no matter where it runs — which
// is the whole point of the rule (rule 6, FR-TEN-005).
describe("formatTenantDate", () => {
  const instant = "2026-01-01T23:00:00Z";

  // Exact strings, not toContain: "2026" contains "02", so a substring
  // assertion on the day could never fail (docs/lessons.md, 20 Aug).
  it("renders the tenant's civil date, not the runner's", () => {
    expect(formatTenantDate(instant, "Pacific/Kiritimati")).toBe("02 Jan 2026");
    expect(formatTenantDate(instant, "Pacific/Midway")).toBe("01 Jan 2026");
  });

  it("puts a South African tenant on its own day for an instant captured abroad", () => {
    // 22:30 UTC is already the next day in Johannesburg (UTC+2).
    expect(formatTenantDate("2026-03-14T22:30:00Z", "Africa/Johannesburg")).toBe("15 Mar 2026");
    expect(formatTenantDate("2026-03-14T22:30:00Z", "America/Los_Angeles")).toBe("14 Mar 2026");
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(formatTenantDate(new Date(instant), "Pacific/Midway")).toEqual(
      formatTenantDate(instant, "Pacific/Midway"),
    );
  });
});
