# Design: B9 sign-in (TYRE-317)

- **Date:** 2026-09-30
- **Ticket:** TYRE-317, the one open child of epic TYRE-2 (P1, Foundation:
  tenancy, RLS, auth, M1). TYRE-376 closes with it. It binds the session id
  that TYRE-201 needs.
- **Decisions it rests on:**
  - Owner rulings on TYRE-317:
    - U91 (comment 13423).
    - U100 to U102 (comment 13444).
    - U103 and U104 (30 Sep 2026, recorded on the ticket).
  - Planner defaults PD-S1 to PD-S3 (comment 13441), which stand unless
    vetoed.
  - ADR-0016 (identity provider and token-to-actor resolution), written with
    this spec.
  - ADR-0011 (actor context, Option B).
  - ADR-0009 (on-device data).
  - ADR-0012 (the refusal envelope).
  - ADR-0014 (the audit mechanism).
- **Requirements:**
  - Authentication: FR-AUT-001 and FR-AUT-016, as TYRE-373 amends them.
  - Audit: FR-AUD-002 and FR-AUD-004.
  - Tenancy: FR-TEN-009.
  - Offline: FR-OFF-012 to FR-OFF-014.
  - Security and scale: NFR-SEC-006, NFR-SEC-007 and NFR-SCL-005.
  - Privacy: NFR-PRV-006, as TYRE-373 amends it.

## Why this exists

Every deployed revision answers 401 to every `/api` call.

- The only resolver is `HeaderActorResolver`
  (`api/internal/httpapi/actor.go:29`), which trusts two headers.
- It is vetoed wherever `CONTAINER_APP_NAME` is present
  (`api/cmd/api/main.go:28`).

The pilot needs real people signing in on their own phones. This is therefore
the first sub-project of B9, and it gates a usable staging.

## What is already decided

| Ruling | What it fixes |
| --- | --- |
| U91 | Sign-in uses the Entra External ID email one-time passcode flow, as provisioned, with 24-hour sessions. Go validates the token and finds the user through a subject column under RLS. Pilot users are created by hand. The outbox holds a capture through a 401. |
| U100 | The access token travels as a bearer token on every call. Go validates it against Entra's published keys, holds no secret and needs no CSRF defence. The capture entry takes one recorded budget rise, and the sign-in library loads lazily. Whether Static Web Apps forwards the Authorization header is checked inside TYRE-51. |
| U101 | The platform tenant is a claim on each person's Entra account. It is set at provisioning and emitted in tyre-api's access token. The API binds the claim and then proves it: the lookup by `oid` runs under RLS, so a wrong tenant finds no row. If the passcode flow cannot carry the claim, the design goes back to the owner. |
| U102 | The session survives an app restart. The token is kept in browser storage for its lifetime, which is 24 hours at most. TYRE-373 amends NFR-PRV-006 and ADR-0009. |
| U103 | The dev header resolver is compiled out of the release binary with a Go build tag, not only vetoed at runtime. |
| U104 | Each held inspection is stamped with the driver who captured it and sends only under that driver's session. Following the norm for shared devices, a sign-in by anyone else is refused while another driver's inspection is held on the phone. |
| PD-S1 | A valid token for an unlinked or inactive user gets 403, which the outbox treats as permanent. The runbook has each pilot driver sign in once before their first field day. |
| PD-S2 | TYRE-373 covers the SRS rows that sign-in moves. FR-AUD-004 joins this ticket: session starts are recorded, refused tokens are logged, and passcode failures stay in Entra's sign-in logs. |
| PD-S3 | Sign-out is refused while the outbox or a draft holds an inspection. |

## What is not yet known

Some facts can only be checked in the CIAM tenant, which neither the repo nor
CI can reach. The owner runs these checks and posts the results on TYRE-317.

- **Check a.** tyre-api's requested access token version is 2. Record the
  redirect URIs and identifier URI as they stand (comment 13440).
- **Check b.** A user created by hand signs in through the passcode flow and
  is not asked for a password (comment 13440).
- **Check c.** Record a real tyre-api access token's `iss`, `aud`, `tid`,
  `oid`, `scp`, `sid`, `ver` and `azp` (comment 13440).
- **Check c2.** Posted with this spec. Map the custom tenant attribute into
  tyre-api's access token, as section 5 lists, and confirm the claim arrives
  and what name it arrives under.
- **Check d.** Does the daily re-sign-in after 24 hours email a new code
  (comment 13440)?

