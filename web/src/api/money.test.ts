import { describe, expect, it } from "vitest";
import { formatRand, type Money } from "./money";

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
