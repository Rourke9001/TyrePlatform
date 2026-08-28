# Design: the first admin write surface

- **Date:** 2026-08-28
- **Ticket:** TYRE-81 (org admin surface to add users and vehicles), under epic
  TYRE-55 (Fleet assets, lifecycle and retread). Batch B4 of
  `docs/implementation-order.md`.
- **Deliberately not in this design:** TYRE-83 (tiered invites and the
  reactivate branch) and TYRE-58 (band configuration validation). Both are
  sequenced after TYRE-81 and are named here only where TYRE-81 must leave
  room for them.
- **Decisions it rests on:** ADR-0003 (tenancy) · ADR-0006 (role and depot
  scoping) · ADR-0011 (actor context and authorisation) · ADR-0012 (the API
  error envelope) · Decisions of Record D8, D9, D10 (Confluence pageId
  16089089)
- **Decision it produces:** ADR-0013 (the write-surface contract)
- **Requirements:** FR-VEH-001..005 · FR-VEH-007, FR-VEH-008 · FR-AUT-005,
  FR-AUT-009, FR-AUT-010, FR-AUT-011, FR-AUT-022 · DR-003 · DR-013 ·
  NFR-SEC-006 · NFR-PRV-004, NFR-PRV-006

## Why this exists

The API has exactly one write endpoint: `POST /api/inspections`. Everything
else in the product — users, units, assignments — reaches the database only
through `db/seeds/gen_seed_fixture.py`. The consequence is stated plainly in
TYRE-81: a tenant cannot be built from nothing. TYRE-80's Sandbox Fleet exists
so exploratory data stays out of BAC, whose rows are the acceptance fixture,
and it is inert beyond capturing against its two seeded units.

This is also the batch where a shape gets set. `POST /api/inspections` was
built as a single endpoint against a single SQL function, and nothing about it
generalises by itself. The next four batches add write surfaces — rig setup
(TYRE-72/73/75), tyre lifecycle (TYRE-48), configuration editing (TYRE-58) —
and each will copy whatever this one does. That is why the ticket mandates an
ADR before the code, and why the ADR's scope is wider than this ticket's code.

## What TYRE-81 asks for, restated

**Changes.** Two create endpoints, `POST /api/users` and `POST /api/vehicles`,
each gated on a capability that already exists (`ManageUsers`, `ManageAssets`),
never on a role name. The org-admin screens that reach them, appearing through
the existing capability-driven navigation. A vehicle is created against an
axle configuration picked from the tenant's library.

**Must not change.** The capture path. The seed fixture — BAC's rows are the
acceptance gate, and the Appendix E valuations and Appendix J exception set
must reproduce unchanged. RLS: every write goes through `withActor` on a
tenant-bound transaction, and the `WITH CHECK` half of `tenant_isolation` is
what makes a cross-tenant write impossible.

**How we know it worked.** An ORG_ADMIN adds a driver and a unit to Sandbox
Fleet through the UI, assigns the driver to the unit, and that driver reaches
a capture screen for it. A capability the actor lacks answers 403. A write
aimed at another tenant fails on `WITH CHECK`. `make check` green.

## The one gap in the ticket, and the assumption taken

TYRE-81's definition of done says the new driver "can then be assigned and
reach a capture". Its scope section lists only `POST /api/users` and
`POST /api/vehicles`, and explicitly excludes "inspection assignment".

Those are two different things, and the exclusion only covers one of them.
Inspection assignment is FR-INS-049's scheduled task. Driver-to-unit
assignment is `app.vehicle_driver`, and it is what `app.v_capture_vehicle`
reads: a driver's reachable units *are* their `vehicle_driver` rows. Without
that write, a driver created through the product can never reach a capture,
and the definition of done cannot be met through the product at all.

**Assumption taken:** a third endpoint, `POST /api/vehicles/{vehicleID}/drivers`,
is in scope — the minimum that makes the stated DoD achievable. It is gated on
`ManageAssignments`, which already exists and is already held by every role
that holds `ManageAssets`. It writes one `app.vehicle_driver` row with a
`from_date` and no `to_date`.

This is flagged for the ticket owner rather than assumed silently. If the
answer is that assignment belongs in its own ticket, drop Task 5 and Task 9
from the plan; the other eight tasks stand unchanged, and the DoD's last
clause moves with it.

Nothing else about the ticket is ambiguous.

## Blockers

None. Checked against `docs/open-issues.md` on 28 Aug 2026:

