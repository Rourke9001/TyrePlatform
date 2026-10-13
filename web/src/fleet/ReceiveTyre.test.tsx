import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TyreCatalogue } from "../api/catalogue";
import { ActorContext } from "../auth/actorContext";
import { me, requestedUrl, respond, testQueryClient } from "../test/fixtures";
import { ReceiveTyre } from "./ReceiveTyre";

// Sizes and brands arrive in an order the form must not trust: SZ10 before
// SZ2, Dunlop before Apollo (NFR-USE-012).
const CATALOGUE: TyreCatalogue = {
  sizes: [
    { id: "s10", name: "SZ10" },
    { id: "s2", name: "SZ2" },
  ],
  brands: [
    { id: "b1", name: "Dunlop" },
    { id: "b2", name: "Apollo" },
  ],
  patterns: [
    { id: "p1", name: "SP431", brandId: "b1", appliesTo: "NEW" },
    { id: "p2", name: "All Position", brandId: null, appliesTo: "BOTH" },
    { id: "p3", name: "Recap", brandId: null, appliesTo: "RETREAD" },
    { id: "p4", name: "Haul", brandId: "b2", appliesTo: "NEW" },
  ],
};

type Reply = () => Response;

// GET /api/tyre-catalogue answers `catalogue` (null: it never answers), and
// each POST /api/tyres takes the next of `receives`. Anything else is a
// request this screen should not make. A fresh Response per call, since a
// body reads once.
function mockApi({
  catalogue = () => respond(200, CATALOGUE),
  receives = [],
}: { catalogue?: Reply | null; receives?: Reply[] } = {}) {
  const queue = [...receives];
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/tyre-catalogue") {
      return catalogue === null
        ? new Promise<Response>(() => undefined)
        : Promise.resolve(catalogue());
    }
    const reply = queue.shift();
    if (url === "/api/tyres" && reply !== undefined) return Promise.resolve(reply());
    return Promise.reject(new Error(`unexpected request to ${url}`));
  });
}

// Every POST body in order. The catalogue read is a GET on mount, so a call
// index would count it.
function receivedBodies(): Record<string, unknown>[] {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([, init]) => init?.method === "POST")
    .map(([, init]) => {
      if (typeof init?.body !== "string") throw new Error("a POST did not send a string body");
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null)
        throw new Error("a POST body is not an object");
      return body as Record<string, unknown>;
    });
}

function minted(...codes: string[]): Reply {
  return () =>
    respond(201, { tyres: codes.map((code, i) => ({ id: `t${i}`, displayCode: code })) });
}

function renderScreen(policy = "FREE") {
  const actor = me({
    displayName: "Controller",
    capabilities: ["ManageAssets"],
    displayCodePolicy: policy,
  });
  return render(
    <ActorContext.Provider value={{ actor, settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <ReceiveTyre />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

// Waits for the catalogue, then picks what a receive must name. An empty
// value leaves that field alone.
async function chooseEntries({ size = "s2", pattern = "p1", tread = "25.0" } = {}) {
  const sizeSelect = await screen.findByLabelText(/^size$/i);
  if (size !== "") await userEvent.selectOptions(sizeSelect, size);
  if (pattern !== "") await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), pattern);
  if (tread !== "") await userEvent.type(screen.getByLabelText(/new tread/i), tread);
}

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: /receive/i }));
}

// fireEvent.submit reaches onSubmit even where jsdom's constraint
// validation would stop a click, so this proves ReceiveTyre's own guard;
// the flush lets a POST the guard failed to stop actually land.
async function forceSubmit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (form === null) throw new Error("expected a form element");
  fireEvent.submit(form);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function optionNames(select: HTMLElement): (string | null)[] {
  return within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);
}

