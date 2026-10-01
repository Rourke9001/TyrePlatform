import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "../api/apiError";
import { ActorProvider } from "./ActorProvider";
import { AuthGate } from "./AuthGate";
import { useAuthFailure } from "./actorContext";
import { fetchMe } from "./me";
import { me } from "../test/fixtures";

vi.mock("./me", () => ({ fetchMe: vi.fn() }));
vi.mock("./oidc", () => ({
  signIn: vi.fn(() => new Promise(() => undefined)),
  completeSignIn: vi.fn(),
  renew: vi.fn(),
  signOut: vi.fn(),
}));

const fetchMeMock = vi.mocked(fetchMe);

function Probe() {
  return <p>failure: {String(useAuthFailure())}</p>;
}

function mount() {
  const client = new QueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ActorProvider>
        <Probe />
        <AuthGate>
          <p>the routes</p>
        </AuthGate>
      </ActorProvider>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("tyre.dev.auth", "bearer");
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ActorProvider failure", () => {
  it("names signed-out for a 401 and asks only once", async () => {
    fetchMeMock.mockRejectedValue(new ApiError(401, "x", "unauthorized"));
    mount();
    expect(await screen.findByText("failure: signed-out")).toBeInTheDocument();
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("names not-set-up for a 403 forbidden and asks only once", async () => {
    fetchMeMock.mockRejectedValue(new ApiError(403, "x", "forbidden"));
    mount();
    expect(await screen.findByText("failure: not-set-up")).toBeInTheDocument();
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  // credential() throws this locally, so a retry cannot change the answer.
  it("does not retry an unavailable sign-in", async () => {
    fetchMeMock.mockRejectedValue(new ApiError(503, "x", "auth_unavailable"));
    mount();
    expect(await screen.findByText("failure: unavailable")).toBeInTheDocument();
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  // Spec section 4: the screen holds until /api/me answers with data.
  it("keeps the sign-in screen when a later refetch fails with a network error", async () => {
    fetchMeMock.mockRejectedValueOnce(new ApiError(401, "x", "unauthorized"));
    const { client } = mount();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();

    vi.useFakeTimers();
    fetchMeMock.mockRejectedValue(new TypeError("Failed to fetch"));
    void client.refetchQueries({ queryKey: ["me"] });
    // Three retries back off for 1, 2 and 4 seconds.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMeMock.mock.calls.length).toBeGreaterThan(2);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("the routes")).toBeNull();
  });

  it("lets the routes through once /api/me returns data", async () => {
    fetchMeMock.mockRejectedValueOnce(new ApiError(401, "x", "unauthorized"));
    const { client } = mount();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fetchMeMock.mockResolvedValue(me());
    await act(async () => {
      await client.refetchQueries({ queryKey: ["me"] });
    });
    expect(await screen.findByText("the routes")).toBeInTheDocument();
  });
});
