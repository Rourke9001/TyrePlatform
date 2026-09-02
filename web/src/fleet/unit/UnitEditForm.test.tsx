import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitEditForm } from "./UnitEditForm";
import { ActorContext } from "../../auth/actorContext";
import type { Unit } from "../../api/units";
import { me, requestedUrl, respond, sentBody, testQueryClient, unit } from "../../test/fixtures";

const DEPOTS = [
  { id: "d1", name: "Alrode", type: "WORKSHOP" },
  { id: "d2", name: "Isando", type: "WORKSHOP" },
];

function stubFetch() {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url.startsWith("/api/depots")) return Promise.resolve(respond(200, DEPOTS));
    return Promise.resolve(respond(200, unit()));
  });
}

function renderForm(overrides: Partial<Unit> = {}) {
  const u = unit({
    id: "u9",
    fleetNumber: "HORSE-1",
    registration: "SBX001GP",
    description: "Long haul",
    homeDepotId: "d1",
    ...overrides,
  });
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <UnitEditForm unit={u} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("editing a unit's description", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // TYRE-94: the axle layout has no PATCH path at all. It is shown so a
  // reader knows what the unit is, never as a control.
  it("shows the axle layout as text and never as a field", async () => {
    renderForm({ configurationName: "6x4 horse" });
    await screen.findByRole("textbox", { name: "Fleet number" });

    expect(screen.getByText("6x4 horse")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /axle layout/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /axle layout/i })).toBeNull();
  });

  it("explains the axle layout is fixed once the unit has history, and not before", async () => {
    const { unmount } = renderForm({ hasHistory: true });
    expect(await screen.findByText("Read-only: this unit has history")).toBeTruthy();
    unmount();

    renderForm({ hasHistory: false });
    await screen.findByRole("textbox", { name: "Fleet number" });
    expect(screen.queryByText("Read-only: this unit has history")).toBeNull();
  });

  it("sends only the field that changed", async () => {
    const user = userEvent.setup();
    renderForm();
    const registration = await screen.findByRole("textbox", { name: "Registration" });

    await user.clear(registration);
    await user.type(registration, "SBX999GP");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    });
    expect(sentBody(1)).toEqual({ registration: "SBX999GP" });
    expect(await screen.findByText("The unit was saved.")).toBeTruthy();
  });

  // The ruling's case: a blank is not a change, but it does not swallow the
  // change made beside it.
  it("sends the field that changed and omits the one that was blanked", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.clear(await screen.findByRole("textbox", { name: "Description" }));
    const registration = screen.getByRole("textbox", { name: "Registration" });
    await user.clear(registration);
    await user.type(registration, "SBX999GP");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    });
    expect(sentBody(1)).toEqual({ registration: "SBX999GP" });
  });

  // useFormMutation keeps isSuccess, so a later click that sends nothing must
  // not leave "The unit was saved" standing beside "Nothing has changed".
  it("drops the standing confirmation when the next save sends nothing", async () => {
    const user = userEvent.setup();
    renderForm();
    const registration = await screen.findByRole("textbox", { name: "Registration" });

    await user.clear(registration);
    await user.type(registration, "SBX999GP");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("The unit was saved.");

    // Nothing touched since, so the second click has nothing to send: what
    // the fields hold is what the save just put on the server.
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("alert").textContent).toContain("Nothing has changed");
    expect(screen.queryByText("The unit was saved.")).toBeNull();
  });

  // The saved value is what the next edit is measured against. Diffed against
  // the mount value for ever, a field could be edited once per sitting and no
  // more: typing back what was there a minute ago would read as no change
  // while the server holds something else.
  it("sends a field edited back to what it held before the last save", async () => {
    const user = userEvent.setup();
    renderForm();
    const description = await screen.findByRole("textbox", { name: "Description" });

    await user.clear(description);
    await user.type(description, "Short haul");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("The unit was saved.");

    await user.clear(description);
    await user.type(description, "Long haul");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(3);
    });
    expect(sentBody(2)).toEqual({ description: "Long haul" });
  });

  // A blank on a text column is read as absence, not as a clear (see
  // patchUnit's comment in api/units.ts), so a blanked field cannot be sent —
  // the save would claim an edit the server declined to make.
  it("omits a text field the user blanked rather than sending an empty string", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.clear(await screen.findByRole("textbox", { name: "Description" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    // Advisory, not a refusal: it explains a save that may well have happened
    // (here it did not, and the alert beside it says so).
    expect(screen.getByRole("status").textContent).toContain("left unchanged");
    expect(screen.getByRole("alert").textContent).toContain("Nothing has changed");
  });

  it("sends an empty string to clear the home depot, which is how the API clears an id", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Home depot" }), "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    });
    expect(sentBody(1)).toEqual({ homeDepotId: "" });
  });

  it("splits tags on commas and sends the whole replacement list", async () => {
    const user = userEvent.setup();
    renderForm({ tags: ["Reefer"] });
    const tags = await screen.findByRole("textbox", { name: "Tags" });

    await user.clear(tags);
    await user.type(tags, "Reefer, Long haul ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    });
    expect(sentBody(1)).toEqual({ tags: ["Reefer", "Long haul"] });
  });

  // The unit read refetches under this form — on a window focus, or on any
  // write's invalidation — and the fields keep what they were seeded with. A
  // diff against the newer prop would send every untouched field back to the
  // value it held at mount, silently reverting whoever made the change.
  it("never sends a field it was not edited in, even after the read moved on", async () => {
    const user = userEvent.setup();
    const client = testQueryClient();
    const tree = (u: Unit) => (
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <UnitEditForm unit={u} />
        </QueryClientProvider>
      </ActorContext.Provider>
    );
    const loaded = unit({ id: "u9", registration: "SBX001GP", description: "Long haul" });
    const { rerender } = render(tree(loaded));
    await screen.findByRole("textbox", { name: "Fleet number" });

    rerender(tree({ ...loaded, registration: "SBX999GP" }));

    const description = screen.getByRole("textbox", { name: "Description" });
    await user.clear(description);
    await user.type(description, "Short haul");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    });
    expect(sentBody(1)).toEqual({ description: "Short haul" });
  });

  it("says the depot list is loading, and offers a retry when it failed", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => undefined));
    const { unmount } = renderForm();
    const picker = await screen.findByRole("combobox", { name: "Home depot" });
    // None stays selectable while the list loads: "" is how the API clears
    // the id, not a placeholder.
    expect(within(picker).getByRole("option", { name: "None" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(within(picker).getByRole("option", { name: "Loading…" }).hasAttribute("disabled")).toBe(
      true,
    );
    unmount();

    vi.mocked(fetch).mockResolvedValue(respond(500, { code: "internal", message: "boom" }));
    renderForm();
    expect(await screen.findByRole("heading", { name: "Depots didn't load" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("says so rather than sending an empty edit when nothing changed", async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findByRole("textbox", { name: "Fleet number" });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(screen.getByRole("alert").textContent).toContain("Nothing has changed");
  });
});
