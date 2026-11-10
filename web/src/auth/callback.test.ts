import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bearerSession } from "../test/bearerSession";
import { plantSession } from "../test/librarySession";

vi.mock("./oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oidc")>()),
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
  renew: vi.fn(),
  signIn: vi.fn(),
  discardUser: vi.fn(() => Promise.resolve()),
}));

const SIGNED_IN = {
  accessToken: "at-a",
  expiresAt: Date.now() + 3_600_000,
  subject: "oid-a",
  returnTo: "/capture/v1",
};

// The library stores the user before the exchange returns.
function signsIn(oidc: typeof import("./oidc")) {
  vi.mocked(oidc.completeSignIn).mockImplementation(() => {
    plantSession({ accessToken: "at-a", subject: "oid-a" });
    return Promise.resolve(SIGNED_IN);
  });
}

async function fresh() {
  vi.resetModules();
  const callback = await import("./callback");
  const oidc = await import("./oidc");
  const token = await import("../api/token");
  const draft = await import("../capture/draft");
  const outbox = await import("../capture/outbox");
  await draft.db.open();
  await draft.clearDraft();
  await draft.db.table("outbox").clear();
  return { callback, oidc, token, draft, outbox };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  bearerSession();
  window.history.replaceState(null, "", "/?code=c1&state=s1");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 201 })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function holdEntryStampedFor(
  outbox: typeof import("../capture/outbox"),
  draft: typeof import("../capture/draft"),
  subject: string,
) {
  await draft.startDraft({
    driverSubject: subject,
    vehicleId: "v1",
    taskId: null,
    startedAt: "2026-09-30T06:00:00Z",
  });
  await draft.savePosition({
    positionId: "p1",
    vehicleId: "v1",
    tyreId: null,
    treads: [9, 9, 9],
    pressureKpa: 800,
    pressureTemperature: "COLD",
    damageFlag: false,
    note: null,
    seconds: 5,
    warnings: [],
  });
  const entry = await outbox.queueDraft({
    granularityMm: 1,
    deviceId: "d",
    appVersion: "0",
    totalPositions: 1,
    submittedAt: "2026-09-30T06:05:00Z",
  });
  await draft.db
    .table("outbox")
    .update(entry.clientUuid, { lastStatus: 401, nextAttemptAt: Date.now() + 600_000 });
  return entry;
}

