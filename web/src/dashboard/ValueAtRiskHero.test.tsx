import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { dashboardBody } from "../test/fixtures";
import { ValueAtRiskHero } from "./ValueAtRiskHero";

function renderHero(overrides: Parameters<typeof dashboardBody>[0] = {}, depot?: string) {
  const body = dashboardBody(overrides);
  return render(
    <MemoryRouter>
      <ValueAtRiskHero
        valueAtRisk={body.valueAtRisk}
        belowThreshold={body.belowThreshold}
        moneyVisible={body.moneyVisible}
        depot={depot}
      />
    </MemoryRouter>,
  );
}

describe("ValueAtRiskHero", () => {
  // H.3 criterion 6: one credible rand figure with its provenance split
  // disclosed. The figure is the wire string formatted, never a sum.
  it("leads with the running figure, its provenance and the count behind it", () => {
    renderHero();
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(hero).toHaveAttribute("data-requirement", "FR-DSH-017");
    expect(screen.getByText("R16,537.50")).toBeInTheDocument();
    expect(hero).toHaveTextContent("from 9 running tyres at or below the removal threshold today");
    expect(hero).toHaveTextContent("of which 9 audit");
    expect(hero).toHaveTextContent("Spares: R1,837.50 from 1 tyre");
    expect(screen.getByRole("link", { name: "See the at-risk list" })).toHaveAttribute(
      "href",
      "/at-risk",
    );
  });

  it("keeps the chosen depot on the at-risk link", () => {
    renderHero({}, "d1");
    expect(screen.getByRole("link", { name: "See the at-risk list" })).toHaveAttribute(
      "href",
      "/at-risk?depot=d1",
    );
  });

  // U36: hidden is a projection, not a zero.
  it("says Hidden when the actor may not see money", () => {
    renderHero({
      moneyVisible: false,
      valueAtRisk: {
        ...dashboardBody().valueAtRisk,
        running: { ...dashboardBody().valueAtRisk.running, casingValueAtRisk: null },
        spare: { ...dashboardBody().valueAtRisk.spare, casingValueAtRisk: null },
      },
    });
    expect(screen.getAllByText("Hidden")).not.toHaveLength(0);
    expect(screen.queryByText("R0.00")).toBeNull();
    // ADR-0013 decision 4: no link to a screen the reader cannot open.
    expect(screen.queryByRole("link", { name: "See the at-risk list" })).toBeNull();
  });

  it("names unvalued tyres rather than pricing them at nothing", () => {
    const base = dashboardBody().valueAtRisk;
    renderHero({
      valueAtRisk: {
        ...base,
        running: { ...base.running, unvaluedCount: 2, estimatedOrAuditCount: 7, auditCount: 7 },
      },
    });
    expect(screen.getByRole("region", { name: "Value at risk" })).toHaveTextContent("2 unvalued");
  });
});
