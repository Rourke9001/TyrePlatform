import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { PositionPanel } from "./PositionPanel";
import { openFitmentsKey } from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Tyre } from "../../api/tyres";
import type { Unit, UnitPosition } from "../../api/units";
import {
  me,
  openFitment,
  requestedUrl,
  respond,
  sentBody,
  testQueryClient,
  unit,
  unitPosition,
} from "../../test/fixtures";

const STOCK: Tyre[] = [
  {
    id: "t7",
    displayCode: "TY007",
    state: "IN_STOCK",
    status: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    brandName: "Bridgestone",
    patternName: "R150",
    receivedDate: "2026-01-05",
    awaitingCost: false,
  },
  {
    id: "t8",
    displayCode: "TY008",
    state: "FITTED",
    status: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    brandName: "Bridgestone",
    patternName: "R150",
    receivedDate: "2026-01-05",
    awaitingCost: false,
  },
];

function renderPanel(
  position: UnitPosition,
  overrides: Partial<Unit> = {},
  capabilities: string[] = ["ManageAssets", "ViewFleet"],
) {
  const u = unit({ ...overrides, positions: [position] });
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <PositionPanel unit={u} position={position} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

// Every request the panel makes, answered by path: the tyre read and the
// write race, and mockResolvedValueOnce would hand whichever landed first
// the other's body.
function stubFetch(fitResponse: unknown = { fitmentId: "f9", warnings: [] }) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url.startsWith("/api/tyres")) return Promise.resolve(respond(200, { tyres: STOCK }));
    if (url.endsWith("/remove")) return Promise.resolve(new Response(null, { status: 204 }));
    if (url.endsWith("/fitments")) return Promise.resolve(respond(201, fitResponse));
    throw new Error(`unstubbed ${url}`);
  });
}