- **OI-29 / TYRE-13** (marketplace tenancy) blocks the P1 schema *freeze*.
  This batch adds no schema, so it is not blocked.
- **OI-17 / TYRE-64** (POPIA, deactivated drivers) touches deletion and
  deactivation. This batch creates users and never deletes or deactivates one,
  so the question stays open without blocking. NFR-PRV-004's default —
  retained 84 months, then pseudonymised — governs until it is answered, and
  TYRE-83 owns the deactivation half.
- **TYRE-19** (platform name and domain) becomes hard at custom-domain setup.
  D10's subdomain-scoped login is recorded in the ADR as a constraint on the
  future auth build, not built here.

## The decisions

### 1. Where a business rule lives when the write is a plain insert

`app.submit_inspection` is a SQL function because submitting an inspection
carries rules — the duplicate window, the odometer ceiling, the staleness
checks — that exist nowhere else. Creating a user or a unit carries no such
rule. Every rule that governs these two rows is already a schema constraint:
`UNIQUE (tenant_id, fleet_number)` is DR-003, `UNIQUE (tenant_id, email)` is
D10, `platform_admin_has_no_tenant` is FR-AUT-003a, the composite foreign keys
are the TYRE-29 class, and `vehicle_driver_no_overlap` is B1's.

**Decision.** The handler issues a parameterised `INSERT ... RETURNING` inside
`withActor`. No wrapper SQL function is written for a write that has no rule
of its own to express: a function that only restates the constraints beneath it
is a second place for the rule to be wrong.

Where a rule is genuinely missing from the schema, it is **added to the
schema**, as B1 did — not implemented in Go. The worked example is in decision 6.

### 2. How a constraint violation becomes an HTTP status

ADR-0012 settled the envelope: `{code, message}`, messages canned unless the
SQLSTATE is in the private `TY` class. It did not settle what a *form* does
with a refusal. "The submission conflicts with data already recorded" is the
right sentence for a driver's phone and useless on a screen with a fleet-number
field that needs highlighting.

**Decision.** `refusalForPgError` gains a second, narrow translation step: for
the SQLSTATEs that carry a constraint name (`23505` unique, `23P01` exclusion),
a small map turns `pgErr.ConstraintName` into a stable wire code. The
constraint name never reaches the wire — it is translated, not forwarded, and
ADR-0012's guarantee is unchanged. An unrecognised constraint falls through to
the existing generic `conflict`, so the default stays safe.

Three entries earn it in this batch:

| Constraint | Wire code | Status | Rule |
| --- | --- | --- | --- |
| `vehicle_tenant_id_fleet_number_key` | `fleet_number_taken` | 409 | DR-003, FR-VEH-004 |
| `app_user_tenant_id_email_key` | `email_taken` | 409 | D10 |
| `vehicle_driver_no_overlap` | `assignment_overlaps` | 409 | B1 / migration `000026` |

**Why not a named `TY0xx` raised in SQL for each.** A `TY` code is raised by
code we wrote, in a trigger or a function, where a rule is being *evaluated*.
Duplicate-key and exclusion violations are detected by the index itself; to
raise a `TY` code for one you must either pre-check inside a trigger — which
races the index it duplicates, and gives the rule two implementations — or
wrap every insert in an exception handler that exists solely to rename an
error. Translating the constraint's name in the transport layer is the honest
description of what is happening: the rule is in the database, and Go is
naming its refusal for a client. The coupling to constraint identifiers is
real and is covered by an integration test per entry — rename a constraint
without updating the map and the test fails on the code, not on the name.

**`23P01` is new to the refusal map.** `vehicle_driver_no_overlap` is
reachable the moment the assignment endpoint exists, and `exclusion_violation`
is in no map today, so it would answer 500 — which for the capture outbox
means an infinite retry, and for a form means a spinner that never resolves.

**One consequence to accept deliberately.** `refusalForPgError` serves every
endpoint, so mapping `23P01` also changes what the capture path does with a
future exclusion constraint it can reach: 409 rather than 500. That is the
outcome ADR-0009 wants — a 500 is the one answer the outbox cannot survive —
but it is a decision about the submit path made from an admin batch, so the
ADR states it rather than leaving it to be found.

### 3. Validation is shape only, and it happens in Go

A create request is refused before it reaches the database when it is
malformed as a *request*: a missing required field, a uuid that does not
parse, a role outside the enum, a string past a length cap. That is transport,
and it belongs in Go (`api/CLAUDE.md`).