describe("completeRedirect", () => {
  // One company's brand must not paint for the next driver (TYRE-471 spec,
  // The redirect callback).
  it("removes the branding tenant key at sign-in", async () => {
    const { callback, oidc, token } = await fresh();
    window.localStorage.setItem(token.TENANT_KEY, "t-old");
    signsIn(oidc);

    await expect(callback.completeRedirect()).resolves.toBe("signed-in");
    expect(window.localStorage.getItem(token.TENANT_KEY)).toBeNull();
  });

  it("reports a sign-in whose tenant key cannot be removed as not finished, and removes its user", async () => {
    const { callback, oidc, token } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    const store = window.localStorage;
    const real = store.removeItem.bind(store);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key: string) => {
      if (key === token.TENANT_KEY) throw new DOMException("blocked", "SecurityError");
      real(key);
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(oidc.discardUser).toHaveBeenCalledWith("at-a");
    expect(token.lastKnownSubject()).toBeNull();
  });

  it("does nothing on a URL that is not a callback", async () => {
    window.history.replaceState(null, "", "/my");
    const { callback, oidc, outbox } = await fresh();
    const stamps = vi.spyOn(outbox, "heldStamps");
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(oidc.completeSignIn).not.toHaveBeenCalled();
    expect(stamps).not.toHaveBeenCalled();
  });

  // Blocked storage makes the library throw before it returns a promise. That
  // is a sign-in that did not finish, and the spent code still leaves the URL.
  it("reports a sign-in whose exchange throws at once as not finished, and clears the URL", async () => {
    const { callback, oidc } = await fresh();
    vi.mocked(oidc.completeSignIn).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(window.location.search).toBe("");
  });

  it("does nothing under the DEV header path, even on a callback URL", async () => {
    window.localStorage.removeItem("tyre.dev.auth");
    const { callback, oidc, outbox } = await fresh();
    const stamps = vi.spyOn(outbox, "heldStamps");
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(oidc.completeSignIn).not.toHaveBeenCalled();
    expect(stamps).not.toHaveBeenCalled();
  });

  // A renewal in another tab that settles between the library storing the
  // user and the subject write finds an oid that is not the subject, and
  // removes the user. So the stamps are read before the exchange, and
  // nothing after it is awaited (TYRE-471 spec, The redirect callback).
  it("reads the held stamps before the exchange, and awaits nothing from the library's store to the subject write", async () => {
    const { callback, oidc, token, outbox } = await fresh();
    const order: string[] = [];
    // Resolved on a macrotask, so a read placed after the exchange lets the
    // probe below fire before the subject is written.
    vi.spyOn(outbox, "heldStamps").mockImplementation(() => {
      order.push("stamps");
      return new Promise((resolve) => setTimeout(() => resolve([]), 0));
    });
    let seen: string | null | undefined;
    vi.mocked(oidc.completeSignIn).mockImplementation(() => {
      order.push("exchange");
      plantSession({ accessToken: "at-a", subject: "oid-a" });
      // The earliest another tab's renewal could settle: the next macrotask.
      setTimeout(() => {
        seen = token.lastKnownSubject();
      }, 0);
      return Promise.resolve(SIGNED_IN);
    });

    await expect(callback.completeRedirect()).resolves.toBe("signed-in");
    expect(order).toEqual(["stamps", "exchange"]);
    await vi.waitFor(() => expect(seen).not.toBeUndefined());
    expect(seen).toBe("oid-a");
  });

  it("writes the subject, records the token as fresh, goes to the stored path, and flushes under the new token", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    signsIn(oidc);
    await holdEntryStampedFor(outbox, draft, "oid-a");

    await expect(callback.completeRedirect()).resolves.toBe("signed-in");
    expect(callback.signInDidNotFinish()).toBe(false);

    expect(token.lastKnownSubject()).toBe("oid-a");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/capture/v1");
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at-a");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(token.refused("at-a")).toBe(true);
  });

  // U104: the compare comes first, and nothing calls the API as the new
  // subject before it.
  it("undoes a sign-in by anyone else while another driver's work is held, before any API call", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    await holdEntryStampedFor(outbox, draft, "oid-b");
    token.rememberSubject("oid-b");
    signsIn(oidc);

    await expect(callback.completeRedirect()).resolves.toBe("undone");
    expect(callback.signInDidNotFinish()).toBe(false);

    expect(oidc.signOut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    // The real signOut clears the key; the mock does not, so this reads
    // "not oid-a" rather than a value.
    expect(token.lastKnownSubject()).not.toBe("oid-a");
    expect(window.sessionStorage.getItem("tyre.auth.other-driver")).toBe("1");
    expect(await outbox.listOutbox()).toHaveLength(1);
  });

  it("writes the marker before signOut, and treats a rejected signOut as signed out", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    await holdEntryStampedFor(outbox, draft, "oid-b");
    token.rememberSubject("oid-b");
    signsIn(oidc);
    let markerAtSignOut: string | null = null;
    vi.mocked(oidc.signOut).mockImplementation(() => {
      markerAtSignOut = window.sessionStorage.getItem("tyre.auth.other-driver");
      return Promise.reject(new Error("end-session metadata unavailable"));
    });

    await expect(callback.completeRedirect()).resolves.toBe("undone");
    expect(markerAtSignOut).toBe("1");
  });

  it("reads a failed stamp read as nothing held, so the sign-in proceeds, and the send guard still holds (TYRE-317, spec section 4)", async () => {
    const { callback, oidc, token, draft, outbox } = await fresh();
    await holdEntryStampedFor(outbox, draft, "oid-b");
    signsIn(oidc);
    vi.spyOn(draft.db.drafts, "get").mockRejectedValue(new Error("storage unavailable"));
    const held = vi.spyOn(draft.db.table("outbox"), "toArray");
    held.mockRejectedValueOnce(new Error("storage unavailable"));
    const flush = vi.spyOn(outbox, "flushOutbox");

    await expect(callback.completeRedirect()).resolves.toBe("signed-in");
    expect(oidc.signOut).not.toHaveBeenCalled();
    expect(token.lastKnownSubject()).toBe("oid-a");
    // The flush runs under oid-a; the entry is oid-b's, so nothing is sent.
    // Awaited to its end, so the absence below is not a race.
    expect(flush).toHaveBeenCalledTimes(1);
    await flush.mock.results[0]?.value;
    expect(held).toHaveBeenCalledTimes(2);
    expect(await outbox.listOutbox()).toMatchObject([{ state: "queued", lastStatus: 401 }]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("reports an error return as not finished, and removes the query", async () => {
    window.history.replaceState(null, "", "/?error=access_denied&state=s1");
    const { callback, oidc } = await fresh();
    vi.mocked(oidc.completeSignIn).mockRejectedValue(new Error("access_denied"));

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(window.location.search).toBe("");
  });

  // The stamps are read before the exchange, and a failed exchange has no
  // newcomer to compare them with.
  it("reports a failed exchange as not finished, and signs no one out, while another driver's work is held", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    await holdEntryStampedFor(outbox, draft, "oid-b");
    token.rememberSubject("oid-b");
    vi.mocked(oidc.completeSignIn).mockRejectedValue(new Error("invalid_grant"));

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(oidc.signOut).not.toHaveBeenCalled();
    expect(token.lastKnownSubject()).toBe("oid-b");
    expect(window.sessionStorage.getItem("tyre.auth.other-driver")).toBeNull();
  });

  it("does not replay once the query is gone", async () => {
    const { callback, oidc } = await fresh();
    signsIn(oidc);
    await callback.completeRedirect();
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(oidc.completeSignIn).toHaveBeenCalledTimes(1);
  });

  // The library stored its user before the write failed; left there, the
  // next load would renew it and never show the sign-in screen (spec
  // section 6).
  it("reports a sign-in whose writes storage refuses as not finished, and removes the library's user", async () => {
    const { callback, oidc } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).toHaveBeenCalledWith("at-a");
  });

  it("still reports failed when the library's user cannot be removed", async () => {
    const { callback, oidc } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    vi.mocked(oidc.discardUser).mockImplementation(() => {
      throw new Error("chunk unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
  });

  it("fails the same way when only the last-known subject cannot be written", async () => {
    const { callback, oidc, token } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    const store = window.localStorage;
    const real = store.setItem.bind(store);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      if (key === token.SUBJECT_KEY) throw new DOMException("full", "QuotaExceededError");
      real(key, value);
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(oidc.discardUser).toHaveBeenCalledWith("at-a");
  });
});

describe("safeReturnPath", () => {
  it("follows a same-origin path and nothing else", async () => {
    const { callback } = await fresh();
    expect(callback.safeReturnPath("/capture/v1?taskId=t1")).toBe("/capture/v1?taskId=t1");
    expect(callback.safeReturnPath("https://evil.test/x")).toBe("/");
    expect(callback.safeReturnPath("//evil.test/x")).toBe("/");
    // new URL() collapses these to a path that starts with two slashes.
    expect(callback.safeReturnPath("/..//evil.test")).toBe("/");
    expect(callback.safeReturnPath("/.//evil.test")).toBe("/");
    expect(callback.safeReturnPath("/%2e%2e//evil.test")).toBe("/");
    expect(callback.safeReturnPath("javascript:alert(1)")).toBe("/");
    expect(callback.safeReturnPath("/\\evil.test")).toBe("/");
    expect(callback.safeReturnPath(undefined)).toBe("/");
    expect(callback.safeReturnPath(42)).toBe("/");
  });
});
