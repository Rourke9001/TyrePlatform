import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ReceiveTyre } from "./ReceiveTyre";
import { ActorContext } from "../auth/actorContext";
import { me, respond, sentBody, testQueryClient } from "../test/fixtures";

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

async function submit() {
  await userEvent.click(screen.getByRole("button", { name: /receive/i }));
}

describe("receiving tyres into the fleet", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // D12/AS-014: under a generated scheme the operator never types a code —
  // one is minted server-side and must be carried to the physical tyre by
  // hand, so the screen has to say that step out loud, not just omit the
  // field and leave the operator guessing.
  it("hides the code field, bounds the quantity 1-200 defaulting to 1, and names the sidewall step under GENERATED", () => {
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
  });

  it("requires the code field and offers no quantity field under FREE", () => {
    renderScreen("FREE");

    expect(screen.getByLabelText(/display code/i)).toBeRequired();
    expect(screen.queryByLabelText(/quantity/i)).not.toBeInTheDocument();
  });

  // ReceiveTyre.tsx's own guard (`if (isFree && displayCode.trim() === "")
  // return;`), proven independently of the `required` attribute. Two
  // non-obvious things: a real click on the submit button never even reaches
  // React's onSubmit here — jsdom's constraint validation intercepts it
  // first — so fireEvent.submit dispatches the "submit" event directly,
  // skipping that interception. And useMutation's mutate() does not call
  // fetch synchronously, so asserting "not called" right after firing the
  // event passes whether or not the guard exists; the setTimeout flush lets
  // a wrongly-removed guard's fetch call actually land before the assertion
  // runs.
  it("never calls the API for an empty code under FREE, guarding independently of the required attribute", async () => {
    const { container } = renderScreen("FREE");

    const form = container.querySelector("form");
    if (form === null) throw new Error("expected a form element");
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("hints at the awaiting-cost queue while the price is blank and hides the cost source select", () => {
    renderScreen("FREE");

    expect(screen.getByText(/awaiting-cost queue/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/cost source/i)).not.toBeInTheDocument();
  });

  it("shows the cost source select only once a price is entered, and hides the hint", async () => {
    renderScreen("FREE");

    await userEvent.type(screen.getByLabelText(/purchase price/i), "10.50");

    expect(screen.getByLabelText(/cost source/i)).toBeInTheDocument();
    expect(screen.queryByText(/awaiting-cost queue/i)).not.toBeInTheDocument();
  });

  // The whole point of web/CLAUDE.md's money-stays-a-string rule:
  // Number("10.50") stringifies back as "10.5", silently dropping the
  // trailing zero. Asserting the exact string (never re-derived with
  // Number/parseFloat in this test either) is the only check that would
  // actually fail if the component coerced.
  it("never coerces the price to a number: the exact string, trailing zero included, reaches receiveTyres", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(201, { tyres: [{ id: "t1", displayCode: "TYRE1" }] }),
    );

    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await userEvent.type(screen.getByLabelText(/purchase price/i), "10.50");
    await submit();

    await screen.findByRole("status");
    const body = sentBody(0) as Record<string, unknown>;
    expect(body.purchasePrice).toBe("10.50");
    expect(typeof body.purchasePrice).toBe("string");
    expect(body).not.toHaveProperty("quantity");
  });

  it("sends the chosen cost source alongside the price, and omits it while the price is blank", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, { tyres: [{ id: "t1", displayCode: "TYRE1" }] }))
      .mockResolvedValueOnce(respond(201, { tyres: [{ id: "t2", displayCode: "TYRE2" }] }));

    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await userEvent.type(screen.getByLabelText(/purchase price/i), "500.00");
    await userEvent.selectOptions(screen.getByLabelText(/cost source/i), "PRICE_LIST_ESTIMATE");
    await submit();
    await screen.findByRole("status");

    expect(sentBody(0)).toMatchObject({
      purchasePrice: "500.00",
      costSource: "PRICE_LIST_ESTIMATE",
    });

    // No price this time round the form was just cleared by the success it
    // just had, so costSource must not survive as a stray field. The code
    // field must have cleared too: userEvent.type appends to whatever is
    // already there, so a dropped setDisplayCode("") in onSuccess would send
    // "TYRE1TYRE2" here and nothing else in this test would catch it.
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE2");
    await submit();
    await screen.findByRole("status");

    expect(sentBody(1)).toMatchObject({ displayCode: "TYRE2" });
    expect(sentBody(1)).not.toHaveProperty("costSource");
    expect(sentBody(1)).not.toHaveProperty("purchasePrice");
  });

  // NFR-USE-010: success must be shown explicitly, never inferred from the
  // absence of an error — and a bulk GENERATED receive mints more than one
  // code, every one of which the operator now has to go and mark a sidewall
  // with.
  it("shows every issued display code explicitly and clears the form on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(201, {
        tyres: [
          { id: "t1", displayCode: "TP-00042" },
          { id: "t2", displayCode: "TP-00043" },
        ],
      }),
    );

    renderScreen("GENERATED");
    await userEvent.clear(screen.getByLabelText(/quantity/i));
    await userEvent.type(screen.getByLabelText(/quantity/i), "2");
    await submit();

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/TP-00042/);
    expect(status).toHaveTextContent(/TP-00043/);

    expect(sentBody(0)).toStrictEqual({ quantity: 2 });
    expect(screen.getByLabelText(/quantity/i)).toHaveValue(1);
  });

  it("renders the register's own message for a speakable refusal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(409, {
        code: "display_code_taken",
        message: "an active tyre already carries that display code",
      }),
    );

    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "DUPE1");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already carries that display code/i,
    );
  });

  it("falls back to a generic message for a refusal with an unrecognised code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));

    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await submit();

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be received/i);
  });

  it("names the permission problem for a receive refused as forbidden", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));

    renderScreen("FREE");
    await userEvent.type(screen.getByLabelText(/display code/i), "TYRE1");
    await submit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission to receive tyres/i);
  });
});
