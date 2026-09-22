# Architecture

A companion to the ADRs, not a substitute. This page says how the pieces fit;
the ADRs say why each was chosen and what it costs.

## Shape

```
   phone (PWA)                    browser
        │                            │
        │  online-first reads        │
        │  durable submit outbox     │
        ▼                            ▼
   ┌─────────────────────────────────────┐
   │  Azure Static Web Apps              │   React + Vite
   │  capture app  │  manager dashboard  │
   └──────────────────┬──────────────────┘
                      │  HTTPS. Target: JWT from Entra External ID
                      │  (FR-AUT-001). Today: the dev header actor
                      │  resolver is the only one built (ADR-0011)
                      ▼
   ┌─────────────────────────────────────┐
   │  Azure Container Apps  (Go)         │   scale-to-zero
   │  auth → actor context → handlers    │
   └──────────────────┬──────────────────┘
                      │  pgx, one transaction per request
                      │  SET LOCAL app.tenant_id + app.actor_id
                      │  role read from app_user, never from a claim
                      ▼
   ┌─────────────────────────────────────┐
   │  Azure Database for PostgreSQL 16   │
   │  RLS · valuation fns · exception    │
   │  views · append-only grants         │
   └─────────────────────────────────────┘
                      │
              Blob Storage (photos)
```

## Where logic lives, and why

**The database is not a persistence layer here. It is the domain model.**

Valuation, the exception rules, the governing-tread derivation and tenant
isolation are all implemented in PostgreSQL — as functions, views, constraints
and policies. This is a deliberate inversion of the usual layering, and it is
load-bearing for three reasons:

1. **The acceptance gate is cent-exactness.** FR-VAL-006 requires reproducing a
   2021 valuation to the cent. That is defensible when there is exactly one
   implementation of the arithmetic, in a language with a real decimal type,
   with a test suite pinned to fifteen worked examples. It stops being
   defensible the moment a second implementation exists in Go "for speed".
2. **Isolation must survive application bugs.** A leak is the one existential
   risk (R3). A policy in Postgres holds even if a handler forgets a
   `WHERE tenant_id = ?`. Application-layer isolation is one missing clause
   away from a breach.
3. **Immutability must survive future engineers.** Readings are append-only
   because `UPDATE` and `DELETE` are *revoked* from the app role. That is a
   property of the database, not a convention someone can quietly break.

So: **if it is a rule about tyres, it goes in SQL with a test in `db/tests/`.
If it is about HTTP, auth, or moving bytes, it goes in Go.**

## Actor context — the critical path

Every scoped request, without exception:

```go
// Transaction-local, so a pooled connection cannot carry one tenant's context
// into the next request — a session-scoped SET here is a cross-tenant data
// leak that will pass every test you write. set_config with is_local => true,
// not SET LOCAL: SET cannot take a bind parameter, and interpolating an id
// into SQL is forbidden on this path.
tx, err := pool.Begin(ctx)
defer tx.Rollback(ctx)
_, err = tx.Exec(ctx,
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)",
    identity.TenantID, identity.UserID)
// role, active and depot scope are read back from app.app_user /
// app.v_actor_depot under RLS in the same transaction — never taken from the
// caller, so a stale token or a forged header cannot grant anything.
// ... all queries on tx ...
tx.Commit(ctx)
```

`api/internal/store` (`InActorTx`) is the real implementation; this sketch
exists so the shape is visible from the architecture page. `InTenantTx` binds
`app.tenant_id` alone and is kept for tenant-scoped work with no actor to
resolve — nothing in the API currently takes that path; every handler binds
an actor through `InActorTx`.

`app.current_tenant_id()` and `app.current_actor_id()` both return NULL when
unset, and every policy compares with `=`. NULL matches nothing, so a request
that skips this step sees zero rows rather than everything. The actor lookup
fails closed the same way: an identity naming no visible, active
`app.app_user` row resolves nothing, and `withActor` turns that into a 403
indistinguishable from an ordinary refusal (ADR-0011). **The system fails
closed.**

## The refusal vocabulary (ADR-0012)

