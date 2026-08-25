# Design: driver capture and the submit outbox (sub-project 3)

- **Date:** 2026-08-25 (revised after fable-advisor review; SRS errata E2 applied)
- **Epic:** TYRE-4 (P3 — Capture app: PWA, offline queue, sync, M2)
- **Tickets:** TYRE-66 (db) · TYRE-71 (capture reference data) · TYRE-67 (submit
  endpoint) · TYRE-68 (shell) · TYRE-69 (capture and outbox) · TYRE-70 (mobile
  browser tests)
- **Decisions it rests on:** ADR-0009 (client platform and on-device data) ·
  ADR-0011 (actor context) · ADR-0007 (unit-centric fleet model) ·
  ADR-0010 (provenance, measured vs derived)
- **Requirements:** FR-INS-020..041, 045..055, 060..066 · FR-OFF-001..020 ·
  FR-VEH-016, FR-VEH-034 · BR-INS-002/003 · BR-VEH-001/003 · BR-ANL-009 ·
  CR-006, CR-010, CR-011 · DR-015..018, DR-020, DR-021 · NFR-USE-001, 001a,
  003, 004, 010, 011 · NFR-SEC-006/007 · NFR-OBS-007

## Why this exists

The platform cannot ingest a single reading. Twenty migrations have built a
register, a valuation engine that reproduces fifteen worked examples to the
cent, an exception engine and a snapshot history — and every row in it arrived
from a seed file. The API exposes five GET routes and no handler has ever
decoded a request body.

So the hypothesis the POC exists to test has never been tested. Sub-project 1
established who is asking. This one is the first time the answer is allowed to
write something down.

## Where it sits in the programme

Sub-project 3 of the five identified in the 23 Aug audit: *driver capture and
outbox*, closing the `INS` and `OFF` modules. Sub-project 2 (value at risk)
and sub-project 5 (exceptions and reports) both consume what lands here; until
it exists they can only read fixture data.

## The constraint everything here is subordinate to

> A driver must capture a full vehicle in under three minutes, on a phone, in
> the sun, with gloves on.

Formally NFR-USE-001 (ten positions, median ≤ 3 min) and NFR-USE-001a
(26-position rig, median ≤ 7 min). Three tread readings per position means a
superlink is 108 numeric entries, not 52. If a decision in this document makes
capture slower it is the wrong decision, however much it improves the
dashboard. Adoption is the whole game.

## Architecture — where each rule lives

| Concern | Layer | Why there |
| --- | --- | --- |
| Governing tread is `MIN()` of the measurements | trigger | Already enforced; the app role has no `UPDATE` on `app.reading` |
| Ordinals contiguous from 1 | deferred constraint trigger | DR-016, already present |
| Hard ranges: tread 0–35mm, pressure 0–1200 kPa | `CHECK` constraints | FR-INS-030/031, already present, never yet exercised by a client |
| Idempotency on replay | `UNIQUE (tenant_id, client_uuid)` | DR-015, already present |
| Position belongs to the vehicle's configuration | **new, in SQL** | No constraint covers it; unreachable until a client can post |
| Screen order to `OUTER`/`CENTRE`/`INNER` | **new, in SQL** | FR-INS-029a maps by side *on save*; one implementation |
| Duplicate-inspection window | **new, in SQL** | FR-INS-038, a Must with no implementation anywhere |
| Fitment disagreement is accepted, never refused | **new, in SQL** | FR-OFF-016 forbids rejection |
| Closing the `inspection_task` | **new, in SQL** | Nothing does it automatically today |
| An odometer refusal not costing the inspection | **new, in SQL** | FR-INS-020/033; the timeline trigger would otherwise abort the transaction |
| The warning-and-response record | **new table** | DR-021 (errata E2) |
| Atomicity of a whole vehicle | **new, in SQL** | One call, one transaction, no partial vehicle |
| Decoding, sizing, rate-limiting and refusing the request | Go | Transport; NFR-SEC-007 |
| Serving what a warning needs, before the signal goes | Go | FR-OFF-001 requires the checks to run offline |
| Rig-level position numbering | web, display only | FR-VEH-034: computed at render time, never stored, never transmitted |
| Holding the inspection until acknowledged | web | ADR-0009 |

