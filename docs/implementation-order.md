# Implementation order

Snapshot of **27 Aug 2026**, re-verified **31 Aug 2026** against `develop` @
`362c12e`.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins — and the disagreement is a bug in this page. Re-verify
before trusting a disposition below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built.

## Every commit hash below predates the 29 Aug promotion

`develop` was promoted to `main` through a pull request (#34, rebase-merged
29 Aug). GitHub's merge button cannot fast-forward, so the promotion **rewrote
all 44 commits** — `20657e1` became `362c12e` — and `deleteBranchOnMerge` then
**deleted `origin/develop`**. Trees are identical (`c526b35`), so nothing was
lost, and `origin/develop` has been recreated from `main`'s tip.

Two consequences for a session reading this page. Every hash cited below is the
pre-promotion one and **no longer resolves**; the commit subjects still do,
which is how to find them. And ADR-0004's promotion path is
`git push origin origin/develop:main` from a terminal, never a pull request —
CONTRIBUTING.md says so, and the repository setting that allowed the pull
request is unchanged.

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
| TYRE-30 | ~~Two of its folded decisions were outstanding — the PLATFORM\_ADMIN email partial unique index and the `vehicle_driver` overlap constraint~~ — **closed by B1** in migration `000026`; **Done on the board** as of the 31 Aug re-verification. DR-014b remains separate as TYRE-60 |
| TYRE-90 | Its **homing** commit is on `develop`, not its implementation. A key whose only commit is documentation stays open — this row exists so the next re-verification does not read the subject line and close it |

### Raised after this page was written

The 28 Aug re-verification found two keys the page predates rather than
misses. Both came out of B1's delivery:

| Key | What it is | Home |
| --- | --- | --- |
| TYRE-87 | Sweep unique and exclusion constraints, and unique indexes, for a missing `tenant_id`. B1 found one cross-tenant oracle and fixed it; seven pre-existing constraints sit in the same blind spot, three of them standalone partial indexes with no `pg_constraint` row | **Rides with B5.** B5 adds exactly this class of constraint — D12's `display_code_policy` gate and the active-display-code index — and the ordering rule that put B1 first applies unchanged: an integrity rule is cheap before pilot data and expensive after |
| TYRE-88 | Harden the TY008/TY009 triggers: legacy NULL-odometer fitments and `unit_kind` edits | **Rides with B5, ahead of TYRE-92**, which writes the first fitment and so is the first caller that can meet `TY009` on real data. B4 required `unit_kind` at the API and left the schema alone deliberately; that gap is this ticket's. Note the triggers stay backstops — B5 exposes no endpoint that edits a configuration or a unit kind |

### The asset flow — four keys raised 30 Aug

*Reconciliation — Asset Flow (30 Aug 2026)* (Confluence page 17170433, in space
TYRE beside the D1–D11 decision records) reconciled the privileged-user asset
surfaces against SRS v1.4, ADR-0004, ADR-0005 and the board. **That page is the
authority; this table is a pointer to it.** It found that the tyre register and
fitment — the platform's central loop — were owned by no story, and it decided
three things (§4):

| Decision | What it settles | Carried on |
| --- | --- | --- |
| **D12** | Per-tenant `display_code_policy` (`FREE` \| `GENERATED`). Under `GENERATED` the API issues the tyre's display code and refuses a hand-typed one; BAC is `GENERATED` for the pilot. FR-TYR-004 is amended from "warns, never blocks" to "warns, never blocks, **unless the tenant has opted into a generated scheme**". DB uniqueness stays active-only per tenant, so fleets branding licence+position can still onboard | TYRE-91 |
| **D13** | `mount_orientation` on `app.fitment` — `MARK_OUTBOARD` / `MARK_INBOARD` / `UNKNOWN`, default `UNKNOWN`. **Distinct from the side of the vehicle:** left/right is a property of the position; this is the tyre's own orientation on the side it is fitted to. Neither is derivable from the other. No behaviour until per-casing irregular-wear analysis reads it | TYRE-92 |
| **D14** | A tyre with an open fitment is never fitted elsewhere directly. Remove (reason, tyre to pool) then fit, or rotate atomically within one rig. **No cross-rig "move" in API or UI.** Already enforced by `one_open_fitment_per_tyre` (INV-3); D14 makes it a product rule so the screen never offers one | TYRE-92 |

