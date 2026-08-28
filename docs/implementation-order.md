# Implementation order

Snapshot of **27 Aug 2026**, re-verified **28 Aug 2026** against `develop` @
`3a3d6c2`.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins — and the disagreement is a bug in this page. Re-verify
before trusting a disposition below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built.

## What the verification found

A proposed order was drawn from the Decisions of Record (D6–D11) and the board.
Checking it against the repository moved three things:

- **Its first step was already complete.** There are no open pull requests.
  TYRE-49, TYRE-68 and TYRE-69 were merged before the order was written, so
  "land what is in review" is board bookkeeping, not merge work.
- **Two items were sequenced as future work but are already on `develop`** —
  TYRE-52 and TYRE-65.
- **Nine open tickets appeared nowhere in it** — TYRE-58 to TYRE-63, TYRE-76,
  and the three standing blockers TYRE-13/15/19. They are given homes below.

The verification also confirmed the rest of the order's dependency reasoning,
which is why the batches keep its shape.

## Disposition of every not-Done key

### Closed by this pass — the work is on `develop`

| Key | Evidence |
|---|---|
| TYRE-49 | PR #21, merged 22 Aug |
| TYRE-68 | PR #26, merged 26 Aug |
| TYRE-69 | PR #26, merged 26 Aug |
| TYRE-52 | `734644a` / migration `000016`; the decision is recorded at `app.tyre_in_estate_asof` and the suite asserts a disposed-but-still-rated tyre |
| TYRE-54 | PR #22 plus `27dd7e9` |
| TYRE-56 | PR #23. Its one residual — CONTROLLER and DEPOT_MANAGER lacking `ManageConfig` — is TYRE-74's whole scope, so it does not hold this open |
| TYRE-65 | PR #25, merged 24 Aug |

### Open, with a narrowed remainder

| Key | What actually remains |
|---|---|
| TYRE-70 | The mobile-viewport projects and specs landed in `11230eb`. What is outstanding is the acceptance run itself — one real vehicle, on a phone, in airplane mode, with its duration measured against the three-minute target. That is a human sitting in a yard, not agent work |
| TYRE-30 | ~~Two of its folded decisions were outstanding — the PLATFORM\_ADMIN email partial unique index and the `vehicle_driver` overlap constraint~~ — **closed by B1** in migration `000026`. DR-014b remains separate as TYRE-60 |

### Raised after this page was written

The 28 Aug re-verification found two keys the page predates rather than
misses. Both came out of B1's delivery and neither is scheduled:

| Key | What it is | Home |
| --- | --- | --- |
| TYRE-87 | Sweep unique and exclusion constraints, and unique indexes, for a missing `tenant_id`. B1 found one cross-tenant oracle and fixed it; seven pre-existing constraints sit in the same blind spot, three of them standalone partial indexes with no `pg_constraint` row | The class of work B1 was. Cheap now, expensive after pilot data — pull it before the pilot, ahead of the analytics tail |
| TYRE-88 | Harden the TY008/TY009 triggers: legacy NULL-odometer fitments and `unit_kind` edits | Follows B4, which adds the first writer that can create a unit whose kind is known. B4 requires `unit_kind` at the API and leaves the schema alone deliberately — that gap is this ticket's |

### Open and correctly scoped, verified still needed

| Key | Verified at |
|---|---|
| TYRE-74 | ~~`api/internal/auth/auth.go:52-53` — `ManageConfig` is absent from both roles~~ — **closed by B2** |
| TYRE-84 | ~~No `ManageTemplates` capability exists~~ — **closed by B2** |
| TYRE-82 | ~~No trigger or constraint guards `vehicle.configuration_id` against change with history present~~ — **closed by B1** |
| TYRE-85 | ~~`000011` dropped `fitted_odometer NOT NULL`; nothing re-enforces it where the unit kind has an odometer~~ — **closed by B1** |
| TYRE-77 | ~~`statusForPgError` forwards `pgErr.Message` verbatim~~ — **closed by B3** |
| TYRE-78 | ~~`TY003` and `23505` both map to 409 in `submitStatus`, and the client cannot tell them apart~~ — **closed by B3** |

Also open and unbuilt: TYRE-36, TYRE-38, TYRE-41, TYRE-48, TYRE-51, TYRE-53,
TYRE-58 to TYRE-64, TYRE-72, TYRE-73, TYRE-75, TYRE-76, TYRE-79, TYRE-81,
TYRE-83, TYRE-87, TYRE-88. TYRE-86 — this page itself — closed on 28 Aug once
its own method had been re-run against it.

## The batches

Ordering follows two rules. First, dependency. Second, and more sharply: an
integrity rule is cheap before pilot data exists and expensive after, because
afterwards the rule has to be retrofitted around rows that already violate it.
That is why the database constraints come before any surface that writes.

