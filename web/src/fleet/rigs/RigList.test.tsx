import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RigList } from "./RigList";
import { ActorContext } from "../../auth/actorContext";
import type { Rig } from "../../api/combinations";
import { me, respond, testQueryClient } from "../../test/fixtures";

function rig(overrides: Partial<Rig> & { id: string }): Rig {
  return {
    motiveVehicleId: "u1",
    motiveFleetNumber: "HORSE-1",
    effectiveFrom: "2026-08-01T22:30:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u1", fleetNumber: "HORSE-1", sequence: 1, descriptor: null, unitKind: "HORSE" },
      {
        vehicleId: "u2",
        fleetNumber: "LINK-A",
        sequence: 2,
        descriptor: "front",
        unitKind: "TRAILER",
      },
      {
        vehicleId: "u3",
        fleetNumber: "LINK-B",
        sequence: 3,
        descriptor: null,
        unitKind: "TRAILER",
      },
    ],
    ...overrides,
  };
}

function renderList(capabilities: string[] = ["ViewFleet"]) {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter>
          <RigList />
        </MemoryRouter>
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("the rigs list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // D5/task brief: the motive is a link to its unit, and the composition
  // renders in walk order with each descriptor in parentheses. The pinned
  // text ("HORSE-1 › LINK-A (front) › LINK-B") is what the e2e also asserts
  // on, so the render must produce it byte for byte, wrapper spans aside.
  it("links the motive to its unit and reads the composition in walk order", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [rig({ id: "r1" })]));
    renderList();

    const link = await screen.findByRole("link", { name: "HORSE-1" });
    expect(link).toHaveAttribute("href", "/fleet/units/u1");

    const row = link.closest("tr");
    if (!row) throw new Error("row not found");
    expect(row).toHaveTextContent("HORSE-1 › LINK-A (front) › LINK-B");
  });

  // rule 6: an instant renders in the tenant's own zone, not the browser's —
  // 22:30Z is 00:30 the next day in Africa/Johannesburg (me()'s own zone).
  it("renders Since through the tenant zone", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [rig({ id: "r1" })]));
    renderList();

    const row = (await screen.findByRole("link", { name: "HORSE-1" })).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("02 Aug 2026")).toBeInTheDocument();
  });

  it("lists an ended rig under Ended rigs, with Since and Until", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [
        rig({
          id: "r1",
          motiveFleetNumber: "HORSE-2",
          effectiveFrom: "2026-07-01T06:00:00Z",
          effectiveTo: "2026-07-20T06:00:00Z",
        }),
      ]),
    );
    renderList();

    expect(await screen.findByRole("heading", { name: "Ended rigs" })).toBeInTheDocument();
    const link = await screen.findByRole("link", { name: "HORSE-2" });
    const row = link.closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("01 Jul 2026")).toBeInTheDocument();
    expect(within(row).getByText("20 Jul 2026")).toBeInTheDocument();
  });

  it("hides End rig for ViewFleet alone", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [rig({ id: "r1" })]));
    renderList(["ViewFleet"]);
    await screen.findByRole("link", { name: "HORSE-1" });
    expect(screen.queryByRole("button", { name: "End rig" })).not.toBeInTheDocument();
  });

  it("shows End rig for ManageAssignments, ends the rig, and moves the row to Ended", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [rig({ id: "r1" })]));
    renderList(["ViewFleet", "ManageAssignments"]);
    await screen.findByRole("link", { name: "HORSE-1" });

    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, rig({ id: "r1", effectiveTo: "2026-09-03T06:00:00Z" })))
      .mockResolvedValueOnce(
        respond(200, [rig({ id: "r1", effectiveTo: "2026-09-03T06:00:00Z" })]),
      );

    await userEvent.click(screen.getByRole("button", { name: "End rig" }));

    expect(fetch).toHaveBeenCalledWith(
      "/api/combinations/r1/end",
      expect.objectContaining({ method: "POST" }),
    );
    await screen.findByRole("heading", { name: "Ended rigs" });
    // en-ZA's short month for September is "Sept", not "Sep" (Aug/Jul stay
    // three letters elsewhere in this file, which is why only this one
    // assertion needs the longer form).
    expect(await screen.findByText(/03 Sept 2026/)).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Rig ended for HORSE-1.");
  });

  it("speaks a TY017 refusal in role=alert", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [rig({ id: "r1" })]));
    renderList(["ViewFleet", "ManageAssignments"]);
    await screen.findByRole("link", { name: "HORSE-1" });

    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, { code: "TY017", message: "this rig ended on 20 Jul 2026" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "End rig" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("this rig ended on 20 Jul 2026");
  });

  it("shows the empty states when there are no rigs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderList();

    expect(
      await screen.findByText(/no open rigs\. a unit not in a rig is inspected on its own\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no ended rigs yet\./i)).toBeInTheDocument();
  });
});
