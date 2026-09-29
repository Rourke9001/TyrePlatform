import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AtRiskBody } from "../api/dashboard";
import {
  atRiskTyre,
  dashboardBody,
  renderWithActor,
  requestedUrl,
  respond,
} from "../test/fixtures";
import { forceMatchMedia } from "../test/media";
import AtRisk from "./AtRisk";

function atRiskBody(overrides: Partial<AtRiskBody> = {}): AtRiskBody {
  const { running, spare } = dashboardBody().valueAtRisk;
  return {
    scope: { level: "TENANT", depotCount: 0, depot: null },
    judgedAt: "TODAY",
    running,
    spare,
    tyres: [
      atRiskTyre({ tyreId: "t1" }),
      atRiskTyre({
        tyreId: "t2",
        isSpare: true,
        positionCode: "S",
        currentTreadMm: 2,
        readAt: null,
        casingValue: null,
        casingBasis: "UNVALUED",
      }),
    ],
    ...overrides,
  };
}

function stubAtRisk(body: AtRiskBody = atRiskBody()) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/valuation/at-risk")) return Promise.resolve(respond(200, body));
      return Promise.resolve(respond(404, { code: "not_found", message: "no" }));
    }),
  );
}

function atRiskCalls(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map((c) => requestedUrl(c[0]))
    .filter((u) => u.startsWith("/api/valuation/at-risk"));
}

beforeEach(() => {
  stubAtRisk();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AtRisk", () => {
  it("lists every at-risk tyre with its tread, its source, its casing value and the basis", async () => {
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    const table = await screen.findByRole("table", {
      name: "Tyres at or below the removal threshold",
    });
    // Four skeleton rows sit under aria-busy while loading; wait for the data.
    await waitFor(() => expect(table).not.toHaveAttribute("aria-busy"));
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("cell", { name: "1.0 mm of 4.0 mm" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "2.0 mm of 4.0 mm" })).toBeInTheDocument();
    expect(within(table).getAllByRole("cell", { name: "inspection reading" })).toHaveLength(2);
    expect(within(table).getByRole("cell", { name: "R1,837.50" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "audit valuation" })).toBeInTheDocument();
    // U36: one tyre's unvalued casing, in the Money rule's words in both columns.
    expect(within(table).getByRole("cell", { name: "Not valued" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "not valued" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "not dated" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Running" })).toHaveTextContent("R16,537.50");
    expect(screen.getByRole("article", { name: "Spares" })).toHaveTextContent("R1,837.50");
    expect(screen.getByText(/judged today/)).toBeInTheDocument();
  });

  // U47: the tiles speak as the hero does, and one of a thing is singular
  // (U55).
  it("qualifies each class as the hero does, one tyre in the singular", async () => {
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    const running = await screen.findByRole("article", { name: "Running" });
    expect(
      within(running).getByText(
        "9 tyres: 0 at actual cost, 9 estimated or audit, of which 9 audit; 0 unvalued",
      ),
    ).toBeInTheDocument();
    const spares = screen.getByRole("article", { name: "Spares" });
    expect(
      within(spares).getByText(
        "1 tyre: 0 at actual cost, 1 estimated or audit, of which 1 audit; 0 unvalued",
      ),
    ).toBeInTheDocument();
  });

  // U36, U44: a class with no tyre also sends null. That is the empty set,
  // never "Not valued", and the list says what is absent.
  it("says none at risk for an empty class and names the empty list", async () => {
    const empty = {
      tyreCount: 0,
      actualCount: 0,
      estimatedOrAuditCount: 0,
      auditCount: 0,
      unvaluedCount: 0,
      casingValueAtRisk: null,
    };
    stubAtRisk(atRiskBody({ running: empty, spare: empty, tyres: [] }));
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    const running = await screen.findByRole("article", { name: "Running" });
    expect(within(running).getByText("None at risk")).toBeInTheDocument();
    const spares = screen.getByRole("article", { name: "Spares" });
    expect(within(spares).getByText("None at risk")).toBeInTheDocument();
    expect(screen.queryByText("Not valued")).toBeNull();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Nothing at or below the removal threshold",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Every fitted tyre in this view reads above the configured removal threshold.",
      ),
    ).toBeInTheDocument();
  });

  // FR-DSH-013: the list is refetched by its own button, as /exceptions is.
  it("refetches the list when Refresh is pressed", async () => {
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    await screen.findByRole("article", { name: "Running" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute("aria-disabled"),
    );
    expect(atRiskCalls()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(atRiskCalls()).toHaveLength(2));
  });

  // Rule 6: every time on the page is the tenant's, named once.
  it("names the tenant's zone under the list", async () => {
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    await screen.findByRole("article", { name: "Running" });
    expect(screen.getByText(/^Times are Africa\/Johannesburg\.$/)).toBeInTheDocument();
  });

  // The page's tiles and list sit directly under its h1 (TYRE-239 comment
  // 12978).
  it("heads its two tiles at level 2", async () => {
    renderWithActor(<AtRisk />, { capabilities: ["ViewFleet", "ViewValuation"], withRouter: true });
    expect(await screen.findByRole("heading", { level: 2, name: "Running" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Spares" })).toBeInTheDocument();
  });

  describe("on a phone", () => {
    let restore: () => void;

    beforeEach(() => {
      restore = forceMatchMedia(true);
    });

    afterEach(() => {
      restore();
    });

    it("heads each card at level 2", async () => {
      renderWithActor(<AtRisk />, {
        capabilities: ["ViewFleet", "ViewValuation"],
        withRouter: true,
      });
      const list = await screen.findByRole("list", {
        name: "Tyres at or below the removal threshold",
      });
      await waitFor(() => expect(list).not.toHaveAttribute("aria-busy"));
      expect(within(list).getAllByRole("heading", { level: 2 })).toHaveLength(2);
    });
  });
});
