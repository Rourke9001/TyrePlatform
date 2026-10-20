import { describe, expect, it } from "vitest";

import { formatTreadAge } from "./treadAge";

// FR-TYR-017: the age is a count of the tenant's calendar days, sent by the
// server (app.tenant_days_since); this only words it.
describe("formatTreadAge", () => {
  it("words a day count", () => {
    expect(formatTreadAge(0)).toBe("today");
    expect(formatTreadAge(1)).toBe("1 day ago");
    expect(formatTreadAge(2)).toBe("2 days ago");
    expect(formatTreadAge(1234)).toBe("1,234 days ago");
  });
  // A reading stamped a moment ahead of the server's day boundary is still
  // today's, never a negative age.
  it("reads a negative count as today", () => {
    expect(formatTreadAge(-1)).toBe("today");
  });
});
