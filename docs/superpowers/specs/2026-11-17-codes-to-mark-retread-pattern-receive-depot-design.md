# Codes to mark, the retread return's pattern, the depot at Receive, and what is left of PR #139's set-aside list

Date: 2026-11-17. Tickets: TYRE-99 (the launch key), carrying TYRE-102
(with TYRE-420 folded in) and TYRE-450, all under epic TYRE-55. Run queue
row 1 (`docs/implementation-order.md`, The run queue). Status: approved by
the owner on 17 Nov 2026 (U230).

Owner rulings this rests on: U147 (21 Oct 2026) answers B22, B23, B39 and
B40; TYRE-99 comment 13204 (24 Sep 2026) on what `brand_pending` means;
and six answers given in this run on 17 Nov 2026: U224 (who marks), U225
(a return with no retread pattern to choose), U226 (which set-aside items
are fixed), U227 (the pattern in the tyre's history), U228 (the price
check) and U229 (the raw price write is ticketed, not fixed here).

Requirements this touches: FR-TYR-035, FR-TYR-040, FR-TYR-042 and
FR-TYR-004 as amended by errata D12 (display codes); FR-FIT-021,
FR-TYR-018 and FR-CFG-004, FR-CFG-007 (the retread return's pattern);
FR-TYR-012 and FR-TEN-013 (a tyre's depot); FR-AUT-007 to FR-AUT-009 (who
holds asset management). Three rows need an erratum (SRS consequences).
CLAUDE.md rules 1, 2, 3 and 6.

## Intent

Four pieces of work ship as one PR because the pilot audit paired them.

1. **Codes to mark.** Under a GENERATED code policy the platform issues a
   tyre's display code at Receive, and somebody then has to mark it on the
   sidewall. Nothing records whether that happened. The column for it,
   `app.tyre.brand_pending`, has existed since 000011 with no writer and no
   reader. A fleet that receives 200 tyres has no list of the ones still
   unmarked, and an unmarked tyre cannot be identified in the yard.
2. **The retread return's pattern.** A retreaded tyre comes back carrying
   the retreader's tread, not the tread it was bought with. The return
   form has no pattern field, so the register keeps the bought pattern,
   and the database accepts any pattern a raw call names, including a
   deactivated one or a new-tyre one.
3. **The depot at Receive.** The Receive form never sends a depot, so every
   received tyre has none and every receipt's depot reads "Not recorded".
   TYRE-100's transfer between depots assumes a tyre has one.
4. **PR #139's set-aside list.** The audit ruled its bugs fixed here. Five
   are still bugs on today's code.

## What the spec-stage reading showed

Each point changes the work as the tickets describe it.

1. **Receive already writes a `BRANDED` event.** `app.receive_tyres` writes
   one per tyre under both policies, with payload `{display_code}`
   (`db/migrations/000059_consent_price_list_receipt.up.sql:629-633`), and
   `app.tyre_for_code` resolves a code by date from the latest one
   (000031:239-256). So marking writes a second `BRANDED` event that
   repeats the code. It does not write the first.
2. **Nothing sets `brand_pending`.** The tyre INSERT in `receive_tyres`
   does not list the column (000059:617-624). The only `true` in the repo
   is a raw insert in suite section 22 (`db/tests/004_tests.sql:2147`),
   which asserts nothing about it.
3. **The app role can rewrite the flag today.** `app_rw` holds `UPDATE` on
   `app.tyre` at table level (000001:575; `db/CLAUDE.md`, Append-only).
   TYRE-99's definition of done asks the suite to prove it cannot clear
   the flag directly, so the grant has to change.
4. **SQL knows no roles.** Capabilities live in Go
   (`api/internal/auth/auth.go:68-74`) and 000060:980-981 says role names
   do not belong in SQL. "Refuses a driver" is therefore a capability
   check in the handler, as for every other tyre write.
5. **TYRE-420's line numbers are stale.** The current
   `app.log_retread_return` is 000054:139-414, not 000048. Its pattern
   check is 000054:317-320: the id must be visible, and nothing else.
6. **No test anywhere sends a return pattern.** No SQL, Go, vitest or e2e
   case passes `p_new_pattern_id` or `newPatternId`.
7. **The retread jobs read carries no pattern.** `GET /api/retread-jobs`
   returns the tyre's id and code only
   (`api/internal/httpapi/retreads.go:23-28`), so the form cannot pre-select
   or compare without a new field.
8. **`receive_tyres` takes any depot id.** It inserts `depot_id` raw into
   the receipt and the tyre (000059:593-599, 617-623). An unknown or
   foreign id fails the foreign key as a canned 23503
   (`api/internal/httpapi/refusal.go:142`); an inactive depot, a retreader
   or a breakdown supplier is accepted (TYRE-450 comment 14154).
9. **Patterns load only from provisioning.** No route writes the catalogue.
   TYRE-417's admin screen is post-POC. The platform catalogue seeds three
   patterns, all for new tyres (000058:76-79), and the BAC fixture has one
   (`db/seeds/gen_seed_fixture.py:299`). Sandbox Fleet has `SBX Retread`.
10. **PR #139's "18 bugs" were never listed.** The pilot plan holds the
    count and no list. All 30 set-aside items were read against today's
    code (the table at the end).

## Goals

- A tyre received under GENERATED starts pending; one received under FREE
  does not (B22).
- A controller, depot manager or organisation administrator records the
  marking, for one tyre or for every pending tyre on a receipt. The record
  is a dated `BRANDED` event and the flag clears (B22, U224).
- The register has a "Codes to mark" filter with a count, and a pending
  tyre reads "Code not yet on the sidewall".
- The app role cannot change the flag by a raw `UPDATE`, and one tenant
  cannot list or mark another's pending tyre.
- An accepted retread return always leaves the tyre on an active pattern
  that applies to retreads, named or kept, by a rule in the database (B23,
  U225, TYRE-420), and the form offers the picker (TYRE-102).
- The return event records the pattern the tyre went out on and the one it
  came back on (U227).
- Receive names the depot or store that takes the stock, required when the
  fleet has one (B39), and the database refuses a depot that is not an
  active depot or store of the fleet.
- The five set-aside bugs are fixed, each in its own commit with a
  regression test that fails first (U226), and the three price fields name
  themselves when the price is not a readable number (U228).

## Non-goals

- A technician screen, endpoint or permission for marking (U224).
- A tyre history endpoint or screen. TYRE-287 builds it (U227).
- A screen that adds or deactivates patterns (TYRE-417, post-POC).
- Blocking the fitting or dispatch of a pending tyre, or any change to the
  fit and dispatch pickers. The replacement definition of done (comment
  13903) names the register only.
- A backfill. Tyres already received keep `brand_pending = false` and
  their depot, set or not. The migration cannot know which codes are on a
  sidewall, production holds no tenant yet
  (`docs/implementation-order.md:285-286`) and staging holds only
  demonstration and sandbox data.
- Narrowing the depot a depot-scoped user may choose at Receive.
  Write-side depot scoping is deferred for every asset write (Decision D8,
  Confluence page 16089089).
- The depot of a tyre that returns from a retreader. `log_retread_return`
  sets it to NULL today (000054:353-365) and TYRE-100 owns stock location.
- Any of the 27 set-aside items that are not bugs, other than the price
  check.
- Closing the app role's raw `INSERT` on `app.tyre` or `app.tyre_event`. A
  raw insert can still plant a tyre with any flag, or a `BRANDED` event the
  function did not write. The definition of done asks only that the flag
  cannot be cleared directly.
- Closing the app role's raw `UPDATE` of a tyre's price columns. The new
  column grant keeps `purchase_price`, `cost_source` and `rand_per_mm`,
  because four invoker functions write them. A raw call can therefore
  still unprice a tyre on a receipt in a final state, which no function
  can then price again. The defect is older than PR #139 and sits under
  its item R10b. Closing it means moving `set_tyre_cost` and the three
  receipt functions to the write list, several times this spec's database
  work. The owner ruled it out of this PR and it is ticketed as TYRE-489
  (U229).

## Anti-goals

- No second implementation of "which tyres are pending" in Go or
  TypeScript. The register reads a view.
- No role name in SQL.
- No trigger that trusts a session setting to tell the marking function
  from a raw write (ADR-0024, Option D, rejected for that reason).
- No edit to a migration already on `origin/develop`.
- No weakening of a suite assertion to make a restaged test pass. A test
  that plants a tyre, a receipt or a return gains the depot or pattern the
  new rule asks for.

## Constraints

- Tenant isolation holds in the database (rule 1). Every read and write in
  a new or restated function names `app.current_tenant_id()`, and a
  refusal for a missing id, another tenant's id and an inactive row reads
  the same, as 000059:470-474 explains.
- Events are append-only (rule 3). Marking appends; it never edits the
  receipt-time `BRANDED` event.
- Money stays `numeric` and is never parsed to a JavaScript number (rule 2).
  The price check is a pattern test on the typed string.
- Dates are the tenant's days (rule 6): "today" is `app.tenant_today`, and
  a day becomes an instant through `app.tenant_day_instant` (000037:133-157).
- A new write-list definer follows `db/CLAUDE.md`, Adding a function, line
  by line.
- The migration must run as a role that is not a superuser, as 000061 does
  (`docs/superpowers/specs/2026-11-16-trip-writes-through-definer-design.md`,
  sections 4 and 9).
- A down file restores the state its up file found, proved by catalogue
  (`docs/lessons.md`, 2026-10-01, Down files restore state).
- Web follows ADR-0015 and ADR-0020: the native Tread `Select` inside
  `Field`, no new component library (`web/CLAUDE.md`).
- User-facing strings and comments follow `docs/comments.md`.

## Approaches

**Holding the flag against the app role.** Three ways were weighed.

- *A column-level grant and a write-list definer (chosen).* `app_rw`'s
  `UPDATE` on `app.tyre` becomes a grant on every column but
  `brand_pending`, and the marking function runs as `app_writer`, the
  NOLOGIN role row security binds. This is ADR-0024's decision applied to
  a fourth function, which that record says to do by reusing the role. Its
  cost: `app_writer`'s grant list grows and is pinned, and a later column
  on `app.tyre` needs its own grant, which a suite pin catches.
- *A trigger that refuses a change the function did not make.* The app
  role can set any custom setting, so the flag would be one `SET LOCAL`
  from a raw write. ADR-0024 rejected this as Option D.
- *No column: derive "pending" from events.* A tyre would be pending while
  it has no marked `BRANDED` event. The app role can insert a raw event,
  so the flag could still be cleared directly, and the column is in the
  SRS data model already (CHG-022).

**Where the two "required" rules live.** B23's pattern and B39's depot
could be required by the form alone, with the database checking only a
value that is sent. They go in SQL instead. CLAUDE.md puts a business rule
about tyres in SQL, a raw call would otherwise skip both, and an integrity
rule is cheap before pilot data exists and dear after
(`docs/implementation-order.md`, Two ordering rules). The cost is
restaging: 36 `receive_tyres` calls in the two suite files, the Go tests
that post a tyre, and every accepted return in the suites gain a depot or
a pattern.

**Closing the consent lockout.** The raw `INSERT` on `tenant_consent`
could be revoked and `record_consent` moved to the write list. A trigger
that refuses a future-dated row for every role is chosen instead. Being
dated in the future is the one raw row that does harm, the rule is an
invariant of the row and not a test of who wrote it, suite section 75b and
`make record-consent` keep working, and the table's other written-once
rule is already a trigger for every role (000059:41).

## The design

### 1. `receive_tyres` sets the flag

`app.receive_tyres` is restated from 000059. The tyre INSERT sets
`brand_pending` to true when the tenant's `display_code_policy` is
`GENERATED` and false when it is `FREE`. The Receive form gains no field
for it. The receipt-time `BRANDED` event is unchanged.

### 2. The marking function

`app.mark_code_on_sidewall(p_tyre uuid, p_receipt uuid, p_marked_on date)`
is the one writer of the flag after receipt. Exactly one of `p_tyre` and
`p_receipt` is given. It returns the tyres it marked, as id and display
code.

- **One tyre.** The tyre must be the tenant's, pending, and still in the
  estate (not `SCRAPPED`, `LOST` or `SOLD`).
- **A receipt.** The receipt must be the tenant's. Every tyre on it that is
  pending and still in the estate is marked. A receipt with none is
  refused.
- **The day.** `p_marked_on` NULL means the tenant's today. A future day is
  refused, and so is a day before the tyre's `received_date`. For a
  receipt, the day is judged against each tyre it would mark.
- **What it writes, per tyre.** One `tyre_event` of type `BRANDED`, payload
  `{"display_code": <the tyre's current code>, "marked": true}`, with no
  `to_state`; and `brand_pending = false`.
- **The event's instant.** `app.tenant_day_instant(p_marked_on)`, and never
  earlier than the tyre's `RECEIVED` event. Receive stamps a back-dated
  receipt at that day's UTC midnight (000059:421-426), which for a fleet
  east of UTC is later than the same day's local midnight, so a marking
  dated on the day of receipt would otherwise sit before the receipt in
  the tyre's history. `receive_tyres` keeps its stamp: the UTC day is the
  register's standing convention and TYRE-123 owns moving it.
- **Refusals.** All `TY012`, the tyre lifecycle's code, each with its own
  message. A missing tyre, another tenant's and no tenant bound read alike
  ("no such tyre in this fleet", as 000059:659-668), and the same holds
  for a receipt.

It is a write-list definer: `SECURITY DEFINER`, owned by `app_writer`,
`search_path` pinned, `EXECUTE` revoked from PUBLIC and granted to
`app_rw`, on the write list in check 8c, section 67a and
`pg_temp.app_writer_faults`. `app_writer` is granted what its call tree
needs and no more, each grant naming the statement that needs it. The
triggers on `app.tyre` run as `app_writer` inside it, so their writes
count.

### 3. The grant on `app.tyre`

The migration revokes `app_rw`'s table-level `UPDATE` on `app.tyre` and
grants `UPDATE` on every column except `brand_pending`. `INSERT` and
`SELECT` stay at table level. Every invoker function that updates a tyre
keeps working, since none writes the flag.

### 4. The queue and the register read

A view, `app.v_tyre_code_to_mark`, with `security_invoker = true`, holds
the rule: a tyre that is pending and still in the estate, shaped like
`app.v_tyre_awaiting_cost` (000012:506-519).

`GET /api/tyres` (`api/internal/httpapi/tyres.go:108-183`) joins it:

- each tyre row gains `codePending`, a boolean;
- `?codesToMark=true` keeps only pending rows, and combines with
  `awaitingCost` as a further filter;
- the response gains `codesToMark`, the count of the view's rows for the
  tenant, whatever filter is applied.

### 5. The marking routes

- `POST /api/tyres/{tyreID}/code-marked`
- `POST /api/tyre-receipts/{receiptID}/codes-marked`

Each takes `{"markedOn": "YYYY-MM-DD"}`, optional. Each requires
`auth.ManageAssets`, which a driver and a technician do not hold (U224),
and answers with the tyres marked. `TY012` is already forwarded as a 422
with its message.

### 6. The register screen

`web/src/fleet/tyres/TyreList.tsx`:

- a "Codes to mark" filter beside "Awaiting cost only", showing the count
  from `codesToMark`;
- a pending row reads "Code not yet on the sidewall";
- a pending row offers a marking action that takes the day, today by
  default. When the tyre's receipt has other pending tyres, the action
  offers to mark all of them in one go.

The Receive form's hint under GENERATED already tells the receiver to mark
the sidewall (`web/src/fleet/ReceiveTyre.tsx:262-271`) and stays.

### 7. The retread return's pattern, in SQL

`app.log_retread_return` is restated from 000054. On an accepted casing:

- A pattern that is sent must be the tenant's, active and one that applies
  to retreads (`RETREAD` or `BOTH`). A missing id, another tenant's and a
  deactivated one share one message; a new-tyre pattern has its own. Both
  mirror `receive_tyres`' catalogue refusals (000059:470-511).
- When none is sent, the tyre keeps its pattern only if that pattern is
  active and applies to retreads. If the tyre's pattern is a new-tyre one,
  or deactivated, or it has none, the return is refused with a message to
  choose the retread pattern, or to ask an administrator to add one when
  the list is empty (U225). So the database and the form agree: a return
  always names, or keeps, a pattern the form could offer.
- The `RETURNED` event's payload gains `pattern_id`, the pattern the tyre
  came back on, and `previous_pattern_id`, the one it went out on (U227).

A rejected casing takes no pattern, as today. The refusals keep the
function's code, `TY014`.

### 8. The return form

`GET /api/retread-jobs` gains the tyre's current pattern id and name.
`web/src/fleet/RetreadQueue.tsx`, with the casing accepted:

- a Pattern select offers the active patterns that apply to retreads, from
  the tyre catalogue read Receive already uses;
- the tyre's current pattern is pre-selected when it is in that list, and
  otherwise the field starts empty and must be chosen (B23);
- `newPatternId` is sent only when the choice differs from the tyre's
  current pattern;
- with no retread pattern in the catalogue, the form says so and what to
  do, and does not send.

The comment at `RetreadQueue.tsx:47-48`, which says no pattern read
exists, goes.

### 9. The depot at Receive

In `app.receive_tyres`, restated once with section 1:

- a `depot_id` that is sent must name an active `DEPOT` or `STORE` of the
  tenant. A missing id, another tenant's, an inactive depot and one of
  another type share one `TY011` message, in the words
  `app.return_tyre_to_stock` uses (000033:738-748);
- when none is sent and the tenant has an active `DEPOT` or `STORE`, the
  receive is refused with `TY011`, asking for the depot or store that
  takes the stock.

`web/src/fleet/ReceiveTyre.tsx` gains a Depot select offering the fleet's
active depots and stores from `GET /api/depots`. It is required when that
list is not empty, pre-selected when exactly one of the offered depots is
among the user's own (`me.depots`), and absent when the list is empty. The
open receipts screen already shows `depotName`.

### 10. The set-aside bugs, one commit each

| # | Defect | Fix | Regression test |
|---|---|---|---|
| 1 | A raw insert as the app role can date a `tenant_consent` row in the future. It becomes the current consent, and `record_consent` then refuses every later record for the purpose, a withdrawal included (R10a, X7). | A `BEFORE INSERT` trigger on `tenant_consent` refuses a row dated after `now()`, for every role, with `TY027`. | Suite section 75: a raw future-dated insert as `app_login` is refused. |
| 2 | Receive has no price guard: `NaN` is refused as a rate above what the register carries, and a negative price as a raw 23514 with the canned `invalid_submission` (X12). | `receive_tyres` refuses a price that is `NaN` or negative with `TY011` and a message that names the price. | Suite section 75g, one row each. |
| 3 | The rate refusal says "check the price entered" on a list-price move, where nobody entered one, and names no subject (R3). | `app.costed_rand_per_mm` is restated with a message true on both routes that names what it was rating. | Suite section 75j: a list entry large enough to cross the bound, the message pinned. |
| 4 | The U144 refusal shows the latest consent's time in the session's timezone, not the fleet's (X5, rule 6). | `app.record_consent` formats it in the tenant's timezone. | Suite section 75a under another session `TimeZone`. |
| 5 | The receipts table's row header is its seventh cell, so the six cells before it are announced without it (R1). | The codes cell becomes the first column of `ReceiptList.tsx`. | `ReceiptList.test.tsx`: the row header is the row's first cell. |
| 6 | Not a bug, scheduled by U228: a price that is not a readable number (a decimal comma, letters) is refused as "invalid" with no field named. | `ReceiveTyre.tsx`, `InvoiceForm.tsx` and `CostForm.tsx` test the typed price against one shared pattern (digits, an optional point and one or two decimals) and show the field's error, as the tread field does (`ReceiveTyre.tsx:353-371`). | One vitest per form: the POST is not sent and the field carries the error. |
| 7 | Found on the way: the comment at `web/src/api/refusal.ts:7-8` says `invalid_submission` carries a field-level message. The canned class 22 and 23514 refusals do not. | The comment is corrected. | None can fail first for a comment. |

Migrations on this branch stay editable until it merges, so a later commit
may add its fix to a migration an earlier commit of the branch created.

### 11. The suite

`db/tests/004_tests.sql` gains, in new sections after 76:

- **Codes to mark.** Receive under GENERATED is pending and under FREE is
  not. Marking one tyre and marking a receipt write the event with the
  code and `marked` and clear the flag. Each refusal: not pending, a
  future day, a day before receipt, a tyre that left the estate, a receipt
  with nothing to mark. As a second tenant, the view shows none of the
  first tenant's rows and marking its tyre or receipt reads "no such". As
  `app_login`, a raw `UPDATE` of `brand_pending` is refused, to false and
  to true. The column pin: `app_rw` holds `UPDATE` on every column of
  `app.tyre` but that one.
- **The return's pattern.** A deactivated pattern, another tenant's, one
  nobody holds and a new-tyre one are each refused; a `RETREAD` and a
  `BOTH` pattern are accepted; no pattern on a new-tyre tyre is refused,
  with and without a retread pattern in the catalogue; no pattern on a
  tyre already on an active retread pattern keeps it, and on one whose
  retread pattern was deactivated is refused; the event carries both
  pattern ids.
- **The depot.** An unknown depot, another tenant's, an inactive one and a
  retreader are each refused with the one message; none sent is refused
  when the tenant has a depot and accepted when it has none.

Checks 8c, 8e and 67a gain the fourth definer. `db/tests/005_privileged.sql`
gains a probe of the marking function after `SET LOCAL ROLE app_login`
with the other tenant bound, since a block that runs as `postgres` proves
nothing about isolation.

### 12. Documents

- `docs/adr/0024-trip-writes-run-as-a-definer-rls-binds.md`: a dated
  amendment naming the fourth function, as its Revisit line asks.
- `db/CLAUDE.md`: the write list gains the function, and Append-only says
  how `brand_pending` is held.
- `docs/adr/0008-tyre-identity-and-display-codes.md`: action item 3 is
  marked done, with what "pending" now means under GENERATED.
- `docs/architecture.md` and `api/internal/httpapi/refusal_codes.json`:
  the new raisers of `TY011`, `TY012`, `TY014` and `TY027`.
- `docs/runbooks/provision-a-tenant-catalogue.md`: a fleet that retreads
  lists its retreader's patterns, since a return is refused without one.
- `docs/runbooks/provision-a-tenant.md` or the consent runbook, if either
  shows a refusal this changes.

## SRS consequences

Three rows no longer match what the owner decided on 21 Oct (U147) and
17 Nov. The prepared rows go to the owner's SRS Cowork agent as
`docs/HANDOFF_srs_errata_TYRE-99_2026-11-17.md` once this spec is
approved, and their paste is a step the owner owes after the merge.

- **FR-TYR-035.** Pending is no longer "found unbranded during
  onboarding". It is every tyre whose code the platform issued, until a
  controller, depot manager or administrator records the marking (B22,
  U224).
- **FR-TYR-040.** Receive does not ask whether the tyre is branded or
  pending; the code policy decides. Receive names the depot or store that
  takes the stock, required when the fleet has one (B22, B39).
- **FR-FIT-021** (and FR-TYR-018 by reference). The retread pattern is an
  active pattern that applies to retreads (FR-CFG-004), required when the
  tyre went out on a new-tyre pattern (B23, U225).

FR-FIT-018 names the controller and the administrator only, while
FR-AUT-008 and Decision D8 give a depot manager the same asset rights.
Marking follows the capability, so a depot manager may mark. That is the
standing reading for every asset write, not a new conflict.

## Definition of done

1. A tyre received under GENERATED is pending and one under FREE is not.
2. Marking one tyre, and marking a receipt, write a dated `BRANDED` event
   that repeats the code with `marked: true` and clear the flag. A tyre
   that is not pending, a future day and a day before receipt are refused.
3. A driver and a technician are refused at both routes (Go test).
4. The register shows the "Codes to mark" filter with its count, and
   "Code not yet on the sidewall" on each pending tyre (vitest, and the
   Sandbox e2e in `web/e2e/tyres.spec.ts`: receive, see it pending, mark
   it, see it leave the filter).
5. The suite proves one tenant cannot list or mark another's pending tyre,
   and that `app_login` cannot change the flag by a raw `UPDATE`.
6. An accepted return naming an inactive pattern or a new-tyre one is
   refused, each with its own message; `RETREAD` and `BOTH` are accepted;
   a return with no pattern on a new-tyre tyre is refused.
7. The return form offers the picker, pre-selects as section 8 says and
   sends `newPatternId` only when it differs (vitest); the register shows
   the new pattern after a return on a new pattern (the Sandbox e2e in
   `web/e2e/fitments.spec.ts`).
8. The `RETURNED` event carries both pattern ids.
9. Receive offers the fleet's active depots and stores, requires one when
   there is any and pre-selects the user's own single depot; a vitest
   proves the depot reaches `POST /api/tyres`.
10. `receive_tyres` refuses a depot that is not an active depot or store
    of the tenant with `TY011`, and a missing one when the tenant has any.
11. Each row of section 10's table is its own commit with its test.
12. Every down file restores what its up file found, proved by catalogue.
13. `make check` is green.

## After the merge, for the owner

- Staging's migrate (`docs/runbooks/environment-release.md`, Each release).
- The SRS rows above, pasted by the Cowork agent.
- BAC's provisioning file lists its retreader's patterns before the first
  retread return is logged (U225).

## Ruled by the owner at approval

One question came from the builder check, and the owner answered it with
the approval (U229, 17 Nov 2026).

The app role can still change a tyre's price by a raw `UPDATE` (Non-goals,
last item). This spec rewrites the grant on `app.tyre`, so a reviewer may
class that older defect as on this branch's path. The owner ruled that it
is not fixed in this PR. It is TYRE-489, raised as TYRE-467 was for
`app.combination`. The app reaches the database only through the API,
which never issues that statement, so the exposure is a raw session with
the app login.

