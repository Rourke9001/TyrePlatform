import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorResponse, UserManager, type INavigator, type NavigateParams } from "oidc-client-ts";

import { SUBJECT_KEY, TENANT_KEY, credential } from "../api/token";
import { bearerSession } from "../test/bearerSession";
import { LIBRARY_USER_KEY, plantSession, storedAccessToken } from "../test/librarySession";
import { createAuth } from "./oidc";

const ORIGIN = "http://localhost:5173";
const IDP = "https://idp.test";
const SCOPE = "api://tyre-api/access_as_user";
const SETTINGS = {
  authority: `${IDP}/`,
  clientId: "pwa",
  apiScope: SCOPE,
  origin: ORIGIN,
  // Supplied so no discovery request is made; the e2e project covers that.
  metadata: {
    issuer: `${IDP}/`,
    authorization_endpoint: `${IDP}/authorize`,
    token_endpoint: `${IDP}/token`,
    end_session_endpoint: `${IDP}/logout`,
  },
};

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function idToken(oid: string | null): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: `${IDP}/`,
    aud: "pwa",
    sub: "pairwise-1",
    iat: now,
    exp: now + 3600,
  };
  if (oid !== null) claims.oid = oid;
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

function tokenResponse(id: string): Response {
  return new Response(
    JSON.stringify({
      access_token: "at-new",
      id_token: id,
      refresh_token: "rt-new",
      token_type: "Bearer",
      expires_in: 3600,
      scope: `openid profile offline_access ${SCOPE}`,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function storeUser(fields: { id_token?: string; refresh_token?: string }): void {
  plantSession({
    accessToken: "at-old",
    subject: "oid-a",
    idToken: fields.id_token,
    refreshToken: fields.refresh_token ?? null,
  });
}

// Captures where the library would navigate. The promise never settles, as a
// real redirect never returns to the page that started it.
function capturing(onNavigate: () => void = () => undefined) {
  const urls: string[] = [];
  const navigator: INavigator = {
    prepare: () =>
      Promise.resolve({
        navigate: (params: NavigateParams) => {
          urls.push(params.url);
          onNavigate();
          return new Promise(() => undefined);
        },
        close: () => undefined,
      }),
    callback: () => Promise.resolve(),
  };
  return { navigator, urls };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("storedSession", () => {
  // A live token never waits on discovery (TYRE-471 spec, The session).
  it("reads the stored user with no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    plantSession({ accessToken: "at-old", subject: "oid-a" });

    await expect(createAuth({ ...SETTINGS, metadata: undefined }).storedSession()).resolves.toEqual(
      {
        accessToken: "at-old",
        expiresAt: expect.any(Number) as number,
        subject: "oid-a",
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads no user, a user with no oid, and a stored value that does not parse as no session", async () => {
    const auth = createAuth(SETTINGS);
    await expect(auth.storedSession()).resolves.toBeNull();
    plantSession({ accessToken: "at-old", subject: null });
    await expect(auth.storedSession()).resolves.toBeNull();
    window.localStorage.setItem(LIBRARY_USER_KEY, "{not json");
    await expect(auth.storedSession()).resolves.toBeNull();
  });
});

describe("discardUser", () => {
  // A late settle must not remove a session that a later renewal or sign-in
  // stored (TYRE-471 spec, Renewal).
  it("removes the stored user only while it holds the given access token", async () => {
    plantSession({ accessToken: "at-new", subject: "oid-a" });
    const auth = createAuth(SETTINGS);

    await auth.discardUser("at-old");
    expect(storedAccessToken()).toBe("at-new");
    await auth.discardUser("at-new");
    expect(storedAccessToken()).toBeNull();
  });
});

describe("the module's storedSession", () => {
  // Blocked site data makes the localStorage getter itself throw, so the
  // managers cannot be built. That is no session, and the store answers
  // signed out, as it did with its own copy (TYRE-471 spec, The session).
  // This file does not mock oidc.ts, so resetModules gives a fresh singleton.
  it("reads a localStorage getter that throws as no session", async () => {
    bearerSession();
    vi.resetModules();
    const oidc = await import("./oidc");
    const token = await import("../api/token");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(oidc.storedSession()).resolves.toBeNull();
    await expect(token.credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
  });
});

describe("signIn", () => {
  it("asks for an authorization code with PKCE, the client, the scopes and the redirect /", async () => {
    const { navigator, urls } = capturing();
    void createAuth(SETTINGS, navigator).signIn("/capture/v1");
    await vi.waitFor(() => expect(urls).toHaveLength(1));

    const url = new URL(urls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("pwa");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/`);
    expect(url.searchParams.get("scope")).toBe(`openid profile offline_access ${SCOPE}`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });
});

describe("completeSignIn", () => {
  async function callbackFor(id: string) {
    const { navigator, urls } = capturing();
    const auth = createAuth(SETTINGS, navigator);
    void auth.signIn("/capture/v1");
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    const state = new URL(urls[0]).searchParams.get("state") ?? "";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenResponse(id))),
    );
    return auth.completeSignIn(`${ORIGIN}/?code=c1&state=${state}`);
  }

  it("returns the oid, the expiry and the path signIn stored, and keeps the user in localStorage", async () => {
    const signedIn = await callbackFor(idToken("oid-a"));

    expect(signedIn.subject).toBe("oid-a");
    expect(signedIn.accessToken).toBe("at-new");
    expect(signedIn.returnTo).toBe("/capture/v1");
    expect(signedIn.expiresAt).toBeGreaterThan(Date.now());
    // U102: the library's default is sessionStorage, which dies with the browser.
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).not.toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  // ADR-0016: an Entra configuration slip that drops oid must not
  // produce a session with no subject to stamp or compare, and must not leave
  // the library's user behind for the next load to renew.
  it("refuses a sign-in whose ID token carries no oid, and removes the stored user", async () => {
    await expect(callbackFor(idToken(null))).rejects.toThrow(/oid/);
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });
});

describe("renew", () => {
  // A stored value that does not parse is no session. It goes, so the
  // renewal is a lapse and the driver signs in, rather than every call
  // failing as offline.
  it("removes a stored value that does not parse, and returns null with no request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    window.localStorage.setItem(LIBRARY_USER_KEY, "{not json");

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Another renewal or a sign-in stored a different refresh token while
  // this one was refused (TYRE-471 spec, The four late settles).
  it("leaves a stored user that holds another refresh token when its own is refused", async () => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        plantSession({ accessToken: "at-other", subject: "oid-a", refreshToken: "rt-other" });
        return Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(storedAccessToken()).toBe("at-other");
  });

  // With no refresh token the library would open a hidden iframe on "/".
  it("returns null without any request when no refresh token is stored", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    storeUser({ id_token: idToken("oid-a") });
    const before = document.body.querySelectorAll("iframe").length;

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.querySelectorAll("iframe")).toHaveLength(before);
    // Spec section 6: the ID token carries a name and an email address, and
    // a session that cannot renew is over.
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });

  it("uses the refresh token and returns the new access token", async () => {
    const id = idToken("oid-a");
    storeUser({ id_token: id, refresh_token: "rt-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenResponse(id))),
    );

    const tokens = await createAuth(SETTINGS).renew();
    expect(tokens?.accessToken).toBe("at-new");
    expect(tokens?.subject).toBe("oid-a");
  });

  // oidc-client-ts sets no request timeout of its own, so without one a
  // stalled discovery or code-exchange request leaves the callback page blank
  // (ADR-0016). Discovery is the request this test can observe.
  it("bounds its discovery request with an abort signal", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(SETTINGS.metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { navigator, urls } = capturing();

    void createAuth({ ...SETTINGS, metadata: undefined }, navigator).signIn("/x");
    await vi.waitFor(() => expect(urls).toHaveLength(1));

    const init = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // The settings' timeout does not reach the refresh request, so renew()
  // passes its own (docs/lessons.md, 2026-10-01). Unbounded, one stalled
  // refresh holds every caller of the shared renewal.
  it("bounds its refresh request with an abort signal", async () => {
    const id = idToken("oid-a");
    storeUser({ id_token: id, refresh_token: "rt-old" });
    const fetchMock = vi.fn(() => Promise.resolve(tokenResponse(id)));
    vi.stubGlobal("fetch", fetchMock);

    await createAuth(SETTINGS).renew();

    const [url, init] = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe(`${IDP}/token`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // U102: the 24-hour refresh token has lapsed. Nothing outlives the session.
  it("removes the stored user and returns null on invalid_grant", async () => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });

  it("lets a network failure through as itself and keeps the stored user", async () => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    await expect(createAuth(SETTINGS).renew()).rejects.toBeInstanceOf(TypeError);
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).not.toBeNull();
  });

  // Spec section 4 "Renewal": a refused refresh token ends the session; only
  // the provider's own transient codes keep it.
  function refusal(error: string, status: number): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
  }

  it.each([
    ["invalid_grant", 400],
    ["invalid_client", 401],
  ])("removes the stored user and returns null on %s", async (code, status) => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    refusal(code, status);

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });

  it.each([
    ["server_error", 500],
    ["temporarily_unavailable", 503],
  ])("keeps the session and rethrows on %s", async (code, status) => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    refusal(code, status);

    await expect(createAuth(SETTINGS).renew()).rejects.toMatchObject({ error: code });
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).not.toBeNull();
  });

  // ErrorResponse.form is the refresh POST body, refresh_token included.
  it("rethrows a transient refusal without the request form", async () => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    refusal("server_error", 500);

    const thrown: unknown = await createAuth(SETTINGS)
      .renew()
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain("rt-old");
    expect(thrown).not.toHaveProperty("form");
  });

  it("does not start the library's own renewal timer", () => {
    const start = vi.spyOn(UserManager.prototype, "startSilentRenew");
    createAuth(SETTINGS);
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  // ADR-0016 again, on the refresh path.
  it("treats a refreshed session with no oid as a lapse and removes the stored user", async () => {
    const withoutOid = idToken(null);
    storeUser({ id_token: withoutOid, refresh_token: "rt-old" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenResponse(withoutOid))),
    );

    await expect(createAuth(SETTINGS).renew()).resolves.toBeNull();
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });
});

describe("signOut", () => {
  // The stored user goes before the first request that can fail, even one
  // whose stored value does not parse (TYRE-471 spec, Signing out).
  it("removes a stored value that does not parse", async () => {
    window.localStorage.setItem(LIBRARY_USER_KEY, "{not json");
    const { navigator, urls } = capturing();

    void createAuth(SETTINGS, navigator)
      .signOut()
      .catch(() => undefined);
    await vi.waitFor(() => expect(urls).toHaveLength(1));

    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
  });

  // The e2e identity stub cannot see the id_token_hint, so this unit test does.
  it("clears the entry's keys first, then sends id_token_hint and lets the library remove its user", async () => {
    const id = idToken("oid-a");
    storeUser({ id_token: id, refresh_token: "rt-old" });
    window.localStorage.setItem(SUBJECT_KEY, "oid-a");
    window.localStorage.setItem("tyre.branding.t-1", "{}");
    window.localStorage.setItem("tyre.branding.default", "{}");
    window.localStorage.setItem("tyre.dev.tenant-id", "kept");
    window.localStorage.setItem(TENANT_KEY, "t-1");

    let atNavigate: Record<string, string | null> = {};
    const { navigator, urls } = capturing(() => {
      atNavigate = {
        subject: window.localStorage.getItem(SUBJECT_KEY),
        tenant: window.localStorage.getItem(TENANT_KEY),
        branding: window.localStorage.getItem("tyre.branding.t-1"),
        user: window.localStorage.getItem(LIBRARY_USER_KEY),
      };
    });
    void createAuth(SETTINGS, navigator).signOut();
    await vi.waitFor(() => expect(urls).toHaveLength(1));

    const url = new URL(urls[0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/logout`);
    expect(url.searchParams.get("id_token_hint")).toBe(id);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/`);
    expect(atNavigate).toEqual({
      subject: null,
      tenant: null,
      branding: null,
      user: null,
    });
    expect(window.localStorage.getItem("tyre.branding.default")).toBeNull();
    expect(window.localStorage.getItem("tyre.dev.tenant-id")).toBe("kept");
  });

  // A page that a rejected sign-out or a back-forward restore leaves in
  // place must not answer with the signed-out driver's token (TYRE-471 spec,
  // Signing out).
  it("leaves this page signed out", async () => {
    bearerSession();
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    window.localStorage.setItem(SUBJECT_KEY, "oid-a");
    await expect(credential()).resolves.toMatchObject({ accessToken: "at-old" });

    const { navigator, urls } = capturing();
    void createAuth(SETTINGS, navigator).signOut();
    await vi.waitFor(() => expect(urls).toHaveLength(1));

    await expect(credential()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    expect(window.localStorage.getItem(LIBRARY_USER_KEY)).toBeNull();
    expect(window.localStorage.getItem(SUBJECT_KEY)).toBeNull();
  });
});

describe("discovery", () => {
  const DISCOVERY_URL = `${IDP}/.well-known/openid-configuration`;
  const answered = () =>
    Promise.resolve(
      new Response(JSON.stringify(SETTINGS.metadata), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  // Discovery answers as `discovery` says; the token endpoint renews.
  function provider(discovery: () => Promise<Response>) {
    const calls = { discovery: 0, token: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === DISCOVERY_URL) {
          calls.discovery += 1;
          return discovery();
        }
        calls.token += 1;
        return Promise.resolve(tokenResponse(idToken("oid-a")));
      }),
    );
    return calls;
  }

  // U199: a failed discovery is not kept, or only a reload could sign in
  // or renew again (TYRE-471 spec, Discovery).
  it("fetches discovery once per page, and again after one that failed", async () => {
    storeUser({ id_token: idToken("oid-a"), refresh_token: "rt-old" });
    let first = true;
    const calls = provider(() => {
      if (!first) return answered();
      first = false;
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    const auth = createAuth({ ...SETTINGS, metadata: undefined });

    await expect(auth.renew()).rejects.toBeInstanceOf(TypeError);
    await expect(auth.renew()).resolves.toMatchObject({ accessToken: "at-new" });
    await expect(auth.renew()).resolves.toMatchObject({ accessToken: "at-new" });
    expect(calls).toEqual({ discovery: 2, token: 2 });
  });

  it.each([
    [
      "a status that is not 2xx",
      () =>
        new Response(JSON.stringify(SETTINGS.metadata), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    ],
    [
      "a captive portal's HTML",
      () =>
        new Response("<html>sign in to the wifi</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    [
      "a document with no token endpoint",
      () =>
        new Response(
          JSON.stringify({ issuer: `${IDP}/`, authorization_endpoint: `${IDP}/authorize` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ],
  ])("treats %s as no signal, and fetches again on the next call", async (_, bad) => {
    let first = true;
    const calls = provider(() => {
      if (!first) return answered();
      first = false;
      return Promise.resolve(bad());
    });
    const { navigator, urls } = capturing();
    const auth = createAuth({ ...SETTINGS, metadata: undefined }, navigator);

    const error: unknown = await auth.signIn("/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ErrorResponse);
    expect(urls).toEqual([]);

    void auth.signIn("/");
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    expect(calls.discovery).toBe(2);
  });
});
