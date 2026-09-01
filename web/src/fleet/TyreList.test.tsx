import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { TyreList } from "./TyreList";
import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";
import type { Tyre } from "../api/tyres";

function renderScreen(capabilities: string[] = ["ManageAssets", "ViewValuation"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const actor: Me = {
    userId: "u0",
    displayName: "Controller",
    role: "CONTROLLER",
    capabilities,
    depots: [],
    timezone: "Africa/Johannesburg",
    displayCodePolicy: "FREE",
  };
  return render(
    <ActorContext.Provider value={{ actor, settled: true }}>
      <QueryClientProvider client={client}>
        {/* TyreList links to ReceiveTyre (/fleet/tyres/new); react-router's
            Link throws outside a Router. */}
        <MemoryRouter>
          <TyreList />
        </MemoryRouter>
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// sentBody: same narrowing as AddDriver.test.tsx's helper of the same name.
function sentBody(call: number): unknown {
  const init = vi.mocked(fetch).mock.calls[call][1];
  if (typeof init?.body !== "string") {
    throw new Error(`call ${call} did not send a string body`);
  }
  return JSON.parse(init.body);
}

function tyre(overrides: Partial<Tyre> & { id: string }): Tyre {
  return {
    displayCode: "POS1",
    state: "IN_STOCK",
    status: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    brandName: "Bridgestone",
    patternName: "R150",
    receivedDate: "2026-01-05",
    awaitingCost: false,
    purchasePrice: "1200.00",
    randPerMm: "150.25",
    casingValue: "800.00",
    ...overrides,
  };
}

describe("the tyre register", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // NFR-USE-012: natural order, not the order the server happened to send
  // (received_date DESC, then display_code — tyres.go's own ORDER BY).
  it("lists tyres in natural display-code order regardless of server order", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, {
        tyres: [tyre({ id: "t10", displayCode: "POS10" }), tyre({ id: "t2", displayCode: "POS2" })],
      }),
    );

    renderScreen();

    const rowHeaders = await screen.findAllByRole("rowheader");
    expect(rowHeaders.map((el) => el.textContent)).toEqual(["POS2", "POS10"]);
  });

  it("filters to the awaiting-cost backlog when the toggle is switched on", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }))
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", awaitingCost: true })] }));

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.click(screen.getByRole("checkbox", { name: /awaiting cost only/i }));
    await screen.findAllByRole("rowheader");

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/tyres?awaitingCost=true");
  });

  // FR-TYR-042/043: a code resolves only against a date, and when more than
  // one tyre carried it the screen must show every match and say so — never
  // pick one for the user.
  it("shows every match for a code+date lookup and the resolve-by-eye note when more than one carried it", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }))
      .mockResolvedValueOnce(
        respond(200, {
          tyres: [
            tyre({ id: "dup-a", displayCode: "DUP1" }),
            tyre({ id: "dup-b", displayCode: "DUP1" }),
          ],
        }),
      );

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.type(screen.getByLabelText(/display code/i), "DUP1");
    fireEvent.change(screen.getByLabelText(/as of date/i), { target: { value: "2026-02-01" } });
    await userEvent.click(screen.getByRole("button", { name: /find tyre/i }));

    const rowHeaders = await screen.findAllByRole("rowheader");
    expect(rowHeaders).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/tyres?code=DUP1&on=2026-02-01");
    expect(
      screen.getByText(/two tyres carried code dup1.*resolve by eye.*never guesses/i),
    ).toBeInTheDocument();
  });

  it("does not show the resolve-by-eye note for a lookup with a single match", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }))
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", displayCode: "SOLO1" })] }));

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.type(screen.getByLabelText(/display code/i), "SOLO1");
    fireEvent.change(screen.getByLabelText(/as of date/i), { target: { value: "2026-02-01" } });
    await userEvent.click(screen.getByRole("button", { name: /find tyre/i }));

    await screen.findAllByRole("rowheader");
    expect(screen.queryByText(/resolve by eye/i)).not.toBeInTheDocument();
  });

  it("shows the reason field only for a scrap and the proceeds field only for a sale", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, { tyres: [tyre({ id: "t1", displayCode: "POS1" })] }),
    );
    renderScreen();
    await screen.findAllByRole("rowheader");

    const disposalSelect = screen.getByRole("combobox", { name: /disposal for pos1/i });
    expect(screen.queryByLabelText(/reason for pos1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/proceeds for pos1/i)).not.toBeInTheDocument();

    await userEvent.selectOptions(disposalSelect, "SCRAPPED");
    expect(screen.getByLabelText(/reason for pos1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/proceeds for pos1/i)).not.toBeInTheDocument();

    await userEvent.selectOptions(disposalSelect, "SOLD");
    expect(screen.queryByLabelText(/reason for pos1/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/proceeds for pos1/i)).toBeInTheDocument();
  });

  // A disposed row has no active-only filter to leave it behind (the e2e
  // spec's own comment says so): DisposeForm must not stay on offer once a
  // tyre is terminal, or its refusal reads as advice for a tyre that is not
  // scrapped. Both rows are awaiting cost so CostForm, not a dash, owns the
  // Set-cost cell — the only dash left in POS1's row is the Dispose cell's.
  it("shows a dash, never a dispose form, for a terminal tyre, while a non-terminal row keeps the form", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, {
        tyres: [
          tyre({ id: "t1", displayCode: "POS1", state: "SCRAPPED", awaitingCost: true }),
          tyre({ id: "t2", displayCode: "POS2", state: "IN_STOCK", awaitingCost: true }),
        ],
      }),
    );
    renderScreen();
    await screen.findAllByRole("rowheader");

    const scrapped = screen.getByRole("rowheader", { name: "POS1" }).closest("tr");
    if (!scrapped) throw new Error("row for POS1 not found");
    expect(within(scrapped).getByText("—")).toBeInTheDocument();
    expect(
      within(scrapped).queryByRole("combobox", { name: /disposal for pos1/i }),
    ).not.toBeInTheDocument();
    expect(within(scrapped).queryByRole("button", { name: /^dispose$/i })).not.toBeInTheDocument();

    const active = screen.getByRole("rowheader", { name: "POS2" }).closest("tr");
    if (!active) throw new Error("row for POS2 not found");
    expect(
      within(active).getByRole("combobox", { name: /disposal for pos2/i }),
    ).toBeInTheDocument();
  });

  it("renders the server's own refusal for a disposal it will not allow", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", displayCode: "POS1" })] }))
      .mockResolvedValueOnce(
        respond(422, { code: "TY012", message: "no such tyre in this fleet" }),
      );

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /disposal for pos1/i }),
      "SCRAPPED",
    );
    await userEvent.type(screen.getByLabelText(/reason for pos1/i), "casing failure");
    await userEvent.click(screen.getByRole("button", { name: /^dispose$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no such tyre in this fleet/i);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/tyres/t1/dispose");
    expect(sentBody(1)).toStrictEqual({ disposal: "SCRAPPED", reason: "casing failure" });
  });

  // SOLD's field is only checked for visibility above; a screen that showed
  // the proceeds input but dropped it from the POST would pass that test and
  // still fail app.dispose_tyre's requirement that a sale record proceeds.
  it("posts proceeds and no reason when disposing as a sale, then refreshes the register", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", displayCode: "POS1" })] }))
      .mockResolvedValueOnce(respond(204, undefined))
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", displayCode: "POS1" })] }));

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /disposal for pos1/i }),
      "SOLD",
    );
    await userEvent.type(screen.getByLabelText(/proceeds for pos1/i), "450.00");
    await userEvent.click(screen.getByRole("button", { name: /^dispose$/i }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(3));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/tyres/t1/dispose");
    expect(sentBody(1)).toStrictEqual({ disposal: "SOLD", proceeds: "450.00" });
  });

  it("falls back to a generic message for a disposal refusal with an unrecognised code", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1", displayCode: "POS1" })] }))
      .mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /disposal for pos1/i }),
      "LOST",
    );
    await userEvent.click(screen.getByRole("button", { name: /^dispose$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be disposed/i);
  });

  // FR-TYR-041: the cost control discharges CFL-002's awaiting-cost backlog.
  it("shows the Set cost column header", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }));
    renderScreen();
    await screen.findAllByRole("rowheader");

    expect(screen.getByRole("columnheader", { name: /set cost/i })).toBeInTheDocument();
  });

  it("offers a price input, a cost-source select, and submit for a tyre still awaiting cost", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, {
        tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: true })],
      }),
    );
    renderScreen();
    await screen.findAllByRole("rowheader");

    expect(screen.getByLabelText(/purchase price for pos1/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /cost source for pos1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set cost/i })).toBeInTheDocument();
  });

  // The server-side handler for POST /api/tyres/{id}/cost requires only
  // ManageAssets, not ViewValuation (api/internal/httpapi/tyres.go) — the
  // cost control must render for every actor who reaches this route the
  // same way DisposeForm already does, never behind an invented
  // ViewValuation gate. Every other awaiting-cost test above renders with
  // the default (ViewValuation included), so this is the one case that
  // would catch a regression re-adding that gate to CostForm specifically.
  it("offers the cost form to an actor without ViewValuation, same as DisposeForm", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, {
        tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: true })],
      }),
    );
    renderScreen(["ManageAssets"]);
    await screen.findAllByRole("rowheader");

    expect(screen.getByLabelText(/purchase price for pos1/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /cost source for pos1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set cost/i })).toBeInTheDocument();
  });

  // D5/TY013: a correction later is a decision this surface does not take,
  // so an already-costed row must never offer a second submission — not a
  // form, not a disabled form, nothing that invites one.
  it("shows a dash, never a cost form, for a tyre that already has a cost recorded", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, {
        tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: false })],
      }),
    );
    // No ViewValuation: the money columns are absent, so the only dash left
    // in this row is the Set-cost cell's — nothing else to confuse it with.
    renderScreen(["ManageAssets"]);
    await screen.findAllByRole("rowheader");

    const row = screen.getByRole("rowheader", { name: "POS1" }).closest("tr");
    if (!row) throw new Error("row for POS1 not found");
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(within(row).queryByLabelText(/purchase price for pos1/i)).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /set cost/i })).not.toBeInTheDocument();
  });

  it("posts the typed price and cost source, then refreshes the register", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(200, {
          tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: true })],
        }),
      )
      .mockResolvedValueOnce(respond(204, undefined))
      .mockResolvedValueOnce(
        respond(200, {
          tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: false })],
        }),
      );

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.type(screen.getByLabelText(/purchase price for pos1/i), "925.50");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /cost source for pos1/i }),
      "PRICE_LIST_ESTIMATE",
    );
    await userEvent.click(screen.getByRole("button", { name: /set cost/i }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(3));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("/api/tyres/t1/cost");
    expect(sentBody(1)).toStrictEqual({ price: "925.50", source: "PRICE_LIST_ESTIMATE" });
  });

  it("renders the server's own refusal for a cost it will not record", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(200, {
          tyres: [tyre({ id: "t1", displayCode: "POS1", awaitingCost: true })],
        }),
      )
      .mockResolvedValueOnce(
        respond(422, { code: "TY013", message: "this tyre's cost is already recorded" }),
      );

    renderScreen();
    await screen.findAllByRole("rowheader");

    await userEvent.type(screen.getByLabelText(/purchase price for pos1/i), "500.00");
    await userEvent.click(screen.getByRole("button", { name: /set cost/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /this tyre's cost is already recorded/i,
    );
  });

  it("hides the money columns from an actor without ViewValuation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }));
    renderScreen(["ManageAssets"]);

    await screen.findAllByRole("rowheader");
    expect(screen.queryByRole("columnheader", { name: /purchase price/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /rand\/mm/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /casing value/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/1200\.00/)).not.toBeInTheDocument();
  });

  it("shows the money columns to an actor with ViewValuation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }));
    renderScreen(["ManageAssets", "ViewValuation"]);

    await screen.findAllByRole("rowheader");
    expect(screen.getByRole("columnheader", { name: /purchase price/i })).toBeInTheDocument();
    expect(screen.getByText(/1200\.00/)).toBeInTheDocument();
  });

  // ReceiveTyre (/fleet/tyres/new) is otherwise reachable by URL alone; the
  // register is its one discoverable entry point. Every actor who can render
  // this screen already holds ManageAssets (AdminRoute in routes.tsx), so the
  // link needs no capability check of its own — renderScreen's default
  // capabilities cover that gate the same way the route does.
  it("links to the receive-tyres screen", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, { tyres: [] }));
    renderScreen();

    const link = await screen.findByRole("link", { name: /receive tyres/i });
    expect(link).toHaveAttribute("href", "/fleet/tyres/new");
  });

  it("shows an alert with a retry action when the register fails to load, and recovers on retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderScreen();

    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: /retry/i });

    vi.mocked(fetch).mockResolvedValueOnce(respond(200, { tyres: [tyre({ id: "t1" })] }));
    await userEvent.click(retry);

    await screen.findAllByRole("rowheader");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
