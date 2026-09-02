import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FitmentHistory } from "./FitmentHistory";
import { ActorContext } from "../../auth/actorContext";
import { formatTenantDate } from "../../time/tenantTime";
import { fitmentRow, me } from "../../test/fixtures";

function renderHistory(rows: Parameters<typeof FitmentHistory>[0]["rows"]) {
  return render(
    <ActorContext.Provider value={{ actor: me(), settled: true }}>
      <FitmentHistory rows={rows} />
    </ActorContext.Provider>,
  );
}

function rowFor(code: string): HTMLElement {
  return screen.getByRole("row", { name: new RegExp(code) });
}

describe("a unit's fitment history", () => {
  // CR-012: a distance and where it came from are one fact. A bare number
  // reads as measured, which for an inferred one is a claim the register
  // never made.
  it("renders a distance beside the label that says where it came from", () => {
    renderHistory([
      fitmentRow({
        fitmentId: "f1",
        displayCode: "TY001",
        distanceKm: 12000,
        distanceSource: "MEASURED",
      }),
      fitmentRow({
        fitmentId: "f2",
        displayCode: "TY002",
        distanceKm: 9000,
        distanceSource: "INFERRED",
      }),
    ]);

    expect(within(rowFor("TY001")).getByText("12000 km (Measured)")).toBeTruthy();
    expect(within(rowFor("TY002")).getByText("9000 km (Inferred)")).toBeTruthy();
  });

  it("says a distance is unavailable rather than printing a number it does not have", () => {
    renderHistory([
      fitmentRow({
        fitmentId: "f3",
        displayCode: "TY003",
        distanceKm: null,
        distanceSource: "UNAVAILABLE",
      }),
    ]);

    const cells = within(rowFor("TY003")).getAllByRole("cell");
    expect(cells.some((c) => c.textContent === "Unavailable")).toBe(true);
    expect(within(rowFor("TY003")).queryByText(/km/)).toBeNull();
  });

  it("shows an open fitment as still fitted, with no removal date and no distance", () => {
    renderHistory([
      fitmentRow({
        fitmentId: "f4",
        displayCode: "TY004",
        removedAt: null,
        removedOdometer: null,
        removedTreadMm: null,
        removalReason: null,
        distanceKm: null,
        distanceSource: "UNAVAILABLE",
      }),
    ]);

    expect(within(rowFor("TY004")).getByText("Fitted")).toBeTruthy();
  });

  it("renders dates in the tenant's calendar, not the browser's", () => {
    renderHistory([
      fitmentRow({ fitmentId: "f5", displayCode: "TY005", fittedAt: "2026-08-01T06:00:00Z" }),
    ]);

    const expected = formatTenantDate("2026-08-01T06:00:00Z", "Africa/Johannesburg");
    expect(within(rowFor("TY005")).getByText(expected)).toBeTruthy();
  });

  it("says so when a unit has never carried a tyre", () => {
    renderHistory([]);
    expect(screen.getByText("This unit has no fitment history yet.")).toBeTruthy();
  });
});
