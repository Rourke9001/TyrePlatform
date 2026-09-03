import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";

import { ActorContext } from "./auth/actorContext";
import { ActorProvider } from "./auth/ActorProvider";
import { AppRoutes, UnitRoute } from "./routes";
import type { Me } from "./auth/me";
import {
  fitmentRow,
  me,
  requestedUrl,
  respond,
  testQueryClient,
  unit,
  unitPosition,
} from "./test/fixtures";

const actor = (capabilities: string[]): Me =>
  me({ userId: "00000000-0000-0000-0000-000000000001", capabilities });

// DriverHome and VehicleList both fetch through TanStack Query. `fetch` is
// stubbed with a real Response so every route can be driven to a specific
// status without a network call. Returning the mock lets a test assert on
// what apiGet actually sent, not just what it rendered.
function mockFetchJson(status: number, body: unknown): Mock<typeof fetch> {
  const mock: Mock<typeof fetch> = vi.fn();
  mock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const DEV_ACTOR_STORAGE_KEY = "tyre.dev.user-id";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem(DEV_ACTOR_STORAGE_KEY);
});

function renderAt(path: string, me: Me) {
  render(
    <QueryClientProvider client={testQueryClient()}>
      <ActorContext.Provider value={{ actor: me, settled: true }}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ActorContext.Provider>
    </QueryClientProvider>,
  );
}

