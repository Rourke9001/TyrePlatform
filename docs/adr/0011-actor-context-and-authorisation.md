# ADR-0011: How the actor is established and the role resolved

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Rourke
- **Related:** ADR-0006 (where role and depot scoping is enforced) · ADR-0003
  (tenancy) · SRS §4.3 AUT, FR-AUT-001..011, NFR-SEC-006 · Appendix H.1

## Context

ADR-0006 decided *where* intra-tenant scoping is enforced: the predicate is
defined once in SQL as a `security_invoker` view, and the Go handler composes
it. That decision assumed an actor existed. None does.

`app.current_actor_id()` has been in the schema since the first migration
(`000001_init.up.sql:32-35`), and `app.v_driver_vehicle`
(`000003_current_assignment_views.up.sql:33-36`) is written against it. But
`store.InTenantTx` binds only `app.tenant_id` (`store.go:57`), so the one
scope predicate that exists returns **zero rows** whenever a handler selects
through it. The Go layer has no notion of a user at all: the request context
carries exactly one value, and `TenantResolver` resolves a tenant and nothing
else. The authorisation layer ADR-0006 designed has no input.

Three constraints shape how that input should arrive.

**FR-AUT-001 requires an external identity provider**, and `architecture.md`
names Entra External ID. No ADR records that choice and no Entra tenant
exists, so a decision that blocks on one blocks every surface above it —
capture, assets and reports all need to know who is asking.

**NFR-SEC-006 is explicit:** *"Authorisation shall be evaluated server-side on
every request; client-side controls shall be treated as presentation only."*

**The verification suite treats `SECURITY DEFINER` as precious.** Check 8c
fails the build for any definer function not on an explicit allowlist. Exactly
one is on it. Anything that adds a second is spending something scarce.

There is also a vocabulary mismatch worth recording, because it will otherwise
be rediscovered. The operator describes four jobs — a driver, a fleet
controller who assigns units to drivers, an asset controller who manages tyres
and retreads, and an owner who reads the aggregate. SRS §4.3 and FR-FIT-018
deliberately collapse the middle two: *"there is deliberately no workshop user
type — lifecycle events are logged by controller/admin users"*, and *"there are
no dedicated workshop capture screens."* The two controller jobs are one role.

## Options considered

### Option A — the role travels in the token

The IdP issues a token carrying tenant and role; the API trusts both.
Attractive because it is the standard OIDC shape, costs no query, and needs no
schema.

**Its real downside:** the identity provider's token contents become an
authorisation decision. A user deactivated under FR-AUT-011 keeps every
permission until their token expires — and FR-AUT-015 allows capture sessions
of up to 30 days, so that window is measured in weeks, not minutes. It also
couples user administration to IdP claim provisioning, which is the wrong
place for it when `app.app_user` is already the register of record.

### Option B — identity in the token, role resolved per request

The request carries who and which tenant. The API binds both as
transaction-local GUCs, then reads `role`, `active` and the depot set from
`app.app_user` / `app.user_depot` **under RLS** as the first act inside the
transaction.

**Its real downside:** one extra query per request, and the tenant must arrive
alongside the identity rather than being derived from the user record. That is
tolerable — a wrong or forged tenant makes the user row invisible under the
standard `tenant_isolation` policy (`000001_init.up.sql:530-535`), so the
lookup returns nothing and the request is refused. It fails closed without a
special case.

### Option C — a `SECURITY DEFINER` resolver

A definer function maps the IdP subject to tenant and role before any tenant
context exists, so nothing needs to be claimed.

**Its real downside:** it grows the definer allowlist that check 8c exists to
hold at zero growth, and routes *every* request through the one mechanism RLS
cannot see. The problem it solves — bootstrapping tenant from identity — is
real but belongs to the identity-provider decision, not to this one.

## Decision

**We will use Option B. The resolver supplies identity only; the role and
depot scope are read from the database under RLS on every request, and handlers
are gated on capabilities rather than on role names.**

1. `store.InActorTx` binds `app.tenant_id` and `app.actor_id` transaction-locally
   via `set_config(..., true)`, loads the actor, and hands the handler a
   resolved actor alongside the transaction. `InTenantTx` is unchanged and
   remains correct for tenant-scoped work with no actor.
2. A role maps to a **capability set**. Handlers assert capabilities. This is
   what lets the two controller jobs share `CONTROLLER` without the code
   claiming they are the same job, and makes a future separation of duties an
   additive change rather than a refactor.
3. The dev resolver extends the existing `X-Tenant-ID` pattern and stays under
   the `CONTAINER_APP_NAME` veto already table-tested in `main_test.go`. Entra
   External ID lands later as a second implementation of the same interface,
   with its own ADR.

## Consequences

**Good:** a deactivated user loses access on their next request, not on their
next token. `app.app_user` stays the single register of who may do what, which
is where FR-AUT-009/010 put it. The definer allowlist stays at one entry. Every
surface above this — capture, assets, reports — can be built against a stable
actor seam without waiting for an Azure Entra tenant to exist.

**Bad:** FR-AUT-001 is **not satisfied** by this decision alone. Until the
identity-provider sub-project lands, the only resolver is the dev one, and it
must never reach a deployed environment — the veto is the whole safety story
and it is one environment variable wide. It also costs a query per request,
which is unmeasured; if it ever matters, the answer is a request-scoped cache,
not a token claim.

**The dev resolver's threat model widens.** Trusting `X-Tenant-ID` verbatim
was already a cross-tenant breach by construction; trusting a user header too
means that locally, anyone who can send a header is anyone, and the capability
gate is decorative. Nothing about the veto changes — the same environment
check covers both — but the consequence of defeating it is now impersonation
within a tenant as well as across tenants. The dev resolver is a development
convenience with the blast radius of an authentication bypass, and should be
read that way in review.

**`PLATFORM_ADMIN` cannot authenticate through this path at all.** Those rows
carry NULL `tenant_id` and are invisible in a tenant session by design
(`000001_init.up.sql:552-554`). This is consistent with Appendix H, which
contains no `ADM` module and provisions tenants by hand, but it means platform
staff have no login until that module is built.

**Revisit when:** the identity provider lands and the subject-to-tenant
bootstrap has to be chosen (a token claim keeps the allowlist at one; a
login-time lookup spends the second entry); a measured latency problem appears;
a feature escalates an already-assigned `app.inspection_task` row in place —
the table keeps its `UPDATE` grant (000012), and `v_my_inspection_task.overdue`
computes `state = 'OPEN' AND due_at < now()` while admitting both `OPEN` and
`ESCALATED`, so an escalated row with a real `assigned_user_id` would read
`overdue = false` however far past due; unreachable today only because
`ESCALATED` is presently set exclusively at generation, for tasks no driver
resolves, and such rows carry a NULL `assigned_user_id` (000014); or the
operator wants enforced separation of duties between the two controller
surfaces, which is an enum value plus a capability row, not a redesign.
