# ADR-0019: The web calls the API at its own origin, over CORS

- **Status:** Accepted. Its PR, #126, merged on 16 Oct 2026.
- **Date:** 2026-10-16
- **Deciders:** Rourke
- **Related:** ADR-0016 (identity; this takes its recorded fallback) ·
  ADR-0017 (environments; the web bundle carries no per-environment setting)
  · ADR-0002 (region) · ADR-0005 (hosting) · TYRE-51, TYRE-341, TYRE-205,
  TYRE-317 · owner ruling U137 (TYRE-51 comment 13779) · U75 (superseded)

## Context

Staging serves `develop` (TYRE-79), but its web fetches relative `/api/...`
paths. The Static Web App has no route to the API, so every one of those
calls 404s at the web origin, and nobody can sign in.

U75 chose to close the gap with a linked backend: the Static Web App on its
Standard SKU proxies `/api` to the Container App, so the web and the API
share one origin. Its reasons were same-origin cookies and one place for the
security headers.

Research on 16 Oct 2026 found five problems with linking (comment 13779):

1. Linking locks the Container App to proxied traffic, and the deploy gate
   curls the Container App directly.
2. Microsoft does not document whether a client's `Authorization` header
   reaches a linked backend.
3. Users report the proxy adds no `X-Forwarded-For`, which would put every
   caller in one NFR-SEC-007 bucket.
4. The proxy has no South African region, so every API call, personal data
   included, would leave the country.
5. A linked app cannot return to the Free SKU.

## Options considered

### Option A: a linked backend (U75)

The Static Web App proxies `/api` to the Container App. One origin, no CORS,
no preflight. **Its downside is the five problems above**: the gate loses its
direct path, the bearer header's survival is undocumented, the rate limit's
per-address bucket collapses, API traffic leaves South Africa North, and the
Standard SKU is permanent.

### Option B: the Container App's own origin, over CORS

The web calls the API at the Container App's FQDN, and the API allows that
one web origin. Both apps stay on their own origins, the Static Web App stays
on Free, and nothing new sits in front of Go. **Its downside**: a CORS
preflight per new URL and method, and an origin pair to keep in step.

### Option C: a proxy, such as Front Door, in front of both

One origin through a proxy the platform controls. **Its downside**: a
monthly cost the pilot does not need, and a second L7 hop, which moves
`TRUSTED_PROXY_HOPS` and every address NFR-SEC-007 reads.

### Option D: a `staticwebapp.config.json` rewrite to the API

**Its downside is that it cannot work**: a Static Web Apps route rewrites
only to a path on the same app, never to another host.

## Decision

The web calls the API at the Container App's own origin, and the API allows
that one web origin over CORS. ADR-0016's recorded fallback is now the
design.

U75's reasons no longer hold. Sign-in is a bearer token, not a cookie
(ADR-0016), so nothing depends on sharing an origin, and the Static Web App's
`globalHeaders` never applied to API responses in any case.

### The parts

- **CORS lives in Go**, in one middleware on the root router, ahead of
  `requireActor` and every rate limiter. It is written in-house, rather
  than taking `github.com/go-chi/cors` as a dependency: one exact origin,
  three methods and two headers need no library.
  Container Apps ingress `corsPolicy` stays unset: two layers would send two
  `Access-Control-Allow-Origin` headers, and the browser refuses such a
  response. Go's version is also proven by a test in `make check`, where
  ingress CORS is proven only by a deploy.
- **The allowed origin is exact.** `CORS_ALLOWED_ORIGINS` holds a
  comma-separated list, matched byte for byte, never a pattern or a
  reflected `Origin`. `infra/app.bicep` sets it from the Static Web App
  resource's `defaultHostname`, so it cannot drift from the resource. Unset,
  the API sends no CORS headers, which keeps local dev and e2e same-origin
  through Vite's proxy.
- **Refusals carry the headers too**, so the web reads a 401 or 429
  envelope rather than a network error.
