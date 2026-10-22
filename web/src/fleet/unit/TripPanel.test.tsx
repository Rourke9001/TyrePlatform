import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { TripPanel } from "./TripPanel";
import {
  driversKey,
  rigsKey,
  tripBlockersPrefix,
  unitTasksPrefix,
  unitTripsPrefix,
} from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Rig } from "../../api/combinations";
import type { Driver, Trip, TripBlocker, UnitTrip } from "../../api/trips";
import type { Vehicle } from "../../api/vehicles";
import { me, requestedUrl, respond, sentBody, testQueryClient, unit } from "../../test/fixtures";

const TENANT = getDevTenantId() ?? "default";
const HORSE = unit({ id: "u9", fleetNumber: "HORSE-1", unitKind: "HORSE" });
const TRAILER = unit({ id: "u5", fleetNumber: "LINK-5", unitKind: "TRAILER" });

const TRIP: Trip = {
  id: "tr1",
  motive: { vehicleId: "u9", fleetNumber: "HORSE-1" },
  driver: { userId: "d1", displayName: "Melusi" },
  startedAt: "2026-09-01T06:00:00Z",
  startedBy: { userId: "c1", displayName: "Nomsa" },
  endedAt: null,
  trailers: [
    { vehicleId: "u5", fleetNumber: "LINK-5" },
    { vehicleId: "u6", fleetNumber: "LINK-6" },
  ],
};

const DRIVERS: Driver[] = [
  { userId: "d1", displayName: "Melusi", staffNumber: null, onTrip: null },
  {
    userId: "d2",
    displayName: "Sipho",
    staffNumber: null,
    onTrip: { vehicleId: "u8", fleetNumber: "HORSE-8" },
  },
];

const VEHICLES: Vehicle[] = [
  { id: "u9", fleetNumber: "HORSE-1", registration: null, unitKind: "HORSE", status: "ACTIVE" },
  { id: "u5", fleetNumber: "LINK-5", registration: null, unitKind: "TRAILER", status: "ACTIVE" },
  { id: "u6", fleetNumber: "LINK-6", registration: null, unitKind: "TRAILER", status: "ACTIVE" },
  { id: "u7", fleetNumber: "LINK-7", registration: null, unitKind: "TRAILER", status: "ACTIVE" },
  { id: "u3", fleetNumber: "LINK-3", registration: null, unitKind: "TRAILER", status: "DISPOSED" },
  { id: "u2", fleetNumber: "LINK-2", registration: null, unitKind: "TRAILER", status: "ACTIVE" },
];

// HORSE-1 tows LINK-5; HORSE-8 tows LINK-2. LINK-6 and LINK-7 are free and
// LINK-3 is retired.
const RIGS: Rig[] = [
  {
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
  },
  {
    id: "r8",
    motiveVehicleId: "u8",
    motiveFleetNumber: "HORSE-8",
    effectiveFrom: "2026-08-01T06:00:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u8", fleetNumber: "HORSE-8", sequence: 1, descriptor: null, unitKind: "HORSE" },
      {
        vehicleId: "u2",
        fleetNumber: "LINK-2",
        sequence: 2,
        descriptor: null,
        unitKind: "TRAILER",
      },
    ],
  },
];

interface Stub {
  trip: () => UnitTrip;
  blockers?: (url: string) => Response;
  start?: () => Response;
  end?: () => Response;
  nominate?: () => Response;
}

function stub(s: Stub) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    const post = init?.method === "POST";
    if (url === "/api/vehicles/u9/trip" || url === "/api/vehicles/u5/trip")
      return Promise.resolve(respond(200, s.trip()));
    if (url === "/api/drivers") return Promise.resolve(respond(200, DRIVERS));
    if (url === "/api/vehicles") return Promise.resolve(respond(200, VEHICLES));
    if (url === "/api/combinations") return Promise.resolve(respond(200, RIGS));
    if (url.startsWith("/api/vehicles/u9/trip-blockers"))
      return Promise.resolve(s.blockers ? s.blockers(url) : respond(200, []));
    if (url === "/api/trips" && post && s.start) return Promise.resolve(s.start());
    if (url === "/api/trips/tr1/end" && post && s.end) return Promise.resolve(s.end());
    if (url.startsWith("/api/inspection-tasks/") && post && s.nominate)
      return Promise.resolve(s.nominate());
    throw new Error(`unstubbed ${url}`);
  });
}

function renderPanel(
  capabilities: string[] = ["ViewFleet", "ManageAssignments"],
  forUnit = HORSE,
  client: QueryClient = testQueryClient(),
) {
  render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={client}>
        <TripPanel unit={forUnit} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
  return client;
}

