# Design: driver capture and the submit outbox (sub-project 3)

- **Date:** 2026-08-25
- **Epic:** TYRE-4 (P3 — Capture app: PWA, offline queue, sync, M2)
- **Tickets:** TYRE-66 (db) · TYRE-67 (api) · TYRE-68 (shell) · TYRE-69 (capture
  and outbox) · TYRE-70 (mobile browser tests)
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
| Decoding, sizing and refusing the request | Go | Transport |
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

Four properties that are not negotiable:

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

At-capture warnings are in scope: below the tenant's configured threshold
(FR-INS-036), width-wise spread beyond the configured margin (FR-INS-041),
pressure outside the correct band (FR-INS-037), and the acknowledgement record
when a driver is warned and proceeds (FR-INS-040). Every threshold is fetched
tenant configuration. Nothing is ever labelled a legal limit (CR-010).

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
5. The function resolves rig-level position numbers to constituent vehicle
   plus own position, validates each against that vehicle's configuration,
   inserts, maps screen order to anatomical position, forces the ordinal
   check, closes the citing `inspection_task`.
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

Rig-level numbering deserves a note. BR-VEH-001 in SRS v1.4 is explicit that
continuous numbering across a combination is *a display projection computed
from the composition, never stored and never an identity*. The capture layer
numbers a superlink 1–26 for the driver; step 5 resolves those to constituent
vehicle plus own position on receipt. `app.reading.vehicle_id` is the owning
unit, which for a trailer position is not the inspection's motive vehicle.

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
vehicle's configuration is refused; a cited task closes. Probe rows use
`BEGIN`/`ROLLBACK` — never a cleanup `DELETE`, which DR-014a has revoked
anyway.

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
