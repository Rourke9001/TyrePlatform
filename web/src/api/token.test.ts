import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIRROR_KEY,
  SUBJECT_KEY,
  authConfigured,
  bearerMode,
  clearMirror,
  lastKnownSubject,
  readMirror,
  rememberSubject,
  rememberTenant,
  writeMirror,
  type Mirror,
} from "./token";
import { bearerSession } from "../test/bearerSession";

const MIRROR: Mirror = {
  accessToken: "at-1",
  expiresAt: Date.now() + 3_600_000,
  obtainedAt: Date.now(),
  subject: "oid-a",
  tenantId: null,
};

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the mirror", () => {
  it("reads back what was written", () => {
    writeMirror(MIRROR);
    expect(readMirror()).toEqual(MIRROR);
  });

  // A half-written or hand-edited value is no session at all, never a throw
  // on the path every API call takes.
  it("reads malformed JSON or the wrong shape as no mirror", () => {
    window.localStorage.setItem(MIRROR_KEY, "{not json");
    expect(readMirror()).toBeNull();
    window.localStorage.setItem(MIRROR_KEY, JSON.stringify({ accessToken: 1 }));
    expect(readMirror()).toBeNull();
  });

  it("clears the mirror and leaves the last-known subject alone", () => {
    writeMirror(MIRROR);
    rememberSubject("oid-a");
    clearMirror();
    expect(readMirror()).toBeNull();
    expect(lastKnownSubject()).toBe("oid-a");
    expect(window.localStorage.getItem(SUBJECT_KEY)).toBe("oid-a");
  });

  it("records the tenant /api/me proved, and does nothing without a mirror", () => {
    rememberTenant("t-1");
    expect(readMirror()).toBeNull();
    writeMirror(MIRROR);
    rememberTenant("t-1");
    expect(readMirror()?.tenantId).toBe("t-1");
  });

  // A full store must not fail a successful /api/me (me.ts calls this).
  it("does not throw when the store is full", () => {
    writeMirror(MIRROR);
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      expect(() => rememberTenant("t-2")).not.toThrow();
    } finally {
      full.mockRestore();
    }
  });
});

describe("the DEV bearer flag", () => {
  it("is off by default under vitest and on when the flag says bearer", () => {
    expect(bearerMode()).toBe(false);
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    expect(bearerMode()).toBe(true);
  });
});

describe("authConfigured", () => {
  it("is false until all three VITE_AUTH_* values are set", () => {
    expect(authConfigured()).toBe(false);
    vi.stubEnv("VITE_AUTH_AUTHORITY", "https://idp.test/");
    vi.stubEnv("VITE_AUTH_CLIENT_ID", "pwa");
    expect(authConfigured()).toBe(false);
    vi.stubEnv("VITE_AUTH_API_SCOPE", "api://tyre-api/access_as_user");
    expect(authConfigured()).toBe(true);
  });
});

vi.mock("../auth/oidc", () => ({
  renew: vi.fn(),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
  discardUser: vi.fn(() => Promise.resolve()),
}));
vi.mock("../shell/chunkReload", async (original) => ({
  ...(await original<typeof import("../shell/chunkReload")>()),
  suppressReloadWhile: vi.fn((p: Promise<unknown>) => p),
}));

// Module state such as the latch lives in the module, so each case imports a
// fresh copy.
async function fresh() {
  vi.resetModules();
  const token = await import("./token");
  const oidc = await import("../auth/oidc");
  const { ApiError } = await import("./apiError");
  const { suppressReloadWhile } = await import("../shell/chunkReload");
  return { token, oidc, ApiError, suppressReloadWhile };
}

const RENEWED = { accessToken: "at-2", expiresAt: Date.now() + 3_600_000, subject: "oid-a" };

