# ADR-0016: Identity provider and token-to-actor resolution

- **Status:** Proposed. Accepted once checks b and c2 on TYRE-317 pass (the
  design's stage 2).
- **Date:** 2026-09-30
- **Deciders:** Rourke
- **Related:** ADR-0011 (actor context, Option B; this closes its revisit
  trigger) · ADR-0001 and ADR-0002 (Entra External ID, the CIAM tenant) ·
  ADR-0009 (on-device data) · ADR-0012 (refusal envelope) · ADR-0014 (audit)
  · design `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md` ·
  TYRE-317, TYRE-373 · owner rulings U91, U100 to U104

## Context

ADR-0011 chose to take identity from the request and read the role from the
database on every request. It deferred three things to the identity
provider's own decision: which provider, how a signed-in subject finds its
tenant before any tenant is bound, and platform staff login.

ADR-0001 names Microsoft Entra External ID and ADR-0002 records its tenant.
The owner has since fixed the shape (U91, TYRE-317 comment 13423): the
provisioned email one-time passcode flow, 24-hour sessions, Go validating the
token, a subject column under RLS, pilot users created by hand, and a capture
outbox that holds through a 401. Microsoft fixes refresh tokens for SPAs and
for passcode sign-in at 24 hours, non-sliding, with no setting to change it.

Four constraints make the bootstrap non-obvious:

- **Rule 1.** RLS needs `app.tenant_id` bound before `app.app_user` can be
  read at all, and the CIAM `tid` is the one Entra tenant, not a platform
  tenant.
- **The suite.** Inside schema `app`, check 8c holds the `SECURITY DEFINER`
  allowlist at one entry, check 67a refuses any definer the application role
  can execute, and the policy-shape check refuses a second policy on a table.
  The suite's sweeps look only at schema `app`, so an object placed outside it
  would escape them, and nothing would prove it isolated.
- **The capture bundle.** The entry chunk had about five bytes of budget
  headroom on 30 Sep 2026, and the capture target makes every byte and every
  redirect a cost.
- **FR-AUT-015's reasoning in ADR-0011.** Option A was rejected partly
  because 30-day sessions would leave a deactivated user with weeks of
  access. TYRE-373 asks this ADR to revisit that.

## Options considered

### Option 1: bearer token, tenant as an Entra claim, proven by RLS

The SPA sends tyre-api's v2 access token on every call. Each person's Entra
account carries the platform tenant as a custom attribute, emitted as a
claim. The API binds the claim, then looks the user up by `oid` under
`tenant_isolation`, so a wrong claim finds no row and fails closed.

Attractive because it is the industry norm when each user belongs to one
tenant (Microsoft's multitenant identity guidance; AWS Cognito's), it keeps
the API stateless, it holds no secret, and it needs nothing the suite
refuses. **Its real downside:** the tenant is written in a second place,
Entra, outside Bicep and CI; one Entra account maps to one platform tenant;
emitting the claim needs `acceptMappedClaims`, which Microsoft allows only for
a GUID or verified-domain audience; and nobody has yet seen the mapped claim
in a real passcode-flow access token (TYRE-317, check c2).

### Option 2: bearer token, tenant named by the client, proven by RLS

As Option 1, but the SPA sends the tenant beside the token, learnt from a
per-tenant sign-in link. **Its real downside:** a driver who clears storage
is stuck until ops resends the link, and a tenant id sent from the device in
production reads like the dev bypass to every future reviewer. It is the
recorded fallback if the claim cannot be emitted: it reuses everything in
Option 1 except where the tenant comes from.

### Option 3: a Go session cookie after a server-side code exchange

Go becomes an OIDC client and issues a sealed HttpOnly cookie. Adds nothing
to the capture bundle and keeps tokens out of JavaScript. **Its real
downside:** Go takes on state, nonce, PKCE, callback, logout and CSRF,
needs an IdP secret with rotation, and cannot work deployed until the linked
backend exists. It still needs Option 1's or Option 2's tenant source.

### Option 4: Static Web Apps' built-in authentication

**Its real downside:** Go would trust a header rather than validate a
token, which is what U91 rules out, and the user id is per-app, not `oid`.

### Options 5 to 7: a definer resolver, a second policy, a mapping table outside `app`

Each resolves the subject before a tenant is bound. **Their real downside:**
inside schema `app`, a definer spends 8c's allowlist and fails 67a (Option 5
is ADR-0011's rejected Option C), and a second policy fails the policy-shape
check. Outside `app`, each would escape every sweep the suite runs and need a
new schema grant to the application role, which is disqualifying under rule 1
because nothing would then prove it isolated.

### Option 8: one tenant per deployment

**Its real downside:** it abandons multi-tenancy.

## Decision

**We will use Option 1: tyre-api's v2 access token as a bearer token on
every request, validated in Go, with the platform tenant carried as a claim
on each Entra user and proven by an RLS lookup of `app.app_user` by `oid`.**

1. **Identity key.** `oid`, with `tid` pinned to the CIAM tenant. Not `sub`,
   which is pairwise per app.
2. **Validation.** RS256 only; a `kid` required and resolved against the key
   set named in discovery, fetched with `?appid=` as Microsoft requires for
   mapped claims; discovery's issuer and the token's `iss` exactly equal to
   the configured issuer; `aud` tyre-api; `azp` tyre-pwa; `ver` 2.0; `scp`
   holding `access_as_user` as a whole element; `exp` required. golang-jwt
   v5.3.1 and keyfunc v3.8.0 (jwkset v0.11.3), within go 1.24.
3. **The seam changes shape.** `Identify(ctx, r)` returns `(Identity, error)`
   and `Identity` gains `Subject` and `SessionID`. TYRE-317 asked for the seam
   unchanged, which cannot hold: a subject is not a user id, and an identity
   provider that cannot be reached has to answer 503, not 401, or drivers are
   sent to a sign-in that cannot help. The resolver keeps its own record of
   whether a key set has loaded, because the library reports an unknown `kid`
   and an unloaded key set the same way.
4. **The dev header resolver is compiled out of the release binary** with a
   Go build tag (U103), and the `CONTAINER_APP_NAME` veto stays as a second
   layer. A CI check fails if the release binary names the dev headers.
5. **The tenant claim is a hint, never trusted.** `InActorTx` binds it, finds
   the user by subject under RLS, binds the actor it found, and refuses a
   tenant that is not `ACTIVE` (FR-TEN-009).
6. **Linking.** `app.app_user.subject` is written only by the provisioning
   runbook, as the database's owning role with `app.tenant_id` bound in the
   same transaction, so the link does not depend on that role bypassing RLS.
   The application role's column grants exclude `subject`.
7. **The web client** keeps the tokens in `localStorage` for their lifetime
   (U102), through a lazily loaded oidc-client-ts, and clears them when a
   renewal is refused or the user signs out. MSAL is rejected because from v4
   its `localStorage` cache does not survive a browser restart without "Keep
   me signed in".
8. **Held inspections are stamped** with the capturing driver's subject and
   send only under that driver's session (U104).
9. **Authentication events** (FR-AUD-004): passcode events in Entra's logs,
   refused tokens in the API's log, session starts in `app.audit_log`
   through `app.record_session_start()`. That function is the one writer of
   `app.audit_log` besides ADR-0014's trigger, and `SESSION_START` sits
   outside the trigger's `TG_OP` vocabulary because it records an
   authentication event, not a row mutation.
10. **`PLATFORM_ADMIN`** has no login in the POC.

**On FR-AUT-015.** With 24-hour sessions, Option A's window for a
deactivated user shrinks from weeks to hours, but ADR-0011's other reason
stands: `app.app_user` is the one register of who may do what, and a role in
the token would be a second. The role stays out of the token.

## Consequences

**Good:** the suite is unchanged, with 8c at one entry and 67a holding.
Deactivation bites on the next request. The API holds no identity-provider
secret and needs no session affinity (NFR-SCL-005). A session id exists for
FR-AUD-002. The deployed API cannot trust a dev header even if the runtime
veto regressed. The fallback (Option 2) costs only the tenant's source.

**Bad:** a driver signs in again at least daily, possibly with an emailed
code (check d). Tokens sit in browser storage on a personal phone, which
NFR-PRV-006 has to say. The capture entry takes a recorded budget rise.
Per-user tenant attributes are Graph state that CI cannot see. A person
needed in two tenants needs two Entra accounts. Passcode failures are visible
only in Entra. Signing out does not revoke an access token the API has
already accepted; it lapses within 90 minutes. On a shared phone, one
driver's held inspection waits until that driver signs in again. Local runs,
tests and CI must remember the build tag.

**Revisit when:** the mapped claim cannot reach tyre-api's access token
(take Option 2, back through the owner); a hand-made user cannot use the
passcode flow (U91 itself goes back to the owner); Static Web Apps strips
`Authorization` on the linked backend (TYRE-51), when the fallback is the
Container App's origin over CORS or a second header the resolver also
accepts; a person needs several tenants; a custom domain lands (TYRE-19),
which moves the issuer, redirect URIs and CSP; the marketplace's second
customer type is decided (ADR-0003); `PLATFORM_ADMIN` login or SSO
(FR-AUT-021) is taken on; the Go toolchain moves past 1.24 (TYRE-379).
