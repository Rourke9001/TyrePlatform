import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { AtRiskClass } from "../api/dashboard";
import { dashboardBody } from "../test/fixtures";
import { ValueAtRiskHero } from "./ValueAtRiskHero";

// What valuation.go sends for a class with no tyre at or below the
// threshold: every count 0 and the money null.
const emptyClass: AtRiskClass = {
  tyreCount: 0,
  actualCount: 0,
  estimatedOrAuditCount: 0,
  auditCount: 0,
  unvaluedCount: 0,
  casingValueAtRisk: null,
};

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
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(within(hero).getByText("Hidden")).toBeInTheDocument();
    expect(hero).toHaveTextContent("Spares: Hidden from 1 tyre");
    expect(hero).not.toHaveTextContent("R0.00");
    expect(hero).not.toHaveTextContent("Not valued");
    // ADR-0013 decision 4: no link to a screen the reader cannot open.
    expect(screen.queryByRole("link", { name: "See the at-risk list" })).toBeNull();
  });

  // U27, U18: fields that share no value, so each figure reads its own; the
  // count behind the figure is the register's below-threshold count, not
  // the class's tyreCount, which comes from another view.
  it("reads each running count from its own field and the count from below-threshold", () => {
    const base = dashboardBody().valueAtRisk;
    renderHero({
      valueAtRisk: {
        ...base,
        running: {
          ...base.running,
          tyreCount: 9,
          actualCount: 1,
          estimatedOrAuditCount: 6,
          auditCount: 4,
          unvaluedCount: 2,
        },
      },
      belowThreshold: { judgedAt: "TODAY", running: 8, spare: 1 },
    });
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(
      within(hero).getByText("from 8 running tyres at or below the removal threshold today"),
    ).toBeInTheDocument();
    expect(
      within(hero).getByText(
        "1 at actual cost, 6 estimated or audit, of which 4 audit; 2 unvalued",
      ),
    ).toBeInTheDocument();
    expect(
      within(hero).getByRole("img", {
        name: "Running value at risk provenance: Actual 1, Estimated or audit 6, Unvalued 2",
      }),
    ).toBeInTheDocument();
  });

  // U55: one of a thing is singular, on the qualifier and on the spare line.
  it("says one running tyre and one spare tyre in the singular", () => {
    renderHero({ belowThreshold: { judgedAt: "TODAY", running: 1, spare: 1 } });
    expect(
      screen.getByText("from 1 running tyre at or below the removal threshold today"),
    ).toBeInTheDocument();
    expect(screen.getByText("Spares: R1,837.50 from 1 tyre")).toBeInTheDocument();
  });

  // U36, U44: a class with no tyre at risk also sends null. That is the
  // empty set, never "Not valued".
  it("says none at risk and no spares at risk for two empty classes", () => {
    renderHero({
      valueAtRisk: { judgedAt: "TODAY", running: emptyClass, spare: emptyClass },
      belowThreshold: { judgedAt: "TODAY", running: 0, spare: 0 },
    });
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(within(hero).getByText("None at risk")).toBeInTheDocument();
    expect(
      within(hero).getByText("No spares at or below the removal threshold"),
    ).toBeInTheDocument();
    expect(
      within(hero).getByText("from 0 running tyres at or below the removal threshold today"),
    ).toBeInTheDocument();
    expect(hero).not.toHaveTextContent("Not valued");
  });

  // U36: the projection wins over the empty set.
  it("says Hidden for an empty class when the actor may not see money", () => {
    renderHero({
      moneyVisible: false,
      valueAtRisk: { judgedAt: "TODAY", running: emptyClass, spare: emptyClass },
      belowThreshold: { judgedAt: "TODAY", running: 0, spare: 0 },
    });
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(within(hero).getByText("Hidden")).toBeInTheDocument();
    expect(hero).toHaveTextContent("Spares: Hidden");
    expect(hero).not.toHaveTextContent("None at risk");
    expect(hero).not.toHaveTextContent("No spares at or below");
  });

  // U36: a class whose every member is unvalued keeps "Not valued", with
  // the count beside it.
  it("says Not valued for classes whose every tyre is unvalued", () => {
    renderHero({
      valueAtRisk: {
        judgedAt: "TODAY",
        running: { ...emptyClass, tyreCount: 9, unvaluedCount: 9 },
        spare: { ...emptyClass, tyreCount: 1, unvaluedCount: 1 },
      },
    });
    const hero = screen.getByRole("region", { name: "Value at risk" });
    expect(within(hero).getByText("Not valued")).toBeInTheDocument();
    expect(hero).toHaveTextContent("Spares: Not valued from 1 tyre, 1 unvalued");
    expect(hero).not.toHaveTextContent("None at risk");
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
