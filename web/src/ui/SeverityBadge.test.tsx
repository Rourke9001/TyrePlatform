import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeverityBadge } from "./SeverityBadge";

describe("SeverityBadge", () => {
  // NFR-USE-009: the word is the encoding; colour and the glyph reinforce it.
  it("renders the severity as a word, not only a colour", () => {
    render(<SeverityBadge severity="CRITICAL" />);
    const badge = screen.getByText("Critical");
    expect(badge.closest("[data-severity]")).toHaveAttribute("data-severity", "CRITICAL");
  });

  it("passes an unknown code through as its own label", () => {
    render(<SeverityBadge severity="SEVERE" />);
    expect(screen.getByText("SEVERE")).toBeInTheDocument();
  });
});
