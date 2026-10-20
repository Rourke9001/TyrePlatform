# Provision a tenant's tyre catalogue

The owner's procedure for staging and the pilot, from the TYRE-369 design
(`docs/superpowers/specs/2026-10-15-tenant-catalogue-provisioning-design.md`).
It gives a tenant the platform catalogue of sizes, brands and patterns, then
loads the tenant's own file of sizes, brands, patterns, per-size casing
estimates and price list. No route or screen writes these rows yet
(TYRE-417 adds editing in the app), so every step here is an owner action.

It starts once the tenant row exists. Creating the tenant, and the rest of
what a new tenant needs, is `provision-a-tenant.md`, which runs this
runbook as its step 4. A tenant provisioned that way already holds the
platform catalogue, so step 2 below inserts 0 for it.

## Before any SQL

- Connect as `app_login`, the role the API uses, which does not bypass RLS
  (CLAUDE.md rule 1). Nothing here needs more. In Azure, set `$RG`, `$PG`
  and `$KVAPI` as `environment-release.md` does, and open psql with the Key
  Vault `database-url` from the folder that holds the tenant's file. The
  folder is mounted read-only at `/load`:

  ```bash
  dsn=$(az keyvault secret show --vault-name $KVAPI -n database-url --query value -o tsv)
  MSYS_NO_PATHCONV=1 docker run --rm -it -e DSN="$dsn" -v "$(pwd -W):/load:ro" \
    postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea \
    sh -c 'psql "$DSN"'
  unset dsn
  ```

  `MSYS_NO_PATHCONV=1` and `pwd -W` are for Git Bash. Without them it
  rewrites the mount and the file never reaches `/load`. If
  docker answers that the input device is not a TTY, put `winpty` in front
  of `docker`. The first statement in psql:

  ```sql
  SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

  Expect `app_login | f`. Anything else: quit, and check `database-url` as
  `environment-release.md` bring-up step 2 does.
- Locally, `make db-shell` opens psql as `app_login` for steps 1 and 2, and
  `make provision-catalogue T=<tenant id> F=<file>` runs step 3 from a file
  on your machine, in one transaction, printing the fleet's name and the
  counts.
- Run each step in its own transaction that binds the tenant first:

  ```sql
  BEGIN;
  SELECT set_config('app.tenant_id', '<tenant id>', true);
  -- the step
  COMMIT;
  ```

- Each step says what it expects. Anything else: `ROLLBACK;` and stop,
  before `COMMIT`.
- Both functions read and write only the bound tenant's rows, naming
  `app.current_tenant_id()` in every statement, so a step is correct
  whether or not the role bypasses RLS. With no tenant bound, or one that
  does not exist, each refuses before it writes anything.
- The steps bind no app user, so the rows they write carry no
  `created_by`.

## 1. Confirm the tenant

The first statement of steps 2 and 3, after the `set_config`:

```sql
SELECT id, name, state FROM app.tenant WHERE id = app.current_tenant_id();
```

Expect one row with the name of the fleet you are provisioning for. A wrong
tenant id that names another fleet passes every count below, so the name is
what shows the binding is right. Any other name, or no row: `ROLLBACK;` and
stop.

## 2. Seed the platform catalogue

In one transaction, after step 1:

```sql
SELECT (SELECT count(*) FROM app.platform_tyre_size p
         WHERE NOT EXISTS (SELECT 1 FROM app.tyre_size t
                            WHERE t.tenant_id = app.current_tenant_id() AND t.platform_catalogue_id = p.id))
     + (SELECT count(*) FROM app.platform_tyre_brand p
         WHERE NOT EXISTS (SELECT 1 FROM app.tyre_brand t
                            WHERE t.tenant_id = app.current_tenant_id() AND t.platform_catalogue_id = p.id))
     + (SELECT count(*) FROM app.platform_tyre_pattern p
         WHERE NOT EXISTS (SELECT 1 FROM app.tyre_pattern t
                            WHERE t.tenant_id = app.current_tenant_id() AND t.platform_catalogue_id = p.id))
       AS expected;