### B1 — database integrity rules — **delivered**

**TYRE-82, TYRE-85, and TYRE-30's two remaining constraints.**

One migration pass, no UI. These are the only items on the board that become
materially harder once the pilot holds real rows. TYRE-82 stops a unit's axle
configuration changing under its own fitments; TYRE-85 restores the half of
FR-FIT-002 that `000011` relaxed and never replaced. TYRE-30's leftovers are
the same class of small constraint in the same schema territory, so they ride
along rather than waiting for a pass of their own.

The plan is at `docs/superpowers/plans/2026-08-27-db-integrity-rules.md`.

Delivered on `TYRE-82-db-integrity-rules` as three paired migrations and three
suite sections:

| Migration | Rule | Section |
|---|---|---|
| `000024_configuration_immutable_with_history` | `TY008` on a `configuration_id` change where fitment, inspection **or** reading exists | 32 |
| `000025_fitment_odometer_by_unit_kind` | `TY009` where `unit_kind` carries an odometer; `TRAILER` and NULL pass | 33 |
| `000026_tenant_null_email_and_assignment_overlap` | partial unique index on `app_user(email) WHERE tenant_id IS NULL`; `vehicle_driver_no_overlap` | 34 |

Two things the branch found that the plan did not predict, both recorded here
because they change what the next batch should expect rather than because they
are history:

- The exclusion constraint keyed as the ticket described it — without
  `tenant_id` — is a **cross-tenant oracle**. Exclusion checks bypass RLS and
  fire before the composite FK, so `exclusion_violation` against
  `foreign_key_violation` disclosed another tenant's assignment dates to a
  caller who chose the probe date. `tenant_id` leads the key for that reason.
  The general case is unswept: check 16 sweeps foreign keys for a missing
  `tenant_id`, and there is no equivalent for unique or exclusion constraints.
  Seven pre-existing constraints are in that blind spot, three of them
  standalone partial indexes with no `pg_constraint` row.
- Suite section 24 asserted the odometer-less fitment property on a unit the
  seed declares `HORSE`, so `TY009` refused it. The section now creates its own
  trailer. It guards its inserts with `IF NOT EXISTS` and is not
  transaction-wrapped, so only `make db-reset` exercises it.

### B2 — the capability map — **delivered**

**TYRE-74, then TYRE-84.**

Both edit the same map in `api/internal/auth/auth.go`. Doing them apart is how
axle-configuration authoring ends up gated on `ManageConfig`, which is the one
outcome TYRE-84 exists to prevent: TYRE-74 widens `ManageConfig` to CONTROLLER
and DEPOT_MANAGER, so a template gate resting on it would silently hand
template authoring to two roles that must not have it. Together they are a
capability constant, two map entries and their tests.

The plan is at `docs/superpowers/plans/2026-08-27-capability-map.md`.

Delivered on `TYRE-74-capability-map` as two commits, in that order:

| Commit | Change | Assertion |
|---|---|---|
| TYRE-74 | `ManageConfig` on `RoleController` and `RoleDepotManager` | both hold it; DRIVER and TECHNICIAN still do not |
| TYRE-84 | `ManageTemplates` on `RoleOrgAdmin` alone | CONTROLLER and DEPOT_MANAGER do not hold it |

No schema change: the capability table has no database mirror, so the whole
batch is one file and its test. No endpoint gated on `ManageConfig` at the
time it widened, which is why the widening was cheap — the cost of deferring
it would have been paid once per surface built on the old shape. The web app
is untouched for the same reason: `navItemsFor` takes capabilities as input
and no menu item is gated on either capability.

`require.Len` in `TestRoleCapabilities` is what keeps the table honest — the
`can` list is an exact set, so a grant added to the map without a test fails.

### B3 — the submit refusal contract — **delivered**

**TYRE-77, then TYRE-78.**

TYRE-77 owns what a refusal says; TYRE-78 owns the machine-readable code it
carries. Every write endpoint added after this inherits whatever shape is
settled here, so the cost of deferring is paid once per endpoint. TYRE-81's own
description asks for these first.

TYRE-77's stated constraint was not accurate: there are **ten** `TY0xx` codes
(`TY001`–`TY010`, `TY008`/`TY009` added by B1), and `db/tests/004_tests.sql`
asserts the **SQLSTATEs** by name, not the messages — it contains no
message-text assertion at all. The fix preserves the five messages reachable
through `app.submit_inspection` (`TY003`–`TY007`) by forwarding them verbatim,
and cans every other refusal.

The plan is at `docs/superpowers/plans/2026-08-28-submit-refusal-contract.md`,
the design at
`docs/superpowers/specs/2026-08-28-submit-refusal-contract-design.md`.

