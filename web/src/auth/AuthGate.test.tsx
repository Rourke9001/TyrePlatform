import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActorContext, type AuthFailure } from "./actorContext";
import { AuthGate } from "./AuthGate";
import { me } from "../test/fixtures";
import { db } from "../capture/draft";
import { suppressReloadWhile } from "../shell/chunkReload";

vi.mock("./oidc", () => ({
  signIn: vi.fn(() => new Promise(() => undefined)),
  completeSignIn: vi.fn(),
  renew: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../shell/chunkReload", async (original) => ({
  ...(await original<typeof import("../shell/chunkReload")>()),
  suppressReloadWhile: vi.fn((p: Promise<unknown>) => p),
}));

function gate(failure: AuthFailure, actor = null as ReturnType<typeof me> | null) {
  return render(
    <ActorContext.Provider value={{ actor, settled: true, failure }}>
      <AuthGate>
        <p>the routes</p>
      </AuthGate>
    </ActorContext.Provider>,
  );
}

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem("tyre.dev.auth", "bearer");
  await db.open();
  await db.table("outbox").clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AuthGate", () => {
  it("shows the sign-in screen when this load has no actor and /api/me said 401", async () => {
    gate("signed-out");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Email me a sign-in code" });
    expect(screen.queryByText("the routes")).toBeNull();

    await userEvent.setup().click(button);
    const oidc = await import("./oidc");
    await vi.waitFor(() => expect(oidc.signIn).toHaveBeenCalledWith("/"));
  });

  // The prompt never interrupts a capture, so a later 401 keeps the screen.
  it("keeps the routes when an actor is already in hand", () => {
    gate("signed-out", me());
    expect(screen.getByText("the routes")).toBeInTheDocument();
  });

  it("says the account is not set up, and the company's account is not active", () => {
    const first = gate("not-set-up");
    expect(screen.getByText(/Ask your fleet office to set up your account/)).toBeInTheDocument();
    first.unmount();
    gate("tenant-inactive");
    expect(screen.getByText(/^This company's account is not active/)).toBeInTheDocument();
  });

  it("never offers sign-in when sign-in is unavailable", () => {
    gate("unavailable");
    expect(screen.getByText(/unavailable right now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign-in code|sign in/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("changes nothing under the DEV header path", () => {
    window.localStorage.removeItem("tyre.dev.auth");
    gate("signed-out");
    expect(screen.getByText("the routes")).toBeInTheDocument();
  });

  // Shown only after the U104 undo, and read once.
  it("shows the other-driver message when the marker is set, then clears it", () => {
    window.sessionStorage.setItem("tyre.auth.other-driver", "1");
    gate("signed-out");
    expect(screen.getByRole("alert")).toHaveTextContent(/captured by another driver/);
    expect(window.sessionStorage.getItem("tyre.auth.other-driver")).toBeNull();
  });

  // A driver whose own session lapsed is never told the work is someone else's.
  it("shows only the neutral count without the marker", async () => {
    await db.table("outbox").put({
      clientUuid: "u1",
      state: "queued",
      payload: {},
      queuedAt: Date.now(),
      attempts: 1,
      nextAttemptAt: Date.now() + 600_000,
      lastStatus: 401,
      lastCode: null,
      lastError: null,
      fleetNumber: null,
      driverSubject: "oid-a",
      legacy: false,
    });
    gate("signed-out");
    expect(
      await screen.findByText("1 inspection is waiting to send on this phone."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/another driver/)).toBeNull();
  });
});

// Spec section 4: once, after the first render, while online and with a
// stored session, the store warms the auth chunk. Every authChunk() call
// passes through suppressReloadWhile, so the spy counts the imports.
describe("the auth chunk warm-up", () => {
  it("loads the chunk after the first render, online, with a session stored", () => {
    window.localStorage.setItem("tyre.auth.subject", "oid-a");
    gate(null, me());
    expect(suppressReloadWhile).toHaveBeenCalledTimes(1);
  });

  it("does not warm without a stored session", () => {
    gate(null, me());
    expect(suppressReloadWhile).not.toHaveBeenCalled();
  });

  it("does not warm offline", () => {
    window.localStorage.setItem("tyre.auth.subject", "oid-a");
    const offline = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      gate(null, me());
      expect(suppressReloadWhile).not.toHaveBeenCalled();
    } finally {
      offline.mockRestore();
    }
  });

  it("does not warm under the DEV header path", () => {
    window.localStorage.removeItem("tyre.dev.auth");
    window.localStorage.setItem("tyre.auth.subject", "oid-a");
    gate(null, me());
    expect(suppressReloadWhile).not.toHaveBeenCalled();
  });
});
