import { describe, expect, it } from "vitest";

import { diagramSide } from "./side";

describe("diagramSide", () => {
  it("maps the wire's two sides and leaves anything else unset", () => {
    expect(diagramSide("LEFT")).toBe("left");
    expect(diagramSide("RIGHT")).toBe("right");
    expect(diagramSide(null)).toBeUndefined();
    expect(diagramSide("MIDDLE")).toBeUndefined();
  });
});
