import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REQUEST_TIMEOUT_SECONDS } from "./deadline";
import { SUBJECT_KEY } from "./token";
import { bearerSession } from "../test/bearerSession";
import { LIBRARY_USER_KEY, plantSession, storedAccessToken } from "../test/librarySession";

// The token store over the real oidc.ts and the real library, with only the
// identity provider stubbed, so what is stored after a late settle is the
// library's own write (TYRE-471 spec, Tests).
//
// renew and discardUser pass through to the real ones, so a test can await a
// late settle's own promise instead of counting ticks (docs/lessons.md,
// 2026-08-26). vi.resetModules() does not run a mock factory again, so this
// oidc.ts instance and its singleton last for the file; token.ts is fresh
// per test.
vi.mock("../auth/oidc", async (importOriginal) => {
  const real = await importOriginal<typeof import("../auth/oidc")>();
  return { ...real, renew: vi.fn(real.renew), discardUser: vi.fn(real.discardUser) };
});

const IDP = "https://idp.test";
const DISCOVERY_URL = `${IDP}/.well-known/openid-configuration`;
const TOKEN_URL = `${IDP}/token`;
const DISCOVERY = {
  issuer: `${IDP}/`,
  authorization_endpoint: `${IDP}/authorize`,
  token_endpoint: TOKEN_URL,
  end_session_endpoint: `${IDP}/logout`,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A token response with no ID token, so the library keeps the stored
// profile and its oid.
function tokens(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
  };
}

// Headers now, the body only when the test finishes it. The library's own
// timeout ends at the headers (docs/lessons.md, 2026-10-02).
function stalled(status: number) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return {
    response,
    finish(body: unknown) {
      controller?.enqueue(new TextEncoder().encode(JSON.stringify(body)));
      controller?.close();
    },
  };
}

