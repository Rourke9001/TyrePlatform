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
