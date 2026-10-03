import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContext, useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ActorContext, useActor, type AuthFailure } from "./actorContext";
import { ActorProvider } from "./ActorProvider";
import { AuthGate } from "./AuthGate";
import { writeMirror } from "../api/token";
import { bearerSession } from "../test/bearerSession";
import { me } from "../test/fixtures";
import { db } from "../capture/draft";
import { OutboxIndicator } from "../capture/OutboxIndicator";
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
  // The one waiting count is the outbox band's, mounted above the gate as the
  // shell does (U107).
  it("shows the neutral line without the marker, and no count beside the band's", async () => {
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
    render(
      <ActorContext.Provider value={{ actor: null, settled: true, failure: "signed-out" }}>
        <OutboxIndicator />
        <AuthGate>
          <p>the routes</p>
        </AuthGate>
      </ActorContext.Provider>,
    );
    expect(await screen.findByText("1 inspection waiting to send")).toBeInTheDocument();
    expect(screen.getAllByText(/waiting to send/)).toHaveLength(1);
    expect(
      screen.getByText("Sign in with the email address your fleet office has for you."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/another driver/)).toBeNull();
  });
});

// Spec section 4, The prompt never interrupts a capture. The real provider and
// a real 401 from /api/me, through the token store. The gate's child stands in
// for the capture route and counts its own mounts.
describe("a refetch of /api/me answering 401 while an actor is held", () => {
  let mounts = 0;
  let unmounts = 0;

  function CaptureInProgress() {
    useEffect(() => {
      mounts += 1;
      return () => {
        unmounts += 1;
      };
    }, []);
    return <p>capture in progress</p>;
  }

  // Outside the gate, so it reads the provider whatever the gate shows.
  function Actor() {
    const failure = useContext(ActorContext).failure ?? null;
    return (
      <p>
        actor: {useActor()?.displayName ?? "none"}, failure: {String(failure)}
      </p>
    );
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the actor, and never unmounts the capture", async () => {
    bearerSession();
    // Older than the fresh-token window, so the 401 reads as a lapse, not as
    // an API that refuses every token (token.ts, refused()).
    writeMirror({
      accessToken: "at-a",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: Date.now() - 5 * 60_000,
      subject: "oid-a",
      tenantId: "t0",
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(JSON.stringify(me({ displayName: "Driver A" })))),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: "unauthorized", message: "expired" }), {
            status: 401,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    mounts = 0;
    unmounts = 0;
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ActorProvider>
          <Actor />
          <AuthGate>
            <CaptureInProgress />
          </AuthGate>
        </ActorProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("actor: Driver A, failure: null")).toBeInTheDocument();

    await act(async () => {
      await client.refetchQueries({ queryKey: ["me"] });
    });

    // The query notifies its observers on a later tick, so this waits until
    // the provider has named the 401 before judging what it kept.
    expect(await screen.findByText(/failure: signed-out/)).toHaveTextContent(
      "actor: Driver A, failure: signed-out",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("capture in progress")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
    expect({ mounts, unmounts }).toEqual({ mounts: 1, unmounts: 0 });
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