| Key | What it is | Home |
| --- | --- | --- |
| TYRE-91 | The tyre register surface: receive into fleet with and without a price, the awaiting-cost queue, bulk-create with generated codes, code lookup resolving **by date** across historical reuse, scrap / sell / lost | **B5**, with TYRE-48 |
| TYRE-92 | The fitment surface: fit, remove, rotate, dispatch, on the unit's plan view. The largest unbuilt piece of the privileged-user flow | **B5**, after TYRE-91 |
| TYRE-93 | Retread return propagates to the tyre — `retread_count`, status, tread, pattern, recomputed `rand_per_mm`, casing valuation, the `max_retreads` cap. Fixes the finding TYRE-55 records and nothing owned | **B5**, with TYRE-92 |
| TYRE-94 | Unit edit and retire: `PATCH` non-configuration fields, status transitions, configuration read-only once history exists | **B5**, last |

Three deliverables the reconciliation names that are **not** tickets, listed
here because otherwise nothing carries them:

- **An SRS erratum** for D12 — FR-TYR-004's amended sentence, and a
  `display_code_policy` column on `tenant` in §5.1. SRS pages exceed the
  Confluence MCP's limits, so this is prepared as a row and pasted by hand;
  block TYRE-91's definition of done on the paste.
- **A comment on TYRE-48** that the branding path must honour the policy.
- **A front-end note on TYRE-68's navigation:** the Fleet tab is
  **Units · Tyres · Rigs · Fitments**.

### Open and correctly scoped, verified still needed

| Key | Verified at |
|---|---|
| TYRE-74 | ~~`api/internal/auth/auth.go:52-53` — `ManageConfig` is absent from both roles~~ — **closed by B2** |
| TYRE-84 | ~~No `ManageTemplates` capability exists~~ — **closed by B2** |
| TYRE-82 | ~~No trigger or constraint guards `vehicle.configuration_id` against change with history present~~ — **closed by B1** |
| TYRE-85 | ~~`000011` dropped `fitted_odometer NOT NULL`; nothing re-enforces it where the unit kind has an odometer~~ — **closed by B1** |
| TYRE-77 | ~~`statusForPgError` forwards `pgErr.Message` verbatim~~ — **closed by B3** |
| TYRE-78 | ~~`TY003` and `23505` both map to 409 in `submitStatus`, and the client cannot tell them apart~~ — **closed by B3** |

