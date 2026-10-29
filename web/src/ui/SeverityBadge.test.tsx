import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SeverityBadge } from "./SeverityBadge";

describe("SeverityBadge", () => {
  it("SeverityBadge renders Critical, Warning, Info with a count", () => {
    render(
      <>
        <SeverityBadge severity="critical" label="Critical" count={4} data-testid="critical" />
        <SeverityBadge severity="warning" label="Warning" count={1200} data-testid="warning" />
        <SeverityBadge severity="info" label="Info" count={0} data-testid="info" />
      </>,
    );
    expect(screen.getByTestId("critical")).toHaveTextContent(/^Critical 4$/);
    expect(screen.getByTestId("critical")).toHaveClass("tr-badge--critical");
    // U55: a displayed number groups its thousands with a comma.
    expect(screen.getByTestId("warning")).toHaveTextContent(/^Warning 1,200$/);
    expect(screen.getByTestId("warning")).toHaveClass("tr-badge--warn");
    expect(screen.getByTestId("info")).toHaveTextContent(/^Info 0$/);
    expect(screen.getByTestId("info")).toHaveClass("tr-badge--info");
  });

  it("shows the word alone without a count, in a glyph per severity", () => {
    const { container } = render(
      <>
        <SeverityBadge severity="critical" label="Critical" />
        <SeverityBadge severity="warning" label="Warning" />
        <SeverityBadge severity="info" label="Info" />
      </>,
    );
    expect(screen.getByText("Critical")).toHaveTextContent(/^Critical$/);
    const glyphs = [...container.querySelectorAll("svg")];
    expect(new Set(glyphs.map((svg) => svg.innerHTML)).size).toBe(3);
    for (const svg of glyphs) expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  // TYRE-270: the words are vocabulary.ts's, so the badge brings none.
  it("says the caller's word and no word of its own", () => {
    render(<SeverityBadge severity="critical" label="Urgent" count={2} size="md" />);
    expect(screen.getByText("Urgent")).toHaveClass("tr-badge--md");
    expect(screen.queryByText(/Critical/)).toBeNull();
  });
});
