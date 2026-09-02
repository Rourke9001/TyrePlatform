import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { DispatchForm } from "./DispatchForm";
import type { Tyre } from "../../api/tyres";
import { requestedUrl, respond, sentBody, testQueryClient } from "../../test/fixtures";

function tyre(overrides: Partial<Tyre> & { id: string }): Tyre {
  return {
    displayCode: "POS1",
    state: "REMOVED",
    status: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    brandName: "Bridgestone",
    patternName: "R150",
    receivedDate: "2026-01-05",
    awaitingCost: false,
    ...overrides,
  };
}

// A deferred whose executor assigns the resolver, released before the test
// ends (docs/lessons.md, 31 Aug 2026) — holds the depot read in flight long
// enough to assert the pending option, without a fake timer.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const RETREADERS = [{ id: "r1", name: "Retread Co", type: "RETREADER" }];
const BREAKDOWN = [{ id: "b1", name: "Roadside Rescue", type: "BREAKDOWN_SUPPLIER" }];

function stubDepots() {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url.includes("type=RETREADER")) return Promise.resolve(respond(200, RETREADERS));
    if (url.includes("type=BREAKDOWN_SUPPLIER")) return Promise.resolve(respond(200, BREAKDOWN));
    return Promise.resolve(respond(201, {}));
  });
}

function dispatchCallIndex(): number {
  return vi
    .mocked(fetch)
    .mock.calls.findIndex(([input]) => requestedUrl(input) === "/api/tyres/t1/dispatch");
}

function renderForm(t: Tyre = tyre({ id: "t1" }), onSuccess?: (destination: string) => void) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <DispatchForm tyre={t} tenantKey="tenant-a" onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
}

describe("dispatching a tyre", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    stubDepots();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers no depot picker before a destination is picked", () => {
    renderForm();

    expect(screen.queryByRole("combobox", { name: /depot for pos1/i })).not.toBeInTheDocument();
  });

  // app.dispatch_tyre's own destination-to-type mapping (000033): the depot
  // picker must not offer a breakdown supplier when Retreader is chosen.
  it("offers the retreader depots once Retreader is picked", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));

    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    expect(await within(depotSelect).findByRole("option", { name: "Retread Co" })).toBeTruthy();
    expect(within(depotSelect).queryByRole("option", { name: "Roadside Rescue" })).toBeNull();
  });

  it("switches to the breakdown-supplier depots when that destination is picked", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Breakdown supplier" }));

    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    expect(
      await within(depotSelect).findByRole("option", { name: "Roadside Rescue" }),
    ).toBeTruthy();
  });

  // Regression for the radio's onChange dropping setDepotId(""): a depot
  // chosen for Retreader is not necessarily a valid Breakdown supplier depot
  // (app.dispatch_tyre's own type check would refuse it as TY014), so the
  // switch must clear the selection, not carry a now-stale depot forward.
  it("clears the picked depot when the destination is switched", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "r1");
    expect(depotSelect).toHaveValue("r1");

    await user.click(screen.getByRole("radio", { name: "Breakdown supplier" }));

    await within(depotSelect).findByRole("option", { name: "Roadside Rescue" });
    expect(within(depotSelect).queryByRole("option", { name: "Retread Co" })).toBeNull();
    expect(depotSelect).toHaveValue("");
    // A controlled select whose value matches no option renders the first
    // non-disabled one instead — "" reads the same whether depotId actually
    // cleared or is stale at "r1". The submit button's own disabled check
    // does not share that ambiguity: a stale depotId leaves it enabled and
    // would dispatch to the wrong depot.
    expect(screen.getByRole("button", { name: /^dispatch$/i })).toBeDisabled();
  });

  it("sends destination and depotId, omitting sentOn when it is left blank", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "r1");
    await user.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() => expect(dispatchCallIndex()).toBeGreaterThanOrEqual(0));
    expect(sentBody(dispatchCallIndex())).toStrictEqual({
      destination: "AT_RETREADER",
      depotId: "r1",
    });
  });

  it("sends sentOn when a date is entered", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Breakdown supplier" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "b1");
    fireEvent.change(screen.getByLabelText(/sent on/i), { target: { value: "2026-02-01" } });
    await user.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() => expect(dispatchCallIndex()).toBeGreaterThanOrEqual(0));
    expect(sentBody(dispatchCallIndex())).toStrictEqual({
      destination: "AT_BREAKDOWN_SUPPLIER",
      depotId: "b1",
      sentOn: "2026-02-01",
    });
  });

  // The confirmation itself is a TyreList-level concern (see
  // TyreList.test.tsx); this only proves the form hands the chosen
  // destination up rather than swallowing it.
  it("calls onSuccess with the chosen destination once the dispatch is recorded", async () => {
    const onSuccess = vi.fn();
    const user = userEvent.setup();
    renderForm(tyre({ id: "t1" }), onSuccess);

    await user.click(screen.getByRole("radio", { name: "Retreader" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "r1");
    await user.click(screen.getByRole("button", { name: /^dispatch$/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("AT_RETREADER"));
  });

  it("shows a loading option while the depot read is pending", async () => {
    const inFlight = deferred<Response>();
    vi.mocked(fetch).mockImplementation(() => inFlight.promise);
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));

    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    const loading = within(depotSelect).getByRole("option", { name: /loading/i });
    expect(loading).toBeDisabled();

    inFlight.resolve(respond(200, RETREADERS));
    await within(depotSelect).findByRole("option", { name: "Retread Co" });
  });

  it("shows an alert with a retry action when the depot read fails, and recovers on retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));

    const alert = await screen.findByRole("alert");
    const retry = within(alert).getByRole("button", { name: /retry/i });
    expect(screen.queryByRole("combobox", { name: /depot for pos1/i })).not.toBeInTheDocument();

    await user.click(retry);

    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    expect(await within(depotSelect).findByRole("option", { name: "Retread Co" })).toBeTruthy();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // TY015's own sentence is the whole content of the refusal (NFR-USE-005) —
  // rendered verbatim, not replaced by a general one.
  it("renders TY015's message verbatim when the casing is at its retread cap", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.includes("type=RETREADER")) return Promise.resolve(respond(200, RETREADERS));
      return Promise.resolve(
        respond(422, {
          code: "TY015",
          message:
            "this casing has been retreaded 4 time(s), at a cap of 4; at its cap it is a purchase, not a retread candidate",
        }),
      );
    });
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "r1");
    await user.click(screen.getByRole("button", { name: /^dispatch$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /a purchase, not a retread candidate/i,
    );
  });
});
