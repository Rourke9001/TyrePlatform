import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { TreadGlyph } from "./TreadGlyph";

describe("TreadGlyph", () => {
  // FR-CFG-024: the frame is the plan view (top down), never the observer's.
  // A left-side and a right-side tyre are mirror images, and the picture is
  // the one training message BR-VEH-001 asks for — no inner/outer words.
  it("draws a left-side tyre and a right-side tyre as mirror images", () => {
    const { container, rerender } = render(<TreadGlyph side="LEFT" count={3} />);
    const left = screen.getByRole("img", { name: /left side of the vehicle/i });
    expect(left).toHaveAttribute("data-side", "LEFT");
    // The centreline is drawn once, at the SVG's own right edge (x1="92"),
    // and it is the mirror transform — not a second, hand-drawn line — that
    // puts it on the correct side of the vehicle for a RIGHT tyre.
    expect(left.querySelector("line")).toHaveAttribute("x1", "92");
    expect(left.style.transform).toBe("");

    rerender(<TreadGlyph side="RIGHT" count={3} />);
    const right = screen.getByRole("img", { name: /right side of the vehicle/i });
    expect(right).toHaveAttribute("data-side", "RIGHT");
    expect(right.querySelector("line")).toHaveAttribute("x1", "92");
    expect(right.style.transform).toBe("scaleX(-1)");
    expectNothingForbiddenSpoken(container, /right side of the vehicle/i);
  });

  it("numbers the readings 1 to count, left to right", () => {
    render(<TreadGlyph side="LEFT" count={3} />);
    expect(screen.getByRole("img").textContent).toBe("123");
  });
});
