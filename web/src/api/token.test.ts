import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUEST_TIMEOUT_SECONDS } from "./deadline";
import {
  SUBJECT_KEY,
  TENANT_KEY,
  authConfigured,
  bearerMode,
  brandingTenant,
  forgetTenant,
  rememberSubject,
  rememberTenant,
} from "./token";
import { bearerSession } from "../test/bearerSession";
import { LIBRARY_USER_KEY, plantSession } from "../test/librarySession";

// The store reads the library's user for real, planted by plantSession();
// only the calls that reach the identity provider are mocked.
vi.mock("../auth/oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/oidc")>()),
  renew: vi.fn(),
  discardUser: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the branding tenant", () => {
  it("is what rememberTenant wrote, until forgetTenant removes it", () => {
    rememberSubject("oid-a");
    expect(brandingTenant()).toBeNull();
    rememberTenant("t-1", "oid-a");
    expect(brandingTenant()).toBe("t-1");
    expect(window.localStorage.getItem(TENANT_KEY)).toBe("t-1");
    forgetTenant();
    expect(brandingTenant()).toBeNull();
  });

  // A GET /api/me that answers after signOut()'s local clear must not put
  // the key back (TYRE-471 spec, Signing out), nor one sent with no driver
  // signed in.
  it("writes nothing when no driver is signed in", () => {
    rememberTenant("t-1", "oid-a");
    rememberTenant("t-1", null);
    expect(window.localStorage.getItem(TENANT_KEY)).toBeNull();
  });

  // A late answer for the driver before must not land on a new sign-in's
  // key (TYRE-471 spec, The session).
  it("writes nothing for a call sent under another driver than the last-known one", () => {
    rememberSubject("oid-b");
    rememberTenant("t-1", "oid-a");
    expect(window.localStorage.getItem(TENANT_KEY)).toBeNull();
  });

  // A full store must not fail a successful /api/me (me.ts calls this).
  it("does not throw when the store is full", () => {
    rememberSubject("oid-a");
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      expect(() => rememberTenant("t-2", "oid-a")).not.toThrow();
    } finally {
      full.mockRestore();
    }
  });

  // Blocked storage reads as no subject, so nothing is written and nothing
  // throws.
  it("writes nothing, and does not throw, when storage refuses access", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(() => rememberTenant("t-1", "oid-a")).not.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  // First paint reads it (ThemeProvider.tsx), so storage that refuses
  // access is no tenant, never a throw.
  it("reads storage that refuses access as no tenant", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(brandingTenant()).toBeNull();
  });
});

describe("the key a phone signed in before TYRE-471 still holds", () => {
  // U102 and b9 spec section 6: it names the driver, and nothing else removes
  // it (TYRE-471 spec, The old key).
  it("is removed when the store loads and when the session is cleared", async () => {
    window.localStorage.setItem("tyre.auth.mirror", "{}");
    const { token } = await fresh();
    expect(window.localStorage.getItem("tyre.auth.mirror")).toBeNull();

    window.localStorage.setItem("tyre.auth.mirror", "{}");
    token.clearSession();
    expect(window.localStorage.getItem("tyre.auth.mirror")).toBeNull();
  });
});

