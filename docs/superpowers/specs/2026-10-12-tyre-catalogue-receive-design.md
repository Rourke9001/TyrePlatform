# Design: tyre catalogue read and Receive tyres pickers (TYRE-318)

- **Date:** 2026-10-12
- **Ticket:** TYRE-318, under epic TYRE-55. It folds in TYRE-370 (Done, U93)
  and the receive half of TYRE-175.
- **Decisions it rests on:** the owner's answers in the TYRE-318 spec session,
  12 Oct 2026, recorded below under "Decisions". Also U93 (TYRE-318 comment
  13426), ADR-0012 (the refusal envelope), ADR-0013 (a write with a rule of its
  own is a SQL function; no threshold in a Go validator) and ADR-0003 (Option A,
  marketplace post-POC).
- **Requirements:**
  - Receipt: FR-TYR-040, FR-TYR-041, FR-TYR-002, FR-TYR-031.
  - Rate: FR-TYR-006, FR-TYR-007, FR-VAL-002, BR-VAL-002.
  - Reference data: FR-CFG-001 to FR-CFG-004, FR-CFG-007.
  - Provenance: DR-019, NFR-PRO-002, rule 9 of the project brief.
  - Money projection: FR-AUT-005a (not engaged by the catalogue read).
  - Usability: NFR-USE-005, NFR-USE-006, NFR-USE-012.
  - Data types: DR-007.

## Why this exists

No endpoint reads `app.tyre_size`, `app.tyre_brand` or `app.tyre_pattern`,
and Receive tyres (`web/src/fleet/ReceiveTyre.tsx`) offers no size, brand,
pattern or new tread. A tyre received through the UI therefore has a NULL
`new_tread_mm`, so `app.rand_per_mm` returns NULL and the register shows a
dash for Rand/mm. `new_tread_mm` is written only at receipt and at retread
return, so pricing such a tyre later through `app.set_tyre_cost` still leaves
it unrated. U93 holds that no real tyre is received before this lands.

The form also pre-selects INVOICE (`ReceiveTyre.tsx:38`), and the SQL imputes
INVOICE for a priced receive with no source (`000031`, the `src` local). A cost
cannot be corrected once recorded, so an imputed invoice is permanent.

TYRE-102, TYRE-283, TYRE-286 and TYRE-288 all read this catalogue, so it goes
first.

## Decisions

Owner answers, 12 Oct 2026, in the TYRE-318 spec session:

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Are size, pattern and new tread mandatory at receipt, and where is that enforced? | Mandatory, enforced in SQL; the form marks them required |
| Q2 | Who may read the catalogue? | `ViewFleet` |
| Q3 | What shape is the read? | One `GET /api/tyre-catalogue`, active rows, natural order, client-side filtering |
| Q4 | Which consistency rules does `receive_tyres` add? | All four: pattern applies to new tyres, brand agrees with or derives from the pattern, entries active, new tread above the retread threshold |
| Q5 | Where do FR-CFG-005 and FR-CFG-006 go? | FR-CFG-005 (platform default catalogue with lineage) folds into TYRE-369; FR-CFG-006 (admin screen) is TYRE-417 |
| Q6 | Does the SQL INVOICE imputation go? | Yes: a priced receive needs a chosen source, in SQL |

The brand list is the tenant's own register (FR-CFG-002), seeded from a
platform default with `platform_catalogue_id` lineage (FR-CFG-005, TYRE-369)
and extended by an admin (FR-CFG-006, TYRE-417). There is no "Other"
pseudo-entry: brand stays optional at receipt (FR-TYR-031 does not require
it), and absence is NULL (NFR-PRO-002). Lineage is the hook a post-POC
marketplace reads (ADR-0003), so nothing here merges or matches rows by name.

## Scope

In:

1. Migration 000053 replaces `app.receive_tyres` with the refusals below.
2. `GET /api/tyre-catalogue`.
3. The 22003 refusal mapping.
4. Receive tyres pickers, new tread field and cost-source change.
5. Sandbox Fleet catalogue seed.
6. The tests listed under Testing.

Out, each with its owner:

- Supplier at receipt, which FR-TYR-040 names and §5.1 does not: TYRE-418.
- Adding or deactivating catalogue rows: TYRE-417.
- Platform default catalogue and per-tenant provisioning: TYRE-369.
- Exposing `platform_catalogue_id` on the read (FR-CFG-005): TYRE-283's
  acceptance criteria. It is NULL on every row until TYRE-369.
- The awaiting-cost form's INVOICE pre-selection: TYRE-419.
- TYRE-175's other two items (`orientation_known DEFAULT true`, TY012 vs
  TY014): TYRE-175.
- Price-list pre-population at receipt (FR-CFG-041): TYRE-283.
- Purchase date and received date on the form: not in the ticket. The API
  already accepts both and `receive_tyres` defaults the received date.

