# Design: per-trip driver assignment, and nominated drivers for idle units (TYRE-326)

- **Date:** 2026-10-22
- **Ticket:** TYRE-326, under epic TYRE-55. Two follow-ons were split off in
  the spec session: TYRE-455 (the odometer reading when a trailer is released,
  and "Mark free") and the TYRE-133 generator changes in comment 14024.
- **Decisions it rests on:**
  - Owner ruling U143 (TYRE-283 comment 13866), which closed OI-32.
  - The owner's 20 Oct 2026 answers on TYRE-440 (comment 13871), which the
    ticket description records.
  - Owner ruling U147, items B13 to B15 (TYRE-326 comment 13945) and B20
    (TYRE-284 comment 13922).
  - The owner's answers in this spec session, 21 and 22 Oct 2026, under
    "Decisions" below.
  - Owner rulings U148 (TYRE-326 comment 14033) and U149 (comment 14032),
    from the plan's red team, round 1, and U150 (comment 14035), from round
    2, under "Rulings after approval" below.
  - ADR-0012 (refusal contract), ADR-0013 (a write with a rule of its own is
    a SQL function), ADR-0014 (audit), ADR-0018 (pipeline).
- **Requirements:** FR-VEH-007, FR-INS-050, FR-INS-051, FR-INS-052, FR-INS-053,
  FR-INS-062, FR-INS-063, FR-AUT-005, FR-AUT-008, FR-DSH-012, FR-FIT-025,
  FR-OFF-015, Appendix H.3 criterion 4, and §5.1's trip entity. Each is read
  as amended by the SRS Part 3 errata tagged TYRE-440, TYRE-284 and TYRE-326
  (page version 16, and the U148 rows once pasted). OI-32 is closed.

## Why this exists

Only the step straight after Add a user can assign a driver to a unit
(`web/src/admin/AddDriver.tsx`). Navigate away and no other screen can do it,
yet Schedule an inspection refuses a unit with no assigned driver. U143 then
changed the model: BAC assigns drivers per trip, not per vehicle.
`vehicle_driver` cannot carry a trip. Its bounds are dates, so it cannot show
a same-day handover or who held a unit when an inspection started. Its
overlap rule is per vehicle and driver pair (`vehicle_driver_no_overlap`,
000026), so two drivers can hold one unit at once.

BAC runs full inspections once a week. Trailers move between horses whenever
a controller re-couples them at a depot or destination, so a standing
per-vehicle assignment never matches what is on the road.

## What changed from the ticket as written

The 22 Oct answers amend four of the ticket's definition-of-done lines and
B15. The amended lines are posted on TYRE-326 with this spec's commit.

- **Trailers at trip start.** B15 and the DoD let the start form change the
  rig to name other trailers. The owner's rule (22 Oct, 05:55 and 05:57 UTC):
  a trailer can be coupled only once it is free. A trailer in another
  motive's open rig cannot be picked, and the trip start never ends another
  motive's rig. The start form only adds free trailers. Dropping a trailer
  from its own truck is a release, and a release is TYRE-455's "Mark free",
  which records the odometer. Until TYRE-455 ships, ending a rig on the Rigs
  screen is how a trailer is freed.
- **Schedule an inspection.** The DoD says it creates a task without choosing
  a driver. On a unit with no trip, the controller may now nominate a driver
  for it (22 Oct, 06:16). The "Assign one before scheduling an inspection"
  message still goes.
- **A driver with no open trip sees no vehicle.** This still holds, except that
  a nominated driver sees, and may capture, the units of an inspection they
  are nominated for, until it is done or a trip takes it over.
- **A driver sees a unit's due tasks only while on its trip.** The same
  exception applies: a nominee sees the tasks they are nominated for.

The mockups shown in the session were concept only. The owner will settle the
look in the front-end component rework (TYRE-443, ADR-0020; 22 Oct, 05:57).
This spec fixes what each screen says and does, not how it looks.

## Decisions

These are the owner's answers in this spec session. The verbatim copies are in
the pipeline state file.

1. **Why per trip** (21 Oct, 23:13). BAC inspects weekly, controllers
   re-couple trailers whenever a driver arrives, and a controller issues a
   trailer change that the driver carries out. The odometer reading at a
   change of coupling became TYRE-455, which is blocked by this ticket.
