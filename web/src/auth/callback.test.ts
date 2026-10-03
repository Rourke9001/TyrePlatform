import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bearerSession } from "../test/bearerSession";

// The factory runs when the chunk is first imported, so a count of zero
// shows the entry never reached for it.
const chunk = vi.hoisted(() => ({ loads: 0 }));

vi.mock("./oidc", () => {
  chunk.loads += 1;
  return {
    completeSignIn: vi.fn(),
    signOut: vi.fn(),
    renew: vi.fn(),
    signIn: vi.fn(),
    discardUser: vi.fn(() => Promise.resolve()),
  };
});

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
  it("does nothing, and loads no chunk, on a URL that is not a callback", async () => {
    window.history.replaceState(null, "", "/my");
    vi.resetModules();
    chunk.loads = 0;
    const callback = await import("./callback");
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(chunk.loads).toBe(0);
  });

  it("does nothing under the DEV header path, even on a callback URL", async () => {
    window.localStorage.removeItem("tyre.dev.auth");
    const { callback, oidc } = await fresh();
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(oidc.completeSignIn).not.toHaveBeenCalled();
  });

  it("writes the mirror and the subject, goes to the stored path, and flushes under the new token", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    await holdEntryStampedFor(outbox, draft, "oid-a");

    await expect(callback.completeRedirect()).resolves.toBe("signed-in");
    expect(callback.signInDidNotFinish()).toBe(false);

    const mirror = token.readMirror();
    expect(mirror?.subject).toBe("oid-a");
    expect(Date.now() - (mirror?.obtainedAt ?? 0)).toBeLessThan(5_000);
    expect(token.lastKnownSubject()).toBe("oid-a");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/capture/v1");
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer at-a");
  });

  // U104: the compare comes first, and nothing calls the API as the new
  // subject before it.
  it("undoes a sign-in by anyone else while another driver's work is held, before any API call", async () => {
    const { callback, oidc, token, outbox, draft } = await fresh();
    await holdEntryStampedFor(outbox, draft, "oid-b");
    token.rememberSubject("oid-b");
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);

    await expect(callback.completeRedirect()).resolves.toBe("undone");
    expect(callback.signInDidNotFinish()).toBe(false);

    expect(oidc.signOut).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(token.readMirror()).toBeNull();
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
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
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
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
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
    const { callback, oidc, token } = await fresh();
    vi.mocked(oidc.completeSignIn).mockRejectedValue(new Error("access_denied"));

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(window.location.search).toBe("");
    expect(token.readMirror()).toBeNull();
  });

  it("does not replay once the query is gone", async () => {
    const { callback, oidc } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    await callback.completeRedirect();
    await expect(callback.completeRedirect()).resolves.toBe("none");
    expect(oidc.completeSignIn).toHaveBeenCalledTimes(1);
  });

  // The library stored its user before the write failed; left there, the
  // next load would renew it and never show the sign-in screen (spec
  // section 6).
  it("reports a sign-in whose mirror cannot be written as not finished, and removes the library's user", async () => {
    const { callback, oidc, token } = await fresh();
    vi.mocked(oidc.completeSignIn).mockResolvedValue(SIGNED_IN);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    await expect(callback.completeRedirect()).resolves.toBe("failed");
    expect(callback.signInDidNotFinish()).toBe(true);
    expect(oidc.discardUser).toHaveBeenCalledTimes(1);
    expect(token.readMirror()).toBeNull();
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
    expect(token.readMirror()).toBeNull();
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