`httpapi.refusalForPgError` sorts every SQLSTATE `submitInspection` can see
into three groups: TY-prefixed codes (ADR-0012's own vocabulary, raised in
SQL where a rule is evaluated, forwarded verbatim because the message is
ours), the standard integrity violations (`23502`, `23503`, `23514`,
`22P02`, `22023`, `22007`, `22008`, canned as 422 so a client mistake never
reads as a 500 the outbox retries forever, ADR-0009), and everything else
(defaults to 500, the honest answer for an invariant breach). A blanket
`23503` is safe across every write path because the message is canned: a
foreign-key violation means the request named something that does not
exist, and 422 with no schema object in it is the honest answer wherever it
is raised. `TY001`/`TY002` (DR-020 odometer plausibility) never reach the
map: both are trapped inside `app.submit_inspection`'s own exception block
and turned into an `app.inspection_warning` row. `TY010` (no tenant/actor
bound) is also absent, because that is a genuine invariant breach, not a
client mistake.

The TY code ledger, migration by migration:

| TY code | Migration | What it refuses |
| --- | --- | --- |
| TY003 | 000023 | a duplicate submit inside the tenant's configured window (FR-INS-038) |
| TY004 | 000023 | a reading naming a position outside its vehicle's configuration |
| TY005 | 000023 | a payload shape `app.submit_inspection` can name directly (missing/empty arrays, out-of-range values) |
| TY006 | 000023 | a reading whose position expects a different measurement |
| TY007 | 000023 | an unrecognised or cross-tenant `vehicle_id` |
| TY008 | 000024 (widened 000028) | a configuration or unit-kind change on a unit with history; no route can reach it, so no `submitStatus` entry exists |
| TY009 | 000025 | `fitment_odometer_matches_unit_kind`, on every fitment write |
| TY011-013 | 000031 | the tyre lifecycle's refusals |
| TY014 | 000032 | a fitment write refused |
| TY015 | 000033 | the retread cap |
| TY016 | 000035 | a unit status transition refused |
| TY017 | 000037 | a rig write refused |
| TY018 | 000038 | an inspection task refused |
| TY019 | 000040 | an inspection write refused, including the void's own refusals |
| TY020 | 000040 | a reading offered to a sealed inspection; no route can reach it, so no entry exists |
| TY021 | 000041 | the future-skew refusal |
| TY022 | 000044 | a composition observation refused |

`httpapi.unitSource` is the one place a fleet handler chooses its relation
for a unit, by `auth.Actor.Scope` and never by role name (ADR-0006). Every
caller composes it: the unit read, its PATCH and status write, its
fitment/driver/task lists, the four unit-path writes (`fitTyre`,
`rotateTyres`, `assignDriver`, `scheduleInspectionTask`), and the two
composition-report writes (`observations.go`), which reach the unit through
the report's inspection (FR-AUT-008, TYRE-162, TYRE-226).

`patchUnit`'s UPDATE always runs, even naming no column, because it is
doing two further jobs beyond the edit itself. It is the existence check,
where RLS is what makes "no such unit" and "another tenant's unit" the same
404 (ADR-0011), and its row lock is what serialises two concurrent tag
replacements on one unit, which a bare SELECT in its place would not. A
tags-only edit therefore still touches the vehicle row, and writes no audit
entry for it: `app.audit_row_change` returns early when an UPDATE leaves
the row identical, so nothing is logged that claims a column moved when
none did. The tag map rows it does change are not audited, because
`vehicle_audited` is on `app.vehicle` alone (000035). The UPDATE's scope
predicate is `unitSource`'s (FR-AUT-008); the read-back is through
`app.vehicle` deliberately, because the write was authorised against the
row as it stood, so the editor reads back what they wrote.

## Rate limiting (NFR-SEC-007)

`ratelimit.clientAddress` resolves the per-address counter's key by reading
the `trustedProxyHops`-th trusted hop's own observation out of
`X-Forwarded-For`, never `RemoteAddr` directly. Each trusted L7 hop in front
of the process appends the address of the peer it received the request
from, so the Nth trusted hop's own observation sits N entries from the
right of the full forwarded chain, never at a fixed position a caller can
predict and prepend forged entries in front of. The chain is flattened
across every `X-Forwarded-For` header line, not read from the first line
alone: RFC 7230 treats repeated header lines as equivalent to one
comma-joined line, so a conformant hop may append its observation as a
separate line rather than extend the caller's.

Today's topology is one hop: Azure Container Apps' own ingress terminates
every connection and forwards over its internal hop, so `RemoteAddr` is
always the ingress's own address, never the caller's. Keying the counter on
`RemoteAddr` there would collapse every client into one bucket, turning the
limiter meant to stop a hostile client into a way for one to lock out every
driver. `infra/main.bicep`'s `TRUSTED_PROXY_HOPS` defaults to 1 for exactly
this hop; adding a second hop in front of it (a CDN, WAF or gateway) moves
the trusted observation one entry further from the right, which is what
raising the option tracks. If the flattened chain has fewer entries than
`trustedProxyHops`, the header does not match the topology the process was
told to expect, and `clientAddress` falls back to `RemoteAddr` rather than
trust anything closer to the caller than the Nth hop would be; the same
fallback covers a header absent or blank (local/dev, `httptest`).