SELECT app.seed_tenant_catalogue() AS seeded;
```

Expect `seeded` to equal `expected`. A tenant's first seed copies every
platform entry. A later seed, after a migration adds entries, copies only
those, so the step is the same for a new tenant and for one seeded before.
Each copy records the platform entry it came from in
`platform_catalogue_id`.

A refusal that starts `this fleet already has its own` names rows the
fleet added under a platform entry's name before it was seeded. The seed
never adopts such a row and never merges two by name: `ROLLBACK;` and take
the names to the owner, who decides what happens to them (spec D4).

## 3. Load the tenant's file

In one transaction, after step 1, with the file's name in place of
`<file>`:

```sql
CREATE TEMP TABLE catalogue_file (n bigint GENERATED ALWAYS AS IDENTITY, line text) ON COMMIT DROP;
\copy catalogue_file (line) FROM '/load/<file>' WITH (FORMAT csv, QUOTE E'\x01', DELIMITER E'\x02')
SELECT s.key AS section,
       CASE WHEN jsonb_typeof(s.value) = 'array' THEN jsonb_array_length(s.value) END AS rows_in_file
  FROM (SELECT app.catalogue_file_parse(string_agg(line, E'\n' ORDER BY n)) AS doc FROM catalogue_file) AS f
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(f.doc) = 'object' THEN f.doc ELSE '{}' END) AS s;
SELECT * FROM app.provision_catalogue(
  (SELECT app.catalogue_file_parse(string_agg(line, E'\n' ORDER BY n)) FROM catalogue_file));
```

`\copy` reads the file line by line as text, with no character treated as a
quote or a separator, so the file reaches Postgres as written and becomes
`jsonb` there through `app.catalogue_file_parse`. A byte-order mark at the
start, which some Windows editors write, is dropped first. Expect each
section's `inserted` to equal its `rows_in_file`, and 0 for a section the
file leaves out. A section that is not a list shows no `rows_in_file`, and
the load then says what is wrong with it. A file that is not JSON at all,
or that repeats a key inside one object, such as a second `price_list`
section or a field written twice, stops at the first `SELECT`:
`ROLLBACK;` and send it back. `jsonb` would keep only the repeat's last
value, and the counts would not show it.

A refusal names the section, the row counted from 1, and the reason, for
example `price_list row 3: typical_price '1800.005' has more than two
decimal places; a load never rounds an amount`. Nothing in the file has
loaded: `ROLLBACK;` and send the message to whoever supplied the file.

## The file

One JSON object. Every section is optional:

```json
{
  "sizes":            [{"name": "12R22.5", "construction": "RADIAL"}],
  "brands":           [{"name": "Brand A"}],
  "patterns":         [{"name": "Pattern A1", "brand": "Brand A", "applies_to": "NEW"}],
  "casing_estimates": [{"size": "12R22.5", "estimated_value": "1800.00", "effective_from": "2026-11-01"}],
  "price_list":       [{"size": "12R22.5", "brand": "Brand A", "typical_price": "4300.00", "effective_from": "2026-11-01"}]
}
```

- **Sizes** need a `name`. `construction` is `RADIAL` or `CROSS_PLY`, or
  left out.
- **Brands** need a `name`.
- **Patterns** need a `name` and `applies_to`: `NEW`, `RETREAD` or
  `BOTH`. Receipt offers a pattern for a new tyre only when it applies to
  `NEW` or `BOTH`. `brand` is optional.
- **Casing estimates** need a `size`, an `estimated_value` and an
  `effective_from`.
- **Price list** rows need a `size`, a `typical_price` and an
  `effective_from`. `brand` is optional; a row without one is the size's
  price with no brand named. Date a price row on or before every received
  date onboarding will enter for that size: a receive dated earlier gets no
  estimate, and its unpriced receipt cannot take the list price
  (FR-CFG-041, TYRE-283).
- **Names.** A size or brand a row names is one the fleet has, seeded or
  its own, or one an earlier section of the same file adds. Names match
  exactly, capitals included. A name that is empty or has a space at either
  end, a no-break or zero-width one included, is refused.
- **Insert only.** A size, brand or pattern the fleet already has, or one
  the file names twice, is refused. So is an estimate for a size and date
  that already has one, or a price for a size, brand and date that already
  has one. A changed figure is a new row with a later `effective_from`, and
  the row it supersedes stays.
- **Estimates are never dated back over a valuation** (FR-CFG-051, U135).
  A size's first estimate may carry a past date while the fleet holds no
  tyre of that size, which is how a new tenant's file is loaded. Once the
  size has an estimate, or the fleet holds a tyre of it, an estimate is
  dated today (UTC) or later: an earlier date would re-price valuations
  already computed. Load a new tenant's estimates before its tyres.
- **Amounts** are JSON strings of rand with at most two decimal places,
  such as `"1837.50"`. A JSON number, a third decimal place, a negative
  amount or one above 9999999999.99 is refused, never rounded.
- **Dates.** `effective_from` is required on every estimate and price row,
  written `YYYY-MM-DD`. The figure applies from the UTC day of that date,
  in any valuation as at that day or later.
- A section or field the load does not know is refused, so a misspelt
  `estimated_value` never loads a row without its value.
- The file holds the tenant's prices. It stays out of the repository.

## Not covered here

- Creating the tenant row and the rest of a new tenant's defaults:
  `provision-a-tenant.md`.
- Adding, editing or deactivating catalogue rows in the app: TYRE-417.
- Reading the price list at receipt: the Receive tyres form and the open
  receipts list (TYRE-283).
