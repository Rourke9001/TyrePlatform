# ADR-0013: The write-surface contract

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Rourke Amiss
- **Related:** ADR-0003 (tenancy model) · ADR-0006 (role and depot scoping
  enforcement) · ADR-0009 (client platform — the durable submit outbox) ·
  ADR-0011 (actor context and authorisation) · ADR-0012 (the API error
  envelope) · FR-VEH-001..005, FR-VEH-007, FR-VEH-008 · FR-AUT-005,
  FR-AUT-009..011, FR-AUT-022 · DR-003 · DR-013 · NFR-SEC-006 ·
  NFR-PRV-004, NFR-PRV-006

## Context

`POST /api/inspections` is the only write the platform has, and it is a SQL
function, `app.submit_inspection`, not a plain insert: submitting an
inspection carries rules of its own — the duplicate window, the odometer
ceiling, the staleness checks — that live nowhere else in the schema. Four
more write surfaces are queued behind it: rig setup (TYRE-72/73/75), tyre
lifecycle (TYRE-48), configuration editing (TYRE-58), and tiered invites
(TYRE-83), which sits directly on top of whatever this one settles.
Nothing about the one write endpoint that exists generalises by itself, and
each of the queued surfaces will copy whatever shape is decided here rather
than re-deriving one. That is reason enough to fix the shape once, in
writing, before the first plain-insert endpoint exists rather than after
several of them have already disagreed.

This is also the first write surface where the write itself carries no rule.
Creating a user or a unit is governed entirely by constraints the schema
already has — `UNIQUE (tenant_id, fleet_number)` (DR-003),
`UNIQUE (tenant_id, email)` (D10), `platform_admin_has_no_tenant`
(FR-AUT-003a), `vehicle_driver_no_overlap` — so the one precedent in the
codebase, a SQL function expressing a business rule, does not fit. What
takes its place — how a constraint violation becomes a client-facing
refusal, what a Go handler may validate before a transaction opens, what an
admin form is allowed to render — is what this ADR decides.

The tenancy guarantee on a write is the `WITH CHECK` half of
`tenant_isolation`, never the handler. A handler that got the tenant wrong
is a bug the database refuses on the way in, not a bug that has to be caught
by reading Go.

## Options considered

### Option A — a SQL function per write, mirroring `app.submit_inspection`

Wrap each create in a function that expresses the constraints it needs, the
one precedent the codebase already has. Attractive because every write then
sits behind the same kind of seam, and a reviewer only has to learn one shape.

**Its real downside:** there is no rule for a function to express. Every rule
governing a user or a unit row is already a schema constraint —
`UNIQUE (tenant_id, fleet_number)`, `UNIQUE (tenant_id, email)`,
`platform_admin_has_no_tenant`, `vehicle_driver_no_overlap` — so a function
here would only restate them, becoming a second place for the rule to be
wrong. Decision 1 rejects it for that reason.

### Option B — a `TY0xx` code raised in SQL for every constraint

Give `fleet_number_taken`, `email_taken` and `assignment_overlaps` the same
shape as `TY003`: a trigger or function that detects the violation and
raises a named exception ahead of the constraint.

**Its real downside:** a unique or exclusion violation is detected by the
index itself, not by code positioned to check first and raise cleanly.
Pre-checking inside a trigger races the very index it duplicates; wrapping
every insert in an exception handler that exists solely to rename an error
gives the rule two implementations instead of one. Decision 2 translates the
constraint name in the transport layer instead — the rule stays in the
database in one place, and Go only names the refusal for a client.

## Decision

1. **A write with no rule of its own is a parameterised insert in Go.** A SQL
   function is written when there is a rule to express — the duplicate
   window, the odometer ceiling — never to wrap a constraint that already
   exists. Where a rule is genuinely missing from the schema, it is added to
   the schema, as migrations `000024`–`000026` did, never implemented in Go.

2. **`tenant_id` on any insert comes from `app.current_tenant_id()`, never
   from the request.** The insert statement calls the session-bound
   function directly rather than threading a tenant value through Go, so
   there is no application-held tenant id for a handler to get wrong.
   `WITH CHECK` on `tenant_isolation` still enforces whatever lands in the
   row — this decision removes the class of bug it would otherwise have to
   catch, it does not stand in for it.