Delivered on `TYRE-77-refusal-contract` as ADR-0012 plus two feature commits:

| Commit | Change | Assertion |
|---|---|---|
| TYRE-77 | `writeError` envelope; `refusalForPgError` cans every non-`TY` refusal; chi's 404/405 get handlers | table-driven `refusal_internal_test.go`; router-level `TestRefusalsCarryTheEnvelope` |
| TYRE-78 | `ApiError.code`; the outbox and `CaptureFlow` thread it; `CaptureDone` branches on `TY003` rather than on the 409 status | vitest per branch; `capture.spec.ts`'s duplicate-window e2e spec, unchanged and still green |

`TY008` and `TY009` stay out of `submitStatus` — deliberately, per ADR-0012:
neither is reachable through any endpoint that exists yet, so an entry now
could carry no test able to fail. B4 owns adding them once it builds the
write surface that can raise them.

No SQL changed. `make check` and `make e2e` both green at delivery.

### B4 — the first admin write surface — **delivered**

**The TYRE-81 ADR, then TYRE-81.**

The ADR comes first because the D9/D10 constraints — the tiered-invite shape,
the reactivate branch, the subdomain-login assumption — are cheaper to record
than to unpick from code. TYRE-83 sits directly on `POST /api/users` and
cannot start before it exists.

The plan is at `docs/superpowers/plans/2026-08-28-admin-write-surface.md`, the
design at `docs/superpowers/specs/2026-08-28-admin-write-surface-design.md`,
the closing proof at `web/e2e/admin.spec.ts`. It covers **TYRE-81 only** — ten
tasks on branch `TYRE-81-admin-write-surface`, cut from `develop` @
`3a3d6c2`. TYRE-83 gets its own plan now that this has landed.

Delivered as ADR-0013 plus nine feature commits and the browser proof:

| Commit | Change | Assertion |
|---|---|---|
| `de2979d` | ADR-0013: parameterised inserts over a SQL function, `tenant_id` from `app.current_tenant_id()` never the request, the constraint-name-to-wire-code map, the renderable-shape-validation extension to ADR-0012 | verified against the real files rather than merely written (Task 1 self-review) |
| `7d6b2fd` | `GET /api/axle-configurations`, capability-gated and tenant-scoped | `TestAxleConfigurationsAreCapabilityGatedAndTenantScoped` |
| `a272de8` | `POST /api/vehicles` against the tenant's configuration library | `TestCreateVehicle`; `TestWriteAimedAtAnotherTenantIsRefused` — the insert names another tenant directly and is required to fail, not merely to report its own tenant back at itself |
| `afde115` | `POST /api/users`, creating a tenant role and never `PLATFORM_ADMIN` | `TestCreateUser`; `TestWriteAimedAtAnotherTenantIsRefused_AppUser` |
| `eca4ce8` | `POST /api/vehicles/{vehicleID}/drivers` — the endpoint TYRE-81's scope section does not name | `TestAssignDriverToVehicle`; `TestWriteAimedAtAnotherTenantIsRefused_VehicleDriver` |
| `6305563` | `client.ts` carries the refusal envelope's `message`, not just its `code`; the admin API module (`createUnit`, `createUser`, `assignDriver`, `fetchAxleConfigurations`) | vitest per function; `client.test.ts` asserts the message survives, closing the gap the plan's review pass found before Tasks 7–8 could hit it |
| `9e6f439` | the add-a-unit screen, gated on `ManageAssets` | `AddUnit.test.tsx` |
| `dde0d0e` | the add-a-driver screen with its assignment step, gated on `ManageUsers` | `AddDriver.test.tsx` |
| `096e6d9` | both screens routed and placed in navigation behind their capabilities | `routes.test.tsx`; `navigation.test.ts` |
| the closing commit | `web/e2e/admin.ts`, `web/e2e/admin.spec.ts` — an org admin builds a unit and a user from nothing, assigns them, on `chromium` alone | `make e2e`, 21 passed (up from 20) |

Three things this batch found, carried forward because they change what the
next batch should expect rather than because they are history:

- **The assignment endpoint was an assumption, and it is not yet confirmed by
  the ticket owner.** TYRE-81's scope section does not name
  `POST /api/vehicles/{vehicleID}/drivers`; the plan added it because the
  definition of done — "the driver can then be assigned and reach a
  capture" — cannot be met through the product without it. It shipped on that
  assumption rather than waiting on an answer, and the assumption is recorded
  in ADR-0013 and stated plainly in the PR body rather than left to be
  inferred. If the ticket owner rules it out after the fact, Task 5 and the
  assign panel in Task 8 are what to remove.
