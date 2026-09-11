# B7, analytics and dashboard, design

**Date:** 2026-09-10 · **Batch:** B7 (`docs/implementation-order.md` §B7) ·
**Tickets:** TYRE-41, TYRE-211 (resolver half), TYRE-183, TYRE-193, TYRE-38,
TYRE-36, and new tickets under TYRE-7 for the design system, the dashboard and
the restyle · **Riders:** TYRE-176, TYRE-182, the two capture defects raised by
this spec · **Authority:** SRS v1.4 §4.10 (FR-VAL-010..013, 020..022, 031),
§4.11 (FR-ANL-023..028, 044, 045), §4.12.2 (FR-RPT-040, 041), §4.13 and §4.13.1
(FR-EXC-001..015, 020..041), §4.14 (FR-DSH-001..019); Appendix H.1 (the POC
lists for VAL, ANL, RPT, EXC, DSH), H.2, H.3 criteria 5 and 6; Appendix J.1 to
J.3 (pageId 10977281); the project brief §2, §4 and §8; ADR-0006, ADR-0010,
ADR-0011, ADR-0012, ADR-0013, ADR-0014; the review-sweep findings TYRE-183,
TYRE-193, TYRE-211; the owner's answers of 10 Sep 2026 (analytics before
deployment; design system first; tokens plus CSS with Radix for the hard
controls). Reviewed 11 Sep 2026 by three independent lenses (SQL, conventions,
requirements coverage); every finding is folded in below.

This is the one committed design document for the batch. Each slice gets its
own gitignored plan under `docs/superpowers/plans/`, written after the slice
before it has merged (CLAUDE.md, documentation split; TYRE-128 decision 4).

## What B7 is

The project brief promises a fleet manager "a live dashboard led by
value-at-risk in rands: what is below threshold, what the estate is worth, what
is costing too much, what to replace next month". Appendix H.3 makes two of the
seven POC success criteria depend on it: criterion 5, the exception engine
reproduces the Appendix J fixture exactly, and criterion 6, the system produces
one credible, quantified value-at-risk figure in rands with its provenance
split disclosed. At `develop` @ `dfab2f1` neither exists outside the database
test suite. The valuation engine and the five exception rules the suite checks
are proven only by `db/tests/004_tests.sql`, the API serves no aggregate and no
exception, and the web app has no dashboard: a manager who logs in lands on the
unit list.

B7 closes that gap, in four slices:

| Slice | Tickets | One sentence |
|---|---|---|
| **B7.1** | TYRE-41, TYRE-211 (resolver), TYRE-183, TYRE-193 (view), TYRE-38 rides | One exception view scoped to each unit's latest inspection, two resolvers, one value-at-risk view, and the suite pins 19, 11 and 9 as numbers through them. |
| **B7.2** | TYRE-36, TYRE-193 (endpoint) | Tenant-scoped, depot-scoped read endpoints that relay those views, money as exact decimal strings, cent-exact integration tests. |
| **B7.3** | new: ADR-0015 and the dashboard, under TYRE-7 | The design system on tokens, plain CSS and Radix primitives, and the manager landing page led by value at risk. |
| **B7.4** | new: the restyle, under TYRE-7; carries TYRE-176, TYRE-182 and the two capture defects | Every existing fleet and admin screen moves onto the design system; the capture sheet gets defect fixes only. |

The exception **lifecycle** (FR-EXC-001 evaluation at receipt, 006..011: one
open row per rule and subject, RAISED to CLOSED, assignment, auto-close on a
resolving event), the **rule administration surface** (FR-EXC-004, 005) and
**notifications** (FR-NOT-001..003, 006) are in Appendix H.1 and are not in
B7. They are B8, ticketed now, and the view B7.1 builds is the rule source
B8's rows are raised from. B7 delivers counts and lists; B8 delivers workflow.

## Why slices, and the gate every slice passes

B6's gate is unchanged and applies to every B7 slice:

1. **Branch** `TYRE-<key>-<slug>` cut from `develop` after the previous slice
   has merged; the next slice's plan is written against the merged vocabulary.
2. **Every task ends with `make check`**; every SQL rule has a suite section
   that was seen failing before the migration existed; every read endpoint has
   a cross-tenant probe and a cross-depot probe that would succeed on a leak,
   not merely change its error text.
3. **A Playwright chain on Sandbox Fleet** for anything a user does, and a
   read-only chain on BAC for the three-way agreement, in its own Playwright
   project that the writing projects depend on (§B7.3); the API container is
   restarted before the run and never reused across two runs
   (`docs/lessons.md` 2026-09-03).
4. **`/comment-audit`**, then an independent five-lane review plus the
   `rls-auditor` on every migration and the `valuation-verifier` on B7.1 and
   B7.2 (both touch money paths).
5. **PR to `develop`** with the U-table marked confirm-or-reverse; the owner
   merges. Then the next slice is planned.

One addition for B7.3 and B7.4: **a mockup gate before code.** The plan for each
web slice starts with mockups (the `design` skill's canvas, with
`frontend-design` setting direction and `dataviz` governing every chart and
stat tile) that the owner reviews before a component is written. The current
front end is functional and plain; the redesign is the point, so it is reviewed
as a design first and as code second.

## Decisions taken without the owner, confirm or reverse

