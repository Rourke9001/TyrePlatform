import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { bearerSession } from "../test/bearerSession";

vi.mock("./oidc", () => ({
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
  renew: vi.fn(),
  signIn: vi.fn(),
  discardUser: vi.fn(() => Promise.resolve()),
}));

// The callback reads the held stamps before the exchange. A real read is
// IndexedDB's, which the fake clock below does not drive, so the bound could
// start after the clock has moved. This one answers at once.
vi.mock("../capture/outbox", () => ({
  heldStamps: vi.fn(() => Promise.resolve([])),
  flushOutbox: vi.fn(() => Promise.resolve()),
}));

const SIGNED_IN = {
  accessToken: "at-a",
  expiresAt: Date.now() + 3_600_000,
  subject: "oid-a",
  returnTo: "/capture/v1",
};

async function fresh() {
  vi.resetModules();
  const callback = await import("./callback");
  const oidc = await import("./oidc");
  const token = await import("../api/token");
  const { boot } = await import("../shell/boot");
  return { callback, oidc, token, boot };
}

const PENDING = "pending" as const;

// Past the bound on the fake clock, then whether the work has settled. A red
// run fails on its assertion instead of hanging to the test timeout.
async function afterTheBound<T>(work: Promise<T>, extraMs = 0): Promise<T | typeof PENDING> {
  const { REQUEST_TIMEOUT_SECONDS } = await import("../api/deadline");
  const settled = work.then((v) => v);
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000 + extraMs);
  return Promise.race([settled, Promise.resolve(PENDING)]);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  bearerSession();
  window.history.replaceState(null, "", "/?code=c1&state=s1");
  vi.stubGlobal("fetch", vi.fn());
  // Only the timers the bound uses. With the stamp read stubbed, nothing on
  // these paths touches IndexedDB.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// TYRE-388: the library's request timeout ends at the token response's
// headers, and the first render waits on the callback, so the callback's own
// bound is what lets the app render.
it("renders the app, signed out, once the bound passes on a code exchange that never finishes", async () => {
  const { callback, oidc, token, boot } = await fresh();
  vi.mocked(oidc.completeSignIn).mockReturnValue(new Promise(() => undefined));
  const render = vi.fn();

  const booted = boot({
    loadConfig: () => Promise.resolve(),
    completeRedirect: callback.completeRedirect,
    render,
    renderFailure: vi.fn(),
    onOnline: () => () => undefined,
  });

  expect(await afterTheBound(booted)).toBeUndefined();
  expect(render).toHaveBeenCalledTimes(1);
  expect(callback.signInDidNotFinish()).toBe(true);
  expect(window.location.search).toBe("");
  expect(token.lastKnownSubject()).toBeNull();
});

// U104: only the callback compares a new driver against the work held, so a
// session it never saw must not be left for a renewal to find.
it("discards a code exchange that finishes after the bound, and records nothing", async () => {
  const { callback, oidc, token } = await fresh();
  vi.mocked(oidc.completeSignIn).mockReturnValue(
    new Promise((resolve) => setTimeout(() => resolve(SIGNED_IN), 11_000)),
  );

  const outcome = callback.completeRedirect();
  expect(await afterTheBound(outcome)).toBe("failed");
  // The exchange finishes a second after the bound.
  await vi.advanceTimersByTimeAsync(1000);

  expect(oidc.discardUser).toHaveBeenCalledTimes(1);
  expect(oidc.discardUser).toHaveBeenCalledWith("at-a");

  expect(token.lastKnownSubject()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not discard anything when the exchange fails outright", async () => {
  const { callback, oidc } = await fresh();
  vi.mocked(oidc.completeSignIn).mockRejectedValue(new Error("access_denied"));

  expect(await afterTheBound(callback.completeRedirect(), 1000)).toBe("failed");

  expect(oidc.discardUser).not.toHaveBeenCalled();
});