- **`unit_kind` is required by the API and not the schema, owned by TYRE-88.**
  The column stays nullable: 12 of the 18 `INSERT INTO app.vehicle` statements
  in `db/tests/004_tests.sql` omit it, so a `NOT NULL` constraint would churn
  the acceptance suite for a benefit this batch does not need. TYRE-88 already
  names `unit_kind` edits as part of its trigger-hardening scope, so the gap
  has an owner rather than sitting unclaimed.
- **`TY008`/`TY009` are still not in `submitStatus`, and B4 did not discharge
  ADR-0012's deferral.** Both need a write surface this batch does not build —
  `TY008` fires on an *update* of `vehicle.configuration_id`, `TY009` on a
  fitment write. B4 only creates a vehicle and assigns a driver; it never
  updates a configuration or writes a fitment, so neither code is reachable
  yet and an entry in `submitStatus` could carry no test able to fail. The
  deferral stays re-pointed at whichever batch builds one of those two
  surfaces.

No schema change: every rule governing a user or unit row was already a
constraint (B1 and B3's antecedent work), so all three write endpoints are
parameterised inserts, none a SQL function. The driver-reaches-capture half of
the definition of done is proven by `TestAssignDriverToVehicle` in Go, against
the same `app.vehicle_driver` relation the browser writes to, and not by a
browser assertion — the created driver's id is never surfaced by either admin
screen, so there is no honest selector for a spec to act as. `make check` and
`make e2e` both green at delivery.

**TYRE-58** belongs after it, not in the analytics tail: band configuration
write-time validation is a rule about a config-editing surface. Note that
TYRE-81 does not build one — it picks from the axle configuration library and
authoring stays ORG_ADMIN's through `ManageTemplates` (D8, TYRE-84) — so
TYRE-58 waits for the surface that edits tenant configuration, not for this.

### B5 — the rig-setup surface

**TYRE-72, then TYRE-73, then TYRE-75.**

Create and date a combination, lock it while in active transportation, then
reconcile observed composition against membership. The largest build on the
board. It blocks D5's driver-confirm flow and FR-INS-049 scheduling, but
nothing corrupts while it waits, which is why it sits behind the write-path
foundations rather than in front of them.

TYRE-82's front-end consequence — disabling the configuration field once a unit
has history — lands here, with B1 as its citation.

### Parallel track — deployment

**TYRE-79, TYRE-51, TYRE-53.** Independent of the application work, so they can
fill any gap. TYRE-79 is the one with a deadline attached: a deploy that reports
success while shipping a crash-looping revision will be discovered at the worst
possible moment, and staging has to be demonstrably working before anyone is
shown it.

### Tail — analytics and lifecycle

**TYRE-41 (re-scoped first), TYRE-38, TYRE-36, TYRE-48, then TYRE-52's
successors.** TYRE-36 only once the register shape is stable, since it reads it.

### Homed, not scheduled

- **TYRE-76** (depot-scoped capture path) follows B2 — it needs the capability
  map settled before a depot manager can be granted a capture path. B2 is
  delivered, so it is unblocked. Note what B2 settled and what it did not: a
  depot manager holds `CaptureInspection` and `ManageConfig` tenant-wide, but
  still takes `ScopeDepot`, so the capture path is a scope question and not a
  capability one.
- **TYRE-59, TYRE-60, TYRE-62** are E1 residue with no dependent. They are
  deliberately unscheduled rather than forgotten; pull them when a gap appears.
- **TYRE-61, TYRE-63** are infrastructure hardening and belong with the
  deployment track.
- **TYRE-70** waits on a human with a phone and a vehicle.

### Blocked on people, not code

**TYRE-43, TYRE-44, TYRE-45, TYRE-46, TYRE-47, TYRE-64** are sponsor questions.
They are not sequenced because no amount of engineering advances them. Chase
them in the background; **TYRE-45** — BAC's real inspection sheets — is worth
pushing hardest, since three other items lean on it.

**TYRE-13, TYRE-15, TYRE-19** are the standing blockers in `open-issues.md`.
They carry no batch here because they are decisions, but two have teeth:
TYRE-13 (sponsor acceptance of ADR-0003) gates the P1 schema freeze, and
TYRE-19 (platform name and domain) becomes a hard blocker at custom-domain
setup rather than a soft one.

## Re-verifying this page

The method, so the next session can redo it rather than trust it:

```
gh pr list --state open                        # open review work
git log origin/develop --pretty=%s \           # keys actually on develop
  | grep -oE 'TYRE-[0-9]+' | sort -u
```

Match against the board with a `statusCategory != Done` search. A key present
on `develop` and open on the board is a candidate, not a conclusion — read the
ticket's definition of done before closing it. TYRE-30 is why: three of its
commits are on `develop` and it is still genuinely open.
