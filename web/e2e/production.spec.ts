import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { loadEnv } from "vite";

import config from "../playwright.production.config";
import { stubIdentityProvider, type IdpSettings } from "./idp";
import { TEST_API_ORIGIN, stubProductionApi } from "./productionApi";

// The production bundle under the CSP the deploy writes (ADR-0019; section 4
// of docs/superpowers/specs/2026-10-16-platform-readiness-design.md). The
// only run of the production boot path before staging: under vite dev
// neither the headers nor config.json exist.

const webOrigin = new URL(config.use?.baseURL ?? "").origin;
// The production sign-in values, read as vite build reads them, never
// copied, so the CIAM origin here cannot drift from the bundle's.
const env = loadEnv("production", resolve(dirname(fileURLToPath(import.meta.url)), ".."), "VITE_");
const PROD: IdpSettings = {
  authority: env.VITE_AUTH_AUTHORITY ?? "",
  clientId: env.VITE_AUTH_CLIENT_ID ?? "",
  apiScope: env.VITE_AUTH_API_SCOPE ?? "",
  webOrigin,
};
const CIAM_ORIGIN = new URL(PROD.authority).origin;
const UNLISTED_API_ORIGIN = "https://api-unlisted.test";

let violations: string[];

test.beforeEach(async ({ page }) => {
  violations = [];
  // The binding first: the init script calls it, and a violation before the
  // first navigation's script runs would otherwise be lost.
  await page.exposeFunction("cspViolation", (v: string) => {
    violations.push(v);
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "securitypolicyviolation",
      (e) => {
        void (window as unknown as { cspViolation(v: string): Promise<void> }).cspViolation(
          `${e.effectiveDirective} ${e.blockedURI}`,
        );
      },
      true,
    );
  });
});

function isWebConfig(url: URL): boolean {
  return url.origin === webOrigin && url.pathname === "/config.json";
}

test("the production bundle runs under its CSP, signed in, with a Radix Select open", async ({
  page,
}) => {
  await stubIdentityProvider(page, PROD, { swapApi: false });
  const api = await stubProductionApi(page, TEST_API_ORIGIN, webOrigin);
  await page.route("https://csp-control.test/", (route) =>
    route.fulfill({ status: 200, body: "ok" }),
  );
  let configRequests = 0;
  page.on("request", (r) => {
    if (isWebConfig(new URL(r.url()))) configRequests++;
  });

  const response = await page.goto("/");
  // Without this the check would pass vacuously on a preview with no headers.
  expect(response?.headers()["content-security-policy"]).toContain(
    `connect-src 'self' ${TEST_API_ORIGIN} ${CIAM_ORIGIN}`,
  );

  // The control: the listener sees a blocked request, even one page.route
  // would have fulfilled.
  await page.evaluate(() => fetch("https://csp-control.test/").catch(() => undefined));
  await expect.poll(() => violations.some((v) => v.includes("csp-control.test"))).toBe(true);
  violations = [];

  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByText("Production Check · CONTROLLER")).toBeVisible();

  configRequests = 0;
  await page.goto("/exceptions");
  await expect(page.getByRole("heading", { name: "Exceptions", exact: true })).toBeVisible();
  // One request per load: the fetch consumed the preload in index.html
  // rather than fetching a second time.
  expect(configRequests).toBe(1);
  await page.getByRole("combobox", { name: "Severity" }).click();
  await expect(page.getByRole("option", { name: "All severities" })).toBeVisible();

  expect(api.calls).toContain("GET /api/me bearer");
  expect(violations).toEqual([]);
});

// The permanent proof that connect-src binds the API origin. Taking the
// placeholder out of the source cannot prove it: the writer refuses such a
// source and the preview never starts.
test("an API origin the CSP does not list is blocked", async ({ page }) => {
  await stubIdentityProvider(page, PROD, { swapApi: false });
  await page.route(isWebConfig, (route) =>
    route.fulfill({ json: { apiOrigin: UNLISTED_API_ORIGIN } }),
  );
  const unlisted = await stubProductionApi(page, UNLISTED_API_ORIGIN, webOrigin);

  await page.goto("/");
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect
    .poll(() =>
      violations.some((v) => v.startsWith("connect-src ") && v.includes("api-unlisted.test")),
    )
    .toBe(true);
  expect(unlisted.calls).toEqual([]);
});

// The spec's anti-goal: no silent fall back to a relative /api on the web
// origin, which 404s.
test("a production bundle without config.json says so, calls no API and keeps its target size", async ({
  page,
}) => {
  await stubIdentityProvider(page, PROD, { swapApi: false });
  const api = await stubProductionApi(page, TEST_API_ORIGIN, webOrigin);
  await page.route(isWebConfig, (route) => route.fulfill({ status: 404, body: "" }));
  const webApi: string[] = [];
  await page.route(
    (url) => url.origin === webOrigin && url.pathname.startsWith("/api/"),
    (route) => {
      webApi.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 500, body: "" });
    },
  );

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("The app could not load its settings.");
  expect(api.calls).toEqual([]);
  expect(webApi).toEqual([]);
  // NFR-USE-004's floor, which only the CSS variables ConfigFailure sets
  // itself provide.
  const box = await page.getByRole("button", { name: "Try again" }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(violations).toEqual([]);
});