The design does not wait on these checks. Everything in stage 1 of
[Order of work](#order-of-work) can be tested locally with a test signing key
and a stubbed identity provider. Where a check gates something, the spec names
it at that point.

- **If c2 fails**, stage 2 stops. The owner is then offered ADR-0016's
  recorded fallback, Option 2, in which the client names the tenant. Option 2
  reuses everything in stage 1 except the claim read.
- **If b fails**, U91's premise fails: hand-made users and the passcode flow
  do not compose. Stage 2 stops, and the question goes back to the owner with
  no recorded fallback.
- **Check d** decides only TYRE-373's wording for FR-AUT-015. It gates
  nothing here.

## Scope

**In scope:**

- The bearer-token resolver and the seam change.
- The build tag that compiles out the dev header resolver.
- The subject link and its grants.
- The tenant-state refusal (TYRE-376).
- The session id and the session start: FR-AUD-002's binding and FR-AUD-004.
- The web token store, sign-in and sign-out.
- The outbox's behaviour when signed out, and the driver stamp.
- The provisioning runbook.
- The Container App and Static Web App settings.
- ADR-0016.

**Out of scope, each with the ticket that owns it:**

| Work | Ticket |
| --- | --- |
| The audit trigger writing `session_id` and `source_ip` (database lane) | TYRE-201 |
| An endpoint that deactivates a user | TYRE-377 |
| Removing tyre-api's unused Graph grant, and correcting Confluence pages 10682399 and 11042818 | TYRE-378 |
| The Go toolchain upgrade | TYRE-379 |
| Auditing writes to `app.app_user` | TYRE-98 |
| Routing, Authorization forwarding, the hop count and the web CSP | TYRE-51 |
| Deep links | TYRE-341 |
| A deploy that applies its settings | TYRE-79 |
| The staging migration runbook | TYRE-368 |
| The staging reset | TYRE-374 |
| The SRS errata | TYRE-373 |

`PLATFORM_ADMIN` gets no login in the POC (ADR-0011; H.1 has no ADM module).

## 1. The request path (Go)

### Configuration

Six non-secret environment variables configure the bearer resolver.

| Variable | Holds |
| --- | --- |
| `AUTH_DISCOVERY_URL` | tyre-api's OpenID discovery document with `?appid=<tyre-api client id>`. Microsoft requires that form when claims mapping is enabled, and its key set is the `jwks_uri` it names. |
| `AUTH_ISSUER` | The exact `iss` value that tokens must carry: `https://<tid>.ciamlogin.com/<tid>/v2.0`, confirmed by check c |
| `AUTH_TENANT_ID` | The CIAM tenant id, 9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19, checked against `tid` |
| `AUTH_AUDIENCE` | tyre-api's client id |
| `AUTH_CLIENT_ID` | tyre-pwa's client id, the only client allowed to call (`azp`) |
| `AUTH_TENANT_CLAIM` | The name of the claim that carries the platform tenant, from check c2 |

`main` reads them as follows:

- A variable counts as set when it is non-empty.
- **All six set:** each is format-checked. `AUTH_TENANT_ID`, `AUTH_AUDIENCE`
  and `AUTH_CLIENT_ID` must be UUIDs. The two URLs must be absolute `https`,
  except that a loopback `http` URL is accepted for tests. A malformed value
  stops startup, as a malformed `TRUSTED_PROXY_HOPS` does
  (`api/cmd/api/main.go:41`). `main` then wires the bearer resolver.
- **None set:** `main` wires no bearer resolver.
- **Some set:** startup is refused, because a partial configuration is a
  mistake.

A deployed revision with no resolver answers **503 `auth_unavailable`** to
every `/api` call and logs an error once at startup. It is not a 401, because
the web client reads 401 as "sign in", and a sign-in cannot help here (see
step 3 below). It does not crash either, because a crash-looping revision is
TYRE-79's defect.

### Validation

Every `/api` request under `requireActor` must carry
`Authorization: Bearer <token>`. The resolver runs these checks in order and
refuses on the first failure.

1. **Algorithm.** The token parses as a JWS whose `alg` is RS256. No other
   algorithm is accepted, so `none` and the HMAC algorithms cannot be
   substituted.
2. **Signing key.** The token must carry a `kid`; without one it gets 401
   before any key lookup. The key is chosen by `kid` from the loaded key set.
   An unknown `kid` against a loaded set triggers at most one refetch. The
   refetch runs under a limiter of one per five minutes, and a request never
   waits for the limiter longer than one second. If the limiter is spent or
   the refetch fails, the answer is 401, never 503.
3. **Discovery issuer.** The discovery document's `issuer` equals
   `AUTH_ISSUER`. A mismatch means the configuration is wrong. Every request
   then gets 503 and the log names both values. The answer is never 401,
   which would send drivers to a sign-in that cannot help.
4. **Token issuer.** `iss` equals `AUTH_ISSUER` exactly.
5. **Audience and client.** `aud` equals `AUTH_AUDIENCE`, and `azp` equals
   `AUTH_CLIENT_ID`.
6. **Version and tenant.** `ver` is `2.0`, and `tid` equals `AUTH_TENANT_ID`.
7. **Scope.** `scp`, split on spaces, has an element exactly equal to
   `access_as_user`.
8. **Time.** `exp` is present and in the future. If `nbf` is present, it is
   in the past. Both checks allow a leeway of at most two minutes. The leeway
   is a transport constant for server clock skew, commented with its reason;
   it is not tenant configuration.
9. **Identity key.** `oid` parses as a UUID. `oid` is immutable, the same
   across apps, and documented by Microsoft as usable as a database key.
   `sub` is pairwise per app and is not used.
10. **Tenant claim.** The claim named by `AUTH_TENANT_CLAIM` is present and
    parses as a UUID. If it is missing or malformed, the token is valid but
    the person has no platform access, so the answer is 403, not 401 (PD-S1).

**Libraries.** Three pinned versions, all within go 1.24. TYRE-379 owns the
toolchain upgrade.

- `github.com/golang-jwt/jwt/v5` v5.3.1.
- `github.com/MicahParks/keyfunc/v3` v3.8.0.
- `github.com/MicahParks/jwkset`, raised to v0.11.3 for its fix to the ECDSA
  parameter panic.

**Loading the keys.** keyfunc does no OIDC discovery. It also returns the same
error for an unknown `kid` as for a key set that never loaded. The resolver
therefore owns both jobs:

- **Discovery.** It fetches the discovery document itself, with a timeout of
  a few seconds.
- **Building the key set.** It builds the key set with
  `keyfunc.NewDefaultOverrideCtx`, with:
  - `HTTPTimeout` set to the same bound;
  - `NoErrorReturnFirstHTTPReq` set to false;
  - the refetch limiter and wait from step 2.
- **Laziness.** Both happen on the first request, behind a mutex, so that
  concurrent requests share one attempt.
- **Failure.** A failed attempt is not cached. Its context is cancelled, which
  ends the refresh goroutine, and the next request tries again.
- **When the answer is 503.** The resolver records whether a key set has ever
  loaded. It answers 503 while none has, or while discovery has failed or its
  issuer does not match.
- **After a successful load.** A failed background refresh keeps the cached
  keys, because jwkset replaces them only on success.

An unreachable Entra never stops startup.

### The seam

ADR-0011's seam changes shape. TYRE-317 asked for it "behind the existing
seam", which cannot hold literally; ADR-0016 records why.

```go
type Identity struct {
    TenantID  uuid.UUID // the dev header, or the token's tenant claim: a hint RLS proves
    UserID    uuid.UUID // dev resolver only
    Subject   uuid.UUID // bearer resolver only: the Entra oid
    SessionID string    // bearer resolver only
}

type ActorResolver interface {
    Identify(ctx context.Context, r *http.Request) (Identity, error)
}
```

Exactly one of `UserID` and `Subject` is set. `HeaderActorResolver` fills
`TenantID` and `UserID`, with its behaviour unchanged. The bearer resolver
fills `TenantID`, `Subject` and `SessionID`.

`requireActor` maps resolver errors to the envelope (ADR-0012):

| Condition | Status | Code |
| --- | --- | --- |
| No token, malformed token, no `kid`, bad signature, or wrong issuer, audience, client, version, tenant or scope; expired; unknown `kid` against a loaded set | 401 | `unauthorized` (existing) |
| A valid token with no usable tenant claim | 403 | `forbidden` (existing) |
| No key set loaded yet, discovery unreachable, a discovery issuer mismatch, or no resolver configured | 503 | `auth_unavailable` (new) |
| Any other resolver error | 500 | `internal` (existing), logged at error |

The registry changes with it:

- `api/internal/httpapi/refusal_codes.json` gains `auth_unavailable` (503) and
  `tenant_inactive` (403).
- The meaning of `forbidden` gains "a valid token with no usable platform
  tenant claim".

`TestRefusalCodesRegistryCoversGoWireVocabulary` then holds. ADR-0012's
2026-09-23 amendment already makes the registry the site table, so ADR-0012
itself does not change.

The two new message constants:

- `msgAuthUnavailable`: "sign-in is unavailable right now; try again shortly".
- `msgTenantInactive`: "this company's account is not active; contact your
  fleet office" (FR-TEN-009's explanatory message).

**Composing the resolvers.** `main` composes the two resolvers only in a
`devheader` build with the dev switch on. In that case a request that carries
`Authorization` goes to the bearer resolver, and any other request goes to the
header resolver.

### The dev resolver is compiled out (U103)

The header resolver and every string that names its headers move into files
built only with the `devheader` tag. This covers the resolver, `main`'s
wiring and its warning log. A `!devheader` counterpart supplies no resolver.

The `CONTAINER_APP_NAME` veto stays as a second layer.

These build with the tag:

- `make api-run`;
- the Go test targets, vet and staticcheck in `make` and CI;
- the API that CI's e2e job starts.

The release image builds without the tag. A CI step builds the release binary
the same way and fails if it contains `X-Tenant-ID` or `X-User-ID`.

### Logging a refusal

Every refusal is logged at warn with the reason and the client address
(`clientAddress`, `api/internal/httpapi/ratelimit.go`). The token is never
logged.

- **Refusals at steps 4 to 10.** The signature has verified, so the log line
  adds the `oid`, the tenant claim and the session id.
- **Refusals at steps 1 to 3.** The claims are unverified and could have been
  chosen by an attacker, so the log line carries only the `kid`.

`withActor` logs its `ErrNoSuchActor` and `tenant_inactive` refusals with the
tenant, the subject (or user id under the dev resolver) and the session id.

These log lines are FR-AUD-004's record of a failed authentication at the API
(section 3).

### Rate limit

`submitRateLimit` keys its per-account counter on `TenantID` plus `Subject`.
Under the dev resolver it keys on `TenantID` plus `UserID`
(`api/internal/httpapi/ratelimit.go:105`). Keying on `UserID` alone would put
every signed-in user in one bucket.

The per-address counter and `TRUSTED_PROXY_HOPS` do not change here. The
linked backend adds a hop, so TYRE-51 re-derives the count.

NFR-SEC-007's "authentication endpoints" now belong to Entra, which
rate-limits them itself (TYRE-373 erratum).

## 2. Tenant binding and the user link

### InActorTx

`store.InActorTx(ctx, key store.ActorKey, fn)` replaces the
`(tenantID, userID)` form. The key type is:

```go
type ActorKey struct {
    TenantID  uuid.UUID
    UserID    uuid.UUID
    Subject   uuid.UUID
    SessionID string
}
```

The store cannot import `httpapi`, which is why the key lives in `store`.
InActorTx returns an error, which `withActor` answers with 500, unless exactly
one of `UserID` and `Subject` is set: that is a programming mistake, not a
refusal. Every caller changes in the same PR: `withActor`, the only
production caller (`api/internal/httpapi/refusal.go:236`), and the test
callers in `store_test.go`, `admin_test.go`, `fitments_test.go` and
`units_test.go`.

InActorTx runs in one READ COMMITTED transaction, as it does now:

1. **Bind the tenant.** Bind `app.tenant_id` with `set_config(..., true)`.
   When the key carries a session id, bind `app.session_id` with
   `set_config(..., true)` as well.
2. **Look up the user.** Run
   `SELECT id, display_name, role, active FROM app.app_user WHERE subject = $1`.
   Under the dev resolver the lookup is `WHERE id = $1`.
   - `tenant_isolation` does the tenant check, so a wrong or forged tenant
     claim finds no row.
   - No row, or `active = false`, gives `ErrNoSuchActor` and a 403. As today,
     the client cannot tell the two cases apart.
   - No policy or view read here depends on `app.actor_id` being bound.
3. **Bind the actor.** Bind `app.actor_id` with `set_config(..., true)`, using
   the id the lookup found. `auth.Actor.UserID` is set from that id, which is
   what `/api/me` returns as `userId`.
4. **Check the tenant.** Run `SELECT state FROM app.tenant` through
   `tenant_self`.
   - Any state other than `ACTIVE`, including `PROVISIONING`, returns a new
     `store.ErrTenantInactive`. `withActor` maps it to 403 `tenant_inactive`.
   - The check runs after the actor resolves, so only a linked user learns
     the tenant's state.
   - This is TYRE-376's definition of done, and that ticket closes with this
     work. The Go test tenants set `ACTIVE`, as that ticket says. The seeded
     tenants are already `ACTIVE`.
5. **Load the depots,** as now.
6. **Record the session start** when the key carries a session id (section
   3). Under the dev resolver there is none, so nothing is written.

The design adds no `SECURITY DEFINER` function, no second policy on
`app.app_user` and no table outside schema `app`.

- Inside schema `app`, check 8c would have to spend its allowlist on a
  definer, 67a would refuse any definer `app_login` can execute, and the
  policy-shape check refuses a second policy.
- Outside `app`, an object escapes every one of those sweeps. That
  disqualifies it under rule 1, because nothing would then prove it isolated.

### Migration (next free number; 000052 at the time of writing)

TYRE-299 in the database lane may take 000052 and section 68 first. Take
whatever numbers are free when the branch is cut.

- **The column.** `app.app_user` gains `subject uuid`, nullable. A user exists
  before they first sign in, and `PLATFORM_ADMIN` rows never get one.
- **The index.** A partial unique index on
  `(tenant_id, subject) WHERE subject IS NOT NULL`. It is per tenant, like
  email, so the constraint never checks across tenants. The one Entra account
  to one tenant rule is enforced in Entra, where the tenant claim is
  single-valued and set by an admin.
- **The grants.** `app_rw` loses table-level `INSERT` and `UPDATE` on
  `app.app_user` and gets them back per column, on every column except
  `subject`.
  - Without this, any handler could re-link a login to another row, because a
    column-level REVOKE does not override a table-level grant.
  - The precedent is 000040's `app.inspection`.
  - The stamp trigger still writes `updated_at` and `updated_by`, because a
    column grant is checked against the statement's SET list.
  - `createUser`'s INSERT and its reactivate UPDATE
    (`api/internal/httpapi/admin.go:408` and `:372`) touch only granted
    columns.
  - Suite check 4 reads `has_any_column_privilege`, so it stays green with
    `app_user` on its allow-list.
- **The session-start function.** `app.record_session_start()` returns void.
  It is written in plpgsql, `SECURITY INVOKER`, with
  `SET search_path = app, pg_temp`, and takes no arguments.
  - It reads `nullif(current_setting('app.session_id', true), '')` and
    `app.current_actor_id()`, and raises if either is NULL.
  - It inserts into `app.audit_log`:
    - `tenant_id = app.current_tenant_id()`;
    - `actor_id` = the actor;
    - `action = 'SESSION_START'`;
    - `entity_type = 'app_user'`;
    - `entity_id` = the actor;
    - `session_id` = the session id;
    - `source_ip = nullif(current_setting('app.source_ip', true), '')::inet`,
      which stays NULL until TYRE-201 binds it.
  - The insert ends
    `ON CONFLICT (tenant_id, session_id) WHERE action = 'SESSION_START' DO NOTHING`.
  - That conflict target needs SELECT on `app.audit_log` and passes
    `tenant_isolation`, and `app_rw` holds both.
- **The session-start index.** A partial unique index on
  `app.audit_log (tenant_id, session_id) WHERE action = 'SESSION_START'`.
  Both new indexes lead with `tenant_id`, so check 37 passes.
- **The down file.** It runs `REVOKE INSERT, UPDATE ON app.app_user FROM app_rw`,
  which also clears the column grants, and then the table-level `GRANT`. It
  drops the function, both indexes and the column.
  - Prove it by catalogue, not by a suite run (`docs/lessons.md`,
    2026-09-15). The proof covers `has_table_privilege`,
    `pg_attribute.attacl` on `app.app_user`, `pg_index` and `pg_proc`.
  - Every `attacl` must be NULL.

### Who writes `subject`

Only the provisioning runbook writes `subject` (section 5). It runs as the
database's owning role: `postgres` locally, and the Flexible Server admin
`tyreadmin` in Azure.

The runbook binds `app.tenant_id` in the same transaction. The link therefore
works whether or not that role bypasses RLS; it does not rely on a bypass.

`infra/main.bicep:29` describes the admin credential as migrations-only.
PR C corrects that description to include provisioning.

The link, like every other write to `app.app_user`, is unaudited until TYRE-98
widens the audit trigger to that table. A comment on TYRE-98 names it as a
write the trigger must cover.

### Suite section (next free; 68 at the time of writing)

**Seeds.** `db/seeds/gen_seed_fixture.py` gives fixed subjects to one BAC
driver and one Second Fleet user. The subjects are md5-derived like the ids,
and a comment names the section. Seeds load as `postgres`, so the grant does
not block them.

The section runs as `app_login`. Each assertion runs after its own control:

- **Grants.** Control: `has_column_privilege(current_user, 'app.app_user', col, 'UPDATE')`
  is true for `active` and `display_name`. Assertion: the same call is false
  for `subject`, for both INSERT and UPDATE. The assertion names
  `current_user`, not `app_rw`, following the suite's convention
  (`db/tests/004_tests.sql:100`).
- **Writing the subject.** An
  `UPDATE app.app_user SET subject = ...` raises `insufficient_privilege`.
- **The index.** The partial unique index exists, with its predicate.
- **The tenant boundary.** Control: with BAC bound, a lookup by BAC's seeded
  subject returns one row. Assertion: with BAC still bound, a lookup by Second
  Fleet's seeded subject returns none.
- **The session start.** Inside a transaction that is rolled back:
  - `app.record_session_start()` called twice for one session leaves one row;
  - a second session adds one;
  - neither row is visible with Second Fleet bound;
  - a call with no session bound raises.

## 3. Session id and authentication events

### The session id

The session id is the token's `sid` when present, stored as `sid:<value>`.
Without `sid`, the API falls back to the token's `uti`, stored as
`uti:<value>`. A `uti` identifies one access token, which lasts 60 to 90
minutes, not a whole sign-in. Check c says which of the two applies.

InActorTx binds the id as `app.session_id` for every bearer request. Reading
it into the trigger's `app.audit_log` rows is TYRE-201's half of the work.
This work only makes it available, which is what TYRE-317's definition of
done asks.

### Authentication events (FR-AUD-004)

FR-AUD-004 says: "record every authentication event, successful or failed".
It is met in three places, and TYRE-373's erratum says so.

| Event | Where it is recorded |
| --- | --- |
| Passcode sent, entered, failed or locked out | Entra's sign-in logs. The API never sees these events. |
| A token refused by the API | The API's structured log (section 1). A refused token has no proven tenant, so it cannot be written to `app.audit_log` under RLS. |
| A session's first use | `app.audit_log`, action `SESSION_START`, through `app.record_session_start()` |

### Writing the session start once

Each session start is written once.

- `store.Store` keeps a set of session ids it has already recorded. The set
  lives in memory, holds up to 10,000 ids, and evicts the least recently used.
- The function is called only for an id that is not in the set.
- The call runs inside the request's transaction. The id joins the set only
  after the transaction commits, so a rolled-back request does not lose the
  event.
- Across replicas and restarts, the unique index turns a repeat into a no-op.

The result is at most one write per session per replica, not one per request.

### Reconciling with ADR-0014

`app.record_session_start()` becomes the one writer of `app.audit_log` other
than the trigger.

- It records FR-AUD-004 authentication events, not FR-AUD-001 mutations.
- `SESSION_START` sits outside the trigger's `TG_OP` vocabulary.

ADR-0014 gets a pointer to ADR-0016 beside its paragraph on `session_id`.

## 4. The web client

### Library

The client uses oidc-client-ts, loaded lazily, with its user store set to
`localStorage`. The library's default store is `sessionStorage`, so the
setting is explicit.

MSAL was the obvious choice, and it is rejected:

- From v4, MSAL encrypts its `localStorage` cache with a key held in a
  session cookie (msal-browser `docs/caching.md`).
- The session therefore dies when the browser closes, unless the user picked
  "Keep me signed in".
- A phone's OS closes the browser often, so MSAL would put an emailed code in
  front of most cold starts, against U102.

### Where the code lives

- `web/src/auth/oidc.ts` is the only file that imports oidc-client-ts. It is
  reached only through a dynamic import from the token store. The existing
  files in `web/src/auth/` stay in the entry chunk.
- The token store is `web/src/api/token.ts`, in the entry chunk, under a
  kilobyte gzipped.
- `VITE_AUTH_AUTHORITY`, `VITE_AUTH_CLIENT_ID` and `VITE_AUTH_API_SCOPE` are
  declared as optional strings in `web/src/vite-env.d.ts`. An undeclared key
  would be typed `any`, and neither `strict` nor the no-`any` gate would
  catch it.

### The token store

**The mirror.** The token store reads a mirror from one `localStorage` key:
`{ accessToken, expiresAt, subject, tenantId }`. The auth chunk writes the
mirror after every sign-in and renewal. The entry never reads the library's
own storage format.

**Expiry.** A token counts as expired 60 seconds before `expiresAt`, so none
expires in flight.

**Renewal.** With no usable token, the store renews:

- **One attempt at a time.** Concurrent callers share one in-flight renewal
  promise.
- **No refresh token stored.** `renew()` returns null without calling
  `signinSilent`. Otherwise the library would fall back to a hidden iframe on
  `/`, because `silent_redirect_uri` defaults to `redirect_uri`.
- **The identity provider refuses the refresh token.** This covers
  `invalid_grant`, when the 24-hour refresh token has lapsed. `renew()` calls
  `removeUser()`, clears the mirror and returns null. The ID token carries the
  person's name and email address, so nothing then outlives the session
  (U102).
- **`renew()` returns null,** for either reason. The call throws
  `ApiError(401, code "signed_out")` without touching the API.
- **Renewal fails for want of a network.** The call throws the network
  error, so the outbox reads it as offline. The app does not claim the driver
  is signed out.

**A failed import of the auth chunk is a network failure, never a reason to
reload.**

- `web/src/shell/chunkReload.ts` exports a suppression handle,
  `suppressReloadWhile(promise)`. Its handler checks the handle before
  reloading.
- The token store holds the handle across its own import. The rule of never
  calling `preventDefault` stands for the route chunks.
- Once, after the first render, while online and with a stored session, the
  store warms the auth chunk. A later renewal in a dead zone then resolves
  from the module map.

**Sending.** `send()` in `web/src/api/client.ts` attaches
`Authorization: Bearer`. On a 401 from the API it clears the mirror, so the
next call renews.

### The redirect callback

On app load, a URL on `/` that carries `state` together with either `code` or
`error` is handed to `completeSignIn()` before the app renders. The query is
then removed with `history.replaceState`, whether or not sign-in succeeded.

- **Success.** The app goes to the path that `signIn()` stored in the
  request's state, falling back to `/` if that path is absent or not
  same-origin. The redirect URI itself stays `/`, so sign-in does not wait on
  TYRE-341's deep links.
- **Failure.** The sign-in screen shows one line saying the sign-in did not
  finish, together with the button.

### The auth chunk

The `UserManager` is configured as follows:

- authorization code with PKCE;
- scopes `openid profile offline_access` plus tyre-api's `access_as_user`;
- redirect URI and post-logout redirect URI both `/`;
- `automaticSilentRenew: false`, set explicitly because the library defaults
  it to true;
- no session-monitor iframe and no userinfo call.

The chunk exports `signIn()`, `completeSignIn()`, `renew()` and `signOut()`.

### Signing in

`ActorState` gains a `failure` field:

`'signed-out' | 'not-set-up' | 'tenant-inactive' | 'unavailable' | null`

It is derived from the `me` query's error. The `me` query does not retry a 401
or 403, so a signed-out driver is not kept waiting through retries.

| `failure` | When | What the app shows |
| --- | --- | --- |
| `signed-out` | 401 | The sign-in screen replaces the routes, but only when this page load's first `/api/me` settles with 401. The screen has one sentence, one "Email me a sign-in code" button at 56 to 64px (NFR-USE-004), and the count of inspections waiting. The button calls `signIn()`, a top-level redirect to Entra. |
| `not-set-up` | 403 `forbidden` | A screen saying the account is not set up and to contact the fleet office (PD-S1). |
| `tenant-inactive` | 403 `tenant_inactive` | A screen with `msgTenantInactive`. |
| `unavailable` | 503 `auth_unavailable` | A screen saying sign-in is unavailable right now. It never shows the sign-in button. |

**The prompt never interrupts a capture.**

- A later 401, from a refetch or any other call, keeps the current screen. The
  shell shows a non-blocking line with a "Sign in" button.
- On `/capture/*`, a 401 never unmounts `CaptureFlow`. A capture that fails to
  submit goes to the outbox, as today. When loading a vehicle fails with 401,
  the message is "Sign in to load this vehicle", not the signal message.
- Nothing redirects on its own.

The final copy for these screens is written in the plan, under `/unslop`.

### The outbox and the driver stamp (U104)

**Stamping.** Each draft and each outbox entry records the capturing driver's
subject, taken from the mirror when the draft starts. The capture payload does
not change: the server still attributes the inspection to whoever sends it, so
the client ensures that is the driver who captured it.

**One driver on the phone at a time.** This follows the norm for shared
devices: a previous user's unsent work goes only under that user's identity,
and the next user's sign-in is refused until it has gone. Discarding it is
never automatic. The sources are SAP's offline OData SDK and SAP Service and
Asset Manager, which fail the next login and name the previous user, and
Apple's Shared iPad, which fails a new sign-in while a user's data is still
unsynced. SAP calls sending under the next user a security concern, and 21 CFR
Part 11 and the MHRA's data integrity guidance both require records to be
attributable to the person who made them.

- After `completeSignIn()`, the token store compares the new subject with the
  stamps on the draft and on every outbox entry.
- If any stamp differs, the sign-in is undone through the full `signOut()`,
  including the end-session redirect. Ending the Entra session matters,
  because otherwise the next tap of "Sign in" would sign the same person
  straight back in.
- Before that `signOut()`, the token store writes a one-shot marker to
  `sessionStorage`. When the app comes back from the end-session redirect,
  the sign-in screen reads the marker, clears it, and says: "Inspections
  captured by another driver are waiting on this phone. They need to sign in
  here to send them before anyone else can use it." Without the marker, the
  screen shows only its neutral count of waiting inspections, because a
  driver whose own session lapsed must not be told the work is someone
  else's. The message names nobody, because the phone keeps the other
  driver's id, not their name.
- As a second guard, `attemptSend` refuses to send an entry whose stamp
  differs from the session's subject.
- An entry or draft with no stamp predates this change. Production has none,
  because staging has never let anyone sign in, and such an entry sends under
  the current session.
- If that driver never comes back, the phone stays blocked for the app until
  someone clears its site data by hand. That is an explicit act on the phone,
  not a silent discard by the app (FR-OFF-014). ADR-0016 records it as an
  accepted edge.

**What does not change.**

- `classify()` keeps 401 retryable, and the pin at
  `web/src/capture/outbox.test.ts:83-89` holds.
- The backoff stays as it is.

**After sign-in.** `completeSignIn()` is followed by a flush that:

- ignores the backoff for entries that are queued or held on a 401;
- never resends a failed entry, which keeps its own recovery action.

**The indicator.**

- **`OutboxIndicator`.** When any waiting entry for the current driver has
  `lastStatus` 401, it adds a line, "Sign in to send N", with a "Sign in"
  button beside "Sync now".
- **`CaptureDone`.** `CaptureFlow` passes `lastStatus` to `CaptureDone`,
  whose queued state reads "Inspection saved. Sign in to send it." when the
  status is 401.

### Signing out

A plain "Sign out" button sits beside `ActorBadge` in the shell header. It is
new, uses no Radix, and counts towards the entry rise. It imports the auth
chunk's `signOut` lazily.

The PD-S3 guard lives on this button, not in `signOut()`. `signOut()` itself
is unconditional, because the U104 undo has to sign a person out while
another driver's inspections are held.

**When sign-out is refused.** It is refused while a draft or any outbox entry
exists, whether queued, sending or failed (PD-S3). The refusal renders inline
beneath the button, with a role of status. It says how many inspections are
waiting and that sign-out comes back once they have sent, or once one the
office has refused is removed.

**When sign-out goes ahead,** it:

1. clears the mirror, the library's store and every `tyre.branding.*` key;
2. redirects to Entra's end-session endpoint.

**What sign-out cannot do.**

- It cannot revoke an access token the API has already accepted. That token
  lapses within 90 minutes.
- `app.app_user.active` is the revocation, and TYRE-377 adds the endpoint for
  it. Disabling the Entra account is the backstop.

### Cached state

The query cache lives in memory, and every change of identity reloads the
page, whether by redirect or by the dev switcher.

The one persisted cache is `ThemeProvider`'s branding. Its key is
`tyre.branding.${getDevTenantId() ?? "default"}`, which in production is the
same for every tenant. The fix:

- In production the key becomes the signed-in tenant, taken from the mirror.
- Sign-out removes every `tyre.branding.*` key.
- Under vite dev the key stays on the dev tenant.

### The bundle

The dev header branch in `send()` moves inside `if (import.meta.env.DEV)`, so
that Vite drops it from production builds.

A new check, `scripts/check-dist-dev-strings.mjs`, runs under `make
web-bundle`. It fails the build if the production `dist` contains
`X-Tenant-ID`, `X-User-ID` or `tyre.dev.`. This makes TYRE-317's "absent from
production builds" testable for the web.

The rise is measured after the change and recorded once, with
`npm run bundle:check -- --record` and a reason in the PR
(`scripts/check-capture-bundle.mjs:100`).

### Development and e2e

- **In a DEV build (vite dev and vitest),** `send()` takes the bearer path
  only when the DEV-only flag `localStorage["tyre.dev.auth"] = "bearer"` is
  set. Otherwise it attaches whatever dev headers exist, possibly none, as
  today, and never imports the auth chunk. The 31 test files that stub `fetch`
  keep working.
- **A production build** has only the bearer path.

## 5. Provisioning and Entra configuration

### The runbook (`docs/runbooks/provision-a-user.md`, new)

Every SQL step runs as the owning role (section 2), inside
`BEGIN; SELECT set_config('app.tenant_id', '<tenant>', true); ...; COMMIT;`.
Each step expects the stated row count and otherwise runs `ROLLBACK` and
stops.

1. **Confirm the tenant.** `SELECT state FROM app.tenant` returns `ACTIVE`,
   because TYRE-376 refuses `PROVISIONING`.
2. **Create the person in the External ID admin center,** or by Graph, in
   whatever shape check b proves works with the passcode flow. Then set their
   tenant attribute by Graph:
   `PATCH /users/{oid}` with
   `{"extension_<b2c-extensions-app id without hyphens>_<name>": "<tenant id>"}`.
   Run this as the owner's own delegated session (Graph Explorer or
   `az rest`), never as tyre-api. Record the exact extension name on
   Confluence page 10682399.
