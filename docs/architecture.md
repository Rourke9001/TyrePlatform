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
                      │  HTTPS, JWT from Entra External ID
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
