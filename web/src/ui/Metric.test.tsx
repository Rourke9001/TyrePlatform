import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { Metric } from "./Metric";

describe("Metric", () => {
  it("Metric renders as an article with data-requirement", () => {
    render(
      <Metric
        label="Open exceptions"
        value="19"
        detail={<p>11 urgent; 9 rules configured</p>}
        data-requirement="FR-DSH-003"
        tone="critical"
      >
        <p>as inspected</p>
      </Metric>,
    );
    const tile = screen.getByRole("article", { name: "Open exceptions" });
    expect(tile).toHaveAttribute("data-requirement", "FR-DSH-003");
    // The figure stands alone in its element, so a page can find it exactly.
    expect(within(tile).getByText("19")).toBeInTheDocument();
    expect(tile).toHaveTextContent("11 urgent; 9 rules configured");
    expect(tile).toHaveTextContent("as inspected");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("Metric is an article named by its label, at the given heading level, with its own link", () => {
    render(
      <MemoryRouter>
        <Metric
          label="Below the removal threshold"
          value="9"
          unit="tyres"
          headingLevel={2}
          link={{ to: "/at-risk", label: "See the at-risk list" }}
        />
      </MemoryRouter>,
    );
    const tile = screen.getByRole("article", { name: "Below the removal threshold" });
    expect(
      within(tile).getByRole("heading", { level: 2, name: "Below the removal threshold" }),
    ).toBeInTheDocument();
    expect(within(tile).queryByRole("heading", { level: 3 })).toBeNull();
    expect(within(tile).getByText("9")).toBeInTheDocument();
    expect(tile).toHaveTextContent("tyres");
    // The link is the caller's words and nothing else; the tile is no anchor.
    const link = within(tile).getByRole("link", { name: "See the at-risk list" });
    expect(link).toHaveAttribute("href", "/at-risk");
    expect(tile.tagName).toBe("ARTICLE");
    expect(tile.closest("a")).toBeNull();
  });

  it("heads its label at level 3 by default", () => {
    render(<Metric label="Overdue tasks" value="0" />);
    expect(screen.getByRole("heading", { level: 3, name: "Overdue tasks" })).toBeInTheDocument();
  });
});
