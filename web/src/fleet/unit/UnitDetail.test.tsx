import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitDetail } from "./UnitDetail";
import { rigsKey } from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Rig } from "../../api/combinations";
import {
  fitmentRow,
  me,
  openFitment,
  requestedUrl,
  respond,
  testQueryClient,
  unit,
  unitPosition,
} from "../../test/fixtures";

const TENANT = getDevTenantId() ?? "default";

const UNIT = unit({
  id: "u9",
  fleetNumber: "HORSE-1",
  positions: [
    unitPosition({ id: "p1", code: "POS1" }),
    unitPosition({
      id: "p2",
      code: "POS2",
      side: "RIGHT",
      fitment: openFitment({ displayCode: "TY100" }),
    }),
  ],
});

// The rig this unit sits in, in the server's own member order: the motive is
// always sequence 1 with a null descriptor (U7).
function rig(overrides: Partial<Rig> = {}): Rig {
  return {
    id: "r1",
    motiveVehicleId: "u9",
    motiveFleetNumber: "HORSE-1",
    effectiveFrom: "2026-08-01T06:00:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u9", fleetNumber: "HORSE-1", sequence: 1, descriptor: null, unitKind: "HORSE" },
      {
        vehicleId: "u5",
        fleetNumber: "LINK-5",
        sequence: 2,
        descriptor: null,
        unitKind: "TRAILER",
      },
    ],
    ...overrides,
  };
}

function stubFetch(rigs: Rig[] = []) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/vehicles/u9") return Promise.resolve(respond(200, UNIT));
    if (url === "/api/combinations") return Promise.resolve(respond(200, rigs));
    if (url === "/api/vehicles/u9/fitments")
      return Promise.resolve(respond(200, [fitmentRow({ fitmentId: "f1", displayCode: "TY100" })]));
    if (url === "/api/vehicles/u9/drivers") return Promise.resolve(respond(200, []));
    if (url === "/api/vehicles/u9/inspection-tasks") return Promise.resolve(respond(200, []));
    if (url.startsWith("/api/tyres")) return Promise.resolve(respond(200, { tyres: [] }));
    if (url.startsWith("/api/depots")) return Promise.resolve(respond(200, []));
    throw new Error(`unstubbed ${url}`);
  });
}

function renderScreen(
  capabilities: string[] = ["ViewFleet", "ManageAssets"],
  client: QueryClient = testQueryClient(),
) {
  return {
    client,
    ...render(
      <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
        <QueryClientProvider client={client}>
          {/* UnitDetail links to the Rigs screen, and react-router refuses a
              Link outside a router. */}
          <MemoryRouter>
            <UnitDetail unitId="u9" />
          </MemoryRouter>
        </QueryClientProvider>
      </ActorContext.Provider>,
    ),
  };
}

// "No rig line" is trivially true while the rig read is still in flight, so
// the absence half below waits for the answer to have landed first
// (RotateForm.test.tsx's own guard against the same vacuous assertion).
async function rigsSettled(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(rigsKey(TENANT))?.status).toBe("success");
  });
}

describe("the unit screen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the unit and draws its plan", async () => {
    renderScreen();
    expect(await screen.findByRole("heading", { name: "HORSE-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Position POS2: TY100" })).toBeTruthy();
  });

  it("opens the picked position's panel", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Position POS2: TY100" }));

    expect(await screen.findByRole("combobox", { name: "Reason" })).toBeTruthy();
  });

  // ViewFleet is the read (D7). Every write on this screen needs a further
  // capability — ManageAssets for rotate/edit/status, ManageAssignments for
  // the schedule form (spec U2) — so a reader is shown the unit rather than
  // a row of controls that would refuse them.
  it("shows a reader the plan and the history and none of the writes", async () => {
    renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Position POS1: empty" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set status" })).toBeNull();
  });

  it("gives a controller the rotate, edit and status forms", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set status" })).toBeTruthy();
  });

  it("says the unit did not load rather than rendering an empty screen", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(500, {}));
    renderScreen();
    expect((await screen.findByRole("alert")).textContent).toContain("Unit didn't load");
  });

  // The list is every ViewFleet reader's (spec U2), so it renders whether or
  // not the schedule form does.
  it("shows a reader Open inspections but not the schedule form", async () => {
    renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("heading", { name: "Open inspections" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Schedule an inspection" })).toBeNull();
  });

  // The capability split is real (spec U2): ManageAssets, which gates the
  // other forms on this screen, does not also gate the schedule form.
  it("keeps the schedule form hidden for ManageAssets alone", async () => {
    renderScreen(["ViewFleet", "ManageAssets"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.queryByRole("heading", { name: "Schedule an inspection" })).toBeNull();
  });

  it("gives ManageAssignments the schedule form", async () => {
    renderScreen(["ViewFleet", "ManageAssignments"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("heading", { name: "Schedule an inspection" })).toBeTruthy();
  });

  // UnitDetail's own reason for the line; both halves asserted so an ended
  // rig cannot read as a live coupling.
  it("names the open rig's other units and says nothing about one already ended", async () => {
    stubFetch([rig()]);
    const { unmount } = renderScreen(["ViewFleet"]);

    const link = await screen.findByRole("link", { name: "LINK-5" });
    expect(link.getAttribute("href")).toBe("/fleet/rigs");
    expect(screen.getByText(/^In a rig with/).textContent).toBe("In a rig with LINK-5");
    unmount();

    stubFetch([rig({ effectiveTo: "2026-08-20T06:00:00Z" })]);
    const ended = renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });
    await rigsSettled(ended.client);

    expect(screen.queryByText(/^In a rig with/)).toBeNull();
  });
});
