import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Condition } from "./condition";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  // Rule 5: the badge names a condition it is given in the caller's words,
  // so capture keeps its own.
  it("StatusBadge renders the given label", () => {
    const { container } = render(<StatusBadge status="near" label="Check" />);
    expect(screen.getByText("Check")).toHaveClass("tr-badge", "tr-badge--warn");
    expect(container).toHaveTextContent(/^Check$/);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives each condition its own tone and glyph", () => {
    const tones: [Condition, string][] = [
      ["ok", "tr-badge--ok"],
      ["near", "tr-badge--warn"],
      ["limit", "tr-badge--critical"],
      ["unread", "tr-badge--unread"],
      ["nospare", "tr-badge--neutral"],
    ];
    const glyphs = new Set<string>();
    for (const [status, tone] of tones) {
      const { container, unmount } = render(<StatusBadge status={status} label={status} />);
      expect(screen.getByText(status)).toHaveClass(tone);
      glyphs.add(container.querySelector("svg")?.innerHTML ?? "");
      unmount();
    }
    expect(glyphs.size).toBe(5);
  });

  it("takes the md size and passes unknown props on", () => {
    render(<StatusBadge status="ok" label="OK" size="md" data-testid="badge" />);
    expect(screen.getByTestId("badge")).toHaveClass("tr-badge--md");
  });
});