2. **Who a task counts for** (21 Oct, 23:17; refined by 6 below). A completed
   task counts for the driver whose inspection completed it. A missed task
   counts against the driver responsible for the unit at its due instant. A
   unit with nobody responsible at that instant lands on the controller's "no
   driver" row. This replaces "by the task's assigned driver" in the TYRE-284
   erratum.
3. **Only free trailers can be coupled** (22 Oct, 05:55). This supersedes the
   21 Oct 23:24 answer, under which the trip start moved a trailer across from
   another horse with a warning. The driver confirming the coupled trailers is
   on TYRE-455 (comment 14022).
4. **The split with TYRE-455** (22 Oct, 05:57). This ticket builds selection:
   only free trailers can be picked, and a trailer coupled elsewhere is shown
   as not selectable, naming its truck. TYRE-455 builds "Mark free" with the
   motive's odometer reading and the distance calculation (comment 14023).
5. **Nominated drivers for idle units** (22 Oct, 06:16). A truck that is not
   moving on inspection day has no trip driver. The controller may nominate a
   free driver, or any driver, to carry out its inspection.
6. **A trip takes over a nomination** (22 Oct, 06:20). If a trip starts on the
   unit before the nominated inspection is done, the inspection passes to the
   trip driver.

The owner approved the rest of the played-back design as presented (22 Oct,
06:16): trip start and end, the as-of-start capture check, the migration of
today's assignments, Add a user losing its step, and the driver's phone.

## Rulings after approval

The owner approved this spec at f608d79 (22 Oct, 06:58). The plan's red team,
round 1, then raised two questions, and the owner's rulings amend the design
as follows.

- **U148: no capture is lost, and a due inspection blocks the trip** (TYRE-326
  comment 14033; 08:49, confirmed 09:03). A capture is never refused for its
  length. The owner went further: a truck cannot be used until its due
  inspection is done. While it is idle the inspection stays open, and the
  truck cannot start a trip until the inspection is carried out. BAC runs
  full inspections every Wednesday, wherever the truck is parked. A truck
  already on a trip is not stopped. The rule is a tenant setting, on for BAC.
  A missed inspection still counts as missed (criterion 4 unchanged). There
  is no override. "Starting a trip" and "Capture" below carry the rule.
- **U149: the rig register follows depot scope** (comment 14032; 08:49). A
  depot manager seeing every depot's rigs is a bug, fixed in this branch. A
  depot manager sees a rig when its motive or any of its members is in their
  depots. "Depot scope" below carries it.
- **U150: an inspection covers the configuration as a whole** (comment 14035;
  09:54). A horse with two trailers is one inspection; an idle horse and two
  idle uncoupled trailers are three. Without this, a rig captured through the
  motive's task left its trailers' tasks OPEN (000041:554-559), and U148's
  gate then held the truck with no way out. "Capture" below carries it.
- **Lead departure, serving U148: a draft can be resumed after its trip
  ends.** The capture context read judged at now, so a draft resumed after
  the controller ended the trip met a 403, and the held draft then blocked
  every other capture on the phone. "Capture" below carries the fix.

## Goals

- A controller starts and ends a trip from the motive unit's screen, naming
  the driver and adding free trailers.
- Every outstanding task resolves to exactly one responsible driver, or to
  nobody, at any instant. Nobody means the task shows on the controller's list
  as escalated. One SQL function makes this decision, and every reader asks
  it.
- A driver captures what they hold: the units of their trip, or the units of
  an inspection they are nominated for. The server judges this over the
  capture itself, from its start to its submission, not at its arrival.
- The SRS stops contradicting the build. Every erratum this design needs is in
  the handover prompt.

## Non-goals

- Releasing a trailer with an odometer reading, and the distance it travelled
  (TYRE-455).
- The driver confirming that the coupled trailers match (TYRE-455).
- Which units a weekly schedule makes due, and running the generator daily
  (TYRE-133). This ticket changes only how the generator names a driver.
- Starting an inspection only against an open task (TYRE-319).
- The per-driver compliance report and criterion 4's figure (TYRE-284). This
  ticket supplies the attribution function they read.
- The depot owner leg of FR-INS-053's chain, which is not built. An uncoupled
  trailer's task goes to the controller's list unless someone is nominated.
- A DEPOT_MANAGER's depot-scoped capture (TYRE-76). It builds on this ticket's
  trips.
- The visual design of the trip panel (TYRE-443).

## Anti-goals