## Lead's calls

Each is an engineering question settled without the owner, with its source.

1. **The flag is held by a column grant and a write-list definer.**
   ADR-0024's decision and its Revisit line
   (`docs/adr/0024-trip-writes-run-as-a-definer-rls-binds.md:109-116,
   156-161`); `db/CLAUDE.md:104-129`; column privileges,
   https://www.postgresql.org/docs/16/sql-grant.html; the same shape as
   `inspection` and `tyre_receipt` (`db/CLAUDE.md:166-198`).
2. **One marking function with two id arguments, exactly one given.** One
   rule and one definer to pin, where two functions would be two entries
   on every write-list check (`db/CLAUDE.md:114-127`).
3. **Refusal codes follow the function's family.** `TY012` for marking
   (000059:659-668), `TY014` for the return (000054:317-320), `TY011` for
   Receive (000059:470-511), `TY027` for consent (000059:87-90).
4. **"Refuses a driver" is the handler's capability check.**
   `api/internal/auth/auth.go:68-74`; 000060:980-981.
5. **The queue is a `security_invoker` view the register joins**, as the
   awaiting-cost queue is (000012:506-519;
   `api/internal/httpapi/tyres.go:141-157`).
6. **Both "required" rules are in SQL.** CLAUDE.md, Where logic belongs;
   `docs/implementation-order.md`, Two ordering rules.
