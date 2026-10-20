# Design: the consent record, the price list at receipt, and a manager's view of the fleet's settings (TYRE-283)

- **Date:** 2026-10-20
- **Ticket:** TYRE-283, under epic TYRE-3. It folds in TYRE-418's Receive
  form change (see "Calls made here").
- **Decisions it rests on:** the owner's answers in the TYRE-283 spec
  session, 20 Oct 2026, recorded below under "Decisions". Owner ruling U143
  (TYRE-283 comment 13866), which supersedes U93. The owner's 15 Oct 2026
  decision on TYRE-418 (comment 13743: no supplier for the POC). ADR-0008
  (tyre identity and display codes), ADR-0010 (provenance), ADR-0012
  (refusal contract), ADR-0013 (a write with a rule of its own is a SQL
  function), ADR-0014 (audit).
- **Requirements:**
  - Consent: FR-TEN-022.
  - Price list: FR-CFG-040, FR-CFG-041, FR-CFG-042.
  - The reads the ticket makes acceptance criteria: FR-TEN-021, FR-CFG-005,
    FR-CFG-012, FR-CFG-021, FR-CFG-022, FR-TYR-017.
  - Receipt and cost: FR-TYR-040 (as amended by TYRE-418), FR-TYR-041,
    FR-VAL-006, CR-012.
  - Money hidden from drivers: FR-AUT-005a.
  - POC scope: SRS H.1 (TEN 021..022, CFG 040..045).

## Why this exists

Three tables have no writer, or no reader. `app.tenant_consent` is written
only by the provisioning script, as raw inserts with no rule behind them.
`app.tyre_price_list` is loaded by `app.provision_catalogue` (TYRE-369) and
read by nothing: Receive tyres never offers its price. And five tenant
settings the SRS says a manager can see (history horizon, catalogue lineage,
the warning threshold, units and currency, tread age) appear nowhere in the
app. The web hardcodes "R", "kPa" and "km".

The consent ledger is H.1's own "cheap now, impossible later" item: consent
cannot be granted retroactively.

## What changed from the ticket as written

U143 (20 Oct 2026) rules that drivers never create tyres: the fleet
controller builds the register through Receive and fit. Three of the
ticket's items follow from it:

- `inspection.tyres_created` leaves this ticket. No inspection creates a
  tyre, so the counter would always read zero. TYRE-286 drops the column by
  migration (TYRE-439). The ticket's definition-of-done line for it is
  superseded.
- Inspection duration is already recorded on every submit
  (`inspection.duration_seconds`, migration 000041). Nothing here touches it.
- This ticket no longer redefines `app.submit_inspection`. The
  `append_inspection_warning` helper that TYRE-213 assigned to it (comment
  13641) moves to the next ticket that does.

U143 item 4 also settles consent: it is contractual. The tech team records
it at onboarding, once legal and the contract approve. There is no in-app
consent screen and no paywall; an admin surface for it is post-POC.

## Decisions

Owner answers, 20 Oct 2026, in the TYRE-283 spec session. Verbatim copies
are in the pipeline state file.

| # | Question | Answer |
| --- | --- | --- |
| D1 | Who records consent, and where? | The tech team, at onboarding, outside the app (U143 item 4) |
| D2 | Can an invoice price replace a price-list estimate later? | Yes, once per receipt of a set of tyres |
| D3 | Is "once per receipt" the whole set in one action? | Yes |
| D4 | How is an invoice identified? | The owner defers to common practice; see "Receipt and invoice" |
| D5 | The playback of consent, the settings page, units and currency, tread age and the receipt | Approved |

Amended after the plan's red team, round 1 (20 Oct 2026), to match the code
as it is: consent refuses `UPDATE` by trigger as well as by grant; the
settings page shows the thresholds that exist (U68 dropped the scrap
threshold); tread age sits in an existing cell, never a new column; the
receipt stores what defined its set; the capture bundle's rise is recorded,
not assumed away; and FR-CFG-022 joins the SRS consequences.

## Scope

In:

1. Migration 000059: the consent writer and its purpose check, the
   current-consent view, the price-list match function, the receipt table
   and the tyre's link to it, `app.receive_tyres` reading the price list,
   the receipt's moves, `app.set_tyre_cost` refusing a tyre that
   arrived on a receipt, and the metric-units constraint.
2. Suite section 75.
3. API: the price-list estimate read, the open receipts list and its
   moves, the settings read, the tenant's currency and units on
   `GET /api/me`, and `platformCatalogueId` on `GET /api/tyre-catalogue`.
