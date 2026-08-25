# Design: driver capture and the submit outbox (sub-project 3)

- **Date:** 2026-08-25
- **Epic:** TYRE-4 (P3 — Capture app: PWA, offline queue, sync, M2)
- **Tickets:** TYRE-66 (db) · TYRE-71 (capture reference data) · TYRE-67 (submit
  endpoint) · TYRE-68 (shell) · TYRE-69 (capture and outbox) · TYRE-70 (mobile
  browser tests)
- **Decisions it rests on:** ADR-0009 (client platform and on-device data) ·
  ADR-0011 (actor context) · ADR-0007 (unit-centric fleet model) ·
  ADR-0010 (provenance, measured vs derived)
- **Requirements:** FR-INS-020..041, 045..055 · FR-OFF-001..020 · BR-INS-003 ·
  CR-006, CR-010, CR-011 · DR-015, DR-016, DR-017 · NFR-USE-001, 001a, 003,
  004, 010, 011 · NFR-SEC-006

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

NFR-OBS-007 requires the median time-per-position to be recorded as a metric,
so the effect of the three-reading model is measured rather than argued about.

## Architecture — where each rule lives

| Concern | Layer | Why there |
| --- | --- | --- |
| Governing tread is `MIN()` of the measurements | trigger | Already enforced; the app role has no `UPDATE` on `app.reading` at all |
| Ordinals contiguous from 1 | deferred constraint trigger | DR-016, already present |
| Idempotency on replay | `UNIQUE (tenant_id, client_uuid)` | DR-015, already present |
| Position belongs to the vehicle's configuration | **new, in SQL** | No constraint covers it; unreachable until a client can post |
| Screen order to `OUTER`/`CENTRE`/`INNER` | **new, in SQL** | FR-INS-029a maps by side *on save*; one implementation |
| Closing the `inspection_task` | **new, in SQL** | Nothing does it automatically today |
| Atomicity of a whole vehicle | **new, in SQL** | One call, one transaction, no partial vehicle |
| An odometer refusal not costing the inspection | **new, in SQL** | FR-INS-020 forbids blocking; the timeline trigger would otherwise abort the transaction |
| The warning-and-response record | **new table** | FR-INS-040 is a Must with no data requirement behind it (C2) |
| Decoding, sizing and refusing the request | Go | Transport |
| Serving what a warning needs, before the signal goes | Go | FR-OFF-001 requires the checks to run offline (C4) |
| Rig-level position numbering | web, display only | FR-VEH-034: computed at render time, never stored, never transmitted |
| Holding the inspection until acknowledged | web | ADR-0009 |

The load-bearing observation is that the database already enforces most of
this. What it does not enforce is exactly what becomes reachable the moment a
write path exists, which is why the new rules go in SQL beside the old ones
rather than into Go for convenience.

## Components

### db/ — one migration (`000021`), one function

`app.submit_inspection(p_payload jsonb) RETURNS TABLE (inspection_id uuid, created boolean)`

One call writes the header, one `app.reading` per position and the
width-wise `app.reading_measurement` rows beneath each. `created` distinguishes
a first submit from a replay so the API can answer 201 or 200 without a second
query.

Seven properties that are not negotiable:

**`SECURITY INVOKER`.** The suite asserts that `app.refresh_governing_tread`
is the *only* `SECURITY DEFINER` routine in the schema and fails the build on
any other. Submit runs as the caller, under RLS, and `search_path` is pinned
to `app, pg_temp` in line with the TYRE-57 helpers.

**The governing tread is never in the payload.** The client sends
measurements; the trigger derives the minimum. `governing_tread_mm` in a
submit body is rejected rather than ignored, because silently discarding a
field a client thought was meaningful is how a client comes to believe it
works (CR-011, BR-INS-003, DR-017).

