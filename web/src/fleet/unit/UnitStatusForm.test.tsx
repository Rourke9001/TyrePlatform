import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitStatusForm } from "./UnitStatusForm";
import { ActorContext } from "../../auth/actorContext";
import type { Unit } from "../../api/units";
import { me, requestedUrl, respond, sentBody, testQueryClient, unit } from "../../test/fixtures";

const TY016_MESSAGE = "Unit HORSE-1 still carries 6 fitted tyres and cannot be disposed of.";

function renderForm(overrides: Partial<Unit> = {}) {
  const u = unit({ id: "u9", ...overrides });
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <UnitStatusForm unit={u} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("setting a unit's status", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A control named only by an aria-label is a box with nothing beside it for
  // anyone reading the screen rather than hearing it (NFR-USE-009).
  it("names both fields on screen, not only to a screen reader", async () => {
    const user = userEvent.setup();
    renderForm();

    // By the control's own id rather than by text: the section's heading is
    // the word "Status" too, and a text match would pass on that alone.
    const status = screen.getByRole("combobox", { name: "Status" });
    expect(document.querySelector(`label[for="${status.id}"]`)?.textContent).toBe("Status");

    await user.selectOptions(status, "DISPOSED");
    const reason = screen.getByRole("textbox", { name: "Reason" });
    expect(document.querySelector(`label[for="${reason.id}"]`)?.textContent).toBe("Reason");
  });

  it("offers the six statuses a unit can hold", () => {
    renderForm();
    const picker = screen.getByRole("combobox", { name: "Status" });
    for (const label of [
      "Active",
      "Workshop",
      "Inactive",
      "Disposed",
      "Parked",
      "Out of service",
    ]) {
      expect(within(picker).getByRole("option", { name: label })).toBeTruthy();
    }
  });

  // FR-VEH-006: a disposal states why. No other transition does, so no other
  // transition asks.
  it("asks for a reason on a disposal and on nothing else", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "WORKSHOP");
    expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "DISPOSED");
    expect(screen.getByRole("textbox", { name: "Reason" })).toBeTruthy();
  });

  it("sends the status and its reason", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "DISPOSED");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Sold at auction");
    await user.click(screen.getByRole("button", { name: "Set status" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    });
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/status");
    expect(sentBody(0)).toEqual({ status: "DISPOSED", reason: "Sold at auction" });
    expect(await screen.findByText("The status was changed.")).toBeTruthy();
  });

  // Both halves of the reason rule: DISPOSED carries one, and no other
  // transition sends the key at all.
  it("sends no reason at all for a transition that is not a disposal", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "WORKSHOP");
    await user.click(screen.getByRole("button", { name: "Set status" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    });
    expect(sentBody(0)).toEqual({ status: "WORKSHOP" });
    expect(await screen.findByText("The status was changed.")).toBeTruthy();
  });

  // TY016 names the unit and counts its open fitments. A generic sentence
  // would drop both, leaving an operator with nothing to act on
  // (NFR-USE-005).
  it("shows the open-fitment refusal in the server's own words", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(422, { code: "TY016", message: TY016_MESSAGE }));
    const user = userEvent.setup();
    renderForm();

    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "DISPOSED");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Sold at auction");
    await user.click(screen.getByRole("button", { name: "Set status" }));

    expect((await screen.findByRole("alert")).textContent).toBe(TY016_MESSAGE);
  });
});
