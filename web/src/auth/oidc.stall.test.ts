import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { INavigator } from "oidc-client-ts";

import { REQUEST_TIMEOUT_SECONDS } from "../api/deadline";
import { createAuth } from "./oidc";

// No metadata, so the library fetches discovery, the request these bound.
const IDP = "https://idp.test";
const SETTINGS = {
  authority: `${IDP}/`,
  clientId: "pwa",
  apiScope: "api://tyre-api/access_as_user",
  origin: "http://localhost:5173",
};
const DISCOVERY = {
  issuer: `${IDP}/`,
  authorization_endpoint: `${IDP}/authorize`,
  token_endpoint: `${IDP}/token`,
  end_session_endpoint: `${IDP}/logout`,
};

const navigated: string[] = [];
let navigation: Promise<unknown> = Promise.resolve();
const navigator = {
  prepare: () =>
    Promise.resolve({
      navigate: (p: { url: string }) => {
        navigated.push(p.url);
        return navigation;
      },
      close: () => undefined,
    }),
  callback: () => Promise.resolve(),
} as unknown as INavigator;

// Discovery's headers arrive and its body never does: the library's own
// timeout ends at the headers (docs/lessons.md, 2026-10-02).
function discoveryBodyStalls() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        // A stream with no source never closes.
        new Response(new ReadableStream(), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

function discoveryAnswers() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

const PENDING = "pending" as const;

async function afterTheBound(work: Promise<unknown>): Promise<unknown> {
  const settled = work.then(
    () => "resolved",
    (e: unknown) => e,
  );
  await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
  return Promise.race([settled, Promise.resolve(PENDING)]);
}

beforeEach(() => {
  navigated.length = 0;
  navigation = Promise.resolve();
  window.localStorage.clear();
  // Only the timers the bounds use: nothing here touches IndexedDB.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// TYRE-381 stage 5: a fresh page fetches discovery before the redirect, so a
// stalled body held "Opening sign-in…" with every later tap ignored.
it("signIn rejects once the bound passes on a discovery body that never arrives", async () => {
  discoveryBodyStalls();

  const result = await afterTheBound(createAuth(SETTINGS, navigator).signIn("/"));

  expect(result).toBeInstanceOf(Error);
  expect(navigated).toEqual([]);
});

// The local clear comes first (spec section 4, Signing out), so a stalled
// discovery must still end the wait.
it("signOut rejects once the bound passes, after clearing the local session", async () => {
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
  discoveryBodyStalls();

  const result = await afterTheBound(createAuth(SETTINGS, navigator).signOut());

  expect(result).toBeInstanceOf(Error);
  expect(navigated).toEqual([]);
  expect(window.localStorage.getItem("tyre.auth.subject")).toBeNull();
});

// The redirect resolves only when the page comes back (pageshow), so it is
// never bounded: a slow but working redirect must not read as a failure, or a
// second tap would start a second one.
it("does not bound the redirect itself once discovery has answered", async () => {
  discoveryAnswers();
  navigation = new Promise(() => undefined);

  const signingIn = createAuth(SETTINGS, navigator).signIn("/");
  // PKCE's digest settles on the real clock, after discovery.
  await vi.waitFor(() => expect(navigated).toHaveLength(1));

  expect(await afterTheBound(signingIn)).toBe(PENDING);
});
