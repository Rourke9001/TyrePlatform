import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
  });

  // units.go:513-520: "" on a text column is read as absence, so a blanked
  // field cannot be sent — the save would claim an edit the server declined
  // to make.
  it("omits a text field the user blanked rather than sending an empty string", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.clear(await screen.findByRole("textbox", { name: "Description" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(screen.getByRole("alert").textContent).toContain("left unchanged");
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

  it("says so rather than sending an empty edit when nothing changed", async () => {
    const user = userEvent.setup();
    renderForm();
    await screen.findByRole("textbox", { name: "Fleet number" });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    expect(screen.getByRole("alert").textContent).toContain("Nothing has changed");
  });
});