function callTo(path: string, method = "POST"): number {
  return vi
    .mocked(fetch)
    .mock.calls.findIndex((c) => requestedUrl(c[0]) === path && (c[1]?.method ?? "GET") === method);
}

function expectInvalidated(calls: readonly (readonly unknown[])[]) {
  const keys = calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  for (const key of [
    unitTripsPrefix(),
    unitTasksPrefix(),
    rigsKey(TENANT),
    driversKey(TENANT),
    tripBlockersPrefix(),
  ]) {
    expect(keys).toContain(JSON.stringify(key));
  }
}

describe("the trip panel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names a motive's trip, its driver, its start and what it tows, and ends it", async () => {
    let ended = false;
    stub({
      trip: () => (ended ? { trip: null, pulledBy: null } : { trip: TRIP, pulledBy: null }),
      end: () => {
        ended = true;
        return respond(200, { ...TRIP, endedAt: "2026-09-02T06:00:00Z" });
      },
    });
    const client = renderPanel();
    const spy = vi.spyOn(client, "invalidateQueries");

    expect(await screen.findByRole("heading", { name: "Trip" })).toBeInTheDocument();
    expect(await screen.findByText("Driver: Melusi")).toBeInTheDocument();
    expect(screen.getByText(/^Started 01 Sept? 2026 08:00 by Nomsa$/)).toBeInTheDocument();
    expect(screen.getByText("Towing LINK-5, LINK-6")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "End trip" }));
    expect(await screen.findByText("Not on a trip.")).toBeInTheDocument();
    expect(callTo("/api/trips/tr1/end")).toBeGreaterThanOrEqual(0);
    expectInvalidated(spy.mock.calls);
  });

  it("names no starter when none is recorded, says it tows nothing, and offers a reader no End trip", async () => {
    stub({ trip: () => ({ trip: { ...TRIP, startedBy: null, trailers: [] }, pulledBy: null }) });
    renderPanel(["ViewFleet"]);

    expect(await screen.findByText("Driver: Melusi")).toBeInTheDocument();
    expect(screen.getByText(/^Started 01 Sept? 2026 08:00$/)).toBeInTheDocument();
    expect(screen.getByText("Towing nothing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End trip" })).toBeNull();
  });

  it("shows a reader Not on a trip with no start form", async () => {
    stub({ trip: () => ({ trip: null, pulledBy: null }) });
    renderPanel(["ViewFleet"]);

    expect(await screen.findByText("Not on a trip.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
  });

  it("starts a trip with a driver and free trailers in the order added", async () => {
    stub({
      trip: () => ({ trip: null, pulledBy: null }),
      start: () => respond(201, TRIP),
    });
    const client = renderPanel();
    const spy = vi.spyOn(client, "invalidateQueries");

    expect(await screen.findByText("Not on a trip.")).toBeInTheDocument();
    expect(await screen.findByText("Coupled now: LINK-5")).toBeInTheDocument();
    const add = screen.getByLabelText("Add a trailer");
    await within(add).findByRole("option", { name: "LINK-7" });
    const offered = within(add)
      .getAllByRole("option")
      .map((o) => [o.textContent, (o as HTMLOptionElement).disabled]);
    // Free and active trailers are offered; one coupled elsewhere is shown
    // but not selectable, naming its truck; the motive's own and a retired
    // one are not offered (spec, decision 4).
    expect(offered).toEqual([
      ["Choose…", false],
      ["LINK-2, coupled to HORSE-8", true],
      ["LINK-6", false],
      ["LINK-7", false],
    ]);

    const start = screen.getByRole("button", { name: "Start trip" });
    expect(start).toBeDisabled();
    await within(screen.getByLabelText("Driver")).findByRole("option", {
      name: "Sipho, on the trip with HORSE-8",
    });
    await userEvent.selectOptions(screen.getByLabelText("Driver"), "d2");

    await userEvent.selectOptions(add, "u7");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.selectOptions(add, "u6");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const list = screen.getByRole("list", { name: "Trailers to add" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.firstChild?.textContent),
    ).toEqual(["LINK-7", "LINK-6"]);
    await userEvent.click(within(list).getAllByRole("button", { name: /remove/i })[0]);
    await userEvent.selectOptions(add, "u7");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Start trip" }));
    await waitFor(() => expect(callTo("/api/trips")).toBeGreaterThanOrEqual(0));
    expect(sentBody(callTo("/api/trips"))).toStrictEqual({
      motiveVehicleId: "u9",
      driverUserId: "d2",
      addTrailers: ["u6", "u7"],
    });
    await waitFor(() => expectInvalidated(spy.mock.calls));
  });

  // U148: the block is shown before Start, with the nominate action on the
  // task, and read again as trailers are added.
  it("names each due inspection that holds the start, disables Start, and offers its nomination", async () => {
    const BLOCK: TripBlocker = {
      taskId: "k1",
      vehicleId: "u7",
      fleetNumber: "LINK-7",
      dueAt: "2026-09-04T22:30:00Z",
    };
    stub({
      trip: () => ({ trip: null, pulledBy: null }),
      blockers: (url) => respond(200, url.includes("addTrailers=u7") ? [BLOCK] : []),
      nominate: () =>
        respond(201, {
          id: "k1",
          vehicleId: "u7",
          fleetNumber: "LINK-7",
          dueAt: BLOCK.dueAt,
          state: "OPEN",
          overdue: false,
          escalated: false,
          responsibleUserId: "d1",
          responsibleDisplayName: "Melusi",
          responsibleVia: "NOMINATION",
        }),
    });
    renderPanel();
    await screen.findByText("Not on a trip.");
    await within(screen.getByLabelText("Driver")).findByRole("option", { name: "Melusi" });
    await userEvent.selectOptions(screen.getByLabelText("Driver"), "d1");
    expect(screen.queryByText(/must be done before the trip starts/)).toBeNull();

    const add = screen.getByLabelText("Add a trailer");
    await within(add).findByRole("option", { name: "LINK-7" });
    await userEvent.selectOptions(add, "u7");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText("These inspections are due and must be done before the trip starts:"),
    ).toBeInTheDocument();
    const block = screen.getByRole("list", { name: "Due inspections" });
    expect(within(block).getByText("LINK-7, due 05 Sept 2026")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start trip" })).toBeDisabled();
    await within(block).findByRole("option", { name: "Sipho, on the trip with HORSE-8" });
    await userEvent.selectOptions(within(block).getByRole("combobox"), "d1");
    await userEvent.click(within(block).getByRole("button", { name: "Nominate" }));
    await waitFor(() =>
      expect(callTo("/api/inspection-tasks/k1/nominations")).toBeGreaterThanOrEqual(0),
    );
  });

  it("leaves Start enabled when the blocker read fails, since the server judges the start anyway", async () => {
    stub({
      trip: () => ({ trip: null, pulledBy: null }),
      blockers: () => respond(500, { code: "boom", message: "down" }),
    });
    renderPanel();
    await screen.findByText("Not on a trip.");
    await within(screen.getByLabelText("Driver")).findByRole("option", { name: "Melusi" });
    await userEvent.selectOptions(screen.getByLabelText("Driver"), "d1");

    expect(
      await screen.findByText("The due inspections could not be checked."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled();
  });

  it.each([
    [
      "TY028",
      "a trip cannot start before its due inspections are done: HORSE-1 due 2026-09-04",
      "a trip cannot start before its due inspections are done: HORSE-1 due 2026-09-04",
    ],
    [
      "invalid_submission",
      "driverUserId is on the trip with HORSE-8, outside your depots; end it there first",
      "driverUserId is on the trip with HORSE-8, outside your depots; end it there first",
    ],
    ["forbidden", "no", "You do not have permission to start or end a trip."],
    ["boom", "down", "The trip could not be changed. Retry."],
  ])("speaks a %s refusal of a start", async (code, message, shown) => {
    stub({
      trip: () => ({ trip: null, pulledBy: null }),
      start: () => respond(code === "forbidden" ? 403 : 422, { code, message }),
    });
    renderPanel();
    await screen.findByText("Not on a trip.");
    await within(screen.getByLabelText("Driver")).findByRole("option", { name: "Melusi" });
    await userEvent.selectOptions(screen.getByLabelText("Driver"), "d1");
    await waitFor(() => expect(screen.getByRole("button", { name: "Start trip" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Start trip" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
  });

  it("speaks a TY028 refusal of an end verbatim", async () => {
    stub({
      trip: () => ({ trip: TRIP, pulledBy: null }),
      end: () =>
        respond(422, {
          code: "TY028",
          message: "this trip has already ended; refresh to see who is on the truck now",
        }),
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "End trip" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "this trip has already ended; refresh to see who is on the truck now",
    );
  });

  it.each<[string, UnitTrip, string]>([
    [
      "on its motive's trip",
      { trip: TRIP, pulledBy: { vehicleId: "u9", fleetNumber: "HORSE-1" } },
      "Pulled by HORSE-1, on Melusi's trip.",
    ],
    [
      "pulled by a motive between trips",
      { trip: null, pulledBy: { vehicleId: "u9", fleetNumber: "HORSE-1" } },
      "Pulled by HORSE-1, not on a trip.",
    ],
    ["free", { trip: null, pulledBy: null }, "Free."],
  ])("names a trailer %s, with no controls for anyone", async (_name, state, words) => {
    stub({ trip: () => state });
    renderPanel(["ViewFleet", "ManageAssignments"], TRAILER);

    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