- **No implicit moves.** Nothing in this ticket ends another motive's rig to
  take its trailer. A trailer is coupled to one motive or free, and only a free
  one is coupled.
- **No second routing rule.** Go never decides who is responsible for a task,
  and no view restates the order of precedence.
- **No new driver taps.** The capture flow gains no step. A driver on a trip
  sees what they saw before for their assigned vehicle.

## Design

### The trip

The trip is a new tenant table, `app.trip`, with the attributes in the
TYRE-326 §5.1 erratum: tenant, motive vehicle, driver, `started_at` and
`ended_at` as instants, `started_by`, `ended_by`, and `combination_id`. It
uses `app.enable_tenant_rls`, an audit trigger (ADR-0014), and an EXCLUDE on
the tstzrange per (tenant, vehicle) and per (tenant, driver). A trip is open
while `ended_at` is null.

- A trip's vehicle is a motive unit: a horse, rigid or light vehicle. A trip on
  a trailer is refused. A retired unit (DISPOSED, INACTIVE) is refused, which
  matches the rig write's U9 rule. PARKED, WORKSHOP and OUT_OF_SERVICE are
  allowed.
- A trip's driver is an active user of the tenant whose role holds
  `CaptureInspection`. The capability map lives in Go (`auth.go`), so the API
  checks the capability and SQL checks that the user is active and in the
  tenant. A trip whose driver cannot capture grants nothing, because capture
  is gated on `CaptureInspection` in Go.
- `combination_id` is the motive's open rig just after the trip started, or
  null when the motive tows nothing. It is a snapshot only.
  `apply_composition_observation` (000044) can end and reopen the rig
  mid-trip, so capture scope, task routing and the unit screen read the
  motive's open rig at the instant in question, never this column.

### Starting and ending a trip

Both writes are SQL functions (ADR-0013), gated by `ManageAssignments` in Go
(B14), and audited.

**Start** takes the motive, the driver and an ordered list of trailers to add,
which may be empty. In one transaction it:

0. **Refuses while a due inspection is outstanding** (U148), when the
   tenant's setting requires it. The setting is read with `app.config_for`,
   and its fallback is on, with BAC as the evidence; the builder names it. The
   start is refused, changing nothing, if any unit the trip would cover has an
   OPEN task whose due date, read in the tenant's calendar, is today or
   earlier. Those units are the motive, the members of its open rig and the
   added trailers. The refusal names each unit and its due date. It is
   permanent, so it shows as the server's words, and there is no override
   argument. A task due on a later date does not block. The check is SQL's,
   inside `start_trip`, so a raw call meets it too.
1. Ends the motive's open trip, and the driver's open trip on any motive, at
   the start instant. The ticket and the FR-VEH-007 erratum both say that
   reassigning the truck or the driver closes the old trip. The EXCLUDE is the
   backstop, not the mechanism.
2. Couples the added trailers, if any, through TYRE-72's rig write
   (`create_combination_at` and `end_combination_at`, 000044). It ends the
   motive's own open rig and opens one holding its existing members, then the
   added trailers in the order picked. A motive with no rig gets a new one.
   Every added trailer must be free: in no open rig. A trailer in another
   motive's rig is refused with a message that names that motive. INV-4
   (000037) already refuses a unit in two open rigs, and the start must
   refuse first with the clearer message.
3. Inserts the trip, with `combination_id` set as above.

The start never removes a trailer from the motive's rig.

**End** takes the trip and stamps `ended_at` and `ended_by`. It leaves the rig
coupled. Ending an ended trip is refused.

Both happen at the server's now. There is no back-dated start or end. The
controller starts a trip before the truck leaves, and a back-dated start
would close earlier trips and couple trailers in the past, which the rig
history may refuse.

**Depot scope.** FR-AUT-008 scopes a DEPOT_MANAGER's controller permissions
to their depots. The start, the end and a nomination lock their unit against
`unitSource` when the actor's scope is not tenant-wide, as Schedule an
inspection does (`tasks.go:288`). The unit is the motive for a trip, and the
task's unit for a nomination. An added trailer is judged through its motive,
as TYRE-76's FR-AUT-008 erratum judges a rig's towed units. The driver picker
is not narrowed by depot.