| # | Decision | Why | Reversal cost |
|---|---|---|---|
| **U1** | **FR-EXC-038 (spare below removal threshold) defaults to CRITICAL, not the SRS table's WARNING.** | Appendix J.2 accounts for 19 exceptions; "11 urgent" is true only if the spare at 2.0mm counts as urgent, which is what both prototypes compute (`fleet_dashboard.html` treats any position at or below removal depth as urgent). A spare at scrap depth fails when it is finally needed (Q21). SRS erratum row prepared, §Non-ticket deliverables. | One seeded severity value. |
| **U2** | **FR-EXC-020 fires at or below the retread threshold** (`governing_tread_mm <= retread_threshold_mm`), the same figure the valuation floors at. | §4.13.1 says "< policy scrap threshold"; Appendix J.2 and J.3 place positions 11, 12, 13 and 16 exactly on 4.0 and count them, FR-VAL-004 and FR-EXC-038 say "at or below", and the suite has always used `<=`. The removal point is the retread threshold in this schema (000013, "a tyre is pulled when retreading protects the casing"); scrap sits at or below it. Moot for BAC, where both are 4.0. Flagged as an SRS conflict; not silently picked. | One comparator, one column name. |
| **U3** | **FR-EXC-021 is a band**: `retread_threshold_mm < governing_tread_mm < warning_threshold_mm`. | Read literally, "< policy threshold + 2mm" also fires on the nine positions already below the threshold and the total becomes 28. J.2 lists position 14 alone. `warning_threshold_mm` is the configured form (rule 5); BAC seeds it at 6.0, which is threshold + 2. A NULL column disables the rule for that tenant rather than inventing a default. | One predicate. |
| **U4** | **FR-EXC-035 is orientation-agnostic.** | Spread is max minus min over the grooves, the same set whichever groove is outer; 000011 states the rule for `v_irregular_wear_ranking`. Every fixture reading loads `orientation_known = false` and J.2 still pins positions 5, 6, 7, 8, 18 and the spare. Read literally, §4.13.1's parenthetical zeroes the rule on the fixture. Flagged. | One predicate. |
| **U5** | **Exception rules resolve the tenant-wide policy row** (`operating_group_id IS NULL AND axle_class IS NULL`), exactly as `removal_threshold_mm_for` does, through the one resolver. | The register floors tread value at that row. A steer tyre "below threshold" on the dashboard but priced above the floor in the register would be the disagreement this batch exists to remove. Per-axle pricing at the write sites is TYRE-211's remainder and the resolver already carries the dimension. | Two arguments at one call site. |
| **U6** | **Severity and enabled live on `app.exception_rule`; thresholds do not.** Nine rule rows are seeded per tenant; `threshold jsonb` stays NULL and its comment says why. | FR-EXC-004 (enable, disable, configure) is in H.1. A jsonb threshold beside `threshold_policy`, `target_pressure` and `configuration` would be a second source for the same number. | One column comment. |
| **U7** | **The exception engine is a view in B7 (approach C).** No `app.exception` rows are written. | The dashboard needs counts and lists; H.3 criterion 5 is proven directly by a view; lifecycle rows raised from the view are B8. | None; B8 is additive. |
| **U8** | **The value-at-risk headline counts running positions only; spares are a disclosed second line.** | BR-RPT-001 excludes spares from tread reporting by default and FR-RPT-005 requires the report to say so. | One filter and one column. |
| **U9** | **`app.v_spare_tyre_age` is re-created** on the tenant's calendar day (`app.tenant_today`) and the latest reading. | It uses `current_date` (rule 6) and `t.last_tread_at`, the audit column, where the latest reading exists; the spares list (FR-DSH-019) would be wrong on the dashboard. | One view. |
| **U10** | **`app.target_pressure_for` is extracted, returns NULL for a SPARE unconditionally, and `inflation_compliance` calls it.** B7.2 moves the capture context's inlined copy in Go onto it. | Three pressure-target resolutions exist (000013's LATERAL, `capture.go`'s LATERAL, section 8's axle-only join) and they disagree on the spare: only `capture.go` guards `axle_class <> 'SPARE'`. The exception view would be a fourth. FR-CFG-013 (errata E1) says a spare's pressure is unclassifiable; that rule lives in the one resolver. | None; identical rows, pinned, including a planted tenant-wide row. |
| **U11** | **The three write-side `threshold_policy` reads (`fit_tyre`, `dispatch_tyre`, `log_retread_return`) stay with TYRE-211's remainder.** B7.1 lands the resolver, moves `removal_threshold_mm_for` onto it, and the new views consume it. | Those three functions were re-created whole in B6.3; reopening them in a read batch widens the blast radius for no dashboard gain. After B7.1 the comparator still lives in four bodies; TYRE-211's remainder moves the three onto the resolver and TYRE-142 (three callers passing `now()` into the exclusive `p_before`) settles the comparator once. | None. |
| **U12** | **TYRE-38 is proven by a superuser-staged negative file**, `db/tests/005_privileged.sql`, run as `postgres` inside `BEGIN … ROLLBACK` from a new `make db-test-privileged` target that `make test` and CI call after the app_login suite. `make db-test` stays exactly what it is. | The backstop cannot be watched red as `app_login` (dropping a composite FK is a superuser act). A control that ships without ever being seen to fire is worth less than it appears (TYRE-38's own words). The alternative, an accepted-risk note, is the reversal. | One file, one make target, one CI step, and the one-line exception added to the five sentences that say the suite is app_login-only (§Non-ticket deliverables). |
| **U13** | **B7.1's view also carries FR-EXC-023, 028 and 039**, all POC rules computable from the latest readings, all producing zero rows on the fixture. **FR-EXC-037 is not carried**: Appendix H.2 defers it, so J.2's two axle rows are excluded from the 19 and the view emits none. | Adding rules later means a second migration re-creating the view; pinning their zeros now documents the boundary J.2 states for 039 ("not raised"). FR-EXC-026, 027 and 029 are unit-level and served as their own tiles (§B7.2); FR-EXC-041 is unconstructable under 000030. | Three predicates. |
| **U14** | **`resolved_by_fitment` is a column of the view, computed.** Open means not resolved. | FR-EXC-010 is in H.1; a dashboard that keeps shouting about a tyre replaced last week is the "permanently-red dashboard that trains users to ignore alerts" §4.13 warns against. Computed from the open fitment, so no write path. | One column. |
| **U15** | **No dark mode in B7.** Tokens are structured as light-first with the dark values absent, not as a single flat palette. | The prototype's toggle is not in H.1; the yard-signage sunlight-first palette is the driver's need. | Additive. |
| **U16** | **The capture flow does not change in B7.** B7.4 fixes the 390px clipped fourth tile and moves the dev tenant and actor switchers out of the phone header; nothing else on the sheet moves. | NFR-USE-001 governs; the keypad geometry is the product. | None. |
| **U17** | **`GET /api/dashboard` is one composed endpoint, one transaction.** The list shapes are their own endpoints. | Every tile on the landing page must share an as-at instant; a client composing nine calls cannot promise that. | Additive. |
| **U18** | **Exception rules are judged at the inspection's `submitted_at`; the register and the value-at-risk hero are judged at today.** The two agree on the fixture and diverge after a policy change or a removal, and the dashboard names which figure comes from which (§B7.3). | FR-EXC-001 evaluates rules against the submitted inspection at receipt, and FR-CFG-051 applies a policy change prospectively; the snapshot trigger prices at the snapshot's date for the same reason. FR-VAL-031 and FR-DSH-004 say "currently", which is the register. Every exception row carries the threshold it was judged against, so it explains itself. Section 59 pins both behaviours with a planted later policy row. | One `bound` expression. |
| **U19** | **FR-EXC-032 is not a rule row; it is the money attribute of the 020 and 038 rows**, served by `v_tyre_at_risk`. Consequence: it cannot be disabled separately from 020 under FR-EXC-004. TYRE-193's "the FR-EXC-032 rule row" is read as "the rule's figure exists", not as a tenth row. | A row that duplicates 020's subject and predicate with a rand column would be one open exception per subject twice (FR-EXC-006). | One seeded row. |
| **U20** | **`v_exception`'s subject vocabulary is the table's: TYRE, POSITION_PAIR, VEHICLE**, and a reading with no tyre on record raises no row. 000045 replaces `app.exception.subject_type`'s comment so B8 inherits one vocabulary. | Two vocabularies for one concept is the second-implementation smell. A position with nothing recorded on it has nothing to remove; it surfaces on the register as an unknown position (FR-INS-026), not here. | One CASE. |

## How this batch treats the code it meets

`docs/architecture.md` is the authority: the database is the domain model, Go
and the browser are thin, one rule lives in one place. Three consequences:

- **No rule logic outside SQL.** Not in Go ("for speed"), not in TypeScript
  ("for the chart"). The three-way agreement is restated below as three
  consumers of one implementation, not three implementations.
- **Views and functions are re-created whole, never patched.**
  `inflation_compliance`, `v_spare_tyre_age`, `v_estate_valuation` and section
  8 are replaced in full in 000045 with their old bodies deleted, in 000036's
  shape.
- **A shared shape is not widened for one consumer, except where the consumer
  is the requirement.** `v_tyre_valuation` is read, not rewritten.
  `v_estate_valuation` gains the casing provenance split because FR-DSH-002
  asks for it on both sides and nothing else can supply it without Go
  aggregating money.

## Sequencing inside the batch

B7.1 → B7.2 → B7.3 → B7.4, each planned after the previous merges.

- **B7.1 first** because it is the integrity rule: TYRE-41 says "do this before
  either client computes an exception count, not after", and the ordering rule
  in `docs/implementation-order.md` says an integrity rule is cheap before
  pilot data and expensive after.
- **B7.2 before B7.3** because the dashboard's numbers arrive through the API
  and the mockups are reviewed against real responses, not fixtures.
- **B7.3 before B7.4** because the design system is built once, on the one
  new screen, and the restyle then applies it to ten existing screens
  without redesigning them a second time.

## B7.1, the exception view and the pins (TYRE-41, TYRE-211, TYRE-183, TYRE-193, TYRE-38), designed to executable detail

Migration `000045_exception_view`. Suite section 59, section 8 re-written in
place, and the new privileged file. No new SQLSTATE the app role can meet: the
one new `RAISE` (D5) is reachable only with a composite FK removed.

### D1. Two resolvers

`app.threshold_policy_for(p_tenant uuid, p_operating_group uuid,
p_axle_class app.axle_class, p_before timestamptz) RETURNS app.threshold_policy`,
`LANGUAGE sql STABLE`, schema-qualified body, no `SET` clause, matching
000013's `removal_threshold_mm_for`. (It is a scalar composite result with a
`LIMIT`, so the planner calls it per row rather than inlining it; section 8d
does not sweep it. If `EXPLAIN` on `v_exception` over the fixture shows the
per-row call matters, the plan declares it `RETURNS SETOF app.threshold_policy`
and uses it in a `LATERAL`, which inlines and which 8d then sweeps.)