3. **Read their object id.**
4. **Create their `app_user`** through the platform's admin surface, with the
   same email address.
   - A tenant's first `ORG_ADMIN` has nobody to invite them. They are
     inserted by SQL instead:
     `INSERT INTO app.app_user (tenant_id, email, display_name, role) VALUES ('<tenant>', '<email>', '<name>', 'ORG_ADMIN')`,
     expecting one row.
5. **Link the subject:**
   `UPDATE app.app_user SET subject = '<oid>' WHERE lower(email) = lower('<email>') AND subject IS NULL RETURNING id`,
   expecting exactly one row.
6. **Check the link.** Have the person sign in once before their first field
   day, and confirm the app greets them by name. A linking mistake then shows
   up before any capture exists (PD-S1).

**A rehire with a new Entra account.** An admin first reactivates the user in
the app; `createUser` reactivates by email and keeps the old subject. Then:

`UPDATE app.app_user SET subject = '<new oid>' WHERE lower(email) = lower('<email>') AND subject = '<old oid>'`,

expecting one row.

**A leaver.** Until TYRE-377 lands, run
`UPDATE app.app_user SET active = false WHERE id = '<id>'`, expecting one
row. Then disable the Entra account.

### Entra settings

These are owner actions, done once and recorded on Confluence page 10682399.

