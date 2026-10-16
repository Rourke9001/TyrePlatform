# Design: provisioning a tenant's tyre catalogue, casing estimates and price list (TYRE-369)

- **Date:** 2026-10-15
- **Ticket:** TYRE-369, under epic TYRE-3. It folds in FR-CFG-005 (owner
  comment 13592, 12 Oct 2026, from the TYRE-318 spec's Q5).
- **Decisions it rests on:** the owner's answers in the TYRE-369 spec
  session, 15 Oct 2026, recorded below under "Decisions". Also U93 (the
  ticket's origin), ADR-0003 (Option A: the marketplace is post-POC, and
  reference-data lineage is one of its preparations, project brief §5.1),
  ADR-0010 (provenance), ADR-0013 (a write with a rule of its own is a SQL
  function) and ADR-0014 (audit).
- **Requirements:**
  - Catalogue: FR-CFG-001 to FR-CFG-005, FR-CFG-007, FR-TEN-006.
  - Price list and casing estimates: FR-CFG-040, FR-CFG-042, FR-CFG-043.
  - Valuation and provenance: FR-TYR-008, FR-TYR-032, FR-TYR-033, CR-012,
    NFR-PRO-002, rule 9 of the project brief.
  - POC scope: SRS H.1 (the CFG row: "values may be seeded by migration";
    the price list and casing estimates are POC configuration) and H.2
    (`FR-ADM-*`, the platform administration console, is deferred).
  - Data types: DR-007.

## Why this exists

The valuation read path reads `app.casing_estimate_by_size` as the
ESTIMATED casing (`000050`, the `est` lateral in `app.tyre_valuation_asof`),
but only the suite writes to it. `app.tyre_size`, `app.tyre_brand`,
`app.tyre_pattern` and `app.tyre_price_list` have no route and no screen;
only the seed generators fill them, and only for the fixture tenants. A
real tenant provisioned today has no sizes, so it cannot receive a tyre
(TYRE-318 made size mandatory at receipt), and it has no per-size estimate,
so every never-retreaded casing is UNVALUED and the value-at-risk figure
(FR-RPT-040) is empty.

`platform_catalogue_id` exists on the three catalogue tables (`000012`) and
references nothing. FR-CFG-005 asks that new tenants be seeded from a
platform default catalogue and that each seeded row carry that lineage.

## Decisions

Owner answers, 15 Oct 2026, in the TYRE-369 spec session. The owner
answered D8 and overrode none of D1 to D7.

| # | Question | Answer |
| --- | --- | --- |
| D1 | How is the platform catalogue stored? | Three tenant-free tables (size, brand, pattern), shaped like `app.jurisdiction_tread_minimum`: RLS forced, read by everyone, written only by migration |
| D2 | How does a new tenant receive it? | An explicit function the operator calls at provisioning, not a trigger on `app.tenant`, so the fixture tenants are never seeded |
| D3 | How does a tenant's own file load? | A JSON file passed to one SQL function under the tenant binding, insert-only and all-or-nothing, run from a make target and a runbook |
| D4 | What happens when names meet? | Names resolve within the tenant only. A catalogue row that already exists is refused, never merged. Lineage is set only by the platform seed, never by name |
| D5 | Where does `effective_from` come from? | The file, on every estimate and price row; there is no default |
| D6 | Do estimates need a provenance column? | No. The per-size table is the estimate; the read path labels it ESTIMATED |
| D7 | Does FR-TYR-033 against FR-CFG-043 need an SRS change? | No. The two estimates are layered, both labelled ESTIMATED; see "Casing estimate precedence" |
| D8 | What does the platform list hold at first? | A starter list from the SRS's own examples. The owner's full list follows in a later migration, and re-running the seed carries it to existing tenants |

Two points the session left open are settled here and named for the
spec review:

- **Starter patterns carry no brand.** The SRS lists the example brands and
  patterns separately (FR-CFG-002, FR-CFG-003) and states no pairing, so the
  platform rows make no claim about one. A tenant pattern seeded from them
  has a NULL brand, which TYRE-318's receipt rules already handle (brand stays
  optional and is derived only where a pattern has one).
