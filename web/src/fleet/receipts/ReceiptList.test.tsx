import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenReceipt } from "../../api/receipts";
import type { Money } from "../../api/money";
import { renderWithActor, requestedUrl, respond } from "../../test/fixtures";
import { ReceiptList } from "./ReceiptList";

function receipt(overrides: Partial<OpenReceipt> & { id: string }): OpenReceipt {
  return {
    priceState: "UNPRICED",
    receivedDate: "2026-10-01",
    depotName: "Main yard",
    sizeName: "315/80R22.5",
    brandName: "Dunlop",
    patternName: "SP431",
    quantity: 2,
    inFleet: 2,
    displayCodes: ["BAC-00010", "BAC-00011"],
    ...overrides,
  };
}

const OPEN: OpenReceipt[] = [
  receipt({ id: "r1" }),
  receipt({
    id: "r2",
    priceState: "ESTIMATED",
    quantity: 1,
    inFleet: 1,
    displayCodes: ["BAC-00012"],
    unitPrice: "4319.91" as Money,
  }),
];

type Reply = () => Response | Promise<Response>;

// GET /api/tyre-receipts/open answers `open` every time; each POST takes
// the next of `moves`. Anything else is a request this screen should not
// make.
function mockApi({ open = OPEN, moves = [] }: { open?: OpenReceipt[]; moves?: Reply[] } = {}) {
  const queue = [...moves];
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    if (url === "/api/tyre-receipts/open" && init?.method !== "POST") {
      return Promise.resolve(respond(200, { receipts: open }));
    }
    const reply = queue.shift();
    if (init?.method === "POST" && reply !== undefined) return Promise.resolve(reply());
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
}

function posts(): { url: string; body: unknown }[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "POST")
    .map(([input, init]) => ({
      url: requestedUrl(input),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    }));
}

function openReads(): number {
  return vi
    .mocked(fetch)
    .mock.calls.filter(
      ([input, init]) =>
        requestedUrl(input) === "/api/tyre-receipts/open" && init?.method !== "POST",
    ).length;
}

function renderScreen() {
  return renderWithActor(<ReceiptList />, {
    capabilities: ["ManageAssets", "ViewValuation"],
    withRouter: true,
  });
}

async function rowFor(code: string): Promise<HTMLElement> {
  const cell = await screen.findByRole("rowheader", { name: new RegExp(code) });
  const row = cell.closest("tr");
  if (row === null) throw new Error(`no row for ${code}`);
  return row;
}