// Discovery always answers. Each refresh POST takes the next queued answer
// and records the refresh token it carried.
function identityProvider(...answers: Response[]) {
  const sent: string[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === DISCOVERY_URL) return Promise.resolve(json(200, DISCOVERY));
    if (url === TOKEN_URL) {
      sent.push(new URLSearchParams(init?.body as URLSearchParams).get("refresh_token") ?? "");
      const next = answers.shift();
      return next ? Promise.resolve(next) : Promise.reject(new TypeError("no answer queued"));
    }
    return Promise.reject(new TypeError(`unexpected request ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

// R1's own renew(), which holds a refusal's conditional removal, so once it
// has settled a late refusal has done all it will.
async function r1Settled(oidc: typeof import("../auth/oidc")): Promise<void> {
  const r1 = vi.mocked(oidc.renew).mock.results[0]?.value as Promise<unknown> | undefined;
  await r1?.catch(() => undefined);
}

// The removal sameDriver makes when a late success is for a subject that is
// not the last-known one.
async function lateRemoval(
  oidc: typeof import("../auth/oidc"),
  accessToken: string,
): Promise<void> {
  await vi.waitFor(() => expect(oidc.discardUser).toHaveBeenCalledWith(accessToken));
  await (vi.mocked(oidc.discardUser).mock.results[0]?.value as Promise<void> | undefined);
}

// The latch, the lock and the two remembered tokens are token.ts's module
// state.
async function fresh() {
  vi.resetModules();
  const token = await import("./token");
  const oidc = await import("../auth/oidc");
  const { ApiError } = await import("./apiError");
  return { token, oidc, ApiError };
}

beforeEach(() => {
  // mock.results[0] is then this test's first renewal.
  vi.clearAllMocks();
  window.localStorage.clear();
  bearerSession();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// TYRE-471 spec, Goals: a live token never waits on the network.
it("answers a live stored token with no request", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  plantSession({ accessToken: "at-1", subject: "oid-a" });
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  const { token } = await fresh();

  await expect(token.credential()).resolves.toEqual({ accessToken: "at-1", subject: "oid-a" });
  expect(fetchSpy).not.toHaveBeenCalled();
});

// U104, U111 B: a session that never passed the compare serves no call. Its
// renewal removes it, because the subject still differs when it settles
// (TYRE-471 spec, Which stored user serves a call).
it("never uses a stored user whose oid is not the last-known subject, and its renewal removes it", async () => {
  plantSession({ accessToken: "at-b", subject: "oid-b", refreshToken: "rt-b" });
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  const idp = identityProvider(json(200, tokens("at-b2", "rt-b2")));
  const { token } = await fresh();

  await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
  expect(idp.sent).toEqual(["rt-b"]);
  expect(storedAccessToken()).toBeNull();
});

// The library stores a sign-in's user before the callback writes the
// subject, so nothing removes it at read time (TYRE-471 spec, Which stored
// user serves a call).
it("keeps that user when a sign-in writes its subject while the renewal is in flight", async () => {
  plantSession({ accessToken: "at-b", subject: "oid-b", refreshToken: "rt-b" });
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  const refresh = stalled(200);
  const idp = identityProvider(refresh.response);
  const { token } = await fresh();

  const call = token.credential();
  await vi.waitFor(() => expect(idp.sent).toEqual(["rt-b"]));
  window.localStorage.setItem(SUBJECT_KEY, "oid-b");
  refresh.finish(tokens("at-b2", "rt-b2"));

  await expect(call).resolves.toEqual({ accessToken: "at-b2", subject: "oid-b" });
  expect(storedAccessToken()).toBe("at-b2");
});

// A reload forgets the refused mark, and the gate's GET /api/me is not
// retried on a 401, so the refused token must leave the library before the
// page can reload (TYRE-471 spec, Sending).
it("replaces a token refused with 401 in the library at once, so a reload never sends it again", async () => {
  plantSession({ accessToken: "at-1", subject: "oid-a", refreshToken: "rt-1" });
  window.localStorage.setItem(SUBJECT_KEY, "oid-a");
  const idp = identityProvider(json(200, tokens("at-2", "rt-2")));
  const { token, oidc } = await fresh();

  expect(token.refused("at-1")).toBe(false);
  await vi.waitFor(() => expect(storedAccessToken()).toBe("at-2"));
  await r1Settled(oidc);

  const reloaded = await fresh();
  await expect(reloaded.token.credential()).resolves.toEqual({
    accessToken: "at-2",
    subject: "oid-a",
  });
  expect(idp.sent).toEqual(["rt-1"]);
});

describe("a renewal past its bound (U199)", () => {
  // Driver S's session, expired, so the first call renews it. The first
  // renewal, R1, has a body that stalls past the bound.
  beforeEach(() => {
    plantSession({
      accessToken: "at-s0",
      subject: "oid-s",
      expiresInSeconds: -60,
      refreshToken: "rt-s0",
    });
    window.localStorage.setItem(SUBJECT_KEY, "oid-s");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  async function abandoned(
    token: typeof import("./token"),
    ApiError: typeof import("./apiError").ApiError,
  ) {
    const first = token.credential().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
    const error = await first;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(token.sessionLapsed()).toBe(false);
  }

  it("rejects as no signal at the bound, and the next call starts a new renewal", async () => {
    const r1 = stalled(200);
    const idp = identityProvider(r1.response, json(200, tokens("at-r2", "rt-r2")));
    const { token, ApiError } = await fresh();

    await abandoned(token, ApiError);
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-r2", subject: "oid-s" });
    // Entra does not revoke a refresh token when it is redeemed.
    expect(idp.sent).toEqual(["rt-s0", "rt-s0"]);
  });

  // Owner, 10 Nov 2026: only a refusal lapses the session.
  it("never lapses the session or removes the stored user, however often it times out", async () => {
    const idp = identityProvider(
      stalled(200).response,
      stalled(200).response,
      stalled(200).response,
    );
    const { token, ApiError } = await fresh();

    for (let i = 0; i < 3; i++) {
      await abandoned(token, ApiError);
      expect(storedAccessToken()).toBe("at-s0");
    }
    expect(idp.sent).toHaveLength(3);
  });

  // TYRE-471 spec, The four late settles, row 1.
  it.each([
    ["succeeds", 200, tokens("at-r1", "rt-r1"), "at-r1"],
    ["is refused", 400, { error: "invalid_grant" }, "at-r2"],
  ])(
    "after a retry succeeded, R1 that %s late leaves S a live token",
    async (_, status, body, live) => {
      const r1 = stalled(status);
      const idp = identityProvider(r1.response, json(200, tokens("at-r2", "rt-r2")));
      const { token, oidc, ApiError } = await fresh();
      await abandoned(token, ApiError);
      await expect(token.credential()).resolves.toMatchObject({ accessToken: "at-r2" });

      r1.finish(body);
      // A late success changes the store; a late refusal must leave it alone.
      if (status === 200) await vi.waitFor(() => expect(storedAccessToken()).toBe("at-r1"));
      else await r1Settled(oidc);

      expect(storedAccessToken()).toBe(live);
      await expect(token.credential()).resolves.toEqual({ accessToken: live, subject: "oid-s" });
      expect(idp.sent).toHaveLength(2);
    },
  );

  // Rows 2 and 3: a sign-out finishes its local clear before any request
  // that can fail (TYRE-471 spec, Signing out), so these are its effects.
  // Another tab cannot clear this tab's memory, only the shared keys.
  it.each([
    ["this tab's sign-out", true, "succeeds", 200, tokens("at-r1", "rt-r1")],
    ["this tab's sign-out", true, "is refused", 400, { error: "invalid_grant" }],
    ["another tab's sign-out", false, "succeeds", 200, tokens("at-r1", "rt-r1")],
    ["another tab's sign-out", false, "is refused", 400, { error: "invalid_grant" }],
  ])(
    "after %s, R1 that %s late leaves the store empty and the page signed out",
    async (_, thisTab, __, status, body) => {
      const r1 = stalled(status);
      const idp = identityProvider(r1.response);
      const { token, oidc, ApiError } = await fresh();
      await abandoned(token, ApiError);
      if (thisTab) token.clearSession();
      else window.localStorage.removeItem(SUBJECT_KEY);
      window.localStorage.removeItem(LIBRARY_USER_KEY);

      r1.finish(body);
      // The store ends as it started, empty, so a late success is awaited
      // through its own removal, not through the store.
      if (status === 200) await lateRemoval(oidc, "at-r1");
      else await r1Settled(oidc);

      expect(storedAccessToken()).toBeNull();
      await expect(token.credential()).rejects.toMatchObject({
        status: 401,
        code: "signed_out",
      });
      expect(idp.sent).toHaveLength(1);
    },
  );

  // Row 4: driver B signs in in another tab while R1 runs on.
  it("after another driver's sign-in, R1 that succeeds late is removed, and B signs in again once", async () => {
    const r1 = stalled(200);
    identityProvider(r1.response);
    const { token, oidc, ApiError } = await fresh();
    await abandoned(token, ApiError);
    plantSession({ accessToken: "at-b", subject: "oid-b", refreshToken: "rt-b" });
    window.localStorage.setItem(SUBJECT_KEY, "oid-b");

    r1.finish(tokens("at-r1", "rt-r1"));
    await lateRemoval(oidc, "at-r1");

    expect(storedAccessToken()).toBeNull();
    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
  });

  it("after another driver's sign-in, R1 that is refused late leaves B's session alone", async () => {
    const r1 = stalled(400);
    const idp = identityProvider(r1.response);
    const { token, oidc, ApiError } = await fresh();
    await abandoned(token, ApiError);
    plantSession({ accessToken: "at-b", subject: "oid-b", refreshToken: "rt-b" });
    window.localStorage.setItem(SUBJECT_KEY, "oid-b");

    r1.finish({ error: "invalid_grant" });
    await r1Settled(oidc);

    expect(storedAccessToken()).toBe("at-b");
    await expect(token.credential()).resolves.toEqual({ accessToken: "at-b", subject: "oid-b" });
    expect(idp.sent).toHaveLength(1);
  });

  // The provider honoured that refresh token, so the session is a real one
  // (TYRE-471 spec, The four late settles).
  it("after the retry was refused, R1 that succeeds late brings S's session back", async () => {
    const r1 = stalled(200);
    identityProvider(r1.response, json(400, { error: "invalid_grant" }));
    const { token, ApiError } = await fresh();
    await abandoned(token, ApiError);
    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(storedAccessToken()).toBeNull();
    expect(token.sessionLapsed()).toBe(true);

    r1.finish(tokens("at-r1", "rt-r1"));
    await vi.waitFor(() => expect(storedAccessToken()).toBe("at-r1"));

    await expect(token.credential()).resolves.toEqual({ accessToken: "at-r1", subject: "oid-s" });
    expect(token.sessionLapsed()).toBe(false);
  });
});