```sql
SELECT p.* FROM app.threshold_policy p
 WHERE p.tenant_id = p_tenant
   AND (p.operating_group_id IS NULL OR p.operating_group_id = p_operating_group)
   AND (p.axle_class IS NULL OR p.axle_class = p_axle_class)
   AND p.effective_from < p_before
 ORDER BY (p.operating_group_id IS NULL), (p.axle_class IS NULL), p.effective_from DESC
 LIMIT 1
```

The axle-class fallback is the shape `fit_tyre` already implements
(000039:176-182); the operating-group tier is new, because `fit_tyre` pins
`operating_group_id IS NULL` and no site reads a group row today (TYRE-211).
`p_before` is the exclusive upper edge, `removal_threshold_mm_for`'s
convention; `fit_tyre` reads `effective_from <= now()` inclusive, and that
difference is exactly what TYRE-142 settles when the write sites move (U11).
Passing `NULL, NULL` selects the tenant-wide row and nothing narrower (U5); the
seeded `-infinity` baseline rows resolve under `<` at every date.
`app.removal_threshold_mm_for(p_tenant, p_before)` is re-created as
`SELECT (app.threshold_policy_for(p_tenant, NULL, NULL, p_before)).retread_threshold_mm`.
Sections 17, 18, 20 and 44 (the register and the as-at register, Appendix E
to the cent) are the proof that nothing moved; section 7 pins the arithmetic
with a literal threshold and does not exercise the resolver.