- **The price list's unique key treats a missing brand as a value.**
  `UNIQUE (tenant_id, size_id, brand_id, effective_from)` (`000012`) lets two
  brandless rows for one size share a date, because NULLs are distinct in a
  unique key, and the read would then resolve by heap order. This branch's
  migration replaces it with `UNIQUE NULLS NOT DISTINCT`, as `000054` did for
  the threshold policy. It sits in a table this branch writes, and the fix is
  one constraint in the branch's own migration (CLAUDE.md, fix in the branch).

Amended after the stage 5 review of PR #122, Owner ruling U135 (16 Oct
2026, TYRE-369 comment 13763): FR-CFG-051 binds casing estimates. An
estimate dated before the current UTC day is refused once its size has an
estimate or the tenant holds a tyre of the size, and `UPDATE` on the
estimate and price tables is revoked from the app role. A size's first
estimate may be dated back while the tenant holds no tyre of it. The file's
text is refused when a key repeats inside one object, before it becomes
`jsonb`.

## Scope

In:

1. Migration 000058: the three platform tables and their starter rows, the
   lineage foreign keys and unique keys, the price-list key change,
   `app.seed_tenant_catalogue()` and `app.provision_catalogue(p_payload jsonb)`.
2. Suite section 74 and the allowlist entries the platform tables need.
3. `make provision-catalogue`.
4. `docs/runbooks/provision-a-tenant-catalogue.md`.

Out, each with its owner:

- Creating the tenant row, and the rest of FR-TEN-006's defaults (axle
  configurations, exception rules): not this ticket. The runbook starts from
  an existing tenant.
- Adding, editing or deactivating catalogue rows in the app (FR-CFG-006):
  TYRE-417.
- Reading the price list at receipt (FR-CFG-041) and exposing
  `platform_catalogue_id` on the catalogue read: TYRE-283.
- Bulk apply (FR-TYR-033): TYRE-288. Nothing here changes it.
- A platform administration console (FR-ADM-009): deferred by H.2.
- The owner's full platform list: a later migration, when the owner
  supplies it.
- An API endpoint or screen of any kind.

## Design

### Platform tables

`app.platform_tyre_size (id, name, construction)`,
`app.platform_tyre_brand (id, name)` and
`app.platform_tyre_pattern (id, name, brand_id, applies_to)`, where
`brand_id` references `app.platform_tyre_brand` and `construction` and
`applies_to` carry the same checks as their tenant counterparts. Each has a
global `UNIQUE (name)`.

They carry no `tenant_id`: a platform entry is one fact for every tenant,
like `app.jurisdiction_tread_minimum`, and they follow its shape. RLS is
enabled and forced with a `FOR SELECT USING (true)` policy and no write
policy. The app role holds `SELECT` only, which 000001's default privileges
already give; it is never granted `INSERT` or `UPDATE`. Only a migration
writes them.

Starter rows (D8), taken from the SRS's own examples and nothing else:

- Sizes, all `RADIAL` (SRS Appendix D.5: every tyre in the reference data
  is radial): `315/80R22.5`, `225/70R19.5`, `11R22.5`, `185/65R15`. These are
  the Appendix E sizes, with `315/80R` written in full as Appendix D.1 gives
  it.
- Brands: `Dunlop`, `Evergreen`, `Roadshine` (FR-CFG-002).
- Patterns, `applies_to = 'NEW'`, no brand: `SP431`, `EGT88`, `RS620`
  (FR-CFG-003).

These are market names, not findings about any fleet.

### Lineage keys

