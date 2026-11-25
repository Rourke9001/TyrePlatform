# Design: the behaviour fixes on the register, unit and fleet screens, and movements recorded for an earlier day (TYRE-240)

Ticket TYRE-240, as re-cut by the pilot audit (U147, comment 13937, items A23,
C1 and B41). The restyle it once carried landed as PRs #153 and #154. What is
left is a list of behaviour defects folded in from closed tickets, and one
feature, B41: the office can record a fit, a removal, a rotation or a return to
stock for the day it happened. The run queue launches it with TYRE-176, which
carries TYRE-278 (`docs/implementation-order.md`, row 8, comment 14254). The
owner's answers of 25 Nov 2026 are under "The owner's answers" (U253, comment
14376).

**Requirements touched:**

- FR-FIT-016 and BR-FIT-006: a movement may be back-dated, never to before
  the tyre's last prior event, and a late one carries a reason.
- FR-FIT-018: lifecycle events are recorded through the management interface.
- FR-FIT-008: removal reasons are a configurable list.
- FR-RPT-015, CR-011, BR-INS-003 and BR-INS-005: a governing depth in a
  detail view shows the width-wise readings it came from.
- NFR-PRO-001, NFR-PRO-002, FR-RPT-016, BR-VAL-002, BR-VAL-003, BR-VAL-004
  and CHG-062: a money figure carries its basis, and an absent one reads as
  absent.
- NFR-USE-012: identifiers sort in natural order.
- NFR-USE-005 and NFR-USE-007: plain words on screen, and a visible label
  whose text is the accessible name.
- FR-TYR-010 and FR-AUT-002: the tyre states and the roles the screens name.
- Rules 2, 3, 4, 5 and 6 of CLAUDE.md.

**One SRS change is prepared, for the owner's yes with this spec (U194).**
FR-FIT-016 and BR-FIT-006 speak of a timestamp and of 24 hours. The office
records a day (U147, B41), so the rule needs a day reading. The row is under
"The SRS row".

## Intent

A controller who logs yesterday's workshop job today has no honest way to do
it. The API takes an instant on three of the four movements and the forms send
none, so every movement is stamped at the moment of typing. Fitment spans,
wear rates and as-at valuations then run from the wrong day.

The rest is a set of small things a manager meets on ordinary use: a register
that prints `AT_BREAKDOWN_SUPPLIER`, money with no word on where it came from,
a casing value that disagrees with the dashboard, a status form that can write
back a stale value, inputs with no visible label, a list in text order, an
Apply that says nothing. Each is cheap. Together they are why the owner called
these screens "unusable unless you know what you need to do" (comment 12937).

## Goals

1. The fit, remove, rotate and return-to-stock forms take an "Occurred on"
   day. Today needs nothing more. An earlier day needs a reason, and the
   database stores both.
2. A movement recorded for an earlier day lands on that day even when the
   tyre already has a movement recorded on it (U253).
3. The register shows, for each money figure, its basis in words. Its casing
   value is the valuation's (U253). An absent figure reads "Not valued".
4. The register shows the tyre's state in words and its retread count.
5. The cost form speaks a `TY012` refusal.
6. The unit status form cannot write back a status the user did not choose.
7. Every governing tread on the position panel has its width-wise readings on
   the panel.
8. Removal reasons and the signed-in role read as words. Removal reason words
   are tenant configuration.
9. The unit edit form says which fields are locked.
10. The fitments list is in natural fleet order and configuration position
    order.
11. The retread return inputs and the rotate form's row inputs have visible
    labels.
12. Apply and Dismiss on a reported rig difference confirm in a status line.
13. The app declares an icon, and no page load asks for `/favicon.ico`.

## Non-goals

- No screen to edit removal reasons or their words. They are provisioned.
- No new day field on dispose or receive, and no reason on dispatch or
  retread return. Dispatch and retread return already take a day and keep
  their forms and wire as they are. They change in one way only, the stamp
  (section 1).
- A cross-unit rotation recorded for the day its rig was coupled is judged
  against the rig as it stood at the stamp. If the rig was coupled later
  that day than the stamp, the rotation is refused in the words
  `app.rotate_tyres` already uses, and the office records it as today's. The
  day rule does not read rigs.
- No display of the back-date reason. It is stored on the event, and the tyre
  history screen that would show it is not built (FR-TYR-015).