4. Web: Receive tyres pre-fills the estimate and carries the purchase date,
   received date and invoice number; the open receipts list and its
   moves; a read-only fleet settings page; tread age beside every tread
   value; money, pressure and distance labels from the tenant's
   configuration.
5. `make record-consent` and a consent section in
   `docs/runbooks/provision-a-tenant.md`. `db/seeds/provision_tenant.py`
   writes consent through the new function.

Out, each with its owner:

- `inspection.tyres_created`, the new-tyre branch and onboarding progress:
  TYRE-286, after TYRE-439.
- The list of tyres whose display code is issued but not yet marked on the
  sidewall (`brand_pending`): TYRE-99.
- A different display-code shape (such as `BAC-T0034` rather than
  `BAC-00034`): not this ticket.
- Supplier on a receipt: dropped for the POC (TYRE-418 comment 13743). The
  usual duplicate-invoice check needs it, so that check returns with it.
- Converting pressure to psi or bar, or distance to miles: deferred until a
  tenant that needs it is signed. Until then the database refuses such a
  tenant (see "Units and currency").
- Editing any setting, consent or price in the app: the tech team sets them
  at onboarding (U143 item 4; TYRE-369's `make provision-catalogue` for
  prices). An admin surface is post-POC.
- Bulk apply of price and tread (FR-TYR-033): TYRE-288.
- Reading consent for aggregates: TYRE-428.

## Design

### Consent

`app.tenant_consent` (000012) keeps its shape. `UPDATE` and `DELETE` are
revoked from the app role, and the suite's check 4 covers it. The ticket
asks for append-only in practice, not just by grant, and the runbook
connects as the owning role, which no revoke binds. So a trigger refuses
`UPDATE` for every role, as `threshold_policy_written_once` does (000054),
proved as a superuser in the privileged file. `DELETE` stays grant-only,
because deleting a tenant cascades through its ledger.

- **Purpose check.** `purpose_code` gains a check constraint holding it to
  `SERVICE_DELIVERY` and `ANONYMISED_BENCHMARKING`, the vocabulary
  `provision_tenant.py` already uses. Adding a purpose stays a code change,
  never file content (OR-LEG-005).
- **The writer.** One SQL function records one consent row for the bound
  tenant: the purpose, granted or withdrawn, the notice version and the time
  consent was given. It refuses an unbound tenant, a purpose outside the
  check, an empty notice version, and a time in the future. It takes no
  tenant parameter, so a caller cannot name another tenant (TYRE-369's
  rule). It is an invoker function with `SET search_path = app, pg_temp`.
- **Actor.** NULL. The tech team is not an app user, as at provisioning
  today. The notice version names the signed agreement and its version.
- **When given and when recorded.** `occurred_at` is when consent was given
  (the agreement date) and may be earlier than the record. `created_at`
  (000017) is when the record was made.
- **Current consent.** A view, `security_invoker = true`, gives the latest
  row per tenant and purpose, ordered by `occurred_at` then `created_at`.
  A purpose with no row has no current consent; an empty ledger is not
  consent. TYRE-428 reads the same shape.
- **No audit trigger.** The ledger is its own history (ADR-0014).
- **Operation.** `make record-consent` binds a tenant and calls the
  function against the local database. `docs/runbooks/provision-a-tenant.md`
  gains a section for recording or withdrawing consent on staging and
  production, connecting as `provision-a-user.md` does.
  `provision_tenant.py` emits a call to the function instead of a raw
  insert, so provisioning and the runbook share one writer.
  `db/tests/provision/provisioned.sql` §8 and `demo.sql` keep passing.

### Price list match

One SQL function returns the estimate for a size, an optional brand and a
date: the price-list row for that size and brand with the latest
`effective_from` on or before the date, otherwise the size's row with no
brand on the same terms, otherwise nothing. A brand-specific row beats a
size-only one whatever their dates. Superseded rows stay in the table
(FR-CFG-042, already true: `UPDATE` and `DELETE` are revoked).

This function is the only implementation of the rule. The API relays it to
the form, and `app.receive_tyres` calls it. No TypeScript or Go copy exists.

### Receipt and invoice

A receipt is one call to `app.receive_tyres`: 1 to 200 identical tyres,
received together. Nothing records that grouping today.

