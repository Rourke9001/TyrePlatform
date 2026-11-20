# Design: a driver starts an inspection only from an open task, and a resumed one says so (TYRE-319, TYRE-323)

Ticket TYRE-319, as amended on 20 Oct 2026 under owner ruling U143
(TYRE-440 comments 13870 and 13871) and narrowed by the pilot audit (U147,
comment 13936, items B16 and C6). Its PR carries TYRE-323 (comment 13940,
item B7) and the part of TYRE-390 the amendment left: a way back to an
inspection held on the phone (TYRE-319 comment 13518). The run queue pairs
them (`docs/implementation-order.md`, row 6). The owner's answers of
20 Nov 2026 are under "The owner's answers".

**Requirements touched, none changed:**

- FR-AUT-005 as amended (Part 3 errata, the TYRE-440 row and the two
  TYRE-326 rows): on a vehicle a driver holds, an inspection starts only
  against an open task, the vehicle alone does not open capture, and a
  driver resuming an inspection held on the phone may load its units.
- FR-INS-051, FR-INS-052 and FR-INS-053 as amended: a task comes from a
  schedule or a controller's instruction, one inspection completes every
  due task on the units it reads (U150), and a task goes to the trip driver
  or a nominee.
- FR-OFF-015 as amended: a submit is judged by who held the unit during
  the capture, not at its receipt.
- FR-OFF-006, FR-OFF-013, FR-OFF-014, NFR-USE-011: the held inspection
  survives a restart, a permanent refusal is kept and shown with a recovery
  action, and nothing held is discarded without the driver.
- FR-OFF-011: a replayed submit answers as its first delivery did.
- FR-DSH-012 as amended: the driver's view.
- FR-INS-062, FR-INS-063: the driver confirms what is coupled and may
  untick a unit.
- FR-AUT-008 as amended (the TYRE-76 row): a depot manager's capture is by
  depot scope and is TYRE-76's to build.
- NFR-USE-004, NFR-USE-005, NFR-USE-009, NFR-AVL-002: glove-sized
  controls, plain refusals, no colour alone, and starting needs the server.
- Rule 6 of CLAUDE.md: the start time shows in the tenant's timezone.

**No SRS change is prepared.** The rule is FR-AUT-005's own text since the
TYRE-440 errata. The unit-coverage refusal is U147's B16, and the choice
screen is U147's B7. The carry-on row on "My inspections" adds nothing
FR-DSH-012 rules out.

## Intent

Since U143 a driver may inspect a vehicle only when a task asks for it.
The driver's home already lists tasks alone, but nothing enforces the
rule. `/capture/<unit>` opens the Start screen with no task in the link
(`web/src/routes.tsx:60-76`), and the server accepts a driver's submit
that names no task (`api/internal/httpapi/capture.go:437-471`). So a
bookmark or a typed address still starts an inspection nobody asked for.

Resuming has two defects of its own (TYRE-323). The draft is matched on
its vehicle only (`web/src/capture/useDraftLifecycle.ts:56`), so a link
for a new task on the same unit resumes the old draft and drops the new
task without a word. And nothing says how old the draft is, though it
carries its start time.

