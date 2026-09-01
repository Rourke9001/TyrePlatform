# Structure and layering — TYRE-97

The dependency map, the folder structure as committed, and the layering
breakdown the handoff asked for, written against `develop` @ `bc74262`. The
ledger is `ledger.md`; the evidence for each actioned row is `report.md`.

## Dependency map

Built from `rg` over import statements; no tool installed. **Zero cycles in
every tier**, so the handoff's "each remaining cycle listed with
justification" clause is vacuously met.

### api/ (Go)

```
cmd/api ──► internal/httpapi ──► internal/store ──► internal/auth
   │                                    ▲
   └────────────────────────────────────┘
```

| Package | Imports (internal) | Imported by |
|---|---|---|
| `cmd/api` | `httpapi`, `store` | — |
| `internal/httpapi` | `auth`, `store` | `cmd/api` |
| `internal/store` | `auth` | `cmd/api`, `httpapi` |
| `internal/auth` | — | `store`, `httpapi` |

Test packages add no back-edge. Direct external modules: `chi`, `pgx`,
`uuid`, `testify`. No ORM, no web framework, no decimal library — money is a
Go `string` between Postgres `numeric` and the JSON string on the wire.

### web/ (React + Vite)

```
main ─► App ─► routes ─► { admin, capture, driver, fleet, dashboard }
                                │            │
        theme ◄─────────────────┘            │
        time  ◄──────────────────────────────┘
        auth  ◄── (every screen, time)
        api   ◄── (auth, theme, every screen)
        shell ◄── dashboard/AppShell
        dashboard/AppShell ─► capture/OutboxIndicator   (the one cross-domain edge; deliberate)
```

| Directory | Imports from | Imported by |
|---|---|---|
| `api/` | nothing internal | everything below |
| `auth/` | `api` | `admin`, `dashboard`, `fleet`, `routes`, `time` |
| `theme/` | `api` | `dashboard/AppShell`, `main` |
| `time/` | `auth` | `driver`, `fleet` |
| `shell/` | nothing internal | `dashboard/AppShell` |
| `capture/` | `api`, itself | `dashboard/AppShell` (indicator only), `routes` |
| `dashboard/` | `api`, `auth`, `capture/OutboxIndicator`, `shell`, `theme` | `App`, `routes` |
| `driver/` | `api`, `time` | `routes` |
| `fleet/` | `api`, `auth`, `time` | `routes` |
| `admin/` | `api`, `auth` | `routes` |
| `test/` | nothing internal | test files only |

`web/e2e/*.ts` imports nothing from `web/src`; the specs drive the running
dev server through the browser only.

### db/, seeds, scripts, CI

`db/migrations/` (read-only for this work) defines every function, view,
policy and grant. `db/seeds/gen_seed_*.py` emit SQL that is loaded after the
migrations and call into them (after DB-1, the fixture derives `rand_per_mm`
through `app.rand_per_mm`). `db/tests/004_tests.sql` reads both. `Makefile`
owns every command; `ci.yml` re-encodes the migrate-seed-test sequence
because the runner has no docker-hosted toolchain (DB-7). `scripts/*.mjs`
are leaves.

## Folder structure as committed

No file was relocated on this branch, so there is no before → after move
map. The tree, with each top-level directory's one purpose:

```
api/        Go. Auth, tenant context, transport. Thin by decision.
  cmd/api/            process entry: config, pool, router, graceful stop
  internal/auth/      roles, capabilities, scope — pure, no I/O
  internal/store/     the tenant-bound transaction (InActorTx) and pool
  internal/httpapi/   handlers, error envelope, rate limit
db/         PostgreSQL 16. The domain model.
  migrations/         schema, functions, views, policies, grants (untouched)
  seeds/              generators — the source of truth for the configuration library
  tests/              the verification suite, run as app_login
web/        React + Vite. One app: capture PWA and manager dashboard.
  src/api/            fetch, the refusal envelope, per-resource wrappers
  src/auth/           actor context and capability gates
  src/capture/        the driver flow, draft and durable submit outbox
  src/dashboard/      shell, unit list
  src/fleet/          tyre register screens
  src/admin/          unit and user creation
  src/driver/         driver home
  src/shell/          navigation model
  src/theme/          tokens, branding, derived shades — the only place colour lives
  src/time/           the only date formatter (rule 6)
  src/test/           vitest setup and shared fixtures (new on this branch)
  e2e/                Playwright specs and actor helpers
infra/      Bicep.
scripts/    the two build gates (comment style, release age)
docs/       ADRs, architecture, lessons, plans; this directory
```

