# B6 — the rig-setup surface — design

**Date:** 2026-09-03 · **Batch:** B6 (`docs/implementation-order.md` §B6) ·
**Tickets:** TYRE-72, TYRE-90, TYRE-101, TYRE-75; TYRE-73 excluded by default
(see U1) · **Riders:** TYRE-124, TYRE-126, TYRE-127, TYRE-128 items 7 and 8
and its small-fixes list · **Authority:** SRS v1.4 §4.5.1 (FR-VEH-019,
FR-VEH-030..034), §4.8.5 (FR-INS-048..055, FR-INS-060..066), FR-AUT-005 (D3),
BR-VEH-001/003, BR-FIT-005/006; Decisions of Record D1–D5 (page 14778369),
D5 and the parked lock; *Reconciliation — Asset Flow (30 Aug 2026)* (page
17170433) §2.4, §3, §5; TYRE-128's owner comment of 3 Sep 2026; ADR-0004,
ADR-0007, ADR-0011, ADR-0012, ADR-0013, ADR-0014.

This is the one committed design document for the whole batch. Each slice
gets its own gitignored plan under `docs/superpowers/plans/`, written after
the slice before it has merged (CLAUDE.md, documentation split; TYRE-128
decision 4). Slice 1's plan is
`docs/superpowers/plans/2026-09-03-b6-slice1-rig-setup.md`.

## What B6 is

A **rig** is a dated pairing of a motive unit (a horse, rigid or light
vehicle) with the trailers it is pulling: `app.combination` plus its ordered
`app.combination_member` rows, effective-dated (FR-VEH-030/031). The
platform has modelled rigs since migration 000001, the fixture seeds one
(`comb1`), the capture app serves the rig to the driver to confirm
(FR-INS-062, D5) and records any difference as an `FR-INS-063` warning
(000023). What has never existed is any way for a **controller** to set one.
A tenant built from nothing captures every unit solo forever, and nothing
reads the warnings the drivers raise.

B6 closes that loop, in four slices:

| Slice | Ticket | One sentence |
|---|---|---|
| **B6.1** | TYRE-72 | A controller creates a dated rig and ends it; the driver's capture offers it the same minute. |
| **B6.2** | TYRE-90 | A controller schedules an ad-hoc inspection task for a driver on a unit; DriverHome shows it; the capture closes it. |
| **B6.3** | TYRE-101 | A rotation may move tyres between units of the same rig, atomically. |
| **B6.4** | TYRE-75 | A controller sees the composition differences drivers reported and turns one into a dated rig change. |
| *(B6.5)* | TYRE-73 | *Conditional.* The in-transport lock — only if the owner un-parks it (U1). |

"Configuration" is never a name for a rig in this batch (reconciliation §3). The Fleet
tab becomes **Units · Tyres · Rigs · Fitments**.

## Why slices, and the gate every slice passes

B5 ran as one branch per slice and its close-out review found nine Important
findings after the branch's own review had found none. Every B6 slice is
therefore its own branch, its own PR and its own review; nothing merges on
the strength of a green `make check` alone. The gate, identical for every
slice:

1. **Branch** `TYRE-<key>-<slug>` cut from `develop` **after the previous
   slice has merged**; the next slice's plan is written against the merged
   vocabulary, never in advance (the B5 lesson: an interface planned
   abstractly is planned wrong).
2. **Every task ends with `make check`**; every SQL rule has a suite section
   that was seen failing before the migration existed; every write endpoint
   has a cross-tenant probe that would *succeed* on a leak, not merely change
   its error text.
3. **A Playwright smoke chain** on Sandbox Fleet (never BAC) that walks the
   slice's definition of done through the real screens, with the API
   container restarted before the run and never reused across two runs
   (`docs/lessons.md`, 2026-09-03).
4. **`/comment-audit`**, then an **independent review** of the whole branch:
   a five-lane reviewer pass (DB, Go, web, tests, docs) plus the
   `rls-auditor` on every migration, and the `valuation-verifier` whenever a
   slice touches money or a valuation path (B6.3 does — `app.fit_tyre` and
   `app.rotate_tyres` are replaced). Every Important finding is fixed on the
   branch or ticketed before the PR is opened.
5. **PR to `develop`**, opened with the U-table below marked confirm-or-
   reverse; the owner merges. Then, and only then, the next slice is planned.

