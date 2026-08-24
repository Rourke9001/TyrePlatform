import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ActorContext } from "./auth/actorContext";
import { AppRoutes } from "./routes";
import type { Me } from "./auth/me";

const actor = (capabilities: string[]): Me => ({
  userId: "00000000-0000-0000-0000-000000000001",
  displayName: "Test",
  role: "CONTROLLER",
  capabilities,
  depots: [],
});

// DriverHome and VehicleList both fetch through TanStack Query, and the
// default QueryClient retries a failed request three times with backoff —
// against a live `fetch` that schedules retry timers that outlive the test
// body (Task 6 review). `fetch` is stubbed with a real Response so every
// route can be driven to a specific status without a network call. Returning
// the mock lets a test assert on what apiGet actually sent, not just what it
// rendered.
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
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ActorContext value={me}>
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

  // apiGet has been required to send X-User-ID since Task 4's actor
  // middleware landed API-side (every live browser request 401s without it);
  // nothing else in this suite calls apiGet, so this is the only place a
  // regression here would be caught.
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
});