**tyre-api:**

- Requested access token version 2.
- `acceptMappedClaims` set to true.
- The `access_as_user` scope, as provisioned.
- Microsoft accepts `acceptMappedClaims` only when the requested audience is
  the app's GUID or an identifier URI in a verified domain. Otherwise it
  returns `AADSTS501461`.
  - Check a records the identifier URI. If check c2 returns that error, change
    the identifier URI (and `VITE_AUTH_API_SCOPE`) to
    `https://<tenant>.onmicrosoft.com/tyre-api` and run c2 again.
  - A custom signing key would also satisfy it, but would change the key set
    Go trusts.
  - This is a configuration fix. It is not a failure of U101.

**The tenant claim:**

- A custom user attribute for the platform tenant.
- It is added in tyre-api's enterprise app, under Attributes and Claims, with
  source "Directory schema extension".
- Its emitted name goes into `AUTH_TENANT_CLAIM`.

**tyre-pwa:**

- SPA redirect URIs `http://localhost:5173/` and the Static Web App's origin
  `/`, and nothing else. Remove `https://jwt.ms` and any implicit-grant
  setting added for checks b and c once their results are posted.
- Admin consent to tyre-api's `access_as_user`.

**The Graph grant** comes off tyre-api (TYRE-378).

### Deployed settings

