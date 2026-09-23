import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("is the page's one h1 with the eyebrow, lede and actions around it", () => {
    render(
      <PageHeader
        title="Dashboard"
        eyebrow="BAC Transport"
        lede="As at 21 Sep 2026, 08:00"
        actions={<button type="button">Refresh</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("BAC Transport")).toBeInTheDocument();
    expect(screen.getByText("As at 21 Sep 2026, 08:00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