describe("clearSession", () => {
  // A page a rejected sign-out leaves in place compares nothing against the
  // last driver's tokens (TYRE-471 spec, Signing out).
  it("clears the subject, the tenant key and what the store compares against", async () => {
    bearerSession();
    const { token } = await fresh();
    token.rememberSubject("oid-a");
    token.rememberTenant("t-1", "oid-a");
    token.recordObtained("at-1");

    token.clearSession();

    expect(window.localStorage.getItem(SUBJECT_KEY)).toBeNull();
    expect(window.localStorage.getItem(TENANT_KEY)).toBeNull();
    // Not latched, because clearSession forgot when at-1 was obtained.
    expect(token.refused("at-1")).toBe(false);
  });

  // A fresh token refused stops the store "for the rest of the page load"
  // (TYRE-471 spec, A fresh token refused), so only a reload clears it.
  it("keeps the latch", async () => {
    bearerSession();
    const { token } = await fresh();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    token.recordObtained("at-1");
    expect(token.refused("at-1")).toBe(true);

    token.clearSession();

    expect(token.isLatched()).toBe(true);
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

// Module state such as the latch lives in the module, so each case imports a
// fresh copy.
async function fresh() {
  vi.resetModules();
  const token = await import("./token");
  const oidc = await import("../auth/oidc");
  const { ApiError } = await import("./apiError");
  return { token, oidc, ApiError };
}

const RENEWED = { accessToken: "at-2", expiresAt: Date.now() + 3_600_000, subject: "oid-a" };

// The renewal a 401 starts follows one read of the stored user, which the
// library makes in microtasks only, so after one macrotask the renewal has
// started and settled, or never will.
function afterTheRead(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("credential", () => {
  // A driver has signed in on this phone, except where a case removes it.
  beforeEach(() => {
    bearerSession();
    rememberSubject("oid-a");
  });

  it("hands back a live stored token without renewing", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-1", subject: "oid-a" });
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // Every sign-in writes the last-known subject or does not finish, so a
  // library user left without one (a callback whose discard failed) is
  // neither used nor renewed (TYRE-471 spec, Renewal).
  it("answers 401 signed_out without renewing when no driver has signed in", async () => {
    window.localStorage.removeItem(SUBJECT_KEY);
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    const { token, oidc, ApiError } = await fresh();

    const error = await token.credential().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect((error as InstanceType<typeof ApiError>).code).toBe("signed_out");
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // 60 seconds early, so no token expires between the check and the server.
  it("renews a token that is about to expire", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a", expiresInSeconds: 30 });
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.discardUser).not.toHaveBeenCalled();
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

  // renew() answers null for no refresh token and for a refused one
  // (oidc.test.ts pins which). The API is never called.
  it("answers 401 signed_out on a renewal that finds no session, and keeps the last-known subject", async () => {
    const { token, oidc, ApiError } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a", expiresInSeconds: -60 });
    token.rememberSubject("oid-a");
    vi.mocked(oidc.renew).mockResolvedValue(null);
    const lapsed = vi.fn();
    token.onLapse(lapsed);

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect((error as InstanceType<typeof ApiError>).code).toBe("signed_out");
    expect(token.lastKnownSubject()).toBe("oid-a");
    expect(token.sessionLapsed()).toBe(true);
    expect(lapsed).toHaveBeenCalledTimes(1);
  });

  // U111 B: only the redirect callback changes the last-known subject, so a
  // stored user it never recorded is dropped at renewal, not adopted.
  it("drops a renewal that returns another subject, and keeps the last-known one", async () => {
    const { token, oidc, ApiError } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a", expiresInSeconds: -60 });
    vi.mocked(oidc.renew).mockResolvedValue({ ...RENEWED, subject: "oid-b" });

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(401);
    expect((error as InstanceType<typeof ApiError>).code).toBe("signed_out");
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).toHaveBeenCalledWith("at-2");
    expect(token.lastKnownSubject()).toBe("oid-a");
  });

  // Another tab's sign-out clears the subject while this tab's renewal is in
  // flight; the renewal must not write it back (U111 B).
  it("drops a renewal that settles after the last-known subject was cleared", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a", expiresInSeconds: -60 });
    vi.mocked(oidc.renew).mockImplementation(() => {
      window.localStorage.removeItem(SUBJECT_KEY);
      return Promise.resolve(RENEWED);
    });

    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).toHaveBeenCalledWith("at-2");
    expect(token.lastKnownSubject()).toBeNull();
  });

  // Discarding is best effort; the call is refused whether or not the
  // library could remove its stored user.
  it("refuses the renewal even when the stored user cannot be discarded", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a", expiresInSeconds: -60 });
    vi.mocked(oidc.renew).mockResolvedValue({ ...RENEWED, subject: "oid-b" });
    vi.mocked(oidc.discardUser).mockRejectedValueOnce(new Error("storage"));

    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(token.lastKnownSubject()).toBe("oid-a");
  });

  // Another tab's sign-in stores a user this tab reads. This tab's calls then
  // succeed, so its line must stop saying the sign-in has run out.
  it("ends the lapse, and says so, once a usable token is back", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(null);
    const changed = vi.fn();
    token.onLapse(changed);
    await expect(token.credential()).rejects.toMatchObject({ status: 401 });
    expect(token.sessionLapsed()).toBe(true);

    plantSession({ accessToken: "at-1", subject: "oid-a" });
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

  // U199: a renewal past its bound is abandoned, so the next call starts a
  // new one, and a timeout is no signal, never a lapse (TYRE-471 spec,
  // Renewal).
  it("answers as offline once the bound passes, and the next call starts a new renewal", async () => {
    const { token, oidc, ApiError } = await fresh();
    vi.mocked(oidc.renew)
      .mockReturnValueOnce(new Promise<never>(() => undefined))
      .mockResolvedValueOnce(RENEWED);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const first = token.credential().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
    const error = await first;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(token.sessionLapsed()).toBe(false);

    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
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

  // Another tab's sign-out removes the stored user; this tab must not keep
  // answering with the old identity.
  it("renews, and so signs out, when another tab's sign-out removed the stored user", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    vi.mocked(oidc.renew).mockResolvedValue(null);
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-1" });

    window.localStorage.removeItem(LIBRARY_USER_KEY);
    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });

  // A private window can refuse every storage access. The store still loads,
  // and with no session it answers signed out.
  it("loads, and answers signed out, when storage refuses every access", async () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    }
    const { token, oidc } = await fresh();

    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  it("answers 503 auth_unavailable, without renewing, when the build carries no VITE_AUTH_* values", async () => {
    vi.unstubAllEnvs();
    const { token, oidc, ApiError } = await fresh();

    const error = await token.credential().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).code).toBe("auth_unavailable");
    expect(oidc.renew).not.toHaveBeenCalled();
  });
});

describe("refused", () => {
  beforeEach(() => {
    bearerSession();
    rememberSubject("oid-a");
  });

  // A wrong AUTH_AUDIENCE, AUTH_CLIENT_ID or scope refuses every valid
  // token; renewing again cannot help (TYRE-471 spec, A fresh token refused).
  it("latches on a 401 for a token this page renewed seconds ago, and then refuses every call with 503", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-2" });

    expect(token.refused("at-2")).toBe(true);
    await expect(token.credential()).rejects.toMatchObject({
      status: 503,
      code: "auth_unavailable",
    });
    expect(token.refused("at-2")).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });

  it("keeps answering true once latched, even for another token", async () => {
    const { token } = await fresh();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    token.recordObtained("at-1");

    expect(token.refused("at-1")).toBe(true);
    expect(token.refused("at-9")).toBe(true);
  });

  // The obtained time is device-clock time, so a clock corrected backwards
  // leaves it in the future, which is not "earlier".
  it("does not latch on a token whose obtained time is ahead of the clock", async () => {
    const { token } = await fresh();
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    token.recordObtained("at-1");
    vi.setSystemTime(now - 2 * 3_600_000);

    expect(token.refused("at-1")).toBe(false);
    expect(token.isLatched()).toBe(false);
  });

  it("does not latch on a token obtained more than 60 seconds earlier, and renews it on the next call", async () => {
    const { token, oidc } = await fresh();
    vi.mocked(oidc.renew)
      .mockResolvedValueOnce(RENEWED)
      .mockResolvedValueOnce({ ...RENEWED, accessToken: "at-3" });
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-2" });
    plantSession({ accessToken: "at-2", subject: "oid-a" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);

    expect(token.refused("at-2")).toBe(false);
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-3" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
  });

  // The refresh token still renews, so the library keeps its user (TYRE-471
  // spec, Sending).
  it("renews after a 401 on an unexpired token that is not fresh, and the library keeps its user", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    expect(token.refused("at-1")).toBe(false);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).not.toBeNull();
  });

  // A slow 401 for at-1 can land after a renewal to at-2.
  it("leaves a since-renewed token alone on a slow 401 for an older one", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-2", subject: "oid-a" });

    expect(token.refused("at-1")).toBe(false);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // A reload forgets the mark, so the renewal starts at once, not on a
  // further call (TYRE-471 spec, Sending).
  it("starts the store's one renewal at once on a 401 for the stored user's token", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    // As the library does: the renewed user is stored before renew() returns.
    vi.mocked(oidc.renew).mockImplementation(() => {
      plantSession({ accessToken: "at-2", subject: "oid-a" });
      return Promise.resolve(RENEWED);
    });

    expect(token.refused("at-1")).toBe(false);

    await vi.waitFor(() => expect(oidc.renew).toHaveBeenCalledTimes(1));
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the stored user holds a since-renewed token",
      () => plantSession({ accessToken: "at-2", subject: "oid-a" }),
    ],
    [
      "no driver has signed in",
      () => {
        window.localStorage.removeItem(SUBJECT_KEY);
        plantSession({ accessToken: "at-1", subject: "oid-a" });
      },
    ],
    [
      "the stored user is another driver's",
      () => plantSession({ accessToken: "at-1", subject: "oid-b" }),
    ],
    ["nothing is stored", () => undefined],
  ])("starts no renewal on a 401 when %s", async (_, state) => {
    const { token, oidc } = await fresh();
    state();
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    expect(token.refused("at-1")).toBe(false);

    await afterTheRead();
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // A sign-out's local clear lands before the stored user is read.
  it("starts no renewal on a 401 once a sign-out has cleared the session", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    vi.mocked(oidc.renew).mockResolvedValue(RENEWED);

    expect(token.refused("at-1")).toBe(false);
    token.clearSession();

    await afterTheRead();
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  // No caller waits on it, so its failure is the next call's to meet.
  it("lets a renewal it starts fail without a caller seeing it, and the next call renews again", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    // A counter, not a queue of once-answers, which a red run would leave
    // for the next test.
    let calls = 0;
    vi.mocked(oidc.renew).mockImplementation(() =>
      ++calls === 1 ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(RENEWED),
    );
    const lapsed = vi.fn();
    token.onLapse(lapsed);

    expect(token.refused("at-1")).toBe(false);
    await vi.waitFor(() => expect(oidc.renew).toHaveBeenCalledTimes(1));
    await afterTheRead();

    expect(token.sessionLapsed()).toBe(false);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
    expect(lapsed).not.toHaveBeenCalled();
  });

  // U199 holds for it: a caller joins it, its bound abandons it as no
  // signal, and the next call starts a new one (TYRE-471 spec, Sending).
  it("makes a renewal it starts the store's one renewal, abandoned at its bound", async () => {
    const { token, oidc, ApiError } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    let calls = 0;
    vi.mocked(oidc.renew).mockImplementation(() =>
      ++calls === 1 ? new Promise<never>(() => undefined) : Promise.resolve(RENEWED),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    expect(token.refused("at-1")).toBe(false);
    const joined = token.credential().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
    const error = await joined;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(oidc.renew).toHaveBeenCalledTimes(1);

    await expect(token.credential()).resolves.toEqual({ accessToken: "at-2", subject: "oid-a" });
    expect(oidc.renew).toHaveBeenCalledTimes(2);
  });

  it("leaves the lapse to the next call when a renewal it starts finds no session", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    vi.mocked(oidc.renew).mockResolvedValue(null);
    const lapsed = vi.fn();
    token.onLapse(lapsed);

    expect(token.refused("at-1")).toBe(false);
    await vi.waitFor(() => expect(oidc.renew).toHaveBeenCalledTimes(1));
    await afterTheRead();

    expect(token.sessionLapsed()).toBe(false);
    expect(lapsed).not.toHaveBeenCalled();
  });

  // The e2e stub issues one access-token string per subject on every renewal
  // (e2e/idp.ts).
  it("renews a refused token once, even when the provider issues the same string again", async () => {
    const { token, oidc } = await fresh();
    plantSession({ accessToken: "at-1", subject: "oid-a" });
    vi.mocked(oidc.renew).mockResolvedValue({ ...RENEWED, accessToken: "at-1" });

    expect(token.refused("at-1")).toBe(false);
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-1" });
    await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-1" });
    expect(oidc.renew).toHaveBeenCalledTimes(1);
  });
});

describe("sender and stampSubject under the DEV header path", () => {
  it("stand the dev actor in and never renew", async () => {
    const { token, oidc } = await fresh();
    window.localStorage.setItem("tyre.dev.user-id", "dev-actor");

    await expect(token.sender()).resolves.toEqual({ accessToken: null, subject: "dev-actor" });
    expect(token.stampSubject()).toBe("dev-actor");
    expect(oidc.renew).not.toHaveBeenCalled();
  });

  it("stamp from the last-known subject on the bearer path", async () => {
    bearerSession();
    const { token } = await fresh();
    token.rememberSubject("oid-a");
    expect(token.stampSubject()).toBe("oid-a");
  });
});
