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

// What loadEstate sends over no tyre: the ROLLUP's total row, every count 0
// and every sum null.
const emptyEstate = {
  ...dashboardBody().estate,
  tyreCount: 0,
  actualCount: 0,
  estimatedCount: 0,
  unvaluedCount: 0,
  casingUnvaluedCount: 0,
  casingActualCount: 0,
  casingEstimatedCount: 0,
  casingAuditCount: 0,
  treadValue: null,
  casingValue: null,
  totalValue: null,
};

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

  // FR-DSH-003: open and total differ once a fitment resolves a row, so
  // the tile reads open; its clock label is the wire's own code (U48).
  it("reads the open count, not the total, and names the clock the wire sends", () => {
    renderTiles({
      exceptions: {
        ...dashboardBody().exceptions,
        judgedAt: "AS_AT",
        open: 17,
        urgent: 10,
        total: 19,
        bySeverity: { CRITICAL: 10, WARNING: 7 },
      },
    });
    const open = screen.getByRole("article", { name: "Open exceptions" });
    expect(within(open).getByText("17")).toBeInTheDocument();
    expect(within(open).queryByText("19")).toBeNull();
    expect(within(open).getByText("as at the chosen date")).toBeInTheDocument();
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
  it("says Not valued beside the count for an estate with no valued member", () => {
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
    const tread = screen.getByRole("article", { name: "Tread value" });
    expect(within(tread).getByText("Not valued")).toBeInTheDocument();
    expect(tread).toHaveTextContent("27 of 27 unvalued");
    expect(region).not.toHaveTextContent("R0.00");
  });

  // FR-DSH-002, U27, U44: counts that share no value, so each tile's
  // qualifier and split read their own fields.
  it("discloses each side's own unvalued count and split beside its figure", () => {
    const estate = dashboardBody().estate;
    renderTiles({
      estate: {
        ...estate,
        tyreCount: 27,
        actualCount: 20,
        estimatedCount: 4,
        unvaluedCount: 3,
        casingActualCount: 5,
        casingEstimatedCount: 6,
        casingAuditCount: 10,
        casingUnvaluedCount: 6,
      },
    });
    const tread = screen.getByRole("article", { name: "Tread value" });
    expect(within(tread).getByText("R20,571.00")).toBeInTheDocument();
    expect(within(tread).getByText("3 of 27 unvalued")).toBeInTheDocument();
    expect(
      within(tread).getByRole("img", {
        name: "Tread value provenance: Actual 20, Estimated 4, Unvalued 3",
      }),
    ).toBeInTheDocument();
    const casing = screen.getByRole("article", { name: "Casing value" });
    expect(within(casing).getByText("R49,612.50")).toBeInTheDocument();
    expect(within(casing).getByText("6 of 27 unvalued")).toBeInTheDocument();
    expect(
      within(casing).getByRole("img", {
        name: "Casing value provenance: Actual 5, Estimated 6, Audit 10, Unvalued 6",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Estate value" })).toHaveTextContent(
      "R70,183.50 across 27 tyres in total; tread 3 of 27 unvalued, casing 6 of 27 unvalued.",
    );
  });

  // U36: hidden is a projection, not a zero, and a reader without
  // ViewValuation is offered no link to /at-risk (D7).
  it("says Hidden for every estate figure and offers no at-risk link when money is hidden", () => {
    const estate = dashboardBody().estate;
    renderTiles({
      moneyVisible: false,
      estate: { ...estate, treadValue: null, casingValue: null, totalValue: null },
    });
    const region = screen.getByRole("region", { name: "Estate value" });
    const tread = screen.getByRole("article", { name: "Tread value" });
    expect(within(tread).getByText("Hidden")).toBeInTheDocument();
    const casing = screen.getByRole("article", { name: "Casing value" });
    expect(within(casing).getByText("Hidden")).toBeInTheDocument();
    expect(region).toHaveTextContent("Hidden across 27 tyres in total.");
    expect(region).not.toHaveTextContent("Not valued");
    const below = screen.getByRole("article", { name: "Below the removal threshold" });
    expect(within(below).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("link", { name: "See the at-risk list" })).toBeNull();
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

  // U36, U44: an estate with no tyre sends null values too. That is the
  // empty set, never "Not valued".
  it("says there are no tyres, not that they are unvalued, for an empty estate", () => {
    renderTiles({ estate: emptyEstate });
    const tread = screen.getByRole("article", { name: "Tread value" });
    const casing = screen.getByRole("article", { name: "Casing value" });
    expect(within(tread).getByText("No tyres in this view")).toBeInTheDocument();
    expect(within(casing).getByText("No tyres in this view")).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Estate value" });
    expect(within(region).getByText("No tyres in this view.")).toBeInTheDocument();
    expect(region).not.toHaveTextContent("Not valued");
  });

  // U36: the projection wins over the empty set.
  it("says Hidden for an empty estate when the actor may not see money", () => {
    renderTiles({ moneyVisible: false, estate: emptyEstate });
    const region = screen.getByRole("region", { name: "Estate value" });
    expect(within(region).getAllByText("Hidden")).toHaveLength(2);
    expect(region).toHaveTextContent("Hidden across 0 tyres in total.");
    expect(region).not.toHaveTextContent("No tyres in this view");
  });

  // U55: one of a thing is singular.
  it("says one tyre, one rule and one running position in the singular", () => {
    const estate = dashboardBody().estate;
    renderTiles({
      estate: { ...estate, tyreCount: 1, actualCount: 1, casingAuditCount: 1 },
      exceptions: { ...dashboardBody().exceptions, rulesConfigured: 1 },
      belowThreshold: { judgedAt: "TODAY", running: 1, spare: 1 },
    });
    expect(screen.getByRole("region", { name: "Estate value" })).toHaveTextContent(
      "R70,183.50 across 1 tyre in total.",
    );
    expect(screen.getByRole("article", { name: "Open exceptions" })).toHaveTextContent(
      /11 urgent; 1 rule configured(?!s)/,
    );
    const below = screen.getByRole("article", { name: "Below the removal threshold" });
    expect(
      within(below).getByText("running position; 1 spare disclosed separately"),
    ).toBeInTheDocument();
  });

  // U17: /fleet/rigs cannot narrow to a depot, so a depot view offers no
  // link to a list that would count every depot's reports.
  it("offers the rigs link only when no depot is chosen", () => {
    const { unmount } = renderTiles({}, "d1");
    const tile = screen.getByRole("article", { name: "Unreconciled rig reports" });
    expect(within(tile).queryByRole("link")).toBeNull();
    unmount();
    renderTiles();
    expect(screen.getByRole("link", { name: "See the rigs" })).toHaveAttribute(
      "href",
      "/fleet/rigs",
    );
  });

  // FR-DSH-005, 006; FR-EXC-027, 029: no two fields share a value, so
  // each tile reads its own, and the panel names its clock from the wire.
  it("renders coverage, overdue, stale and unreconciled as four tiles on the tenant's day", () => {
    renderTiles({
      units: {
        judgedAt: "TENANT_TODAY",
        total: 7,
        scheduled: 4,
        covered: 3,
        unscheduled: 3,
        stale: 2,
        staleUnknown: 1,
      },
      overdueTasks: 5,
      pendingCompositionReports: 6,
    });
    const panel = screen.getByRole("region", { name: "Units" });
    expect(panel).toHaveTextContent("on the tenant's calendar day");
    const coverage = screen.getByRole("article", { name: "Inspection coverage" });
    expect(within(coverage).getByText("3 of 7")).toBeInTheDocument();
    expect(within(coverage).getByText("4 scheduled, 3 unscheduled")).toBeInTheDocument();
    const overdue = screen.getByRole("article", { name: "Overdue tasks" });
    expect(within(overdue).getByText("5")).toBeInTheDocument();
    const stale = screen.getByRole("article", { name: "Stale units" });
    expect(within(stale).getByText("2")).toBeInTheDocument();
    expect(within(stale).getByText("1 unknown, never inspected")).toBeInTheDocument();
    const rigs = screen.getByRole("article", { name: "Unreconciled rig reports" });
    expect(within(rigs).getByText("6")).toBeInTheDocument();
    expect(within(rigs).getByRole("link", { name: "See the rigs" })).toHaveAttribute(
      "href",
      "/fleet/rigs",
    );
  });
});
