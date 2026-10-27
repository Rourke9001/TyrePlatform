import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("heads the page at level 1 with its eyebrow, description and actions", () => {
    render(
      <PageHeader
        title="Exceptions"
        eyebrow="Fleet"
        description="What needs a person, judged at each unit's latest inspection."
        actions={<button type="button">Refresh</button>}
        data-requirement="FR-EXC-001"
      />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Exceptions" });
    // Inside a shell, a header element would read as a second banner.
    expect(screen.queryByRole("banner")).toBeNull();
    const header = heading.closest(".tr-pagehead");
    expect(header).toHaveAttribute("data-requirement", "FR-EXC-001");
    expect(header).toHaveTextContent("Fleet");
    expect(header).toHaveTextContent("judged at each unit's latest inspection");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("links back through the router", () => {
    render(
      <MemoryRouter>
        <PageHeader title="TRK-01" back={{ label: "Units", to: "/fleet" }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Units" })).toHaveAttribute("href", "/fleet");
  });
});