Also open and unbuilt, against `develop` rather than any branch in flight — a
key delivered on a branch that has not yet merged stays listed here until it
lands: TYRE-36, TYRE-38, TYRE-41, TYRE-48, TYRE-51, TYRE-53, TYRE-58 to
TYRE-64, TYRE-72, TYRE-73, TYRE-75, TYRE-76, TYRE-79, TYRE-83, TYRE-87,
TYRE-88, TYRE-89, TYRE-90, TYRE-91 to TYRE-94. TYRE-86 — this page itself —
closed on 28 Aug once its own method had been re-run against it; TYRE-30 closed
on the board between the 28 and 31 Aug passes.

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
could carry no test able to fail. B4 did not build such a surface either; the
deferral is re-pointed at whichever batch does (see B4's carry-forward).

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

Delivered as PR #32, rebase-merged 28 Aug 2026 (hashes below are `develop`'s,
not the branch's):

| Commit | Change | Assertion |
|---|---|---|
| `f03ae5f` | ADR-0013: parameterised inserts over a SQL function, `tenant_id` from `app.current_tenant_id()` never the request, the constraint-name-to-wire-code map, the renderable-shape-validation extension to ADR-0012 | verified against the real files rather than merely written (Task 1 self-review) |
| `7091c93` | `GET /api/axle-configurations`, capability-gated and tenant-scoped | `TestAxleConfigurationsAreCapabilityGatedAndTenantScoped` |
| `c729399` | `POST /api/vehicles` against the tenant's configuration library | `TestCreateVehicle`; `TestWriteAimedAtAnotherTenantIsRefused` — the insert names another tenant directly and is required to fail, not merely to report its own tenant back at itself |
| `78674f8` | `POST /api/users`, creating a tenant role and never `PLATFORM_ADMIN` | `TestCreateUser`; `TestWriteAimedAtAnotherTenantIsRefused_AppUser` |
| `b8326cd` | `POST /api/vehicles/{vehicleID}/drivers` — the endpoint TYRE-81's scope section does not name | `TestAssignDriverToVehicle`; `TestWriteAimedAtAnotherTenantIsRefused_VehicleDriver` |
| `49732bd` | `client.ts` carries the refusal envelope's `message`, not just its `code`; the admin API module (`createUnit`, `createUser`, `assignDriver`, `fetchAxleConfigurations`) | vitest per function; `client.test.ts` asserts the message survives, closing the gap the plan's review pass found before Tasks 7–8 could hit it |
| `7d4133f` | the add-a-unit screen, gated on `ManageAssets` | `AddUnit.test.tsx` |
| `f039946` | the add-a-driver screen with its assignment step, gated on `ManageUsers` | `AddDriver.test.tsx` |
| `f85bdc5` | both screens routed and placed in navigation behind their capabilities | `routes.test.tsx`; `navigation.test.ts` |
| `97554ee` | `web/e2e/admin.ts`, `web/e2e/admin.spec.ts` — an org admin builds a unit and a user from nothing and assigns them, on `chromium` alone | `make e2e`, 21 passed (up from 20) |
| `cfdf097` | the final whole-branch review's fixes: the e2e proof continues as the created driver to the capture screen for the created unit; `AddDriver` names the refused action, handles a tenant with no units, and clears after a create; validation messages lose their wrapping prefix; ADR-0013 completed to the template | `admin.spec.ts` asserts `CaptureStart`'s heading as the driver; `AddDriver.test.tsx` / `AddUnit.test.tsx` cover the forbidden and fallback branches; `TestCreateVehicle` asserts the exact message |

Four things this batch found, carried forward because they change what the
next batch should expect rather than because they are history:

- **The assignment endpoint was an assumption, and it is not yet confirmed by
  the ticket owner.** TYRE-81's scope section does not name
  `POST /api/vehicles/{vehicleID}/drivers`; the plan added it because the
  definition of done — "the driver can then be assigned and reach a
  capture" — cannot be met through the product without it. It shipped on that
  assumption rather than waiting on an answer, and the assumption is recorded
  in ADR-0013 and stated plainly in the PR body rather than left to be
  inferred. If the ticket owner rules it out after the fact,
  Task 5 and the assign panel in Task 8 are what to remove.
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
  deferral resolves in **B5**, though not the way this note assumed: `TY009`
  becomes reachable there and gets its entry; `TY008` never does, because the
  only ticket that touches a unit after creation refuses `configuration_id`
  outright. See that batch.
- **Rule 6's display half has no infrastructure, owned by TYRE-89.** Storage
  is UTC throughout and `app.tenant_today(timezone)` exists, but no endpoint
  sends the tenant's timezone to the client and no screen formats in it —
  `DriverHome` renders a due date in the browser's zone, and this batch's
  `AddDriver` picks an assignment's `from_date` as the browser's calendar day.
  TYRE-89 puts the timezone on `/api/me`, adds the one formatting path a
  screen may use, and defaults `from_date` server-side to the tenant's day.

No schema change: every rule governing a user or unit row was already a
constraint (B1 and B3's antecedent work), so all three write endpoints are
parameterised inserts, none a SQL function. The driver-reaches-capture half of
the definition of done is proven twice: `TestAssignDriverToVehicle` reads
`GET /api/capture/vehicles/{id}` as the driver in Go, and `admin.spec.ts` opens
the capture screen as the created driver in a second browser context, taking
the driver's id from the create response since neither admin screen surfaces
it. `make check` and `make e2e` both green at delivery and in CI.

**TYRE-58** belongs after it, not in the analytics tail: band configuration
write-time validation is a rule about a config-editing surface. Note that
TYRE-81 does not build one — it picks from the axle configuration library and
authoring stays ORG_ADMIN's through `ManageTemplates` (D8, TYRE-84) — so
TYRE-58 waits for the surface that edits tenant configuration, not for this.

### B4.5 — what sits on B4's code — **delivered**

**TYRE-83, then TYRE-89.**

Neither is large; both edit files B4 has just written, and the order matters in
one direction only: TYRE-83 changes what a create may do, TYRE-89 changes when
it does it.

TYRE-83 refines the invite surface that did not exist until B4. ADR-0013
recorded the D9/D10 constraints specifically so this would be an edit rather
than a restructure, and the 409 already carries `email_taken` rather than a
generic conflict, which is what the reactivate branch keys on.

TYRE-89 is the reason this batch is not simply deferred into B5. Rule 6's
storage half is done; its display half has no infrastructure at all, and **every
batch after this one writes dates** — B5's branding, receipt and fitment events,
B6's combination effective dates. The formatter, the `/api/me` field and the
server-side `from_date` default are cheaper before those exist than retrofitted
across them. Its eslint ban on bare `toLocale*` is what stops the rule decaying
into a convention.

One constraint from the ticket: TYRE-83's `active = false` half was left out
of B4.5's scope. NFR-PRV-004 already governs a deactivated driver's personal
information — 84 months, then pseudonymised — so nothing blocks the surface
when it is scheduled. Build the invite and reactivate paths; leave deactivation
for a later batch.

### B5 — the asset flow — **delivered**

**TYRE-48 with TYRE-91, then TYRE-92 with TYRE-93, then TYRE-94.** TYRE-87
rides along.

**B5 runs as two slices, planned separately (decided 1 Sep 2026).** The
batch's own rule forces the split: the vocabulary is frozen by the code that
first writes it, so slice 2 cannot be planned to executable detail before
slice 1's writes exist — a full-B5 plan would be the abstract freeze this
section warns against.

- **Slice 1 — built, PR open, not yet merged.** TYRE-88 → TYRE-87 → the
  D12/D13 schema and TYRE-48's vocabulary → TYRE-91's register surface.
  Plan at `docs/superpowers/plans/2026-09-01-b5-tyre-register.md`, design at
  `docs/superpowers/specs/2026-09-01-b5-tyre-register-design.md`; branch
  `TYRE-91-tyre-register`; migrations `000028`–`000031`; suite sections
  36–39. When it lands, TYRE-88 and TYRE-87 close; TYRE-91 closes only once
  the D12 SRS erratum row is pasted by hand; **TYRE-48 stays open** — its
  retread paths are slice 2's.

  **TYRE-87's actual sweep found eight offenders, not the ticket's seven** —
  the ticket's manual audit missed `reading`'s 3-uuid tuple. Final
  disposition: five re-keyed tenant-first in migration `000029`
  (`position`/`code`, `combination_member`/`sequence`,
  `reading_measurement`/`ordinal`, `valuation_snapshot`/`as_at`,
  `exception.one_open_exception_per_subject`), three allowlisted as
  opaque-uuid-only (`reading`'s 3-uuid tuple, two `fitment` partial
  indexes). The `valuation_snapshot` cross-tenant oracle was confirmed
  empirically the same way B1's was — `23505`, not `23503` — before the
  re-key, so the blind spot B1 first named was real, not theoretical, in
  a second constraint too.

  **The plan also inserted one small task the original 14 did not
  anticipate.** Task 13's e2e implementer found the plan narrated a
  cost-setting UI flow that no task (10/11/12) had ever been briefed to
  build — the server endpoint (Task 8) sat idle. An advisor-consulted
  ruling inserted Task 10b to build it (a per-row cost form on
  `TyreList.tsx`, gated to awaiting-cost rows only) before Task 13 could
  write a truthful spec; Task 13's TY011 step was separately reframed to
  assert D12's UI contract rather than an unreachable on-screen refusal.
  See the branch's `docs/lessons.md` entry dated 2026-09-01 and the PR
  body for the full rulings.
- **Slice 2 — plan after slice 1 merges, against the then-frozen
  vocabulary.** TYRE-92 with TYRE-93, then TYRE-94. It discharges TY009's
  `submitStatus` deferral; TY008 never enters (below). Pick up here: read
  slice 1's design doc §Out-of-scope table first — it names what was
  deliberately deferred and to which ticket.

  **Slice 2 — delivered 2026-09-03 (TYRE-92/93/94/48, PR #41).** Plan and
  design at `docs/superpowers/plans/2026-09-01-b5-fitment-surface.md` and
  `docs/superpowers/specs/2026-09-01-b5-fitment-surface-design.md`; branch
  `TYRE-92-fitment-surface`.

  | Migration | What it does |
  |---|---|
  | `000032_fitment_written_once` | a fitment is written once and closed once; the breakdown dispatch joins the vocabulary; removal reasons; Sandbox depots |
  | `000033_fitment_functions` | the fitment lifecycle functions — fit, remove, rotate, dispatch, return |
  | `000034_log_retread_return` | a retread return propagates to the tyre — the cap and the rejected-casing valuation |
  | `000035_vehicle_status_and_audit` | unit status transitions, audited per ADR-0014 |
  | `000036_asof_fallback_dated` | the as-at register's `last_tread_mm` fallback applies only when `last_tread_at` is NULL or not after the as-at bound — U10's money change over the merged `000013` function, reversible in one migration. The comparison is against `bound.ts`'s UTC day edge, not the tenant calendar; that residual over-reach is inherited from `000013` and ticketed as TYRE-123 |

  Thirteen routes reach `/api` for the first time in this slice: the unit
  read and its PATCH (`GET`/`PATCH /vehicles/{id}`), status transitions
  (`POST /vehicles/{id}/status`), fitment history and the fleet-wide open
  list (`GET /vehicles/{id}/fitments`, `GET /fitments`), depots and retread
  jobs (`GET /depots`, `GET /retread-jobs`), the three fitment writes
  (`POST /vehicles/{id}/fitments`, `POST /fitments/{id}/remove`,
  `POST /vehicles/{id}/rotations`), and dispatch, return-to-stock and Log
  Retread (`POST /tyres/{id}/dispatch`, `POST /tyres/{id}/return`,
  `POST /retread-jobs/{id}/return`). `TY008`'s non-entry in `submitStatus`
  is done in code, not merely decided: `patchUnit`'s request type carries no
  `configurationId`/`unitKind` field, and `decodeJSONStrict` refuses either
  key outright (ADR-0012's amendment).

  The web surface: the unit screen (`UnitDetail` — a data-driven plan view,
  fit, remove, rotate, edit and status), the register's dispatch and
  return-to-stock actions, the retread queue, and the fleet-wide fitments
  list, routed behind their capabilities per the corrected D7 (spec
  correction, 2026-09-03). `web/e2e/fitments.spec.ts` is the proof: one
  continuous, serial Playwright run against Sandbox Fleet that receives
  stock, fits a trailer and a horse, rotates, removes, dispatches a casing
  to the retreader, logs its return, then parks and disposes the unit —
  every write this slice added, in one chain where each step reads what the
  step before it wrote.

  **Close-out review, 3 Sep 2026.** An independent five-lane review of PR
  #41 (with the rls-auditor and valuation-verifier on the database delta)
  found no Critical and nine Important findings; all were fixed on the branch
  or ticketed before merge. The one behavioural defect was in the database: a
  removal or rotation could be stamped before the fitment it closed, which the
  event-based instant guard could not see for a fitment opened outside
  `app.fit_tyre`. It is now refused (TY012) and enforced by a CHECK on
  `app.fitment`. Everything the review left open — eight owner decisions and
  fourteen small fixes — is registered as **TYRE-128**, with TYRE-124..127
  for the four items large enough to stand alone. The full report is the PR's
  review comment; the review workspace was deleted after it was posted, so
  TYRE-128 and that comment are the record.

The tyre register and fitment are the platform's central loop — a fleet tyre
system that cannot receive a tyre or record where it is fitted does not
demonstrate its own premise — and until 30 Aug no story owned either. The
sequence is the reconciliation's own (§5) and each link is a real dependency,
not a preference:

- **TYRE-48 with TYRE-91**, not before it. The event vocabulary is frozen by
  the code that first writes it; frozen in the abstract it will be wrong.
- **TYRE-91 before TYRE-92** — you cannot fit what you cannot receive.
- **TYRE-93 with TYRE-92**, because a retread return *is* a refit. Splitting
  them means building the return path twice.
- **TYRE-94 last.** Nothing corrupts while unit edit and retire wait.

This batch carries the last schema changes that are cheap before pilot data:
D13's `mount_orientation` column and D12's `display_code_policy`. That is also
why TYRE-87's constraint sweep rides with it rather than waiting for the
analytics tail — B5 is adding constraints of exactly the class TYRE-87 sweeps.

**This batch discharges ADR-0012's deferral — but only half of it, and the
other half resolves rather than moves again.**

`TY009` becomes reachable here. **TYRE-92 writes the first fitment**, which is
exactly what it fires on, so it gets its `submitStatus` entry and its wire code
in this batch, with a test that fails without it.

`TY008` does **not**, and no later batch will change that. It fires on an
*update* of `vehicle.configuration_id`, and TYRE-94 — the only ticket that
touches a unit after creation — refuses `configuration_id` on `PATCH`
outright: correcting a wrong configuration is a documented migration or a
retire-and-re-add (D11(ii)), and `unit_kind` is the same. So the trigger is a
pure database backstop against a path the API deliberately does not offer, and
an entry in `submitStatus` could carry no test able to fail — not yet, but
ever, unless some later decision reopens configuration editing. Leave it out
and record why; do not re-point it a third time.

TYRE-88 hardens both triggers and belongs ahead of TYRE-92, for the reason B1
came first: it is cheap before pilot fitments exist.

TYRE-93 is SQL, not Go. It is a business rule about tyres — a recomputed
`rand_per_mm` and a casing valuation — so it lands in `db/` with a test in
`db/tests/`, and `make check` must stay green **including the Appendix E pins**.
The valuation is the acceptance gate; there is exactly one implementation of it.

**Before any screen in this batch is named, read §3 of the reconciliation.**
"Configuration" is reserved for the axle-configuration template — ORG_ADMIN,
`ManageTemplates`, immutable once a unit has history. Using it for the
controller's rig and fitment work collides with that gating, with TYRE-82's
trigger, and with every SRS reference from FR-VEH-010 on. The Fleet tab is
**Units · Tyres · Rigs · Fitments**.

### B6 — the rig-setup surface — **next**

*Numbered B5 until 31 Aug 2026, when the asset flow took that slot. Commit
`20657e1` — "home the FR-INS-049 schedule surface in B5" — means this batch.*

**Kick-off, in this order (written 3 Sep 2026, as PR #41 merges):**

1. **Cut `TYRE-72-rig-setup` from `develop` after PR #41 has landed**, not
   before: B6's combination effective dates read the unit status and fitment
   rows B5 slice 2 wrote, and the branch should carry 000036 from the start.
2. **Read TYRE-128 first and put the eight owner decisions to the owner
   before the spec is written.** Two of them shape this batch directly: the
   ViewFleet-versus-ManageAssets reading of "screens gated on X" (B6's rig
   screens face the same choice, and the two batches must answer it the same
   way), and whether plans and handoff prompts belong in `docs/` (decides
   where B6's own plan lives). U11 and the rest can be answered in parallel
   but should be answered, not carried a third time.
3. **Carry TYRE-124..127 and TYRE-128's small fixes with whichever B6 task
   touches their area**, the way TYRE-87 rode with B5; do not open a
   residue-only branch for them. TYRE-124 (000025's stale comment) belongs
   with the first B6 migration, since it needs a migration to correct.
4. **Then TYRE-72 with TYRE-90, then TYRE-73, then TYRE-75**, as below.
   TYRE-101 (cross-unit rotation within a rig) was deferred from B5 to this
   batch and is TYRE-72's natural sibling once a combination exists.

Two standing rules from B5's close-out apply to every branch from here: the
API container is restarted immediately before every `make e2e` and never
reused across two runs, and no test derives a tenant-relative date from the
browser or CI clock (`docs/lessons.md`, 2026-09-03).

**TYRE-72 with TYRE-90, then TYRE-73, then TYRE-75.**

Create and date a combination and schedule an inspection task for a driver,
lock the combination while in active transportation, then reconcile observed
composition against membership. TYRE-90 (FR-INS-049's schedule surface) was
named as "the natural sibling" in TYRE-72, TYRE-73 and TYRE-81 and owned by
none of them until 28 Aug; TYRE-72's own text says to build the two together,
and they share the `ManageAssignments` gate. It blocks D5's driver-confirm flow
and FR-INS-049 scheduling, but nothing corrupts while it waits, which is why it
sits behind the write-path foundations rather than in front of them.

**This batch may run in parallel with B5**, and the reconciliation says so
explicitly: TYRE-72 touches units, not tyres. The two share no table and no
endpoint. Sequenced here because one engineer cannot run both, not because B5
blocks it — if a second pair of hands appears, this is what they take.

TYRE-82's front-end consequence — disabling the configuration field once a unit
has history — belongs to **TYRE-94** in B5, whose scope names it directly, with
B1 as its citation.

### Parallel track — deployment

**TYRE-79, TYRE-51, TYRE-53.** Independent of the application work, so they can
fill any gap. TYRE-79 is the one with a deadline attached: a deploy that reports
success while shipping a crash-looping revision will be discovered at the worst
possible moment, and staging has to be demonstrably working before anyone is
shown it.

### Tail — analytics and lifecycle

**TYRE-41 (re-scoped first), TYRE-38, TYRE-36, then TYRE-52's successors.**
TYRE-36 only once the register shape is stable, since it reads it. TYRE-48 left
this tail on 31 Aug — the event vocabulary is frozen by the code that writes it,
which is B5's.

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
git rev-parse origin/develop^{tree} \          # develop and main must agree
             origin/main^{tree}                # after a promotion
```

Match against the board with a `statusCategory != Done` search. A key present
on `develop` and open on the board is a candidate, not a conclusion — read the
ticket's definition of done before closing it. TYRE-90 is why: its only commit
on `develop` is the one that homed it in this page.

The third command is the 29 Aug lesson. Compare **trees**, never hashes: a
promotion that went through a pull request rewrites every hash while leaving
the tree identical, so equal trees mean the branches agree and unequal hashes
alone mean nothing. If `origin/develop` is missing entirely, it was deleted by
`deleteBranchOnMerge` and is restored with
`git push origin origin/main:refs/heads/develop`.