The load-bearing observation is that the database already enforces most of
this. What it does not enforce is exactly what becomes reachable the moment a
write path exists, which is why the new rules go in SQL beside the old ones
rather than into Go for convenience.

## Components

### db/ — one migration (`000021`)

Two new objects and one repaired function.

**`app.inspection_warning`** — the home DR-021 (errata E2) gives FR-INS-040.
Append-only child of the inspection: `warning_code`, `entered_value` where
applicable, `response` — **nullable**, because a server-raised refusal has no
driver present to answer it — `source` (`CLIENT`/`SERVER`), `raised_at`, and an
optional `reading_id` so a per-position warning and an inspection-level one
share a home. `UPDATE` and `DELETE` revoked from the app role, like every other
record of fact.

**`app.submit_inspection(p_payload jsonb) RETURNS TABLE (inspection_id uuid, created boolean)`**
— one call writes the header, one `app.reading` per position, the width-wise
`app.reading_measurement` rows beneath each, the odometer, the warnings and the
task closure. `created` distinguishes a first submit from a replay so the API
answers 201 or 200 without a second query.

**`app.check_odometer_plausible()` gains custom ERRCODEs and loses a constant.**
Both are prerequisites, not polish. It currently raises three bare
`RAISE EXCEPTION`s, all defaulting to `P0001`, so a caller cannot trap the
timeline's refusals without also swallowing every other `P0001` in the
transaction — which is the silent-failure mode this design exists to refuse.
And it hard-codes `max_daily_km constant int := 1600` while DR-020 requires a
*configurable* ceiling and CLAUDE.md rule 5 forbids the constant outright. It
reads the ceiling from tenant configuration through `app.config_for`.

Properties of the submit function that are not negotiable:

**`SECURITY INVOKER`.** The suite's allowlist is exactly
`ARRAY['refresh_governing_tread']` and it fails the build on any other
`SECURITY DEFINER` routine in the `app` schema. Submit runs as the caller,
under RLS, `search_path` pinned to `app, pg_temp`.

**The governing tread is never in the payload.** The client sends
measurements; the trigger derives the minimum. `governing_tread_mm` in a
submit body is rejected rather than ignored, because silently discarding a
field a client thought was meaningful is how a client comes to believe it
works (CR-011, BR-INS-003, DR-017).

**Ordinals are checked before the function returns.** The contiguity trigger
is `DEFERRABLE INITIALLY DEFERRED`, so left alone it fires at `COMMIT` — after
the handler has returned, surfacing as a commit failure the API can only call
a 500. The function issues `SET CONSTRAINTS ALL IMMEDIATE` once the
measurements are in, so a malformed position is a refusal the client can act
on.

**Screen order becomes anatomical position inside the function.** The payload
carries the three readings in the order the driver entered them; the function
maps them to `OUTER`/`CENTRE`/`INNER` by the position's side relative to the
vehicle centreline. FR-INS-029a is explicit that the driver never sees the
words inner or outer. `orientation_known` is `true` for anything captured
through this path — the `false` case exists for imported history.

**Every reading carries a real identity, never a rig number.** BR-VEH-003 as
amended by E2: rig-level numbers "are never stored and never transmitted —
every reading is captured and submitted against `unit + own position`". So the
payload names `(vehicle_id, position_id)` and the continuous 1–26 a driver
sees on a superlink never leaves the display layer.

**Position validation follows the configuration lineage, not the current
pointer.** FR-VEH-016 versions axle configurations precisely so that amending
one "does not alter the position meaning of historical inspections". A
completed inspection can sit in the outbox for days; if an admin revises the
unit's configuration meanwhile, validating against the *current* version would
refuse a finished walk-around over an edit the driver never saw. The check is
that the named position belongs to *some* version of that vehicle's
configuration.