3. **A constraint violation a client must branch on gets a stable wire
   code, translated from the constraint name in one map in `httpapi.go`.**
   ADR-0012's `refusalForPgError` already collapses `23505` to the generic
   `conflict`; this decision adds a narrower step ahead of that fallback —
   for the SQLSTATEs that carry a constraint name (`23505` unique, `23P01`
   exclusion), a small map turns `pgErr.ConstraintName` into a stable code.
   The name is translated, never forwarded onto the wire, so ADR-0012's
   disclosure guarantee is unchanged, and an unrecognised constraint still
   falls through to `conflict`, so the default stays safe. This extends
   ADR-0012 rather than amending it — the envelope, the `TY`-class rule and
   the integrity-class collapse are untouched.

   | Constraint | Wire code | Status |
   | --- | --- | --- |
   | `vehicle_tenant_id_fleet_number_key` | `fleet_number_taken` | 409 |
   | `app_user_tenant_id_email_key` | `email_taken` | 409 |
   | `vehicle_driver_no_overlap` | `assignment_overlaps` | 409 |

   `23P01` is new to the map: nothing before this ADR's surfaces could raise
   it, since `vehicle_driver_no_overlap` is reachable only once an
   assignment endpoint exists.

   Two consequences of this decision are stated here rather than left to be
   discovered:

   - **The translation map is shared with the submit path.** `refusalForPgError`
     serves every endpoint, so mapping `23P01` also changes what
     `POST /api/inspections` does with a future exclusion violation it can
     reach: 409 rather than 500. That is the outcome wanted — ADR-0009's
     outbox cannot survive a 500 — but it is a decision about the submit
     path made from an admin surface, so it is recorded as one rather than
     arriving as a side effect.
   - **These endpoints carry a body-size cap and no rate limit**, unlike
     `POST /api/inspections`, whose limiter exists because a driver's
     outbox can retry without a human present (NFR-SEC-007). An admin form
     has a human in front of it and sits behind `ManageUsers` or
     `ManageAssets`. A rate limiter was considered and rejected for that
     reason, not simply omitted.

4. **A Go-authored refusal message is renderable; a database-authored one is
   not, except the `TY` class.** ADR-0012 split messages by who wrote them,
   not by status code: a `TY0xx` message is ours and reaches the wire
   verbatim, a Postgres message is canned because it can name a table or a
   constraint. A shape-validation message written in Go falls on the same
   side of that line — it names a request field, never a schema object — so
   the rule generalises rather than gaining an exception. This is the one
   addition to ADR-0012's vocabulary, and the reason an admin form may show
   a validation message on the field it names.

5. **Request validation is shape only, in Go, before any transaction
   opens.** A missing required field, an id that does not parse, a role
   outside its enum, a string past a length cap are refused before a
   transaction opens — that is transport, not policy. It must never grow
   into a business rule: no fleet-number pattern is checked (FR-VEH-003
   requires accepting alphanumeric fleet numbers), and no threshold, band
   or rate appears in a Go validator, ever.

6. **`PLATFORM_ADMIN` is not creatable through a tenant surface**, refused
   explicitly by the handler rather than left to `platform_admin_has_no_tenant`.
   The constraint already makes the row impossible to write; letting the
   request reach the database and answering with a translated conflict
   would be an accident that happens to be safe, not a decision, and it
   would answer the wrong code — a rejected role is not a duplicate key.

7. **No write surface removes a row.** No `DELETE`, and no update that sets
   `active = false`. Leaving a company is `active = false` (D10) and belongs
   to the deactivation surface that follows this one; migration `000018`
   has already revoked `DELETE` from `app_rw` on the tables these decisions
   govern, so the database refuses a delete regardless. The point recorded
   here is that no endpoint should be built that tries.

8. **The axle-configuration library gets a read endpoint.**
   `GET /api/axle-configurations` is gated on `ManageAssets` — the
   capability that can act on the answer — and returns the tenant's active
   configurations, the source a vehicle-create form has nowhere else to
   populate a picker from. It is a plain select inside `withActor`;
   `app.axle_configuration` is RLS-scoped like every other table, and no new
   relation is composed. Authoring a configuration stays out of scope: D8
   reserves that for `ManageTemplates`, held by `ORG_ADMIN` alone (TYRE-84),
   and this endpoint only reads the library.

9. **A created row answers 201 with its own projection, not 202.**
   `POST /api/inspections` answers 202 because the outbox may still be
   holding the submission when the response is written. A create here is
   synchronous — it happened inside the transaction or it did not — so it
   answers 201 with the same JSON projection the corresponding list endpoint
   uses, and no `Location` header: the platform has no
   `GET /api/vehicles/{id}`, and a header pointing at a route that 404s is
   worse than no header at all.

10. **No idempotency key.** `client_uuid` exists on the capture path because
    a driver's outbox retries a submission with no human present
    (ADR-0009). An admin form has a human in front of it, and the unique
    constraints these writes already carry turn a resubmission into a clean
    409 rather than a duplicate row. Building an idempotency mechanism now
    would be for a retry loop that does not exist.

## Consequences

**Good:** every write surface queued behind this one — rig setup, tyre
lifecycle, configuration editing, tiered invites — inherits a shape instead
of inventing one: a parameterised insert unless a rule is genuinely missing
from the schema, `tenant_id` from the session never the request, a
translated constraint code a form can act on, and a Go-authored message a
form may render on the field it names. The axle-configuration read
establishes the same seam for a read endpoint that a future list view can
copy, and a created row's 201 projection lets a client hold what it just
wrote without a second round trip.