describe("credential", () => {
  // A driver has signed in on this phone. Without a last-known subject there
  // is no session to renew (token.chunkfail.test.ts).
  beforeEach(() => {
    bearerSession();
    rememberSubject("oid-a");
  });

  it("hands back a valid mirrored token without loading the auth chunk", async () => {
    const { token, oidc, suppressReloadWhile } = await fresh();
    token.writeMirror(MIRROR);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-1", subject: "oid-a" });
    expect(oidc.renew).not.toHaveBeenCalled();
    expect(suppressReloadWhile).not.toHaveBeenCalled();
  });

  // 60 seconds early, so no token expires between the check and the server.
  it("renews a token that is about to expire and mirrors the result", async () => {
    const { token, oidc } = await fresh();
    token.writeMirror({ ...MIRROR, expiresAt: Date.now() + 30_000, tenantId: "t-1" });
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(token.readMirror()).toMatchObject({ accessToken: "at-2", tenantId: "t-1" });
    expect(token.lastKnownSubject()).toBe("oid-a");
  });

  it("shares one renewal between three concurrent callers", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(RENEWED), 10)),
    );

    const got = await Promise.all([token.credential(), token.credential(), token.credential()]);
    expect(got.map((c) => c.accessToken)).toEqual(["at-2", "at-2", "at-2"]);
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });

  // The chunk answers null for no refresh token and for a refused one
  // (oidc.test.ts pins which). The API is never called.
  it("answers 401 signed_out, clears the mirror and keeps the last-known subject", async () => {
    const { token, oidc, ApiError } = await fresh();
    token.writeMirror({ ...MIRROR, expiresAt: 0 });
    token.rememberSubject("oid-a");
    vi.mocked(oidc.renew).mockResolvedValue(null);
    const lapsed = vi.fn();
    token.onLapse(lapsed);

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect((error as InstanceType<typeof ApiError>).code).toBe("signed_out");
    expect(token.readMirror()).toBeNull();
    expect(token.lastKnownSubject()).toBe("oid-a");
    expect(token.sessionLapsed()).toBe(true);
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  // U111 B: only the redirect callback changes the last-known subject, so a
  // stored user it never recorded is dropped at renewal, not adopted.
  it("drops a renewal that returns another subject, and keeps the last-known one", async () => {
    const { token, oidc, ApiError } = await fresh();
    token.writeMirror({ ...MIRROR, expiresAt: 0 });
    vi.mocked(oidc.renew).mockResolvedValue({ ...RENEWED, subject: "oid-b" });

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect((error as InstanceType<typeof ApiError>).code).toBe("signed_out");
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(token.readMirror()).toBeNull();
    expect(token.lastKnownSubject()).toBe("oid-a");
  });

  // Another tab's sign-out clears the subject while this tab's renewal is in
  // flight; the renewal must not write it back (U111 B).
  it("drops a renewal that settles after the last-known subject was cleared", async () => {
    const { token, oidc } = await fresh();
    token.writeMirror({ ...MIRROR, expiresAt: 0 });
    vi.mocked(oidc.renew).mockImplementation(() => {
      window.localStorage.removeItem(SUBJECT_KEY);
      return Promise.resolve(RENEWED);
    });

    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(token.lastKnownSubject()).toBeNull();
    expect(token.readMirror()).toBeNull();
  });

  // Discarding is best effort; the mirror is cleared and the call refused
  // whether or not the chunk could remove its stored user.
  it("refuses the renewal even when the stored user cannot be discarded", async () => {
    const { token, oidc } = await fresh();
    token.writeMirror({ ...MIRROR, expiresAt: 0 });
    vi.mocked(oidc.renew).mockResolvedValue({ ...RENEWED, subject: "oid-b" });
    vi.mocked(oidc.discardUser).mockRejectedValueOnce(new Error("storage"));

    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(token.readMirror()).toBeNull();
    expect(token.lastKnownSubject()).toBe("oid-a");
  });

  // Another tab's sign-in writes the shared mirror. This tab's calls then
  // succeed, so its line must stop saying the sign-in has run out.
  it("ends the lapse, and says so, once a usable token is back", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(null);
    const changed = vi.fn();
    token.onLapse(changed);
    await expect(token.credential()).rejects.toMatchObject({ status: 401 });
    expect(token.sessionLapsed()).toBe(true);

    token.writeMirror(MIRROR);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-1", subject: "oid-a" });
    expect(token.sessionLapsed()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  // The outbox reads a network failure as offline, never as signed out.
  it("lets a network failure from the renewal through as itself", async () => {
    const { token, oidc, ApiError } = await fresh();
    vi.mocked(oidc.renew).mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(token.sessionLapsed()).toBe(false);
  });

  it("lets a transient refusal through as a plain error, not as signed out", async () => {
    const { token, oidc, ApiError } = await fresh();
    vi.mocked(oidc.renew).mockRejectedValue(
      Object.assign(new Error("try later"), { error: "temporarily_unavailable" }),
    );

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(token.sessionLapsed()).toBe(false);
  });

  // A private window refuses the write; the renewed token is still good.
  it("still returns a renewed token when the mirror cannot be written", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    } finally {
      full.mockRestore();
    }
  });

  // The refresh request's own timeout ends when its headers arrive, so a
  // stalled body would hold every caller of the one renewal (spec section 4,
  // Renewal).
  it("answers as offline once the bound passes, starts no second renewal, and adopts the late one", async () => {
    const { token, oidc, ApiError } = await fresh();
    let finish: (tokens: typeof RENEWED) => void = () => undefined;
    vi.mocked(oidc.renew).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.useFakeTimers();
    const watch = (call: Promise<unknown>) => {
      const seen: { value: unknown } = { value: "pending" };
      void call.then(
        (value) => {
          seen.value = value;
        },
        (error: unknown) => {
          seen.value = error;
        },
      );
      return seen;
    };

    const first = watch(token.credential());
    await vi.advanceTimersByTimeAsync(token.REQUEST_TIMEOUT_SECONDS * 1000);
    expect(first.value).toBeInstanceOf(Error);
    expect(first.value).not.toBeInstanceOf(ApiError);
    expect(token.sessionLapsed()).toBe(false);

    // Joins the stuck renewal and is answered without waiting out a second
    // bound.
    const second = watch(token.credential());
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value).toBeInstanceOf(Error);
    expect(oidc.renew).toHaveBeenCalledTimes(1);

    finish(RENEWED);
    await vi.advanceTimersByTimeAsync(0);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });

  it("renews again after a failed renewal settles", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(RENEWED);

    await expect(token.credential()).rejects.toBeInstanceOf(TypeError);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
  });

  // A blocked store must neither renew on every call nor hide a refused
  // fresh token from the latch.
  it("holds a renewed token in memory when storage refuses it, and still latches", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
      await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
      expect(oidc.renew).toHaveBeenCalledTimes(1);

      expect(token.refused("at-2")).toBe(true);
      await expect(token.credential()).rejects.toMatchObject({ status: 503 });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(oidc.renew).toHaveBeenCalledTimes(1);
    } finally {
      full.mockRestore();
    }
  });

  // Another tab's sign-out clears the shared mirror; this tab must not keep
  // answering with the old identity.
  it("renews, and so signs out, when another tab cleared the mirror", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValueOnce(RENEWED).mockResolvedValueOnce(null);
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-2" });

    token.clearMirror();
    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
  });

  // An old refusal drops the held token, so the next call renews.
  it("drops a held token on a refusal past the fresh window", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await token.credential();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(token.refused("at-2")).toBe(false);
    await token.credential();
    expect(oidc.renew).toHaveBeenCalledTimes(2);
  });

  it("answers 503 auth_unavailable, without the chunk, when the build carries no VITE_AUTH_* values", async () => {
    vi.unstubAllEnvs();
    const { token, oidc, ApiError, suppressReloadWhile } = await fresh();

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).code).toBe("auth_unavailable");
    expect(oidc.renew).not.toHaveBeenCalled();
    expect(suppressReloadWhile).not.toHaveBeenCalled();
  });
});