## Database: migration 000053

`CREATE OR REPLACE FUNCTION app.receive_tyres(payload jsonb)`. The signature,
return type, invoker rights and `SET search_path = app, pg_temp` are unchanged
(db/CLAUDE.md, Adding a function). Everything 000031 does stays as it is:
policy gating, quantity bounds, received-date rules, the counter, the two
events.

New refusals, all `TY011` with plain-language messages (NFR-USE-005). They run
after the existing policy and quantity checks and before the loop, so a
refused receive mints no code:

1. `size_id`, `pattern_id` and `new_tread_mm` are each present (Q1,
   FR-TYR-031). A missing one is named in the message.
2. Each of size, pattern and (if sent) brand resolves to a row this tenant can
   see that is `active` (Q4, FR-CFG-007). One message per kind covers a
   missing id, another tenant's id and a deactivated row, so the refusal is no
   oracle for another tenant's ids. This mirrors `set_tyre_cost`'s "no such
   tyre in this fleet".
3. The pattern's `applies_to` is `NEW` or `BOTH` (Q4, FR-CFG-004).
4. If the pattern has a `brand_id`, a sent brand must equal it, and an omitted
   brand is taken from the pattern (Q4, NFR-USE-006). A pattern with no brand
   leaves the brand as sent, or NULL.
5. When `app.current_removal_threshold_mm()` returns a value, `new_tread_mm`
   must exceed it. Otherwise `app.rand_per_mm` returns NULL and the tyre is
   unratable (Q4, U93). The threshold is the same call the rate uses, so there
   is no constant. When no threshold is in force the check is skipped and the
   rate comes back NULL, as today.
   U129 (TYRE-421, TYRE-318 comment 13600) later made a priced receive with no
   threshold in force a refusal; an unpriced one still lands.
6. A `purchase_price` with no `cost_source` is refused (Q6). An unpriced
   receive keeps `UNKNOWN`. The `INVOICE` branch of the `src` default is
   removed.

The down file restores 000031's definition. Per
`docs/lessons.md` (down files restore state, not text), the plan proves the
down by catalogue state, not by matching text.

`numeric(12,2)` and `numeric(4,1)` locals keep their current role: the cents
rounding happens before the divide (FR-VAL-006).

## API

### `GET /api/tyre-catalogue`

- A new handler in its own file under `api/internal/httpapi/`, registered in
  `httpapi.go` beside `/axle-configurations`.
- `require(a, auth.ViewFleet)` (Q2). TECHNICIAN, CONTROLLER, DEPOT_MANAGER and
  ORG_ADMIN hold it, and DRIVER does not. TYRE-286 widens it if the driver's
  new-tyre branch needs it.
- Three queries on the one `withActor` transaction, `WHERE active`, each
  ordered in natural order (NFR-USE-012). `exceptions.go:101` is the precedent
  for how this codebase sorts naturally in SQL.
- Response, camelCase, never null arrays:

  ```json
  {
    "sizes":    [{"id": "...", "name": "315/80R22.5"}],
    "brands":   [{"id": "...", "name": "..."}],
    "patterns": [{"id": "...", "name": "...", "brandId": "..." , "appliesTo": "NEW"}]
  }
  ```

  `brandId` is null for a pattern with no brand. The read carries no money, so
  FR-AUT-005a's projection is not engaged.

### `POST /api/tyres`

Unchanged in shape. The `receiveTyresRequest` doc comment (`tyres.go:181`)
says every field but quantity is optional; it is corrected to point at
`app.receive_tyres` as the owner of what is required. Go adds no validation of
its own (ADR-0013 decision 5). `newTreadMm` stays a JSON string, cast in SQL,
because a JSON number decodes to a float64 and tread is `DECIMAL(4,1)`
(DR-007, `request.go:248`).

### 22003

A value too large for its numeric column (a `newTreadMm` of "1234", an
oversized `purchasePrice`) raises Postgres 22003, which `refusal.go`'s canned
map does not list, so it reaches the client as a 500. Add `22003` to the
canned 422 class beside `22P02`, with a refusal test and its row in
`refusal_codes.json` if that file lists the class.

## Web

### `web/src/api/`

`fetchTyreCatalogue()` and its types: `TyreSize`, `TyreBrand`, `TyrePattern`,
`TyreCatalogue`. `appliesTo` is a string union of the three values.

### Receive tyres

Field order, each with a real `<label>`:

1. **Size**: required select.
2. **Brand**: optional select, with an empty first option.
3. **Pattern**: required select. Options are patterns whose `appliesTo` is
   `NEW` or `BOTH`. With a brand chosen, the list narrows to that brand's
   patterns plus patterns with no brand. Choosing a pattern that has a brand
   sets the brand select to it. Changing the brand to one a chosen branded
   pattern does not belong to clears the pattern.
