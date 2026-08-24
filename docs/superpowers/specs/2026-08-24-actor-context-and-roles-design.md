# Design: identity, roles and access (sub-project 1)

- **Date:** 2026-08-24
- **Ticket:** TYRE-56, under epic TYRE-2 (P1 — Foundation: tenancy, RLS, auth, M1)
- **Decisions it rests on:** ADR-0011 (how the actor is established and the
  role resolved) · ADR-0006 (where role and depot scoping is enforced)
- **Requirements:** FR-AUT-002..009, 011, 022 · FR-DSH-001, FR-DSH-012 ·
  NFR-SEC-006

## Why this exists

The database has carried an authorisation layer since the first migration and
nothing has ever used it. `app.current_actor_id()` reads a GUC that Go never
sets, so `app.v_driver_vehicle` — the one scope predicate that exists —
returns zero rows in every deployed code path. Meanwhile the Go layer has no
notion of a user: the request context carries a tenant and nothing else.

Every product surface still to be built needs to know who is asking. This
sub-project supplies that, and nothing else.

## Where it sits in the programme

The work identified from the 23 Aug repo audit decomposes into five
sub-projects. This is the first, and the rest depend on it.

| # | Sub-project | Personas | Modules closed |
| --- | --- | --- | --- |
| **1** | **Identity, roles and access** | all | `AUT`, `DSH-001/012` |
| 2 | Value-at-risk slice | owner | `VAL-031`, `RPT-040`, `DSH-017` |
| 3 | Driver capture and outbox | driver | `INS`, `OFF`, `TYR-030..035`, `FIT-024` |
| 4 | Assets, lifecycle and retread | controller, owner | `VEH` writes, `TYR`, `FIT-021`, `CFG`, `IMP` |
| 5 | Exceptions, notifications, reports | owner | `EXC`, `NOT`, remaining `ANL`/`RPT` |

Sub-project 4 fell between TYRE-3 and TYRE-5 and was owned by no epic, which
is why it went unbuilt while the database beneath it was completed. It now has
one: TYRE-55.

## The role model

Six roles exist in `app.user_role` and the SRS defines all six. The operator's
four jobs map onto them as follows, with the middle two sharing a role because
SRS §4.3 and FR-FIT-018 collapse them deliberately — there is no workshop user
type and there are no workshop capture screens.

| Operator's job | Role | Scope |
| --- | --- | --- |
| Driver | `DRIVER` | Currently assigned units only (FR-AUT-005) |
| Fleet controller | `CONTROLLER` | Whole tenant (FR-AUT-007) |
| Asset controller | `CONTROLLER` | Whole tenant — same role, different surface |
| Owner | `ORG_ADMIN` | Whole tenant plus configuration and users (FR-AUT-009) |
| — | `TECHNICIAN` | Assigned depots, read (FR-AUT-006) |
| — | `DEPOT_MANAGER` | `CONTROLLER` powers narrowed to depots (FR-AUT-008) |

`TECHNICIAN` and `DEPOT_MANAGER` are not personas the operator described, but
FR-AUT-006 and FR-AUT-008 are Must and both fall inside Appendix H's
`FR-AUT-001..011`, so their scope predicates are in scope here.

The two controller surfaces differ in navigation, not in permission. Handlers
therefore assert **capabilities**, never role names:

| Capability | Roles |
| --- | --- |
| `ViewFleet` | `CONTROLLER`, `DEPOT_MANAGER`, `ORG_ADMIN`, `TECHNICIAN` |
| `CaptureInspection` | `DRIVER`, `CONTROLLER`, `DEPOT_MANAGER`, `ORG_ADMIN` |
| `ManageAssignments` | `CONTROLLER`, `DEPOT_MANAGER`, `ORG_ADMIN` |
| `ManageAssets` | `CONTROLLER`, `DEPOT_MANAGER`, `ORG_ADMIN` |
| `LogRetread` | `CONTROLLER`, `ORG_ADMIN` |
| `ManageConfig` | `ORG_ADMIN` |
| `ManageUsers` | `ORG_ADMIN` |