7. **A depot at Receive is a `DEPOT` or `STORE`.** `app.return_tyre_to_stock`
   (000033:738-748) and B12 of U147 use the same pair for stock.
8. **The marking day may be back-dated to the day of receipt and no
   earlier, and never forward**, as `receive_tyres` and `dispatch_tyre`
   treat their days (000059:416-420; 000048:356-370).
9. **No backfill of the flag or the depot.** `docs/implementation-order.md:285-286`.
10. **The consent lockout closes with a trigger, and the grant stays.**
    Approaches, above; 000059:41 is the precedent.
11. **The price check refuses with a message and converts nothing.** A
    decimal comma is ambiguous beside a thousands separator ("1,234"), and
    the tread field already refuses a bad shape in place
    (`web/src/fleet/ReceiveTyre.tsx:353-371`).
12. **A return keeps the tyre's own retread pattern only while it is
    active.** A retread is a new use of a pattern, and FR-CFG-007's
    deactivation is what stops new use. One rule for the database and the
    form, where keeping a deactivated one would have the database accept a
    return the form cannot send (builder check, 17 Nov 2026).
13. **A marking is never stamped before its tyre's receipt.** The clamp is
    local to the new function. `app.fitment_instant_ok` holds the same
    order for lifecycle events (000033:46-51). Moving Receive's stamp to
    the tenant's midnight would re-date every back-dated receipt and
    belongs with TYRE-123 (builder check, 17 Nov 2026).