- **`Access-Control-Max-Age` is 7200 seconds**, Chromium's cap. The caps it
  rests on, each checked on 16 Oct 2026: Chromium 7200 s since v76 and
  Firefox 86400 s (developer.mozilla.org, Access-Control-Max-Age); WebKit
  600 s (`maxPreflightCacheTimeout` in WebKit's
  `Source/WebCore/loader/CrossOriginPreflightResultCache.cpp`). Each
  browser clamps a larger value to its own cap, so 7200 is the most any
  Chromium-based browser will use.
- **No `Access-Control-Allow-Credentials`**: there are no cookies. **No
  `Access-Control-Expose-Headers`**: the client reads no response header,
  only bodies.
- **The API origin reaches the web in a fetched `/config.json`**, written by
  the deploy from the Container App's FQDN. That is the path ADR-0017's "web
  bundle carries no per-environment setting" prescribes, so one bundle still
  serves both environments. A per-environment build was the alternative,
  and ADR-0017 forbids it.
- **The web origin's headers** sit in one committed
  `web/staticwebapp.config.json`, with the API origin filled in at deploy.
  The CSP and why each directive is what it is:
  - `default-src 'self'`, `object-src 'none'`, `base-uri 'self'` and
    `frame-ancestors 'none'`: the app loads only its own files.
  - `script-src 'self'`, with no `'unsafe-inline'`: the build emits no inline
    script.
  - `style-src 'self' 'unsafe-inline'`: Radix Select and Dialog inject a
    `<style>` element at runtime, through react-remove-scroll's
    react-style-singleton, and a static header cannot carry a per-response
    nonce. Inline style is the accepted, lower-risk allowance; inline script
    is not. Tried on 16 Oct 2026: without the allowance the production check
    records six `style-src-elem` violations, all once the Select opens.
  - `connect-src 'self'`, the API origin and the CIAM origin (the host of
    `VITE_AUTH_AUTHORITY`).
  - No `frame-src`: `renew()` in `web/src/auth/oidc.ts` ends the session
    rather than renewing in an iframe.
  - `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
    `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`, the same
    values `api/internal/httpapi/security.go` sends.
  - A `Permissions-Policy` that denies the features the app does not use:
    accelerometer, camera, geolocation, gyroscope, magnetometer, microphone,
    payment and USB.
- **`TRUSTED_PROXY_HOPS` stays 1.** Container Apps ingress is still the only
  L7 hop, and it appends the caller's address rightmost
  (learn.microsoft.com/azure/container-apps/ingress-overview).
- **For ADR-0002:** API traffic stays in South Africa North. The Static Web
  App serves only the compiled frontend.

## Consequences

**Good:** the web can reach the API in staging and in production with one
bundle, on the Free SKU, with no proxy in front of Go. The deploy gate keeps
its direct path to the Container App, NFR-SEC-007 keeps a per-caller address,
and personal data stays in South Africa North. The question whether
`Authorization` survives a proxy disappears, because there is no proxy:
TYRE-317's first signed-in request is the last proof it needs.

**Bad:**

- Each session pays, against NFR-PRF-001 (capture interactive within 2 s on
  3G), one `config.json` round trip, overlapped with the entry download by a
  preload in `index.html`, plus one preflight per new URL and method, cached
  by the browser up to its cap.
- An origin pair to keep in step: the API allows the web origin, and the
  web's CSP names the API origin. The deploy writes the CSP, so it names one
  environment's API origin.
- A rollback to a commit from before this ADR ships a web that calls a
  relative `/api`, 404s, and fails the post-deploy smoke.

**Revisit when:** a custom domain lands (TYRE-19); any proxy is placed in
front of either origin; photo capture (FR-INS-023/024) or a captured
position (NFR-PRV-005) needs `camera` or `geolocation`, which the
`Permissions-Policy` denies; a tenant logo is served from blob storage or the
API (`logoUrl` in `web/src/dashboard/AppShell.tsx`), which `default-src
'self'` blocks for images. None of these headers apply under `vite dev`, so
only the production browser check (`web/playwright.production.config.ts`) or
staging shows such a block.
