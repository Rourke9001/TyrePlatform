import { type Page } from "@playwright/test";

import config from "../playwright.config";
import { DRIVER_ACTOR } from "./sandbox";

// The identity provider stub (web/CLAUDE.md). The identity provider cannot
// be reached from CI, and the Go half of sign-in is proved by its own tests
// (spec section 7). By default the stub answers idp.test,
// web/.env.development's authority, and on /api swaps the bearer for the
// Sandbox driver's dev headers, since `make api-run` has no AUTH_*
// configuration to validate it. The production check hands it the
// production authority and its own web origin, and stubs the API itself
// (productionApi.ts).
export interface IdpSettings {
  authority: string;
  clientId: string;
  apiScope: string;
  webOrigin: string;
}

export const DEV_IDP: IdpSettings = {
  authority: "https://idp.test/",
  clientId: "e2e-pwa",
  apiScope: "api://e2e-api/access_as_user",
  webOrigin: new URL(config.use?.baseURL ?? "").origin,
};

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
  // A bearer-mode call that also carried the dev actor headers. Identity must
  // come from the token alone.
  withDevHeaders: string[];
  submitBearers: string[];
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function idToken(idp: IdpSettings, oid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: idp.authority,
    aud: idp.clientId,
    sub: `pairwise-${oid}`,
    oid,
    iat: now,
    exp: now + 3600,
  };
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

export async function stubIdentityProvider(
  page: Page,
  idp: IdpSettings = DEV_IDP,
  opts: { swapApi?: boolean } = {},
): Promise<IdpStub> {
  const base = idp.authority.replace(/\/$/, "");
  const origin = idp.webOrigin;
  const cors = { "Access-Control-Allow-Origin": origin };
  const scope = `openid profile offline_access ${idp.apiScope}`;
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

  await page.route(
    (url) => url.href === `${base}/.well-known/openid-configuration`,
    (route) =>
      route.fulfill({
        headers: cors,
        json: {
          issuer: idp.authority,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          end_session_endpoint: `${base}/logout`,
          jwks_uri: `${base}/keys`,
        },
      }),
  );

  // Predicates on the href, not globs, because whether "?" in a glob is
  // literal has changed across Playwright releases.
  await page.route(
    (url) => url.href.startsWith(`${base}/authorize?`),
    (route) => {
      const url = new URL(route.request().url());
      stub.authorizeUrls.push(url);
      const back = new URL(`${origin}/`);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      if (stub.failNextAuthorize) {
        stub.failNextAuthorize = false;
        back.searchParams.set("error", "access_denied");
      } else {
        back.searchParams.set("code", "e2e-code");
      }
      return route.fulfill({ status: 302, headers: { location: back.href } });
    },
  );

  await page.route(
    (url) => url.href === `${base}/token`,
    (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "*",
          },
        });
      }
      return route.fulfill({
        headers: cors,
        json: {
          access_token: `e2e-at-${stub.subject}`,
          id_token: idToken(idp, stub.subject),
          refresh_token: `e2e-rt-${stub.subject}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope,
        },
      });
    },
  );

  await page.route(
    (url) => url.href.startsWith(`${base}/logout?`),
    (route) => {
      const url = new URL(route.request().url());
      stub.endSessionUrls.push(url);
      return route.fulfill({
        status: 302,
        headers: { location: url.searchParams.get("post_logout_redirect_uri") ?? `${origin}/` },
      });
    },
  );

  if (opts.swapApi === false) return stub;

  // A predicate, not the glob "**/api/**". Playwright matches a glob against
  // the whole URL, so that glob also catches Vite's own /src/api/client.ts,
  // token.ts and friends, and main.tsx never runs.
  await page.route(
    (url) => url.origin === origin && url.pathname.startsWith("/api/"),
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