14. **The consent refusal alone moves to the tenant's timezone.** TYRE-131
    owns the other refusal messages that print an instant.
15. **The fit and dispatch pickers are unchanged.** The replacement
    definition of done (TYRE-99 comment 13903) names the register only.

## Left to the builder

- How many migrations, from 000062, and which fix lands in which.
- The exact `app_writer` grants, derived from the function's call tree.
- Every message's wording, within `docs/comments.md`, and the layout of
  the marking action and the pickers within Tread.
- The JSON shape the two marking routes answer with.
- The names of the new suite sections and the 005 probe.
- Whether the retread jobs read gains its two fields in the existing query
  or a join.
- How each restaged test gets its depot or retread pattern.

## Rejected

- **A technician "Codes to mark" screen.** U224.
- **A field at Receive for branded or pending.** B22: the policy decides.
- **Letting a return through on the bought pattern when the catalogue has
  no retread pattern.** U225.
- **A tyre history view in this PR.** U227, TYRE-287.
- **Revoking the app role's `INSERT` on `tenant_consent`.** Lead's call 10.
- **Accepting a decimal comma.** Lead's call 11.

## PR #139's set-aside list, item by item

Read against `develop` at `b503c57f` and the bug definition in
`docs/how-work-runs.md`. S is the self-review list, R the stage 5 list, X
the scoped re-review list, in the order of the PR body.