describe("open receipts", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists open receipts with their codes and price", async () => {
    mockApi();
    renderScreen();

    const unpriced = await rowFor("BAC-00010");
    expect(
      within(unpriced).getByRole("rowheader", { name: "BAC-00010, BAC-00011" }),
    ).toBeInTheDocument();
    expect(within(unpriced).getByRole("cell", { name: "01 Oct 2026" })).toBeInTheDocument();
    expect(within(unpriced).getByRole("cell", { name: "Main yard" })).toBeInTheDocument();
    expect(within(unpriced).getByRole("cell", { name: "Dunlop" })).toBeInTheDocument();
    expect(within(unpriced).getByRole("cell", { name: "Awaiting its price" })).toBeInTheDocument();
    const estimated = await rowFor("BAC-00012");
    expect(within(estimated).getByRole("cell", { name: "R4,319.91" })).toBeInTheDocument();
    expect(
      within(estimated).getByRole("cell", { name: "Price list estimate" }),
    ).toBeInTheDocument();
  });

  it("says so when no receipt is open", async () => {
    mockApi({ open: [] });
    renderScreen();
    expect(await screen.findByText("No receipts are waiting for their price.")).toBeInTheDocument();
  });

  // D3: one invoice prices the whole set, so the confirmation speaks for it.
  it("record invoice sends the price, number and date and confirms the set", async () => {
    mockApi({ moves: [() => respond(200, { priced: 2, leftFleet: 0 })] });
    renderScreen();
    const row = await rowFor("BAC-00010");

    await userEvent.click(within(row).getByRole("button", { name: "Record invoice" }));
    await userEvent.type(within(row).getByLabelText("Unit price"), "4500.00");
    await userEvent.type(within(row).getByLabelText("Invoice number (optional)"), "INV-7");
    await userEvent.type(within(row).getByLabelText("Invoice date (optional)"), "2026-10-02");
    await userEvent.click(within(row).getByRole("button", { name: "Save invoice" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invoice recorded. 2 tyres priced.",
    );
    expect(posts()).toEqual([
      {
        url: "/api/tyre-receipts/r1/invoice",
        body: { price: "4500.00", invoiceNumber: "INV-7", invoiceDate: "2026-10-02" },
      },
    ]);
    await waitFor(() => expect(openReads()).toBeGreaterThan(1));
  });

  it("apply list price is offered only for an unpriced receipt", async () => {
    mockApi({ moves: [() => respond(200, { priced: 1, leftFleet: 1 })] });
    renderScreen();
    const estimated = await rowFor("BAC-00012");
    expect(
      within(estimated).queryByRole("button", { name: "Apply list price" }),
    ).not.toBeInTheDocument();
    const unpriced = await rowFor("BAC-00010");

    await userEvent.click(within(unpriced).getByRole("button", { name: "Apply list price" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "List price applied. 1 tyre priced. 1 tyre has left the fleet and keeps what it had.",
    );
    expect(posts()).toEqual([{ url: "/api/tyre-receipts/r1/list-price", body: {} }]);
  });

  // Keeping the estimate is final: no invoice can follow, so it asks.
  it("keeping the estimate asks first", async () => {
    mockApi({ moves: [() => new Response(null, { status: 204 })] });
    renderScreen();
    const unpriced = await rowFor("BAC-00010");
    expect(
      within(unpriced).queryByRole("button", { name: "Keep the estimate" }),
    ).not.toBeInTheDocument();
    const estimated = await rowFor("BAC-00012");

    await userEvent.click(within(estimated).getByRole("button", { name: "Keep the estimate" }));
    const dialog = await screen.findByRole("dialog", { name: "Keep the estimate as final?" });
    expect(dialog).toHaveAccessibleDescription(
      "No invoice can be recorded for this receipt afterwards.",
    );
    expect(posts()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep the estimate" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Estimate kept. This receipt's price is final.",
    );
    expect(posts()).toEqual([{ url: "/api/tyre-receipts/r2/keep-estimate", body: {} }]);
  });

  // The dialog answers a dismissal three ways, and all of them return focus
  // to the button that opened it.
  describe("the keep dialog", () => {
    async function openKeep() {
      const estimated = await rowFor("BAC-00012");
      const opener = within(estimated).getByRole("button", { name: "Keep the estimate" });
      await userEvent.click(opener);
      const dialog = await screen.findByRole("dialog", { name: "Keep the estimate as final?" });
      return { opener, dialog };
    }
    const scrim = (dialog: HTMLElement) => {
      const el = dialog.parentElement;
      if (el === null) throw new Error("no scrim");
      return el;
    };

    it("closes on a backdrop click", async () => {
      mockApi();
      renderScreen();
      const { opener, dialog } = await openKeep();
      await userEvent.click(scrim(dialog));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });

    it.each([
      ["Escape", () => userEvent.keyboard("{Escape}")],
      ["the Close button", () => userEvent.click(screen.getByRole("button", { name: "Close" }))],
    ])("closes on %s and returns focus to its opener", async (_name, dismiss) => {
      mockApi();
      renderScreen();
      const { opener } = await openKeep();
      await dismiss();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    });

    it("stays open on Escape, Close and the backdrop while the write is pending", async () => {
      let release: (r: Response) => void = () => undefined;
      const pending = new Promise<Response>((res) => {
        release = res;
      });
      mockApi({ moves: [() => pending] });
      renderScreen();
      const { dialog } = await openKeep();
      await userEvent.click(within(dialog).getByRole("button", { name: "Keep the estimate" }));
      await waitFor(() => {
        expect(posts()).toHaveLength(1);
      });

      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await userEvent.click(scrim(dialog));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      release(new Response(null, { status: 204 }));
      expect(await screen.findByRole("status")).toBeInTheDocument();
    });
  });

  // Review focus 5: a set wholly gone still moves, and says it priced none.
  it("a move that priced no tyre says so", async () => {
    mockApi({ moves: [() => respond(200, { priced: 0, leftFleet: 1 })] });
    renderScreen();
    const row = await rowFor("BAC-00012");

    await userEvent.click(within(row).getByRole("button", { name: "Record invoice" }));
    await userEvent.type(within(row).getByLabelText("Unit price"), "4500.00");
    await userEvent.click(within(row).getByRole("button", { name: "Save invoice" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Invoice recorded. No tyre on this receipt is still in the fleet, so none was priced.",
    );
  });

  it("a refusal is spoken", async () => {
    mockApi({
      moves: [
        () =>
          respond(422, {
            code: "TY026",
            message: "this receipt's price is final and does not change",
          }),
      ],
    });
    renderScreen();
    const row = await rowFor("BAC-00012");

    await userEvent.click(within(row).getByRole("button", { name: "Record invoice" }));
    await userEvent.type(within(row).getByLabelText("Unit price"), "4500.00");
    await userEvent.click(within(row).getByRole("button", { name: "Save invoice" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "this receipt's price is final and does not change",
    );
  });
});
