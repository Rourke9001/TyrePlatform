import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { VehicleList } from "./VehicleList";
import { ActorContext } from "../auth/actorContext";
import { me, respond, testQueryClient } from "../test/fixtures";

function renderList(capabilities: string[] = ["ViewFleet", "ManageAssets"]) {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter>
          <VehicleList />
        </MemoryRouter>
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("the unit list", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // D7: the list is the way into a unit. A row that is not a link leaves the
  // unit screen reachable by typed URL alone.
  it("makes every row a link to that unit", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(200, [
        { id: "u9", fleetNumber: "HORSE-1", registration: "SBX001GP" },
        { id: "u10", fleetNumber: "HORSE-2", registration: null },
      ]),
    );
    renderList();

    const row = await screen.findByRole("link", { name: /HORSE-1/ });
    expect(row.getAttribute("href")).toBe("/fleet/units/u9");
    expect(screen.getByRole("link", { name: /HORSE-2/ }).getAttribute("href")).toBe(
      "/fleet/units/u10",
    );
  });

  it("points an empty fleet at the screen that adds a unit", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, []));
    renderList();

    expect(await screen.findByRole("heading", { name: "No units yet" })).toBeTruthy();
    expect(screen.getByText(/Add one from/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Add a unit" }).getAttribute("href")).toBe(
      "/admin/units/new",
    );
    expect(screen.queryByText(/upcoming release/)).toBeNull();
  });

  // The screen behind that link is AdminRoute'd on ManageAssets, so offering
  // it to a reader who does not hold the capability is an invitation to a
  // refusal (ADR-0013 decision 4). The empty state itself still shows: what
  // the fleet holds is ViewFleet's to see.
  it("offers the link only to a reader who can add a unit", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, []));
    renderList(["ViewFleet"]);

    expect(await screen.findByRole("heading", { name: "No units yet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add a unit" })).toBeNull();
  });
});