- **The receipt record.** A new tenant table, one row per receive, RLS
  forced, with its own uuid identity. It carries the optional invoice
  number and the receipt's price state (below), with when and by whom it
  last moved. It also stores what defined the set at receive: the size,
  the resolved brand, the pattern and the received date. A retread return
  can rewrite a tyre's pattern, so the list and the moves read the
  receipt, never a tyre. Each tyre gains a nullable link to its receipt, set at
  receive and never changed. `app.tyre` is on check 4's `UPDATE` allow-list
  at table level, so a trigger, not a grant, holds the link fixed. The
  receipt table needs `UPDATE` for its state and joins that allow-list.
  Tyres received before this migration have no receipt and keep today's
  per-tyre costing.
- **Price state.** A receipt is in one of four states, following the usual
  goods-received practice, where a receipt stays open until it is matched
  to an invoice or deliberately cleared without one:
  - **Unpriced**: received with no price (`UNKNOWN`).
  - **Estimated**: priced from the list (`PRICE_LIST_ESTIMATE`).
  - **Invoiced**: priced from an invoice (`INVOICE`). Final.
  - **Estimate kept**: the controller has recorded that no invoice will
    come, and the estimate stands. Final. This is the normal end for the
    fleet's existing tyres entered at onboarding, which the price list
    exists for (CHG-036, 000012).

  The moves are unpriced to estimated, unpriced or estimated to invoiced,
  and estimated to estimate kept. No other move exists, and a final state
  never moves. "Once per receipt" (D2) is this: the invoice is recorded at
  most once, and only before the receipt is final.
- **Invoice reference.** Common practice identifies an invoice by
  supplier, number and date. With no supplier in the POC, the receipt holds
  the invoice number (optional, free text, any format, since every
  supplier numbers differently, and a tenant that files by its own order or
  delivery number can enter that). The invoice date is the tyres' existing
  `purchase_date`, written for every tyre on the receipt. There is no second
  date column. Nothing requires the number to be unique: one invoice may
  cover several receipts (two sizes on one invoice are two receives).
- **At receive (FR-CFG-041).** The cost source decides the price:
  - `PRICE_LIST_ESTIMATE`: the price must equal the match function's
    estimate for the size, brand and received date, or the receive is
    refused, naming the list price. A size and brand with no applicable row
    cannot be received as an estimate. So an estimate is always the list's
    figure, never a number someone labelled one.
  - `INVOICE`: any valid price, as today. An invoice number may accompany
    it. The receipt is invoiced from the start.
  - `UNKNOWN`: no price, as today. The tyres await their cost.
  An invoice number with any source but `INVOICE` is refused. The existing
  price and source refusals stand unchanged.
- **Moving a receipt later (D2, D3).** SQL functions, one per move, each
  applying to every tyre on the receipt in one transaction, each refused
  for a receipt not in the bound tenant or not in the state the move starts
  from:
  - **Apply the list price** (unpriced to estimated): every tyre takes the
    match function's estimate for its size, brand and received date as
    `PRICE_LIST_ESTIMATE`. Refused when no row applies. This keeps what
    `app.set_tyre_cost` offers an unpriced tyre today.
  - **Keep the estimate** (estimated to estimate kept): changes no tyre,
    records who closed it and when.
  - **Record the invoice** (unpriced or estimated to invoiced): takes the
    invoice unit price, and the optional invoice number and invoice date.
    The rules for the tyres follow.
- **Recording the invoice, per tyre.**
  - Refused for a final receipt, including one received with `INVOICE`.
  - Each tyre takes the price as `INVOICE`, and its `rand_per_mm` is
    recomputed through `app.rand_per_mm` with the removal threshold in
    force, under the same refusals and the same rule as `app.set_tyre_cost`.
    A retreaded tyre keeps its rate, which is its retread cost's
    (FR-TYR-019).
  - A tyre that has left the fleet (scrapped, sold or lost) keeps its
    estimate, and the others take the price. This is the line
    `app.set_tyre_cost` already draws: a tyre that has left the estate is
    not re-costed. The same holds for applying the list price.
  - For a tyre still in the fleet, the new rate also restates its past
    valuations: `app.tyre_valuation_asof` reads the current rate and
    source, so earlier dates move from ESTIMATED to ACTUAL at the invoice
    figure, and month-end snapshots follow at their next reconcile. This is
    the accepted consequence 000008's header records, and
    `app.set_tyre_cost` does the same today. Keeping each date on the rate
    it had would need rate history on the tyre, which is not this ticket.
  - The tyre rows are audited (ADR-0014), so each change is in the audit
    log. The receipt table is audited too; the suite's pinned count of
    audited tables (§72a) moves by one.
  - After this the price is final. A correction stays with TYRE-48, as
    `app.set_tyre_cost` says today.
- **Per-tyre costing.** `app.set_tyre_cost` refuses a tyre that arrived on
  a receipt and points the caller to the receipt, so a set is never part
  priced one way and part another. Tyres without a receipt keep it.
