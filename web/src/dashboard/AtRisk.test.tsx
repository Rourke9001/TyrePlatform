import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  atRiskTyre,
  dashboardBody,
  renderWithActor,
  requestedUrl,
  respond,
} from "../test/fixtures";
import { forceMatchMedia } from "../test/media";
import AtRisk from "./AtRisk";

beforeEach(() => {
  const { running, spare } = dashboardBody().valueAtRisk;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/valuation/at-risk")) {
        return Promise.resolve(
          respond(200, {
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
          }),
        );
      }
      return Promise.resolve(respond(404, { code: "not_found", message: "no" }));
    }),
  );
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
