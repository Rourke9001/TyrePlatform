import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SUBJECT_KEY } from "./token";
import { bearerSession } from "../test/bearerSession";
import { plantSession, storedAccessToken } from "../test/librarySession";

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