- **The brand the match uses.** When the brand is left blank,
  `app.receive_tyres` takes it from a branded pattern (000057). The
  estimate the form shows is asked for with the same size, brand and
  pattern the receive will send, and resolves the brand the same way, so
  the database never refuses the figure the form showed.

### Receive tyres (web)

- Once size and brand are chosen, the unit price pre-fills from the
  estimate read, labelled as a price-list estimate with its effective date.
  With no applicable row, the price stays empty.
- Editing the price makes it an invoice price, and the form says so.
  Clearing it leaves the tyres awaiting cost.
- An invoice price offers the optional invoice number.
- The optional purchase date and the received date (defaulting to the
  tenant's today, back-datable, never future) are on the form, which is
  TYRE-418's change. A change of received date re-reads the estimate,
  because the match is effective on that date.
- After saving, the issued display codes are listed, as today.

### Open receipts (web)

A list in the fleet section of receipts that are unpriced or estimated:
received date, depot, size, brand, pattern, quantity, the display codes
issued, and the current price and its source. Each offers the moves its
state allows: "Record invoice" (unit price, invoice number, invoice date),
"Apply list price" for an unpriced receipt, and "Keep the estimate" for an
estimated one, which asks for confirmation because it is final. Each shows
the result for the whole set. Gated as Receive tyres is (`ManageAssets`).

The awaiting-cost list (`app.v_tyre_awaiting_cost`) is unchanged. For a
tyre on a receipt, its cost form sends the user to the receipt instead.

### Units and currency (FR-CFG-021, FR-CFG-022)

- **Stored units do not change.** Pressure is stored in kPa and distance in
  km.
- **Metric only, enforced.** A check constraint on `app.tenant` holds
  `pressure_unit` to `KPA` and `distance_unit` to `KM` until conversion is
  built, and `provision_tenant.py` refuses the others with a message that
  says so. This way no screen can put a psi label on a kPa figure. Both
  pilot tenants are kPa and km. `db/tests/provision/free.json` provisions a
  psi and miles tenant today, so that fixture moves to metric and the
  refusal gets its own provisioning test.
- **Currency.** `GET /api/me` adds the tenant's currency code, pressure unit
  and distance unit. Every money value renders through the one money
  formatter (CLAUDE.md, `web/src/api/money.ts`), which takes its symbol from
  the currency code through a small map in code (ZAR is "R") and falls back
  to the code itself. There is no exchange conversion: a tenant works in its
  own currency. If the formatter is renamed, CLAUDE.md and `web/CLAUDE.md`
  are updated with it.
- **Labels.** Every hardcoded "kPa" and "km" in the web (capture's position
  sheet, its warnings, the odometer entry and its checks, the fleet
  odometer forms, fitment history) reads its label from one units module
  fed by `/api/me`. The capture bundle sits exactly at its budget today,
  so any rise this ticket causes is recorded with its measured size and
  reason, and listed in the PR, as `web/CLAUDE.md` allows.

### Fleet settings page (the five reads)

A read-only page for the roles holding `ManageConfig` (CONTROLLER,
DEPOT_MANAGER, ORG_ADMIN), reached from the navigation, fed by one settings
read. Nothing on it is editable. It shows:

- **Fleet:** timezone, currency, pressure and distance units, and the
  history horizon (FR-TEN-021): the date live capture starts, or that the
  fleet has no imported history.
- **Tread thresholds:** each threshold policy row in force, with its scope
  (fleet-wide, operating group, axle class), removal threshold, warning
  threshold (FR-CFG-012 as revised by TYRE-299), retread cap and whether
  retreads are permitted, and its effective date. There is no scrap
  threshold: U68 dropped it (000054).
- **Consent:** each purpose with its current state, the notice version, and
  when it was given, from the current-consent view. A purpose never
  recorded reads "Not recorded".
- **Price list:** the entries in force today: size, brand or "Any brand",
  typical price and effective date.
- **Catalogue:** the sizes, brands and patterns, each marked as from the
  platform catalogue or added for this fleet (FR-CFG-005).
  `GET /api/tyre-catalogue` also returns `platformCatalogueId` on each row.

### Tread age (FR-TYR-017)

Wherever a tread value is shown, the age in days of that measurement is
shown with it, counted in the tenant's calendar (rule 6). It goes inside
an existing cell (the measurement's date, or the tread value), never a new
column: the dashboard and exceptions layouts accepted at TYRE-238 are
fixed, and those tables already carry the measurement's date. The known
places: the at-risk list, the exceptions list, the spares panel, a unit's
position panel, fitment history, and capture's previous reading. The
planner sweeps the web for any other place a tread value renders. The spares
panel already receives `daysSinceMeasured` and does not show it.

### Correct under either role

Every new function writes and reads only rows whose `tenant_id` is
`app.current_tenant_id()`, so it stays in the bound tenant under the Azure
admin role as well as `app_login` (TYRE-369's rule). Every new view is
`security_invoker = true`.

## SRS consequences

These rows go to the SRS through a ticket raised after this spec is
approved, as TYRE-439 and TYRE-440 do:

- §5.1 gains the receipt entity, and the tyre gains its link to it.
- FR-CFG-041: an estimate is replaced by the invoice price once per
  receipt, for every tyre on it still in the fleet, or kept as final when
  no invoice will come; an unpriced receipt may take the list price.
- FR-CFG-021: for the POC, pressure and distance are metric only.
  Conversion is built when a tenant needs it.
- FR-CFG-022: for the POC, the display symbol follows the currency code
  through a platform map, not a separate per-tenant setting.
- FR-TEN-022 cites ADR-0003 action item 6, which the accepted ADR-0003 no
  longer carries. The requirement stands on its own; the citation is
  corrected.

## Testing

Suite section 75, run as `app_login`:

- **Consent:** a recorded row reads back. Each refusal fires: unbound
  tenant, unknown purpose, empty notice version, future time. `UPDATE` and
  `DELETE` stay refused to the app role, and the privileged file proves
  `UPDATE` refused to a superuser too. The current view gives the latest row per purpose,
  a withdrawal after a grant reads as withdrawn, and another tenant sees
  none of it.
- **Match:** a brand row beats a size-only row, the latest row on or before
  the date wins, a row dated after the date is ignored, and no row gives
  nothing.
- **Receive:** an estimate equal to the list price is stored as
  `PRICE_LIST_ESTIMATE`. A different figure is refused, as are an estimate
  with no applicable row and an invoice number without an invoice price.
  One receipt row per receive, with every tyre linked to it.
- **Receipt moves:** each allowed move works and every other is refused,
  including any move from a final state and a second invoice. Recording the
  invoice gives every tyre the price and source, recomputes the rate for
  unretreaded tyres and keeps it for retreaded ones, and leaves a scrapped
  tyre on its estimate. Applying the list price gives every tyre the
  match's figure. Keeping the estimate changes no tyre. Another tenant's
  receipt is not found. Money round-trips exactly.
- **Receipt link:** changing a tyre's receipt is refused.
- **Per tyre:** `app.set_tyre_cost` refuses a tyre on a receipt and still
  costs one without.
- **Units:** a tenant with psi, bar or miles is refused.
- The receipt table is RLS forced, joins the audited set, and §72a's count
  moves with it.
- The section leaves every fixture tenant as it found it.

Go: handler tests for each new endpoint and field, and each new refusal
mapped under ADR-0012. Web: vitest for the pre-fill (shown and labelled,
edited to invoice, cleared to awaiting cost, re-read on a date change), the
invoice action, the settings page, tread age, the currency symbol and its
fallback, and the unit labels.

Appendix E and Appendix J pins are unchanged. `make check` green.

## Calls made here

The owner deferred these to common practice or left them to the lead:

1. The invoice reference is a free-text number with no uniqueness rule, and
   the invoice date is the existing purchase date.
2. A tyre that has left the fleet keeps its estimate when the invoice is
   recorded. This corrects what the owner was told in the session (that it
   would take the invoice price): `app.set_tyre_cost` already draws that
   line. Tyres still in the fleet have their past valuations restated to
   the invoice figure, as `app.set_tyre_cost` does today (000008).
10. A receipt has four price states, and two moves besides the invoice:
    applying the list price to an unpriced receipt (what
    `app.set_tyre_cost` allows an unpriced tyre today) and keeping the
    estimate when no invoice will come (the usual end for the fleet's
    existing tyres entered at onboarding).
3. An estimate must equal the list's figure; editing it makes it an invoice
   price.
4. Tyres received before this change get no receipt.
5. `app.set_tyre_cost` refuses a tyre on a receipt.
6. A check constraint, not just provisioning, holds tenants to metric
   units.
7. TYRE-418's Receive form change folds in here: it sits in the form this
   ticket changes, and the received date drives the price match.
8. The settings page also shows the catalogue with its lineage, because
   FR-CFG-005 has to be visible to a manager somewhere.
9. Consent's `occurred_at` may be back-dated to the agreement date, never
   future.