- **The Container App.** The six `AUTH_*` variables stay out of
  `infra/main.bicep` until stage 2 has real values. A revision deployed in
  between has no resolver, and it answers 503. Once added, they reach the
  running revision only after TYRE-79 makes the deploy apply the template
  rather than `update --image`.
- **The web build.** `.github/workflows/deploy.yml` passes the three
  `VITE_AUTH_*` values to `npm run build`. They are public identifiers, not
  secrets.
- **The web CSP.** The web origin sends no Content-Security-Policy today; the
  API's own (`api/internal/httpapi/security.go`) covers only its JSON
  responses. The web CSP belongs to TYRE-51, and its `connect-src` must allow
  the `ciamlogin.com` host for the token endpoint.

## 6. Security notes

**What is stored.** `localStorage` holds the access, refresh and ID tokens and
the mirror.

- The ID token carries the person's name and email address, because
  `profile` is requested so that tokens carry `oid` and `tid`.
- Any script on the origin can read these values. The mitigations are the ones
  already in place: no third-party scripts, fonts self-hosted
  (`web/src/theme/fonts.ts`), and the future CSP.
- U102 accepts the remaining exposure. TYRE-373's NFR-PRV-006 notice names the
  fields.
- Nothing survives the session, because a refused renewal and a sign-out both
  clear the tokens.