4. **New tread (mm)**: required, `inputMode="decimal"`. The form refuses, inline
   and before submit, a value that is not a decimal with at most one decimal
   place. This is a convenience; SQL's cast and CHECK are the control.
5. **Purchase price**: as today, a decimal string.
6. **Cost source**: shown once a price is entered, starting on an empty
   "Choose a source" option. A priced receive cannot submit until a source is
   chosen, and the form says why (TYRE-370's definition of done).

The body sends `sizeId`, `patternId` and `newTreadMm` always, `brandId` only
when set, and `costSource` only when the user chose one. Money and tread are
never passed through `Number()`.

Catalogue states, in plain words, with submission blocked in each:

- loading;
- failed to load;
- loaded with no sizes or no new-tyre patterns: the fleet has no catalogue yet,
  so ask an administrator (TYRE-369 provisions it, TYRE-417 adds to it).

A server `TY011` shows its own message through `refusalMessage`, as today. On
success the form clears every field, cost source included, and nothing is
re-selected.

The catalogue query uses Tanstack Query (CLAUDE.md, TypeScript). ADR-0015
governs styling: `tokens.ts` and plain CSS, the existing `fleet.css` classes.

## Seeds

`db/seeds/gen_seed_fixture.py`, Sandbox Fleet only (never BAC, whose rows are
the acceptance fixture):

- two sizes;
- two brands;
- a NEW pattern belonging to the first brand;
- a NEW pattern with no brand;
- a RETREAD-only pattern.

That set exercises every picker branch. Edit the generator, never the
generated SQL (db/CLAUDE.md, Seeds).

Trap: `gen_seed_volume.py:218-228` already inserts a size named
`315/80R22.5`, a brand and a pattern for the same tenant, and the tables are
`UNIQUE (tenant_id, name)`. Either the fixture's names differ from the volume
seed's, or the volume seed reuses the fixture's rows. The plan picks one and
shows `make db-volume` still loads.

## Testing

**Suite** (`db/tests/004_tests.sql`, next free section; 68 is the highest
today):

- Each of the six refusals in "Database: migration 000053", by `TY011`.
- A deactivated size, brand and pattern, each refused.
- Another tenant's pattern id is refused with the same message as a missing
  one.
- A happy path: a priced receive with size, pattern and tread stores
  `rand_per_mm` equal to
  `app.rand_per_mm(price, tread, app.current_removal_threshold_mm())`, and a
  brand omitted with a branded pattern is stored as the pattern's brand.
- An unpriced receive stores `UNKNOWN`.
- Every planted row rolls back, as the suite's other sections do.

**Existing callers** gain the inputs the new rule requires, with no assertion
weakened (CLAUDE.md, Testing). Each one only receives a tyre as setup for a
different assertion:

- The receive section around `004_tests.sql:4195` and the one around `:9781`.
- `api/internal/httpapi/tyres_test.go` and `retreads_test.go`.
- `web/e2e/rotation.spec.ts:61`.
- `web/src/fleet/ReceiveTyre.test.tsx`.

The plan lists every caller it finds. A caller whose assertion depended on a
bare receive is put to the owner, not rewritten.

**Go integration** (real Postgres, table-driven, `testify/require`):

- `GET /api/tyre-catalogue` returns one tenant's rows and none of another's.
- Inactive rows are excluded.
- The JSON shape and natural order hold.
- TECHNICIAN gets 200 and DRIVER gets 403.
- A refusal test for 22003.
- A receive refused for a missing pattern comes back as TY011 through the
  envelope.

**Vitest:**

- The form never sends a cost source the user did not choose (TYRE-370).
- A priced receive cannot submit without a source.
- Required fields block submission.
- Patterns are filtered by `appliesTo` and by brand.
- Choosing a branded pattern sets the brand.
- A non-decimal tread is refused inline.
- The three catalogue states block submission.

**E2e** (Playwright, Sandbox project): receive a priced tyre through the form
with size, pattern and new tread, then assert that the register row shows a
Rand/mm rather than a dash. This is the ticket's definition-of-done line
proven end to end.

`make check` green, Appendix E and J pins unchanged.

## Risks

- **A caller outside the tests receives bare tyres.** The plan greps every
  `receive_tyres` and `/api/tyres` POST before the migration lands.
- **Rule 5 refuses when no threshold policy row exists.** It does not: it is
  skipped when no threshold is in force. Every seeded tenant has a
  `-infinity` baseline policy (`gen_seed_configurations.py`).
  U129 (TYRE-421, TYRE-318 comment 13600) later made a priced receive with no
  threshold in force a refusal; an unpriced one still lands.
- **The seed change moves a pinned count.** Sandbox rows only, and the plan
  runs the full suite and `make db-volume`.
