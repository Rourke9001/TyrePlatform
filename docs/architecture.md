# Architecture

A companion to the ADRs, not a substitute. This page says how the pieces fit;
the ADRs say why each was chosen and what it costs.

## Shape

```
   phone (PWA)                    browser
        │                            │
        │  IndexedDB queue           │
        │  sync on reconnect         │
        ▼                            ▼
   ┌─────────────────────────────────────┐
   │  Azure Static Web Apps              │   React + Vite
   │  capture app  │  manager dashboard  │
   └──────────────────┬──────────────────┘
                      │  HTTPS, JWT from Entra External ID
                      ▼
   ┌─────────────────────────────────────┐
   │  Azure Container Apps  (Go)         │   scale-to-zero
   │  auth → tenant context → handlers   │
   └──────────────────┬──────────────────┘
                      │  pgx, one transaction per request
                      │  SET LOCAL app.tenant_id = <claim>
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

## Tenant context — the critical path

Every request, without exception:

```go
// SET LOCAL, not SET. This binds the setting to the transaction, so a pooled
// connection cannot carry one tenant's context into the next request. A plain
// SET here is a cross-tenant data leak that will pass every test you write.
tx, err := pool.Begin(ctx)
defer tx.Rollback(ctx)
_, err = tx.Exec(ctx, "SET LOCAL app.tenant_id = $1", claims.TenantID)
// ... all queries on tx ...
tx.Commit(ctx)
```

`app.current_tenant_id()` returns NULL when the setting is unset, and every
policy compares with `=`. NULL matches nothing, so a request that skips this
step sees zero rows rather than everything. **The system fails closed.**

## Offline capture

The hypothesis the POC exists to test is that a driver captures a full vehicle
in under three minutes. Everything about the capture path is subordinate.

- Inspections are written to IndexedDB (Dexie) first, always. The network is
  never on the critical path of the driver's flow.
- Each inspection carries a client-generated `client_uuid`, unique per tenant
  in the schema. Sync is therefore idempotent: replaying a queued inspection is
  a no-op, so an uncertain network is safe (FR-OFF-011).
- Photos queue separately from readings. A slow photo upload must never hold up
  a completed inspection.
- Sync is background where the platform allows it. **On iOS it does not** —
  Safari has no Background Sync API and evicts storage more aggressively.
  TYRE-14 (Q7) establishes which platform the pilot drivers actually use; the
  answer materially changes this design.

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
| [0003](adr/0003-tenancy-model.md) | Tenancy model | Blocked on OI-29 (TYRE-13) |
| [0004](adr/0004-branching-strategy.md) | Branching — develop integrates, main mirrors production | Proposed |
| [0005](adr/0005-environments-and-hosting.md) | Environments — staging is production for the pilot | Accepted |
| [0006](adr/0006-role-depot-scoping-enforcement.md) | Where role and depot scoping is enforced | Accepted |