The mapping lives in exactly one place in Go. Separating the two controller
jobs later is one enum value and one column in that table.

Breadth is not in this table: it is a separate role-keyed `Scope` table in
`api/internal/auth`, defaulting to depot-narrowed for any role the table does
not name.

## Architecture — four refusal layers

| Condition | Result | Enforced by |
| --- | --- | --- |
| No identity on the request | `401` | `requireActor` middleware |
| User row invisible in the bound tenant, or `active = false` | `403` | `InActorTx`, under RLS |
| Role lacks the capability | `403` | per-handler capability assertion |
| In scope but no matching rows | empty result | scope view |

A wrong or forged tenant needs no special case: the standard
`tenant_isolation` policy hides the user row, the actor load returns nothing,
and the request is refused. `active = false` returns a row — the policy does
not filter on it — so a deactivated user is distinguishable from a foreign one
in logs while the client sees the same `403`.

RLS remains underneath all four, unchanged.

## Components

### db/ — one migration (`000014`), four views

Scope predicates as ADR-0006 requires: defined once in SQL, composed by
handlers. All `security_invoker = true`; all key on `app.current_actor_id()`;
all return zero rows for an unset actor, matching the fail-closed contract
`app.v_driver_vehicle` already documents.

| View | Scopes | Requirement |
| --- | --- | --- |
| `app.v_actor_depot` | The actor's own depot set, from `app.user_depot` | FR-AUT-004 |
| `app.v_depot_vehicle` | Units whose home depot is one of the actor's | FR-AUT-006, FR-AUT-008 |
| `app.v_depot_tyre` | Tyres whose current depot is one of the actor's | FR-AUT-006 |
| `app.v_my_inspection_task` | Open tasks assigned to the actor | FR-DSH-012 |

No new table, no new `SECURITY DEFINER` function, no change to any existing
policy. `app.v_driver_vehicle` is unchanged and remains the `DRIVER`
predicate.

### api/ — the actor seam

`InTenantTx` is unchanged and remains correct for tenant-scoped work with no
actor. A sibling adds the actor:

- `InActorTx` binds `app.tenant_id` **and** `app.actor_id` transaction-locally
  via `set_config(..., true)`, loads `role`, `active` and the depot set from
  `app.app_user` / `app.user_depot` under RLS, and passes a resolved actor to
  the handler alongside the transaction.
- `ActorResolver` supplies **identity only** — tenant id and user id. It never
  supplies a role.
- `HeaderActorResolver` extends today's `X-Tenant-ID` pattern with a user
  header, gated by the existing `devHeaderEnabled` veto so it cannot exist in
  a Container Apps revision.
- `requireActor` replaces `requireTenant` on the `/api` route group.

The endpoint set at the end of this sub-project — deliberately small, but real
enough that the capability gate and all three scope views are exercised by
something a user calls:

| Endpoint | Capability | Reads through |
| --- | --- | --- |
| `GET /api/me` | any actor | `app.app_user`, `app.user_depot` |
| `GET /api/vehicles` | `ViewFleet` | `app.v_depot_vehicle`, or the whole tenant (`app.vehicle`) for `ScopeTenant` roles |
| `GET /api/my/vehicles` | `CaptureInspection` | `app.v_driver_vehicle` |
| `GET /api/my/tasks` | `CaptureInspection` | `app.v_my_inspection_task` |

`GET /api/org/branding` is unchanged and available to any actor.

Note the behaviour change: `GET /api/vehicles` is today tenant-scoped and
open to any caller with a tenant header. It becomes `ViewFleet`-gated, which
a `DRIVER` does not hold — so a driver receives `403` there and uses
`/api/my/vehicles` instead. That is FR-AUT-005 expressed as a route rather
than as a filter, and it is what gives the per-role tests a genuine refusal
to assert against. `web/src/dashboard/VehicleList.tsx` moves with it.

