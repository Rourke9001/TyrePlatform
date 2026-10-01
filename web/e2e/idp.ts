import { type Page } from "@playwright/test";

import config from "../playwright.config";
import { DRIVER_ACTOR } from "./sandbox";

// The one e2e file that mocks (web/CLAUDE.md): the identity provider cannot
// be reached from CI, and the Go half of sign-in is proved by its own tests
// (spec section 7). The stub answers idp.test, web/.env.development's
// authority, and on /api swaps the bearer for the Sandbox driver's dev
// headers, since `make api-run` has no AUTH_* configuration to validate it.
const IDP = "https://idp.test";
const ORIGIN = new URL(config.use?.baseURL ?? "").origin;
const CLIENT_ID = "e2e-pwa";
const SCOPE = "openid profile offline_access api://e2e-api/access_as_user";
const CORS = { "Access-Control-Allow-Origin": ORIGIN };

export interface IdpStub {
  // The oid the next token response carries.
  subject: string;
  failNextAuthorize: boolean;
  refuseSubmits: boolean;
  authorizeUrls: URL[];
  endSessionUrls: URL[];
  // "<path> <bearer>" for each /api call; a call with no bearer is refused and
  // listed in withoutBearer.
  apiBearers: string[];
  withoutBearer: string[];
  // A bearer-mode call that also carried the dev actor headers: identity must
  // come from the token alone.
  withDevHeaders: string[];
  submitBearers: string[];
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(oid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `${IDP}/`,
    aud: CLIENT_ID,
    sub: `pairwise-${oid}`,
    oid,
    iat: now,
    exp: now + 3600,
  };
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

export async function stubIdentityProvider(page: Page): Promise<IdpStub> {
  const stub: IdpStub = {
    subject: "e2e-oid-a",
    failNextAuthorize: false,
    refuseSubmits: false,
    authorizeUrls: [],
    endSessionUrls: [],
    apiBearers: [],
    withoutBearer: [],
    withDevHeaders: [],
    submitBearers: [],
  };

  await page.route(`${IDP}/.well-known/openid-configuration`, (route) =>
    route.fulfill({
      headers: CORS,
      json: {
        issuer: `${IDP}/`,
        authorization_endpoint: `${IDP}/authorize`,
        token_endpoint: `${IDP}/token`,
        end_session_endpoint: `${IDP}/logout`,
        jwks_uri: `${IDP}/keys`,
      },
    }),
  );

  // RegExp, not a glob: whether "?" in a glob is literal has changed across
  // Playwright releases.
  await page.route(/^https:\/\/idp\.test\/authorize\?/, (route) => {
    const url = new URL(route.request().url());
    stub.authorizeUrls.push(url);
    const back = new URL(`${ORIGIN}/`);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    if (stub.failNextAuthorize) {
      stub.failNextAuthorize = false;
      back.searchParams.set("error", "access_denied");
    } else {
      back.searchParams.set("code", "e2e-code");
    }
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });

  await page.route(`${IDP}/token`, (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }
    return route.fulfill({
      headers: CORS,
      json: {
        access_token: `e2e-at-${stub.subject}`,
        id_token: idToken(stub.subject),
        refresh_token: `e2e-rt-${stub.subject}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: SCOPE,
      },
    });
  });

  await page.route(/^https:\/\/idp\.test\/logout\?/, (route) => {
    const url = new URL(route.request().url());
    stub.endSessionUrls.push(url);
    return route.fulfill({
      status: 302,
      headers: { location: url.searchParams.get("post_logout_redirect_uri") ?? `${ORIGIN}/` },
    });
  });

  // A predicate, not the glob "**/api/**". Playwright matches a glob against
  // the whole URL, so that glob also catches Vite's own /src/api/client.ts,
  // token.ts and friends, and main.tsx never runs.
  await page.route(
    (url) => url.origin === ORIGIN && url.pathname.startsWith("/api/"),
    (route) => {
      const request = route.request();
      const bearer = request.headers()["authorization"];
      const path = new URL(request.url()).pathname;
      if (!bearer?.startsWith("Bearer e2e-at-")) {
        stub.withoutBearer.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 401, json: { code: "unauthorized", message: "no bearer" } });
      }
      stub.apiBearers.push(`${path} ${bearer}`);
      const sent = request.headers();
      if (sent["x-tenant-id"] !== undefined || sent["x-user-id"] !== undefined) {
        stub.withDevHeaders.push(`${request.method()} ${path}`);
      }
      if (request.method() === "POST" && path === "/api/inspections") {
        stub.submitBearers.push(bearer);
        if (stub.refuseSubmits) {
          return route.fulfill({
            status: 401,
            json: { code: "unauthorized", message: "refused by the stub" },
          });
        }
      }
      const headers = { ...request.headers() };
      delete headers["authorization"];
      return route.continue({
        headers: { ...headers, ...DRIVER_ACTOR },
      });
    },
  );

  return stub;
}

// A lapsed session: the mirror and the library's stored user gone, so the
// next call finds nothing to renew. The entry never reads the library's
// keys; only this test does.
export async function lapseSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key === "tyre.auth.mirror" || key.startsWith("oidc.user:"))
        window.localStorage.removeItem(key);
    }
  });
}

// A token older than the fresh-token window (src/api/token.ts), so a stubbed
// 401 reads as a lapsed token and not as a misconfigured API.
export async function ageToken(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = window.localStorage.getItem("tyre.auth.mirror");
    if (raw === null) throw new Error("no mirror to age");
    const mirror = JSON.parse(raw) as { obtainedAt: number };
    mirror.obtainedAt = Date.now() - 5 * 60_000;
    window.localStorage.setItem("tyre.auth.mirror", JSON.stringify(mirror));
  });
}