**A disagreement about the tyre is accepted, never refused.** FR-INS-026
identifies the tyre from fitment state and shows its display code; FR-INS-027
lets the driver report a difference. Fitment can change between capture and
submit, and FR-OFF-016 is unambiguous: "accepting the inspection and raising a
discrepancy exception for controller resolution, rather than rejecting the
inspection". The function trusts the payload's tyre identity — it is what the
driver physically saw — records the readings against it, and writes the
mismatch to `inspection_warning` with `source = 'SERVER'`. Raising a true
exception row waits for sub-project 5; losing the observation does not.

**The odometer can never block the inspection.** FR-INS-020 makes it optional,
pre-filled from the unit's last known reading, absent on a trailer-only
inspection, and says it "shall never block a tyre inspection… subject to
DR-020". FR-INS-064 adds that only the motive unit's odometer is recorded and
distance is never apportioned to towed units. The insert sits in its own
plpgsql exception block trapping *only* the timeline's new custom ERRCODEs and
re-raising everything else: a refusal rolls back that row alone, the
inspection commits, and the refused value plus the driver's confirmation land
on `inspection_warning`.

**The duplicate window is enforced here.** FR-INS-038 rejects a second
inspection of the same **unit** inside a configurable interval defaulting to
four hours, unless a `CONTROLLER` overrides. A replayed `client_uuid` is *not*
a second inspection and must not trip it — that distinction is the one the
tests pin hardest.

**Task closure cites the task the driver launched from.** FR-INS-052 requires
a completed task to cite its inspection, and a unit can carry several open
tasks at once (a schedule firing plus an ad-hoc instruction, FR-INS-051). The
payload names the `task_id`; FR-INS-048 already shows it to the driver, so the
client has it. Absent one, the function closes nothing rather than guessing.

Replay is a lookup, not an upsert: on a `client_uuid` this tenant has already
accepted, the function returns the existing id and writes nothing.

### api/ — the capture reference surface (TYRE-71)

FR-OFF-002 as amended by E2 now enumerates nine things, not six, and the three
additions exist because FR-OFF-001 takes connectivity away after session start:

> assigned units **and open inspection tasks**, configurations, current
> fitments, thresholds, targets, reading configuration, **each unit's last
> recorded odometer, each position's previous governing reading with fitment
> events since, and the fleet average wear rate per position class — cohorted
> per BR-ANL-009 — with the configured multiple**

The cohorting matters and is easy to get wrong: BR-ANL-009 forbids blending
across `axle_type`, because "a lifted axle is not touching the road", and
asserts no wear rate at all for lifting axles. Harmless today — every seeded
axle is `FIXED` — and wrong the first time a lifting axle appears.

All three additions are bounded per vehicle: one previous reading per
position, one average per position class. Serving them is what lets
FR-INS-034/035 evaluate with no signal.

Read by a `DRIVER`, who does not hold `ViewValuation`, so no monetary field
appears, and scoped so a driver reads only units assigned to them
(FR-AUT-005).

### api/ — the submit endpoint (TYRE-67)

`POST /api/inspections`, inside the existing `/api` subrouter, so
`requireActor` already covers it. The handler is the shape every other handler
has: `withActor`, then `require(a, auth.CaptureInspection)`, then the call. It
is the first body decode in the codebase, so it establishes the size limit,
the malformed-body refusal, and NFR-SEC-007's rate limiting per account and
per source address.

| Case | Status | Notes |
| --- | --- | --- |
| First submit | `201` | server inspection id |
| Same `client_uuid`, same tenant | `200` | same id, nothing written |
| Actor lacks `CaptureInspection` | `403` | — |
| Vehicle not visible in this tenant | `403` | indistinguishable from absent |
| Position not on any version of that vehicle's configuration | `422` | names the position |
| Second inspection inside the FR-INS-038 window | `409` | **permanent**, not retryable |
| Malformed or oversized body | `400` | — |
| Rate limit exceeded | `429` | NFR-SEC-007 |