**Ordinals are checked before the function returns.** The contiguity trigger
is `DEFERRABLE INITIALLY DEFERRED`, so left alone it fires at `COMMIT` — after
the handler has returned, surfacing as a commit failure the API can only call
a 500. The function issues `SET CONSTRAINTS ALL IMMEDIATE` once the
measurements are in, so a malformed position is a refusal the client can
understand and fix.

**Screen order becomes anatomical position inside the function.** The payload
carries the three readings in the order the driver entered them; the function
maps them to `OUTER`/`CENTRE`/`INNER` by the position's side relative to the
vehicle centreline. FR-INS-029a is explicit that the driver never sees the
words inner or outer, and CHG-010 fixed the convention. `orientation_known`
is `true` for anything captured through this path — the `false` case exists
for imported history that predates the convention, not for live capture.

**Every reading carries a real identity, never a rig number.** FR-VEH-034 is
explicit: rig-level numbering across a combination is *computed at render time
from the composition, never stored*, and "every reading attaches to `unit +
own position`". So the payload names `(vehicle_id, position_id)` per reading
and the continuous 1–26 a driver sees on a superlink never leaves the display
layer. The function still validates that each position belongs to the vehicle
it is claimed against — that check is what makes trusting the identity safe.

**The odometer can never block the inspection.** FR-INS-020 (corrected v1.4)
makes it optional, pre-filled from the unit's last known reading for the
driver to confirm or correct, absent entirely on a trailer-only inspection,
and says it "shall never block a tyre inspection". A confirmed value is
written to the vehicle timeline with `source = INSPECTION`. But
`app.vehicle_odometer_reading` carries its own `BEFORE` trigger that rejects a
backwards or implausible reading, and a trigger that fires inside the submit
would abort the whole transaction — losing the inspection to protect a
subsidiary number. So the odometer insert sits in its own plpgsql exception
block: a rejection rolls back that row alone, the inspection commits, and the
refusal is recorded as a warning against the inspection.

**Warnings and the driver's response to them are recorded.** FR-INS-040 is a
Must: *"record every validation warning that was raised and the user's
response to it."* No DR-xxx says where, and no entity in SRS §5 carries a
field for it — see the conflicts section. This design gives it an append-only
child table keyed to the inspection, with an optional reading reference so a
per-position warning and an inspection-level one (the odometer) share a home.
A record that exists only in the browser is not a record.

Replay is a lookup, not an upsert: on a `client_uuid` this tenant has already
accepted, the function returns the existing id and writes nothing. Readings
are append-only and there is no version of this where a replay edits one.

### api/ — one route, no new patterns

`POST /api/inspections`, inside the existing `/api` subrouter, so
`requireActor` already covers it. The handler is the shape every other handler
already has: `withActor` for the actor-bound transaction, then
`require(a, auth.CaptureInspection)`, then the call. It is the first body
decode in the codebase, so it also establishes the size limit and the
malformed-body refusal.

The replay contract, which the outbox depends on absolutely:

| Case | Status | Body |
| --- | --- | --- |
| First submit | `201` | server inspection id |
| Same `client_uuid`, same tenant | `200` | the same id, nothing written |
| Actor lacks `CaptureInspection` | `403` | — |
| Vehicle not visible in this tenant | `403` | indistinguishable from absent |
| Position not on that vehicle | `422` | which position |
| Malformed or oversized body | `400` | — |

Attribution is `app_user.id`. `staff_number` appears nowhere on the write path
— not in the payload, not in the outbox record, not in a key. It is a
human-facing label; identity is the UUID, and that is what keeps a reused
employee number from ever re-pointing one person's history at another.

No monetary field crosses this endpoint in either direction.

### api/ — the capture reference surface (TYRE-71)

The capture flow cannot be built without this and none of it exists today.
FR-OFF-002 has the client fetch reference data at session start and hold it in
memory for the session only — no persistent cache, no replica of the register
on the device — and FR-OFF-001 then requires a driver to complete and submit
with no further connectivity. Everything a capture needs to know must
therefore have arrived before the driver walks up to the vehicle.

FR-OFF-002 names six things: *assigned units, configurations, current
fitments, thresholds, targets, reading configuration*. That parenthetical is
the closest the SRS comes to an enumeration and it is demonstrably incomplete
— two more are required by §4.8 and one by the odometer rule:

| Also required | Because |
| --- | --- |
| Last recorded odometer per unit | FR-INS-020 pre-fills a projection from it, and FR-INS-032/033 validate against it |
| Previous governing reading per position, and fitment events since | FR-INS-034 warns on an unexplained tread increase |
| Fleet average wear rate per position class, and the configured multiple | FR-INS-035 warns above it, defaulting to three times |

All three are bounded per vehicle — one previous reading per position, one
average per position class — so serving them costs a small payload rather than
a replica. Serving them is what lets FR-INS-034/035 evaluate offline, which
FR-OFF-001 requires and FR-OFF-002's list does not anticipate.

Read by a `DRIVER`, who does not hold `ViewValuation`, so no monetary field
appears. Every threshold is tenant configuration through `app.config_for`.

### web/ — the shell, the capture flow, the outbox

**The shell (TYRE-68).** A persistent left-hand navigation rendered from the
capability list `GET /api/me` already returns — not a hard-coded menu with
role checks in it. A `DRIVER` holds exactly `CaptureInspection` and sees one
item; an `ORG_ADMIN` holds eight and sees the full set. Navigation and route
guard then read one source and cannot drift. Hiding an item is a courtesy; the
server refuses regardless (NFR-SEC-006).

**The capture flow (TYRE-69).** The mechanics are settled in the Driver
Capture prototype and are followed, not reinvented: a shared numeric keypad
rather than the native keyboard, a tread field that settles and auto-advances
once it cannot gain another digit, any-order completion by tapping the axle
diagram, and severity carried by colour *and* background *and* a text badge.
The token system in `web/src/theme/tokens.ts` governs; a hex or font literal
outside it is a bug.

At-capture warnings are in scope — all of them sit inside Appendix H.1's
`FR-INS-020..041`, so a partial set would be a silent scope cut:

| Warning | Requirement | Needs |
| --- | --- | --- |
| Below the configured removal threshold | FR-INS-036 | tenant config |
| Width-wise spread beyond the margin | FR-INS-041 | tenant config, and prompts for a photo |
| Pressure outside the correct band | FR-INS-037 | target pressure by axle class |
| Pressure beyond the target margin | FR-INS-031a | tenant config |
| Tread higher than last time, unexplained by a fitment | FR-INS-034 | previous reading and fitment events |
| Wear rate above the configured multiple of fleet average | FR-INS-035 | fleet average, configured multiple |
| Odometer backwards, or an implausible daily distance | FR-INS-032/033 | last odometer |

Every threshold is fetched tenant configuration; a hard-coded `4.0` anywhere
here is a bug. Nothing is ever labelled a legal limit (CR-010). Each warning
raised, and whether the driver acknowledged and continued, travels in the
submit payload to satisfy FR-INS-040.

**The outbox (TYRE-69).** Online-first with a durable submit queue, per
ADR-0009 and CR-006 — no local replica of the register, no background-sync
dependency, no sync engine. Reference data is held in memory for the session
(FR-OFF-002/003). What is protected is the single in-progress inspection,
written incrementally so a killed browser or a flat battery costs nothing
(FR-OFF-005/006), and held until the server acknowledges it. An explicit
*Sync now* exists (FR-OFF-010), a submit is never silently discarded
(FR-OFF-014), and a queue left sitting warns the driver (FR-OFF-020). First
Dexie dependency in the repo.

## Data flow — one submitted inspection

1. Driver opens the app; `GET /api/my/tasks` lists what is assigned
   (FR-INS-048). Reference data loads into memory.
2. Capture proceeds, each entry written to the durable buffer as it is made. A
   `client_uuid` is generated when the inspection starts, not when it is sent.
3. Submit moves it to the outbox. From here the network is irrelevant to
   correctness.
4. `POST /api/inspections` → `withActor` binds tenant and actor →
   `app.submit_inspection`.
5. The function validates each reading's position against the vehicle it is
   claimed against, inserts, maps screen order to anatomical position, forces
   the ordinal check, writes the odometer to the vehicle timeline in its own
   exception block, records the warnings the driver saw and answered, and
   closes the citing `inspection_task`.
6. **The cascade the client never sees:** each measurement insert fires
   `refresh_governing_tread`, recomputing `MIN()` into
   `app.reading.governing_tread_mm`. That `UPDATE` fires
   `reading_snapshots_governing_change`, which values the tyre into
   `app.valuation_snapshot` using the tenant's configured removal threshold
   *at that date* and that individual tyre's `rand_per_mm`. A driver's submit
   re-strikes the fleet's asset value inside the same transaction. There is no
   batch job and no second write path for money.
7. `201` returns; the outbox entry is released. Anything less than a clean
   acknowledgement leaves it queued, and a replay is safe.

Rig-level numbering deserves a note, because it is the one place this design
changed after review. A superlink shows the driver a continuous 1–26. That
numbering is a *display projection computed at render time from the
composition* (FR-VEH-034, BR-VEH-001) — never stored, never an identity. The
client already holds the composition as reference data, so it does the
projection for display and sends real identities. Nothing resolves a rig
number server-side because no rig number is ever transmitted.

`app.reading.vehicle_id` is the owning unit, which for a trailer position is
not the inspection's motive vehicle; `app.inspection.combination_id` records
the rig the capture was taken against.

## Error handling

The API reuses the existing 401/403/500 vocabulary rather than inventing one;
`422` is new and exists only for a payload that is well-formed but describes
an impossible vehicle. A refusal never distinguishes *you may not see this*
from *this does not exist* (ADR-0011).

Client-side, a failure is a queued submit, never a lost one. The outbox
retries with backoff to a 30-minute ceiling while the app is open
(FR-OFF-012), surfaces a recovery action on a submit the server has rejected
outright (FR-OFF-013), and never discards silently.

## Testing

Three layers, and the three-way agreement rule applies: the database, the
capture app and the dashboard each compute the exception counts independently,
so a change that breaks one and not the others is visible immediately.

**db** — new sections in `db/tests/004_tests.sql`, as `app_login`: idempotent
replay writes nothing; the same `client_uuid` is accepted in a second tenant;
a rejected position rolls the whole vehicle back; the ordinal guard fires
inside the function rather than at commit; screen order maps correctly to
anatomical position on both sides of the vehicle; a position from another
vehicle's configuration is refused; a cited task closes; a backwards odometer
is refused **without** costing the inspection and leaves a recorded warning
behind; a trailer-only inspection submits with no odometer at all; a warning
the driver acknowledged survives the submit. Probe rows use `BEGIN`/`ROLLBACK`
— never a cleanup `DELETE`, which DR-014a has revoked anyway.

**api** — table-driven against a real Postgres. The 201/200 replay contract is
the one to pin hardest.

**web** — vitest for the outbox state machine and the auto-advance rule, which
are the two pieces of logic with real edges.

**e2e (TYRE-70)** — mobile-viewport Playwright projects against `vite dev`.
Full flow, offline capture, restart mid-inspection, reconnect and sync. M2's
own criterion is proved here: a full vehicle captured in airplane mode, synced
on reconnect, correct positions in the database.

## Dependency this phase creates

TYRE-41 stops being theoretical. The exception views join on `inspection_id`
with no scoping to the latest inspection — invisible while every vehicle has
exactly one seeded inspection, and wrong the first time a driver submits a
second one for the same vehicle. It lands with this phase, behind TYRE-66.

TYRE-38 (the snapshot trigger's same-tenant backstop) is write-adjacent but
not required here.

## Conflicts found in the SRS

Specifying this phase surfaced four places where SRS v1.4 contradicts itself or
leaves a Must requirement without a home. House rule is to flag a conflict
rather than silently pick a side, so each is recorded here with the reading
this design proceeds on and why. All four want an errata pass.

**C1 — BR-VEH-003 was missed by the v1.4 unit-centric rewrite.** It still says
rig-level numbers "exist only in the capture presentation layer and are
resolved to unit and position **on receipt**", which describes numbers
crossing the wire. FR-VEH-034 and BR-VEH-001 say the projection is computed at
render time and never stored. In the Part 4 §6.4 table, BR-VEH-001 is tagged
*(revised v1.4)* and BR-VEH-002 *(resolved v1.4)*; BR-VEH-003 carries no tag
at all, which is what an editorial miss looks like. **Proceeding on
FR-VEH-034**, which is explicit, dated and consistent with the rewritten §4.5.

**C2 — FR-INS-040 is a Must with no data requirement behind it.** It demands a
record of every warning and the user's response; no DR-xxx in §5.2 defines
where that lives and no entity in §5.1 carries a field for it. The nearest
thing, `exception.acknowledged_at`, belongs to the exception engine's post-hoc
alerts and is a different concept. **Proceeding by adding an append-only child
table**, and the SRS wants a DR to match.

**C3 — an implausible odometer is both rejected and overridable.** For a
*backwards* reading FR-INS-032, DR-020 and BR-INS-002 agree: reject. For a
*forward but implausible* one, DR-020 says reject while FR-INS-032/033 say
warn and require confirmation. FR-INS-020 then constrains both by saying the
odometer "shall never block a tyre inspection". **Proceeding on the reading
that satisfies all three**: the client warns and asks for confirmation before
submit; the database still refuses a row that violates its trigger; and
because that refusal is contained in its own exception block, the inspection
survives either way and the refusal becomes a recorded warning. No reading of
these requirements justifies losing an inspection over an odometer.

**C4 — FR-OFF-002's reference-data list is incomplete.** It enumerates six
items and omits the last odometer (FR-INS-020 pre-fills from it), the previous
reading and fitment history (FR-INS-034), the fleet average wear rate
(FR-INS-035) and assigned tasks (FR-INS-048). Since FR-OFF-001 requires
capture to complete offline once reference data has loaded, anything a
warning needs must be in that payload. **Proceeding by serving the additions**
listed under TYRE-71.

## Out of scope

- **Photos.** ADR-0009 queues them separately by design: a slow upload must
  never hold up a completed inspection.
- **Any endpoint that edits a reading.** Readings and fitment events are
  immutable and `UPDATE`/`DELETE` are revoked. A mis-keyed reading is a
  compensating event, which is its own ticket and not this one.
- **Real authentication.** Identity remains the dev actor headers, gated on
  `import.meta.env.DEV` and `APP_DEV_TENANT_HEADER`, until FR-AUT-001 lands as
  its own sub-project. Accepted deliberately.
- **Cost-per-km and forecasting analytics** (FR-ANL-010..015, 040..043) —
  Appendix H.2 defers them.
- **Monetary projection.** `ViewValuation` still has no projection; it gets
  one with the first monetary endpoint, which is sub-project 2.

## Open items

| # | Item | Blocks |
| --- | --- | --- |
| D1 | Does `CONTROLLER` gain `ManageConfig`? Rourke expects controllers to set inspection cadence; the capability table gives it to `ORG_ADMIN` alone. | Nothing here; the config-editing surface |
| D2 | Staff-number reuse: total unique index, tenant policy, or configurable? Migration `000019` deliberately permits reuse. | Nothing here — the write path attributes by UUID either way |
| OI-33 | BAC's real inspection sheets, as a check on this capture model and a defensible default cadence. | Nothing; TYRE-45 |

Neither D1 nor D2 blocks a line of this phase, which is why it proceeds.
