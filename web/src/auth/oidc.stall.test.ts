import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { INavigator } from "oidc-client-ts";

import { REQUEST_TIMEOUT_SECONDS } from "../api/deadline";
import { LIBRARY_USER_KEY, plantSession } from "../test/librarySession";
import { createAuth } from "./oidc";

// No metadata, so the library fetches discovery, the request these bound.
const IDP = "https://idp.test";
const SETTINGS = {
  authority: `${IDP}/`,
  clientId: "pwa",
  apiScope: "api://tyre-api/access_as_user",
  origin: "http://localhost:5173",
};
const DISCOVERY_URL = `${IDP}/.well-known/openid-configuration`;
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

// Discovery waits until the test answers it.
function discoveryHeld(): () => void {
  let answer = () => undefined as void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = () =>
            resolve(
              new Response(JSON.stringify(DISCOVERY), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            );
        }),
    ),
  );
  return () => answer();
}

// The library's stored user, as a sign-in leaves it: its ID token names the
// driver, and its refresh token can renew the session.
function storeUser(expiresInSeconds: number) {
  plantSession({
    accessToken: "at",
    subject: "oid-a",
    expiresInSeconds,
    refreshToken: "rt",
    idToken: "id-token-naming-the-driver",
  });
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
// discovery must still end the wait, and leave no stored user behind: its
// refresh token and the ID token naming the driver (spec section 6).
it("signOut rejects once the bound passes, after clearing the local session", async () => {
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
  storeUser(3600);
  discoveryBodyStalls();

  const result = await afterTheBound(createAuth(SETTINGS, navigator).signOut());

  expect(result).toBeInstanceOf(Error);
  expect(navigated).toEqual([]);
  expect(window.localStorage.getItem("tyre.auth.subject")).toBeNull();
  expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
});

// Offline on a fresh page, which has not fetched discovery yet.
it("signOut removes the stored user when discovery cannot be fetched at all", async () => {
  window.localStorage.setItem("tyre.auth.subject", "oid-a");
  storeUser(3600);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );

  await expect(createAuth(SETTINGS, navigator).signOut()).rejects.toBeInstanceOf(Error);

  expect(navigated).toEqual([]);
  expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
});

// A fresh page's first renewal fetches discovery before the refresh POST,
// and the store keeps a renewal in flight until it settles (token.ts), so a
// discovery that never settles would hold every later send.
it("renew rejects once the bound passes on a stalled discovery, before any token is sent", async () => {
  storeUser(-60);
  discoveryBodyStalls();

  const result = await afterTheBound(createAuth(SETTINGS, navigator).renew());

  expect(result).toBeInstanceOf(Error);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(DISCOVERY_URL, expect.anything());
  // Still there: a discovery that fails says nothing about the session.
  expect(window.localStorage.getItem(LIBRARY_USER_KEY)).not.toBeNull();
});

// Another tab's sign-out removes the shared stored user while this tab's
// renewal waits on discovery. signinSilent reads the user itself, and with no
// refresh token it would try a hidden iframe on "/" (spec section 4, The
// auth chunk).
it("renew answers null, with no iframe, when the stored user goes during discovery", async () => {
  storeUser(-60);
  const answer = discoveryHeld();

  const renewing = createAuth(SETTINGS, navigator).renew();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  window.localStorage.removeItem(LIBRARY_USER_KEY);
  answer();

  expect(await afterTheBound(renewing)).toBe("resolved");
  await expect(renewing).resolves.toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
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