**A stale token grants nothing.** The session lasts at most 24 hours. The API
re-reads the role, the active flag and the tenant state on every request
(ADR-0011), so a stale token cannot grant anything the database has since
withdrawn.

**One Entra account maps to one platform tenant.** A trainer who is needed in
the demonstration tenant (U92) needs a second email address.

**Shared phones.** The driver stamp (U104) refuses anyone else's sign-in while
one driver's inspections are held, so a lapsed session cannot send them under
another name. PD-S3 keeps an explicit sign-out from stranding them.

**iPhone home-screen apps** keep their own storage and may complete the
redirect in Safari instead of in the app. No manifest ships yet (TYRE-154), so
today the app runs only in the browser. Check d tests both cases.

**The Authorization header.** If Static Web Apps strips it on the linked
backend (TYRE-51), there are two fallbacks. The client can call the Container
App's origin directly with CORS, or the token can travel in a second header
that the resolver also accepts. The header name is one constant in web and
one in Go.

## 7. Testing

### Go unit tests

These run against an `httptest` server that serves a discovery document and a
key set for a test RSA key. Tokens are minted per case.

**Refused with 401:**

- expired;
- `nbf` in the future;
- no `kid`;
- a wrong `aud`, `azp`, `iss`, `tid` or `ver`;
- `scp` of `access_as_user_admin`, and an `scp` without `access_as_user`;
- `alg` none, and HS256;
- a malformed `oid`;
- an unknown `kid` against a loaded set, with the limiter spent, which refuses
  within its bound.