The rig routes in `combinations.go` lock nothing against depot scope, unlike
every other by-id write. Unless the planner finds a record that rigs are
deliberately tenant-wide, that is a bug. It is fixed on this branch (U146),
judged by the rig's motive, with a regression test. The rig register read
(`GET /api/combinations`) is not narrowed either, and U149 rules that a bug
too: a depot manager sees a rig when its motive or any of its members is in
their depots, and the rig comes back whole.

Ending the driver's earlier trip is visible: the driver picker names the truck
of any driver already on a trip, so the controller sees what the start will
close.

### Who is responsible for a task

One SQL function, called `app.task_driver_at(task, at)` here, returns the
responsible user, or null, for a task at an instant. It applies this order,
which is FR-INS-053's chain with the trip and the nomination in it:

1. **The trip driver.** If the task's unit is the motive of a trip open at
   `at`, or sits in the open rig at `at` of a motive with a trip open at `at`,
   the result is that trip's driver.
2. **The task's nominee.** Otherwise, the result is the newest nomination on
   the task made at or before `at`. A nomination lapses when a trip covering
   the unit starts after it and at or before `at` (decision 6). When that
   trip ends, the nomination does not come back.
3. **The motive's nominee, for a coupled trailer.** Otherwise, if the unit is
   a trailer in the open rig at `at` of a motive, the result is that motive's
   rule 2 answer: the newest live nomination on an outstanding task of that
   motive. A controller who nominates a driver for a coupled horse's
   inspection has given them the rig.
4. **Nobody.** Otherwise, null.

Every reader goes through this function:

- the driver's task list (`v_my_inspection_task`), at now;
- the controller's task list and its Driver column, at now;
- the escalation flag, at now;
- missed-task attribution, at `due_at`. TYRE-284 reads it.

### Nominations

A nomination names a driver for one task. It is a row in a new insert-only
tenant table, `app.inspection_task_nomination` (the SRS errata name it):
task, user, `nominated_at` and `nominated_by`, with RLS and
UPDATE and DELETE revoked. Re-nominating adds a newer row. The history is the
point: both the capture-window check and the due-instant attribution ask
who was nominated at a past instant.

- A nomination is made at scheduling, as an optional driver on Schedule an
  inspection, or later, on an outstanding task from the controller's list. The
  later route is how a "no driver" row gets a driver.
- It is refused while a trip covers the unit, because the task already goes to
  the trip driver. It is refused on a task that is not outstanding.
- The nominee must be active and hold `CaptureInspection`, checked as for a
  trip driver. A driver on a trip elsewhere may be nominated (decision 5).
- `ManageAssignments` gates it.
- There is no withdrawal back to nobody in this ticket. A controller replaces
  a nominee by nominating someone else. A withdrawal row can be added later
  without rewriting the history.
- `app.task_driver_at` does not read `app_user.active`. That flag keeps no
  history, so reading it would rewrite past attribution. No route deactivates
  a user yet (TYRE-377).

*Amended by the plan's Decision 17 and the review of PR #148 (TYRE-326). A
generated task with no assignee, which part D of the migration makes OPEN,
gains the driver of a converted trip that covers its unit or, for a towed
unit, the live nominee of its rig motive's task, so that task does change
hands at deploy. An outstanding task whose assignee is a deactivated user
gets no nomination of its own, because `app.nominate_for_task` would refuse
them. After deploy it is held only through a converted trip covering its unit
or, for a towed unit, through its rig motive's live nominee; otherwise nobody
holds it and it reads escalated.*

`inspection_task.assigned_user_id` stops being written. The migration copies
each outstanding task's assignee into a nomination dated at the task's
`created_at`, with `requested_by` as the nominator, so no outstanding task
changes hands at deploy. Whether the column is then dropped is the builder's
call. It must not stay a second source that any reader trusts.

### Escalation, overdue and the task states

- Escalated is worked out, not stored. A task is escalated while it is
  outstanding and `app.task_driver_at(task, now())` is null. Nothing writes
  ESCALATED any more. The migration sets existing ESCALATED rows to OPEN, and
  the enum value stays, because dropping one is a type rebuild for no gain.
  `escalated_at` is no longer written.
- Outstanding means OPEN. Overdue means outstanding and past `due_at`. The
  dashboard's overdue count (`dashboard.go`, through `v_inspection_task`) then
  counts tasks nobody holds, which today's ESCALATED state hid.
- `app.generate_inspection_tasks` (000012) can still be called by the app
  role, and it reads `vehicle_driver`. Its assignee step changes so that it
  writes each task OPEN with no assignee. The rest of it is TYRE-133's.