describe("refused", () => {
  beforeEach(() => {
    bearerSession();
  });

  // A wrong AUTH_AUDIENCE, AUTH_CLIENT_ID or scope refuses every valid
  // token; renewing again cannot help.
  it("latches on a 401 for a token obtained seconds ago, and then refuses every call with 503", async () => {
    const { token, oidc } = await fresh();
    token.writeMirror({ ...MIRROR, obtainedAt: Date.now() });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(token.refused("at-1")).toBe(true);
    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: "auth_unavailable" });
    expect(token.refused("at-1")).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // A slow 401 for at-1 can land after a renewal to at-2.
  it("leaves a mirror that has moved on to another token alone", async () => {
    const { token } = await fresh();
    token.writeMirror({ ...MIRROR, accessToken: "at-2" });

    expect(token.refused("at-1")).toBe(false);
    expect(token.readMirror()?.accessToken).toBe("at-2");
  });

  it("keeps answering true once latched, even for another token", async () => {
    const { token } = await fresh();
    token.writeMirror({ ...MIRROR, obtainedAt: Date.now() });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(token.refused("at-1")).toBe(true);
    expect(token.refused("at-9")).toBe(true);
  });

  // obtainedAt is device-clock time, so a clock corrected backwards leaves it
  // in the future, which is not "less than 60 seconds earlier" (spec
  // section 4, A fresh token refused).
  it("does not latch on a token whose obtainedAt is ahead of the clock", async () => {
    const { token, oidc } = await fresh();
    token.writeMirror({ ...MIRROR, obtainedAt: Date.now() + 2 * 3_600_000 });
    token.rememberSubject("oid-a");
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    expect(token.refused("at-1")).toBe(false);
    expect(token.isLatched()).toBe(false);
    expect(token.readMirror()).toBeNull();
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });

  it("clears the mirror on a 401 for an older token, so the next call renews", async () => {
    const { token } = await fresh();
    token.writeMirror({ ...MIRROR, obtainedAt: Date.now() - 5 * 60_000 });
    token.rememberSubject("oid-a");

    expect(token.refused("at-1")).toBe(false);
    expect(token.readMirror()).toBeNull();
    expect(token.lastKnownSubject()).toBe("oid-a");
  });
});

describe("sender and stampSubject under the DEV header path", () => {
  it("stand the dev actor in and never load the chunk", async () => {
    const { token, oidc, suppressReloadWhile } = await fresh();
    window.localStorage.setItem("tyre.dev.user-id", "dev-actor");

    await expect(token.sender()).resolves.toEqual({ accessToken: null, subject: "dev-actor" });
    expect(token.stampSubject()).toBe("dev-actor");
    expect(oidc.renew).not.toHaveBeenCalled();
    expect(suppressReloadWhile).not.toHaveBeenCalled();
  });

  it("stamp from the last-known subject on the bearer path", async () => {
    bearerSession();
    const { token } = await fresh();
    token.rememberSubject("oid-a");
    expect(token.stampSubject()).toBe("oid-a");
  });
});
