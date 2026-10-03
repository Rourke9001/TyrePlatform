import { describe, expect, it } from "vitest";
import { formatRand, moneyOrEmpty, moneyText, type Money } from "./money";

const rand = (s: string) => s as Money;

describe("formatRand", () => {
  it("renders the suite's own figures without reading them as numbers", () => {
    expect(formatRand(rand("16537.50"))).toBe("R16,537.50");
    expect(formatRand(rand("1837.50"))).toBe("R1,837.50");
    expect(formatRand(rand("70183.50"))).toBe("R70,183.50");
  });
  it("keeps a cent-exact string a double would have rounded", () => {
    expect(formatRand(rand("1954.25"))).toBe("R1,954.25");
    expect(formatRand(rand("0.10"))).toBe("R0.10");
  });
  it("handles a whole rand and a negative", () => {
    expect(formatRand(rand("500"))).toBe("R500.00");
    expect(formatRand(rand("-1234.5"))).toBe("-R1,234.50");
  });
  it("shows a scale the server sent rather than dropping a digit", () => {
    expect(formatRand(rand("1234.567"))).toBe("R1,234.567");
  });
});

// U36: null with moneyVisible false is a projection, null with it true is
// "every member unvalued"; neither is ever 0 (NFR-PRO-002/003).
describe("moneyText", () => {
  it("formats a figure, names a hidden one and names an unvalued one", () => {
    expect(moneyText("16537.50" as Money, true)).toBe("R16,537.50");
    expect(moneyText(null, false)).toBe("Hidden");
    expect(moneyText(null, true)).toBe("Not valued");
    expect(moneyText("1.00" as Money, false)).toBe("Hidden");
  });
});

// U36, U44: a set with no tyre also sends null, and that null is the empty
// set, not "every member unvalued"; Hidden still wins over it.
describe("moneyOrEmpty", () => {
  it("names an empty set, keeps Hidden ahead of it and Not valued for a set of unvalued tyres", () => {
    expect(moneyOrEmpty(null, true, 0, "None at risk")).toBe("None at risk");
    expect(moneyOrEmpty(null, false, 0, "None at risk")).toBe("Hidden");
    expect(moneyOrEmpty(null, true, 3, "None at risk")).toBe("Not valued");
    expect(moneyOrEmpty("16537.50" as Money, true, 9, "None at risk")).toBe("R16,537.50");
  });
});