The `409` deserves its own status because the outbox must treat it as a
permanent failure that surfaces FR-OFF-013's recovery action, not something to
retry for thirty minutes. Conflating it with `422` or a replay would make the
outbox hammer a refusal that will never change.

Attribution is `app_user.id`. `staff_number` appears nowhere on the write path.
No monetary field crosses this endpoint in either direction.

### web/ — the shell, the capture flow, the outbox

**The shell (TYRE-68).** A persistent left-hand navigation rendered from the
capability list `GET /api/me` already returns — not a hard-coded menu with
role checks in it. A `DRIVER` holds exactly `CaptureInspection` and sees one
item; an `ORG_ADMIN` holds eight and sees the full set. Navigation and route
guard read one source and cannot drift. Hiding an item is a courtesy; the
server refuses regardless (NFR-SEC-006).

**The capture flow (TYRE-69).** Mechanics are settled in the Driver Capture
prototype and are followed, not reinvented: a shared numeric keypad rather
than the native keyboard, a tread field that settles and auto-advances once it
cannot gain another digit, any-order completion by tapping the axle diagram,
severity carried by colour *and* background *and* a text badge. The token
system in `web/src/theme/tokens.ts` governs; a hex or font literal outside it
is a bug.

A rig inspection presents one continuous sequence across member units
(FR-INS-060) while every reading is recorded against the unit that owns the
position (FR-INS-061). The driver confirms the attached units before starting,
defaulting to the last recorded composition (FR-INS-062), and may begin with a
unit not previously associated, which records a change of composition
(FR-INS-063). Completeness is reported per member unit as well as for the rig
(FR-INS-065).

At-capture warnings — all inside Appendix H.1's `FR-INS-020..041`, so a
partial set would be a silent scope cut:

| Warning | Requirement | Needs |
| --- | --- | --- |
| Below the configured removal threshold | FR-INS-036 | tenant config |
| Width-wise spread beyond the margin | FR-INS-041 | tenant config; prompts for a photo |
| Pressure outside the correct band | FR-INS-037 | target pressure by axle class |
| Pressure beyond the target margin | FR-INS-031a | tenant config |
| Tread higher than last time, unexplained by a fitment | FR-INS-034 | previous reading, fitment events since |
| Wear rate above the configured multiple of fleet average | FR-INS-035 | cohorted average, configured multiple |
| Odometer backwards, or implausible daily distance | FR-INS-032/033 | last odometer, configured ceiling |

Every threshold is fetched tenant configuration; a hard-coded `4.0` here is a
bug. Nothing is ever labelled a legal limit (CR-010). Each warning raised and
the driver's response travels in the payload to satisfy FR-INS-040.

**Per-position timing (NFR-OBS-007)** is captured here or not at all. The
requirement records median time-per-position "so that the effect of the
three-reading model on NFR-USE-001 is measured rather than assumed", and
`app.inspection` carries only `duration_seconds`. Timings ride in the payload.
This cannot be retrofitted onto inspections already captured, which is why it
lands with TYRE-69 rather than later.

**The outbox (TYRE-69).** Online-first with a durable submit queue, per
ADR-0009 and CR-006 — no local replica of the register, no background-sync
dependency, no sync engine. Reference data is held in memory for the session
(FR-OFF-002/003). What is protected is the single in-progress inspection,
written incrementally so a killed browser or a flat battery costs nothing
(FR-OFF-005/006), held until the server acknowledges it. Explicit *Sync now*
(FR-OFF-010); never silently discarded (FR-OFF-014); a queue left sitting
warns the driver (FR-OFF-020). Backoff to a 30-minute ceiling (FR-OFF-012) —
except for the permanent refusals, `409` and `422`, which surface FR-OFF-013's
recovery action immediately. First Dexie dependency in the repo.

## Data flow — one submitted inspection

1. Driver opens the app; assigned tasks and reference data load (FR-INS-048,
   FR-OFF-002). From here connectivity is optional.
2. For a rig, the driver confirms the attached units (FR-INS-062).
3. Capture proceeds, each entry written to the durable buffer as it is made. A
   `client_uuid` is generated when the inspection starts, not when it is sent.
