import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { FitmentList } from "./FitmentList";
import type { FleetFitment } from "../api/units";
import { renderWithActor, respond } from "../test/fixtures";

function fitment(overrides: Partial<FleetFitment> & { fitmentId: string }): FleetFitment {
  return {
    vehicleId: "u1",
    fleetNumber: "HORSE-1",
    positionCode: "POS1",
    tyreId: "t1",
    displayCode: "TY001",
    // Wire-shaped (units.go's listOpenFitments handler, whose own
    // fittedAt.UTC().Format(time.RFC3339) writes this field), not a bare
    // date: an instant, not a calendar date, is what carries over the wire.
    fittedAt: "2026-08-01T22:30:00Z",
    daysFitted: 10,
    sequence: 1,
    ...overrides,
  };
}

function renderScreen() {
  return renderWithActor(<FitmentList />, { capabilities: ["ViewFleet"], withRouter: true });
}

describe("the fitments list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links each row to the unit that carries the fitment", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [fitment({ fitmentId: "f1", vehicleId: "u9", fleetNumber: "HORSE-9" })]),
    );
    renderScreen();

    const link = await screen.findByRole("link", { name: "HORSE-9" });
    expect(link).toHaveAttribute("href", "/fleet/units/u9");
  });

  // daysFitted comes from the API's own tenant-time arithmetic (rule 6) and
  // is rendered as given, never recomputed here.
  it("renders days fitted from the server", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [fitment({ fitmentId: "f1", daysFitted: 42 })]),
    );
    renderScreen();

    const row = (await screen.findByRole("link", { name: "HORSE-1" })).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("42")).toBeInTheDocument();
  });

  // U55 (TYRE-342): a long fitment's day count groups thousands.
  it("groups a four-digit days fitted with a comma", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [fitment({ fitmentId: "f1", daysFitted: 1234 })]),
    );
    renderScreen();

    const row = (await screen.findByRole("link", { name: "HORSE-1" })).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("1,234")).toBeInTheDocument();
  });

  // rule 6: an instant renders in the tenant's own zone, not the browser's.
  // 22:30Z is 00:30 the next day in Africa/Johannesburg (me()'s own zone).
  it("renders fitted on through useTenantDate", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [fitment({ fitmentId: "f1", fittedAt: "2026-08-01T22:30:00Z" })]),
    );
    renderScreen();

    const row = (await screen.findByRole("link", { name: "HORSE-1" })).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("02 Aug 2026")).toBeInTheDocument();
  });

  it("shows a note card when no positions are fitted", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderScreen();

    expect(await screen.findByText(/no positions are currently fitted/i)).toBeInTheDocument();
  });

  it("shows an alert with a retry action when the list fails to load, and recovers on retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderScreen();

    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: /retry/i });

    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [fitment({ fitmentId: "f1", fleetNumber: "HORSE-2" })]),
    );
    await userEvent.click(retry);

    expect(await screen.findByRole("link", { name: "HORSE-2" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // NFR-USE-012, TYRE-327: fleet numbers in natural order, and a unit's rows
  // in its configuration's order. A sort by position code, text or natural,
  // would put 2 before 3 before 10 and fail this.
  it("orders units naturally and each unit's rows by position sequence", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [
        fitment({ fitmentId: "a", fleetNumber: "LINK12", positionCode: "1", sequence: 1 }),
        fitment({ fitmentId: "b", fleetNumber: "LINK6", positionCode: "2", sequence: 3 }),
        fitment({ fitmentId: "c", fleetNumber: "LINK6", positionCode: "10", sequence: 1 }),
        fitment({ fitmentId: "d", fleetNumber: "LINK6", positionCode: "3", sequence: 2 }),
      ]),
    );
    renderScreen();

    const headers = await screen.findAllByRole("rowheader");
    const rows = headers.map((h) => {
      const row = h.closest("tr");
      if (row === null) throw new Error("no row");
      return `${h.textContent} ${within(row).getAllByRole("cell")[0].textContent}`;
    });
    expect(rows).toEqual(["LINK6 10", "LINK6 3", "LINK6 2", "LINK12 1"]);
  });
});