`app.target_pressure_for(p_tenant uuid, p_size uuid, p_axle_class
app.axle_class, p_before timestamptz) RETURNS app.target_pressure`, same shape.
The precedence is `inflation_compliance`'s `ORDER BY` copied verbatim, which
ranks size-and-class, then size-only, then class-only, then tenant-wide
(000013:112-114; `capture.go:219-221` matches it; 000013's prose comment at
102-103 says the opposite and stays as it is, because an applied migration is
never edited; the correct statement lives on the new function):

```sql
SELECT tp.* FROM app.target_pressure tp
 WHERE p_axle_class IS DISTINCT FROM 'SPARE'
   AND tp.tenant_id = p_tenant
   AND (tp.axle_class IS NULL OR tp.axle_class = p_axle_class)
   AND (tp.size_id IS NULL OR tp.size_id = p_size)
   AND tp.effective_from < p_before
 ORDER BY (tp.size_id IS NOT NULL) DESC, (tp.axle_class IS NOT NULL) DESC, tp.effective_from DESC
 LIMIT 1
```

The first predicate is FR-CFG-013 (errata E1) in the one place: a spare's
pressure is unclassifiable, never compliant, never an exception, even for a
tenant that adds a tenant-wide row. `inflation_compliance` is re-created with
its LATERAL replaced by a call; its section pins prove identical rows, and
section 59 plants a tenant-wide target row inside its transaction and pins
that the spare still resolves to NULL while position 16 still resolves to the
TRAILER row.

### D2. The latest inspection per unit

```sql
CREATE VIEW app.v_latest_unit_inspection WITH (security_invoker = true) AS
SELECT DISTINCT ON (r.tenant_id, r.vehicle_id)
       r.tenant_id, r.vehicle_id, i.id AS inspection_id, i.submitted_at, i.received_at
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
 WHERE i.state <> 'VOIDED'
 ORDER BY r.tenant_id, r.vehicle_id, i.submitted_at DESC, i.received_at DESC, i.id;
```

Resolved through `reading.vehicle_id`, the owning unit (FR-INS-061), never
`inspection.vehicle_id`, which is the motive unit of the rig: both fixture
inspections carry `veh1` there. A trailer inspected solo after its rig was
inspected resolves to its own later inspection; the rig's other members keep
theirs. Ties on `submitted_at` break on `received_at` then `id`, so the answer
is deterministic under out-of-order sync.

`app.v_latest_reading` is `v_reading_detail` joined to this view on
`(tenant_id, vehicle_id, inspection_id)`, plus `app.reading` for
`pressure_temperature` (added after `v_reading_detail` was last created) and
`app.tyre` for `size_id`, and `app.vehicle.home_depot_id` as `depot_id` for
ADR-0006 composition. It is the one population every position rule below
reads. FR-EXC-036 pairs two tyres of one axle end from one inspection, which
`v_dual_mate_difference` already guarantees by joining on `inspection_id`; the
rule filters that view through `v_latest_unit_inspection` rather than
re-deriving the pair.

### D3. The rule catalogue and the view

**Seeded rule rows.** `db/seeds/gen_seed_configurations.py` emits nine
`app.exception_rule` rows per seeded tenant (BAC, Second Fleet, Sandbox
Fleet), `code` the FR id, `name` the SRS rule name, `enabled = true`,
`severity` per the table below, `threshold` NULL with a column comment saying
thresholds live in `threshold_policy`, `target_pressure` and `configuration`
(U6). No provisioning function exists (H.1: tenants are provisioned by hand);
until one does, B7.2's `rules_configured` is the disclosure, so a tenant with
no rows shows "no exception rules configured" rather than a clean sheet.

| Code | Rule | Predicate over `v_latest_reading` (thresholds from tenant config) | Severity | Subject |
|---|---|---|---|---|
| FR-EXC-020 | Below removal threshold | `NOT is_spare AND governing_tread_mm <= thr.retread_threshold_mm` | CRITICAL | TYRE |
| FR-EXC-038 | Spare below removal threshold | `is_spare AND governing_tread_mm <= thr.retread_threshold_mm` | CRITICAL (U1) | TYRE |
| FR-EXC-021 | Approaching threshold | `NOT is_spare AND governing_tread_mm > thr.retread_threshold_mm AND governing_tread_mm < thr.warning_threshold_mm` (no rows when NULL) | WARNING | TYRE |
| FR-EXC-022 | Pressure dangerously under | `pct < 100 - tgt.critical_under_pct` | CRITICAL | TYRE |
| FR-EXC-023 | Pressure under | `pct >= 100 - tgt.critical_under_pct AND pct < 100 - tgt.warn_under_pct` | WARNING | TYRE |
| FR-EXC-035 | Irregular wear across the tread | `width_spread_mm >= config_for('width_spread_warn_mm')`, spares included, orientation ignored (U4) | WARNING | TYRE |
| FR-EXC-036 | Dual-mate mismatch | `v_dual_mate_difference.difference_mm >= config_for('dual_mate_warn_mm')` on the latest inspection | WARNING | POSITION_PAIR |
| FR-EXC-028 | Damage reported | `damage_flag` | WARNING | TYRE |
| FR-EXC-039 | Suspected pressure transcription | `v_pressure_uniformity_anomaly.suspected_transcription` for an inspection that is the latest of its **motive** unit (`inspection.vehicle_id`), joined once per inspection | INFO | VEHICLE |

