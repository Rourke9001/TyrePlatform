import { describe, expect, it } from "vitest";
import { formatMoney, moneyOrEmpty, moneyText, type Money } from "./money";

const rand = (s: string) => s as Money;

describe("formatMoney", () => {
  it("renders the suite's own figures without reading them as numbers", () => {
    expect(formatMoney(rand("16537.50"), "ZAR")).toBe("R16,537.50");
    expect(formatMoney(rand("1837.50"), "ZAR")).toBe("R1,837.50");
    expect(formatMoney(rand("70183.50"), "ZAR")).toBe("R70,183.50");
  });
  it("keeps a cent-exact string a double would have rounded", () => {
    expect(formatMoney(rand("1954.25"), "ZAR")).toBe("R1,954.25");
    expect(formatMoney(rand("0.10"), "ZAR")).toBe("R0.10");
  });
  it("handles a whole amount and a negative", () => {
    expect(formatMoney(rand("500"), "ZAR")).toBe("R500.00");
    expect(formatMoney(rand("-1234.5"), "ZAR")).toBe("-R1,234.50");
  });
  it("shows a scale the server sent rather than dropping a digit", () => {
    expect(formatMoney(rand("1234.567"), "ZAR")).toBe("R1,234.567");
    expect(formatMoney(rand("205.7100"), "ZAR")).toBe("R205.7100");
  });
  // FR-CFG-022: the symbol follows the tenant's currency code through a
  // platform map; a code the map does not hold prints as itself, and no
  // code at all prints the bare figure rather than a wrong symbol.
  it("takes its symbol from the currency code, falling back to the code", () => {
    expect(formatMoney(rand("1234.00"), "USD")).toBe("USD 1,234.00");
    expect(formatMoney(rand("-1234.00"), "USD")).toBe("-USD 1,234.00");
    expect(formatMoney(rand("1234.00"), "")).toBe("1,234.00");
  });
});

// U36: null with moneyVisible false is a projection, null with it true is
// "every member unvalued"; neither is ever 0 (NFR-PRO-002/003).
describe("moneyText", () => {
  it("formats a figure, names a hidden one and names an unvalued one", () => {
    expect(moneyText("16537.50" as Money, true, "ZAR")).toBe("R16,537.50");
    expect(moneyText(null, false, "ZAR")).toBe("Hidden");
    expect(moneyText(null, true, "ZAR")).toBe("Not valued");
    expect(moneyText("1.00" as Money, false, "ZAR")).toBe("Hidden");
  });
});

// U36, U44: a set with no tyre also sends null, and that null is the empty
// set, not "every member unvalued"; Hidden still wins over it.
describe("moneyOrEmpty", () => {
  it("names an empty set, keeps Hidden ahead of it and Not valued for a set of unvalued tyres", () => {
    expect(moneyOrEmpty(null, true, 0, "None at risk", "ZAR")).toBe("None at risk");
    expect(moneyOrEmpty(null, false, 0, "None at risk", "ZAR")).toBe("Hidden");
    expect(moneyOrEmpty(null, true, 3, "None at risk", "ZAR")).toBe("Not valued");
    expect(moneyOrEmpty("16537.50" as Money, true, 9, "None at risk", "ZAR")).toBe("R16,537.50");
  });
});