It is not a business rule and must not grow into one. In particular:

- **Fleet numbers are not pattern-checked.** FR-VEH-003 says the system
  "shall accept alphanumeric fleet numbers and shall not assume numeric
  values". A regex here would reject real data; the only check is non-empty
  after trimming.
- **No threshold, band or rate appears anywhere in this batch** (project rule
  5). The only numeric literals are length caps on free text, which are
  transport limits, not policy.

Refusals from this layer answer 422 with `invalid_submission` and a message
naming the field: `fleetNumber is required`.

**That message is renderable, and this is the one addition to ADR-0012's
vocabulary.** ADR-0012 split messages by who wrote them: a `TY0xx` message is
ours and reaches the wire verbatim, a Postgres message is canned because it can
name a table or a constraint. A validation message written in `admin.go` falls
on the same side of that line as a `TY0xx` — we wrote it, it names a request
field and never a schema object. So the rule generalises rather than gaining an
exception: **a Go-authored or `TY`-class message is renderable; a
database-authored one is not.**

This matters because the alternative is worse. An admin form that must
highlight a field either reads the message or the envelope grows a `field`
key — and a third key on every refusal in the platform, to serve two screens,
is a larger change than the one ADR-0012 just settled.

**The client cannot do this yet, and that is part of this batch.** B3 gave
`ApiError` the envelope's `code` and left its `message` as the synthetic string
`apiPost` builds from the verb, the path and the status; the envelope's message
is parsed for its code and thrown away. So the rule above is a decision the
code does not implement until `web/src/api/client.ts` reads both fields from
the one parse a `Response` body allows. The capture path is unaffected either
way: `CaptureDone` keys its sentences on `code`, and `outbox.ts` already
records that its stored message is "diagnostics only, never rendered".

### 4. `PLATFORM_ADMIN` is not creatable through a tenant surface

`platform_admin_has_no_tenant` already makes the row impossible — a
`PLATFORM_ADMIN` carries a NULL `tenant_id`, and a tenant-bound insert cannot
write one. Letting the request reach the database and answering with a
translated constraint violation would be an accident that happens to be safe.

**Decision.** The handler rejects `role = "PLATFORM_ADMIN"` explicitly, as an
invalid role for this endpoint, with its own test. ADR-0011's position is that
platform staff are never the actor on a tenant-scoped request, and never its
subject either.

Every other role in `app.user_role` is creatable by an actor holding
`ManageUsers` at this ticket. **TYRE-83 narrows exactly this list** — an actor
holding only D9's finer `InviteDriver` capability may create `DRIVER` and
nothing else. The handler is written so that narrowing is an edit to one
function, not a restructure.

### 5. No endpoint in this batch removes anything

No `DELETE`, and no update that sets `active = false`. D10 settled that
leaving a company is `active = false` and never a delete, because attribution
survives through `vehicle_driver` (FR-VEH-008) — but the deactivation surface
is TYRE-83's, and TYRE-64's POPIA question touches it. `000018` has already
revoked `DELETE` from `app_rw` on both tables, so the database would refuse it
regardless; the point is that no endpoint should be built that tries.

### 6. `unit_kind` is required by the API and not yet by the schema

`app.vehicle.unit_kind` is nullable. `000011`'s CHG-027 backfill derived it
from the configuration code and left underivable rows NULL deliberately, and
`000025`'s TY009 trigger passes a NULL kind for that reason. A unit created
today with no kind is a unit whose fitment-odometer rule silently cannot fire.

**Decision, in two halves.** The API requires `unitKind` on create — a unit
whose kind the product does not know should not be creatable through the
product. The *schema* constraint that would make this true for every writer is
**not** added in this batch, and the reason is measured rather than assumed:
12 of the 18 `INSERT INTO app.vehicle` statements in `db/tests/004_tests.sql`
omit `unit_kind`, as do both Go integration fixtures. A `CHECK (unit_kind IS
NOT NULL) NOT VALID` would be correct and cheap to write, and would then
require editing a dozen fixtures inside the file that is the acceptance gate,
for a benefit this batch does not need.

That sweep belongs with **TYRE-88** (trigger hardening, which already names
`unit_kind` edits) or a ticket of its own. Recorded in the ADR as an accepted
gap with a named owner, not left implicit.

### 7. The axle-configuration library needs a read endpoint

TYRE-81 says a vehicle is created against a configuration "chosen from the
tenant's library". No endpoint serves that library — `GET /api/vehicles`
returns units, not configurations — so the create form has nothing to populate
a picker from.

