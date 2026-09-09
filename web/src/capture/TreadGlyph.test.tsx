import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { TreadGlyph } from "./TreadGlyph";

describe("TreadGlyph", () => {
  // FR-CFG-024: the frame is the plan view (top down), never the observer's.
  // A left-side and a right-side tyre are mirror images, and the picture is
  // the one training message BR-VEH-001 asks for: no inner/outer words.
  it("draws a left-side tyre and a right-side tyre as mirror images", () => {
    const { container, rerender } = render(<TreadGlyph side="LEFT" count={3} />);
    const left = screen.getByRole("img", { name: /left side of the vehicle/i });
    expect(left).toHaveAttribute("data-side", "LEFT");
    // Only the centreline moves between sides: right of the tyre for LEFT,
    // left of the tyre for RIGHT. The reading digits never move. See the
    // next assertions and the second test below.
    expect(left.querySelector("line")).toHaveAttribute("x1", "92");
    const leftTexts = left.querySelectorAll("text");
    const leftFirstX = leftTexts[0].getAttribute("x");
    const leftLastX = leftTexts[leftTexts.length - 1].getAttribute("x");

    rerender(<TreadGlyph side="RIGHT" count={3} />);
    const right = screen.getByRole("img", { name: /right side of the vehicle/i });
    expect(right).toHaveAttribute("data-side", "RIGHT");
    expect(right.querySelector("line")).toHaveAttribute("x1", "8");
    // Digit 1 is the sheet's leftmost field on both sides (FR-INS-029a maps
    // ordinal 1 by side, not by screen position), so its x must not have
    // moved when the side flipped. Only the centreline did.
    const rightTexts = right.querySelectorAll("text");
    expect(rightTexts[0].getAttribute("x")).toBe(leftFirstX);
    expect(Number(leftFirstX)).toBeLessThan(Number(leftLastX));
    expect(Number(rightTexts[0].getAttribute("x"))).toBeLessThan(
      Number(rightTexts[rightTexts.length - 1].getAttribute("x")),
    );
    expectNothingForbiddenSpoken(container, /right side of the vehicle/i);
  });

  it("numbers the readings 1 to count, left to right, on either side", () => {
    const { rerender } = render(<TreadGlyph side="LEFT" count={3} />);
    expect(screen.getByRole("img").textContent).toBe("123");

    rerender(<TreadGlyph side="RIGHT" count={3} />);
    expect(screen.getByRole("img").textContent).toBe("123");
  });
});