- No width-wise readings in the fitment history table. Its "Tread on" and
  "Tread off" are the single figures typed at the fit and the removal
  (`api/internal/httpapi/units.go:382-385`), not a minimum over readings, so
  FR-RPT-015 has nothing to show there.
- No width-wise readings on the dashboard's list rows. FR-RPT-015 names
  detail views.
- No change to `occurredAt`. The instant fields the API already takes stay,
  with their 24 hour rule.
- No change to the capture app. None of this is on its routes.
- The styling folds 132, 345, 359 and comment 12979's list belong to the
  Tread slices. TYRE-281 is TYRE-445's. TYRE-330's f14 is TYRE-171's.

## Anti-goals

- Go never turns a day into an instant and never compares two dates. The day
  rule is one SQL function with a suite section (CLAUDE.md, Where logic
  belongs).
- No second implementation of the casing fallback. The register reads the
  valuation's casing value, it does not restate the `COALESCE`.
- No edit to a tyre event or a closed fitment. A back-dated movement is a new
  row with an earlier `occurred_at` (rule 3).
- No two state events of one tyre at the same instant. `app.rotate_tyres`
  says why: `app.tyre_in_estate_asof` reads the latest one and cannot break a
  tie (`db/migrations/000039_rig_rotation.up.sql:784-790`).
- No removal reason words in a web constant (TYRE-330, f8).

## Constraints

- Migrations 000033, 000039, 000048 and 000062 are applied. A changed
  function is a new migration pair, 000067, that restates the body
  (`db/CLAUDE.md`, Schema changes are migrations, Adding a function).
- `app.fitment_instant_ok` reads only the tyre's state events. A fitment
  opened outside `app.fit_tyre` has no event, which is every open fitment of
  the pilot tenant, so `app.remove_tyre` and `app.rotate_tyres` also check
  the open fitment's `fitted_at` (000039:348-360, :602-614). The day rule has
  to see both.
- `app.rotate_tyres` resolves the rig at the movement's instant
  (000039:476-497). A rotation recorded for an earlier day reads the rig as
  it stood then.
- The as-at valuation honours a dated tread from the UTC day its instant
  falls in (`db/migrations/000050_definer_tenant_predicate.up.sql`, the
  TYRE-123 note in its header). Read it before planning the suite cases.
- The forms also send an odometer. For an earlier day it is the reading on
  that day, and the odometer checks the functions already make refuse a value
  that does not fit. Those refusals are spoken as they are.
- The money columns and their basis are sent only to an actor who may view
  valuation (`tyres_internal_test.go`,
  `TestTyreJSONForProjectsMoneyByCapability`).
- Every wire code becomes words in `web/src/domain/vocabulary.ts`
  (`web/CLAUDE.md`). Dates render through `web/src/time/tenantTime.ts`.
- Appendix E's 15 valuations and Appendix J's 19, 11 and 9 do not move.

## Approaches

**The day on the wire.** Three ways to let a form back-date.

- The form sends an instant it worked out from the day. This keeps the API
  as it is and puts the tenant's timezone and the 24 hour rule in the
  browser. Rejected: that is a business rule in the web, and the midnight it
  would send loses to any movement recorded live that morning.
- The form takes a date and a time. This is the cheapest in the database:
  the rule stays as the SRS words it, and the placement rule in section 1 is
  not needed. It costs the office a time it has to recall or invent for each
  movement, and a refusal whenever the invented time sorts before something
  already recorded. Every other dated field in the office app is a day (Sent
  on, Returned on, Received date, Effective from). Rejected on U147's
  wording, "an occurred on date", and on U253.
- The form sends the day, and SQL turns it into an instant. Chosen. It is
  what dispatch and retread return already do through
  `app.tenant_day_instant` (`db/migrations/000037_rig_written_once.up.sql:133-157`).

**Removal reason words.** Reshape `removal_reasons` into code and label
pairs, or add a second key. Reshaping changes the check in `app.remove_tyre`
(000039:320-339), the provisioning check and every seed. A second key,
`removal_reason_labels`, changes none of them. Chosen.

**The register's casing value.** Label the stored column "audit valuation",
or read the valuation's figure. The owner chose the valuation's (U253).

## The design

### 1. Database: migration 000067

**The day rule.** It has two halves, and one function owns each.

*Placement* answers the instant to stamp. It takes a day, the tyres the
movement touches, and the positions it fills.