Each tenant table's `platform_catalogue_id` gains a foreign key to its own
platform table (`tyre_size` to `platform_tyre_size`, and so on), and a
`UNIQUE (tenant_id, platform_catalogue_id)`, so a tenant holds a copy of
each platform entry at most once. The key leads with `tenant_id`, as
check 37a requires; a NULL lineage (a tenant's own row) is unconstrained.

### Seeding a tenant: `app.seed_tenant_catalogue()`

Copies the platform catalogue into the bound tenant and returns the number
of rows it inserted.

- The tenant is `app.current_tenant_id()`. Unbound, the call is refused.
  There is no tenant parameter, so a caller cannot name another tenant.
- Brands, then sizes, then patterns. Each copy takes the platform row's
  `name`, `construction` or `applies_to`, and its `id` as
  `platform_catalogue_id`.
- A platform entry the tenant already holds a copy of, matched by
  `platform_catalogue_id`, is skipped. A second call therefore inserts
  nothing, and a call after a later platform migration inserts only the new
  entries. This is how the owner's full list reaches tenants seeded from the
  starter list.
- A tenant pattern's brand is the tenant row whose `platform_catalogue_id`
  is the platform pattern's `brand_id`. It is found by lineage, never by name.
- If a platform entry's name equals a row the tenant added itself (NULL
  lineage), the call is refused with a named error listing every such
  name, and inserts nothing. It never adopts the tenant's row as the copy:
  rows are never merged by name (owner comment 13592). Resolving such a
  collision is a decision for the day it happens.

### Loading the tenant's file: `app.provision_catalogue(p_payload jsonb)`

Loads one tenant-supplied file into the bound tenant, in one transaction,
and returns the count inserted per section.

Payload, every section optional:

```json
{
  "sizes":            [{"name": "...", "construction": "RADIAL"}],
  "brands":           [{"name": "..."}],
  "patterns":         [{"name": "...", "brand": "...", "applies_to": "NEW"}],
  "casing_estimates": [{"size": "...", "estimated_value": "0.00", "effective_from": "YYYY-MM-DD"}],
  "price_list":       [{"size": "...", "brand": "...", "typical_price": "0.00", "effective_from": "YYYY-MM-DD"}]
}
```

- **Tenant.** `app.current_tenant_id()`, refused when unbound, as above.
- **Order.** Sizes, brands, patterns, then estimates and prices, so a later
  section may name an entry an earlier one adds.
- **Names.** `size` and `brand` resolve against the bound tenant's rows by
  name, seeded or the tenant's own. Nothing resolves against the platform
  tables. A name that does not resolve is refused.
- **Insert-only.** A size, brand or pattern whose name the tenant already
  has, or that appears twice in the file, is refused. An estimate or price
  row that would collide with an existing one on its unique key is refused.
  The function never updates: a price change is a new row with a later
  `effective_from`, and the superseded row stays (FR-CFG-042).
- **Money (rule 2, DR-007).** `estimated_value` and `typical_price` must be
  JSON strings of digits with at most two decimal places. A JSON number,
  a third decimal place, a negative value or a value too large for
  `numeric(12,2)` is refused, never rounded or coerced.
- **Dates.** `effective_from` is required on every estimate and price row
  and must be an ISO date (D5). A date after an inspection means that
  inspection does not see the row (`effective_from <= p_as_at` in 000050),
  so the supplier of the figure chooses it, within U135's limit above.
- **Unknown keys.** A top-level key or a row field the function does not
  know is refused, so a misspelt `estimated_valeu` cannot load as a row
  with no value.
- **Lineage and actor.** Rows from the file carry NULL
  `platform_catalogue_id` (D4) and NULL `created_by`: the load binds no app
  user, as `provision-a-user.md`'s steps do not.
- **Refusals** carry new codes from TY024, each naming the section, the
  row's position in it and the reason, so a supplier can correct the file.
  Any refusal rolls back the whole load (D3).

### Correct under either role