describe("receiving tyres into the fleet", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockApi();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // D12/AS-014: under a generated scheme the operator never types a code.
  // One is minted server-side and must be carried to the physical tyre by
  // hand, so the screen has to say that step out loud, not just omit the
  // field and leave the operator guessing.
  it("hides the code field, bounds the quantity 1-200 defaulting to 1, and names the sidewall step under GENERATED", async () => {
    renderScreen("GENERATED");

    expect(screen.queryByLabelText(/display code/i)).not.toBeInTheDocument();
    const quantity = screen.getByLabelText(/quantity/i);
    expect(quantity).toHaveAttribute("min", "1");
    expect(quantity).toHaveAttribute("max", "200");
    expect(quantity).toHaveValue(1);
    expect(
      screen.getByText(
        /the platform assigns the next code.*mark the sidewall with the code shown after saving/i,
      ),
    ).toBeInTheDocument();
    await screen.findByLabelText(/^size$/i);
  });

  it("requires the code field and offers no quantity field under FREE", async () => {
    renderScreen("FREE");

    expect(screen.getByLabelText(/display code/i)).toBeRequired();
    expect(screen.queryByLabelText(/quantity/i)).not.toBeInTheDocument();
    await screen.findByLabelText(/^size$/i);
  });

  it("never posts with an empty code under FREE, guarding independently of the required attribute", async () => {
    const { container } = renderScreen("FREE");
    await chooseEntries();

    await forceSubmit(container);

    expect(receivedBodies()).toHaveLength(0);
  });

  it("lists sizes and brands in natural order whatever order the server sends", async () => {
    renderScreen("GENERATED");

    expect(optionNames(await screen.findByLabelText(/^size$/i))).toEqual([
      "Choose a size",
      "SZ2",
      "SZ10",
    ]);
    expect(optionNames(screen.getByLabelText(/^brand$/i))).toEqual([
      "No brand chosen",
      "Apollo",
      "Dunlop",
    ]);
  });

  // FR-CFG-004: a received tyre is new, so the retread-only pattern is never
  // offered; a chosen brand narrows to its own patterns and the unbranded.
  it("offers only new-tyre patterns, narrowed by a chosen brand to its own and the unbranded ones", async () => {
    renderScreen("GENERATED");

    const pattern = await screen.findByLabelText(/^pattern$/i);
    expect(optionNames(pattern)).toEqual(["Choose a pattern", "All Position", "Haul", "SP431"]);
    await userEvent.selectOptions(screen.getByLabelText(/^brand$/i), "b2");
    expect(optionNames(screen.getByLabelText(/^pattern$/i))).toEqual([
      "Choose a pattern",
      "All Position",
      "Haul",
    ]);
  });

  // NFR-USE-006: a branded pattern names its brand, so it is not asked twice.
  // The select's value cannot prove the clear: once p1 drops out of the
  // options, React selects the first option whatever patternId holds. A
  // forced submit can, because patternId is what the guard reads.
  it("sets the brand from a branded pattern, and clears that pattern when the brand moves to another", async () => {
    const { container } = renderScreen("GENERATED");

    await userEvent.selectOptions(await screen.findByLabelText(/^pattern$/i), "p1");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("b1");
    await userEvent.selectOptions(screen.getByLabelText(/^brand$/i), "b2");
    await userEvent.selectOptions(screen.getByLabelText(/^size$/i), "s2");
    await userEvent.type(screen.getByLabelText(/new tread/i), "25.0");

    await forceSubmit(container);

    expect(receivedBodies()).toHaveLength(0);
  });

  // With the brand cleared and the pattern kept, the screen would show no
  // brand while app.receive_tyres stores the pattern's (NFR-USE-006).
  it("clearing the brand clears a branded pattern, and an unbranded pattern survives a brand change", async () => {
    renderScreen("GENERATED");

    await userEvent.selectOptions(await screen.findByLabelText(/^pattern$/i), "p1");
    await userEvent.selectOptions(screen.getByLabelText(/^brand$/i), "");
    expect(screen.getByLabelText(/^pattern$/i)).toHaveValue("");

    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "p2");
    await userEvent.selectOptions(screen.getByLabelText(/^brand$/i), "b2");
    expect(screen.getByLabelText(/^pattern$/i)).toHaveValue("p2");
  });

  it("clears a brand filled in from a pattern when an unbranded pattern replaces it, and sends none", async () => {
    mockApi({ receives: [minted("TP-00042")] });
    renderScreen("GENERATED");

    await userEvent.selectOptions(await screen.findByLabelText(/^pattern$/i), "p1");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("b1");
    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "p2");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("");
    expect(optionNames(screen.getByLabelText(/^pattern$/i))).toContain("Haul");

    await chooseEntries({ pattern: "" });
    await submit();
    await screen.findByRole("status");

    expect(receivedBodies()[0]).toMatchObject({ patternId: "p2" });
    expect(receivedBodies()[0]).not.toHaveProperty("brandId");
  });

  it("clears a brand filled in from a pattern when the pattern is set back to none", async () => {
    renderScreen("GENERATED");

    await userEvent.selectOptions(await screen.findByLabelText(/^pattern$/i), "p1");
    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "");

    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("");
  });

  it("keeps a brand the user chose when its pattern gives way to an unbranded one or none", async () => {
    renderScreen("GENERATED");

    await userEvent.selectOptions(await screen.findByLabelText(/^brand$/i), "b1");
    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "p1");
    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "p2");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("b1");
    await userEvent.selectOptions(screen.getByLabelText(/^pattern$/i), "");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("b1");
  });

  // Object rows, not tuples: a tuple table types each argument as the union
  // of both columns, which chooseEntries would refuse.
  it.each([
    { missing: "a size", entries: { size: "" } },
    { missing: "a pattern", entries: { pattern: "" } },
    { missing: "a new tread", entries: { tread: "" } },
  ])("never posts without $missing", async ({ entries }) => {
    const { container } = renderScreen("GENERATED");
    await chooseEntries(entries);

    await forceSubmit(container);

    expect(receivedBodies()).toHaveLength(0);
  });

  // "1234" would otherwise reach the numeric(4,1) cast and come back as
  // 22003's generic message rather than one naming the field.
  it.each(["25.55", "abc", "2 5", "1234"])(
    "refuses a new tread of %s inline, before any submit",
    async (tread) => {
      const { container } = renderScreen("GENERATED");
      await chooseEntries({ tread });

      expect(screen.getByLabelText(/new tread/i)).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByText(/at most three digits and one decimal place/i)).toBeInTheDocument();
      await forceSubmit(container);
      expect(receivedBodies()).toHaveLength(0);
    },
  );

  it("hints at the awaiting-cost queue while the price is blank and hides the cost source select", async () => {
    renderScreen("FREE");

    expect(screen.getByText(/awaiting-cost queue/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/cost source/i)).not.toBeInTheDocument();
    await screen.findByLabelText(/^size$/i);
  });

  // TYRE-370: a recorded cost is never corrected, so no source is chosen
  // for the operator.
  it("shows the cost source once a price is entered, on no source, and hides the hint", async () => {
    renderScreen("FREE");
    await screen.findByLabelText(/^size$/i);

    await userEvent.type(screen.getByLabelText(/purchase price/i), "10.50");

    expect(screen.getByLabelText(/cost source/i)).toHaveValue("");
    expect(screen.queryByText(/awaiting-cost queue/i)).not.toBeInTheDocument();
  });

  it("blocks a priced receive until a source is chosen, and says why", async () => {
    const { container } = renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await userEvent.type(screen.getByLabelText(/purchase price/i), "500.00");

    expect(screen.getByText(/choose where this price came from/i)).toBeInTheDocument();
    await forceSubmit(container);
    expect(receivedBodies()).toHaveLength(0);

    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "INVOICE");
    expect(screen.queryByText(/choose where this price came from/i)).not.toBeInTheDocument();
  });

  // A choice made while a price was entered stays in state after the price
  // is cleared, and must not ride along (TYRE-370).
  it("never sends a cost source the user did not choose, nor one left behind by a cleared price", async () => {
    mockApi({ receives: [minted("TYRE1")] });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await userEvent.type(screen.getByLabelText(/purchase price/i), "500.00");
    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "PRICE_LIST_ESTIMATE");
    await userEvent.clear(screen.getByLabelText(/purchase price/i));
    await submit();
    await screen.findByRole("status");

    expect(receivedBodies()[0]).not.toHaveProperty("costSource");
    expect(receivedBodies()[0]).not.toHaveProperty("purchasePrice");
  });

  // The whole point of the money-stays-a-string rule: Number("10.50")
  // stringifies back as "10.5", silently dropping the trailing zero.
  // Asserted as an exact string, never re-derived with Number/parseFloat.
  it("never coerces the price or the tread to a number: the exact strings reach receiveTyres", async () => {
    mockApi({ receives: [minted("TYRE1")] });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries({ tread: "25.0" });
    await userEvent.type(screen.getByLabelText(/purchase price/i), "10.50");
    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "INVOICE");
    await submit();
    await screen.findByRole("status");

    const [body] = receivedBodies();
    expect(body.purchasePrice).toBe("10.50");
    expect(body.newTreadMm).toBe("25.0");
    expect(body.costSource).toBe("INVOICE");
    expect(body).not.toHaveProperty("quantity");
  });

  it("sends the chosen cost source alongside the price, and omits it while the price is blank", async () => {
    mockApi({ receives: [minted("TYRE1"), minted("TYRE2")] });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await userEvent.type(screen.getByLabelText(/purchase price/i), "500.00");
    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "PRICE_LIST_ESTIMATE");
    await submit();
    await screen.findByRole("status");

    expect(receivedBodies()[0]).toMatchObject({
      purchasePrice: "500.00",
      costSource: "PRICE_LIST_ESTIMATE",
    });

    // userEvent.type appends to whatever is already there, so a dropped
    // setDisplayCode("") in onSuccess would send "TYRE1TYRE2" and nothing
    // else here would catch it.
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE2");
    await chooseEntries();
    await submit();
    await screen.findByText(/TYRE2/);

    expect(receivedBodies()[1]).toMatchObject({ displayCode: "TYRE2" });
    expect(receivedBodies()[1]).not.toHaveProperty("costSource");
    expect(receivedBodies()[1]).not.toHaveProperty("purchasePrice");
  });

  // NFR-USE-010: success is shown explicitly. A bulk GENERATED receive
  // mints more than one code, each of which the operator still has to go
  // mark a sidewall with.
  it("shows every issued display code explicitly and clears every field on success", async () => {
    mockApi({ receives: [minted("TP-00042", "TP-00043")] });
    renderScreen("GENERATED");
    await userEvent.clear(screen.getByLabelText(/quantity/i));
    await userEvent.type(screen.getByLabelText(/quantity/i), "2");
    await chooseEntries();
    await submit();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/TP-00042/);
    expect(status).toHaveTextContent(/TP-00043/);
    expect(receivedBodies()[0]).toStrictEqual({
      quantity: 2,
      sizeId: "s2",
      patternId: "p1",
      brandId: "b1",
      newTreadMm: "25.0",
    });
    expect(screen.getByLabelText(/quantity/i)).toHaveValue(1);
    expect(screen.getByLabelText(/^size$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^brand$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^pattern$/i)).toHaveValue("");
    expect(screen.getByLabelText(/new tread/i)).toHaveValue("");
  });

  it("clears the cost source on success, so nothing is chosen for the next receive", async () => {
    mockApi({ receives: [minted("TP-00042")] });
    renderScreen("GENERATED");
    await chooseEntries();
    await userEvent.type(screen.getByLabelText(/purchase price/i), "500.00");
    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "INVOICE");
    await submit();
    await screen.findByRole("status");

    await userEvent.type(screen.getByLabelText(/purchase price/i), "600.00");
    expect(screen.getByLabelText(/cost source/i)).toHaveValue("");
  });

  it("says the catalogue is loading and blocks submission until it arrives", async () => {
    mockApi({ catalogue: null });
    const { container } = renderScreen("GENERATED");

    expect(await screen.findByText(/loading the tyre catalogue/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /receive/i })).toBeDisabled();
    await forceSubmit(container);
    expect(receivedBodies()).toHaveLength(0);
  });

  it("says the catalogue could not be loaded and blocks submission", async () => {
    mockApi({ catalogue: () => respond(500, { code: "internal", message: "internal error" }) });
    const { container } = renderScreen("GENERATED");

    expect(await screen.findByText(/tyre catalogue could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^receive$/i })).toBeDisabled();
    await forceSubmit(container);
    expect(receivedBodies()).toHaveLength(0);
  });

  it.each([
    { lacking: "no sizes", catalogue: { ...CATALOGUE, sizes: [] } },
    {
      lacking: "no new-tyre patterns",
      catalogue: {
        ...CATALOGUE,
        patterns: [{ id: "p3", name: "Recap", brandId: null, appliesTo: "RETREAD" }],
      },
    },
  ])(
    "sends the operator to an administrator when the catalogue has $lacking",
    async ({ catalogue }) => {
      mockApi({ catalogue: () => respond(200, catalogue) });
      const { container } = renderScreen("GENERATED");

      expect(await screen.findByText(/no tyre catalogue yet/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^size$/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /receive/i })).toBeDisabled();
      await forceSubmit(container);
      expect(receivedBodies()).toHaveLength(0);
    },
  );

  it("renders the register's own message for a speakable refusal", async () => {
    mockApi({
      receives: [
        () =>
          respond(409, {
            code: "display_code_taken",
            message: "an active tyre already carries that display code",
          }),
      ],
    });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "DUPE1");
    await chooseEntries();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already carries that display code/i,
    );
  });

  it("renders app.receive_tyres' own TY011 message", async () => {
    mockApi({
      receives: [
        () =>
          respond(422, {
            code: "TY011",
            message:
              "that pattern is not in this fleet's active catalogue; choose another, or ask an administrator to add it",
          }),
      ],
    });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "that pattern is not in this fleet's active catalogue; choose another, or ask an administrator to add it",
    );
  });

  it("falls back to a generic message for a refusal with an unrecognised code", async () => {
    mockApi({ receives: [() => respond(500, { code: "boom", message: "unrecognised" })] });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be received/i);
  });

  it("names the permission problem for a receive refused as forbidden", async () => {
    mockApi({ receives: [() => respond(403, { code: "forbidden", message: "no" })] });
    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await chooseEntries();
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission to receive tyres/i);
  });
});
