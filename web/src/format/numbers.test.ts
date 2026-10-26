import { describe, expect, it } from "vitest";

import { formatCount, formatMm, formatPct, plural, pluralWord } from "./numbers";

// U55: the count is grouped; the noun is singular at exactly one.
describe("plural and pluralWord", () => {
  it("says one of a thing at 1 and many at any other count", () => {
    expect(plural(1, "tyre", "tyres")).toBe("1 tyre");
    expect(plural(0, "tyre", "tyres")).toBe("0 tyres");
    expect(plural(2, "day", "days")).toBe("2 days");
    expect(plural(1234, "tyre", "tyres")).toBe("1,234 tyres");
    expect(pluralWord(1, "running position", "running positions")).toBe("running position");
    expect(pluralWord(9, "running position", "running positions")).toBe("running positions");
  });
});

describe("formatCount, formatMm and formatPct", () => {
  it("groups thousands, always shows one decimal of tread and none of a percentage", () => {
    // U55: a comma, as money groups.
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
    expect(formatMm(2)).toBe("2.0 mm");
    expect(formatMm(4)).toBe("4.0 mm");
    expect(formatMm(4.5)).toBe("4.5 mm");
    expect(formatPct(44.44)).toBe("44%");
    expect(formatPct(100)).toBe("100%");
  });

  it("makes a fraction whole before grouping it", () => {
    expect(formatCount(1234.5678)).toBe("1,235");
    expect(formatCount(0.1 + 0.2)).toBe("0");
    expect(formatCount(-0.4)).toBe("0");
    expect(formatPct(-2.5)).toBe("-3%");
    expect(formatPct(2.5)).toBe("3%");
  });
});
