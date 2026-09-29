import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { dashboardBody } from "../test/fixtures";
import { DashboardTiles } from "./DashboardTiles";

function renderTiles(overrides: Parameters<typeof dashboardBody>[0] = {}, depot?: string) {
  return render(
    <MemoryRouter>
      <DashboardTiles body={dashboardBody(overrides)} depot={depot} />
    </MemoryRouter>,
  );
}

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("DashboardTiles", () => {
  // The accepted mockup's order: estate, then exceptions, then units.
  it("lays the panels out in the accepted mockup's order", () => {
    renderTiles();
    const estate = screen.getByRole("region", { name: "Estate value" });
    const exceptions = screen.getByRole("region", { name: "Exceptions" });
    const units = screen.getByRole("region", { name: "Units" });
    expect(follows(estate, exceptions)).toBe(true);
    expect(follows(exceptions, units)).toBe(true);
  });

  // The three-way agreement's rendered half: 19 open, 11 urgent, 9 below.
  it("renders the exception counts as inspected and the threshold count today, and says so", () => {
    renderTiles();
    const open = screen.getByRole("article", { name: "Open exceptions" });
    expect(open).toHaveAttribute("data-requirement", "FR-DSH-003");
    expect(within(open).getByText("19")).toBeInTheDocument();
    expect(open).toHaveTextContent("11 urgent; 9 rules configured");
    expect(open).toHaveTextContent("as inspected");
    const below = screen.getByRole("article", { name: "Below the removal threshold" });
    expect(below).toHaveAttribute("data-requirement", "FR-DSH-004");
    expect(within(below).getByText("9")).toBeInTheDocument();
    expect(below).toHaveTextContent("1 spare");
    expect(below).toHaveTextContent("today");
    expect(screen.getByRole("link", { name: "Critical 11" })).toHaveAttribute(
      "href",
      "/exceptions?severity=CRITICAL",
    );
    expect(screen.getByRole("link", { name: "Warning 8" })).toHaveAttribute(
      "href",
      "/exceptions?severity=WARNING",
    );
    expect(screen.getByText(/judged at each unit's latest inspection/)).toBeInTheDocument();
  });

  // U17: a tile and the list it opens count the same units.
  it("carries the chosen depot onto every list link", () => {
    renderTiles({}, "d1");
    expect(screen.getByRole("link", { name: "Critical 11" })).toHaveAttribute(
      "href",
      "/exceptions?severity=CRITICAL&depot=d1",
    );
    const open = screen.getByRole("article", { name: "Open exceptions" });
    expect(within(open).getByRole("link", { name: "See the list" })).toHaveAttribute(
      "href",
      "/exceptions?depot=d1",
    );
    expect(screen.getByRole("link", { name: "See the at-risk list" })).toHaveAttribute(
      "href",
      "/at-risk?depot=d1",
    );
  });

  // FR-DSH-002 and U27: two disjoint splits, four casing segments.
  it("renders the estate's tread and casing values with their own splits", () => {
    renderTiles();
    const estate = screen.getByRole("region", { name: "Estate value" });
    expect(estate).toHaveTextContent("R20,571.00");
    expect(estate).toHaveTextContent("R49,612.50");
    expect(estate).toHaveTextContent("R70,183.50 across 27 tyres in total.");
    expect(
      within(estate).getByRole("img", {
        name: "Tread value provenance: Actual 27, Estimated 0, Unvalued 0",
      }),
    ).toBeInTheDocument();
    expect(
      within(estate).getByRole("img", {
        name: "Casing value provenance: Actual 0, Estimated 0, Audit 27, Unvalued 0",
      }),
    ).toBeInTheDocument();
  });

  // U44, 000049: an estate with no valued member reads null, rendered
  // through the Money rule beside its count, never 0.
  it("discloses the unvalued count beside every estate figure", () => {
    const estate = dashboardBody().estate;
    renderTiles({
      estate: {
        ...estate,
        actualCount: 0,
        estimatedCount: 0,
        unvaluedCount: 27,
        casingAuditCount: 0,
        casingUnvaluedCount: 27,
        treadValue: null,
        casingValue: null,
        totalValue: null,
      },
    });
    const region = screen.getByRole("region", { name: "Estate value" });
    expect(region).toHaveTextContent("Not valued");
    expect(region).toHaveTextContent("27 of 27 unvalued");
    expect(region).not.toHaveTextContent("R0.00");
  });

  // 000049: one side wholly unvalued leaves a partial total, which says so.
  it("says which side a partial total is missing", () => {
    const estate = dashboardBody().estate;
    renderTiles({
      estate: {
        ...estate,
        casingAuditCount: 0,
        casingUnvaluedCount: 27,
        casingValue: null,
        totalValue: estate.treadValue,
      },
    });
    expect(screen.getByRole("region", { name: "Estate value" })).toHaveTextContent(
      "R20,571.00 across 27 tyres in total; tread 0 of 27 unvalued, casing 27 of 27 unvalued.",
    );
  });

  it("renders coverage, overdue, stale and unreconciled as four tiles on the tenant's day", () => {
    renderTiles({
      units: {
        judgedAt: "TENANT_TODAY",
        total: 3,
        scheduled: 1,
        covered: 1,
        unscheduled: 2,
        stale: 1,
        staleUnknown: 1,
      },
      overdueTasks: 2,
      pendingCompositionReports: 1,
    });
    expect(screen.getByRole("article", { name: "Inspection coverage" })).toHaveTextContent(
      "1 of 3",
    );
    expect(screen.getByRole("article", { name: "Inspection coverage" })).toHaveTextContent(
      "2 unscheduled",
    );
    expect(screen.getByRole("article", { name: "Overdue tasks" })).toHaveTextContent("2");
    expect(screen.getByRole("article", { name: "Stale units" })).toHaveTextContent("1 unknown");
    expect(screen.getByRole("link", { name: "See the rigs" })).toHaveAttribute(
      "href",
      "/fleet/rigs",
    );
  });
});
