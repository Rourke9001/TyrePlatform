import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { StatTile } from "./StatTile";

describe("StatTile", () => {
  it("names the figure, its qualifier, its clock and where the list is", () => {
    render(
      <MemoryRouter>
        <StatTile
          label="Open exceptions"
          value="19"
          qualifier="11 critical"
          judged="as inspected"
          to="/exceptions"
          linkLabel="See the list"
          requirement="FR-DSH-003"
        />
      </MemoryRouter>,
    );
    const tile = screen.getByRole("article", { name: "Open exceptions" });
    expect(tile).toHaveAttribute("data-requirement", "FR-DSH-003");
    expect(tile).toHaveTextContent("19");
    expect(tile).toHaveTextContent("11 critical");
    expect(tile).toHaveTextContent("as inspected");
    expect(screen.getByRole("link", { name: "See the list" })).toHaveAttribute(
      "href",
      "/exceptions",
    );
  });

  it("renders without a router when it has no link", () => {
    render(<StatTile label="Overdue tasks" value="0" />);
    expect(screen.getByRole("article", { name: "Overdue tasks" })).toHaveTextContent("0");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