Every TYRE row requires `tyre_id IS NOT NULL` (U20). `thr` is
`app.threshold_policy_for(tenant_id, NULL, NULL, bound)` and `tgt` is
`app.target_pressure_for(tenant_id, size_id, axle_class, bound)`, both
resolved at `bound = submitted_at` of the inspection the row comes from (U18),
so a policy change after the inspection does not re-judge it (FR-CFG-051; the
same reason the snapshot trigger prices at the snapshot's date). `pct` is
`pressure_kpa * 100.0 / tgt.target_kpa`, NULL when no target resolves.

**`app.v_exception`** (`security_invoker = true`) is the UNION ALL of the nine
predicates, each joined to its `exception_rule` row on `(tenant_id, code)` and
filtered on `enabled`. Columns:

| Column | Meaning |
|---|---|
| `tenant_id`, `rule_code`, `rule_name`, `severity`, `urgent` | `urgent` is `severity = 'CRITICAL'`; the word the documents use, computed here and nowhere else |
| `subject_type`, `subject_id` | TYRE (the tyre id), POSITION_PAIR (the outer tyre's id), VEHICLE (the motive unit) |
| `vehicle_id`, `fleet_number`, `unit_label`, `depot_id`, `axle_class`, `position_code`, `position_code_2`, `is_spare` | `depot_id` is the unit's home depot, for ADR-0006; `position_code_2` and the pair's second tyre only on POSITION_PAIR |
| `tyre_id`, `display_code` | the tyre the reading recorded, which may since have moved |
| `inspection_id`, `observed_at` | FR-EXC-015 "last seen"; `observed_at` is `submitted_at` |
| `measure_mm`, `measure_pct`, `threshold_mm`, `threshold_pct` | the number judged and the configured number it was judged against, so a row explains itself |
| `detail` jsonb | measurements array, `pressure_kpa`, `target_kpa`, `pressure_temperature`, the pair's two depths |
| `resolved_by_fitment` | true when the tyre named on the row no longer holds an open fitment at that position (U14); the fixture has none, so every pin below holds with and without the filter |

Rows for FR-EXC-032 (casing at scrap risk) are not emitted (U19): the money
lives in D4, joined by `tyre_id`.

### D4. Value at risk

```sql
CREATE VIEW app.v_tyre_at_risk WITH (security_invoker = true) AS
SELECT v.tenant_id, v.tyre_id, v.display_code, v.vehicle_id, v.fleet_number,
       v.depot_id, v.position_code, p.is_spare, v.current_tread_mm,
       v.removal_threshold_mm, v.tread_source, v.read_at,
       v.casing_value, v.casing_basis
  FROM app.v_tyre_valuation v
  JOIN app.fitment f  ON f.tyre_id = v.tyre_id AND f.removed_at IS NULL
  JOIN app.position p ON p.id = f.position_id
 WHERE v.state = 'FITTED'
   AND v.current_tread_mm IS NOT NULL
   AND v.removal_threshold_mm IS NOT NULL
   AND v.current_tread_mm <= v.removal_threshold_mm;
```

`app.v_casing_value_at_risk` aggregates it in `v_estate_valuation`'s shape:
`level` TENANT or DEPOT with `key_name`, crossed with `position_class`
RUNNING or SPARE (U8), via GROUPING SETS: `tyre_count`, `actual_count` (basis
ACTUAL, a retreader's figure), `estimated_count` (basis ESTIMATED or AUDIT,
with `audit_count` disclosed inside it), `unvalued_count`, and
`casing_value_at_risk = sum(casing_value)` over the valued rows only, never
zero-filled (FR-VAL-013, FR-VAL-031, NFR-PRO-002/003). The tread side of these
tyres is R0.00 by FR-VAL-004 and is not restated. This view is judged at today
(U18): "currently below the policy threshold" is the register's word.

Fixture expectation, to the cent: TENANT / RUNNING 9 tyres, 9 `audit_count`,
0 unvalued, **R16,537.50**; TENANT / SPARE 1 tyre, **R1,837.50**; the DEPOT
rows for BAC's one depot carry the same figures. The valuation-verifier checks
them; a fresh Appendix E pin run is the gate as always (FR-VAL-006).

`app.v_estate_valuation` is re-created whole with three more counts,
`casing_actual_count`, `casing_estimated_count` and `casing_audit_count`, so
FR-DSH-002's "each with its provenance split" is answered for the casing side
by SQL; its existing pins prove the existing columns did not move.

### D5. TYRE-38, the snapshot backstop

`app.snapshot_on_governing_change` (live body: 000008) gains, **before** the
`IF NEW.tyre_id IS NULL … RETURN NULL` guard, so that any cross-tenant
inspection reference is refused whether or not a tyre is named:

```sql
IF (SELECT i.tenant_id FROM app.inspection i WHERE i.id = NEW.inspection_id)
   IS DISTINCT FROM NEW.tenant_id THEN
  RAISE EXCEPTION 'reading % names an inspection outside its tenant', NEW.id
    USING ERRCODE = 'insufficient_privilege';
END IF;
```

The rationale is cited at the function, pointing at 000004's canonical note,
not restated. `reconcile_valuation_snapshots` already asserts the tyre's
tenant (000029), so the inspection lookup is the trigger's one uncovered edge;
TYRE-38's widened scope (the RLS-unbound branch of that tyre assert, the
tenant-free ON CONFLICT arbiter, `tyre_valuation_asof`'s id-only joins) is
partly proven here and partly stays open on the ticket, stated in the PR.

Proof (U12): `db/tests/005_privileged.sql`, run by `make db-test-privileged`
as `postgres` inside `BEGIN … ROLLBACK`. The staging it needs, because
`reading_sealed` (000040) refuses a reading on any inspection not created in
the same transaction, and Second Fleet seeds no tyre:

1. Plant a BAC inspection in the transaction (its `created_at` equals
   `transaction_timestamp()`, so the seal passes) and a Second Fleet tyre.
2. Drop `reading_inspection_id_fkey`.
3. Insert a Second Fleet reading naming the BAC inspection and the Second
   Fleet tyre; insert one measurement so `refresh_governing_tread` fires the
   chain.
4. Trap the guard's own message text ("names an inspection outside its
   tenant"), not the bare SQLSTATE: 42501 is raised by three functions in the
   chain and a bare code would be vacuous (`docs/lessons.md` 2026-09-01).
5. A second probe drops `reading_tyre_id_fkey` and inserts a BAC reading naming
   the Second Fleet tyre, expecting `reconcile_valuation_snapshots`' own
   message ("is not tenant … to reconcile"), which proves that assert's
   RLS-unbound branch for the first time.

The file's header says why it exists and why it must never run as anything but
a negative control. `make db-test` is unchanged and stays app_login-only; the
new target is wired into `make test` and into CI's "Schema, isolation and
valuation" job as its own step.

### D6. The pins (TYRE-183)

**Section 8 is rewritten in place** to assert the same five position sets it
asserts today through `v_exception` joined to `v_combination_reading` on
`(inspection_id, vehicle_id, unit_own_code)` for the sheet's 1..26 projection,
exactly as its FR-EXC-036 branch already does. `v_combination_reading` carries
running positions only, so the projected FR-EXC-035 string stays
`5,6,7,8,18` and the spare's FR-EXC-035 and FR-EXC-038 rows are asserted
separately on `is_spare`, as today's FR-EXC-038 branch does. FR-EXC-021 is
asserted at `14`, and 023, 028 and 039 at zero. Expected values do not change;
the text that says "each query here names the sheet" goes, because the view
names it.

**Section 59 pins the numbers**, as BAC under `app_login`:

| Assertion | Expected |
|---|---|
| `count(*) FROM app.v_exception` | **19** |
| `count(*) FILTER (WHERE urgent)` | **11** |
| `count(*) FILTER (WHERE rule_code = 'FR-EXC-020')` | **9** |
| the same three with `NOT resolved_by_fitment` | 19, 11, 9 (the fixture has no resolution, so both agree) |
| per rule: 020 → 9, 021 → 1, 022 → 1, 023 → 0, 028 → 0, 035 → 6, 036 → 1, 038 → 1, 039 → 0 | as listed |
| no row carries `inspection_id = md5('insp0')` | insp0 is invisible |
| `v_latest_unit_inspection` for veh1, veh2, veh3 | all `insp1` |
| a Second Fleet inspection on `t2veh1` with one tyre and one reading planted in the transaction under the tenant-2 GUC, then re-bound to BAC | not visible to BAC; section 8b's sweep covers the new views |
| a planted BAC inspection with six equal pressures on a solo unit | exactly one FR-EXC-039 row, subject that unit (not one per rig member) |
| a planted tenant-wide `target_pressure` row (U10) | the spare still resolves to NULL; position 16 still resolves to TRAILER |
| a planted later `threshold_policy` row at 5.0, effective now (U18) | `v_exception` 020 stays 9 (judged at July's 4.0); `v_tyre_at_risk` RUNNING becomes 10 (position 14 at 5.0 joins) |
| `v_casing_value_at_risk` | TENANT / RUNNING 9 / R16,537.50, TENANT / SPARE 1 / R1,837.50, DEPOT rows equal |
| disabling FR-EXC-021 on BAC's rule row inside the transaction | total 18, urgent 11 |
| `v_removal_forecast` within the seeded horizon (D7) | 0 |
| `app.unit_inspection_status` (D7) at 2026-08-01 and 2026-09-01 | 3 unscheduled, coverage NULL; stale 0 then 3 |

The disable row is the rule-catalogue proof: `enabled` is read, not
decorative. The policy row is U18 made visible.

**The three-way agreement is restated** where a client author will find it
(TYRE-41's DoD): CLAUDE.md's testing section, `.claude/commands/verify.md`,
`README.md` and `docs/achievements.md`, all of which carry the claim today.
The database computes the exceptions once, in `app.v_exception`. The API
relays them (B7.2). The dashboard leg is a Playwright assertion that the
rendered counts for BAC equal 19, 11 and 9 (B7.3). The capture app's leg is
unchanged: per-vehicle warnings at entry, asserted against the database for
one fixture vehicle (the capture spec of 2026-08-25, "Three layers"). "Three
tiers agree" means three consumers of one implementation, and a change that
breaks one is visible because the other two still read the same view.

### D7. Riders carried by B7.1

- **U9**: `v_spare_tyre_age` re-created: `age_days` as
  `app.tenant_today(t.timezone) - received_date` with a join to `app.tenant`
  (RLS returns the caller's row), `days_since_measured` against the latest
  non-voided reading of the spare's tyre, falling back to `last_tread_at`,
  with a `measured_source` column saying which (READING / AUDIT / NULL).
- **Coverage and staleness get substrate** (FR-DSH-005, FR-DSH-006,
  FR-EXC-027): `app.unit_inspection_status(p_as_at date)` returns one row per
  active unit with `last_inspected_at`, `interval_days` (its active
  `inspection_schedule`, by unit then by operating group, else NULL),
  `covered` (inspected within the interval; NULL when unscheduled),
  `stale` (days since exceed `reading_staleness_days`) and `days_since`, and
  `app.v_unit_inspection_status` is it at the tenant's today. Coverage is
  covered over scheduled units with unscheduled disclosed, never counted as
  covered; stale is its own figure on its own key, so the two tiles are two
  numbers.
- **The forecast horizon becomes configuration** (rule 5): key
  `forecast_horizon_days`, seeded 30, read through `app.config_for`. The
  FR-DSH-009 count is `v_removal_forecast` rows with `basis` other than
  `AT_OR_BELOW_THRESHOLD` and `INSUFFICIENT_DATA`, `NOT is_spare`, and
  `earliest_removal_date` within the horizon of the tenant's today; on the
  fixture that is 0, and the already-below tyres are FR-DSH-004's, not this
  tile's.
- `api/CLAUDE.md` "Money over the wire" is corrected: numeric is scanned as
  text into a string and emitted as a JSON string; no decimal library exists
  or is wanted. The code is right and the sentence is stale.
- The precedence statement on `app.target_pressure_for` is the one that
  matches the `ORDER BY`; 000013's comment stays (applied migrations are
  frozen) and the new function's header says it supersedes that sentence.
- Every requirement ID this slice implements is cited at the object
  (FR-EXC-020..039 at the view, FR-VAL-031 at the at-risk view, FR-EXC-015 at
  `observed_at`), so the IDs stop returning zero from `rg`.

### Test data and the proof

Second Fleet (tenant 2, `22222222…`, `t2veh1` on a HORSE_6X4 configuration) is
the cross-tenant control, planted inside the section's own `BEGIN … ROLLBACK`
with one tyre, one inspection and one reading (the pattern of sections 25 and
40 to 44). The fixture is not changed: the two inspections it already carries
are exactly the latest-inspection case TYRE-41 describes, and the 2026-08-25
capture spec's sentence that the scoping was "invisible while every vehicle
has exactly one seeded inspection" is stale and gains a one-line pointer here.

## B7.2, the analytics read API (TYRE-36, TYRE-193), outline

Planned after B7.1 merges. No migration expected. Every handler follows
`tyres.go`'s shape: one transaction, `SET LOCAL app.tenant_id` through
`store.go`, `numeric` scanned as text into `*string`, response structs of its
own, `require(...)` on the capability.

| Route | Reads | Capability |
|---|---|---|
| `GET /api/dashboard?depot=&from=&to=` | one composed struct: value at risk (RUNNING and SPARE rows), estate valuation with both provenance splits, exceptions by severity and by rule with `rules_configured`, below-threshold count (from `v_tyre_at_risk`, U18), coverage and unscheduled and stale counts (`v_unit_inspection_status`), overdue task count (`v_inspection_task.overdue`), pending composition reports (FR-EXC-029, `GET /api/combinations/observations`' source), inflation compliance over `from`..`to`, tread band distribution, forecast-within-horizon count, irregular wear count (FR-EXC-035 rows, running, with the spare disclosed), `as_at` | ViewFleet; every rand field projected only under ViewValuation |
| `GET /api/exceptions?severity=&rule=&vehicle=` | `v_exception`, natural order by fleet number then position | ViewFleet |
| `GET /api/valuation/estate?level=&asAt=` | `v_estate_valuation` or `tyre_valuation_asof` aggregated for a date | ViewValuation |
| `GET /api/valuation/at-risk` | `v_tyre_at_risk` rows plus the aggregate rows | ViewValuation |
| `GET /api/analytics/tread-distribution?level=` | `v_tread_distribution` | ViewFleet |
| `GET /api/analytics/irregular-wear` | `v_irregular_wear_ranking` filtered to the configured spread and `NOT is_spare` | ViewFleet |
| `GET /api/analytics/inflation-compliance?from=&to=` | `app.inflation_compliance` | ViewFleet |
| `GET /api/analytics/wear-rate` | `v_tyre_wear_rate` | ViewFleet |
| `GET /api/analytics/removal-forecast?horizonDays=` | `v_removal_forecast`; the default horizon is the configured key | ViewFleet |
| `GET /api/spares` | `v_spare_tyre_age` | ViewFleet |

**Depot scope is composed in SQL** (ADR-0006 option C): a `ScopeDepot` actor
(TECHNICIAN, DEPOT_MANAGER) reads `v_exception` and `v_tyre_at_risk` joined
through `v_depot_vehicle`, and the aggregates' DEPOT rows for the actor's
depots; a `ScopeTenant` actor reads the TENANT rows and may filter by depot.
The integration tests carry a TECHNICIAN control that must not see the
tenant-wide hero. Operating-group filtering (FR-DSH-011) is deferred with its
true reason: `vehicle.operating_group_id` is live but no surface assigns it
(TYRE-109) and the fixture has no group. The capture context (`capture.go`)
moves its inlined pressure-target LATERAL onto `app.target_pressure_for`
(U10). Tests: integration against Postgres proving each endpoint returns the
figures the suite pins (19/11/9, R16,537.50, the 15 Appendix E valuations
through the register), a request with no tenant context fails closed, a tenant
cannot read another's figures through any route, a depot actor cannot read
another depot's, and a money-path grep for `float64` is clean (scoped to
money: the cohort wear rate in `capture.go` is mm per month, not rands).

## B7.3, the design system and the dashboard, outline

Planned after B7.2 merges. Two tickets under TYRE-7: the design system (with
ADR-0015) and the dashboard.

**ADR-0015, UI substrate.** Tokens in `web/src/theme/tokens.ts` grown into a
full scale (type ramp, space, radius, elevation, semantic colour roles for
severity and provenance, and a tread-band scale keyed by band ordinal, beside
the existing `statusColor` scale, which stays the severity scale); plain CSS
on custom properties, as today; Radix primitives (`@radix-ui/react-select`,
`-dialog`, `-popover`) for the controls where focus, keyboard and
screen-reader behaviour are hard to hand-roll; inline SVG for charts under the
`dataviz` method, no chart library; the per-tenant brand colour keeps its
WCAG-derived hover and pressed states. Bundle cost is measured on the capture
route and must not grow beyond what the phone build already ships.

**Components** (each with a vitest and an example page reachable in dev):
PageHeader, StatTile (value, label, provenance line, link), SeverityBadge,
ProvenanceSplit (actual / estimated / unvalued as one bar), DataTable
(right-aligned numerics, basis column, sticky header, empty and loading
states), Panel, EmptyState, FormField, Button (primary, secondary, quiet,
danger), Select and Dialog (Radix), FilterBar, BandChart (tread bands), the
AppShell rework (a dev bar for the tenant and actor switchers, collapsed by
default, never in the phone header).

**The dashboard**, route `/` for any actor holding ViewFleet (FR-DSH-001;
drivers keep `/my`, FR-DSH-012), reading `GET /api/dashboard`:

1. **Value at risk** as the hero (FR-DSH-017, FR-RPT-040): the rand figure,
   its provenance split, the spare line, "from N tyres at or below the
   removal threshold today", linking to the at-risk list. N is the register's
   count (U18).
2. **Estate value** split tread and casing, each with its provenance split
   (FR-DSH-002).
3. **Open exceptions** by severity, each linking to the filtered list
   (FR-DSH-003), counting `v_exception` rows only; **below threshold** (004)
   from the register; the row explains that the first is "as inspected" and
   the second "today".
4. **Inspection coverage** with unscheduled disclosed (005); **overdue
   tasks**, **stale units** and **unreconciled rig reports** (006, FR-EXC-026,
   027, 029), each its own tile.
5. **Inflation compliance** for a selectable period with its hot, cold and
   unknown basis (007).
6. **Tread band distribution** (008) as the one chart.
7. **Replacement window opens within the configured horizon** (009) and
   **irregular wear** count (016), both linking.
8. **Spares** (019), the dedicated list, never on a tread-ranked panel.
9. A depot filter across the page (011) and a refresh (013).

Every figure states what it is not: unvalued tyres are counted and named,
absence renders as "not measured", never 0 (NFR-PRO-002/003, ADR-0010). The
exceptions list, route `/exceptions`, is the filtered table the tiles link to,
with the rule, severity, unit, position, measure against threshold, last seen
and "replaced since" columns.

**The three-way e2e, in its own project.** `capture.spec.ts` writes BAC
(TYRE-208) and `playwright.config.ts` is `fullyParallel`, so a read-only BAC
spec in an existing project would race the writes and the 19/11/9 would depend
on ordering. `web/e2e/dashboard.spec.ts` therefore runs in a new
`bac-readonly` project (desktop viewport) that the `android` project lists in
`dependencies`, so every BAC read completes before any BAC write starts. It
reads BAC as Pieter through a shared `web/e2e/bac.ts` helper (the `actAs`
already in `smoke.spec.ts`, extracted) and asserts the rendered exception,
urgent and below-threshold counts are 19, 11 and 9 and the hero reads
R16,537.50. `smoke.spec.ts`'s landing assertion (a controller reaches `/fleet`)
changes to the dashboard at `/`.

## B7.4, the restyle, outline

Planned after B7.3 merges. One ticket under TYRE-7, carrying TYRE-176 (basis
labels on the register's money columns) and TYRE-182 (enum labels through
`vocabulary.ts`), and the two capture defects raised by this spec: the fourth
entry tile is clipped at 390px, and the dev switchers push the sheet down the
phone screen. Scope, the ten routes `routes.tsx` serves today: Units, Unit
detail (two-column layout, the plan view as a real component, forms grouped in
panels), Tyres register (numerics right-aligned, an actions column that acts),
Receive tyres, Rigs, Fitments, Retreads, Add a unit, Add a user, Driver home.
The capture sheet's keypad, auto-advance, tiles and review flow are untouched
(U16); the Playwright `reach.spec.ts` measurements are the proof.

## Out of scope (owned, not forgotten)

- **Exception lifecycle, evaluation at receipt, rule administration and
  notifications** (FR-EXC-001, 004, 005, 006..011, FR-NOT-001..003, 006): B8,
  ticketed under TYRE-7 by this spec's close-out, reading `v_exception` as
  its rule source. FR-EXC-004's write surface waits with TYRE-58 for a
  configuration-editing screen.
- **FR-EXC-037** (axle side-to-side divergence): Appendix H.2 defers it; its
  two Appendix J.2 rows are not pinned and `v_exception` emits none (U13).
- **Reports and exports** (FR-RPT-002, 020..023, 030, 031, 037, 041 as
  documents): TYRE-6, unchanged.
- **Forecasting set and cost per kilometre** (FR-ANL-010..015, 040..043):
  Appendix H.2 defers them; `v_removal_forecast` is read, not extended.
- **Per-axle and per-operating-group threshold resolution at the write
  sites**: TYRE-211's remainder; the comparator: TYRE-142 (U11).
- **Operating-group filtering** (FR-DSH-011's second half): after TYRE-109.
- **Dark mode** (U15). **Photo capture**, **PWA manifest**: TYRE-152, TYRE-154.

## Non-ticket deliverables

- `docs/adr/0015-ui-substrate.md` (B7.3).
- `docs/implementation-order.md` §B7, committed with this spec; the rows flip
  as slices merge.
- CLAUDE.md testing section, `.claude/commands/verify.md`, `README.md` and
  `docs/achievements.md` restated per D6 (B7.1).
- The one-line exception for the privileged file (U12) added to CLAUDE.md
  ("`make db-test` … as a non-superuser"), `db/CLAUDE.md`, the Makefile
  comment, the ci.yml step comment and `db/tests/004_tests.sql`'s header
  (B7.1).
- `web/CLAUDE.md`'s sentence that tread band colours are keyed to band names
  (TYRE-27) and the matching comment on `statusColor` in `tokens.ts` are
  corrected when the ordinal band scale lands (B7.3).
- **SRS errata rows, prepared for the owner's paste**
  (`docs/spec/HANDOFF-srs-errata-b7-2026-09-10.md`, gitignored; SRS pages
  exceed the Confluence MCP's limits; B7.1's DoD is gated on the paste):
  FR-EXC-038 default severity CRITICAL (U1); FR-EXC-020 "at or below the
  removal threshold" (U2); FR-EXC-021 "between the removal threshold and the
  warning threshold" (U3); FR-EXC-035 parenthetical replaced by
  "orientation-agnostic; orientation-unknown readings are excluded from
  directional diagnosis only" (U4).
- Jira: a sprint "B7, analytics and dashboard"; comments on TYRE-41, TYRE-36,
  TYRE-38, TYRE-183, TYRE-193, TYRE-211 stating which half each slice
  delivers; new tickets for the design system, the dashboard, the restyle,
  the two capture defects and B8.