**Decision.** `GET /api/axle-configurations` is in scope, gated on
`ManageAssets` (the capability that can act on the answer), returning active
configurations only. It is a read, so it composes no new relation: `app.vehicle`
is not involved, `app.axle_configuration` is RLS-scoped like every other table,
and the query is a plain select inside `withActor`.

**Not in scope:** authoring a configuration. D8 is explicit that authoring is
`ManageTemplates`, ORG_ADMIN-only, and TYRE-84 has already reserved the
capability. This endpoint reads the library and never writes to it.

### 8. A created row answers 201 with its own projection

`POST /api/inspections` answers 202 because the outbox may still be holding
it. A create is synchronous and either happened or did not.

**Decision.** 201, with the same JSON projection the corresponding list
endpoint uses, so a client that just created a unit holds the identical shape
it would have read. No `Location` header: the platform has no
`GET /api/vehicles/{id}`, and a header pointing at a 404 is worse than none.

### 9. No idempotency key

The capture path carries `client_uuid` because a driver's outbox retries
without a human present. An admin form has a human in front of it, and the
unique constraints already make the second submission a clean 409 rather than
a duplicate row. Adding an idempotency mechanism now would be building for a
retry loop that does not exist.

## The D9/D10 constraints the ADR must record

These are the reason the ADR comes before the code. None is built here; each
would be expensive to unpick from code that assumed otherwise.

- **D9, tiered invites.** ORG_ADMIN may invite any role; CONTROLLER and
  DEPOT_MANAGER may invite DRIVER only, through a new finer capability plus a
  handler rule — never a role-name branch. `ManageUsers` stays ORG_ADMIN's
  alone. There is no privilege-escalation path: neither role can create or
  promote an admin. (TYRE-83.)
- **D9, reconfirmed.** The first ORG_ADMIN of a tenant is created by a
  PLATFORM_ADMIN at provisioning, as a manual step. The owner *is* the
  ORG_ADMIN; there is no separate owner role (FR-AUT-009). Nothing in this
  batch bootstraps a tenant.
- **D10, rehire.** A rehire invite hits `UNIQUE (tenant_id, email)` against an
  inactive row. The flow must offer **reactivation**, not fail — the same
  shape as D2's staff-number rule in `000019`. TYRE-81 answers `email_taken`;
  TYRE-83 turns that code into the reactivate branch. This is why the code is
  specific rather than a generic `conflict`: TYRE-83's branch needs to know
  which conflict it hit.
- **D10, login.** Login is scoped to the tenant subdomain
  (`app.tenant.subdomain` is UNIQUE); the tenant resolves before
  authentication, so the same email in two tenants never collides. Global
  identity with a tenant picker is rejected — it leaks employment history.
  Global email uniqueness is rejected — a driver could not work for two
  customers. No real login exists yet (the dev header resolver is all there
  is), so recording this now constrains the future auth build at zero rework
  cost.
- **D8, write-side scope.** DEPOT_MANAGER writes are tenant-wide for now:
  scope views narrow reads only. This is deferred deliberately, not
  overlooked, and the ADR says so — otherwise the first person to notice will
  read it as a bug.

## What this changes about ADR-0012's premises

`httpapi.go` carries a comment saying the blanket `23503` mapping "is safe
here only because `app.submit_inspection` is the single write path". This
batch ends that. The mapping stays — since B3 the message is canned, so the
disclosure that made a blanket mapping worrying is gone — but the comment's
stated reason is no longer true and must be rewritten to the reason that is:
a foreign-key violation from any write path means the request named something
that does not exist, and 422 with a canned message is the honest answer for
all of them.

`TY008` and `TY009` stay out of `submitStatus`, and the deferral note in
ADR-0012 that points at B4 needs correcting rather than discharging. Neither
is reachable from anything this batch builds: `TY008` fires on an **update**
of `vehicle.configuration_id` where history exists, and this batch has no
update endpoint; `TY009` fires on a fitment write, and fitment is out of
scope. An entry now would still carry no test able to fail.

## Sequencing

Ten tasks. The ADR first, because everything after it cites it. Then the
library read, because the vehicle form needs it. Then the three writes, in
dependency order — a driver cannot be assigned to a unit before either exists.
Then the client, in one pass per screen. Then the end-to-end proof and the
documentation close-out.

The Go work lands before any React, so that a failure in the browser is
unambiguously a client failure.