4. Submit moves it to the outbox. The network is now irrelevant to correctness.
5. `POST /api/inspections` → `withActor` → `app.submit_inspection`.
6. The function checks the duplicate window, validates each position against
   its configuration lineage, inserts, maps screen order to anatomical
   position, forces the ordinal check, writes the odometer inside its
   exception block, records warnings, and closes the cited task.
7. **The cascade the client never sees:** each measurement insert fires
   `refresh_governing_tread`, recomputing `MIN()` into
   `app.reading.governing_tread_mm`. That `UPDATE` fires
   `reading_snapshots_governing_change`, which values the tyre into
   `app.valuation_snapshot` at the tenant's configured removal threshold *for
   that date* and that tyre's own `rand_per_mm`. A driver's submit re-strikes
   the fleet's asset value inside the same transaction.
8. `201` returns; the outbox entry is released. Anything less leaves it
   queued, and a replay is safe.

`app.reading.vehicle_id` is the owning unit, which for a trailer position is
not the inspection's motive vehicle; `app.inspection.combination_id` records
the rig the capture was taken against.

## How E2 settled the four conflicts

Specifying this phase surfaced four places where the SRS contradicted itself or
left a Must without a home. All four are now amended in the live pages and
carry `(errata E2)` tags. Recorded here because the resolutions are the
premises this design is built on.

**C1 — BR-VEH-003 had been missed by the v1.4 unit-centric rewrite.** It now
reads "never stored and never transmitted — every reading is captured and
submitted against `unit + own position`", agreeing with FR-VEH-034. The
database was always right about this: suite check 9 already asserts the 1..26
projection is computed from `combination_member.sequence` with no stored
mapping to drift.

**C2 — FR-INS-040 was a Must with no data requirement.** DR-021 is new, and
`inspection_warning` is now a named entity, with the nullable `response` the
review argued for.

**C3 — an implausible odometer was both rejected and overridable.** The
resolution is DR-020's, and this design should own that rather than claim a
reading that satisfies everything: **the conflict is resolved in favour of the
timeline, and FR-INS-033's confirmation governs only the capture flow.** A
driver who confirms an implausible-forward value still does not get it onto
the timeline. The argument is DR-018: `vehicle_odometer_reading` is a record
of fact with `UPDATE` and `DELETE` revoked, so an accepted implausible value
is *permanent*, and per the sponsor's own Q6 answer it poisons every rate on
that vehicle. A confirmed override would write an irrevocable poison pill on
the say-so of a gloved thumb in the sun. The escape hatches exist for a value
that is genuinely real: the ceiling is tenant configuration, and FR-IMP-015
permits standalone odometer capture through the management interface once a
controller has checked it against the fuel records.

Nothing is discarded. The refused value and the driver's confirmation are
preserved on the warning record, which is the standard FR-OFF-014 sets for the
rest of the pipeline.

**C4 — FR-OFF-002's reference-data list was incomplete.** Extended to nine
items, with the BR-ANL-009 cohorting named explicitly.

## Testing

Three layers, and the three-way agreement rule applies: the database, the
capture app and the dashboard each compute the exception counts independently.

**db** — new sections in `db/tests/004_tests.sql`, as `app_login`: idempotent
replay writes nothing; the same `client_uuid` is accepted in a second tenant; a
rejected position rolls the whole vehicle back; the ordinal guard fires inside
the function rather than at commit; screen order maps correctly on both sides
of the vehicle; a position from another vehicle's configuration is refused
while one from a *superseded version of its own* is accepted; the FR-INS-038
window refuses a second inspection but never a replay; a fitment disagreement
is accepted and recorded; a cited task closes; a backwards odometer is refused
**without** costing the inspection and leaves a warning carrying the entered
value; a trailer-only inspection submits with no odometer; the tread and
pressure `CHECK` ranges hold on the write path, which no client has ever
exercised. Probe rows use `BEGIN`/`ROLLBACK` — never a cleanup `DELETE`, which
DR-014a has revoked anyway.

