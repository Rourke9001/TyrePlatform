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

function renderForm(t: Tyre = tyre({ id: "t1" })) {
  return render(
    <QueryClientProvider client={testQueryClient()}>
      <DispatchForm tyre={t} tenantKey="tenant-a" />
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

  it("shows an explicit success line once the dispatch is recorded", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("radio", { name: "Retreader" }));
    const depotSelect = await screen.findByRole("combobox", { name: /depot for pos1/i });
    await user.selectOptions(depotSelect, "r1");
    await user.click(screen.getByRole("button", { name: /^dispatch$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/pos1 was dispatched/i);
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
