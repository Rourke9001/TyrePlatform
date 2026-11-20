# Design: a capture link with no task finds the driver's due task, and Next stays on an empty box (TYRE-491)

Ticket TYRE-491, raised by the staging walk-through of TYRE-319 on
20 Nov 2026 (TYRE-319 comment 14341). It carries three defects. This design
builds two of them and records the owner's deferral of the third. Owner
ruling U245 (TYRE-491 comment 14344) amends row 2 of the gate table in
`docs/superpowers/specs/2026-11-20-task-only-capture-start-and-resume-design.md`
(approved as U244), called "the TYRE-319 spec" below. The owner's answers of
20 Nov 2026 are under "The owner's answers" (U246).

**Requirements touched, none changed:**

- FR-AUT-005 as amended (Part 3 errata, the TYRE-440 row): on a vehicle a
  driver holds, an inspection starts only against an open task for it, and
  the vehicle alone does not open capture.
- FR-INS-048 and FR-DSH-012 as amended: a driver is shown the inspection
  tasks assigned to them and their due dates.
- FR-INS-052 as amended (U150): one inspection completes every open task
  due on the units it reads, and each of those tasks cites it.
- NFR-USE-001 and NFR-USE-001a: the capture targets. NFR-USE-004,
  NFR-USE-005, NFR-USE-009: glove-sized controls, plain words, no colour
  alone.
