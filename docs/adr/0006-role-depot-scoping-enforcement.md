# ADR-0006: Where role and depot scoping is enforced

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** Rourke

## Context

Tenant isolation lives in row-level security and is not in question here
(ADR-0003, non-negotiable rule 1). This decision is only about the
authorisation layer *on top of* it: FR-AUT-004..008 scope what a user sees
**within** their own tenant — a `DRIVER` to currently assigned vehicles
(FR-AUT-005), a `TECHNICIAN` and `DEPOT_MANAGER` to their assigned depots
(FR-AUT-006, FR-AUT-008), a `CONTROLLER` and `ORG_ADMIN` to the whole tenant
(FR-AUT-007, FR-AUT-009).

The two enforcement points on offer are Postgres RLS policies (extend the
per-tenant policy with per-role predicates, driven by `app.actor_id` /
a new role GUC) or the API layer (Go composes the scope into its queries).

The forces are not symmetrical with tenant isolation. A cross-tenant leak is
existential (R3); an intra-tenant scoping miss shows a driver a colleague's
vehicle — bad, but a bug, not a breach. And the scoping predicates are
relational in a way tenant identity is not: "currently assigned vehicles"
is a date-windowed join through `vehicle_driver`; "assigned depots" is a
join through `user_depot`.

## Options considered

### Option A — Per-role RLS policies

Everything in one place; even SQL run from a psql session is scoped.
**Downside:** per-role policies on `vehicle`, `inspection`, `tyre`, `reading`
must subquery `vehicle_driver` / `user_depot`, which are themselves RLS
tables — that forces SECURITY DEFINER helper functions to break policy
recursion, adds a per-row correlated cost to every query, and destroys the
one-policy-shape property the verification suite's sweep rests on. The
sweep is provable because every table carries the *same* policy;
a matrix of role × table policies is not sweepable, it is only enumerable.

### Option B — Application-level filters in Go

Scoping is authorisation, and auth is the API's job (architecture split:
tyre rules in SQL, auth and transport in Go). Policies stay simple.
**Downside:** the predicate ends up re-derived in every handler that touches
vehicles, and a missed `WHERE` clause silently overexposes. The failure is
invisible until someone notices.

### Option C — Predicates once in SQL, gate in Go

The scope predicates are defined exactly once in the database as
`security_invoker` views/functions (e.g. a current-assignments view keyed on
`app.current_actor_id()`), and the API composes them — handlers select
through the scope view rather than re-deriving the join. RLS continues to
enforce tenant isolation underneath everything.
**Downside:** enforcement still depends on the Go handler choosing the
scoped view; the database will not stop a handler that queries the base
table. That residual risk is carried by per-role API integration tests
(FR-AUT-005/006 are verification-by-test in the SRS).

## Decision

We will use Option C: tenant isolation stays in RLS; role and depot scoping
is enforced in the API layer, with each scope predicate defined once in SQL
as a `security_invoker` view or function that handlers compose.

## Consequences

**Good:** the RLS surface stays small, uniform and provable by the existing
sweep; scope logic has a single SQL implementation (no drift between
capture, dashboard and sync); the POC's per-role behaviour is testable at
the API boundary where the SRS verifies it.

**Bad:** a handler that bypasses the scope view overexposes within the
tenant, and only the API integration tests catch it. Discipline lives in
review plus tests, not in the database.

**Revisit when:** a scoping bug reaches staging; OI-29 lands a second party
type (seller visibility is *cross*-tenant by design, which Option C cannot
express and RLS must); or the P3 offline sync endpoints are built and the
sync payload needs server-side scoping guarantees stronger than per-handler
composition.
