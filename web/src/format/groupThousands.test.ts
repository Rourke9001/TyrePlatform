import { describe, expect, it } from "vitest";

import { groupThousands } from "./groupThousands";

describe("groupThousands", () => {
  it("writes a comma between each three digits from the right (U55)", () => {
    expect(groupThousands("0")).toBe("0");
    expect(groupThousands("999")).toBe("999");
    expect(groupThousands("1000")).toBe("1,000");
    expect(groupThousands("416180")).toBe("416,180");
    expect(groupThousands("1234567")).toBe("1,234,567");
    expect(groupThousands("-1234")).toBe("-1,234");
  });

  // The capture readout shows a placeholder of zeros before the first key.
  it("groups leading zeros like any other digit", () => {
    expect(groupThousands("000000")).toBe("000,000");
  });
});