Last, an inspection held on the phone can lose its way back. When the
office ends the trip or cancels the task, the task leaves "My
inspections", and the only routes left are an address bar an installed app
does not have, or guessing (`docs/runbooks/provision-a-user.md:219-234`;
TYRE-154's spec accepted this gap until this ticket, U243).

## Goals

1. A driver's capture link opens the form only for an open task of theirs
   on that unit.
2. The server refuses a driver's submit that cites no task, or a task on a
   unit the submit does not cover.
3. A submit whose task closed, or whose trip ended, after the inspection
   started is accepted as it is today.
4. A resumed inspection shows when it was started, in tenant time.
5. A link whose task differs from the held inspection's shows the
   difference and the driver chooses.
6. An inspection held on the phone is one tap from "My inspections" and
   from the sign-out refusal.
7. The task path costs the taps it costs today.

## Non-goals

- A vehicle list or a vehicle search on the driver's home (U143, C6).
- A depot manager's capture path. TYRE-76 builds it, with its own right to
  capture. Until then a depot manager captures only as a driver does,
  through a trip or a nomination, and meets the same rule.
- Any change for a tenant-wide actor (controller, org admin). Their capture
  screen and their submit are untouched.
- Checking that the cited task was open when the inspection started. The
  owner's answer of 20 Oct 2026 has the server refuse "only when the driver
  never held that vehicle at that time" (TYRE-440 comment 13871), and
  `app.actor_could_capture` already judges that.
- The driver's tyre change (FR-FIT-025, TYRE-441).
- Recurring schedules (TYRE-133).
- One table of capture failure words (TYRE-465). The new messages follow
  the tables that exist.
- Migrating task-less work already on a phone. See "Lead's calls", 8.

## Anti-goals

- No reading is taken that the server will then refuse. Every refusal the
  server adds is one the phone's own gate stops before Start.
- No draft and no outbox entry is discarded, re-pointed or hidden without
  the driver's tap (FR-OFF-014).
- No tap, confirmation or wait is added between a task row and the first
  reading.
- No second implementation of who holds a task. The phone reads
  `GET /api/my/tasks`, and the server decides.

## Constraints

- Business rules live in SQL with a test in `db/tests/`; Go keeps
  transport and the scope exemption (CLAUDE.md, Where logic belongs).
- A handler never tests a role name (ADR-0011). "A DRIVER" in the ticket
  is, in code, an actor whose scope is not tenant-wide, the same test the
  own-units check uses (`capture.go:455`). The web reads `me.scope`
  (`web/src/auth/me.ts:16`, U87).
- Starting an inspection needs the server; finishing one never does
  (NFR-AVL-002). The gate may wait on a read before Start. Nothing after
  Start may.
- Modules under `web/src/capture/` and `web/src/driver/` ship in the entry
  and count against its budget (`web/CLAUDE.md`, The design system).
- Dates render through `web/src/time/tenantTime.ts` (rule 6).
- A migration already on `develop` is never edited. The server rule is a
  new pair, `000064`.
- Copy is sentence case with straight quotes, and never says
  "roadworthy".

## Approaches

### Where the server rule lives

1. **A new SQL function the submit handler calls in its scoped branch
   (chosen).** `submitInspection` already calls `app.actor_could_capture`
   for an actor who is not tenant-wide, then `app.submit_inspection`
   (`capture.go:455-470`). The task rule sits beside it: same branch, same
   payload, its own SQLSTATE.
2. Inside `app.submit_inspection`. Rejected. That function serves every
   role and holds no role or scope (`000060:980-982`), and a tenant-wide
   actor submits with no task.
3. In Go. Rejected. Whether a task covers a unit is a rule about tasks and
   units (CLAUDE.md, Where logic belongs).

### What the phone's gate reads

1. **`GET /api/my/tasks`, the list "My inspections" already holds
   (chosen).** Each row is an outstanding task the driver is responsible
   for now, with the unit it is captured through
   (`app.v_my_inspection_task`, `000060:698-720`). Arriving from a task row
   the answer is in the query cache, so the gate adds no wait.
2. A new "may I start" endpoint. Rejected. It would be a second answer to
   the question the list already answers.

### Where the way back sits

The owner chose a row on "My inspections" over the sign-out refusal alone
(20 Nov 2026). The sign-out link is still built, because the ticket's
definition of done names it and the leaver step ends at Sign out.

## The design

### 1. The server: a driver's submit cites a task that covers it

**Migration `000064`.** One new function, `app.submit_cites_task(p_payload
jsonb)`, invoker rights, plpgsql with the search path pinned, written and
granted as `db/CLAUDE.md`, Adding a function, says. It returns nothing and
raises a new SQLSTATE, `TY029`, when the payload fails the rule:

- **A replay passes.** When the bound actor already has a stored inspection
  with the payload's `client_uuid`, the function returns at once, as
  `app.actor_could_capture` does (`000060:770-777`, FR-OFF-011).
- **No task.** `task_id` absent or JSON null raises `TY029` with the
  message `this inspection names no inspection task`.
- **No such task.** A `task_id` that names no task the bound tenant can see
  raises `TY029` with `this inspection names a task that is not in this
  fleet`.
- **A task on a unit the submit does not cover.** FR-INS-052 as amended
  says what a rig inspection covers: its motive and the towed units
  confirmed at its start. In the payload those are its own `vehicle_id`
  and each entry of `observed_member_vehicle_ids`, and with them every unit
  it attributes a reading or an absent spare to (`000060:781-789`). A task
  whose `vehicle_id` is none of them raises `TY029` with `this inspection
  names a task on <fleet number>, which it does not cover`.
- **A covered unit the actor could not capture.** `app.submit_inspection`
  records the observed list and never checks it (`000060:1024-1048`), and
  the own-units check does not read it. So the task's unit must also pass
  `app.user_could_capture` for the bound actor over the payload's capture
  window (`app.capture_window`). One that fails raises the same `TY029`
  message as an uncovered unit, so the answer does not say whether the
  unit exists.
- **A covered unit need not carry a reading.** A driver may submit a
  partial walk-around (`web/src/capture/CaptureReview.tsx:195`), so an
  inspection begun from a trailer's task may read the motive alone. It
  passes. The trailer's task stays open, because the close takes only a
  unit the inspection read (`000060:1312-1317`), as today.
- **Anything else passes**, whatever the task's state. An open task, a
  cancelled one and a completed one all pass. What a passing submit then
  does to the task is `app.submit_inspection`'s, unchanged: it completes an
  open task it read and leaves a closed one as it is (`000060:1312-1317`).

A `task_id` that is not a uuid is left to `app.submit_inspection`'s own
cast, as today.

**The handler.** In `submitInspection`'s scoped branch, after
`app.actor_could_capture` answers true, the handler runs `SELECT
app.submit_cites_task($1::jsonb)`. A payload the actor may not capture
therefore still answers TY007's 422 first. `TY029` joins `submitStatus` as
422 (`api/internal/httpapi/refusal.go:92`) and `refusal_codes.json`. A
tenant-wide actor never reaches the call.

**The order on the wire** for a scoped actor: capability, own-units
(`TY007`), cites a task (`TY029`), then `app.submit_inspection`'s own
refusals.

### 2. The phone's gate on `/capture/<unit>`

For an actor whose `me.scope` is not tenant-wide, `CaptureFlow` decides
what to show from three things: the draft on the phone, the link's
`taskId`, and the driver's tasks (`myTasksQuery`, the read "My
inspections" uses). A tenant-wide actor skips the gate and sees today's
screens.

A link's task is **open for this unit** when the tasks read lists it and
its `captureVehicleId ?? vehicleId` is the route's unit. A task's **own
unit** is its `vehicleId`, which for a coupled trailer is not the route's
unit.

The existing screens for another driver's draft and for a draft on another
vehicle come first, as today. Then:

*20 Nov 2026: TYRE-491 amends row 2 under U245. A link with no task, or with a task not open for this unit, reaches the driver's one open task on the unit, through the motive's address for a coupled trailer, a pick screen when they hold more than one, and "Nothing is due" only when they hold none (docs/superpowers/specs/2026-11-20-capture-link-due-task-and-next-on-empty-design.md, section 1).*

| # | Draft for this unit | The link's task | The driver sees |
|---|---|---|---|
| 1 | none | open for this unit | The Start screen, as today. No new tap. |
| 2 | none | absent, or not open for this unit | No form. "Nothing is due on this vehicle for you. An inspection starts from a task on My inspections." and the "My inspections" link (`BackToWork`). |
| 3 | none | the tasks read failed and holds no copy | No form. The answer `answerOf` gives for the failure (sign in, find signal, try again), with "Reload" and the "My inspections" link. |
| 4 | held | the same as the draft's, or absent | The draft, straight in, with its start line (section 4). No new tap. |
| 5 | held | open for this unit, different from the draft's, and its own unit is one the draft covers | The choice screen (section 3). |
| 6 | held | different from the draft's, and anything else: not open, on a unit the draft does not cover, or the tasks read holds no copy | The draft, straight in, as row 4. The draft keeps its own task. |

Notes on the table:

- While the tasks read is pending with no copy, rows 1 to 3 and 5 to 6
  show "Loading…". Row 4 never waits on it: a resume whose task matches
  must work with no signal.
- A held draft never waits on a read that cannot answer. With a draft
  held and no copy of the tasks, a read that is paused for want of signal,
  or that has failed once, counts as "holds no copy", which is row 6. The
  query's own retries would otherwise hold the inspection behind
  "Loading…" for as long as the phone has no signal (`web/src/main.tsx:29`;
  NFR-AVL-002). From the plan's red team, round 1.
- A copy of the tasks kept through a failed refresh is used as it stands.
  The server is the control (section 1); the gate is there so a driver is
  not led into work the server will refuse.
- Row 6 keeps a held inspection reachable when its task has closed, which
  is how the carry-on row and the sign-out link arrive. It resolves nothing
  the driver could choose: the link's task cannot be carried by this draft,
  and it stays on "My inspections".
- "The draft covers" a unit when the unit is in the draft's
  `observedMemberVehicleIds`, or is the draft's `vehicleId`.
- The "another vehicle" screen's "Go to it" link gains the held draft's
  `taskId` when it has one.

**Which task an inspection cites, at Start (the owner's answer 3).** The
task goes into the draft when the driver taps Start, from the units ticked
then:

1. The link's task, when its own unit is ticked.
2. Otherwise the driver's open task with the earliest `dueAt` whose own
   unit is ticked and whose `captureVehicleId ?? vehicleId` is this
   route's unit.
3. Otherwise there is nothing to file the inspection against. Start is not
   offered. In its place: "This inspection is for <fleet number>. Tick it
   to inspect it, or tell your fleet office it is not attached." The
   fleet number is the link's task's own unit.

The motive is always ticked, so case 3 arises only when the link's task is
a towed unit's, the driver unticks it, and nothing else ticked has a task.
Ticking the unit again restores Start.

### 3. The choice screen (TYRE-323, B7)

Shown for row 5. One screen, no modal:

- An alert: "You have an inspection of <fleet number> in progress on this
  phone, started <start>. The task you opened is a different one."
  `<start>` is the draft's `startedAt` through `useTenantInstant`.
  `<fleet number>` is the draft's.
- **"Carry on for this task"**, the primary control at the glove size. One
  tap writes the link's `taskId` into the draft, then resumes it as row 4.
  The readings are untouched.
- **"Start again"**, through `ConfirmDiscard` with the words
  `draftLostWords` gives today. On confirm the draft is discarded and the
  Start screen for the link's task shows.
- The "My inspections" link.

Nothing is written until the driver taps. Leaving the screen leaves the
draft as it was.

Re-pointing is a new function in `draft.ts` beside `saveHeader`. The draft
is one JSON row under no schema (`draft.ts:112-135`), so no Dexie version
changes.

### 4. The start line on a resumed inspection

A draft loaded from the phone, rows 4 to 6 and after "Carry on for this
task", shows one line under the fleet number on the walk-around screen and
on the review screen: "Started <start>", through `useTenantInstant`. An
inspection begun by the Start tap in this visit shows no such line (the
owner's answer 2). The line is text, costs no tap and holds no control.

`useDraftLifecycle` already holds the resumed draft's start
(`resumedStartedAt`), set on a resume and never by a Start
(`useDraftLifecycle.ts:31-34`).

### 5. The carry-on row on "My inspections" (the owner's answer 1)

When the phone holds a draft the signed-in driver may carry (`mayCarry`),
"My inspections" shows one row above every task: "Carry on with <fleet
number>, started <start>". It links to
`/capture/<draft.vehicleId>?taskId=<draft.taskId>`, with no `taskId` when
the draft has none. A draft with no stored fleet number reads "Carry on
with your inspection, started <start>".

- The row is a `ListRow` link at the size of a task row.
- It reads the draft store once per visit, as `InstallHint` reads held
  work (`web/src/driver/InstallHint.tsx`). A failed read shows no row and
  no error: the task rows still resume a draft for their own unit.
- Another driver's draft shows no row. The capture route already says who
  must finish it.
- The row does not wait on the tasks or trip reads. The task rows wait on
  the draft read, so the row never moves a task after the list has
  painted. That read is local to the phone and the capture route already
  waits on it before it shows anything (`CaptureFlow.tsx:333`). A draft
  read that fails shows the tasks without the row (Lead's calls, 14).

`readHeldWork` gains what the row and the sign-out link need about the
draft: its vehicle, task, fleet number, start and stamp. `HeldWork.draft`
stays a boolean for its present callers, or becomes the summary with them
updated; the builder picks.

### 6. The sign-out refusal links to the held inspection

When the refusal reports a draft (`stillHeld`, `SignOutButton.tsx:12-23`),
a link follows the message: "Go to it", to the same address as the
carry-on row. The words of the refusal do not change. The link is a plain
anchor, as `BackToWork` is, and sits outside the live region so the
refusal is announced once.

### 7. The refusal's words on the phone

A queued inspection the server refuses with `TY029` becomes "needs the
office", as any permanent 422 does (`outbox.ts:82-103`). The done screen
and the outbox band say, for that code: "This inspection is not filed
against one of your tasks, so the office could not accept it. Your
readings are saved. Call the tyre office." It sits beside TY003's sentence
in `CaptureDone.tsx` and wherever the outbox band words a failed entry.

The gate keeps a current phone from ever queueing such a submit. The words
are for work queued before this ships and for a phone on an old copy of
the app.

### 8. Docs and comments

- `docs/runbooks/provision-a-user.md`, A leaver, "An inspection in
  progress": the way in becomes the "Carry on with <fleet number>" row on
  "My inspections", and the "Go to it" link in the sign-out refusal. The
  capture-address fallback, the home-screen sentence and the "TYRE-390
  adds a way back" sentence go.
- `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md:1056` gets an
  italic rider above the paragraph that names TYRE-390 as still to come.
  The body is not rewritten.
- `web/CLAUDE.md`, The network: one sentence that a scoped actor's capture
  opens only from an open task, and that "My inspections" and the sign-out
  refusal link to a held inspection.
- `docs/architecture.md`, Capture and the network, gains the task check
  beside the own-units paragraph (`docs/architecture.md:265`), in the order
  section 1 gives.
- `routes.tsx:60-62` says an inspection "can be started off a task or off
  the vehicle alone", and `DriverHome.tsx:65-66` says a capture without a
  task "is TYRE-319's question". Both become true statements of the rule.
- Each new comment cites its requirement or ruling, one constraint each
  (`docs/comments.md`).

## Testing

**SQL (`db/tests/004_tests.sql`, a new section).** As `app_login` with a
scoped driver bound, against planted tasks:

- no `task_id`, and a null one: `TY029`;
- a `task_id` unknown to the tenant, and another tenant's task: `TY029`;
- a task on a unit the payload does not cover: `TY029`, the message naming
  the fleet number;
- a task on a unit the payload lists as attached but the actor could not
  capture in the window: `TY029`, the same message;
- a task on the payload's own unit, one on a towed unit the payload
  reads, and one on a towed unit it lists as attached and does not read:
  pass, and after the submit the unread unit's task is still open;
- a task cancelled, and one completed, before the call: pass, and
  `app.submit_inspection` then stores the inspection and leaves that task
  as it was (TYRE-323's "established and pinned");
- a replay of the actor's own stored capture, with the task key removed:
  pass.

The function's shape goes on whichever suite lists pin a new plpgsql
function (checks 8c and 8d).

**Go (`api/internal/httpapi`).** Through the real handler and database:

- a driver's submit with no task answers 422 `TY029`;
- a driver's submit citing a task on an uncovered unit answers 422
  `TY029`;
- a driver's submit citing a task cancelled after `started_at` answers
  201, and the task is still cancelled;
- a controller's submit with no task still answers 201;
- a driver's submit for a unit they do not hold still answers `TY007`,
  whatever its task.

Existing driver submits in the Go tests gain a task.

**Web unit tests (vitest).**

- The gate: one case per row of the table in section 2, plus the pending
  read, plus a tenant-wide actor seeing Start with no task.
- The cited task at Start: the three cases, and ticking the unit again.
- The choice screen: "Carry on for this task" writes the task and keeps
  every reading; "Start again" discards only after the confirm; leaving
  writes nothing.
- The start line: present on a resumed draft on both screens, in the
  tenant's timezone with a tenant whose offset differs from the test
  runner's; absent after a fresh Start.
- The carry-on row: shown for the driver's own draft, hidden for another
  driver's and on a failed read, its address with and without a task.
- The sign-out refusal: the link's address, and none when only outbox
  entries are held.
- The done screen's and the band's words for `TY029`.

**e2e (Playwright).**

- A driver with no task opens `/capture/<their unit>`: no Start control,
  the "Nothing is due" words, and the link back.
- A driver with a task starts from "My inspections", completes and
  submits, on the `android` project where `capture.spec.ts` already
  submits.
- A held draft shows the carry-on row, and the row opens it.

Every existing spec that opens `/capture/<unit>` as a driver with no task
(`captureSteps.ts:23` and its callers, `reach`, `sheetFit`, `rigs`,
`admin`, `auth`, `installHint`) gets a task first, or opens through one.
The builder decides between a seeded task and one made through the API in
the spec's setup; no test may derive a tenant date from the browser clock
(`docs/lessons.md`, 2026-09-03).

**Design check.** `web-design-guidelines` over the changed UI files before
the PR, and the new states in `/dev/design` where a gallery section fits.

## Definition of done

1. A scoped actor opening `/capture/<unit>` with no task, or with a task
   not open for that unit, and no draft, sees no capture form and a link
   to "My inspections".
2. The server answers 422 `TY029` to a scoped actor's submit that cites no
   task, an unknown task, or a task on a unit the submit does not cover.
   SQL and Go tests pin each.
3. A submit whose task was cancelled or completed, or whose trip ended,
   after the inspection started is accepted, pinned by a test. Nothing in
   the outbox is discarded.
4. A resumed inspection shows "Started <start>" in tenant time. A fresh
   one does not.
5. A link whose open task differs from the held draft's shows the choice
   screen. Nothing changes until the driver taps.
6. A resume whose task matches costs no tap, and neither does the task
   path from "My inspections" to the first reading.
7. "My inspections" shows the carry-on row for a held draft, and the
   sign-out refusal links to it. The runbook's leaver step names both.
8. Unticking the task's unit at Start follows the three cases in
   section 2.
9. The e2e cases above pass.
10. The capture bundle stays under its ceilings, or the PR names the
    import that grew it and the ceiling is raised by hand with its reason
    (U200).
11. `make check` is green.

## The owner's answers (20 Nov 2026)

| Question | Answer |
|---|---|
| The way back to a held inspection whose task has left the list | A carry-on row on "My inspections", and the sign-out link |
| Where a resumed inspection shows its start time | One line on the walk-around and review screens, on a resumed inspection only |
| The driver unticks the unit the task is for | The inspection goes ahead only against another open task on a ticked unit; otherwise Start is not offered and the screen says to tell the fleet office |
| The spec, with the lead's calls | Approved, 20 Nov 2026 (U244) |

Earlier rulings this design applies: U143 and TYRE-440 comment 13871 (the
rule, and a late submit is accepted), U147 items B7, B16 and C6, U150 (one
inspection completes every due task it reads), U148 (no capture is lost),
U104 and U108 (the driver stamp and the sign-out refusal).

## Lead's calls

| # | Question | Choice | Source |
|---|---|---|---|
| 1 | Who "a DRIVER" is in code | An actor whose scope is not tenant-wide, on the server and in the web | `api/internal/httpapi/capture.go:455`; ADR-0011; `web/src/auth/me.ts:16` |
| 2 | A depot manager | Bound like a driver until TYRE-76 gives depot capture its own right | SRS FR-AUT-008 errata row (TYRE-76); `api/internal/auth/auth.go:99-102` |
| 3 | Where the rule lives | A new invoker function called from the handler's scoped branch | CLAUDE.md, Where logic belongs; `db/migrations/000060_per_trip_assignment.up.sql:762,980-982` |
| 4 | The refusal's code and status | New SQLSTATE `TY029`, 422, permanent for the outbox | `api/internal/httpapi/refusal.go:92-134`; `web/src/capture/outbox.ts:82-103` |
| 5 | Which units a submit covers | Its own unit, the units confirmed attached at Start and any unit it attributes a reading to, each one the actor could capture during the capture. A reading on the task's unit is not required | SRS FR-INS-052 errata row (U150): "A rig inspection covers its motive and the towed units confirmed at its start"; `000060:656-665,781-789,1024-1048`; `CaptureReview.tsx:195` |
| 6 | A task closed before the inspection started | Accepted | TYRE-440 comment 13871: the server refuses "only when the driver never held that vehicle at that time" |
| 7 | A task id that names nothing in the fleet | Refused. The app role cannot delete a task, so the app never issued such an id in that fleet | `db/migrations/000018_delete_revoke_dr014a.up.sql:73` |
| 8 | Task-less work already on a phone when this ships | No migration. A draft is re-pointed by opening a task for its unit; a queued one is refused and reads "needs the office". Only staging phones hold any, since the pilot has not begun | `docs/implementation-order.md:3-14`; section 3 |
| 9 | What the gate reads | `GET /api/my/tasks`, no new endpoint | `web/src/driver/driver.data.ts:33-36`; `000060:698-720` |
| 10 | A replayed submit | Passes the task check | FR-OFF-011; `000060:770-777` |
| 11 | A mismatch the phone cannot verify, or cannot carry | The draft resumes with its own task | NFR-AVL-002; U150 completes every due task the inspection reads, so the link's task is not lost |
| 12 | An ADR | None. The rule follows the own-units check's pattern, and nothing new is decided about tenancy, storage or transport | `docs/adr/0006`, `0011`, `0012` |
| 13 | One inspection cites one task, so a second open task on the same unit due on a later day stays open after the submit | Accepted, and unchanged by this design. U150 sets which tasks an inspection completes, and B7 gives the driver the choice of which one to carry | SRS FR-INS-052 errata row (U150); TYRE-323 comment 13940; `000060:1326-1333` |
| 14 | Whether "My inspections" waits on the draft read | The task rows wait on it. It is a local read, a reserved slot would leave a gap or shift the list, and the capture route waits on the same read. A failed read shows the tasks alone. From the plan's red team, round 1 | `web/src/capture/CaptureFlow.tsx:333`; `web/src/capture/useDraftLifecycle.ts:47-84` |

## Left to the builder

- The function's exact name and the wording of its three messages, within
  the meanings in section 1.
- How `HeldWork` carries the draft's summary.
- The components' names and files, and whether the gate is a hook beside
  `useDraftLifecycle` or part of it.
- Which fixture gives each e2e driver a task.
- The class names and spacing of the new lines and rows, from the tokens.

## Sources

1. Jira: TYRE-319 (description, comments 13518, 13936, 14253), TYRE-323
   (description, comments 13769, 13940), TYRE-440 (comments 13870, 13871),
   TYRE-154 comment 14327 (U243).
2. SRS in Confluence, read 20 Nov 2026: Part 2 (page 10846209, v10),
   Part 3 with the errata table (10878977, v25), Part 4 (10911745, v11),
   Part 5 (10944514, v5). Project brief (10321923, v2).
3. `db/migrations/000060_per_trip_assignment.up.sql`: the task views
   (608-720), the capture predicate (637-665), the own-units check
   (762-805), the task close in `app.submit_inspection` (1303-1335).
4. `api/internal/httpapi/capture.go:405-480`, `refusal.go:92-134`,
   `api/internal/auth/auth.go:66-101`.
5. `web/src/capture/CaptureFlow.tsx`, `useDraftLifecycle.ts`, `draft.ts`,
   `outbox.ts`, `CaptureStart.tsx`, `CaptureDone.tsx`;
   `web/src/driver/DriverHome.tsx`, `driver.data.ts`, `driver.view.ts`;
   `web/src/auth/SignOutButton.tsx`; `web/src/routes.tsx:57-76`.
6. `docs/runbooks/provision-a-user.md:209-266`.
7. `docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md` and
   `2026-11-19-web-app-manifest-ios-install-hint-design.md:81-86`.