**Refused with 403:** a tenant claim that is missing or malformed.

**Refused with 503:** discovery unreachable on the first request, which then
recovers on a later one; and a discovery issuer mismatch.

**Accepted:** a valid token. A background refresh that fails after a good load
keeps validating with the cached keys.

**Logging.** `slog` output is captured for a forged token and for a token that
fails at step 5. The first carries no `oid`, the second carries it, and
neither carries the token text.

**Other unit tests:**

- `main_test.go` covers every configuration case: all set, none set, some set,
  present but empty, and malformed.
- `main_test.go` also covers the composition under the build tag.
- `TestRefusalCodesRegistryCoversGoWireVocabulary` holds.
- A new unit test sits beside `TestSubmitRateLimitMiddlewareRefusesOverLimit`.
  It shows that two subjects in one tenant land in separate buckets.
  `TestRequireActorRunsBeforeInlineRateLimitMiddleware` changes only for the
  new signature.

### Go integration tests, against a real Postgres

- A linked user resolves, and `/api/me` returns their id.
- An unlinked subject gets 403, and so does an inactive user.
- A tenant claim that names another tenant gets 403. This is the RLS proof.
- `SUSPENDED`, `CLOSED` and `PROVISIONING` tenants get 403 `tenant_inactive`.
  An `ACTIVE` tenant resolves.
- The session start is written once across two requests. A rolled-back
  request writes nothing and does not mark the session as recorded.
- The dev resolver's tests pass with the tag, updated only for the new
  signature.

### Database

The suite section described in section 2.

### Build

- The release binary contains no header names.
- The `dist` check passes.
- `make check` is green.

### Web, vitest

**The token store:**

- a valid token;
- a token near expiry;
- three concurrent calls, which share one renewal;
- no refresh token, which gives a 401;
- `invalid_grant`, which clears storage and gives a 401;
- a network failure, which stays a network failure;
- a failed auth import, which neither reloads nor reads as a 401.