Both functions write only rows whose `tenant_id` is
`app.current_tenant_id()`, and read the tenant's rows through the same
predicate. Under `app_login` RLS binds them as well; under the Azure admin
role, which may bypass RLS, the predicate alone keeps them in the bound
tenant. This is the rule `provision-a-user.md` states for its steps. Both
are invoker functions with `SET search_path = app, pg_temp` (db/CLAUDE.md,
"Adding a function").

### Casing estimate precedence (FR-TYR-033 and FR-CFG-043)

The ticket asks whether FR-TYR-033's casing estimate and FR-CFG-043's
per-size estimate need an SRS clarification. They do not (D7). 000050
already resolves a tyre's casing value in this order:

1. The latest `app.casing_valuation` row: ACTUAL when its source is
   `RETREADER`, ESTIMATED when it is `ADMIN_ESTIMATE` (FR-TYR-033's per-tyre
   estimate, written by TYRE-288).
2. The latest per-size estimate, `app.casing_estimate_by_size`: ESTIMATED
   (FR-CFG-043, provisioned here).
3. The onboarding audit figure: AUDIT.
4. Otherwise UNVALUED.

Both estimates are labelled ESTIMATED and neither is blended with a
retreader's figure (CR-012). The per-tyre estimate is the narrower one and
wins where it exists. This branch changes none of it.

### Operation

`make provision-catalogue T=<tenant uuid> F=<file>` loads a file into the
local database: it binds the tenant, calls `app.provision_catalogue` with
the file's raw text as `jsonb`, and prints the counts. It never parses the
file in Python or any other language that would read money as a float.

`docs/runbooks/provision-a-tenant-catalogue.md` is the owner's procedure
for staging and the pilot. It starts once the tenant row exists, connects
as `provision-a-user.md` does, and runs two steps, each in its own
transaction that binds the tenant first: the seed, then the file. Each step
states the count it expects, and anything else is `ROLLBACK;` and stop. The
runbook gives the payload format above. The tenant's file holds its prices
and is never committed to the repository.

## Testing

Suite section 74, run as `app_login` like the rest of `004_tests.sql`:

- 74a: seeding a tenant with no catalogue inserts every platform entry once,
  each with its `platform_catalogue_id`, and each starter pattern with a
  NULL brand.
- 74b: a second seed inserts nothing.
- 74c: another tenant bound in the same session sees none of the seeded or
  loaded rows.
- 74d: a file loads sizes, brands, patterns, estimates and price rows with
  NULL lineage; money round-trips exactly.
- 74e: each refusal fires and leaves nothing behind: unbound tenant, a name
  the tenant already has, a duplicate within the file, an unresolved size or
  brand, a JSON-number amount, a third decimal place, a missing
  `effective_from`, an unknown key, and a seed whose platform name collides
  with a tenant's own row.
- 74f: two brandless price rows for one size and date are refused by the
  new unique key.
- 74g: a tyre of a seeded size, received, fitted and inspected in the
  provisioned tenant, values ESTIMATED at the per-size figure on or after
  the estimate's `effective_from`, and UNVALUED when valued after its
  inspection but before that date.

Constraints on how the planner stages it:

- The section leaves every fixture tenant as it found it: BAC's and
  Sandbox's rows are the acceptance fixture, and the e2e suite reads
  Sandbox's catalogue (TYRE-318's pickers).
- The provisioning functions are not called from the seed generators; the
  provisioning load stays out of the fixture generators (the ticket's
  definition of done). How the tenant under test comes to exist is the
  planner's choice within these constraints.
- Appendix E and Appendix J pins are unchanged.

The platform tables join `app.jurisdiction_tread_minimum` wherever the
suite allowlists a tenant-free table: the tenant-column sweep
(`004_tests.sql`, the "tenant-less allowlist"), the revoked-privilege list,
the policy-name exception and check 37b's message. Each entry states why the
table has no tenant column.

`make check` green.