| Item | What | Verdict |
|---|---|---|
| S1 | An absent `receiptId` reads as a receipted tyre | Not a bug: Go always sends the field, and no rollback crosses #139 |
| S2 | Threshold rows keyed by scope label | Not a bug: group names are unique per tenant |
| S3 | "Not valued" beside "Awaiting its price" | Not a bug: both true, a wording nit |
| S4 | A typed price is sent unchecked (invoice, Receive, cost forms) | Not a bug: a missing convenience. Scheduled by U228 (section 10, row 6) |
| S5 | Receive disabled about seven seconds on a failing estimate read | Not a bug: latency, and the settled result is right |
| R1 | The receipts row header is the seventh cell | Bug, fixed (row 5) |
| R2 | 75h and 75g test gaps | Not a bug: the gaps hide none |
| R3 | The rate refusal's wording on a list-price move | Bug, fixed (row 3) |
| R4 | "undefined days ago" under a partial rollback | Not a bug: unreachable, as S1 |
| R5 | No comment citing TYRE-76 on the receipt routes | Not a bug: a missing comment |
| R6 | "Price it on its receipt" links to the list | Not a bug: a missing feature |
| R7 | The list price in TY011's message | Not a bug: every role that sees it holds ViewValuation |
| R8 | "No imported history" for a NULL horizon | Not a bug: activation stamps the horizon before any sign-in |
| R9 | P15 and check 8b coverage | Not a bug: the gaps hide none |
| R10a | Raw insert into `tenant_consent` | Bug, fixed (row 1) |
| R10b | Raw insert of a receipt in a final state | Not a bug on its own; the defect under it is a raw write to `app.tyre`, ticketed as TYRE-489 (U229) |
| R11 | `tenant_days_since` runs per row | Not a bug: performance |
| R12 | `receive_tyres` keeps its own rate rule | Not a bug: same outcome for every input |
| R13 | `formatMm` misses; CaptureStart's browser-clock days | Already fixed: TYRE-443 (8094e8ac), U164, TYRE-342 (edf8ad12) |
| X1 | `Infinity` refused as a bare 22003 | Not a bug: the canned refusal any oversize figure gets (U189) |
| X2 | NaN rows run on unretreaded tyres only | Not a bug: the guard runs before the branch |
| X3 | A pattern change drops a typed price | Not a bug: Decision 24 |
| X4 | `invoiceNumber` not cleared with the price | Not a bug: Decision 22 still holds |
| X5 | The U144 refusal's timezone | Bug, fixed (row 4) |
| X6 | The read-then-insert race | Not a bug: Decision 25 left it open |
| X7 | A future-dated raw insert locks out later consent | Bug, the same defect as R10a (row 1) |
| X8 | The runbook shows no three-argument call | Not a bug: the line is true |
| X9 | The confirmation lost "stays unpriced" | Not a bug: the wording is still true |
| X10 | The NaN comments cite no ID | Not a bug: a style nit in an applied migration |
| X11 | `current_tenant_id()` called per lookup | Not a bug: nothing changes it mid-call |
| X12 | `receive_tyres` has no price guard | Bug, fixed (row 2) |