describe("AppRoutes", () => {
  it("lands a driver on their own work rather than a fleet view they cannot read", () => {
    mockFetchJson(200, []);
    renderAt("/", actor(["CaptureInspection"]));
    expect(screen.getByRole("heading", { name: /my inspections/i })).toBeDefined();
  });

  it("lands a ViewFleet holder on the fleet view rather than the driver view", () => {
    mockFetchJson(200, []);
    renderAt("/", actor(["ViewFleet"]));
    expect(screen.getByRole("heading", { name: /units/i })).toBeDefined();
  });

  it("renders a not-found view for an unknown path", () => {
    renderAt("/nowhere", actor(["ViewFleet"]));
    expect(screen.getByText(/not found/i)).toBeDefined();
  });

  // The landing redirect keeps a driver off /fleet, but the route itself must
  // refuse the same actor if they land here another way — a pasted link or a
  // bookmark, not just an offered nav link. RequireCapability hides silently,
  // so "refused" reads as the heading never appearing rather than an error.
  it("shows nothing at /fleet for an actor who can only capture inspections", () => {
    renderAt("/fleet", actor(["CaptureInspection"]));
    expect(screen.queryByRole("heading", { name: /units/i })).toBeNull();
  });

  // GET /api/my/tasks returns 200 with [] for an unassigned driver — an empty
  // result is a legitimate answer, not a refusal, and must not render as one.
  it("shows an unassigned driver's empty task list rather than an error", async () => {
    mockFetchJson(200, []);
    renderAt("/my", actor(["CaptureInspection"]));
    expect(await screen.findByText(/nothing due/i)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The server re-checks the capability on every request (NFR-SEC-006); a
  // refusal reaching the client after the route already rendered must surface
  // as an error state, not silently look like an empty list.
  it("surfaces a capability refusal on /api/my/tasks as an error, not an empty list", async () => {
    mockFetchJson(403, { error: "forbidden" });
    renderAt("/my", actor(["CaptureInspection"]));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.queryByText(/nothing due/i)).toBeNull();
  });

  // The API's dev actor middleware 401s any request missing X-User-ID, and
  // nothing else in this suite asserts on apiGet's headers, so this is the
  // only place a regression here would be caught.
  it("sends the dev actor id from localStorage as X-User-ID on every request", async () => {
    const devActorId = "b85aef08-6081-80db-9d4d-dad38ae40545";
    window.localStorage.setItem(DEV_ACTOR_STORAGE_KEY, devActorId);
    const fetchMock = mockFetchJson(200, []);
    renderAt("/my", actor(["CaptureInspection"]));
    await screen.findByText(/nothing due/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/my/tasks");
    // Normalised through Headers: apiGet builds a plain object, but
    // HeadersInit also allows an array of pairs or a Headers instance, and
    // this must hold regardless of which shape apiGet chooses to send.
    expect(new Headers(init?.headers).get("X-User-ID")).toBe(devActorId);
  });

  // /capture is the one route that refuses out loud. A menu item may hide
  // silently, but somebody who followed a link to a destination and got a blank
  // screen has no way to tell refusal from a broken app (NFR-USE-005). The
  // server re-checks the capability regardless (NFR-SEC-006).
  it("explains a refusal at /capture rather than rendering nothing", () => {
    renderAt("/capture/11111111-1111-1111-1111-111111111111", actor(["ViewFleet"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  // The redirect is one-shot, so a decision taken before GET /api/me answers
  // is never revised. Mounting the real provider is the only way to exercise
  // that: renderAt injects the actor synchronously and cannot see this class
  // of bug.
  it("waits for the actor before choosing a landing view", async () => {
    const controller = me({
      userId: "u1",
      displayName: "Nomsa",
      capabilities: ["ViewFleet", "CaptureInspection"],
    });
    // Deliberately not resolved yet: the assertion below is that nothing has
    // navigated while it is outstanding.
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );

    render(
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <ActorProvider>
            <AppRoutes />
          </ActorProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("heading", { name: /inspections/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /units/i })).toBeNull();

    release(new Response(JSON.stringify(controller), { status: 200 }));
    expect(await screen.findByRole("heading", { name: /units/i })).toBeDefined();
  });

  it("tells an actor without the capability, rather than blanking the screen", () => {
    mockFetchJson(200, []);
    renderAt("/admin/units/new", actor(["CaptureInspection"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("renders the add-a-unit screen for an actor holding ManageAssets", async () => {
    // The screen fetches the configuration library on mount; an unstubbed
    // relative-URL fetch throws in node, so stub it even though the heading
    // renders outside the query's branches.
    mockFetchJson(200, []);
    renderAt("/admin/units/new", actor(["ManageAssets"]));
    expect(await screen.findByRole("heading", { name: /add a unit/i })).toBeInTheDocument();
  });

  it("tells an actor without the capability, rather than blanking the screen, at /admin/users/new", () => {
    mockFetchJson(200, []);
    renderAt("/admin/users/new", actor(["CaptureInspection"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("renders the add-a-user screen for an actor holding ManageUsers", () => {
    renderAt("/admin/users/new", actor(["ManageUsers"]));
    expect(screen.getByRole("heading", { name: /add a user/i })).toBeInTheDocument();
  });

  // D9 split the invite: a CONTROLLER or DEPOT_MANAGER holds InviteDriver and
  // not ManageUsers, and the whole point of the split is that they reach this
  // screen anyway (ADR-0011).
  it("renders the add-a-user screen for an actor holding InviteDriver alone", () => {
    renderAt("/admin/users/new", actor(["InviteDriver"]));
    expect(screen.getByRole("heading", { name: /add a user/i })).toBeInTheDocument();
  });

  it("tells an actor without the capability, rather than blanking the screen, at /fleet/tyres", () => {
    renderAt("/fleet/tyres", actor(["ViewFleet"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("renders the tyre register for an actor holding ManageAssets", async () => {
    mockFetchJson(200, { tyres: [] });
    renderAt("/fleet/tyres", actor(["ViewFleet", "ManageAssets"]));
    expect(await screen.findByRole("heading", { name: /tyres/i })).toBeInTheDocument();
  });

  it("tells an actor without the capability, rather than blanking the screen, at /fleet/tyres/new", () => {
    renderAt("/fleet/tyres/new", actor(["ViewFleet"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("renders the receive-tyre screen for an actor holding ManageAssets", () => {
    renderAt("/fleet/tyres/new", actor(["ViewFleet", "ManageAssets"]));
    expect(screen.getByRole("heading", { name: /receive tyres/i })).toBeInTheDocument();
  });

  it("renders the unit screen at /fleet/units/:unitId for a ViewFleet holder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = requestedUrl(input);
        if (url === "/api/vehicles/u9")
          return Promise.resolve(
            respond(
              200,
              unit({ id: "u9", fleetNumber: "HORSE-1", positions: [unitPosition({ id: "p1" })] }),
            ),
          );
        if (url === "/api/vehicles/u9/fitments")
          return Promise.resolve(respond(200, [fitmentRow({ fitmentId: "f1" })]));
        throw new Error(`unstubbed ${url}`);
      }),
    );
    renderAt("/fleet/units/u9", actor(["ViewFleet"]));
    expect(await screen.findByRole("heading", { name: "HORSE-1" })).toBeInTheDocument();
  });

  // A unit is reached by following a link from the unit list, so it is a
  // destination someone navigated to and says why it is refused — routes.tsx's
  // own rule, the same one /capture answers to.
  it("explains a refusal at /fleet/units/:unitId rather than rendering nothing", () => {
    renderAt("/fleet/units/u9", actor(["CaptureInspection"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
    expect(screen.queryByRole("heading", { name: "HORSE-1" })).toBeNull();
    // renderAt is synchronous: with the guard gone, UnitDetail would still
    // mount and its query would still be pending on this first render, so the
    // assertions above could pass on a screen that had merely not loaded yet
    // — this is the one that separates a refusal from a slow read.
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  // Unreachable through AppRoutes' own path table (:unitId never matches an
  // empty segment) — mirrors CaptureRoute's defensive shape, so this drives
  // UnitRoute directly rather than through a URL nothing can produce.
  it("renders not-found from UnitRoute itself when unitId is absent", () => {
    render(
      <MemoryRouter initialEntries={["/no-id"]}>
        <Routes>
          <Route path="/no-id" element={<UnitRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/not found/i)).toBeDefined();
  });

  it("renders the fitments list at /fleet/fitments for a ViewFleet holder", async () => {
    mockFetchJson(200, []);
    renderAt("/fleet/fitments", actor(["ViewFleet"]));
    expect(await screen.findByRole("heading", { name: /fitments/i })).toBeInTheDocument();
  });

  // D7 keeps the fitments list hidden rather than refused, like /fleet: it is
  // a menu destination, not somewhere a link inside the app sends a reader who
  // cannot read it.
  it("shows nothing at /fleet/fitments for an actor without ViewFleet", () => {
    renderAt("/fleet/fitments", actor(["CaptureInspection"]));
    expect(screen.queryByRole("heading", { name: /fitments/i })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // Distinguishes RequireCapability's silent hide from the catch-all
    // NotFound route: the route must exist and hide, not be absent.
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  // "Rigs", exact: /rigs/i would also match the list's own "Open rigs" and
  // "Ended rigs" headings once rigs.isSuccess renders them.
  it("renders the rigs screen at /fleet/rigs for a ViewFleet holder", async () => {
    mockFetchJson(200, []);
    renderAt("/fleet/rigs", actor(["ViewFleet"]));
    expect(await screen.findByRole("heading", { name: "Rigs" })).toBeInTheDocument();
  });

  // U2: rig writes gate on ManageAssignments, reads on ViewFleet — the same
  // split D7 already drew for Fitments.
  it("shows nothing at /fleet/rigs for an actor without ViewFleet", () => {
    renderAt("/fleet/rigs", actor(["CaptureInspection"]));
    expect(screen.queryByRole("heading", { name: "Rigs" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  // U2/D5: RigsScreen itself, not the route, gates Set a rig on
  // ManageAssignments — a ViewFleet-only actor reads the register and never
  // sees the write form.
  it("shows Open rigs without the Set a rig form for a ViewFleet holder alone", async () => {
    mockFetchJson(200, []);
    renderAt("/fleet/rigs", actor(["ViewFleet"]));
    expect(await screen.findByRole("heading", { name: "Open rigs" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Set a rig" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set rig" })).toBeNull();
  });

  it("tells an actor without the capability, rather than blanking the screen, at /fleet/tyres/retreads", () => {
    renderAt("/fleet/tyres/retreads", actor(["ViewFleet"]));
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
  });

  it("renders the retread queue for an actor holding LogRetread", async () => {
    mockFetchJson(200, []);
    renderAt("/fleet/tyres/retreads", actor(["LogRetread"]));
    expect(await screen.findByRole("heading", { name: /retreads/i })).toBeInTheDocument();
  });
});