describe("a position panel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers a fit for an empty position and a removal for an occupied one", async () => {
    stubFetch();
    const { unmount } = renderPanel(unitPosition({ id: "p1", code: "POS1" }));
    expect(await screen.findByRole("combobox", { name: "Tyre" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Reason" })).toBeNull();
    unmount();

    renderPanel(unitPosition({ id: "p2", code: "POS2", fitment: openFitment() }));
    expect(await screen.findByRole("combobox", { name: "Reason" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Tyre" })).toBeNull();
  });

  it("offers only tyres the register holds in stock", async () => {
    stubFetch();
    renderPanel(unitPosition({ id: "p1" }));
    const picker = await screen.findByRole("combobox", { name: "Tyre" });
    // The register read is in flight when the select first renders, so the
    // option has to be awaited rather than the control that will hold it.
    expect(await within(picker).findByRole("option", { name: "TY007" })).toBeTruthy();
    expect(within(picker).queryByRole("option", { name: "TY008" })).toBeNull();
  });

  // A trailer has no odometer, so neither form may ask for one. Both halves:
  // a panel that never rendered the field would pass the absence assertion
  // on its own (docs/lessons.md, 26 Aug 2026). Required, not optional: the
  // write is refused as TY009 without it (FR-FIT-002).
  it("asks for an odometer on a unit that has one and never on a unit that does not", async () => {
    stubFetch();
    const { unmount } = renderPanel(unitPosition({ id: "p1" }), { hasOdometer: true });
    const field = await screen.findByRole("textbox", { name: "Odometer" });
    expect(field.hasAttribute("required")).toBe(true);
    unmount();

    renderPanel(unitPosition({ id: "p1" }), { hasOdometer: false, unitKind: "TRAILER" });
    await screen.findByRole("combobox", { name: "Tyre" });
    expect(screen.queryByRole("textbox", { name: "Odometer" })).toBeNull();
  });

  // The remove form carries its own hasOdometer guard, which the fit form's
  // pair above never renders. Both halves again, on an occupied position.
  it("asks a removal for an odometer on a unit that has one and never otherwise", async () => {
    stubFetch();
    const occupied = unitPosition({ id: "p2", code: "POS2", fitment: openFitment() });
    const { unmount } = renderPanel(occupied, { hasOdometer: true });
    await screen.findByRole("combobox", { name: "Reason" });
    expect(screen.getByRole("textbox", { name: "Odometer" }).hasAttribute("required")).toBe(true);
    unmount();

    renderPanel(occupied, { hasOdometer: false, unitKind: "TRAILER" });
    await screen.findByRole("combobox", { name: "Reason" });
    expect(screen.queryByRole("textbox", { name: "Odometer" })).toBeNull();
  });

  // CLAUDE.md rule 3: the reading lands on an event nothing can edit, and
  // CR-012 turns it into a distance. Number.parseInt would have read each of
  // these as 125 and sent it.
  it.each(["125 000", "125.7", "12a"])(
    "refuses the odometer %s rather than sending a truncated reading",
    async (typed) => {
      stubFetch();
      const user = userEvent.setup();
      renderPanel(unitPosition({ id: "p1", code: "POS1" }), { hasOdometer: true });

      await screen.findByRole("option", { name: "TY007" });
      await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
      await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
      await user.type(screen.getByRole("textbox", { name: "Odometer" }), typed);
      await user.click(screen.getByRole("button", { name: "Fit tyre" }));

      expect((await screen.findByRole("alert")).textContent).toContain("digits only");
      // One call, the register read: no fit was sent.
      expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    },
  );

  it("refuses a malformed odometer on a removal too", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(
      unitPosition({ id: "p2", code: "POS2", fitment: openFitment({ fitmentId: "f4" }) }),
      {
        hasOdometer: true,
        removalReasons: ["Worn out"],
      },
    );

    await user.selectOptions(await screen.findByRole("combobox", { name: "Reason" }), "Worn out");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "125 000");
    await user.click(screen.getByRole("button", { name: "Remove tyre" }));

    expect((await screen.findByRole("alert")).textContent).toContain("digits only");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("sends the fit under the server's own field names", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(unitPosition({ id: "p1", code: "POS1" }), { id: "u9", hasOdometer: true });

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("radio", { name: "Mark inboard" }));
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "123456");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
    });
    expect(sentBody(1)).toEqual({
      tyreId: "t7",
      positionId: "p1",
      treadMm: "15.5",
      mountOrientation: "MARK_INBOARD",
      odometer: 123456,
    });
  });

  // D13: nobody touching the radios is a fit nobody asserted an orientation
  // for, and the fitment row is immutable — MARK_OUTBOARD must never be the
  // default the write carries.
  it("sends UNKNOWN orientation when the radios are never touched", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(unitPosition({ id: "p1", code: "POS1" }), { id: "u9", hasOdometer: false });

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
    });
    expect(sentBody(1)).toMatchObject({ mountOrientation: "UNKNOWN" });
  });

  // Odometer is asked for but not guarded like the tread is: readOdometer
  // reads a blank as "no value", so without this check a blank field on a
  // unit that requires the reading would pass silently and round-trip to a
  // TY009 the server has to speak instead.
  it("refuses a fit with a blank odometer on a unit that has one, without sending it", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(unitPosition({ id: "p1", code: "POS1" }), { hasOdometer: true });

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    // Whitespace-only: the field is `required`, which a blank value fails in
    // jsdom before the submit handler runs at all, so this is the only way to
    // reach the guard itself rather than the browser's own validation.
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "   ");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Enter the odometer");
    // One call, the register read: no fit was sent.
    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
  });

  // A background refetch (window focus, another write's invalidation) can
  // swap the occupant of a position out from under a half-typed removal.
  // Readings typed for the old fitment must never survive to close a
  // different one.
  it("clears the removal form's fields when the occupied fitment changes under it", async () => {
    stubFetch();
    const user = userEvent.setup();
    const client = testQueryClient();
    const f1 = unitPosition({
      id: "p2",
      code: "POS2",
      fitment: openFitment({ fitmentId: "f1", displayCode: "TY001" }),
    });
    const u = unit({ hasOdometer: true, removalReasons: ["Worn out"], positions: [f1] });
    const tree = (position: UnitPosition) => (
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <PositionPanel unit={u} position={position} />
        </QueryClientProvider>
      </ActorContext.Provider>
    );
    const { rerender } = render(tree(f1));

    await user.selectOptions(await screen.findByRole("combobox", { name: "Reason" }), "Worn out");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "123456");

    const f2 = unitPosition({
      id: "p2",
      code: "POS2",
      fitment: openFitment({ fitmentId: "f2", displayCode: "TY002" }),
    });
    rerender(tree(f2));

    expect(screen.getByRole("combobox", { name: "Reason" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Tread (mm)" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Odometer" })).toHaveValue("");
  });

  it("shows a fit's warnings as status text, never as a refusal", async () => {
    stubFetch({
      fitmentId: "f9",
      warnings: [{ code: "dual_mate_tread_gap", message: "Its dual mate is 4.0 mm shallower." }],
    });
    const user = userEvent.setup();
    renderPanel(unitPosition({ id: "p1" }), { hasOdometer: false });

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    const warnings = await screen.findByRole("status", { name: "Warnings" });
    expect(within(warnings).getByText("Its dual mate is 4.0 mm shallower.")).toBeTruthy();
    expect(warnings.closest('[role="alert"]')).toBeNull();
  });

  it("renders no warning list at all when the fit raised none", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(unitPosition({ id: "p1", code: "POS1" }), { hasOdometer: false });

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    await screen.findByText("TY007 was fitted to POS1.");
    expect(screen.queryAllByRole("status", { name: "Warnings" })).toHaveLength(0);
  });

  it("offers the tenant's own removal reasons and sends the removal", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(
      unitPosition({ id: "p2", code: "POS2", fitment: openFitment({ fitmentId: "f4" }) }),
      {
        hasOdometer: false,
        removalReasons: ["Worn out", "Sidewall damage"],
      },
    );

    const reason = await screen.findByRole("combobox", { name: "Reason" });
    expect(within(reason).getByRole("option", { name: "Sidewall damage" })).toBeTruthy();
    await user.selectOptions(reason, "Sidewall damage");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.click(screen.getByRole("button", { name: "Remove tyre" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0);
    });
    const last = vi.mocked(fetch).mock.calls.length - 1;
    expect(requestedUrl(vi.mocked(fetch).mock.calls[last][0])).toBe("/api/fitments/f4/remove");
    expect(sentBody(last)).toEqual({ reason: "Sidewall damage", treadMm: "4.5" });
  });

  // The panel holds both mutations so a fit's warnings survive the swap to the
  // remove form. Neither mutation forgets its success, so the confirmation has
  // to name the write that was actually last: two sentences about one tyre,
  // one of them false, is worse than none (NFR-USE-010).
  it("replaces the fit's confirmation with the removal's rather than showing both", async () => {
    stubFetch({
      fitmentId: "f4",
      warnings: [{ code: "dual_mate_tread_gap", message: "Its dual mate is 4.0 mm shallower." }],
    });
    const user = userEvent.setup();
    const empty = unitPosition({ id: "p1", code: "POS1" });
    const u = unit({ hasOdometer: false, removalReasons: ["Worn out"], positions: [empty] });
    const tree = (position: UnitPosition) => (
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <PositionPanel unit={u} position={position} />
        </QueryClientProvider>
      </ActorContext.Provider>
    );
    const client = testQueryClient();
    const { rerender } = render(tree(empty));

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));
    await screen.findByText("TY007 was fitted to POS1.");
    expect(screen.getByRole("status", { name: "Warnings" })).toBeTruthy();

    // The invalidated read comes back with the position occupied, which is
    // what swaps the form under the same panel.
    const occupied = unitPosition({
      id: "p1",
      code: "POS1",
      fitment: openFitment({ fitmentId: "f4", displayCode: "TY007" }),
    });
    rerender(tree(occupied));

    await user.selectOptions(screen.getByRole("combobox", { name: "Reason" }), "Worn out");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.click(screen.getByRole("button", { name: "Remove tyre" }));

    await screen.findByText("TY007 was removed from POS1.");
    expect(screen.queryByText("TY007 was fitted to POS1.")).toBeNull();
    expect(screen.queryAllByRole("status", { name: "Warnings" })).toHaveLength(0);
  });

  // Nothing on this screen reads the fleet-wide fitments list, so the only
  // thing that can mark it stale is this write's own invalidation list: an
  // entry left valid is served to /fleet/fitments for as long as gcTime
  // holds it, showing a position this fit has just occupied as empty.
  it("invalidates the fleet-wide fitments list its fit makes stale", async () => {
    stubFetch();
    const user = userEvent.setup();
    const client = testQueryClient();
    const key = openFitmentsKey(getDevTenantId() ?? "default");
    // Seeded first: invalidateQueries on a key with no cache entry is
    // silently a no-op, and the assertion below would then hold whatever the
    // invalidation list said.
    client.setQueryData(key, []);
    const position = unitPosition({ id: "p1", code: "POS1" });

    render(
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <PositionPanel
            unit={unit({ hasOdometer: false, positions: [position] })}
            position={position}
          />
        </QueryClientProvider>
      </ActorContext.Provider>,
    );

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));

    await waitFor(() => {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    });
  });

  // The removal's closing UPDATE answers to 000025's trigger as the fit's
  // INSERT does, so a unit read that says "no odometer" while the server says
  // otherwise refuses here too. Without TY009 in REMOVE_WORDING the sentence
  // is the general one, which does not say what to do next (ADR-0012).
  it("speaks TY009 on a removal, not the general sentence", async () => {
    const message = "fitment odometer is required for a unit that has one";
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/tyres")) return Promise.resolve(respond(200, { tyres: STOCK }));
      return Promise.resolve(respond(422, { code: "TY009", message }));
    });
    const user = userEvent.setup();
    renderPanel(
      unitPosition({ id: "p2", code: "POS2", fitment: openFitment({ fitmentId: "f4" }) }),
      { hasOdometer: false, removalReasons: ["Worn out"] },
    );

    await user.selectOptions(await screen.findByRole("combobox", { name: "Reason" }), "Worn out");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.click(screen.getByRole("button", { name: "Remove tyre" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  // CR-012 reads the distance out of the two odometers, and app.fitment's
  // odometer_does_not_decrease refuses the pair as a 23514 the API can only
  // report generically.
  it("refuses a removal odometer below the fitted one, naming the reading to beat", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderPanel(
      unitPosition({
        id: "p2",
        code: "POS2",
        fitment: openFitment({ fitmentId: "f4", fittedOdometer: 100000 }),
      }),
      { hasOdometer: true, removalReasons: ["Worn out"] },
    );

    await user.selectOptions(await screen.findByRole("combobox", { name: "Reason" }), "Worn out");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "4.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "99999");
    await user.click(screen.getByRole("button", { name: "Remove tyre" }));

    expect((await screen.findByRole("alert")).textContent).toContain("100000");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // NFR-USE-012: a controller looks for TY2 where TY2 belongs, and the read
  // arrives in received-date order.
  it("offers the stock in natural code order, not the order the register returned", async () => {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        respond(200, {
          tyres: [
            { ...STOCK[0], id: "a", displayCode: "TY10" },
            { ...STOCK[0], id: "b", displayCode: "TY2" },
          ],
        }),
      ),
    );
    renderPanel(unitPosition({ id: "p1" }));

    const picker = await screen.findByRole("combobox", { name: "Tyre" });
    await within(picker).findByRole("option", { name: "TY2" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose…", "TY2", "TY10"]);
  });

  it("says the stock read is loading, and offers a retry when it failed", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined));
    const { unmount } = renderPanel(unitPosition({ id: "p1" }));
    const picker = await screen.findByRole("combobox", { name: "Tyre" });
    expect(within(picker).getByRole("option", { name: "Loading…" }).hasAttribute("disabled")).toBe(
      true,
    );
    unmount();

    vi.mocked(fetch).mockResolvedValue(respond(500, { code: "internal", message: "boom" }));
    renderPanel(unitPosition({ id: "p1" }));
    expect(await screen.findByRole("heading", { name: "Tyres didn't load" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  // A rotation elsewhere on the unit puts a different tyre here. The panel
  // reads the same position it always did, so only the fitment id says the
  // confirmation is about a vehicle that has since changed (NFR-USE-010).
  it("drops the fit's confirmation once another fitment holds the position", async () => {
    stubFetch({ fitmentId: "f9", warnings: [] });
    const user = userEvent.setup();
    const client = testQueryClient();
    const empty = unitPosition({ id: "p1", code: "POS1" });
    const u = unit({ hasOdometer: false, positions: [empty] });
    const tree = (position: UnitPosition) => (
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <PositionPanel unit={u} position={position} />
        </QueryClientProvider>
      </ActorContext.Provider>
    );
    const { rerender } = render(tree(empty));

    await screen.findByRole("option", { name: "TY007" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Tyre" }), "t7");
    await user.type(screen.getByRole("textbox", { name: "Tread (mm)" }), "15.5");
    await user.click(screen.getByRole("button", { name: "Fit tyre" }));
    await screen.findByText("TY007 was fitted to POS1.");

    rerender(
      tree(
        unitPosition({
          id: "p1",
          code: "POS1",
          fitment: openFitment({ fitmentId: "f11", displayCode: "TY050" }),
        }),
      ),
    );

    expect(screen.queryByText("TY007 was fitted to POS1.")).toBeNull();
  });

  // NFR-USE-009 and the gloves: a field named only by an aria-label is a box
  // with nothing beside it for anyone who can see the screen.
  it("names every field on screen, not only to a screen reader", async () => {
    stubFetch();
    // Both forms: they are separate JSX, and an empty position renders none of
    // the removal's three fields, so a fit-only sweep passes while the remove
    // form names nothing on screen.
    const { unmount } = renderPanel(unitPosition({ id: "p1" }), { hasOdometer: true });
    await screen.findByRole("combobox", { name: "Tyre" });
    // Reached through each control's own id: a label that names nothing is
    // not a label, and the accessible name has to survive the change.
    for (const [role, name] of [
      ["combobox", "Tyre"],
      ["textbox", "Tread (mm)"],
      ["textbox", "Odometer"],
    ]) {
      const field = screen.getByRole(role, { name });
      expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(name);
    }
    unmount();

    renderPanel(unitPosition({ id: "p2", code: "POS2", fitment: openFitment() }), {
      hasOdometer: true,
      removalReasons: ["Worn out"],
    });
    await screen.findByRole("combobox", { name: "Reason" });
    for (const [role, name] of [
      ["combobox", "Reason"],
      ["textbox", "Tread (mm)"],
      ["textbox", "Odometer"],
    ]) {
      const field = screen.getByRole(role, { name });
      expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(name);
    }
  });

  it("shows the occupant but no write form to a reader who cannot manage assets", async () => {
    stubFetch();
    renderPanel(
      unitPosition({ id: "p2", code: "POS2", fitment: openFitment({ displayCode: "TY100" }) }),
      {},
      ["ViewFleet"],
    );

    expect(await screen.findByText("TY100")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Reason" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove tyre" })).toBeNull();
  });
});
