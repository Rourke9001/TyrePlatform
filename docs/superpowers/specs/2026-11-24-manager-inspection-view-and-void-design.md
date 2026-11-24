# Design: a manager sees a unit's inspections, their readings and current condition, and can void one (TYRE-325)

Ticket TYRE-325, raised by the 24 Sep 2026 checkpoint audit (runtime finding
f3) and widened by the pilot audit (U147, comment 13943, item B19: the
definition of done gains FR-INS-012's void button). The run queue launches it
alone (`docs/implementation-order.md`, row 7). The owner's answers of
24 Nov 2026 are under "The owner's answers" (U248, comment 14354), and the
condition on the approval under "The owner's condition" (U249).

**Requirements touched:**

- FR-RPT-031 (Vehicle Tyre Position): the unit screen gains tread and
  pressure per position. Its wear rate and projected removal window are not
  built here (Non-goals).
- FR-RPT-015 and CR-011, BR-INS-003, BR-INS-005: wherever a governing depth
  is shown, the width-wise readings it came from are shown with it, and the
  governing value is the stored minimum, never worked out on the screen.
- FR-INS-003, FR-INS-040 and DR-021: what an inspection records (who, when,
  odometer) and every warning raised at capture with the driver's response.
- FR-INS-020 and FR-INS-064: the odometer is the motive unit's, and distance
  is never apportioned to a towed unit. A towed unit's inspection names the
  unit it was read with and that unit's odometer, and no distance is worked
  out from them here (Non-goals; the owner's condition, U249).
- FR-INS-011, FR-INS-012, CR-004 and Appendix C.2: a submitted inspection is
  never edited; a controller or higher may void it with a mandatory reason,
  the record is kept, and it leaves analytics.
- FR-AUT-007, FR-AUT-008 and FR-AUT-009: a controller reads and writes the
  whole tenant, a depot manager the units of their depots.
- FR-CFG-013 and FR-INS-022a: the pressure target is tenant configuration, a
  spare has none, and a pressure carries its hot, cold or unknown basis.
- FR-EXC-001 and the rules `app.v_exception` implements: current condition is
  judged there and nowhere else.
- FR-TYR-017: a tread figure shows its age in days.
- IR-UI-009: a destructive action is confirmed and names what it affects.
- The Part 3 errata row for FR-INS-029a and FR-CFG-024 (TYRE-207): manager
  screens may name the readings Outer, Centre and Inner.
- Rules 1, 3, 4, 5 and 6 of CLAUDE.md.

**One SRS change is prepared, for the owner's yes with this spec (U194).**
The SRS names no manager inspection screen and is silent on two things U248
decided. The row, for the Part 3 errata table:

| Requirement | Erratum | Amendment | Reason | Section |
|---|---|---|---|---|
| **FR-INS-012** | (TYRE-325, 24 Nov 2026) | FR-INS-012 gains: "A voided inspection stays visible to management users in the unit's inspection list, marked voided, with its reason, who voided it and when, and its readings can still be read. A DEPOT_MANAGER may void an inspection that was addressed to, or read, at least one unit of their assigned depots (FR-AUT-008). The confirmation names every such unit of the inspection (IR-UI-009)." | Owner ruling U248, items 2 and 3 (TYRE-325 comment 14354, 24 Nov 2026). FR-INS-012 keeps the record and says nothing of whether a manager still sees it, and FR-AUT-008 narrows a depot manager to their depots without saying how that reads for one inspection of a rig whose units belong to two depots. | §4.8.1 (Part 2); cross-ref FR-AUT-008, IR-UI-009, Appendix C.2 |

On the owner's yes the row goes to
`docs/HANDOFF_srs_errata_TYRE-325_2026-11-24.md` for the owner's Cowork
agent, and pasting it is a step the owner owes after the merge.

## Intent

After a driver submits, the task closes and nothing else changes for a
manager. No route reads an inspection or its readings
(`api/internal/httpapi/httpapi.go:80-158` has `POST /inspections` and
`POST /inspections/{id}/void` only). The unit screen shows the tyre at each
position and one "last tread" figure, with no readings, no pressure and no
condition (`web/src/fleet/unit/PositionPanel.tsx:72-73`,
`web/src/fleet/unit/unit.view.ts:65-77`). The void exists as an API and has
no screen. So the person who has to act on a walk-around cannot see it, and
the person who has to correct a wrong one cannot.

## Goals

1. A manager opens a unit and sees its inspections, newest first: date and
   time in the tenant's timezone, driver, odometer, how many warnings were
   recorded, and which one is the latest and which are voided.
2. A manager opens one inspection and sees, for that unit, every position
   read: the width-wise readings with the governing minimum marked, the
   pressure beside the tenant's target, damage and notes, and each warning
   recorded at capture with the driver's response.
3. The unit screen shows current condition per position from the unit's
   latest inspection, judged by `app.v_exception` and by nothing else.
4. A controller, depot manager or org admin voids an inspection from its
   page: a reason, a confirm step that names every unit affected, and a
   clear result.
5. A voided inspection stays in the list, marked, with its reason, who and
   when (U248).
6. A depot manager can void only an inspection that read a unit of their
   depots (U248).
7. A towed unit's inspections keep, and show, the record a trailer distance
   is worked out from: which unit each was read with and that unit's
   odometer at the time (U249).

## Non-goals

- The Units list (`/fleet`). It does not change (U248). Coverage and
  staleness (FR-INS-045 to 047, FR-DSH-005, FR-DSH-006) are TYRE-284's.
- Wear rate and the projected removal window per position, the rest of
  FR-RPT-031. The ticket's definition of done does not ask for them.
- A trailer distance figure. FR-INS-064 says distance is never apportioned
  to a towed unit, and FR-FIT-009 and BR-ANL-011 treat a distance inferred
  from couplings as unbounded. Changing that is TYRE-455, the owner's ticket
  of 22 Oct 2026 (run-queue row 40, with TYRE-441), which records the horse's
  odometer at every trailer swap and carries the SRS change. Until it lands,
  the difference between the odometers of two inspections is the trailer's
  distance only when one horse towed it the whole time between them. This
  ticket keeps and shows the record and computes no difference (U249).
- A whole-rig inspection page. An inspection is shown one unit at a time,
  with the other units it read named.
- Any judgement of an older inspection. Only the latest one is judged, as
  `app.v_exception` does (U18). An older one shows what was read, the target
  in force that day, and the warnings the driver saw.
- An over-pressure condition mark. `app.v_exception` has no over-pressure
  rule (FR-EXC-024 and 025 are outside Appendix H.1). The driver's recorded
  FR-INS-037 or FR-INS-031a warning is where over-pressure shows.
- Undoing a void, a time limit on a void, reopening a task a voided
  inspection completed, or asking for a re-inspection from the void dialog.
  The Schedule inspection form on the unit screen is how a re-inspection is
  asked for (UC-02, alternate flow 3a).
- Imported sheets (FR-IMP-009, TYRE-453) and the "Not the tyre I expected"
  report (FR-INS-027, TYRE-285). Neither is built.
- Photographs (TYRE-152).
- Money. Nothing here shows a rand figure.
- The cost of `app.v_exception` on a large tenant (TYRE-256, post-POC).

## Anti-goals

- A threshold, band or minimum worked out in Go or in the browser.
- A second implementation of any `app.v_exception` rule, or of "latest
  inspection per unit".
- A route that edits an inspection or a reading.
- A screen that calls a tyre legal, illegal or roadworthy.
- A depot manager learning anything about a unit outside their depots beyond
  its fleet number and what the driver wrote about the whole walk-around
  (the comment and the defect report) on an inspection they may already see.
  Its id, its readings, its odometer and the warnings that concern it stay
  out of reach.
- A distance shown for a towed unit, or a difference of two odometers
  labelled as one (Non-goals).

## Constraints

- **Rule 1.** Every new view is `WITH (security_invoker = true)` and carries
  `tenant_id`, which suite check 8b needs for its leak sweep
  (`db/CLAUDE.md`, Adding a view; `db/tests/004_tests.sql:354-374`).
- **Rule 3.** No new write surface. The void stays `app.void_inspection`
  (`db/migrations/000040_inspection_written_once.up.sql:641-667`). No grant
  changes.
- **Rule 4.** The governing value on every screen is
  `reading.governing_tread_mm`. `TreadReadings` never computes a minimum
  (`docs/adr/0020-tread-design-system.md:240-242`), and nor does its caller.
- **Rule 5.** No number for a threshold or a target appears in code.
- **Rule 6.** Every instant renders through `web/src/time/tenantTime.ts`.
- "Latest" is decided through `reading.vehicle_id`, never
  `inspection.vehicle_id`, which is the unit the capture was addressed to
  (`db/migrations/000045_exception_view.up.sql:169-177`).
- **One test of "this inspection concerns this unit"**, used by the list, the
  page's 404, the dialog's list of units and the void's scope check alike:
  `app.inspection_read_unit`'s, an inspection addressed to the unit or one
  carrying a reading of it
  (`db/migrations/000060_per_trip_assignment.up.sql:284-292`). A view that
  has to enumerate the pairs states the same two arms, and the suite pins the
  view to the function in both directions.
- Position ids repeat across the units of a rig, so a reading is keyed by
  position and vehicle together (`docs/lessons.md`, 2026-08-26).
- A unit outside the actor's scope answers 404, never 403 (ADR-0011).
- A migration already on `develop` is not edited. The next number is 000065.
- ADR-0020 and ADR-0022 govern the screen: Tread components, tokens only,
  words for wire codes in `web/src/domain/vocabulary.ts`, tables that turn
  into cards below 640px, no information by colour alone (NFR-USE-009).
- The new page loads behind `React.lazy`, as `UnitDetail` does
  (`web/src/routes.tsx:38-40`), so the capture entry does not grow.

## Approaches

**A. New read views and two unit-path routes; current condition composed
from the existing exceptions read (chosen).** A migration adds views for a
unit's inspection list and for an inspection's readings, voided ones
included. Two GET routes relay them. The unit screen gets its condition from
`GET /api/exceptions?vehicle=<id>`, which already exists
(`api/internal/httpapi/exceptions.go:117`), joined on screen to the latest
inspection's readings. Nothing about a rule is written twice, and the
exceptions list and the unit screen cannot disagree, because they read the
same rows.

**B. One new "unit condition" view that restates the judging.** A view over
`app.v_latest_reading` that resolves thresholds and bands per position and
returns a condition column. It gives one tidy read, but it is a second copy
of the predicates in `app.v_exception`
(`db/migrations/000045_exception_view.up.sql:204-207` says there is one), and
the pressure band `CASE` already lives inside `app.inflation_compliance`
(`000045:133-140`). Rejected: a third reader that restates rules is how the
tiers drift.

**C. Widen `app.v_reading_detail` and query it from Go.** It excludes voided
inspections (`db/migrations/000011_sponsor_answer_surgery.up.sql:290`), and
valuation, wear rate and the exception views read it. Showing voided sheets
would mean removing that filter from under them. Rejected, as 000045 itself
declined to widen it (`000045:186-188`).

The owner handed the lead the how (U195); A is the lead's pick.

## The design

### 1. Database: migration 000065, read views only

Two views, both `security_invoker`, both carrying `tenant_id`, neither
filtering on `state`.

**The unit's inspections.** One row per unit and inspection, for every
inspection that concerns the unit (Constraints). Columns: the tenant, the
unit, the inspection, its state, the void reason, who voided it (display
name) and when, `started_at`, `submitted_at`, `received_at`, the driver's id
and display name, whether the capture was addressed to this unit, the addressed unit's
id and fleet number, the odometer and whether the odometer timeline took it,
the driver's comment and defect report, the number of positions
read on this unit, the number of warnings that concern this unit, and
whether this is the unit's latest inspection. "Latest" comes from joining
`app.v_latest_unit_inspection`, never from a second `DISTINCT ON`. A voided
inspection is never latest, by that view's own filter (`000045:183`), and
nor is one that concerns the unit without reading it.

The odometer belongs to the unit the capture was addressed to: the
inspection row holds what the driver entered (`000060:996-1003`), and submit
files it on that unit's timeline alone (`000060:1284-1289`). Every row of the
inspection carries that reading together with the addressed unit's id and
fleet number, so a towed unit's row says which unit it was read with and at
what odometer (U249). It is never presented as the towed unit's own reading,
and the view works out no distance from it. A trailer-only inspection has
none (FR-INS-020).

The timeline can refuse the reading (DR-020, or a second one on the same
day), and submit then keeps the inspection and records a warning
(`000060:1290-1298`). The view says whether a timeline row cites the
inspection, so a screen never shows a refused reading as an accepted one.

The view is not where a depot manager's scope is applied: the API returns
the addressed unit's odometer and id only when that unit is in the actor's
scope (section 2).

A warning concerns a unit when it hangs off one of the unit's readings, or
when it hangs off no reading (an inspection-level warning, such as the
odometer's) and the capture was addressed to the unit. That keeps a refused
odometer, and a composition report's list of units, on the addressed unit's
page only.

Who voided and when are the row's own stamps. A row the void reached is
frozen (`000040:578-630`), so its `updated_at` and `updated_by` are the ones
`inspection_stamps_updated` wrote on the void's update
(`db/migrations/000017_audit_columns_dr013.up.sql:228-237`). That holds for
a row the void reached, not for every voided row: the app role may insert
`state`, `void_reason` and both stamps, and nothing checks an insert's state
or stamps, so a raw insert can plant a row already `VOIDED` with stamps of
its own. No route does, since submit writes `SYNCED` (`000060:1006`). They
are read only when the state is `VOIDED`.

**An inspection's readings.** One row per reading. Columns: the tenant, the
inspection, the unit, the reading, the position (id, code, sequence, axle
number, axle class, side, slot, spare flag), the tyre's id and display code,
`governing_tread_mm`, the measurements in ordinal order with each one's
anatomy (`OUTER`, `CENTRE`, `INNER`) and whether orientation is known for
all of them, `pressure_kpa`, `pressure_temperature`, the target pressure in
kPa, the damage flag and type, the wear pattern and the note.

The target is `app.target_pressure_for(tenant, the tyre's size, the
position's axle class, submitted_at)`, the same resolver at the same instant
`app.v_exception` uses (`000045:256-258`), so for a latest inspection the two
agree by construction. A spare resolves to no target (`000045:87`). A
reading with no tyre on record has no size, so it resolves to the class-wide
or tenant-wide target (`000045:89-90`), and the view carries that as it
comes: it is the tenant's target for the position's class, and nothing here
judges against it. The view carries the target and nothing derived from it:
no percentage, no band.

**Spares reported absent.** A spare the driver said the unit does not carry
is a row of `app.inspection_absent_spare`
(`db/migrations/000041_capture_observations.up.sql:29-50`), keyed by
inspection, unit and position. The inspection read returns them beside the
readings.

A down migration drops the views.

Migration 000066 seals `app.inspection_warning` and
`app.inspection_absent_spare` as 000040 seals a reading: a row offered to an
inspection committed in an earlier transaction is refused `TY020`, so the
page shows a warning or an absent spare only as the capture recorded it
(U251).

### 2. API: two reads, and the void's scope

Both reads require `auth.ViewFleet`, take the unit from the path, find it
through `unitSource(a)` and answer 404 `not_found` when it is missing or out
of scope, as `getUnit` does (`api/internal/httpapi/units.go:343-349`,
`849-854`). Both relay the views; neither computes anything.

**`GET /api/vehicles/{vehicleID}/inspections`.** The unit's inspections,
newest first, in the order `app.v_latest_unit_inspection` uses
(`submitted_at DESC, received_at DESC, id`). The read is bounded: a page of
rows and a way to ask for the page after it. An empty unit answers an empty
list.

On both reads a row names the addressed unit by fleet number. Its id, the
odometer and the timeline flag are returned when the addressed unit is the
unit in the path or is in `unitSource(a)`, and are null otherwise, so a
depot manager reads another depot's horse's odometer on neither read. The
scope test is a join in the handler's query, as the units concerned are.

**`GET /api/vehicles/{vehicleID}/inspections/{inspectionID}`.** The header
(the list row's fields), the readings of this unit on this inspection in
position order (by code length then code, NFR-USE-012), this unit's spares
reported absent, the warnings that concern this unit (code, source, entered
value, response, raised-at, and the position code when it hangs off a
reading), and every unit the inspection concerns: its fleet number, whether
it is in the actor's scope, and its id only when it is. An inspection that
does not concern this unit answers 404.

Wire types follow `exceptions.go:41-50`: millimetres as numbers, kPa as an
integer, instants as RFC 3339 UTC, and a null where there is no value. The
tenant-calendar age of the inspection in days comes from
`app.tenant_days_since` in SQL (FR-TYR-017), as `exceptions.go:111` does.

**The void's scope (a bug on this path, fixed here).** `voidInspection`
checks the capability and nothing else
(`api/internal/httpapi/inspections.go:48-56`), so a depot manager can void
any inspection in the tenant. It joins the callers of `unitSource`
(`docs/architecture.md:183-193`): for an actor who is not tenant-wide, the
inspection must concern at least one unit in `unitSource(a)`, by the one
test (Constraints), so every inspection a depot manager may void is on a
list they can open, and the dialog names their unit. Otherwise the
answer is 404 `not_found`, the same as an inspection that does not exist.
The check holds for the write as the unit-path writes' checks do
(`units.go:856-861`, `889-893`). The request, the 204, TY012 and TY019 are
unchanged. `docs/architecture.md` names the new caller.

### 3. Web: the unit screen

**Inspections card.** On `/fleet/units/:unitId`, a card titled
"Inspections" lists the rows of the first read: date and time, driver,
odometer, positions read, warnings, and a mark for "Latest" or "Voided". On
a row whose capture was addressed to another unit, the odometer cell names
that unit and gives its reading, as in "H12: 412 300 km", or names the unit
alone when the reading is out of the actor's scope or was not entered. A
reading the timeline refused is marked as not on the odometer record. No
column or line gives a distance.
A row links to the inspection's page. With no inspections it says so. Older
pages load on request.

**Condition on the plan.** The unit screen sets no condition on a tile
today (`web/src/fleet/unit/unit.view.ts:65-77`); `AxleDiagram` already
accepts one (`web/src/ui/AxleDiagram.tsx:11-22`). The screen reads the
latest inspection (the second read, for the row marked latest) and the
unit's open exception rows from `GET /api/exceptions?vehicle=<id>`
(`exceptions.go:117-118`). Per position, the first row that fits:

| # | The position | Tile |
|---|---|---|
| 1 | The latest inspection reported this spare absent | `nospare` |
| 2 | The register has no tyre fitted here now | no condition mark, as today |
| 3 | The unit has no latest inspection, or it did not read this position, or the reading names a tyre other than the one fitted now | `unread` |
| 4 | An open exception row of severity CRITICAL names it | `limit` |
| 5 | An open exception row of severity WARNING names it | `near` |
| 6 | Otherwise | `ok` |

A dual-mate row (`positionCode2`) marks both positions. A row with no
position (the unit-level pressure uniformity rule) is a line beside the
plan, not a tile. Severity to condition is a display mapping in the unit's
view model, with the words in `vocabulary.ts`; the browser compares no
measurement with any threshold.

The unit screen's exception rows are a query of its own, keyed by the unit,
with the fleet screens' default freshness, fetched beside the latest
inspection so the two are the same age. It does not refetch on window focus:
the exceptions read builds the whole tenant's latest readings before it
filters to the unit, which is the cost U41 keeps off a focus event
(`dashboard.data.ts:29-30`). It does not go through
`useExceptions`, whose rows never go stale until Refresh
(`web/src/dashboard/dashboard.data.ts:83-92`).

**Position panel.** For the selected position the panel adds the latest
reading: `TreadReadings` with the governing reading marked, the pressure as
"780 of 800 kPa" with its hot, cold or unknown basis, the age in days, the
names of the open exceptions on the position, and a link to the inspection.
A spare says it has no target. When the fitted tyre is not the tyre read,
the panel says the tyre has not been read since it was fitted and shows no
reading.

### 4. Web: the inspection page

`/fleet/units/:unitId/inspections/:inspectionId`, behind the same
`ViewFleet` gate as the unit screen, lazy. It shows:

- A header: the unit, date and time, driver, the odometer under the same
  rule as the list (this unit's own, or the addressed unit's, named), and
  "Latest inspection" or "Voided".
- When voided, a banner with the reason, who voided it and when.
- The driver's comment and defect report, when there is one. They are the
  driver's words about the whole walk-around, so they show on every unit's
  page of the inspection.
- The other units the inspection concerns, each a link when it is in the
  actor's scope and plain text when not.
- The warnings, each as words, with its position, the value entered and the
  driver's response (Confirmed, Acknowledged, or none for one the server
  raised). Words for every code `app.submit_inspection` can write today
  (FR-INS-031a, 033, 034, 035, 036, 037, 041, FR-INS-063, FR-OFF-016,
  DR-020) go in `vocabulary.ts`, written for a manager; a code with no words
  shows as "Other warning" with its code, so nothing is hidden. Capture's
  own driver-facing names (`web/src/capture/CaptureReview.tsx:15-27`) stay
  where they are, because `vocabulary.ts` stays out of the capture entry
  (`web/CLAUDE.md:230-235`). No string calls anything a legal limit
  (CR-010).
- The readings, one row per position, cards on a phone: position, tyre,
  the width-wise readings with the governing one marked, the minimum, the
  pressure beside its target with its basis, damage and note. Readings are
  named Outer, Centre and Inner when orientation is known and numbered when
  it is not (`web/src/ui/TreadReadings.tsx:70-75`). Tread is `formatMm`. A
  spare reported absent is a row that says so.
- The value a warning carries is shown only where it is a measurement the
  page can format (a tread, a pressure, an odometer). A composition report's
  value is a list of unit ids and is not shown; the Rigs screen already
  works those reports (`api/internal/httpapi/observations.go`).
- A "Void inspection" button, shown only with the `VoidInspection`
  capability and only while the inspection is not voided.

### 5. Web: the void

The button opens a Tread `Dialog` with `tone="danger"`
(`web/src/ui/Dialog.tsx`, used as `ReceiptList.tsx:112-135` uses it). It
names the inspection by date and driver and lists every unit it concerns,
by fleet number. It says in plain words that the inspection stays on record
marked voided, that its readings stop counting toward condition, exceptions,
wear rates and values for every unit listed, that this cannot be undone, and
that it does not ask for a new inspection. A reason is required. The server
refuses one over 200 bytes (`api/internal/httpapi/inspections.go:44`,
`request.go:80-84`), which is the house count for this field and stays; the
form stops at 200 characters and shows the server's refusal for a reason
that is under that and still too long. Close is blocked while the write is
pending. A refusal shows in the dialog through `RefusalAlert`, including
TY019 when someone else voided it first.

On success the dialog closes and the page shows the inspection as voided
with a status line saying so (NFR-USE-010). The void makes stale every
query it changes: the inspections, the inspection, the unit and the unit's
exception rows, for every unit, by prefix; and the four keys the dashboard's
Refresh invalidates (`dashboard`, `spares`, `exceptions`, `at-risk`,
`dashboard.data.ts:43-54`), so the dashboard and its lists are read again
together on the next visit and cannot show the voided inspection's figures.
Nothing polls (U41). Of the unit's reads, only the exception rows skip the
refetch on focus (section 3); the inspections, the inspection and the unit
take the fleet default, which refetches a stale query on focus. The unit's
condition then comes from the inspection before it, or shows unread when
there is none.

## How we will know it worked

- **Suite** (`db/tests/004_tests.sql`, a new section, on the golden
  fixture): each of BAC's three units lists both fixture inspections with the
  right latest mark, agreeing with `app.v_latest_unit_inspection`; voiding
  the latest inside a transaction keeps it listed as voided with the reason
  and the voider, and moves latest to the other; the readings view returns
  the same measurements and governing value as `app.v_reading_detail` for a
  non-voided inspection and still returns them for a voided one; its target
  equals the `target_kpa` `app.v_exception` reports for the same reading;
  warnings are counted per unit as section 1 defines; the list view's pairs
  are exactly the pairs `app.inspection_read_unit` accepts; every row of an
  inspection carries the addressed unit and the odometer the inspection row
  holds, a towed unit's row included; the timeline flag is false for a
  reading the timeline refused; another tenant sees no row. Check 8b covers both views without change. The Appendix J counts (19,
  11, 9) do not move.
- **API** (`make api-test`): a driver gets 403 on both reads; the fixture
  relays; a unit or inspection out of scope, or an inspection that did not
  read the unit, gets 404; a voided inspection is listed and readable; the
  list pages; a depot manager's read of a two-depot rig's inspection carries
  no id for the other depot's unit, and their own towed unit's rows name the
  other depot's horse by fleet number and carry no odometer, no id for it and
  no inspection-level warning; a controller's read of the same towed unit
  carries the horse's id and odometer. For the void: a depot manager
  with no unit on the inspection gets 404 and nothing is voided, one with a single unit on a two-depot rig
  gets 204, a controller gets 204 anywhere in the tenant, and the existing
  `TestVoidInspection` cases hold.
- **Web unit tests**: the condition table above, row by row; the list and
  page states (loading, empty, error, voided, phone cards); the dialog
  (reason required, refusal shown, units named, button hidden without the
  capability or when voided).
- **Browser** (`make e2e`, `chromium` project, Sandbox Fleet, as
  `web/e2e/tasks.spec.ts` does): a driver submits, the controller opens the
  unit, sees the inspection and its readings, voids it with a reason, and
  sees it marked voided.
- `web-design-guidelines` over the changed UI files, and `make check` green.

## Left to the builder

- The views' names and exact column names, and whether warnings and covered
  units are views of their own or queries in the handler.
- The page size and the shape of the paging parameter.
- Whether the unit screen learns the latest inspection's readings from the
  second read or from a third route that returns them directly.
- How the governing reading's index reaches `TreadReadings` (a column or an
  equality lookup), given rule 4 above.
- Whether the void's scope check locks or checks before and after, following
  whichever of `lockUnitInScope` and `checkUnitInScope` fits the function's
  own locks.
- Component and file layout under `web/src/fleet/unit/`, per ADR-0022.
- The exact words on the screen, within `/unslop` and CR-010.

## The owner's answers (24 Nov 2026, U248)

| # | Question | Answer |
|---|---|---|
| 1 | Where a manager sees a unit's inspections | A list on the unit page; a row opens the inspection on its own page, which holds the readings and the void button |
| 2 | Whether a voided inspection still appears | Shown, marked Voided, with the reason, who and when; readings can still be opened; it never counts toward condition or exceptions |
| 3 | When a depot manager may void an inspection of a rig that mixes depots | When it read at least one unit of their depots; the confirm step names every unit affected |
| 4 | Whether the Units list changes | No |

Stated with the questions, no objection: FR-RPT-031's wear rate and removal
window are left out.

## The owner's condition (24 Nov 2026, U249)

The owner approved this spec and its SRS row with one condition, in their
words: "approved as long as the differencve in odomemter between inspections
on trailers from thier horses are also tracked so we can also caluclate the
distance of the trailers traveled between inspections".

How it is met. The record is already kept: an inspection row holds the
horse's odometer and the rig it was done on, and each reading names its own
unit (`db/migrations/000060_per_trip_assignment.up.sql:996-1003`,
`db/migrations/000001_init.up.sql:322`). This ticket changes none of that
and now shows it: a trailer's inspection names the horse it was read with
and that horse's odometer (Goal 7). Working the distance out is TYRE-455,
with its SRS change (Non-goals). The lead read "tracked" as kept and
visible, not as a figure on this screen, and told the owner so.

## Lead's calls

| # | Question | Call | Source |
|---|---|---|---|
| 1 | Where current condition is judged | `GET /api/exceptions?vehicle=` plus the latest inspection's readings; no new judging view | `api/internal/httpapi/exceptions.go:117-118`; `db/migrations/000045_exception_view.up.sql:204-207` |
| 2 | Whether older inspections are judged | No; they show readings, the day's target and recorded warnings | `000045:209-215` (U18) |
| 3 | New views or a wider `v_reading_detail` | New views | `db/migrations/000011_sponsor_answer_surgery.up.sql:290`; `000045:186-188` |
| 4 | How "latest" is decided | By `app.v_latest_unit_inspection`, through `reading.vehicle_id`; row 17 says which inspections are listed | `000045:169-184` |
| 5 | Who voided and when | The row's `updated_by` and `updated_at`, read only when voided; no new column | `db/migrations/000040_inspection_written_once.up.sql:578-630` |
| 6 | Where the void's scope check lives, and its refusal | In the handler, through `unitSource`; 404 | `docs/architecture.md:183-193`; `api/internal/httpapi/units.go:856-861` |
| 7 | Wire types for measurements and instants | Numbers, integer kPa, RFC 3339 | `exceptions.go:41-50` |
| 8 | Where warning words live | `vocabulary.ts` for managers; capture's names untouched | `web/CLAUDE.md:230-235`; `web/src/capture/CaptureReview.tsx:15-27` |
| 9 | A position whose fitted tyre is not the tyre read | `unread`, and the panel shows no reading | `000045:394-398`; `units.go:236-240` |
| 10 | Reading labels | Outer, Centre, Inner when orientation is known, numbered when not | SRS Part 3 errata, the TYRE-207 row; `web/src/ui/TreadReadings.tsx:70-75` |
| 11 | Pressure against target | The reading and the target, side by side; no percentage or band in the new view | `000045:111-112`, `247-248` (two copies exist already) |
| 12 | Over-pressure | No condition mark | `000045:239-401` has no over-pressure rule |
| 13 | A time limit on the void, or only the latest | Neither; any non-voided inspection | `000040:641-667` |
| 14 | The list's size | Paged | `000045:184` (the order to page on) |
| 15 | An ADR | None; this follows ADR-0006, 0011, 0013, 0020 and 0022 | `docs/adr/` |
| 16 | The browser test's tenant | Sandbox Fleet, submitting first | `web/e2e/tasks.spec.ts:27-80`; `web/e2e/sandbox.ts:157-183` |
| 17 | Which test says an inspection concerns a unit | `app.inspection_read_unit`'s, everywhere. From the builder check | `db/migrations/000060_per_trip_assignment.up.sql:284-292` |
| 18 | Whose the odometer and the inspection-level warnings are | The addressed unit's. Inspection-level warnings show on its rows alone. The odometer shows on other units' rows too, named as the addressed unit's, when that unit is in the actor's scope (U249). From the builder check | `000060:1284-1299` |
| 19 | The comment, the defect report and spares reported absent | Shown: the first two on every unit's page of the inspection, an absent spare as a row and as `nospare` on the plan. From the builder check | `db/migrations/000001_init.up.sql:318-341`; `db/migrations/000041_capture_observations.up.sql:29-50` |
| 20 | A reading with no tyre on record | Carries the class or tenant target the resolver gives; nothing judges it | `000045:87-90` |
| 21 | Freshness of the unit screen's exception rows, and what a void makes stale | A unit-keyed query at the fleet default; the void invalidates the unit's keys and the dashboard's four. From the builder check | `web/src/dashboard/dashboard.data.ts:29-54`, `83-92` |
| 22 | The reason's length | The server's 200 bytes stay; the form stops at 200 characters and shows the refusal | `api/internal/httpapi/request.go:80-84`; `inspections.go:44` |
| 23 | How the owner's condition on trailer distance is met | The record is kept and shown; no distance is computed here, because the SRS forbids apportioning one and TYRE-455 carries that change | `web/src/capture/CaptureStart.tsx:38-39` (FR-INS-064); TYRE-455; `docs/implementation-order.md:147` |
| 24 | Which odometer a screen shows, and a refused one | What the driver entered on the inspection row, with a flag for whether the timeline took it | `000060:996-1003`, `1284-1298` |