## Capture and the network

The hypothesis the POC exists to test is that a driver captures a full vehicle
in under three minutes. Everything about the capture path is subordinate.

Per ADR-0009 (client platform and on-device data): the client is
**online-first with a durable submit outbox**, not an offline-first sync
engine. Drivers have connectivity as the normal case; what the design protects
is the one in-progress inspection.

- Reads (vehicle lists, configuration) are fetched online; nothing replicates
  the register to the phone.
- The in-progress inspection is durably held on-device until the server
  acknowledges it — a submit outbox, with an explicit "Sync now" and a
  stale-queue warning, never a background-sync dependency (iOS Safari has no
  Background Sync API and evicts storage aggressively).
- Each inspection carries a client-generated `client_uuid`, unique per tenant
  in the schema, so submission is idempotent: replaying an outbox entry is a
  no-op and an uncertain network is safe.
- Photos queue separately from readings. A slow photo upload must never hold up
  a completed inspection.

`submitInspection` re-applies FR-AUT-005's narrowing on the write path: the
read composes `app.v_capture_vehicle`, and without the same check on the
write a driver could submit against any unit in the tenant, wider than the
read ever exposed. A superlink payload legitimately carries readings
against several `vehicle_id`s in one submit: the motive unit plus each
coupled trailer, so a completed sheet is 108 numeric entries, not 52 (the
one constraint everything in `CLAUDE.md` is subordinate to). Checking only
the top-level `vehicle_id` would let a driver assigned to unit A embed a
reading against unrelated unit B in the same tenant: `TY004` in
`app.submit_inspection` only confirms a position belongs to its own
vehicle's configuration, never that the actor may write to that vehicle.
So every `vehicle_id` referenced anywhere in the payload must resolve
through `v_capture_vehicle`: the top-level one plus every
`readings[].vehicle_id`, read straight from the raw JSON rather than a
second Go-side model. The `COALESCE` around the `readings` key guards a
missing or non-array value so a malformed payload still gets a refusal in
Go rather than a raw Postgres error.

## Environments

| | |
|---|---|
| Local | docker-compose Postgres 16 on :5433. Same major version as production so RLS and `security_invoker` behave identically. |
| CI | GitHub Actions. Ephemeral Postgres service container. The verification suite is the gate. |
| Production | Azure. One resource group per environment. Bicep in `infra/`. Deploys via GitHub Actions using OIDC federated credentials — no long-lived Azure secret in the repo. |

## Decision record index

| ADR | Title | Status |
|---|---|---|
| [0001](adr/0001-stack.md) | Platform stack — Azure, Go API, React PWA, PostgreSQL | Proposed |
| [0002](adr/0002-region-and-data-residency.md) | Azure region and POPIA data residency | Accepted |
| [0003](adr/0003-tenancy-model.md) | Tenancy model | Proposed — blocked on sponsor acceptance (OI-29 / TYRE-13) |
| [0004](adr/0004-branching-strategy.md) | Branching — develop integrates, main mirrors production | Proposed |
| [0005](adr/0005-environments-and-hosting.md) | Environments — staging is production for the pilot | Accepted |
| [0006](adr/0006-role-depot-scoping-enforcement.md) | Where role and depot scoping is enforced | Accepted |
| [0007](adr/0007-unit-centric-fleet-model.md) | Unit-centric fleet model | Accepted |
| [0008](adr/0008-tyre-identity-and-display-codes.md) | Tyre identity and display codes | Accepted |
| [0009](adr/0009-client-platform-and-on-device-data.md) | Client platform and on-device data | Accepted |
| [0010](adr/0010-provenance-measured-vs-derived.md) | Provenance — measured vs derived | Accepted |
| [0011](adr/0011-actor-context-and-authorisation.md) | How the actor is established and the role resolved | Accepted |
| [0012](adr/0012-api-error-envelope.md) | The API error envelope | Accepted |
| [0013](adr/0013-write-surface-contract.md) | The write-surface contract | Accepted |
| [0014](adr/0014-audit-mechanism.md) | How mutations are audited | Accepted |
| [0015](adr/0015-ui-substrate.md) | UI substrate: tokens, plain CSS, three Radix primitives, inline SVG charts | Proposed |
