import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Banner } from "./Banner";

describe("Banner", () => {
  it("Banner critical and warning are alerts, info and success status", () => {
    render(
      <>
        <Banner tone="critical" title="Two inspections need the office" />
        <Banner tone="warning" title="Held for two days" />
        <Banner tone="info" title="Sandbox data" />
        <Banner tone="success" title="Inspection sent" />
      </>,
    );
    expect(screen.getAllByRole("alert").map((el) => el.textContent)).toEqual([
      "Two inspections need the office",
      "Held for two days",
    ]);
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([
      "Sandbox data",
      "Inspection sent",
    ]);
  });

  it("is info by default, with a body and one action", () => {
    const { container } = render(
      <Banner title="Readings saved" action={<button type="button">Sync now</button>}>
        They send when the signal returns.
      </Banner>,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("tr-banner", "tr-banner--info");
    expect(within(banner).getByText("They send when the signal returns.")).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Sync now" })).toBeInTheDocument();
    expect(container.querySelector(".tr-banner__icon")).toHaveAttribute("aria-hidden", "true");
  });

  it("passes unknown props to its root", () => {
    render(<Banner tone="warning" title="Stale" data-testid="stale" aria-live="polite" />);
    expect(screen.getByTestId("stale")).toHaveAttribute("aria-live", "polite");
  });
});
