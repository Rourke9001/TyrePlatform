import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ActorContext } from "./auth/actorContext";
import { ActorProvider } from "./auth/ActorProvider";
import { AppRoutes } from "./routes";
import type { Me } from "./auth/me";

const actor = (capabilities: string[]): Me => ({
  userId: "00000000-0000-0000-0000-000000000001",
  displayName: "Test",
  role: "CONTROLLER",
  capabilities,
  depots: [],
});

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

// Shared by every test that needs a QueryClient: the default retries a
// failed request three times with backoff, which would otherwise schedule
// timers that outlive the test body.
function testClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderAt(path: string, me: Me) {
  render(
    <QueryClientProvider client={testClient()}>
      <ActorContext value={{ actor: me, settled: true }}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ActorContext>
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
    expect(screen.getByRole("heading", { name: /vehicles/i })).toBeDefined();
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
    expect(screen.queryByRole("heading", { name: /vehicles/i })).toBeNull();
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
    const controller: Me = {
      userId: "u1",
      displayName: "Nomsa",
      role: "CONTROLLER",
      capabilities: ["ViewFleet", "CaptureInspection"],
      depots: [],
    };
    // Deliberately not resolved yet: the assertion below is that nothing has
    // navigated while it is outstanding.
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );

    render(
      <QueryClientProvider client={testClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <ActorProvider>
            <AppRoutes />
          </ActorProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.queryByRole("heading", { name: /inspections/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /vehicles/i })).toBeNull();

    release(new Response(JSON.stringify(controller), { status: 200 }));
    expect(await screen.findByRole("heading", { name: /vehicles/i })).toBeDefined();
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
});