**Sending:** `send()` attaches the bearer and clears the mirror on a 401. With
the DEV flag unset, it never imports the auth chunk.

**The callback:** success, an error return, and a replay after the query has
been removed.

**`ActorState`:** each `failure` value.

**The outbox:**

- a sign-in as a different subject, with a held entry or draft, is undone
  through `signOut()`, and the screen shows the waiting message only when the
  one-shot marker is present, clearing it on first render;
- a lapsed driver whose own entries are held sees the neutral count, not the
  waiting message;
- `attemptSend` refuses an entry stamped for another subject;
- the post-sign-in flush skips failed entries;
- the 401 copy in `OutboxIndicator` and `CaptureDone`.

**Sign-out:** refused while any entry or the draft exists, and when it goes
ahead, it clears the branding keys.

### Playwright auth project

The project is `auth`, and its spec is `web/e2e/auth.spec.ts`.

**Set-up:**

- It runs on the Pixel 7, matched by `testMatch: /auth\.spec/`. The other
  four projects add `auth\.spec` to `testIgnore`.
- It sets the bearer flag before each test.
- The stub values for `VITE_AUTH_*` come from a committed
  `web/.env.development`, which points at a non-routable host,
  `https://idp.test/`. They are harmless to every other dev session, because
  the DEV rule never loads the auth chunk without the flag.

**Mocking.** This project is the one documented exception to
`web/CLAUDE.md`'s rule that e2e specs never mock, and that file is amended to
say so. The reasons:

- The identity provider cannot be reached from CI.
- The Go half of sign-in is proved by its own tests.

**How the stubs work.**

- `page.route` stubs the identity provider's discovery, authorize, token and
  end-session endpoints. The authorize stub redirects to `/` with the
  request's `state`.
- For API calls, the handler first asserts that the bearer is present. It then
  continues to the real API with `Authorization` removed and the Sandbox Fleet
  dev headers added, or returns a 401 where a case needs one.

**Cases:**

- Opening the app while signed out shows the sign-in screen. The button goes
  to the authorize endpoint with PKCE, the right client and scopes, and the
  redirect `/`.
- The callback completes, and `/api/me` is called with the bearer.
- A sign-in started from `/capture/:id` returns there with the draft
  restored.
- An error callback shows the "did not finish" line.
- A submit refused with 401 is held, reads "Sign in to send", and sends after
  sign-in.
- A sign-in as a different subject while an entry is held reaches the
  end-session endpoint, returns to the sign-in screen with the waiting
  message, and leaves the entry unsent.
- Sign-out is refused while an entry is held. Once the outbox is empty,
  sign-out reaches the end-session endpoint and clears the mirror.

### Staging smoke, by hand, in Sandbox Fleet

1. Provision one person by the runbook.
2. Sign in on a phone.
3. Submit an inspection.
4. Read the `SESSION_START` row, with the tenant bound.
5. Sign out.
6. Confirm the app gets 401 afterwards.

## Order of work

1. **Now, needing nothing external.** The code lands as three pull requests:
   - **PR A, database and API.** The migration, the seeds and the suite
     section; the bearer resolver, the seam, `InActorTx` with TYRE-376, the
     session start, the rate-limit key and the build tag.
   - **PR B, web.** The token store, the auth chunk, the screens, the stamp,
     sign-out, the `dist` check and the Playwright auth project.
   - **PR C, the runbook draft and the Bicep description fix.**

   The plan may split these PRs differently, with its reason written down.
   With no `AUTH_*` values deployed, the API answers 503 and the web shows
   "unavailable", so merging stage 1 changes nothing a user can reach.
2. **After checks a, b, c and c2 pass on TYRE-317.**
   - The real issuer, discovery URL, claim name and client ids go into Bicep,
     and the authority, client id and scope go into `deploy.yml`'s build.
   - The runbook is finished.
   - ADR-0016 moves to Accepted.

   If b or c2 fails, work stops and the question goes back to the owner, as
   set out under [What is not yet known](#what-is-not-yet-known).
3. **After TYRE-79 and TYRE-368, which puts staging at a head that includes
   this migration.** Also needed: TYRE-374, with Sandbox Fleet provisioned and
   `ACTIVE`, and then TYRE-51 with TYRE-341. Then the staging smoke runs.

## Documents this changes

**ADRs:**

- `docs/adr/0016-identity-provider-and-token-to-actor.md` is new. It is
  Proposed with this spec and moves to Accepted in stage 2.
- ADR-0011: this spec corrects its stale lines on Entra, meaning its context,
  its good consequences and decision 3. Its revisit trigger now points at
  ADR-0016.
- ADR-0014: this spec adds a pointer to ADR-0016 beside its paragraph on
  `session_id`.
- ADR-0009: amended in PR B, the change that puts tokens in storage, citing
  U102. Decision 2, the consequences and action item 6 say that session
  tokens are held in `localStorage` for at most 24 hours.

**Updated in the PR that makes them false:**

- `docs/architecture.md`: the diagram label, the request-path sketch and the
  ADR index.
- `api/CLAUDE.md`: the dev resolver section.
- `web/CLAUDE.md`: the e2e mock exception and the auth chunk.
- The header comment in `web/playwright.config.ts`.
- `api/internal/httpapi/refusal_codes.json`.
- The admin credential's description at `infra/main.bicep:29`.

**TYRE-373's errata,** pasted by hand. The list grows to:

- FR-AUT-001, 012, 013, 014, 015, 016 and 017;
- FR-AUT-010, noting that an invite takes effect only after the Entra account
  and the subject link exist;
- NFR-SEC-003, and the authentication half of NFR-SEC-007;
- FR-AUD-004's three places;
- the NFR-PRV-006 notice and its fields;
- UC-05, where a `PROVISIONING` tenant's users cannot sign in.

**Posted on the board with this spec:**

- on TYRE-317: the amended definition of done, check c2, and rulings U103 and
  U104;
- on TYRE-373: the additions above;
- on TYRE-51: the Authorization-forwarding check, the hop count and the web
  CSP's `connect-src`;
- on TYRE-201: that `app.record_session_start()` reads `app.source_ip` too;
- on TYRE-98: that the subject link is an `app_user` write the trigger must
  cover.