**api** — table-driven against a real Postgres. The 201/200 replay contract and
the 409-is-permanent distinction are the two to pin hardest.

**web** — vitest for the outbox state machine, the auto-advance rule, and the
permanent-versus-retryable refusal branch.

**e2e (TYRE-70)** — mobile-viewport Playwright projects against `vite dev`.
Full flow, offline capture, restart mid-inspection, reconnect and sync. M2's
criterion is proved here: a full vehicle captured in airplane mode, synced on
reconnect, correct positions in the database.

## Dependency this phase creates

TYRE-41 stops being theoretical. The exception views join on `inspection_id`
with no scoping to the latest inspection — invisible while every vehicle has
exactly one seeded inspection, wrong the first time a driver submits a second.
It lands with this phase, behind TYRE-66. It sits under epic TYRE-5, so the
dependency is cross-epic and wants re-scoping before pickup.

TYRE-38 (the snapshot trigger's same-tenant backstop) is write-adjacent but
not required here.

## Out of scope

- **Photos.** ADR-0009 queues them separately: a slow upload must never hold up
  a completed inspection. This is safe against FR-INS-039 (conditional
  photographic evidence, a Must) because FR-OFF-018 requires inspection data to
  submit successfully *where photograph upload fails* — so enforcement is
  necessarily client-side capture-and-queue, never a submit gate. The submit
  path is therefore complete without it.
- **Raising true exception rows** for a fitment discrepancy. FR-OFF-016's
  accept-and-record half lands here; the exception engine is sub-project 5.
- **Any endpoint that edits a reading.** Readings are immutable and
  `UPDATE`/`DELETE` are revoked. A mis-keyed reading is a compensating event.
- **Real authentication.** Identity remains the dev actor headers, gated on
  `import.meta.env.DEV` and `APP_DEV_TENANT_HEADER`, until FR-AUT-001 lands.
- **Cost-per-km and forecasting analytics** — Appendix H.2 defers them.
- **Monetary projection.** `ViewValuation` gets one with the first monetary
  endpoint, which is sub-project 2.

## Open items

> **Careful with the D-numbers: this table has its own numbering.** Its D1 and D2
> happen to match the `questions-for-rourke.md` decisions of the same name, but
> **its D3 does not** — here D3 is FR-INS-038's controller override, whereas the
> questions file's D3 was the combination-member capture read (settled, and now
> SRS FR-AUT-005 erratum D3). The questions file's D4 and D5 are also settled and
> have no counterpart here. When a plan or ticket cites "D3", check which list it
> means. Decisions of Record — D1–D5: Confluence page 14778369.

| # | Item | Blocks |
| --- | --- | --- |
| ~~D1~~ **ANSWERED 25 Aug 2026** | How is controller-set scheduling modelled — widen `ManageConfig`, or a narrower capability? **Resolved: widen it.** `CONTROLLER` and `DEPOT_MANAGER` gain `ManageConfig` in full — thresholds, bands and rates — with no narrower split capability. It is tenant-wide, not depot-narrowed. FR-AUT-007/008/009 carry erratum D1; the `auth.go` change itself is not yet made — it is TYRE-74. | Nothing now |
| ~~D2~~ **ANSWERED 25 Aug 2026** | Staff-number reuse: total unique index, tenant policy, or configurable? **Resolved: tenant policy.** Migration `000019`'s partial index stands as shipped; reuse is permitted once no active member holds the number. FR-AUT-022 carries erratum D2. | Nothing — the write path attributes by UUID, as it always did |
| D3 | Where is FR-INS-038's `CONTROLLER` override exercised — at capture on the device, pre-authorised, or after the fact? The SRS does not say. Default taken: the window is enforced server-side and an override is a controller action after a refusal, because the driver's device cannot be trusted to assert one. | Nothing; the refusal path works without it |
| OI-33 | BAC's real inspection sheets, as a check on this capture model and a defensible default cadence. | Nothing; TYRE-45 |