## Decisions taken without the owner — confirm or reverse

| # | Decision | Why | Reversal cost |
|---|---|---|---|
| **U1** | **TYRE-73 is out of B6 by default.** The ticket says "Post-pilot. Parked deliberately — do not pick this up before the pilot has run." `docs/implementation-order.md` §B6 sequences it after TYRE-90. The page's own rule is that the board wins, so the page is corrected and the lock becomes a conditional fifth slice. | The two sources disagree and only one is the authority. | Zero: B6.1 leaves the schema able to carry a lock later (a `locked_at`/`locked_by` pair on `app.combination`, refused by the same function that refuses INV-4). |
| **U2** | **Rig writes gate on `ManageAssignments`; rig reads on `ViewFleet`.** TYRE-72's DoD and reconciliation §3 both name `ManageAssignments`; TYRE-128 decision 2 says "read screens gate on ViewFleet and writes on ManageAssets — B6's rig screens follow the same rule", which this reads as the *split pattern* with the ticket's own capability. `auth.go` gives `ManageAssignments` and `ManageAssets` to exactly the same three roles today, so the choice changes no role's reach. | The ticket is the definition of done; the decision was about reads-versus-writes. | One `require(...)` and one `useCan(...)` per surface. |
| **U3** | **TYRE-90 builds FR-INS-051's ad-hoc task, not FR-INS-049's recurring schedule.** The v1.4 FR-INS-049 is a recurring schedule per unit or operating group; `app.inspection_schedule` and `app.generate_inspection_tasks` (000012) exist with no write surface and nothing invoking the generator. TYRE-90's own DoD is the ad-hoc task. The schedule surface is unowned and is listed under *Out of scope* with a ticket to raise. | Build the DoD; do not widen. | None — the schedule surface is additive later. |
| **U4** | **A task's assignee must be able to capture the unit**, not merely hold a `vehicle_driver` row on it: an open assignment on the unit itself, or an open assignment on the motive unit of the open rig the unit belongs to (FR-INS-053, FR-AUT-005 as amended by D3). TYRE-90's wording ("an open vehicle_driver row for that unit") would make every trailer task unschedulable. | A trailer never has its own driver; the SRS routes its task to the horse's driver. | One predicate in SQL. |
| **U5** | **A unit is a member of at most one open rig (INV-4), and never joins a rig that starts before its last one ended.** One implementation: a BEFORE INSERT trigger on `app.combination_member`, whose message names the rig the unit is in. `app.create_combination` does **not** pre-check it — 000033's own rule ("a pre-check here would be a second implementation that a raw INSERT walks past") — it only locks the member rows so two concurrent creates serialise on the trigger's answer. This is **not** TYRE-73's lock: the lock refuses the controller's *re-coupling action* while a rig is in transit; INV-4 refuses the *record* of one trailer behind two horses at once, which is never true. Cheap before pilot data, expensive after (the batch's own ordering rule). | FR-VEH-031's "correctly attributed over time" is unmeetable with overlapping open memberships; the house pattern is one rule in one place. | A migration dropping one trigger. |
| **U6** | **A rig is written once and ended once.** `app.combination` gains a written-once trigger in 000032's shape (only `effective_to` and the audit stamps may change; an ended rig is frozen); `UPDATE` on `app.combination_member` is revoked from `app_rw`. A changed composition is a new rig, never an edit. | Composition history is the thing drivers confirm against; an edited history is a lie about what was coupled when. | One migration. |
| **U7** | **The motive unit is member sequence 1.** The fixture (`gen_seed_fixture.py:147-149`) and `capture.go:272-297` already assume it; the function enforces it. Towed members are sequences 2..n in the order given, which is the walk order FR-VEH-034 projects from. | Two existing readers assume it. | None. |
| **U8** | **Effective instants follow B5's date rule, through one shared function.** "On" the tenant's today is `now()`; an earlier day is tenant-local midnight; a future day is refused; never a bare date cast. That rule is written inline twice today (`app.dispatch_tyre` 000033:639-654, `app.log_retread_return` 000034:84-94). 000037 extracts it once as `app.tenant_day_instant(p_on date) RETURNS timestamptz` — NULL for a future day, so each caller refuses in its own code and words — and **B6.3, which replaces both of those functions anyway, deletes the two inline copies** rather than leaving a third. A start earlier than a member's last membership end is refused (TY017), never clamped. | `docs/lessons.md` 2026-09-01 and 2026-09-03; one rationale in one place (CLAUDE.md). | None. |
| **U9** | **Kinds:** a rig is headed by a `HORSE`, `RIGID` or `LIGHT` unit and tows only `TRAILER`s; a unit whose `unit_kind` is NULL (a pre-000011 row) is refused with a message naming it. `DISPOSED` and `INACTIVE` units are refused; `PARKED`, `WORKSHOP` and `OUT_OF_SERVICE` are not — FR-VEH-006 pauses a unit's schedule, not the yard's ability to couple it. | FR-VEH-030's "one motive unit and zero or more towed units"; FR-VEH-005's retirement states. | One predicate. |
| **U10** | **Zero towed units is refused.** FR-VEH-030 permits it, but a one-member rig changes nothing the capture or the register reads, and offering it invites a controller to "rig" every rigid. | YAGNI; the capture treats no-rig as solo already. | Delete one `IF`. |
| **U11** | **SQLSTATEs:** TY017 is "a rig write refused"; TY018 is "an inspection task refused" (B6.2); TY019 is "a composition observation refused" (B6.4). TY012 keeps its meaning — a row this tenant cannot see — with a distinct message per object ("no such rig in this fleet"). | ADR-0012's TY-class rule; one code per refusal family so a client can branch. | Rename in one map. |
| **U12** | **`app.audit_row_change()` attaches to `app.combination` and `app.combination_member` in B6.1**, and to `app.inspection_task` in B6.2 — the tables this batch gives write paths to. TYRE-98's wider sweep is unchanged. | ADR-0014's rule: a table with a write path is audited. | Drop two triggers. |
| **U13** | **`GET /api/vehicles` gains `unitKind` and `status`** so the rig form can filter motive from towed and hide retired units. Additive; no consumer breaks. Both source relations already project them — `app.v_depot_vehicle` is `SELECT v.*` (000014) and `app.vehicle` is the table — so the handler selects two more columns and nothing is joined or bent. The driver's `GET /api/my/vehicles` reads `app.v_driver_vehicle`, which projects a fixed column list, and is **left alone**: the fleet list gets its own response struct rather than widening the shape the driver's list shares. | The form needs the kind; a second endpoint for two columns is worse; a view rewritten for a column its consumer never asked for is a bend. | None. |
| **U14** | **The Sandbox e2e creates its own units** through the API rather than reusing `sbveh1`/`sbveh2`: `playwright.config.ts` is `fullyParallel`, and `fitments.spec.ts` disposes `sbveh1` mid-run. | Two specs sharing a unit is an order dependency the config does not promise. | None. |

## How this batch treats the code it meets

`docs/architecture.md` and `docs/refactor/architecture.md` are the
authority: the database is the domain model, Go and the browser are thin,
arrows point at SQL, one rule lives in one place. Three consequences for
every B6 slice, stated once here:

- **A rule is written once, where a raw write meets it.** A trigger or a
  constraint is the implementation; a function never pre-checks what a
  trigger already refuses (000033's occupancy comment is the precedent).
  A function holds only what a trigger cannot: locks, ordering across
  several rows, and the message a refusal needs.
- **Existing code is extended through its designed seams or replaced whole,
  never patched around.** `submitStatus`, `conflictCodes`, `navItemsFor`,
  `useFormMutation`, `refusalMessage` and the `require`/`withActor` pair
  are the seams. Where a slice needs a shape an existing function does not
  have — B6.3's rotation, the two inline date blocks — the function is
  re-created whole in a new migration and the old body deleted, not
  amended in place.
- **A shared shape is not widened for one consumer.** A handler that needs
  two more columns gets its own response struct; a view is not rewritten
  for a column its other consumers never asked for.

## Sequencing inside the batch

B6.1 → B6.2 → B6.3 → B6.4, each planned after the previous merges.

- **B6.1 first** because everything else reads a live rig: B6.2's assignee
  predicate walks the rig (U4); B6.3's rotation scope *is* the rig; B6.4
  changes rigs.
- **B6.2 second, not with B6.1.** The implementation order says "TYRE-72
  with TYRE-90". They share a capability and a "controller tells the system
  about the week" shape but no table and no endpoint; a combined branch is
  the whole-batch PR the gate above exists to avoid. Adjacent, not merged.
- **B6.3 before B6.4** because B6.4's e2e needs a full driver capture on a
  rig (the untick), and B6.3's is the cheaper chain to learn the shared
  capture walk on; and because B6.3 replaces the 000033 functions, which is
  where TYRE-126/127 and the 30 mm collapse (TYRE-128 item 8) ride.

## B6.1 — the rig surface (TYRE-72) — designed to executable detail

### D1. Schema rules — migration `000037_rig_written_once`

Nothing new is stored. `app.combination` and `app.combination_member` keep
their shape (000001, 000004, 000017, 000029). What 000037 adds is the rules
that make writing them safe:

1. **Written once (U6).** `app.combination_is_written_once()` BEFORE UPDATE
   ON `app.combination`: an ended rig (`OLD.effective_to IS NOT NULL`) is
   frozen — TY017 "an ended rig cannot be changed"; on an open rig any
   column other than `effective_to`, `updated_at`, `updated_by` moving is
   TY017 "an open rig can only be ended, never edited". Trigger name
   `combination_written_once`; `combination_stamps_updated` (000017) writes
   the two audit stamps, which is why they are excluded rather than relying
   on trigger order — 000032's reasoning, restated once here.
   `REVOKE UPDATE ON app.combination_member FROM app_rw` — DELETE was
   already revoked (000018).
2. **INV-4 and membership order (U5).** `app.combination_member_in_order()`
   BEFORE INSERT ON `app.combination_member`, the one implementation: if
   the unit has a membership whose rig is open → TY017 `%s is in the rig
   headed by %s; end that rig first`; if its latest closed membership ended
   after the new rig's `effective_from` → TY017 `%s left the rig headed by
   %s on %s; this rig cannot start before that`. The function below does
   not repeat either check.
2a. **The shared day-to-instant rule (U8).** `app.tenant_day_instant(p_on
   date) RETURNS timestamptz`: NULL input or the tenant's today → `now()`;
   an earlier day → that day's tenant-local midnight; a later day → NULL,
   which the caller refuses in its own words. B6.3 replaces 000033's and
   000034's inline copies with calls to it.
3. **Audit (U12).** `combination_audited` and `combination_member_audited`,
   AFTER INSERT OR UPDATE, `app.audit_row_change()`.
4. **TYRE-124.** A `COMMENT ON FUNCTION` for 000025's odometer-by-unit-kind
   trigger function restating what holds since PR #41: TY009 is mapped
   (`submitStatus`, 422) and three HTTP routes write `app.fitment`. The
   migration's header says why a comment-only correction lives in a new
   migration (000025 is merged and below the edit floor).

### D2. The functions

Both `LANGUAGE plpgsql`, invoker rights, `SET search_path = app, pg_temp`,
tenant from RLS, actor from `app.current_actor_id()`.

```sql
CREATE FUNCTION app.create_combination(
  p_motive        uuid,
  p_towed         jsonb,            -- [{"vehicle_id": uuid, "descriptor": text|null}, ...] in walk order
  p_effective_on  date DEFAULT NULL -- tenant today when NULL (U8)
) RETURNS uuid;                     -- the new combination id

CREATE FUNCTION app.end_combination(
  p_combination   uuid,
  p_ended_on      date DEFAULT NULL
) RETURNS void;
```

`create_combination`, in order, each refusal its own message:

| Check | SQLSTATE | Message shape |
|---|---|---|
| motive not visible | TY012 | `no such unit in this fleet` |
| motive `unit_kind` NULL | TY017 | `%s has no unit kind recorded; set it before it heads a rig` |
| motive kind is TRAILER | TY017 | `a rig is headed by a horse, rigid or light vehicle; %s is a trailer` |
| motive DISPOSED / INACTIVE | TY017 | `%s is %s; a retired unit is not coupled` |
| `p_towed` empty or not an array | TY017 | `a rig has at least one towed unit; a unit on its own needs no rig` (U10) |
| a towed id repeats, or equals the motive | TY017 | `%s is named twice in this rig` |
| towed not visible | TY012 | `no such unit in this fleet` |
| towed kind not TRAILER (or NULL) | TY017 | `only a trailer is towed; %s is a %s` |
| towed DISPOSED / INACTIVE | TY017 | as the motive's |
| `p_effective_on` after tenant today (`tenant_day_instant` answers NULL) | TY017 | `a rig is set as at today or earlier, never in the future` |
| descriptor longer than 200 characters | TY017 | `a descriptor is at most 200 characters` (U-bound, TYRE-128 decision 5: bound it in SQL) |
| a member is in an open rig, or its last rig ended after the start | TY017 | **raised by the trigger (D1.2), not by the function** |

The start instant is `app.tenant_day_instant(p_effective_on)` (D1.2a).
Every member vehicle row is locked `FOR UPDATE` before the member inserts so
two concurrent creates naming the same trailer serialise on the trigger's
answer; a concurrent fit on that unit (which takes `FOR SHARE`) waits the
few milliseconds this takes, which is accepted. Inserts: one
`app.combination` row (`tenant_id = app.current_tenant_id()`, `created_by =
app.current_actor_id()`), the motive as member sequence 1 with a NULL
descriptor (U7), towed members 2..n with their descriptors — and the
trigger is what refuses a member that is already coupled.

`end_combination`: row locked `FOR UPDATE`; not visible → TY012 `no such rig
in this fleet`; already ended → TY017 `this rig ended on %s`; the end
instant by the same date rule; an end instant before `effective_from` →
TY017 `this rig started on %s; it cannot end before that`; then one UPDATE
of `effective_to`. Ending a rig does not touch fitments, tasks or
inspections: the tyres stay on their units (INV-1), which is the whole
reason a rig is not a configuration (ADR-0007).

### D3. Reads the screens need

- `GET /api/combinations` — `ViewFleet`. Every rig, open first then by
  `effective_from DESC`; `?open=true` narrows to open. Shape:

```json
[{
  "id": "…", "motiveVehicleId": "…", "motiveFleetNumber": "HORSE",
  "effectiveFrom": "2026-09-03T07:12:00Z", "effectiveTo": null,
  "members": [
    {"vehicleId": "…", "fleetNumber": "HORSE", "sequence": 1, "descriptor": null, "unitKind": "HORSE"},
    {"vehicleId": "…", "fleetNumber": "LINK6", "sequence": 2, "descriptor": "front", "unitKind": "TRAILER"}
  ]
}]
```

- `GET /api/vehicles` gains `unitKind` (nullable) and `status` (U13).

No new view: the read is two joins the handler owns, and `app.combination`
is RLS-scoped.

### D4. The writes

- `POST /api/combinations` — `ManageAssignments` — body
  `{motiveVehicleId, towed: [{vehicleId, descriptor?}], effectiveOn?}`,
  shape-validated in Go (uuids parse, `towed` present and an array,
  `descriptor` through `text()` with `maxTextLen`, `effectiveOn` through
  `dateField`), then one `SELECT app.create_combination($1, $2::jsonb,
  $3::date)`; answers **201** with the rig in D3's shape (one
  `combinationByID` read shared with the list).
- `POST /api/combinations/{combinationID}/end` — `ManageAssignments` —
  body `{endedOn?}`; `pathID`; `SELECT app.end_combination($1, $2::date)`;
  answers **200** with the rig.
- `submitStatus` gains `"TY017": 422`; ADR-0012's code table gains the row.
  No `conflictCodes` entry: the only unique key reachable
  (`combination_member_tenant_id_combination_id_sequence_key`) is written by
  the function alone.

### D5. The web surface

- **Route `/fleet/rigs`**, `RequireCapability("ViewFleet")` like
  `/fleet/fitments`; nav item **Rigs** between Tyres and Fitments, capability
  `ViewFleet`; the placeholder comment in `navigation.ts` goes.
- **`RigList`** (`web/src/fleet/rigs/RigList.tsx`): a table of open rigs —
  motive, members in walk order with descriptors, "Since" through
  `useTenantDate` — with an **End rig** button per row shown only under
  `useCan("ManageAssignments")` (refusals spoken through `refusalMessage`,
  TY017 speakable). Below it, **Ended rigs**, the same table with "Until".
- **`RigForm`** (`RigForm.tsx`), `ManageAssignments` only, above the list:
  a motive select (units with `unitKind` in HORSE/RIGID/LIGHT, status not
  DISPOSED/INACTIVE, and not the motive or a member of any open rig — the
  client narrows so the common refusal never round-trips, the function stays
  the authority), an ordered towed list built from a trailer select with
  **Add**, per-row **Up / Down / Remove** and an optional descriptor, and
  an **Effective from** date input left blank for today — the browser never
  supplies "today" (rule 6; lessons 2026-09-03). `useFormMutation` with
  `invalidate: [rigsKey(tenantKey), vehiclesKey(tenantKey)]`; success line
  `role="status"` naming the motive.
- `web/src/api/combinations.ts`: `Rig`, `RigMember`, `NewRig`, `fetchRigs`,
  `createRig`, `endRig`; `Vehicle` gains `unitKind: UnitKind | null` and
  `status: string`; `rigsKey(tenantKey)` in `queryKeys.ts`.
- Nothing on `UnitDetail` in this slice; B6.3 adds the "in rig with …"
  banner when it needs it.

### D6. Test data and the proof

- **Suite section 45** (`db/tests/004_tests.sql`, `BEGIN … ROLLBACK`, BAC
  tenant with two planted units so the fixture's `comb1` — every BAC unit is
  in it — is untouched): 45a create and the capture read widens; 45b INV-4
  through the function and through a raw insert; 45c kinds, duplicates, the
  empty list; 45d the date rule; 45e end, end again, end before start, the
  capture read narrows, the trailer is free again; 45f written-once and the
  member revoke (42501 as `app_login`); 45g cross-tenant through both
  functions with the pinned messages, non-vacuous because the same calls
  succeed for the owning tenant one line earlier; 45h the audit rows.
- **Go** `combinations_test.go`: shapes, 403 for `TECHNICIAN` on POST and
  200 on GET, 403 for `DRIVER` on GET, TY017 forwarded verbatim, TY012 for
  tenant B naming tenant A's horse and tenant A's rig, and the DoD's own
  test: after the POST, `GET /api/capture/vehicles/{motive}` as a driver
  assigned to the motive carries the rig's members.
- **e2e `web/e2e/rigs.spec.ts`** (chromium, serial, Sandbox CONTROLLER):
  create a horse and a trailer through the API for this run; assign the
  Sandbox driver to the horse; on `/fleet/rigs` build the rig through the
  form; the row lists both units; in a second context the driver opens
  `/capture/{horse}` and "Your rig" lists the trailer, ticked; a second rig
  naming the same trailer is refused and the refusal names the first rig;
  End rig moves the row to Ended rigs; the driver's capture start no longer
  shows "Your rig". That is TYRE-72's "a new tenant can reach a working rig
  capture without touching the fixture", walked.

### D7. Riders carried by B6.1

| Item | Where it lands |
|---|---|
| TYRE-124 | 000037 (D1.4) |
| Suite check 4's PASS message claims `tyre_event` and `audit_log` its body does not exercise | Section 4 gains an UPDATE probe on each, so the message becomes true rather than narrower |
| `maxTextLen` counts bytes, not runes | `text()` switches to `utf8.RuneCountInString` in one commit with a test, because the rig descriptor is a new field through it |
| `queryKeys.ts` restates `openFitmentsKey`'s rationale at `vehiclesKey` | Cited instead, when `rigsKey` is added beside it |
| Two `ActorContext` call shapes in tests | Twelve test files use `<ActorContext.Provider value={…}>` and three use the bare `<ActorContext value={…}>`; new tests use `.Provider`, and the three (`routes.test.tsx`, `tenantTime.test.tsx`, `RequireCapability.test.tsx`) are converted in the same commit. `ActorProvider.tsx` is production code and is left alone |
| 000036's `app.tyre_valuation_asof` has no pinned `search_path` (deliberate) | One sentence in ADR-0014's Consequences |
| ADR-0014's attached-tables list | Gains the two combination tables (U12) |

Not carried here, by area: TYRE-128 item 7 (`depotTypes`, `units.go`) →
B6.2, which adds the drivers read beside the unit reads; item 8 (30 mm),
TYRE-126, TYRE-127, the `effective_from` comparator alignment, the odometer
`malformed_json` field name, the `"UNKNOWN"` literal in `PositionPanel`, the
remove/rotate odometer local-refusal tests, `fitments.spec.ts`'s orientation
assertions, 000033's guard comments → B6.3, which replaces those functions
and forms; `cost_source` on re-rate and the fit-form reset asymmetry → no B6
slice touches them; they stay on TYRE-128.

## B6.2 — the inspection task (TYRE-90) — outline, planned after B6.1 merges

**Shape.** Migration 000038: `app.user_can_capture(p_user uuid, p_vehicle
uuid) RETURNS boolean` — an open `vehicle_driver` row at the tenant's today
on the unit, or on the motive of the open rig the unit is a member of (U4;
the same predicate `app.v_capture_vehicle` expresses for the current actor,
factored so a controller can ask it about someone else) — and
`app.create_inspection_task(p_vehicle uuid, p_assignee uuid, p_due_on date
DEFAULT NULL) RETURNS uuid`: unit visible else TY012; not DISPOSED/INACTIVE
else TY018; assignee visible else TY012 (U11: a row this tenant cannot
see); active else TY018 "`%s` is no longer active"; `user_can_capture`
else TY018 "`%s` is not assigned to `%s` or to the horse pulling
it"; `p_due_on` not before tenant
today else TY018; `due_at` is tenant-local end of that day, never a bare
cast; `requested_by = app.current_actor_id()`, state OPEN. `inspection_task`
gains `audit_row_change` (U12). The submit path already closes the task
(000023:449) — nothing there changes.

**API.** `GET /api/vehicles/{id}/drivers` (`ViewFleet`; the unit's current
assignments, and for a trailer in an open rig the motive's, each row saying
which) — the read TYRE-90's screen needs and which does not exist; `GET
/api/vehicles/{id}/inspection-tasks` (`ViewFleet`, open and escalated tasks,
`taskJSON` shape); `POST /api/vehicles/{id}/inspection-tasks`
(`ManageAssignments`, body `{assigneeUserId, dueOn?}`, 201 `taskJSON`).
`submitStatus` gains TY018.

**Web.** On `UnitDetail`, a **Schedule an inspection** panel under
`useCan("ManageAssignments")`: driver select from the drivers read, due
date blank for today, submit; an **Open tasks** list under it. DriverHome is
unchanged — it already renders the task and the link into the capture.

**Proof.** Suite section 46 (predicate, refusals, cross-tenant, audit,
non-vacuous close-on-submit through `app.submit_inspection`); Go tests on
the three routes; e2e `tasks.spec.ts`: controller schedules the Sandbox
driver on a run-created horse; `/my` lists "`<fleet>` — due …"; the link
opens the capture with `taskId`; a submit closes it and `/my` reads
"Nothing due." The capture walk must be shared with `capture.spec.ts`
rather than copied — check whether a helper exists before planning; if the
android-only walk cannot run on chromium, the spec submits the same payload
`capture.spec.ts` asserts through the API and says so in its header.

**Riders.** TYRE-128 item 7 (delete `depotTypes`; the cast answers 22P02,
already mapped).

**Before planning it:** confirm `app.v_capture_vehicle`'s "current" test
(`effective_to IS NULL`) is the predicate B6.1 shipped; confirm whether
`capture.spec.ts` exposes a reusable walk.

## B6.3 — cross-unit rotation within a rig (TYRE-101) — outline

**Shape.** Migration 000039 replaces `app.rotate_tyres` (a rotation is one
transaction, BR-FIT-005; D14's "within one rig"): each move gains an
optional `to_vehicle_id`; every unit named must be `p_vehicle` itself or a
member of the same open rig at `p_occurred_at` (TY014 otherwise, naming
the unit that is not); odometers become per unit — `p_odometers jsonb`
`{vehicle_id: km}` — because a horse records one and a trailer none
(TY009 per unit); `mount_orientation` carries over per move as today. The
30 mm sanity bound collapses into one SQL definition used by fit, remove,
rotate and retread return (TYRE-128 item 8); the dual-mate warning reads the
mate's governing reading ahead of `last_tread_mm` (TYRE-126); the
`effective_from` comparators align on `<=`; **the two inline day-to-instant
blocks in `app.dispatch_tyre` and `app.log_retread_return` are deleted in
favour of `app.tenant_day_instant` (U8)**; 000033's guard comments are
reworded in the replacing bodies (the migration replaces those functions
anyway, so no comment-only migration is needed). Replaced, not patched: each
function is re-`CREATE`d whole in the new migration, and the old body is not
consulted for shape — the spec's rules are.

**API.** `POST /vehicles/{id}/rotations` keeps its path; the body gains
`toVehicleId?` per move and `odometers?` keyed by unit; the single
`odometer` stays accepted for the one-unit case.

**Web.** `RotateForm` gains a unit column when the unit is in an open rig
and its target picker offers only empty positions or ones vacated by the
same set of moves (TYRE-127); `UnitDetail` shows "In a rig with …" linking
to `/fleet/rigs`; `PositionPanel`'s `"UNKNOWN"` literal ties to
`MOUNT_ORIENTATIONS`.

**Proof.** Suite section 47 including the ticket's own DoD probes (a tenant
cannot rotate across another tenant's units, nor across units that share no
rig); `valuation-verifier` on the replaced functions; e2e extends
`rigs.spec.ts` or adds `rotation.spec.ts`: fit a tyre on each unit of the
run's rig and rotate them across, both histories show the move.

## B6.4 — reconcile observed composition (TYRE-75) — outline

**Shape.** `app.inspection_warning` is append-only (DR-021), so a resolution
is its own record: migration 000040 adds
`app.composition_observation` (tenant_id, warning_id UNIQUE, combination_id
— the rig offered —, action `APPLIED | DISMISSED`, resulting_combination_id,
note, actor, at), RLS-enrolled, DELETE and UPDATE revoked, audited; and
`app.apply_composition_observation(p_warning uuid, p_note text) RETURNS
uuid` — the warning must be an `FR-INS-063` row this tenant can see, not yet
resolved (TY019), and its rig must still be open (TY019 "stale: the rig
ended on %s"); the observed instant is the inspection's `started_at` (the
coupling was different no later than the walk-around began); the offered rig
ends at that instant and, unless the observed set is the motive alone, a new
rig opens at the same instant with the observed members in the offered order
(only removals are possible under D5). `app.dismiss_composition_observation`
records the other action. Both write the resolution row.

**API.** `GET /api/combinations/observations` (`ViewFleet`; unresolved
warnings joined to inspection, driver, offered members, observed members —
ids resolved to fleet numbers); `POST /api/combinations/observations/{id}/apply`
and `/dismiss` (`ManageAssignments`). `submitStatus` gains TY019.

**Web.** A **Reported differences** section at the top of `/fleet/rigs`:
who reported what, when, against which rig; **Apply** and **Dismiss**.

**Proof.** Suite section 48 (the ticket's DoD: an actioned warning closes
the prior rig's `effective_to` and opens one with the observed membership;
stale and cross-tenant refusals; a dismissed warning changes no rig); e2e
where the driver unticks the trailer in "Your rig", submits, and the
controller applies the difference — which needs B6.2's shared capture walk.

## Out of scope (owned, not forgotten)

| Item | Where it lives |
|---|---|
| The in-transport lock | TYRE-73, parked post-pilot (U1); conditional B6.5 |
| FR-INS-049's recurring schedule surface — create/pause a schedule per unit or operating group, and something to invoke `app.generate_inspection_tasks` daily | Unowned. **Raise a ticket at B6.2's close-out** under TYRE-55; it is additive on 000012 |
| Cancelling, reassigning or escalating a task by hand | TYRE-90 excludes them by name; same ticket as above or a sibling |
| Adding a unit from the driver's phone | Deliberately not built (D5, FR-INS-063 erratum) |
| Trailer distance inferred from coupling (INFERRED provenance, OI-31) | TYRE-44/OI-32 and BR-ANL-011; a rig's existence does not by itself apportion distance (FR-INS-064) |
| Guided full-unit tyre change (FR-FIT-018) | B5's out-of-scope table; still unscheduled |
| Depot-to-depot transfer, `brand_pending`, the unit odometer timeline from fitments | TYRE-100, TYRE-99, TYRE-106 |

## Non-ticket deliverables

- `docs/implementation-order.md` §B6 rewritten to this slicing, with the
  TYRE-73 correction (U1) — committed with this spec on `TYRE-72-rig-setup`.
- ADR-0012's code table: TY017 (B6.1), TY018 (B6.2), TY019 (B6.4).
- ADR-0014's attached-tables list and the 000036 `search_path` sentence
  (B6.1).
- An SRS erratum row is owed only if the owner reverses U4 (FR-INS-053
  already states the chain) or U10 (FR-VEH-030's "zero or more" is left as
  written, since the platform merely declines to record the degenerate
  case).