- No day, or the tenant's today: `now()`.
- A later day: refused, `TY014`, in the words dispatch uses for a future day.
- An earlier day. Take the latest of these: each tyre's last movement, which
  is its latest state event and, while it is fitted, its open fitment's
  `fitted_at`; and, for each position the movement fills, the `removed_at`
  of the last fitment closed there. A position the same rotation empties
  does not count.
  - The latest falls on a later day than the one given: refused, `TY012`.
    For a tyre the words are `app.fitment_instant_ok`'s, "this tyre's last
    recorded movement is ...; this one cannot predate it". For a position
    they name the position and when it was vacated.
  - It falls on the day given: the stamp is that instant plus the smallest
    step a `timestamptz` holds, so the new movement sorts after it and never
    beside it.
  - It falls before the day given, or there is none: the stamp is the start
    of that day in the tenant's timezone, as `app.tenant_day_instant` gives
    it.

*The reason* is a separate test. A fit, a removal, a rotation or a return to
stock recorded for an earlier day with a blank reason is refused, `TY014`, "a
movement recorded for an earlier day records why".

"Day" is always the tenant's (rule 6). A rotation passes every moved tyre and
every position it fills, and gets one instant for the set.

**The four movements take the day.** `app.fit_tyre`, `app.remove_tyre`,
`app.rotate_tyres` and `app.return_tyre_to_stock` each accept a day in place
of an instant and resolve it through both halves, under the locks they
already take, or in a way that refuses when a concurrent movement gets in
first. An instant passed as before behaves as before, with one addition: a
fit or a rotation at an instant earlier than the position's last closure is
refused, `TY012`, on either path. Two tyres never share a position, at any
instant (BR-FIT-002), and today only the open fitments are held to that
(`db/migrations/000001_init.up.sql:305-306`).

**Dispatch and retread return use placement.** `app.dispatch_tyre` and
`app.log_retread_return` stamp an earlier day at its midnight and refuse only
a stamp before the tyre's last movement, so a tie passes
(`db/migrations/000048_threshold_policy_in_force.up.sql:366-385`,
`db/migrations/000062_codes_to_mark_retread_pattern_receive_depot.up.sql:646-662`).
Once a removal can be recorded for Monday, "removed Monday, sent Monday",
logged on Tuesday, is the ordinary case, and it would either tie or be
refused. Both functions take their stamp from placement instead. Nothing
else in them changes: no reason, no new argument, and every money line of
`app.log_retread_return` is restated as it stands.

**The reason is kept.** `app.rotate_tyres` and `app.return_tyre_to_stock`
gain a back-date reason, which today they cannot take
(000039:615, `db/migrations/000033_fitment_functions.up.sql:748`).
`app.remove_tyre` checks its back-date reason and stores it nowhere
(000039:405-411). All four write the reason onto the event row they insert,
on both the day path and the instant path. `app.fit_tyre` already does
(`db/migrations/000048_threshold_policy_in_force.up.sql:293-304`).

**Removal reason words.** A configuration key `removal_reason_labels`, a
jsonb object from code to words. The migration gives it to every tenant that
has `removal_reasons` in force, and the seeds and the provisioning template
carry it. The shipped words are Worn to threshold, Damage, Irregular wear,
Casing failure, Vehicle disposal, Rotation, Correction and Puncture.
`removal_reasons` and the check in `app.remove_tyre` do not change.

The down migration restores the six bodies as 000033, 000039, 000048 and
000062 left them and removes the key's rows.

### 2. API

- **Movements.** Fit, remove and rotate take `occurredOn`, a `YYYY-MM-DD`
  day, beside `occurredAt`. Sending both is refused as an invalid
  submission. Return to stock takes `occurredOn` for the first time. Rotate
  and return to stock take `backdateReason`. Fit keeps `reason` and remove
  keeps `backdateReason`, which are their names today
  (`api/internal/httpapi/fitments.go:31-41`, `:204-210`, `:286-291`;
  `tyres.go:571-578`). The handler passes the day through `dateField` and
  SQL does the rest.
- **The register read.** `GET /api/tyres` adds `costSource`, the stored
  `cost_source`. Its casing value becomes the valuation's, read from
  `app.v_tyre_valuation`, with `casingBasis` beside it. All three follow the
  money columns' capability rule.
- **The unit read.** Each open fitment whose last tread is a reading carries
  that reading's width-wise set in the shape the inspection read already
  uses (`inspection_reads.go:84-110`): the ordered readings, their anatomy,
  `orientationKnown`, the governing index, and the inspection the reading
  belongs to. The unit carries `removalReasonLabels`.
