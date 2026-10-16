# Design: the web reaches the API, and the platform is ready for production (TYRE-51 with TYRE-305, TYRE-405 and TYRE-402)

- **Date:** 2026-10-16
- **Ticket:** TYRE-51, under epic TYRE-10. Comment 13770 folds in TYRE-305
  (the pool), TYRE-405 (`/readyz`, carrying TYRE-408) and TYRE-402 (the
  registry). TYRE-51 already carries TYRE-205's web half (comment 13192),
  the sign-in additions (13447, 13454, 13455) and TYRE-341's
  `navigationFallback` (13516).
- **Decisions it rests on:**
  - **Owner ruling U137** (TYRE-51 comment 13779, 16 Oct 2026, supersedes
    U75): no linked backend, and the Static Web App stays on the Free SKU in
    both environments. The web calls the API at the Container App's own
    origin, and the API allows that web origin over CORS.
  - U71 (TYRE-305 comment 13149): a pool of 7 per replica.
  - ADR-0017, "The web bundle carries no per-environment setting": a
    per-environment setting moves to a fetched `config.json`, never to a
    per-environment build.
  - ADR-0016's recorded fallback: the Container App's origin over CORS.
  - U117: the template split.
  - U130: the triage rule.
- **Requirements:**
  - NFR-SEC-010 (security headers) and NFR-SEC-007 (the per-address limit
    on submissions, as amended by TYRE-373's erratum). Both are Must and
    in Appendix H.1.
  - NFR-OBS-005: the reason `/readyz` pings the database. It is outside
    H.1.
  - No SRS row covers CORS, origins, the Static Web App, readiness or the
    pool, so nothing here proposes an SRS change.

## Why this exists

Staging serves `develop` (TYRE-79), but nobody can sign in there. The web
fetches relative `/api/...` paths. The Static Web App has no route to the
API, so those calls 404 at the web origin. Three smaller gaps also stand
between staging and a production stood up from the same templates
(TYRE-397):

- **The pool is too large.** `defaultMaxConns` is 10. A rolling deploy runs
  four replicas, and 4 x 10 is over B1ms's 35 user connections (TYRE-305).
- **`/readyz` is unthrottled.** It spends a pooled connection and a ping on
  every anonymous request (TYRE-405).
- **The registry is derived from `env`.** `platform.bicep` names it
  `crtyre${env}`, so a production apply would look for a registry that does
  not exist (TYRE-402).

**Why not a linked backend (U75's plan).** Research on 16 Oct 2026 found
five problems, recorded in comment 13779:

1. Linking locks the Container App to proxied traffic, and the deploy gate
   curls the Container App directly.
2. Microsoft does not document whether a client's `Authorization` reaches a
   linked backend.
3. Users report the proxy adds no `X-Forwarded-For`, which would put every
   caller in one NFR-SEC-007 bucket.
4. The proxy has no South African region, so every call, personal data
   included, would leave the country.
5. A linked app cannot return to Free.

U75's own reasons no longer hold either. Sign-in is a bearer token, not a
cookie (ADR-0016), and the web host's headers never apply to API responses.

## Goals

1. A browser on the web origin calls the API at its own origin. The API
   answers with CORS headers for that one origin, refusals included, so the
   web can read a 401 or a 429 envelope.
2. The web origin answers with NFR-SEC-010's headers. Its CSP allows
   exactly what the app loads: itself, the API origin, and the CIAM host.
3. A deep link to a client route, and a reload of one, return the app
   (TYRE-341).
4. The API origin reaches the web through runtime configuration. One bundle
   serves both environments (ADR-0017).
5. After every staging deploy, CI proves goals 1 to 4 against the deployed
   origins. The owner applies nothing by hand for them.
6. The pool is 7, and ADR-0005's arithmetic matches B1ms's limits.
7. Concurrent `/readyz` hits inside a stated bound cost one ping. A failed
   database still shows within one gate poll.
8. `platform.bicep` grants AcrPull on a registry named by parameter. That
   registry is staging's by default, so production's grant resolves to
   `crtyrestaging` (ADR-0017, Registry).

## Non-goals

- Production itself: TYRE-397.
- Custom domains for either origin.
- Azure Front Door, or any proxy in front of either origin.
- Staging's uptime window: the owner's idea, recorded on TYRE-398, comment
  13778.
- Cache-Control for static assets.
- TYRE-203, the backup work, which `implementation-order.md` lists beside
  this item.
- Reading `max_connections` off staging. That is the owner's U94 query; see
  §6.
- The first real sign-in: TYRE-317.

## Anti-goals

Any of these makes the change a failure even if the tests pass:

- **A per-environment web build**, which ADR-0017 forbids.
- **A wildcard or pattern CORS origin**, or one that reflects whatever
  `Origin` arrives.
- **CORS set in two places** (Go and Container Apps ingress). Duplicate
  `Access-Control-Allow-Origin` headers make the browser refuse the
  response.
- **CORS headers on success only.** The web then cannot read a refusal, and
  `client.ts`'s refusal handling sees a network error instead.
- **A CSP that blocks something the running app needs.** Staging is the
  only place it would surface, and it would surface as a blank or broken
  app.
- **A `/readyz` answer older than one gate poll.**
- **Any change to tenant isolation, `requireActor`, the rate limits'
  values, or the API's own security headers (`security.go`).**

## 1. The decision record

The implementer writes a new ADR as the plan's first task. It is ADR-0019,
unless that number is taken by then. It records:

- U137: the web reaches the API at its own origin over CORS.
- The five reasons against linking, citing comment 13779.
- U75's superseded rationale.
- What the decision gives up: one CORS preflight per new URL and method,
  cached by the browser, and an origin pair to keep in step.
- That ADR-0016's fallback is now the design. ADR-0016 gets a one-line
  pointer to the new ADR.
- That `TRUSTED_PROXY_HOPS` stays 1. Container Apps ingress is still the
  only L7 hop, and it appends the caller's address rightmost
  (learn.microsoft.com/azure/container-apps/ingress-overview).
- For ADR-0002: API traffic stays in South Africa North. The Static Web App
  serves only the compiled frontend.

## 2. CORS, in Go

**Where.** CORS lives in one Go middleware on the root router. It is
registered beside `securityHeaders`, ahead of `requireActor` and ahead of
every rate limiter. Container Apps ingress `corsPolicy` stays unset.

*Lead's call:* Go, not ingress. CORS is HTTP behaviour, which CLAUDE.md
puts in Go. A table-driven test in `make check` proves it, the same way
`security.go` is proven, whereas ingress CORS is proven only by a deploy.
The middleware may be written in-house or use `github.com/go-chi/cors`.
That choice is the builder's, and if it adds the dependency the ADR says
so.

**Allowed origins.** An exact list, from an environment variable that
`app.bicep` sets.

- **The deployed value comes from the resource, not a literal.**
  `app.bicep` takes the Static Web App as an `existing` resource
  (`stapp-tyre-${env}`) and sets `https://` plus its `defaultHostname`.
  That value cannot drift from the resource.
- **Unset means no CORS headers at all.** That covers local dev and e2e,
  which stay same-origin through Vite's proxy.

**Preflight.** An `OPTIONS` request with an allowed `Origin` and an
`Access-Control-Request-Method`:

- is answered before authentication and rate limiting, with 204;
- carries the API's security headers, as every response does;
- allows the methods the API uses (GET, POST, PATCH) and the request
  headers the web sends (`Authorization`, `Content-Type`). The builder
  confirms these lists against `web/src/api/client.ts`;
- sets `Access-Control-Max-Age` to a value the builder states, with the
  browser caps it rests on.

A preflight never counts against NFR-SEC-007's limits.

**Actual responses.** On every response to an allowed origin, refusals
included, the middleware sets:

- `Access-Control-Allow-Origin` to that exact origin;
- `Vary: Origin`;
- `Access-Control-Expose-Headers` for any response header the web reads.
  The builder checks for one; today the client reads only bodies.

It never sets `Access-Control-Allow-Credentials`: there are no cookies.

**Other origins.** A disallowed `Origin`, or none, gets no CORS headers and
no error. The browser enforces the refusal. A non-browser caller is
unaffected, as it is today.

**Paths.** CORS applies under `/api`. `/healthz` and `/readyz` neither need
it nor change.

## 3. The web: runtime configuration and the API origin

**`config.json`.** At startup, before its first API call, the web fetches
`/config.json` from its own origin. The file carries the API origin, for
example `{"apiOrigin": "https://ca-api-staging.<...>.azurecontainerapps.io"}`.
`client.ts`'s `send` prefixes every path with it. Paths stay relative
everywhere else, the outbox included: the outbox stores payloads, and the
base is applied at send time.

**A missing or invalid file.** In a dev build, a missing file means a
relative base, so the Vite proxy, vitest and e2e work unchanged. In a
production build it is a visible failure the app reports, never a silent
fall back to relative `/api` on the web origin, which 404s. The builder
decides the shape of that failure and its tests.

**The file is written at deploy time.** The deploy's web job writes it from
the API's deployed FQDN. That value is `app.bicep`'s `apiFqdn` output, or
an `az containerapp show` query; the builder picks one. The job writes it
after the bundle, dev-string and sign-in checks. It is not part of the
bundle those checks measure, and the bundle stays identical across
environments.

## 4. The web origin's headers and fallback (`staticwebapp.config.json`)

The deployed artifact carries `staticwebapp.config.json` at the root of the
upload (`web/dist`).

**One committed source.** One file in the repository holds the headers and
the fallback. The deploy fills in only the per-environment API origin for
the CSP. The builder chooses the mechanism, for example a placeholder that
the step writing `config.json` replaces. The same source feeds the browser
check below.

**`globalHeaders`** (NFR-SEC-010, valid on the Free SKU):

- `Content-Security-Policy`, with at least:
  - `default-src 'self'`
  - `connect-src 'self' <api-origin> <ciam-origin>`, the CIAM origin being
    the host of `VITE_AUTH_AUTHORITY`
  - `frame-ancestors 'none'`
  - `object-src 'none'`
  - `base-uri 'self'`
  - `script-src 'self'`, with no `'unsafe-inline'`
  - `style-src 'self' 'unsafe-inline'`. *Lead's call:* Radix Dialog and
    Select inject a `<style>` element at runtime, through
    react-remove-scroll's react-style-singleton. A static header cannot
    carry a per-response nonce. Inline style is the accepted, lower-risk
    allowance; inline script is not.
  - no `frame-src`: `renew()` in `web/src/auth/oidc.ts` ends the session
    rather than renewing in an iframe.
  - any `img-src` or `font-src` beyond `'self'` that the running app
    needs. The browser check below finds these.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY` and a `Referrer-Policy`, matching `security.go`'s
  values unless the app needs otherwise.
- A `Permissions-Policy` that denies the features the app does not use.

**`navigationFallback`** (TYRE-341): rewrite to `/index.html`, excluding
`/assets/*`, `/config.json` and requests for files by extension. A missing
asset then 404s instead of returning HTML. `/api/*` needs no exclusion: the
web origin serves no API. Adding it is harmless.

**The CSP is proven in a browser before merge, on the production bundle.**
*Lead's call:* an automated Playwright check in `make test`, as follows.

- It serves the production build with `vite preview`. `preview.headers`
  reads the same committed source, with a test API origin filled in.
- It serves a `config.json` naming that test origin. Any absolute origin is
  a valid `apiOrigin`, the web origin included.
- It uses the `auth` project's IdP and API stubs (`page.route`) to reach
  the signed-in screens. A production bundle has no dev header path
  (`bearerMode()`, `check-dist-dev-strings.mjs`), so stubbing is the only
  way past sign-in.
- It opens at least one screen with a Radix Dialog or Select, the lazy
  screens behind sign-in included.
- It fails on any `securitypolicyviolation` event.
- Because `page.route` fulfils the API calls, no real API runs and the CI
  API needs no CORS setting.

This is also the only place the production `config.json` boot path runs
before staging.

## 5. The post-deploy checks, in CI

`deploy.yml`'s web job gains a check step after the upload. A failure
fails the job. Each check retries briefly, because a scale-to-zero replica
may cold-start. The steps:

1. **The web origin.** `GET /` answers 200 with §4's headers, and its CSP
   names the API origin.
2. **The deep link.** `GET` on a client route answers 200 with the same
   `index.html`. A reload is the same request to the server.
3. **The configuration.** `GET /config.json` answers 200 and names the API
   origin.
4. **The preflight.** `OPTIONS /api/org/branding` to the API origin, with
   the web origin as `Origin`, `Access-Control-Request-Method: GET` and
   `Access-Control-Request-Headers: authorization`, answers 204 and allows
   that origin and header.
5. **The refusal.** `GET /api/org/branding` with the web origin as `Origin`
   and a malformed bearer token answers 401, with Go's error envelope, the
   CORS origin header and the API's security headers.
6. **Another origin.** The same request with another `Origin` gets no
   `Access-Control-Allow-Origin`.

**Authorization.** These checks prove routing, CORS and the refusal shape.
They do not prove that `Authorization` reaches Go unchanged (comment
13447). The 401 body is the same for no token and a bad token, and only the
log line's `reason` differs (`api/internal/bearer/bearer.go`). *Lead's
call:* CI does not read container logs. Log reads lag and cover one replica
each, which makes them a flaky gate. With no proxy in the path, only
Container Apps ingress sits between the browser and Go, and TYRE-317's
first signed-in request settles the question.

These checks are TYRE-398's first post-deploy smoke tests. The plan says
so, and TYRE-398 builds on them.

## 6. The pool (TYRE-305)

**The code.** `defaultMaxConns` becomes 7 (U71). Its comment names B1ms's
35 user connections and cites the ADR, not the arithmetic.

**The ADR.** ADR-0005 gains an amendment that corrects the arithmetic:

- 35 user connections, with Azure's 15 reserved;
- steady state 2 x 7 = 14;
- the rolling-deploy peak 4 x 7 = 28, which leaves 7 for `migrate` and an
  admin `psql`;
- the `TEST_ADMIN_DATABASE_URL` checks never connect to staging;
- the same arithmetic applies to production's own B1ms server.

**The DSN can override the default.** `store.New` applies
`defaultMaxConns` only when the DSN names no `pool_max_conns`
(`store.go:53`). The repository never shows how staging's Key Vault
`database-url` was written. The amendment states the rule. The runbook
gains an owner step that reports whether the secret names
`pool_max_conns`, using a command that prints a count and never the value.
If it does, the owner rewrites the secret without it.

**The live figures.** The amendment says that `max_connections` and the
reserved settings have not been read off staging. TYRE-305 stays open until
the owner runs the U94 query (TYRE-368 comment 13436), posts the figures,
and confirms the DSN check. The code does not wait for either.

## 7. `/readyz` (TYRE-405, carrying TYRE-408)

**The bound.** `/readyz` answers from the last ping result while it is
younger than a stated bound, a named constant. *Lead's call:* 5 seconds,
half the gate's 10-second poll and the readiness probe's period. A failure
that starts just after a fresh "ready" is then visible within one poll.

**One ping per bound.** Requests that arrive while a ping is in flight wait
for that ping rather than starting their own. N concurrent hits inside the
bound cost at most one ping.

**Both outcomes are cached for the same bound.** Recovery from a failure
therefore also shows within one poll.

**The ping's context.** The shared ping runs on its own context with the
existing 2-second budget, never the first caller's request context. One
client disconnecting must not cancel the answer the others wait on.

**Unchanged:** the 200 and 503 bodies, `sha`, `revision`,
`Cache-Control: no-store` and the probe settings. The deploy gate's stubbed
tests stay green.

**The test.** A Go test with a counting pinger and an injectable clock, so
nothing sleeps. It proves:

- concurrent requests inside the bound trigger one ping;
- a request after the bound triggers one more;
- a failing pinger gives every waiter a 503.

**The comments.** `readyz.go`'s comments cite this spec's §7 (TYRE-408).

## 8. The registry (TYRE-402)

**The parameters.** `platform.bicep` takes the registry's name and resource
group as parameters. The defaults are staging's (`crtyrestaging`,
`rg-tyre-staging`), because both environments pull from it (ADR-0017).
`app.bicep`'s existing `acrName` default, `crtyre${env}`, has the same
defect. The builder aligns it to the same default.

**The grant crosses resource groups.** Production's AcrPull assignment
targets a registry in another resource group. From a resource-group-scoped
template, that needs a module scoped to the registry's group. Bicep refuses
a cross-scope extension resource otherwise.

**`app.bicep` must not read the registry.** It reads
`acr.properties.loginServer` from an `existing` registry in
`acrResourceGroup`. Production's deploy identity holds Contributor on its
own group only, so it cannot read staging's registry. `app.bicep` instead
takes the login server as a string parameter, `crtyrestaging.azurecr.io`
by default. The image pull still runs as the API's managed identity, under
the AcrPull grant above. This is a small fix in a file the branch already
changes, so it rides here (CLAUDE.md).

**Staging's grant must keep its identity.** The assignment's name is
`guid(acr.id, apiIdentity.id, roleAcrPull)`. That name, and the
assignment's resource ID with it, stays the same, so staging's live grant
is not recreated.

**The header comment.** It names the environment through `env`, not
`rg-tyre-staging`.

**The proof in the PR:**

- `make infra-lint` stays green;
- `az bicep build` of `platform.bicep` succeeds with the module;
- the plan states the what-if the owner runs against staging after merge,
  where the expected result is no change to the grant.

The what-if against production is TYRE-397's, before its first apply.

## What the owner does after merge

- Nothing is required for §2 to §5. `app.bicep` and the web deploy through
  CI.
- A what-if of `platform.bicep` against staging, expecting no change (§8).
- Run the U94 query and the DSN check, and post both on TYRE-305 (§6).
- Add the web origin to tyre-pwa's redirect URIs, for TYRE-317's first
  sign-in.
- Update Confluence page 10682399's "Still pending" line. Close-out may do
  it.

**A rollback** to a commit from before this PR ships a web without
`config.json` handling. That web calls relative `/api` and 404s, which is
staging's state today. It is accepted, since nobody signs in to staging
yet. §5's checks also fail on such a commit. The runbook records this
beside its existing note that earlier images fail the gate for want of
`/readyz`.

**The docs.** The implementer updates `docs/implementation-order.md`'s
TYRE-51 mention, which still describes U75's linked backend. Comment 13779
and the new ADR are the reference.

## Left to the builder

- In-house CORS middleware or `go-chi/cors`.
- The `Max-Age` value.
- The shape of the configuration failure.
- How the deploy writes the two files.
- The `img-src` and `font-src` directives the browser check finds.
- How the deploy job reads the API FQDN.
- The retry policy of the post-deploy checks.
