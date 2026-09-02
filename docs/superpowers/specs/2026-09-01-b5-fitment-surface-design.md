# B5 slice 2 — the fitment surface: design

**Date:** 2026-09-01 · **Batch:** B5 slice 2 (docs/implementation-order.md) ·
**Tickets:** TYRE-92, TYRE-93, TYRE-94; closes TYRE-48. **Authority:**
Confluence page 17170433 (*Reconciliation — Asset Flow, 30 Aug 2026*) §2.4–2.7,
§3, §4 (D12/D13/D14), §5; SRS v1.4 Appendix C.1; each ticket's own definition
of done. **Predecessor:** `2026-09-01-b5-tyre-register-design.md` (slice 1),
whose §Out-of-scope table names what this slice inherits.

Written against `develop` @ `ff1744e`, after PR #39 (slice 1) and PR #40
(TYRE-97) merged. The vocabulary this slice writes against is therefore frozen
by real code, which is the condition the order doc set for planning it.

## Decisions taken without the owner — confirm or reverse

This design was written unattended. Each item below is a call the owner may
reverse; the plan is arranged so reversing any one is a bounded edit.

| # | Decision | Where it binds | Reverse by |
|---|---|---|---|
| U1 | **Fit is from `IN_STOCK` only.** A `REMOVED` tyre is returned to stock as an explicit action first (Appendix C `REMOVED → IN_STOCK`, FR-FIT-003, the owner's 30 Aug comment on TYRE-92). No implicit return inside `fit_tyre` | D2 | one branch in `app.fit_tyre` plus one register-row action |
| U2 | **Dispatch is from `REMOVED` only**, to either destination (Appendix C lists no `IN_STOCK →` dispatch; FR-TYR-011 makes every unlisted transition invalid) | D2 | one state check in `app.dispatch_tyre` |
| U3 | **Rotation is within one unit** (FR-FIT-010's words). D14's "within one rig" needs a live combination to define the rig, and combinations arrive in B6 (TYRE-72). Cross-unit rotation inside a rig is B6's extension, recorded in the out-of-scope table | D2 | `app.rotate_tyres` gains a combination parameter in B6 |
| U4 | **The audit mechanism is an ADR (0014) and attaches to `app.vehicle` only in this slice.** Nothing writes `app.audit_log` today; TYRE-94 asks for audited mutations (FR-AUD-001). A generic row trigger is the mechanism; widening it to other tables is a follow-up ticket, not this slice | D5, ADR-0014 | detach the trigger; the ADR records the alternative |
| U5 | **The retread cap reads the tenant-wide `threshold_policy` row** (`axle_class IS NULL`, `operating_group_id IS NULL`, latest `effective_from`). A `REMOVED` tyre has no axle class, so the per-class rows cannot govern a dispatch; `retreads_permitted` per class is read at *fit* as FR-FIT-006's warning instead | D3 | one resolver query |
| U6 | **PATCH takes `tags` with replace-all semantics** in the same transaction (FR-VEH-041; `vehicle_tag`/`vehicle_tag_map` exist since 000012). Tag names are created on first use per tenant | D6 | drop the field; the out-of-scope table then names the deferral |
| U7 | **A malformed id in a path is 400 `bad_request` everywhere.** Slice 1's tyre endpoints answer 422 for it and the capture read answers 400; this slice adds nine id-carrying routes and ends the split on the 400 side, because a path that does not parse is a malformed request, not an invalid submission | D6 | revert two lines in `tyres.go` |
| U8 | **`REFITTED` is written when the fitted tyre has any prior fitment row**, `FITTED` otherwise. TYRE-48's comment assigns `refitted` to the post-retread path; a prior-fitment test is deterministic, needs no caller flag, and is a superset of that reading | D2 | one predicate in `app.fit_tyre` |
| U9 | **A rejected casing writes a zero `RETREADER` casing valuation citing the job**, not only the job row. BR-VAL-004 calls the rejection "a documented event", and FR-TYR-009 makes it the sole legitimate source of a zero; the register's `casing_basis` precedence (000013) then reads it as `ACTUAL` | D3 | one INSERT |
| U10 | **Fit and removal tread readings update `last_tread_mm`/`last_tread_at`** when later than the tyre's current `last_tread_at`. They are measured values (ADR-0010) and the valuation views read `last_tread_mm` as current tread; a fit at a known tread that left the register showing a stale figure would be a CR-012 defect. Monotonic on time, so a backdated fit never overwrites a newer inspection | D2, D3 | two UPDATE clauses |
| U11 | **A retread fitted to a non-permitted axle class warns; only the cap refuses.** TYRE-93's DoD says "a dispatch beyond `max_retreads` or on a non-permitted axle class is refused", but its scope line says "refused or warned per FR-CFG-044", and FR-FIT-006 is explicit: "warn, without blocking". A dispatch has no axle class to refuse on; the fit is where the class is known, and the SRS says warn there. Flagged as a DoD-versus-SRS conflict rather than picked silently | D2, D3 | make `RETREAD_ON_NON_PERMITTED_AXLE` a TY014 refusal in `app.fit_tyre` |

## Why this is the second slice, and what it inherits

Slice 1 froze `tyre_event.type`'s vocabulary by writing `RECEIVED`, `BRANDED`,
`SCRAPPED`, `SOLD`, `LOST`; established the lifecycle-functions pattern
(`SECURITY INVOKER`, `FOR UPDATE` on the tyre row, state and event moving
together, TY-class refusals forwarded verbatim); and left TY009's wire entry
for the first fitment writer. This slice writes the other half of the
vocabulary — `FITTED`, `REFITTED`, `ROTATED`, `REMOVED`, `SENT_FOR_RETREAD`,
`RETURNED` — and finds the vocabulary one value short (D1).

Inherited from slice 1's out-of-scope table, with disposition:

| Deferred | Disposition here |
|---|---|
| Fit / remove / rotate / dispatch, `mount_orientation` behaviour, TY009's `submitStatus` entry | **Built** (D2, D6) |
| Retread return propagation, rejected-casing scrap, `LogRetread` gate's first use | **Built** (D3, D6) |
| Unit PATCH/retire, TY008's permanent non-entry rationale in code | **Built** (D5, D6) |
| `brand_pending` workshop workflow | still TYRE-48 residual → re-home to a new ticket at close-out (TYRE-48 closes here) |
| FR-EXC-041 observed-duplicate exception from capture | exceptions work, unchanged |
| "Rebalancing" as maintenance note vs event | unchanged; stays out of the vocabulary |

## Sequencing inside the slice

1. **ADR-0014** — the audit mechanism (U4). Cheaper to record than to unpick.
2. **Schema hardening before the first writer** — the fitment
   immutability trigger (D1), for the reason B1 and TYRE-88 came first.
3. **TYRE-92's SQL, then TYRE-93's** — a retread return is a refit and
   reuses the fit path's warnings.
4. **TYRE-94's SQL** — last of the schema, nothing corrupts while it waits.
5. **RLS audit** of the four migrations before any Go.
6. **Go**, plumbing first (PATCH, id parsing, the wire codes), then reads,
   then writes.
7. **Web**, shared pieces first (the form-mutation hook, the register split),
   then the unit screen, then the queues, then routes and navigation.
8. **e2e**, then close-out.

## Decisions

### D1. `app.fitment` is written once and closed once; the vocabulary gains one value

**The trigger.** Rule 3 says fitment events are immutable and enforced by
grants, but `app.fitment` is *not* in the append-only set: `app_rw` holds
`UPDATE` on it (000001) and only `DELETE` was revoked (000018), because closing
a fitment is an UPDATE of the row's `removed_*` columns — the schema's design
since 000001. Nothing today stops an UPDATE of `tyre_id`, `position_id`,
`fitted_at` or `mount_orientation`, or a second "closure" of a closed row.
TYRE-92 says the API must not expose an in-place update; this makes it a
database fact instead of a convention:

- `BEFORE UPDATE ON app.fitment`, function `app.fitment_is_written_once()`,
  trigger **`fitment_written_once`**. Refuses with **TY014** when
  `OLD.removed_at IS NOT NULL` (already closed), or when any column outside
  the closure set differs between OLD and NEW. The closure set is
  `removed_at, removed_odometer, removed_tread_mm, removal_reason,
  distance_km, distance_source`; `updated_at`/`updated_by` are excluded from
  the comparison because `fitment_stamps_updated` (000017) writes them on
  every UPDATE.
- The name sorts after `fitment_odometer_matches_unit_kind` and
  `fitment_stamps_updated`, so on the same UPDATE TY009's trigger still fires
  first and suite section 36b/36c keep their SQLSTATEs. This is a load-bearing
  naming choice and the migration's header says so.
- Corrections are compensating events (FR-FIT-015, CR-004): close the wrong
  fitment with reason `correction` and open the right one. No endpoint edits a
  fitment.

**The vocabulary.** `dispose_tyre` writes the event type as the target state's
name; slice 1's CHECK has `SENT_FOR_RETREAD` but nothing for the other
dispatch destination. The CHECK is replaced (slice 1 D1 accepted this cost)
to add **`SENT_TO_BREAKDOWN_SUPPLIER`**. `RETURNED` serves every return to
stock — from the retreader, from the breakdown supplier, and from `REMOVED`
(Appendix C's "return to stock") — with `to_state` and `from_state` telling
them apart. No other value is added.

**Removal reasons are tenant configuration** (rule 5, FR-FIT-008). A
`removal_reasons` key in `app.configuration` (jsonb array of strings) is
seeded for every tenant with FR-FIT-008's minimum plus the two this slice
writes itself:

`["worn_to_threshold","damage","irregular_wear","casing_failure",
"vehicle_disposal","rotation","correction","puncture"]`

`remove_tyre` and `rotate_tyres` validate against it (TY014). The API serves
the list on the unit read so the screen offers exactly the tenant's reasons.

### D2. The fitment functions — TYRE-92

All `SECURITY INVOKER`, `SET search_path = app, pg_temp`, run inside the
tenant-bound transaction. Each locks the tyre row `FOR UPDATE`; each writes the
fitment row, the tyre's `state`/`current_depot_id`, and the `tyre_event` in one
statement sequence, so state and log never disagree. An unknown or
cross-tenant id is indistinguishable from missing under RLS and raises
**TY012** with a per-object message — `'no such tyre in this fleet'` (slice
1's string, reused), `'no such unit in this fleet'`, `'no such fitment in
this fleet'`, `'no such position on this unit'`. Each message is distinct so a
cross-tenant probe can pin it (lesson 2026-09-01).

Instants follow the slice-1 lesson: `p_occurred_at` defaults to `now()`, is
refused if in the future or earlier than the tyre's latest `tyre_event`
(FR-FIT-016), and a backdate of more than 24 hours requires `p_reason`
(TY014 when absent).

**`app.fit_tyre(p_tyre uuid, p_vehicle uuid, p_position uuid, p_tread_mm
numeric, p_mount_orientation app.mount_orientation, p_odometer bigint
DEFAULT NULL, p_occurred_at timestamptz DEFAULT now(), p_reason text DEFAULT
NULL) RETURNS TABLE (fitment_id uuid, warnings jsonb)`**

- Tyre must be `IN_STOCK` (FR-FIT-003) — otherwise TY012 naming the current
  state and, when `FITTED`, the unit and position it is on (the owner's D14
  comment: "naming its current location").
- The position must belong to the vehicle's `configuration_id` — checked
  explicitly, because position ids repeat across units of one configuration
  (lesson 2026-08-26) and the FK alone does not catch a wrong pairing. TY014.
- `p_tread_mm` is required (FR-FIT-001 captures tread at fitment); TY014 when
  NULL or outside `(0, 30]`.
- `p_odometer` is passed through; TY009 (the trigger) decides whether the
  unit kind requires it. The function does not duplicate that rule.
- Occupied position and second open fitment are **left to the two partial
  unique indexes** (the DoD says "refused by the DB"). The function makes no
  pre-check for them; the 23505 reaches Go and `conflictCodes` names it (D6).
- Writes the fitment with `mount_orientation` (D13), the tyre to `FITTED`
  with `current_depot_id = NULL`, and one event: `FITTED` when the tyre has no
  prior fitment row, `REFITTED` otherwise (U8), `to_state = 'FITTED'`,
  payload `{"fitment_id","position_code","vehicle_id"}`.
- Updates `last_tread_mm`/`last_tread_at` when `p_occurred_at` is later than
  the current `last_tread_at` (U10).
- **Warnings, never blocking** (returned as a jsonb array of
  `{"code","message"}`, empty when none):
  - `SIZE_DIFFERS_ON_AXLE` — another open fitment on the same
    `axle_number` of this unit carries a different `size_id` (FR-FIT-005).
    Silent when either size is NULL (absence is absence, CR-012).
  - `RETREAD_ON_NON_PERMITTED_AXLE` — `tyre.status = 'RETREAD'` and the
    resolved `threshold_policy` row for the position's `axle_class` has
    `retreads_permitted = false` (FR-FIT-006, FR-CFG-044).
  - `DUAL_MATE_TREAD_GAP` — the position is `INNER` or `OUTER` and the mate
    (same unit, axle, side, other slot) has an open fitment whose tyre's
    `last_tread_mm` differs from `p_tread_mm` by more than the tenant's
    `dual_mate_warn_mm` configuration (FR-FIT-020; the key already exists,
    default 3).

**`app.remove_tyre(p_fitment uuid, p_reason text, p_tread_mm numeric,
p_odometer bigint DEFAULT NULL, p_occurred_at timestamptz DEFAULT now(),
p_backdate_reason text DEFAULT NULL) RETURNS void`**

- Fitment must be open (TY012 when closed — a second removal is a state
  error, not an input error).
- `p_reason` must be in the tenant's `removal_reasons` (TY014).
- `p_tread_mm` required, same bounds (FR-FIT-007).
- Provenance is written, never defaulted silently (FR-FIT-009, CR-012):
  `distance_source = 'MEASURED'` and `distance_km = p_odometer -
  fitted_odometer` when both odometers exist (TY014 if it would go negative
  — the constraint 000011 dropped, restored as a function rule);
  `'UNAVAILABLE'` with `distance_km = NULL` otherwise. `INFERRED` is not
  written by anything until OI-31's coupling records exist.
- Closes the row (the only UPDATE the trigger permits), tyre to `REMOVED`
  with `current_depot_id = vehicle.home_depot_id`, event `REMOVED`
  (`to_state = 'REMOVED'`, `reason = p_reason`, payload
  `{"fitment_id","distance_km","distance_source"}`). Updates
  `last_tread_mm`/`last_tread_at` per U10.

**`app.rotate_tyres(p_vehicle uuid, p_moves jsonb, p_odometer bigint DEFAULT
NULL, p_occurred_at timestamptz DEFAULT now()) RETURNS TABLE (tyre_id uuid,
fitment_id uuid)`**

`p_moves` is `[{"tyre_id","to_position_id","tread_mm"}, ...]`.

- At least two moves (TY014). Every tyre must have an open fitment on
  `p_vehicle` (TY012 naming the first that does not). Every target position
  must be on the unit's configuration (TY014), targets distinct (TY014), and
  each target either vacated by this same rotation or currently empty (TY014
  naming the position — a rotation never displaces a tyre it was not told
  about).
- One transaction: close every involved fitment with reason `rotation`,
  provenance as in `remove_tyre` from the one `p_odometer`; then insert the
  new fitments with `fitted_odometer = p_odometer`, `fitted_tread_mm` from
  the move, and **`mount_orientation` carried over from the closed fitment**
  (a rotation does not flip the tyre; a flip is a remove-and-fit). Closing
  all before opening any is what keeps the partial unique indexes quiet
  mid-statement.
- One `ROTATED` event per tyre, `to_state = 'FITTED'` (the state is
  unchanged, D2 of slice 1 requires the row say so), payload
  `{"from_position_code","to_position_code","fitment_id"}`.
- Atomicity is the function's own transaction (FR-FIT-010, FR-FIT-014). The
  test for "interrupted mid-transaction leaves no half state" is a move set
  whose last move is invalid: after the refusal, every original fitment is
  still open and no new row exists.

**`app.dispatch_tyre(p_tyre uuid, p_destination app.tyre_state, p_depot uuid,
p_sent_on date DEFAULT NULL) RETURNS TABLE (retread_job_id uuid)`**

- `p_destination` is `AT_RETREADER` or `AT_BREAKDOWN_SUPPLIER` (TY012
  otherwise). Tyre must be `REMOVED` (U2; TY012 naming the state).
- `p_depot` must be this tenant's depot of the matching `depot_type`
  (`RETREADER` / `BREAKDOWN_SUPPLIER`), active (TY014).
- `p_sent_on` defaults to `app.tenant_today()`; bounded to today or earlier.
  The event instant is `now()` when `p_sent_on` is the tenant's today, and
  tenant-local midnight of that day — `least(p_sent_on::timestamp AT TIME
  ZONE tz, now())` — for any earlier date. It is refused with **TY012** when
  it would fall earlier than the tyre's latest `to_state` event, and is never
  clamped to that event: two `to_state` events sharing one instant leave
  `app.tyre_in_estate_asof` unable to resolve the tyre (FR-FIT-016,
  FR-VAL-022).
- **The cap (BR-FIT-009, FR-CFG-044):** for `AT_RETREADER`, refuse with
  **TY015** when `tyre.retread_count >= max_retreads` of the tenant-wide
  policy row (U5). A capped casing "is a purchase, not a retread
  candidate"; the refusal message says so and names the count and the cap.
- `AT_RETREADER` inserts the `retread_job` (`sent_at = p_sent_on`,
  `retreader_depot_id = p_depot`) and returns its id; the breakdown
  destination returns NULL.
- Tyre to `p_destination`, `current_depot_id = p_depot`; event
  `SENT_FOR_RETREAD` or `SENT_TO_BREAKDOWN_SUPPLIER` with the matching
  `to_state`, payload `{"depot_id","retread_job_id"}`.

**`app.return_tyre_to_stock(p_tyre uuid, p_depot uuid DEFAULT NULL,
p_occurred_at timestamptz DEFAULT now()) RETURNS void`**

- From `REMOVED` or `AT_BREAKDOWN_SUPPLIER` (Appendix C; FR-FIT-013's
  "receipt back"). `AT_RETREADER` is refused here (TY012): its only exit is
  Log Retread (D3). `p_depot`, when given, must be an **active** `DEPOT`/
  `STORE` of this tenant; when NULL the tyre keeps `current_depot_id`.
- Tyre to `IN_STOCK`; event `RETURNED`, `to_state = 'IN_STOCK'`.

**Correction (2026-09-02, Task 3).** The `dispatch_tyre` instant above
replaces `least(p_sent_on::timestamptz, now())`, which cast the date in the
session's zone rather than the tenant's and stamped a same-day dispatch at
midnight — behind the removal it follows, leaving `app.tyre_in_estate_asof`
reading `REMOVED` while `app.tyre.state` read `AT_RETREADER`. The
`return_tyre_to_stock` bullet gains `active`, which 000033 already enforces
and this bullet had omitted. The accepted cost of the new rule: a send that
happened yesterday and is logged today is refused unless it is recorded under
today's date.

### D3. Log Retread — TYRE-93

**`app.log_retread_return(p_job uuid, p_returned_on date, p_casing_accepted
boolean, p_report_reference text, p_retread_cost numeric DEFAULT NULL,
p_post_tread_mm numeric DEFAULT NULL, p_casing_value numeric DEFAULT NULL,
p_new_pattern_id uuid DEFAULT NULL) RETURNS void`**

SQL, not Go — it is a business rule about tyres, and the acceptance gate
rests on one implementation of the arithmetic.

- The job must exist in this tenant and be open (`returned_at IS NULL`);
  otherwise TY012 (`'no such open retread job in this fleet'`). The tyre must
  be `AT_RETREADER` (TY012). `p_returned_on` must be on or after `sent_at`
  and not after `app.tenant_today()` (TY014). Its event instant follows D2's
  dispatch rule: `now()` when `p_returned_on` is the tenant's today,
  tenant-local midnight of that day otherwise, refused with **TY012** when it
  would fall earlier than the tyre's latest `to_state` event and never
  clamped to it.
- `retread_job` is UPDATEd (its grants allow it; only DELETE is revoked) with
  every return field. Turnaround is the table's own generated column
  (FR-FIT-021), never entered.
- **Accepted casing:** `p_retread_cost`, `p_post_tread_mm` and
  `p_casing_value` are required (TY014). The tyre row: `retread_count + 1`,
  `status = 'RETREAD'`, `new_tread_mm = p_post_tread_mm`, `pattern_id =
  COALESCE(p_new_pattern_id, pattern_id)`, and
  `rand_per_mm = app.rand_per_mm(cost, p_post_tread_mm,
  app.current_removal_threshold_mm())` where `cost` is a `numeric(12,2)`
  **local** the parameter is assigned into first — the 2026-09-01 lesson,
  applied so the stored rate reproduces from the stored cost to the cent
  (FR-TYR-019, BR-VAL-006). `p_post_tread_mm` must exceed the threshold
  (TY014), so the rate is never NULL after a paid retread. State to
  `IN_STOCK`, `current_depot_id = NULL`. One `casing_valuation` row:
  `value = p_casing_value`, `source = 'RETREADER'`, `retread_job_id =
  p_job`, `effective_from = p_returned_on` (FR-FIT-022). Event `RETURNED`,
  `to_state = 'IN_STOCK'`, payload `{"retread_job_id","retread_count"}`.
  `tyre.casing_value` is **not** written: 000013's register precedence reads
  the valuation row first and treats the column as the `AUDIT` fallback.
- **Rejected casing:** `p_casing_value` must be NULL or 0 and
  `p_retread_cost` NULL (TY014; the job's own CHECK is the backstop). Tyre
  to `SCRAPPED`; a zero `RETREADER` casing valuation citing the job (U9);
  event `SCRAPPED`, `from_state = 'AT_RETREADER'`, `reason = 'casing
  rejected by retreader'`, payload `{"retread_job_id"}`. This is the one
  path that writes a zero casing value (FR-TYR-009, BR-VAL-004);
  `dispose_tyre` still refuses it, as its HINT already says.
- The cap is re-checked here (TY015) as a backstop against a job created
  before the policy changed.
- **`retread_count_matches_status`** (000001) holds by construction: the
  increment and the status change are one UPDATE.

Appendix E's section 7 is a pure-function pin and is untouched; sections 17
and 18 read `last_tread_mm` and `rand_per_mm` off rows this slice never
writes on BAC. The plan runs the `valuation-verifier` agent on this migration
before it is called done.

### D4. Reads the screens need

Two things do not exist today: a manager-facing read of a unit's positions
with their current fitment (the capture context is `CaptureInspection`-gated
and carries inspection fields), and any read of fitment history. Both are
plain queries composed from `app.position`, `app.fitment`, `app.tyre` and
the removal-reasons configuration — no new view, because every consumer is
Go and the shape is per-endpoint. The unit read also answers `hasHistory`
(any fitment, inspection or reading row), which is the exact predicate
TY008's trigger uses and what the screen keys the read-only configuration on
(TYRE-94, TYRE-82's front-end consequence).

### D5. Unit edit and status — TYRE-94, and ADR-0014

**Descriptive edit is a parameterised UPDATE**, per ADR-0013 decision 1 —
no rule governs `fleet_number` (its uniqueness is a constraint already in
`conflictCodes`), `registration`, `description`, `body_type`,
`unit_descriptor`, `home_depot_id`, `operating_group_id`. Tags (U6) are two
statements in the same transaction: delete the unit's map rows, insert the
new set, creating missing `vehicle_tag` names. 000018 revoked `DELETE` on
`vehicle_tag_map`; migration 000035 restores it for that table alone, with
the rationale that a tag map row is a current label for filtering
(FR-VEH-041), not history — `vehicle_tag` itself stays undeletable.

`configuration_id` and `unit_kind` are **not fields of the PATCH body**. The
decoder rejects unknown keys, so a request carrying either — in any casing —
is refused 422 `invalid_submission` naming the field, before any SQL runs.
TY008 therefore stays a pure database backstop, and this slice records that
in code: a comment beside `submitStatus` says TY008 has no entry because no
endpoint can reach it, citing docs/implementation-order.md §B5, so it is not
re-pointed a third time.

**Status is a SQL function**, because rules govern it:

**`app.set_vehicle_status(p_vehicle uuid, p_status app.vehicle_status,
p_reason text DEFAULT NULL) RETURNS void`**

- All six FR-VEH-005 values are legal targets from any non-`DISPOSED` state.
  `DISPOSED` is terminal (**TY016** on any transition out of it).
- `DISPOSED` is refused with TY016 while the unit has an open fitment
  (INV-2: the tyres go back to the pool first) and requires `p_reason`.
- A no-op transition (same status) is refused with TY016 so an audit row is
  never written for nothing.
- Schedules pause by existing construction: 000012's
  `app.generate_inspection_tasks(date)` already skips units whose status is
  not `ACTIVE` (FR-VEH-006, FR-INS-054). The suite asserts it — a parked unit
  with a due schedule gets no task — rather than trusting the filter.

**ADR-0014 — how mutations are audited.** `app.audit_log` (000001) has never
had a writer. The mechanism is one generic trigger function
`app.audit_row_change()`, `AFTER INSERT OR UPDATE`, writing
`(tenant_id, actor_id = app.current_actor_id(), action = TG_OP, entity_type
= TG_TABLE_NAME, entity_id = NEW.id, before = to_jsonb(OLD), after =
to_jsonb(NEW))`. Attached to `app.vehicle` in this slice; the ADR lists the
tables that should follow and the ticket raised for them. The trigger is
`SECURITY INVOKER` and `audit_log` is already in the RLS sweep, so the row
lands under the writer's tenant. `app.current_actor_id()` returns NULL when
no actor is bound (000001:32), so seed-loaded units and suite-planted rows
get an INSERT audit row with a NULL actor — "loaded, not acted" — rather
than a failing insert; the ADR records that as intended.

### D6. The API surface

Capability gates (never a role name, ADR-0011): `ViewFleet` for reads,
`ManageAssets` for every fitment and unit write, **`LogRetread`** for the
retread queue and the return — its first use since B2 defined it. Money
fields on any tyre projection are dropped unless the actor holds
`ViewValuation`, as slice 1 does. Depot scope is not applied, for slice 1's
reason (TYRE-76 owns it).

| Method | Path | Gate | Backing |
|---|---|---|---|
| GET | `/api/vehicles/{vehicleID}` | ViewFleet | unit row, positions with current fitment, `hasHistory`, tags, `removalReasons` |
| GET | `/api/vehicles/{vehicleID}/fitments` | ViewFleet | history, closed rows carrying `distanceKm` and `distanceSource` together (CR-012) |
| GET | `/api/fitments?open=true` | ViewFleet | fleet-wide open fitments — the **Fitments** screen |
| GET | `/api/depots?type=RETREADER\|BREAKDOWN_SUPPLIER\|DEPOT` | ManageAssets | the dispatch and return forms' pickers |
| POST | `/api/vehicles/{vehicleID}/fitments` | ManageAssets | `app.fit_tyre` → 201 `{fitmentId, warnings}` |
| POST | `/api/fitments/{fitmentID}/remove` | ManageAssets | `app.remove_tyre` → 204 |
| POST | `/api/vehicles/{vehicleID}/rotations` | ManageAssets | `app.rotate_tyres` → 201 `{moves:[{tyreId,fitmentId}]}` |
| POST | `/api/tyres/{tyreID}/dispatch` | ManageAssets | `app.dispatch_tyre` → 201 `{retreadJobId?}` |
| POST | `/api/tyres/{tyreID}/return` | ManageAssets | `app.return_tyre_to_stock` → 204 |
| GET | `/api/retread-jobs?open=true` | LogRetread | open jobs with tyre code, depot, `sentAt`, days out |
| POST | `/api/retread-jobs/{jobID}/return` | LogRetread | `app.log_retread_return` → 204 |
| PATCH | `/api/vehicles/{vehicleID}` | ManageAssets | parameterised UPDATE + tags → 200 with the unit read's body |
| POST | `/api/vehicles/{vehicleID}/status` | ManageAssets | `app.set_vehicle_status` → 204 |

Wire codes: `submitStatus` gains **TY009, TY014, TY015, TY016 → 422**, each
with a handler test that fails without it. `conflictCodes` gains
`one_open_fitment_per_position → position_occupied` and
`one_open_fitment_per_tyre → tyre_already_fitted`
(`TestConflictCodesNameLiveSchemaObjects` covers them for free);
`vehicle_tag_tenant_id_name_key` is not needed because names are upserted.

Plumbing this slice adds because nothing had needed it: `r.Patch` in the
router, an `apiPatch` in the web client, a `patch` test helper; a
`pathID(r, "vehicleID")` helper that answers 400 `bad_request` on a malformed
id and is used by every id-carrying route including slice 1's two (U7);
`maxCreateBytes` renamed `maxWriteBytes` since it bounds every write body;
and every request body decodes into a **named** struct (slice 1's two
anonymous ones included), so the request shape is a type a test can name.

Cross-tenant proof uses **both** existing idioms, named in the plan's global
constraints so a task cannot pick the wrong one: the raw-insert RLS probe
(`TestWriteAimedAtAnotherTenantIsRefused_*`, 42501) for the one direct
insert this slice adds (`vehicle_tag_map`) and for `app.fitment`; the
handler-level invisibility probe (`Test*CrossTenantIsInvisible`, 422 with
the pinned message) for every function-backed write.

### D7. The web surface

Vocabulary per reconciliation §3 and §2.7: **Units · Tyres · Fitments** now,
Rigs when B6 builds it. "Configuration" appears nowhere.

- **Units become clickable.** `VehicleList` rows link to
  `/fleet/units/:unitId`, and its stale empty-state copy ("Unit registration
  opens in an upcoming release") is corrected — the add-a-unit screen has
  existed since B4.
- **`UnitDetail`** (`ManageAssets` for the actions, `ViewFleet` to see it):
  - `UnitPlan` — a data-driven SVG of the unit's positions from the read,
    laid out by `axle_number`/`side`/`slot` with the spare beside, each
    position showing its display code or *empty*. It **replaces
    `AxleSchematic`**, the prop-less decorative SVG WEB-5 said to rename
    "only when it becomes data-driven"; that moment is now, and the old
    component is deleted rather than kept beside its replacement.
  - `PositionPanel` — for the selected position: **Fit** (code lookup of
    `IN_STOCK` tyres, tread, mount orientation, odometer shown only when
    the unit kind has one — a trailer form never asks) or **Remove**
    (reason from the tenant list, tread, odometer likewise). Warnings from
    a fit render as `role="status"` beside the result, not as errors.
  - `RotateForm` — pick two or more occupied positions and their targets;
    one odometer; one tread per tyre.
  - `UnitEditForm` — the PATCH fields and tags; the axle configuration is
    rendered read-only with a note when `hasHistory` is true, and is never a
    field of the form (it has no PATCH path at all — the read-only render is
    TYRE-94's UI requirement, the API refusal is what protects it).
  - `UnitStatusForm` — the six statuses; disposal asks for a reason and
    shows the open-fitment refusal verbatim.
  - `FitmentHistory` — closed and open rows, distance always beside its
    provenance label (CR-012).
- **Register** (`/fleet/tyres`): rows gain **Dispatch** (`REMOVED` only:
  destination, depot picker, date) and **Return to stock** (`REMOVED`,
  `AT_BREAKDOWN_SUPPLIER`). `TyreList.tsx` is split into
  `fleet/tyres/{TyreList,DisposeForm,CostForm,DispatchForm}.tsx` — WEB-3's
  open question, answered by the file's growth.
- **Retread queue** (`/fleet/tyres/retreads`, `LogRetread`): open jobs with
  days out, and the return form (accepted/rejected branch, the accepted
  fields, new pattern picker). Linked from the register's header, and a nav
  item **Retreads** under the same gate.
- **Fitments** (`/fleet/fitments`, `ViewFleet`): fleet-wide open fitments
  with unit, position, code, fitted date and days fitted; each row links
  to the unit.
- **`useFormMutation`** — WEB-6's deferred hook, extracted now because this
  slice adds eight forms to the six that exist: field state, `useMutation`,
  invalidation keys, the pending-disabled button and the `role="alert"`
  refusal. Existing forms migrate to it only where a file is already being
  edited (the register split); the rest stay, listed for a later pass.
- Dates render only through `useTenantDate`; the build's ban is active.
- `AdminRoute` (alert) is the gate for every new screen; `RequireCapability`
  (hide) stays on `/fleet` and `/fleet/fitments` as the read routes. The
  two components are deliberate (routes.tsx) and are not unified here.

### D8. Test data

Sandbox Fleet gains, in the seed generator: a `RETREADER` depot and a
`BREAKDOWN_SUPPLIER` depot (the dispatch picker needs one of each; nothing
creates depots through the API yet), and the `removal_reasons` key comes
from the configuration generator for every tenant. Sandbox already has a
`HORSE` and a `TRAILER` with unit-scoped configurations and no tyres; the
e2e receives its own through the register, as `tyres.spec.ts` does. BAC
rows are never written outside a rolled-back suite section.

The suite's new sections (40–43) stage inside `BEGIN;`/`ROLLBACK;` with no
existence guards (lesson 2026-09-01). Section 41's rotation-failure case is
the DoD's "no half state" proof; section 41 also proves the two indexes
refuse a raw insert past the function, which is what the DoD's "refused by
the DB" means.

## The e2e proof

`web/e2e/fitments.spec.ts`, `chromium` only, Sandbox only, as the
CONTROLLER (`sbcontroller1`): receive three tyres → fit one to the trailer
without an odometer and one to the horse with one, orientation captured on
both → rotate the horse's two steer tyres → remove the trailer's tyre with a
reason and see `MEASURED`/`UNAVAILABLE` beside its distance → return it to
stock, dispatch it to the retreader → log the return accepted and see the
register row at `RETREAD`, count 1 → park the horse and see it absent from
the due-task list → attempt disposal of the horse and read the open-fitment
refusal → remove its tyres → dispose it. Each step's screen is the one the
task brief built; the brief for this spec is written last, against the
landed components (lesson 2026-09-01).

## Out of scope (owned, not forgotten)

| Deferred | Owner |
|---|---|
| Cross-unit rotation within a rig (U3), guided full-unit tyre change (FR-FIT-018) | B6, after TYRE-72 gives the rig a live shape |
| `INFERRED` distance provenance from coupling records | OI-31 / TYRE-43 |
| Fitment odometers feeding the unit's odometer timeline (`vehicle_odometer_reading`, 000012 §3, TY001/TY002) and `current_odometer`. Fit, remove and rotate each capture a unit odometer and write it to the fitment only; nothing here inserts a timeline row or checks against `current_odometer` | new ticket at close-out — a fitment odometer is a reading of the unit and the timeline should see it, but reconciling it with TY001's monotonic rule is its own decision |
| Depot-to-depot transfer of a tyre (FR-FIT-011's transfer half) | new ticket at close-out |
| Attaching the audit trigger beyond `app.vehicle` | new ticket at close-out (named in ADR-0014) |
| `brand_pending` workshop workflow | new ticket at close-out (TYRE-48 closes here) |
| Retread attachment upload (FR-FIT-021's "+ optional attachment") | not in Appendix H; not built |
| FR-VEH-006's "suggest parking" prompt, FR-FIT-024's detected unlogged event | exceptions work |
| Fit-from-`REMOVED` shortcut (U1) | owner's question; one branch if reversed |
| The two route-gate components' unification | unchanged, deliberate per routes.tsx |

## Non-ticket deliverables

- **docs/implementation-order.md** — B5 marked delivered with the slice-2
  table, TY008's permanent non-entry noted as done, B6 marked next.
- **ADR-0014** (audit mechanism) — committed before the migration that
  applies it.
- **TYRE-48 closes** with this slice: every path in its DoD now writes its
  event, and the vocabulary is enforced.
- **A follow-up ticket list** in the PR body for the out-of-scope rows
  marked "new ticket at close-out".