**Bad:** the constraint-name-to-wire-code map is a second place that must
change in step with the schema — rename `vehicle_tenant_id_fleet_number_key`
and forget the map, and the client silently falls back to the generic
`conflict`. An integration test per entry catches a missed rename on the
code failing, not on the constraint's name, which is the best this shape
does without generating the map from the catalogue. `PLATFORM_ADMIN`'s
rejection is now enforced in two places — the handler and
`platform_admin_has_no_tenant` — because the constraint alone would answer
the wrong code, not because either enforcement is redundant to drop. No
surface here removes a row or narrows `DEPOT_MANAGER` writes to its own
depot, and both are deliberate deferrals a reader could mistake for
oversights without this paragraph.

**Revisit when:** TYRE-83 narrows the creatable-role list to `InviteDriver`
for `CONTROLLER` and `DEPOT_MANAGER`; TYRE-88 adds the `unit_kind NOT NULL`
constraint this ADR accepts as a gap; the deactivation surface that decision 7
deliberately leaves unbuilt is scheduled (NFR-PRV-004 already governs the
retained data, 84 months then pseudonymised, so nothing gates it); a write
surface needs an update or a delete, which is the point decision 7 stops
covering; or a client needs to retry a write idempotently, which decision 10
assumes never happens because a human is always present at an admin form.

## Constraints on later work

None of these are built by the surfaces this ADR governs. They are recorded
now because unpicking an assumption from code that already shipped costs
more than writing the assumption down first.

- **Tiered invites.** `ManageUsers` stays `ORG_ADMIN`'s alone here — nothing
  in this ADR grants it more narrowly. The invite surface that replaces
  plain user creation adds a finer capability, `InviteDriver`, held by
  `CONTROLLER` and `DEPOT_MANAGER`, so the two controller jobs can create a
  `DRIVER` without holding `ManageUsers`; `ORG_ADMIN` may still invite any
  role through the capability it already holds. The narrowing is a
  capability grant plus a handler rule, never a role-name branch, and there
  is no privilege-escalation path in either direction: neither `CONTROLLER`
  nor `DEPOT_MANAGER` can create or promote an admin.
- **The first `ORG_ADMIN` is a manual step.** A tenant's first `ORG_ADMIN`
  is created by a `PLATFORM_ADMIN` at provisioning, not through a
  self-service surface (FR-AUT-009). The owner *is* the `ORG_ADMIN`; there
  is no separate owner role. Nothing decided here bootstraps a tenant —
  provisioning stays a manual `PLATFORM_ADMIN` act until it has a surface of
  its own.
- **Rehire reactivates; it does not fail closed.** `UNIQUE (tenant_id,
  email)` means a rehire invite for a previously deactivated user collides
  with their own old row. That collision has to become a reactivation
  branch, not a dead end — the same shape as the staff-number rule in
  migration `000019`. This is why decision 3 names `email_taken` as its own
  code rather than leaving `23505` to fall through to the generic
  `conflict`: the branch that turns a collision into a reactivation needs to
  know which unique constraint it hit, and splitting a generic code apart
  later costs every client that already parsed it.
- **Login resolves the tenant before it resolves the user.**
  `app.tenant.subdomain` is `UNIQUE`, and login is scoped to it: the tenant
  resolves from the subdomain first, so the same email address in two
  tenants never collides and never has to. A global identity with a tenant
  picker is rejected because it discloses employment history across
  tenants; global email uniqueness is rejected because a driver may work
  for two customers, and nothing should prevent that at the schema level.
  No real login exists yet — the dev header resolver (ADR-0011) is all
  there is — so recording this now constrains the future auth build at
  zero rework cost.
- **Depot scoping on a write stays deferred.** `DEPOT_MANAGER` writes are
  tenant-wide on every surface these decisions govern; the depot-scope
  views ADR-0006 defined narrow reads only, not writes. This is a
  deliberate deferral, not an oversight, and it is written down here so
  that the first person to notice a depot-manager write reaching another
  depot's rows finds this paragraph before filing a defect.

## Accepted gaps

- **`vehicle.unit_kind` is required by the API, not by the schema.** The
  column stays nullable: 12 of the 18 `INSERT INTO app.vehicle` statements
  in `db/tests/004_tests.sql` omit it, and so do the Go integration
  fixtures. A `NOT NULL` constraint would be correct and cheap to write, and
  would then require editing every one of those statements inside the file
  that is the acceptance gate, for a benefit no surface governed by this ADR
  needs — the API requires `unitKind` on create, so the gap is reachable
  only by a writer that predates this ADR. **Owner: TYRE-88**,
  which already names `unit_kind` edits as part of its trigger-hardening
  scope.
- **The driver-assignment endpoint does not check that its assignee holds
  the `DRIVER` role.** No constraint says an `app.vehicle_driver` row's user
  must be a driver, and none is added here. The gap is inert today: every
  role that can be assigned already holds `CaptureInspection`, so assigning
  a controller to a unit is odd, not unsafe. No ticket owns this one — it
  should be revisited the day a role becomes assignable, or gains
  `ManageAssignments`, without also holding `CaptureInspection`, at which
  point an assignee's role stops being something a client can rely on by
  construction.