`GET /api/me` returns the actor's display name, role, capabilities and depots
so the client can render navigation. Presentation only: every endpoint
re-checks server-side per NFR-SEC-006.

### web/

Two prerequisites do not exist and are part of this sub-project:

- **No router.** `App.tsx` mounts two components and navigation is a bare
  anchor. Capability-gated routes need one.
- **No DOM test environment.** Vitest runs in the node environment with no
  jsdom and no testing library, so no component can currently be rendered in a
  test. Adding them is a prerequisite for testing anything role-gated. The
  `.npmrc` dependency-age window that `make deps-age` asserts applies.

On top of those: a `useMe()` query, a role-appropriate landing view
(FR-DSH-001), the narrower driver view (FR-DSH-012), and route guards that
render nothing the actor lacks the capability for.

## Data flow — one request

1. Request arrives with identity (dev headers now; a validated token later).
2. `requireActor` extracts tenant id and user id, or answers `401`.
3. The handler opens `InActorTx`, which binds both GUCs inside the
   transaction.
4. `InActorTx` selects the actor's row under RLS. Nothing returned, or
   `active = false`, answers `403`.
5. The handler asserts the capability the endpoint needs, or answers `403`.
6. The handler queries through the scope view for the actor's role. Tenant
   isolation is enforced by RLS; intra-tenant scope by the view.
7. The transaction commits and both bindings die with it.

## Error handling

House rules apply unchanged: errors are values, wrapped with
`fmt.Errorf("...: %w", err)`, logged with `slog.ErrorContext`, never returned
to the client in detail, and never `panic` in request handling. Refusals are
distinguishable in logs and identical on the wire.

## Testing

- **db** — a new numbered section in `db/tests/004_tests.sql` exercising each
  new view with the actor set, unset, and set to a foreign tenant's user. The
  existing section 15 is the pattern.
- **api** — table-driven per-role integration tests against a real Postgres,
  covering role × endpoint × expected status, plus the two failure modes that
  matter: a `DRIVER` calling an asset endpoint gets `403`, and a `DRIVER`
  querying a unit they are not assigned gets an empty result rather than a
  refusal. ADR-0006 names these tests as the sole carrier of the residual risk
  it accepted, so they are the substance of this sub-project rather than a
  formality.
- **web** — component tests for capability-gated navigation, which the jsdom
  addition makes possible for the first time.
- `make check` green before and after.

## Out of scope

- **Entra External ID.** FR-AUT-001 is not satisfied by this sub-project and
  must be before any real pilot user. It gets its own ADR and sub-project.
- The IdP subject column on `app.app_user`, which lands with Entra.
- FR-AUT-010 invite / suspend / reactivate — invitation is IdP-coupled.
- 2FA, PIN re-authentication and lockout tuning, deferred by Appendix H.1.
- `PLATFORM_ADMIN` login, structurally impossible under ADR-0011 and outside
  Appendix H, which has no `ADM` module.
- Audit-log writes. This sub-project makes them meaningful by establishing an
  actor; the first mutating surface starts writing them.

## Open items logged for the sponsor

Recorded in `docs/spec/QUESTIONS-FOR-ROURKE.md` with the assumption each is
built on, per the open-items-only convention:

1. **Whether a `DRIVER` may see money.** No requirement in SRS v1.4 restricts
   valuations, casing values or rand-per-mm from a driver. The capability
   model can express the restriction; the spec does not ask for it.
2. **Two cross-reference errors in SRS v1.4.** FR-FIT-021 cites FR-ANL-026 for
   spare-pool sizing where FR-ANL-043 is meant, and FR-FIT-019 cites FR-ANL-024
   for rotation recommendations where FR-ANL-042 is meant.