- **The fitments list.** Each row carries the position's `sequence`, and the
  query orders a unit's rows by it (`units.go:447-501`, today
  `ORDER BY v.fleet_number, p.code`).

### 3. Web: the tyre register (`web/src/fleet/tyres/`)

- **Basis.** Purchase price and cost per mm share one basis, the cost
  source. In words: "actual cost" for an invoice, "estimated" for a price
  list estimate, "source not recorded" for a figure with an unknown source.
  Casing value shows `basisLabel(casingBasis)`. No figure stands without its
  basis beside it, in the table and in the phone card.
- **Absence.** An absent figure reads "Not valued" through `moneyText`
  (`web/src/api/money.ts:52-56`), never a dash. A row is one tyre, so there
  is no count to put beside it.
- **State.** `tyreStateLabel` in `domain/vocabulary.ts`: In stock, Fitted,
  Removed, At retreader, At breakdown supplier, Scrapped, Sold, Lost. The
  State cell and any control that lists states use it.
- **Retreads.** A "Retreads" column for every tyre, the word
  `PositionPanel` uses.
- **Cost form.** `COST_WORDING.speakable` gains `TY012`
  (`CostForm.tsx:14-18`).
- `TyreList.test.tsx:476` looks for a header that no longer exists, so it
  passes whatever the screen shows. It is fixed to name "Cost per mm".

### 4. Web: the unit screen (`web/src/fleet/unit/`)

- **Occurred on.** `FitForm`, `RemoveForm` and `RotateForm` gain a date
  field labelled "Occurred on", with the hint `RigForm` uses, "Leave empty
  for today.", and the tenant's today as its latest day. When the day is
  earlier than today, a second field appears, "Why it is recorded late", and
  the form will not submit without it. The form sends `occurredOn` and the
  reason only then. The database decides. The form's check is there so the
  user sees the field before a refusal.
- **Unit status.** `UnitStatusForm` takes its selection from the unit read
  again whenever the unit's status changes under it, and "Set status" is
  disabled while the selection is the unit's current status. No API change
  (comment 13617).
- **Last tread.** When "Last tread" is a reading, its width-wise set is on
  the panel, drawn by `TreadReadings` from `readingCells`. `LatestReading`
  already draws the set of the unit's latest inspection. When both are the
  same reading the set appears once. When the latest inspection did not read
  the position, the set sits with "Last tread". Cells are named Outer, Centre
  and Inner only where `orientationKnown` is true, as `readingCells` decides
  today.
- **Removal reasons.** The Reason picker and the fitment history's Reason
  column show the words from `removalReasonLabels`. A code with no words
  shows the code, the fallback every label in `vocabulary.ts` has.
- **Locked fields.** The note under Details names what is locked and why:
  the axle layout and the unit kind, because the unit has fitments or
  inspections, and it says the fields below can still change. The axle
  layout is already plain text and the unit kind is not on the form, so no
  field changes state.
- **Rotate labels.** Each row's unit, target and tread inputs have a visible
  label, or sit under a visible column header they are tied to. The
  checkbox's accessible name is its visible text.
- The comment at `FitForm.tsx:21-23` describes `app.remove_tyre` and is
  wrong for this form. It is corrected.

### 5. Web: the rest

- **Return to stock** (`ReturnToStockButton.tsx`). Today stays one action.
  The control also offers "Occurred on" and the reason, as section 4
  describes, and `RETURN_WORDING.speakable` gains `TY014`.
- **Fitments list** (`web/src/fleet/FitmentList.tsx`). Rows sort by fleet
  number through `byNaturalCode` (`web/src/fleet/unit/naturalOrder.ts:5-7`),
  then by `sequence`.
- **Retread queue** (`web/src/fleet/RetreadQueue.tsx:185-244`). Report
  reference, Returned on, Retread cost, Post-tread, Casing value and Pattern
  each get a visible label through `Field`.
- **Reported differences** (`web/src/fleet/rigs/ReportedDifferences.tsx`). A
  successful Apply or Dismiss shows a `role="status"` line that names the
  rig, held by the section so it outlives the card, as `RetreadQueue` holds
  `closedCode`.
- **Role.** `roleLabel` in `domain/vocabulary.ts`: Driver, Technician,
  Controller, Depot manager, Organisation admin, Platform admin.
  `Chrome.tsx:34` and `AddDriver.tsx` both read it.
- **Icon.** `web/index.html` gains
  `<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />`.