### Capture: who may capture, judged over the capture

A user may capture a unit at instant `t` when, at `t`:

- they are the driver of a trip open at `t` whose motive is the unit, or whose
  motive's open rig at `t` holds the unit; or
- they are the live nominee at `t` (rule 2, or rule 3 for a coupled trailer)
  of a task on the unit that is outstanding at `t`, and no trip covers the
  unit at `t`. A nominee of a motive's task may capture that motive and the
  trailers in its open rig at `t`.

One SQL predicate holds this. The capture-vehicle views (`v_capture_vehicle`,
`v_user_capture_vehicle`, 000038) and `v_driver_vehicle` (000003) are rebuilt
on it at now, so `GET /api/my/vehicles`, `GET /api/capture/vehicles/{id}` and
the schedule form's reads change with them. `v_current_assignment` (000015)
is rebuilt on trips or dropped, whichever its readers allow.

**The submit's own-units check reads the capture window, not now** (owner,
20 Oct). Today Go checks, at submit time, that the payload's vehicle and every
reading's vehicle are in `v_capture_vehicle` (`capture.go:364-382`). It skips
the check for tenant-wide roles (`a.Scope() != auth.ScopeTenant`). That
exemption stays in Go, because the Scope table lives in auth and role names
do not belong in SQL (000041's own comment). So CONTROLLER and ORG_ADMIN
still capture any unit, as today. What changes is the question Go asks:

- Go asks a SQL function whether the actor could capture each referenced unit
  at some instant of the judged window (below), which runs from the
  inspection's `started_at` to its `submitted_at`, using the predicate above.
  The rule then has one implementation, in SQL.
- The window is the capture as the phone reports it. A phone a minute slow
  just after a controller started the trip still passes, because the driver
  held the unit before the capture ended.

The ticket's three cases follow:

- A trip closed between start and submit is accepted.
- A task cancelled between start and submit is accepted. The task stays
  cancelled, and the inspection closes no task. Today the close is an UPDATE
  whose WHERE skips a CANCELLED task (000041:554-559), which already gives
  this result. A test pins it.
- A user who could capture the unit at no instant of the window is refused.

**A rig inspection completes its units' due tasks** (U150). The submit keeps
closing the task it names. It also completes, for each unit that carries a
reading in the inspection, every OPEN task due on or before the tenant day of
`submitted_at`, each citing that inspection. A task due on a later day stays
open, a unit with no reading keeps its task, and a cancelled task stays
cancelled. Uncoupled units are inspected separately, each against its own
task. The tasks a rig inspection completes count as completed for criterion
4, under the inspection's driver.

**A resumed draft reads its unit through the same window** (lead departure,
serving U148). `GET /api/capture/vehicles/{id}` takes an optional `startedAt`
from the resumed draft. For an actor who is not tenant-wide, it then admits a
unit the actor could capture at some instant of the submit's window ending
now: from `startedAt`, or the tenant setting before now, whichever is later.
The rig members a resumed rig capture loads take the same parameter. Without
it the read judges at now, and so do `/api/my/vehicles` and the driver's
phone, so a driver with no trip and no nomination still sees no vehicle.

"Outstanding at `t`" needs the instant each task was completed or cancelled.
If the table cannot answer that today, the builder adds what is missing. The
audit log is not a read path.

**The window judged is bounded, and no capture is refused for its length**
(rule 5, U148). Today `started_at` is the phone's value, inserted unchecked
(000041:240). The window that judges the capture runs to `submitted_at`, from
`started_at` or from a tenant setting before `submitted_at`, whichever is
later. The setting is read with `app.config_for`, with a default of 12 hours,
and the builder names it. A `started_at` after `submitted_at`, such as a
phone clock corrected backwards mid-capture, is judged at `submitted_at`. One
SQL function computes the window, and both `app.submit_inspection` and the Go
own-units check read it. A capture longer than the setting is judged on its
last part and accepted when the driver held the unit then. It is never
refused for its length. A driver who held the unit only before that last part
is refused, because they did not hold it at any instant of the judged window.
Under U148 an idle truck's inspection stays with its nominee until it is
done, so the weekly idle-truck case is not this one.

The residual limit: the window is the phone's own account. `submitted_at` is
bounded only on its future side (TYRE-166), because the outbox can deliver
days late, so a phone that stamps both instants in the past is believed. This
follows the owner's 20 Oct answer ("judged by when it was captured"), and
ADR-0009 never refuses an outbox entry for its age. Anchoring the window to
`received_at` would refuse every capture held in the outbox longer than the
window, and a refused capture is lost.

### Trip screens

All of this is concept only; TYRE-443 decides the look (decision 4).

- **A motive's unit screen, on a trip:** the driver, the start instant, who
  started it, the trailers in the motive's open rig now, and End trip.
- **A motive's unit screen, between trips:** a start form. It offers a driver
  picker, listing active users who hold `CaptureInspection` and naming the
  truck of anyone already on a trip. It shows the trailers coupled now, read
  only. It offers the trailers that can be added: free trailers, plus
  trailers coupled elsewhere shown as not selectable, naming their truck.
  Then Start trip. Where the tenant's U148 setting is on and a unit the trip
  would cover has a due inspection outstanding, the form says so before the
  controller taps Start. It names the unit and the due date, and offers the
  nominate action on that task, so the block is never a surprise.
- **A trailer's unit screen:** the motive pulling it and that motive's trip
  driver, or "Free". No trip controls.
- The start, end and nomination controls show only to `ManageAssignments`
  (U2, D8). Every `ViewFleet` reader sees the trip panel.

### Schedule an inspection and the controller's task list

- **Schedule an inspection** takes a due date. On a unit no trip covers, it
  also offers an optional driver to nominate, from the same picker as the
  trip start. On a unit a trip covers, it says who the inspection goes to. The
  "Assign one before scheduling an inspection" message is removed.
  `app.create_inspection_task` loses its assignee argument and the "not
  assigned" refusal, and gains the optional nominee.
- **The controller's task list** (`loadUnitTasks`, `UnitTaskList.tsx`) names
  the responsible driver from the function, marks a nominee as nominated,
  shows "No driver" and "Escalated" in words (NFR-USE-009), and offers a
  nominate action on a task nobody holds.

### The driver's phone

`DriverHome.tsx` shows the truck of the driver's open trip and the trailers in
its open rig now, with their due inspections. A nominee also sees each unit
they are nominated for, with its due inspection. With neither, it reads "You
are not on a trip." (FR-DSH-012 as amended below). A nominee cannot log a
tyre change: FR-FIT-025 is a trip driver's.

### Add a user

The assign step leaves Add a user (`AddDriver.tsx:207-241`). So do the web
call (`api/admin.ts:84-86`) and the route `POST /api/vehicles/{id}/drivers`
(`admin.go:453-534`). No route ends an assignment today, so none is removed.

### `vehicle_driver` becomes history

The table stays, as the record of assignments before trips. Its INSERT,
UPDATE and DELETE are revoked from the app role, so no path writes rows that
nothing reads. The mapping of `vehicle_driver_no_overlap` to
`assignment_overlaps` leaves `refusal.go` and `refusal_codes.json`, and so
does its pin in `TestConflictCodesNameLiveSchemaObjects`.

The migration turns each open row into an open trip:

- A row on a motive becomes a trip that starts at the tenant-local start of
  its `from_date` (rule 6). An inspection already in an outbox then still
  passes the capture-window check.
- A row on a trailer is dropped. The trailer reaches its driver through the
  motive's rig.
- Where rows conflict (two drivers on one motive, or one driver on two
  motives), the newest `from_date` wins, then the lowest id. The rest stay as
  history only. A task whose driver loses a conflict, or reached a trailer
  that now sits in another driver's rig, changes hands at deploy, and that
  driver's queued captures of the unit are refused. Production has no
  tenants and staging holds no real data, so this only decides what the
  migration test asserts. On staging's Demonstration Fleet, for one, HORSE
  goes to the newer row's driver.
- A migrated trip's `started_by` comes from the row's `created_by` where one
  exists. A migrated trip must be identifiable as migrated.

### Seeds and the suite

- `gen_seed_fixture.py` writes trips instead of `vehicle_driver` rows: BAC 4,
  Second Fleet 1 and Sandbox 2 today (`demo_tenant.sql:195` carries BAC's).
  Melusi keeps HORSE and LINK12 on `/api/my/vehicles` (`web/e2e/driver.ts:26-49`),
  through a trip on HORSE whose fixture rig holds LINK12. That rig also holds
  LINK6, so Melusi gains it. Leave the acceptance fixture's rig alone and move
  the pins (suite §15, the e2e) with it.
- The suite sections that pin assignment change with it: 4, 15, 26, 28, 31,
  34, 37, 43, 45, 46 and 58. Section 72's audited-table count rises by the
  trip and nomination tables. New tests go in section 76 and on. The next
  migration is 000060.

## SRS consequences

The SRS pages are too large for the Confluence tools, so every change is a
prepared row in `docs/HANDOFF_srs_errata_TYRE-326_2026-10-22.md` (gitignored)
for a coworker agent to paste. TYRE-326 does not close while the SRS
contradicts it. The rows:

- **Appendix H.3 criterion 4; FR-INS-050.** Attribution by the responsible
  driver, as in decision 2 and `app.task_driver_at`. It replaces "by the
  task's assigned driver" in the TYRE-284 row.
- **FR-INS-053.** The chain gains the nominee between the trip driver and the
  controller, and a trip takes over a nomination.
- **FR-AUT-005.** A nominee sees and may capture the units of the inspection
  they are nominated for, and nothing else, with no tyre change.
- **FR-DSH-012.** A nominee's view shows the units they are nominated for.
- **FR-INS-051.** A controller may nominate a driver for a task on a unit no
  trip covers, then or later.
- **FR-OFF-015.** A submit is judged by who could capture the unit during
  the capture, from its client-side start to its client-side submission. The
  span judged is bounded by a tenant setting, and no capture is refused for
  its length (U148). This needs one more row amending T7.
- **FR-VEH-007; FR-INS-052.** Where the tenant requires it, a trip cannot
  start while a unit it would cover has an inspection due on or before today
  that is not done. A trip under way is not stopped, and there is no
  override. A task past its due date stays open until done and counts as
  missed (U148).
- **FR-INS-052; FR-INS-062.** An inspection covers the configuration as a
  whole: a rig inspection completes the due tasks of every unit it records
  readings for (U150). Row V3.
- **FR-AUT-005, the resumed draft** (lead departure serving U148). A driver
  resuming an inspection in progress may load the units it covers when they
  held them at some instant of its judged span ending now. Row V4.
- **FR-OFF-015 and FR-VEH-007 wording** (U150). In T7, "closes no task"
  becomes "does not close it"; in V2, a blocking task is one "still open",
  so a cancelled task does not block. Row V5.

V1, V2 and V3 went in at versions 17 to 21. V4 and V5 are prepared in
`docs/HANDOFF_srs_errata_TYRE-326_V4_2026-10-22.md`.
- **UC-01 precondition.** The vehicle is assigned for an active trip, or its
  inspection is nominated to the driver.
- **§5.1 trip; FR-VEH-007.** Starting a trip adds free trailers only and never
  ends another motive's rig. `combination_id` is null when the motive tows
  nothing.
- **§5.1 inspection_task_nomination (new).** The nomination entity.
- **Appendix G.2 OI-32.** The idle-truck case is answered by nomination.

## Testing

Business rules are tested in SQL (`db/tests/004_tests.sql`, section 76 on).
Go and web tests cover the transport.

- **Trip start:** opens a trip, and closes the motive's and the driver's open
  trips at the same instant. Adds free trailers through the rig write, in the
  order picked. Refuses a trailer in another motive's open rig, naming that
  motive. Refuses a trailer, retired or inactive motive, and an inactive
  driver. Leaves `combination_id` null for a motive that tows nothing.
- **The U148 gate:** a start is refused, changing nothing, when the motive,
  a member of its open rig or an added trailer has an OPEN task due today or
  earlier, and the refusal names each unit. A task due tomorrow does not
  block. With the tenant setting off, nothing blocks. An open trip is never
  ended by the rule. Due today is judged in the tenant's calendar, with a
  case either side of tenant-local midnight.
- **Trip end:** stamps the end and leaves the rig. Refuses a second end.
- **The EXCLUDEs:** a raw overlapping insert per vehicle and per driver is
  refused.
- **`app.task_driver_at`:** each rule, a trailer through its motive's trip, a
  trailer through its motive's nominee, a nomination lapsed by a later trip
  that stays lapsed after the trip ends, a re-nomination, and nobody.
- **Nominations:** refused while a trip covers the unit, and on a task that is
  not outstanding. The table refuses UPDATE and DELETE.
- **Capture window:** the ticket's three cases, a nominee capturing the
  nominated motive and its coupled trailers, a nominee refused after a trip
  took over, and the judged window: a capture longer than the setting is
  accepted on its last part, and a `started_at` after `submitted_at` is
  judged at `submitted_at`.
- **A rig inspection (U150):**
  - it completes the due tasks of its motive and trailers, after which the
    U148 gate lets the trip start;
  - a task due on a later day stays open, and so does the task of a unit
    with no reading;
  - three uncoupled units each close only their own task.
- **A resumed draft:** with a trip ended ten minutes ago, the context read
  answers 200 for a `startedAt` before the end, and 403 with no `startedAt`
  or with one after the end.
- **Escalation and overdue:** a task nobody holds reads escalated, and a held
  one does not. Overdue counts both.

*Amended by the plan's Decision 17 and the review of PR #148 (TYRE-326): a
generated task with no assignee gains, at the migration, the driver of a
converted trip covering its unit or, for a towed unit, its rig motive's live
nominee. A task whose assignee is a deactivated user gets no nomination of
its own, and is held only through such a trip or motive nominee; otherwise
nobody holds it.*

- **Migration:** open rows become trips, with trailer rows dropped, conflicts
  resolved as above, and assignees copied as nominations. Outside the conflict
  cases, no outstanding task changes responsible driver at the migration
  instant.
- **Depot scope:** a DEPOT_MANAGER is refused a trip start, end, nomination or
  rig write on a motive outside their depots.
- **RLS and grants:** the new tables are isolated per tenant (rule 1), every
  new or rebuilt view has `security_invoker = true`, and `vehicle_driver`'s
  writes are revoked.
- **Go:** the trip, nomination and schedule endpoints, their capability gates,
  and the refusal wording.
- **Web:** the trip panel's two states, the trailer state, the schedule form
  with and without a trip, the task list's words, Add a user with no assign
  step, and DriverHome with a trip, a nomination and neither.
- **e2e:** `web/e2e/driver.ts` keeps Melusi's two units.

## Calls made here

These are my calls; the owner can overturn any of them.

- Trip start auto-closes the motive's and the driver's open trips, as the
  ticket and the FR-VEH-007 erratum say, rather than refusing.
- End trip leaves the rig coupled.
- Trips are allowed on horse, rigid and light units, wherever the rig write
  allows a motive. Retired units are refused, as U9 refuses them for rigs.
- A trip driver, or a nominee, is any active user whose role holds
  `CaptureInspection`. Go checks the capability, and SQL checks active.
- Rule 3: a coupled trailer with no trip falls to the nominee of its motive's
  task.
- Nominations are insert-only history, and the migration copies today's
  assignees into them.
- Escalation is computed, ESCALATED rows become OPEN, and the enum value
  stays.
- The judged window is bounded by a tenant setting, default 12 hours, and the
  phone's clock is believed inside it rather than anchored to `received_at`.
  U148 rules out refusing a capture for its length.
- The U148 gate's fallback is on, with BAC as the evidence. It blocks on
  tasks due today or earlier in the tenant's calendar, across the motive, its
  rig and the added trailers.
- The capture check passes when the actor held the unit at any instant from
  `started_at` to `submitted_at`, not only at `started_at`. It tolerates a
  slow phone clock, and the ticket's three cases still hold.
- Tenant-wide roles stay exempt from the own-units check, in Go, as today.
- The capture context read takes the resumed draft's `startedAt`, judged on
  the submit's window ending now, so U148's "no capture is lost" holds on
  the read side too.
- Trips start and end at the server's now; nothing is back-dated.
- Depot scope is judged by the motive, and the rig routes gain the same lock.
- No nomination withdrawal; `app.task_driver_at` ignores the active flag.
- `vehicle_driver` stays as history with its writes revoked. Open rows become
  trips; trailer rows are dropped; conflicts go to the newest.
- The generator's assignee step changes here, because the app role can call it
  and its source table becomes history.

## Left to the builder

- Names: the trip and nomination write functions, the tables' columns beyond
  the errata's, the tenant setting, and the refusal codes within ADR-0012's
  families. `app.trip`, `app.inspection_task_nomination` and
  `app.task_driver_at` are fixed, because the SRS errata and TYRE-284 cite
  them.
- The endpoints' paths and shapes, following the combinations routes
  (`combinations.go:218-317`).
- Whether `assigned_user_id` and `v_current_assignment` are dropped or kept
  unread.
- How the web fetches the free and coupled trailers for the picker.