- NFR-AVL-002: starting an inspection needs the server.
- FR-INS-003 and FR-AUD-010: the application version on every inspection.
  Not built here (the owner's answer 3).

**No SRS change is prepared.** FR-AUT-005's amended text rules on what a
driver may do, which is start an inspection against an open task. It does
not rule on the shape of the link. After this design a capture still opens
only against an open task of the driver's, and with no such task the
vehicle alone still opens nothing. The phone finds the task when the link
does not name it (Lead's calls, 1).

## Intent

**The link.** TYRE-319 made `/capture/<unit>` open only from a task. A link
that names no task shows "Nothing is due on this vehicle for you" without
looking at the driver's tasks (`web/src/capture/taskGate.ts:63`), even when
a task is due on that unit. Such a link comes from a bookmark, the browser's
history, a Home Screen shortcut, a link the office sends, or an install from
before TYRE-319. The owner ruled that a driver with a task due must be able
to see it and start it (U245).

**The Next key.** When a tread digit settles its box, the keypad moves to
the next box by itself after 200 ms (`web/src/capture/PositionSheet.tsx:24`,
`:211-221`). A Next tapped by habit after that moves on again and leaves the
box empty, because Next always moves one box on from a tread
(`web/src/capture/entry.ts:93-110`). Nothing is lost, since the pressure
box's Next returns to the first empty reading, but a gloved driver loses
taps and sees a box jump.

## Goals

1. A driver who opens a capture link with no task, on a unit where they
   hold exactly one open task, reaches that task's Start screen with no
   extra tap.
2. With more than one such task the driver sees them and picks one.
3. "Nothing is due" shows only when the driver's tasks list none for that
   unit.
4. Every inspection a driver starts still cites a task, and the server's
   `TY029` refusal is unchanged.
5. Next on an empty box does not leave it, and the box shows that it still
   needs a reading.
6. The task path from "My inspections" to the first reading, and a normal
   position's entry, cost the taps they cost today.

## Non-goals

- The application version (the ticket's part 2). Deferred to after the POC
  by the owner's answer 3. Inspections keep recording `0.0.0`.
- Replacing the 200 ms hold. TYRE-464 does that under U178. This design
  touches neither the timer nor the reach-back.
- Any change to rows 4 to 6 of the TYRE-319 spec's table: a held draft
  resumes or offers the choice exactly as today.
- Any change on the server, to `GET /api/my/tasks`, or for a tenant-wide
  actor.
- A vehicle list or search on the driver's home (U143).

## Anti-goals

- No capture opens without an open task of the driver's (FR-AUT-005).
- No second answer to "what is due for this driver". The pick screen and
  the gate read the list "My inspections" reads.
- No timer decides what a key does. The Next rule reads what is in the
  box, never how long ago the keypad moved (U178).
- No tap is added where one task is due, or anywhere in a position's
  normal entry.

## Constraints

- Modules under `web/src/capture/` and `web/src/driver/` ship in the entry
  and count against its budget (`web/CLAUDE.md`, The design system; U200).
- Colours and motion come from `web/src/theme/tokens.ts` and the Tread
  system (ADR-0015, ADR-0020). `web/src/theme/captureContrast.test.ts`
  refuses a colour inside an animation step, so a colour change is a state
  style, never a keyframe.
- `web/src/ui/base.css:24-31` cuts every animation to nothing under
  `prefers-reduced-motion: reduce`, so nothing may be said by motion alone.
- Copy is sentence case with straight quotes, and never says "roadworthy".
- Dates render through `web/src/time/tenantTime.ts` (rule 6).
- A dated spec is a record. The TYRE-319 spec gets a rider and its body is
  not rewritten.

## Approaches

### What a link with no task does

1. **The gate reads the driver's tasks for that unit and acts on the count
   (chosen).** None is "Nothing is due", one is the Start screen, more than
   one is a pick screen (the owner's answer 1).
2. Redirect to "My inspections". Rejected by U245's intent: the driver
   asked for this vehicle and a task is due on it.
3. Always start against the earliest-due task. Rejected by the owner's
   answer 1 for the case of more than one task.

### How the pick screen hands over the choice

1. **Each row is a link to `/capture/<unit>?taskId=<id>` (chosen).** That
   is the address a "My inspections" row already uses
   (`web/src/driver/DriverHome.tsx:171`), so the choice arrives as row 1 of
   the TYRE-319 table and the gate holds no new state. Back returns to the
   pick screen.
2. Hold the choice in component state. Rejected: a reload would lose it,
   and the gate would need a second source for the link's task.

### What Next does on an empty box

1. **It stays, and the box is marked (chosen, the owner's answer 2).** The
   rule reads the box's value, so it does not depend on the 200 ms hold and
   stays true after TYRE-464.
2. Swallow a Next that arrives within some time of an auto-advance.
   Rejected: one key would again mean two things by a timer, the mechanism
   U178 replaces.
3. Leave it to TYRE-464. Rejected by the owner's answer 2.

## The design

### 1. The gate on a link with no task

This amends row 2 of the TYRE-319 spec's section 2 table, and only the rows
with no draft. The screens for another driver's draft and for a draft on
another vehicle still come first.

A task's **capture unit** is its `captureVehicleId ?? vehicleId`: a
coupled trailer's task is captured through its motive, so the rig is
inspected whole (`web/src/capture/taskGate.ts:21-33`;
`db/migrations/000060_per_trip_assignment.up.sql:698-720`). A task is
**open for this unit** when the tasks read lists it and its capture unit
is the route's unit. The link's task is **usable** when it is open for
this unit.

The **unit's tasks** are every task the read lists whose capture unit, or
whose own `vehicleId`, is the route's unit. The second half is the coupled
trailer's own address: `/capture/<trailer>` opens no form, because the
trailer is captured through its motive, but the driver does hold a task
due on that trailer, and U245 has them led to it.

With no draft for this unit:

| # | The link's task | The unit's tasks | The driver sees |
|---|---|---|---|
| 1 | usable | any | The Start screen for the link's task, as today. |
| 2a | absent, or not usable | exactly one, open for this unit | The Start screen for that task, as row 1. No new tap. |
| 2d | absent, or not usable | exactly one, captured through another unit | The route replaces its address with that task's own, `/capture/<its capture unit>?taskId=<its id>`, which is row 1 there. No new tap. |
| 2b | absent, or not usable | more than one | The pick screen (section 2). |
| 2c | absent, or not usable | none | "Nothing is due on this vehicle for you. An inspection starts from a task on My inspections." and the "My inspections" link, as today. |
| 3 | any | the tasks read failed and holds no copy | The failure screen of the TYRE-319 spec's row 3, unchanged. |

Notes:

- A link with no task now waits on the tasks read, as a link with a task
  does: "Loading…" while it is pending with no copy. Starting needs the
  server (NFR-AVL-002), and the read is in the query cache when the driver
  comes from "My inspections".
- A link whose task is listed nowhere, or is captured through another
  unit, is treated as a link with no task. The ticket's definition of done
  has "Nothing is due" show only when nothing is due for this driver on
  that unit (U245). So `/capture/<trailer>?taskId=<that trailer's task>`,
  which shows "Nothing is due" today, becomes row 2d and lands on the
  motive's Start screen for that task.
- Row 2d replaces the history entry, so Back does not return to an
  address that only sends the driver forward again. The motive's route
  then applies its own gate, its drafts included.
- In row 2a the one task **stands in for the link's task** everywhere the
  Start screen reads the link's task: the task cited at Start
  (`citedTask`, the TYRE-319 spec's "Which task an inspection cites") and
  the fleet number in "This inspection is for <fleet number>. Tick it to
  inspect it, or tell your fleet office it is not attached."
  (`web/src/capture/CaptureFlow.tsx:284-288`). So a lone task on a towed
  unit that the driver unticks blocks Start with that unit's number, as a
  link naming it would.
- The address is not rewritten in row 2a. The task goes into the draft at
  Start (`CaptureFlow.tsx:299-306`), and a held draft on a link with no
  task resumes straight in (the TYRE-319 spec's row 4).
- A copy of the tasks kept through a failed refresh is used as it stands,
  as in the TYRE-319 spec.
- Rows 4 to 6 (a held draft) are unchanged. A discard that leaves no draft
  falls to the rows above.

### 2. The pick screen

Shown for row 2b. One screen, no modal:

- A sentence: "More than one inspection is due on this vehicle. Choose the
  one to start."
- One row per task of the unit, earliest `dueAt` first, ties in the list's
  order. Each row reads as a "My inspections" task row reads: "<fleet
  number>, due <date>", with " (overdue)" in words when the task is overdue
  (`DriverHome.tsx:168-177`; NFR-USE-009). The date goes through
  `useTenantDate`.
- Each row is a link, at a task row's size, to the task's own address,
  `/capture/<its capture unit>?taskId=<task id>`, as on "My inspections".
  For a task open for this unit that is this route with the task named.
- The "My inspections" link (`BackToWork`).

One component renders a task row for both lists, so their words and their
address cannot drift. Nothing is written until a row is tapped, and the tap
only navigates.

On a rig the list can hold a task per unit, the motive's and each towed
unit's, all captured through the motive. Every row opens the same rig's
Start screen and differs only in the task the inspection cites. The submit
then completes the cited task whatever its due date, and every open task
due by the tenant's today on the units it reads (U150;
`000060:1312-1333`). So on a trip where each unit has a task due today,
the pick changes nothing the driver can see and costs one tap, on a link
with no task only. The owner's answer 1 was given with this example in the
question, and the approval message names it again.

### 3. Next on an empty box

**The rule, in `entry.ts`.** A `next` key stays where it is when the
focused box is empty and Next has no reading to send the driver to:

- on a tread box whose value is null, always;
- on the pressure box when it is null and every tread is filled. With a
  tread still empty the pressure box's Next goes to it, as today
  (`entry.ts:94-98`).

A stay changes nothing in the entry state, `advancedFrom` and `touched`
included, so a half pressed afterwards still reaches the reading the keypad
left (U160). Next from a box that holds a value moves exactly as today. So
after an auto-advance, a Next by habit lands nowhere new: the driver is on
the box the keypad moved to, and it is still focused.

**The cue, in `PositionSheet` and `TreadReadings` (the owner's answer 2).**
When a Next stays:

- The focused box takes a **needs-a-reading mark**: its ring in the
  critical colour, drawn so it differs from the focused ring in more than
  hue (weight or style), since colour alone may not carry it (NFR-USE-009).
  The mark is a state style. It holds until the driver's next key or tap on
  the sheet, then clears. No timer in code clears it.
- The box **shakes once**, a short sideways movement on `transform` only.
  Each further Next that stays plays it again. Under
  `prefers-reduced-motion: reduce` there is no shake and the mark alone
  shows.
- A live region that takes no layout space says once per stay which box is
  empty, in the box's own name: "Tread reading 2 of 3 is empty." or
  "Pressure is empty."

The cue moves no focus, opens nothing and adds no control. It is on the box
and not the whole screen, so the keypad does not move under the thumb. The
sheet's size does not change, so `sheetFit.spec.ts` holds.

`TreadReadings` is a Tread component, so the mark is a prop of it and gets
a state in `/dev/design` (`web/src/ui/gallery/tyres.gallery.tsx`), in both
columns.

**Tests that pin the old behaviour.** `entry.test.ts:105` moves from empty
box to empty box with Next. The owner's answer 2 reverses exactly that, so
the test is rewritten to type a value before each Next, and a new test pins
the stay. Any other test or e2e step that presses Next on an empty box is
changed the same way and named in the PR's Decisions.

### 4. The application version (deferred)

Nothing is built. `web/vite.config.ts:52` keeps stamping the package
version. The ticket's definition-of-done line for it is withdrawn by the
owner's answer 3, recorded on the ticket as U246, and the PR lists it under
"Set aside".

### 5. Docs and comments

- The TYRE-319 spec gets an italic rider directly above the section 2
  table, dated 20 Nov 2026, saying that TYRE-491 amends row 2 under U245
  and naming this file. A rider cannot sit between two rows of a table, so
  it sits above the table and names the row. The body is not rewritten.
- Every comment and test name the change makes false is corrected, such as
  `taskGate.ts`'s "The rows of the TYRE-319 spec's section 2 table" and the
  test named "row 2: no link task is nothing due, without waiting on the
  read". Each new comment cites its requirement or ruling, one constraint
  each (`docs/comments.md`).
- `web/CLAUDE.md`, The network, stays true as written. The builder adds a
  clause only if a sentence there has become false.

## Testing

**Web unit tests (vitest).**

- The gate: one case per row of the table in section 1, a pending read on
  a link with no task, a link whose task is not usable with one and with
  several tasks for the unit, a coupled trailer's address with one task
  (row 2d, with and without that task named in the link) and with
  several, a task on an unrelated unit not counting, and a tenant-wide
  actor seeing Start with no task.
- Row 2d in the route: the address is replaced, not pushed, and the
  motive's Start screen shows for that task.
- Row 2a end to end in `CaptureFlow`: a link with no task and one task
  shows Start with no other control to tap, Start writes that task's id
  into the draft, and the queued payload carries it as `task_id`.
- Row 2a with the lone task on a towed unit: unticking it blocks Start with
  that unit's fleet number, and ticking it again restores Start.
- The pick screen: the rows' order, words and addresses, the overdue words,
  the date in a tenant timezone that differs from the test runner's, and
  the "My inspections" link.
- The Next rule in `entry.test.ts`: a stay on an empty tread, a stay on an
  empty pressure with every tread filled, pressure's Next still going to an
  empty tread, a stay leaving the state unchanged so a later half reaches
  back, and Next from a filled box moving as before.
- The cue in `PositionSheet.test.tsx`: the ticket's sequence (a settling 8,
  the auto-advance, then Next) leaves the second box focused and empty with
  the mark and the announcement, the third box untouched, and the mark gone
  after the next digit.

**e2e (Playwright).**

- A driver with one open task on a unit opens `/capture/<unit>` with no
  task: the Start control shows, and the submit is accepted and completes
  the task.
- A driver with two open tasks on a unit opens the same link: the pick
  screen shows both, and a row leads to Start.
- A driver with no open task on a unit still sees "Nothing is due". The
  existing case uses BAC's HORSE (`web/e2e/capture.spec.ts:44-58`), which
  carries a standing task since TYRE-319 (`bacTasks.setup.ts`), so it moves
  to a unit the driver holds with no open task.
- From the ticket, not seen in the walk-through: on the `android` and `ios`
  projects, the choice screen ("Carry on for this task", "Start again")
  shows both controls inside the viewport at thumb size.
- Also from the ticket: the sign-out refusal shows "Go to it" and "Sign
  out" inside the viewport without overlap at phone width. It runs in the
  `auth` project (Pixel 7), the only one with a signed-in bearer session,
  which the Sign out button needs to render at all
  (`web/src/auth/SignOutButton.tsx:39`; `web/playwright.config.ts:82-84`).

No e2e case may depend on how many tasks another spec has left on a unit:
each plants or picks the tasks it counts, and none derives a tenant date
from the browser clock (`docs/lessons.md`, 2026-09-03). No case submits a
capture that cites BAC's standing task on HORSE, since a cited task closes
whatever its due date and every later BAC case opens through it. The "no
open task" case must not use a coupled trailer's address, which is row 2d
or 2b whenever a task is due on that trailer.

**Design check.** `web-design-guidelines` over the changed UI files before
the PR, and the new mark in `/dev/design`.

## Definition of done

1. A scoped actor opening `/capture/<unit>` with no task, or with a task
   that is not usable, and no draft, reaches the Start screen of their one
   open task on that unit with no extra tap, through the motive's address
   when the unit is a coupled trailer, the pick screen when they hold more
   than one, and "Nothing is due" only when they hold none.
2. The inspection started that way cites its task, and a submit that cites
   none still answers `TY029`. No server file changes.
3. The TYRE-319 spec carries the dated rider above its section 2 table.
4. Next on an empty tread box, and on an empty pressure box with every
   tread filled, stays. The box shows the mark, shakes once unless reduced
   motion is set, and is announced. Tests pin each.
5. A normal position costs the taps it costs today.
6. The e2e cases above pass.
7. The capture bundle stays under its ceilings, or the PR names the import
   that grew it and the ceiling is raised by hand with its reason (U200).
8. `make check` is green.

## The owner's answers (20 Nov 2026, U246)

| # | Question | Answer |
|---|---|---|
| 1 | A link with no task, and more than one open task on the unit | "Show the tasks to pick from" |
| 2 | Next after an auto-advance | Next stays on an empty box, and "can we not have like a screen shake or flash a red around the empty box to show that like, hey this box is still empty you should input something" |
| 3 | The application version | "defer to post POC, i dont think this is important at this point, we still refeining it and will refine it during the POC so i dont think this matters right now" |

Earlier rulings this design applies: U245 (a driver with a task due can see
it and start it), U244 (the TYRE-319 spec), U143 and U147 (the task rule),
U150 (one inspection completes every due task it reads), U160 (the half's
reach-back), U178 (no key decided by a timer), U200 (bundle ceilings).

## Lead's calls

| # | Question | Choice | Source |
|---|---|---|---|
| 1 | Whether U245 changes FR-AUT-005 | No erratum. The amended text has a driver "start an inspection against an open task for it" and says "The vehicle alone does not open capture". Capture still opens only against an open task, and the vehicle alone still opens nothing | SRS Part 3 (10878977, v25), errata table, FR-AUT-005, the TYRE-440 row |
| 2 | A link whose task is not open for this unit | Treated as a link with no task | TYRE-491, definition of done, first item (U245) |
| 3 | A link with no task while the tasks read is pending | It waits, as a link with a task does | NFR-AVL-002; `web/src/capture/taskGate.ts:63-64` |
| 4 | How the pick screen passes the choice on | A link to the address a "My inspections" row uses, so the gate holds no new state | `web/src/driver/DriverHome.tsx:171`; `web/src/capture/useTaskGate.ts:47-59` |
| 5 | The pick screen's order | Earliest due first, ties in list order, the order `citedTask` already prefers | `web/src/capture/taskGate.ts:81-86` |
| 6 | Whether row 2a rewrites the address | No. The draft takes the task at Start, and a held draft on a link with no task resumes | `web/src/capture/CaptureFlow.tsx:299-306`; `taskGate.ts:47` |
| 7 | What stands in for the link's task in row 2a | The one open task, for the cited task and the blocked-Start words alike | `CaptureFlow.tsx:284-288`; `taskGate.ts:73-87` |
| 8 | Where the rider goes | Directly above the table, naming row 2 | Markdown tables take no text between rows; `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md:1056` is the house pattern |
| 9 | Whether the cue is a screen shake or a mark on the box | The box. The owner's answer offers either, the eye has to land on the box, and a moving screen moves the keypad under a gloved thumb | The owner's answer 2; `web/CLAUDE.md`, The capture target |
| 10 | How long the mark shows | Until the next key or tap, with no timer in code | U178 (TYRE-464); `web/src/ui/base.css:24-31` |
| 11 | Reduced motion | No shake; the mark and the announcement carry the cue | `web/src/ui/base.css:24-31`; https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion |
| 12 | The pressure box | The same stay and cue when it is empty and no tread is. Today that Next already does nothing, silently | `web/src/capture/entry.ts:97-99` |
| 13 | The deferred application version | No ticket. It fails the schedule test by the owner's own answer, so it is one "Set aside" line | `docs/how-work-runs.md`, Which bugs a branch fixes (U130) |
| 14 | An ADR | None. Nothing is decided about tenancy, storage or transport | `docs/adr/0009`, `0015`, `0020` |
| 15 | A coupled trailer's own address when a task is due on that trailer | It counts as a task of the unit. One such task sends the route on to the motive's address with the task named, replacing the history entry; several show the pick screen. From the builder check | TYRE-491, definition of done, first item (U245); `db/migrations/000060_per_trip_assignment.up.sql:706-713`; `web/src/driver/DriverHome.tsx:171` |
| 16 | Where the sign-out refusal's phone-width check runs | The `auth` project (Pixel 7). The ticket asks for phone width, and the button renders only in a bearer session, which the device projects do not have. No WebKit identity stub is added. From the builder check | `web/src/auth/SignOutButton.tsx:39`; `web/playwright.config.ts:60-85`; `web/CLAUDE.md`, Browser tests |

## Left to the builder

- The names and files of the pick screen and the shared task row, and how
  the gate's result carries the unit's tasks.
- How the reducer or the sheet reports a stay, within "a stay changes
  nothing in the entry state".
- The mark's exact ring, the shake's distance and duration, and the live
  region's markup, from the tokens and the existing patterns, passing
  `captureContrast.test.ts`.
- Which fixtures give each e2e driver the tasks it counts.

## Sources

1. Jira: TYRE-491 (description, comment 14344), TYRE-319 (comment 14341),
   TYRE-464 (description, U178).
2. SRS in Confluence, read 20 Nov 2026: Part 2 (page 10846209, v10),
   Part 3 with the errata table (10878977, v25), Part 4 (10911745, v11).
   Project brief (10321923, v2).
3. `docs/superpowers/specs/2026-11-20-task-only-capture-start-and-resume-design.md`,
   section 2.
4. `web/src/capture/taskGate.ts`, `useTaskGate.ts`, `CaptureFlow.tsx`,
   `CaptureStart.tsx:258-262`, `TaskChoice.tsx`, `entry.ts`,
   `PositionSheet.tsx`; `web/src/ui/TreadReadings.tsx`,
   `web/src/ui/base.css`; `web/src/driver/DriverHome.tsx:153-177`;
   `web/src/auth/SignOutButton.tsx:69-93`.
5. `web/e2e/capture.spec.ts:44-58`, `web/playwright.config.ts`.