## How we will know it worked

- **Suite** (`db/tests/004_tests.sql`, a new section, as `app_login`). For
  each of the four movements: today with no reason is stamped `now()`; an
  earlier day with no reason is `TY014`; with a reason it lands at the
  tenant's start of that day; a future day is refused. For the day rule: a
  movement for a day on which the tyre was already moved lands strictly
  after that movement and on the same tenant day; a day before the tyre's
  last movement is `TY012`; a removal for the day of a fitment that has no
  event lands after `fitted_at`; a tenant east of UTC gets its own day, not
  UTC's; no tyre ends with two state events at one instant. The event row of
  each back-dated movement carries the reason. A rotation more than 24 hours
  back succeeds with a reason, where suite 41v's note says it could not.
  For a position: a fit for the day its last tyre came off lands after that
  removal; a fit for a day before it came off is `TY012`; a fit at an
  instant before it came off is `TY012` too; and no two fitments of one
  position overlap. For dispatch and retread return: a removal and a
  dispatch both recorded for one earlier day land in that order at two
  instants, and so do a dispatch and a return on one day, with the return's
  money figures as they were. Every tenant with removal reasons has their
  words.
- `make db-test` passes with Appendix E and Appendix J unchanged, and
  `valuation-verifier` finds `app.log_retread_return`'s arithmetic
  untouched.
- **Go.** Each handler: `occurredOn` reaches SQL, a malformed day is
  refused, both fields together are refused. The register read: `costSource`
  and `casingBasis` present with the capability and absent without it, and a
  retreaded casing shows the retreader's value. The unit read: a position
  whose last tread is a reading carries the set, one with only a fitment
  tread carries none, and the labels are there. The fitments list: HORSE 2
  before HORSE 10 by sequence.
- **Vitest.** Register: basis words, "Not valued", state words, the retread
  count of an unfitted retreaded tyre, a cost `TY012` spoken. Status form: a
  status that changes between mount and submit is not overwritten, and the
  button is disabled when nothing changed. Forms: an earlier day shows and
  requires the reason, and the body carries both. Position panel: the set
  appears once in each of the two cases. Fitments list: LINK6 before LINK12.
  Retread queue and rotate form: inputs found by visible label. Reported
  differences: the status line after Apply and after Dismiss. Chrome: a role
  in words. `web/lint/webManifest.test.ts`: the icon link.
- **e2e.** `fitments.spec.ts` and `tyres.spec.ts` assert state words, and one
  fit and one removal are recorded for an earlier day. `rotation.spec.ts`
  records a rotation for an earlier day with a reason.
- These tests change because they pin the defect: `Chrome.test.tsx:188` and
  `:208` (the raw role), `UnitEditForm.test.tsx:62-70` (the old note),
  `ReportedDifferences.test.tsx:72-86` (no confirmation), and the e2e lines
  that expect `IN_STOCK`, `REMOVED`, `AT_RETREADER` and `SCRAPPED`.
- `web-design-guidelines` over the changed UI files, and `make check`.

## Left to the builder

- Whether the four functions take the day as a new argument or the handlers
  call the day rule in the same statement, so long as one function owns the
  rule and a concurrent movement cannot slip under it.
- The day rule's name, and where on the event row the reason sits.
- The wire shape of the reading set on the unit read, so long as
  `readingCells` can take it.
- How the return-to-stock control offers the day without a second step for
  today.
- Visible label or column header on each rotate row.
- The exact sentences of the locked-fields note and the status lines, under
  `/unslop`.
- Where the basis sits in the register's row and card.

## The SRS row

For the errata table at the top of Part 3, through the owner's Cowork agent
once the owner says yes.

| Requirement | Erratum | Amendment | Reason | Section |
| --- | --- | --- | --- | --- |
| **FR-FIT-016; BR-FIT-006** | (TYRE-240, U253, 25 Nov 2026) | Through the management interface an event is back-dated by day. It is stamped at the start of that day in the tenant's timezone, or directly after the last recorded movement of the tyre, or of the position it fills, when that falls on the same day. A day earlier than the day of that last movement is refused. A fit, a removal, a rotation or a return to stock recorded for a day earlier than the tenant's today always carries a reason. A caller that supplies a timestamp keeps the rule as written, with its 24 hours. | The office records a job card's date, not a time (U147, B41). The start of an earlier day is always at least 24 hours back, so the reason follows from the rule as written. Stamped at midnight alone, an event logged late for a day on which the tyre was already moved would be refused and recorded on the wrong day (U253). | §4.7 (Part 2); §6.5 (Part 4) |

