import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RotateForm } from "./RotateForm";
import { openFitmentsKey } from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Unit } from "../../api/units";
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

function threePositions(): Unit["positions"] {
  return [
    unitPosition({
      id: "p1",
      code: "POS1",
      fitment: openFitment({ fitmentId: "f1", tyreId: "t1", displayCode: "TY001" }),
    }),
    unitPosition({
      id: "p2",
      code: "POS2",
      side: "RIGHT",
      fitment: openFitment({ fitmentId: "f2", tyreId: "t2", displayCode: "TY002" }),
    }),
    unitPosition({ id: "p3", code: "POS3", axleNumber: 2, fitment: null }),
  ];
}

function renderForm(overrides: Partial<Unit> = {}) {
  const u = unit({ id: "u9", positions: threePositions(), ...overrides });
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <RotateForm unit={u} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("rotating tyres within a unit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers only the occupied positions — an empty one has nothing to move", () => {
    renderForm();
    expect(screen.getByRole("checkbox", { name: "Rotate POS1" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Rotate POS3" })).toBeNull();
  });

  it("sends one move per checked position, each with its target and tread", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, { moves: [] }));
    const user = userEvent.setup();
    renderForm({ hasOdometer: true });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "220000");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBe(1);
    });
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/rotations");
    expect(sentBody(0)).toEqual({
      moves: [
        { tyreId: "t1", toPositionId: "p2", treadMm: "11.0" },
        { tyreId: "t2", toPositionId: "p1", treadMm: "12.5" },
      ],
      odometer: 220000,
    });
    expect(await screen.findByText("The rotation was applied.")).toBeTruthy();
  });

  // useFormMutation keeps isSuccess, so without gating the confirmation the
  // next refused attempt would read "The rotation was applied" beside "Pick at
  // least two positions".
  it("drops the standing confirmation when the next attempt is refused", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, { moves: [] }));
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await screen.findByText("The rotation was applied.");

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(screen.getByRole("alert").textContent).toContain("two positions");
    expect(screen.queryByText("The rotation was applied.")).toBeNull();
  });

  // CLAUDE.md rule 3 / CR-012: a truncated reading lands on an immutable
  // event, so the form refuses rather than parses what it can.
  it.each(["125 000", "125.7"])(
    "refuses the odometer %s rather than sending a truncated reading",
    async (typed) => {
      const user = userEvent.setup();
      renderForm({ hasOdometer: true });

      await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
      await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
      await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
      await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
      await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
      await user.type(screen.getByRole("textbox", { name: "Odometer" }), typed);
      await user.click(screen.getByRole("button", { name: "Rotate" }));

      expect(screen.getByRole("alert").textContent).toContain("digits only");
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  // D7: a rotation is two or more positions swapping. One checked position
  // is a removal and a fit, which this form is not.
  it("refuses to send a rotation of one position", async () => {
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p3");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("two positions");
  });

  // A rotation moves tyres between positions of one unit, which changes what
  // the fleet-wide fitments list holds for both of them. No screen here reads
  // that list, so its key is stale only if this write says so.
  it("invalidates the fleet-wide fitments list its moves make stale", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, { moves: [] }));
    const user = userEvent.setup();
    const client = testQueryClient();
    const key = openFitmentsKey(getDevTenantId() ?? "default");
    // Seeded first: invalidateQueries on a key with no cache entry is
    // silently a no-op (PositionPanel.test.tsx holds the same note).
    client.setQueryData(key, []);

    render(
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <RotateForm unit={unit({ id: "u9", hasOdometer: false, positions: threePositions() })} />
        </QueryClientProvider>
      </ActorContext.Provider>,
    );

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await waitFor(() => {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    });
  });

  // Every move closes a fitment row, and 000025's trigger refuses a closure
  // on a unit that has an odometer without the reading (FR-FIT-002). A rotation
  // sent from a stale unit read gets that refusal, and a general sentence
  // would leave the controller retrying the same thing (ADR-0012).
  it("speaks TY009 rather than the general sentence", async () => {
    const message = "fitment odometer is required for a unit that has one";
    vi.mocked(fetch).mockResolvedValue(respond(422, { code: "TY009", message }));
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("never asks a trailer for an odometer and asks a horse for one", () => {
    const { unmount } = renderForm({ hasOdometer: true });
    // Required, not optional: without it the write is refused as TY009.
    expect(screen.getByRole("textbox", { name: "Odometer" }).hasAttribute("required")).toBe(true);
    unmount();

    renderForm({ hasOdometer: false, unitKind: "TRAILER" });
    expect(screen.queryByRole("textbox", { name: "Odometer" })).toBeNull();
  });
});