Only one file was added: `web/src/test/fixtures.ts` (WEB-7).

## Layering — what is actually there

The handoff's template puts domain rules in a pure code layer and treats
the database as infrastructure. This repository inverts that on purpose
(`docs/architecture.md` §"Where logic lives, and why"): the acceptance gate
is cent-exact reproduction of a valuation, so there is exactly one
implementation of it, in the one tier with a real decimal type and
row-level security. Mapping the handoff's names onto the real tiers:

| Handoff layer | Where it lives here | May import | May not |
|---|---|---|---|
| **domain** — entities, valuation, position maps, invariants | `db/migrations/`: `app.tread_value`, `app.rand_per_mm`, `app.submit_inspection`, `app.receive_tyres`, exception views, `TY0xx` triggers, `enable_tenant_rls` | nothing — it is the bottom | anything about HTTP, headers, JSON shape |
| **application** — use cases orchestrating domain + ports; tenant context | The SQL functions are the use cases. The Go side of "application" is `store.InActorTx`: begin, bind tenant and actor transaction-locally, resolve role and scope under RLS, run, commit | `auth` | handlers, `net/http` |
| **infrastructure** — DB wiring, auth provider, storage, clock | `store` (pool, `set_config`), `cmd/api` (config, Entra/dev resolver), `web/src/capture/draft.ts` + `outbox.ts` (Dexie), `web/src/api/client.ts` (fetch) | domain contracts by name only (SQL text, wire codes) | business decisions |
| **interfaces** — HTTP handlers, capture client, screens. Thin | `httpapi` handlers; every `web/src/*` screen | `store`, `auth`; `api/`, `auth/`, `time/`, `theme/` | `pgx` pool directly; Dexie directly; money as a number; a date without `tenantTime` |
| **shared** — result types, errors, ids | `httpapi.errorBody` + `writeError`/`writeStatus` (ADR-0012); `web/src/api/refusal.ts`; `auth.Capability` | — | growing into a utils bin |
| **tools** — seed and fixture generators importing from domain | `db/seeds/gen_seed_*.py` emit SQL that calls domain functions rather than re-implementing them (DB-1 closed the one exception) | — | arithmetic the database owns |

**The dependency rule, as it holds here:** arrows point at the database.
Go and the browser both depend on SQL's contracts (function names, `TY0xx`
codes, view columns); nothing in SQL knows either exists. Within Go,
`auth ← store ← httpapi ← cmd`; within web, `api ← auth/theme/time ←
screens ← routes`. A screen never reaches a store; a handler never reaches
a pool.

## The three cross-cutting concerns

**Tenant context.** Enters once, in `store.InActorTx`
(`api/internal/store/store.go`), as `set_config('app.tenant_id', $1, true)`
plus the actor id — transaction-local, so a pooled connection cannot carry
it forward. Every policy compares `tenant_id = app.current_tenant_id()`,
which is NULL when unset, so a request that skips the step sees nothing
(FR-TEN-004). The client never sends a tenant id in a request body; the
dev header resolver (`cmd/api`) is the only other source and is vetoed in
Container Apps (ADR-0011). Propagation is the transaction handle `tx`
passed into the handler closure — there is no ambient context to leak.

**Provenance (ADR-0010).** Enters at the row: `cost_source`,
`casing_basis`, `distance_provenance`, `orientation_known` are columns,
written by the SQL function that records the event. Go passes them through
as strings; the web app renders the vocabulary it is given
(`COST_SOURCES`) and never fills a gap with a number. The one derived value
the client computes for itself — the governing tread `MIN()` — exists for
instant feedback and is never transmitted (`payload.ts`), so the trigger's
materialised value is the only one on record (CR-011).

**Auth and role capability.** The identity arrives as a JWT (or dev
header) in `cmd/api`; the *role* is never taken from it — `InActorTx` reads
`app.app_user` under RLS inside the same transaction, and `auth.Actor`
carries capabilities derived from the role by `auth.capabilities`, the one
table (ADR-0011). Handlers assert `require(a, auth.X)` and never compare
role names; read breadth follows `a.Scope()`. `/api/me` serialises the
capability list and the web app's `RequireCapability` and `navItemsFor`
consume it — the client is gated for navigation only; the server is the
authority.