## The owner's answers (25 Nov 2026, U253)

1. The register's casing value is the dashboard's figure.
2. A movement logged late for a day on which the tyre already has a recorded
   movement is accepted as that day's, placed directly after it. Any earlier
   day asks for a reason.

## Lead's calls

1. **The day goes on the wire and SQL applies the timezone.** Dispatch and
   retread return do this already (`tyres.go:495-499`, `:536`;
   `retreads.go:106`, `:151-158`; 000037:133-157).
2. **The stamp is strictly after the last movement, never equal to it.**
   Two state events at one instant leave `app.tyre_in_estate_asof` unable to
   order them (000039:784-790), and
   `db/migrations/000031_tyre_lifecycle_functions.up.sql:252` orders by
   `occurred_at` alone.
3. **A tyre's last movement includes its open fitment's `fitted_at`.**
   000039:348-360 and :602-614 give the reason: the pilot tenant's open
   fitments have no event.
4. **An earlier day needs a reason, and SQL says so.** The same-day stamp
   can fall inside 24 hours, so `app.fitment_instant_ok`'s clock test
   (000033:52-57) would let some earlier days through and the form could not
   tell which. One rule by day is what the user can predict.
5. **`occurredAt` stays, and both fields together are refused.** Tests and
   helpers stamp instants (`fitments_test.go:114-123`,
   `units_test.go:111-122`).
6. **Every movement stores its back-date reason.** 000048:293-295 states the
   principle, and 000039:405-411 breaks it.
7. **Removal reason words are a second configuration key.** It leaves
   `app.remove_tyre`'s check (000039:320-339), `units.go:210-230` and
   `db/seeds/seed_policy.py:63-75` as they are.
8. **The cost basis is the stored `cost_source`, put into words.** BR-VAL-002
   makes the cost source the provenance of the price and of everything
   derived from it, and 000050:78-81 reads it the same way.
9. **The casing value comes from `app.v_tyre_valuation`.** It is today's
   slice of the one valuation (`db/migrations/000011_sponsor_answer_surgery.up.sql:384-398`).
10. **The server sends position sequence and the web sorts fleet numbers.**
    TYRE-327 asks for the one comparator, which is `byNaturalCode`
    (`naturalOrder.ts:5-7`).
11. **The width-wise set shows once.** `PositionPanel.tsx:87-104` and
    `LatestReading.tsx:38-54` would otherwise draw the same reading twice.
12. **The icon is a link to the 192 pixel PNG already shipped.** A browser
    asks for `/favicon.ico` only "in the absence of a link with the icon
    keyword" (https://html.spec.whatwg.org/multipage/links.html#rel-icon).
13. **Dismiss confirms as Apply does.** They share one mutation shape and one
    silence (`ReportedDifferences.tsx:49-56`).
14. **Role and tyre state words live in `domain/vocabulary.ts`**
    (`web/CLAUDE.md`, the wire-code rule).
    *Amended at planning, 25 Nov 2026: `roleLabel` lives in
    `web/src/domain/roles.ts` instead. `Chrome.tsx` is in the capture
    entry's closure, and that entry may not import `vocabulary.ts`
    (`web/CLAUDE.md`, the wire-code rule's exceptions;
    `web/src/capture/place.ts:3`). `web/CLAUDE.md` names the new file
    beside the other two exceptions. Tyre state words stay in
    `vocabulary.ts`.*
15. **The retread count shows for every state.** It is a fact about the
    casing, and a column that appears for one state is harder to read than
    one that says 0.
16. **Placement also reads the position's last closure, and an instant
    before it is refused on either path** (builder check, question 1).
    BR-FIT-002 holds at every instant, and 000001:305-306 holds it only for
    open fitments. Without this, a fit recorded for Monday overlaps the tyre
    that came off that position on Monday afternoon.
17. **Dispatch and retread return take their stamp from placement** (builder
    check, question 2). Their guards let a tie through (000048:380-385,
    000062:656-662), and this branch makes the tie ordinary. They gain no
    reason: neither takes one today, and B41 names four forms.
18. **The day rule does not read rigs.** A rig set live and a cross-unit
    rotation recorded late for that same day is rare, the refusal is
    already worded, and the cost is a third input to placement with no
    clear answer when a unit sat in two rigs on one day.
