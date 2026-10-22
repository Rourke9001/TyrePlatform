# Provision a tenant

The owner's procedure for a new fleet, from the TYRE-374 design
(`docs/superpowers/specs/2026-10-17-tenant-provisioning-design.md`). It takes
a platform admin from an empty provisioning file to an ACTIVE tenant whose
first ORG_ADMIN can be linked through `provision-a-user.md`. A tenant is
provisioned from configuration only, under a fresh id (U92), and a platform
admin makes it ACTIVE by hand once its reference data and configuration are
in place, before its first ORG_ADMIN is linked (TYRE-387, option A). No
route or screen creates a tenant (Appendix H.1), so every step here is an
owner action.

Staging holds Sandbox Fleet and the demonstration tenant only (U116). The
pilot tenant is provisioned in production (TYRE-397), never on staging. The
verification suite (`db/tests/004_tests.sql`) never runs against a deployed
environment.

## Before any SQL

- Connect as the database's owning role: `postgres` locally, the Flexible
  Server admin `tyreadmin` in Azure. The app role cannot write `app.tenant`
  (migration 000042).
- Open psql from the folder that holds the generated file. The folder is
  mounted read-only at `/load`. In Azure, run `environment-release.md`
  **Before anything** and **Each release** step 1 first, then:

  ```bash
  pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
  MSYS_NO_PATHCONV=1 docker run --rm -it -e PGPASSWORD="$pw" -v "$(pwd -W):/load:ro" \
    postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea \
    psql "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require"
  unset pw
  ```

  Locally, the same container on the compose network:

  ```bash
  MSYS_NO_PATHCONV=1 docker run --rm -it -e PGPASSWORD=postgres --network tyreplatform_default \
    -v "$(pwd -W):/load:ro" \
    postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea \
    psql "host=tyre-pg dbname=tyre user=postgres"
  ```

  `MSYS_NO_PATHCONV=1` and `pwd -W` are for Git Bash. Without them it
  rewrites the mount and the file never reaches `/load`. If docker answers
  that the input device is not a TTY, put `winpty` in front of `docker`.
- The first statement in psql:

  ```sql
  SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

  Expect `tyreadmin` in Azure or `postgres` locally. Either bypass value is
  fine: every statement the generator writes names its tenant, and binds it
  before the tenant row, so it is correct whether or not the role bypasses
  RLS.
- Each step says what it expects. Anything else: `ROLLBACK;` and stop,
  before `COMMIT`.
- Nothing here binds an app user, so the rows written carry no
  `created_by`, and the consent rows no `actor_id`.
- **Production only:** TYRE-397's backup gate is met before step 2.

## 1. Fill in the provisioning file

Copy `db/seeds/provision_template.json` and fill it in with the policy the
client confirmed against the platform's defaults (onboarding step 1 of the
design) and the consent records from the agreement the client signed. For
Sandbox Fleet, state `"platform_owned": true` and leave `consent` out
(U138). **The file** below says what each field takes.

Name it `<subdomain>.tenant.json` and keep it in a folder outside the
repository. The repository ignores that name as a second guard, but the
file carries the client's policy and consent and never belongs there.

Save it as UTF-8. The generator refuses anything else, including the
UTF-16 that PowerShell 5's `>` writes.

## 2. Generate and run

From the repo root, with the folder's path in place of `<folder>`:

```bash
python db/seeds/provision_tenant.py <folder>/<subdomain>.tenant.json <folder>/<subdomain>.tenant.sql
```

Expect the tenant id on the first line, then the file written, then one
count per table:

```
tenant id: 6f0b3c2e-...
wrote <folder>/<subdomain>.tenant.sql
configuration 16
threshold_policy 2
target_pressure 4
axle_configuration 6
position 52
exception_rule 9
display_code_counter 1
depot 1
tenant_consent 2
```

Note the id and the counts. A refusal starts `refused:`, names the field and
writes nothing: fix the file and run it again. Each run mints a new id, so
the same file run on staging and on production never yields one shared id.

Then in psql:

```sql
\i /load/<subdomain>.tenant.sql
```

It runs as one transaction. It binds the new id, checks a timezone the file
names against Postgres's list, inserts the tenant in PROVISIONING, writes every
row, seeds the platform catalogue, and ends with a count gate that rolls
everything back unless each table holds what the generator wrote. It
commits itself, and `COMMIT` is the last line it prints. If it stops on an
error instead: `ROLLBACK;`. Nothing was written. Fix the file and generate
again, which mints another id.

## 3. Check

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant id>', true);
SELECT id, name, state FROM app.tenant WHERE id = app.current_tenant_id();
SELECT 'configuration' AS t, count(*) FROM app.configuration WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'threshold_policy', count(*) FROM app.threshold_policy WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'target_pressure', count(*) FROM app.target_pressure WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'axle_configuration', count(*) FROM app.axle_configuration WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'position', count(*) FROM app.position WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'exception_rule', count(*) FROM app.exception_rule WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'display_code_counter', count(*) FROM app.display_code_counter WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'depot', count(*) FROM app.depot WHERE tenant_id = app.current_tenant_id()
UNION ALL SELECT 'tenant_consent', count(*) FROM app.tenant_consent WHERE tenant_id = app.current_tenant_id();
ROLLBACK;
```

Expect one tenant row with the fleet's name and the state `PROVISIONING`,
and every count equal to step 2's printout. The check only reads, so it
ends in `ROLLBACK;` either way. Anything else: stop.

## 4. Load the tenant's catalogue file, if it has one

`provision-a-tenant-catalogue.md` steps 1 and 3. Its step 2 is already done:
step 2 above seeded the platform catalogue, and running it again inserts 0.
Load the file before step 5 and before any tyre, because a size's casing
estimate may be dated back only while the tenant holds no tyre of that size
(U135).

## 5. Activate

In one transaction:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant id>', true);
SELECT id, name, state FROM app.tenant WHERE id = app.current_tenant_id();
```

Expect one row with the fleet's name and the state `PROVISIONING`. Then:

```sql
UPDATE app.tenant
   SET state = 'ACTIVE',
       history_horizon = app.tenant_today(timezone)
 WHERE id = app.current_tenant_id() AND state = 'PROVISIONING'
RETURNING id, name, state, history_horizon;
```

Expect one row, `ACTIVE`, with `history_horizon` today's date where the
fleet is (rule 6, FR-TEN-021). Live capture cannot start before then,
because sign-in is refused until the tenant is ACTIVE, and a later import of
the fleet's history loads behind it. Then `COMMIT;`. Zero rows means the
tenant was not in PROVISIONING: `ROLLBACK;` and stop. This is the step
`provision-a-user.md` step 1 cites.

## 6. Record

Add the tenant id and name to the tenant list on Confluence page 10682399,
for that environment. Every user's `platformTenantId` needs the id, and so
does every later import.

## Record or withdraw consent

The tech team records consent at onboarding, from the agreement the client
signed, and again whenever the contract records a change (U143 item 4).
Provisioning writes the file's records itself; this is for any record
after that. A withdrawal is a new record with `false`. The ledger is never
edited: a trigger refuses an `UPDATE` from every role, this one included.

Connect as **Before any SQL** says, then:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant id>', true);
SELECT id, name FROM app.tenant WHERE id = app.current_tenant_id();
```

Expect one row with the fleet's name. Then:

```sql
SELECT app.record_consent('<PURPOSE>', <true|false>, '<notice version>',
  '<YYYY-MM-DD>'::date::timestamp AT TIME ZONE
    (SELECT timezone FROM app.tenant WHERE id = app.current_tenant_id()));
SELECT purpose_code, granted, notice_version, occurred_at
  FROM app.v_tenant_consent_current
 WHERE tenant_id = app.current_tenant_id();
```

The purpose is `SERVICE_DELIVERY` or `ANONYMISED_BENCHMARKING`. The date is
the agreement's, a day in the fleet's own calendar, recorded as that day's
first instant in the fleet's timezone whatever the session's TimeZone. A
date after today is refused, and so is one not after the purpose's latest
record (U144): a second change on the same day is recorded without the
date, as `now()`. The read names the tenant because the admin
role may bypass RLS. Expect the purpose with the state just recorded, then
`COMMIT;`.

Locally, `make record-consent T=<tenant id> P=<PURPOSE> G=<true|false>
N="<notice version>" ON=<YYYY-MM-DD>` does the same.

## 7. First ORG_ADMIN

`provision-a-user.md`, from step 1.

## The file

One JSON object. `name` and `subdomain` are required, `depots` needs one
entry, and a client's file needs a consent record. Everything else is
optional. `db/seeds/provision_template.json` shows every field with the
platform's defaults.

```json
{
  "name": "Example Fleet",
  "subdomain": "example",
  "timezone": "Africa/Johannesburg",
  "display_code_policy": "GENERATED",
  "display_code_prefix": "EXF",
  "depots": [{"name": "Main depot", "type": "DEPOT", "address": "1 Example Road"}],
  "policy": {
    "configuration": {"reading_staleness_days": 21},
    "threshold_policy": {"FLEET": {"retread_threshold_mm": 4.0, "warning_threshold_mm": 6.0}},
    "target_pressure": {"STEER": {"target_kpa": 800}}
  },
  "consent": [{"purpose": "SERVICE_DELIVERY", "granted": true, "notice_version": "<the notice the client signed>"}]
}
```

- **Identity.** `name` is text with no space at either end. `subdomain` is
  lower-case letters, digits and inner hyphens, at most 63 characters,
  unique across tenants. Left out, the others take the schema's defaults:
  `timezone` `Africa/Johannesburg` (an IANA zone name, checked against
  Postgres's list inside the transaction), `locale` `en-ZA`, `currency`
  `ZAR` (three capitals), `pressure_unit` `KPA`, `distance_unit` `KM`,
  `display_code_policy` `FREE`. `KPA` and `KM` are the only units until
  conversion is built: the generator refuses `PSI`, `BAR` and `MI`, and so
  does the database (FR-CFG-021, TYRE-283).
- **Display codes.** `GENERATED` needs `display_code_prefix`, 2 to 8
  capital letters or digits, and gets a counter starting at 1. `FREE`
  takes no prefix and gets no counter.
- **Depots.** At least one, since no route creates one and a tenant
  without one cannot home a unit or scope a driver. Each has a `name`,
  unique within the file, an optional `type` (`DEPOT`, the default,
  `STORE`, `RETREADER` or `BREAKDOWN_SUPPLIER`) and an optional `address`.
- **Policy.** Three optional sections. A value given replaces the
  platform's default as the tenant's baseline row, dated `-infinity` like
  every other baseline row, so it is in force at any date a later import
  can carry (SRS §5.1 errata E1). It is not a second, later row. A section
  or key left out takes the default (`db/seeds/seed_policy.py`).
- **Threshold policy.** Scopes are `FLEET` and the axle classes `STEER`,
  `DRIVE`, `TRAILER`, `TAG` and `SPARE`. Fields: `retread_threshold_mm` and
  `warning_threshold_mm`, at most one decimal place; `max_retreads`, a whole
  number; `retreads_permitted`, true or false. The warning figure must be
  above the retread figure, and the database refuses the run otherwise.
  A class row starts from the fleet-wide row with the file's `FLEET`
  figures applied, then the platform's own class default (`STEER` permits
  no retreads, CHG-038), then the file's fields for that class. From then
  on a class row pins every figure for its class: a later fleet-wide row
  never reaches a class that has its own row, so a fleet-wide change needs
  a new row for each such class too. `STEER` always has its own row.
- **Target pressure.** Classes `STEER`, `DRIVE`, `TRAILER` and `TAG`, never
  `SPARE`, whose pressure is unclassifiable (FR-CFG-013, errata E1). Fields:
  `target_kpa`, a whole number from 100 to 1200; `warn_under_pct`,
  `critical_under_pct`, `warn_over_pct` and `critical_over_pct`, at most one
  decimal place, each critical figure above its warning figure.
- **Configuration.** Each key takes the default's type, and the values its
  reader accepts, because a value at `-infinity` governs every date:

  | Key | Accepts |
  |---|---|
  | `tread_reading_count` | 1 or 3; capture refuses any other width |
  | `capture_spares` | true or false |
  | `due_inspection_blocks_trip` | true or false |
  | `width_spread_warn_mm`, `dual_mate_warn_mm`, `axle_divergence_warn_mm` | a number above 0 |
  | `tread_bands` | a list of `[lower, upper]` pairs starting at 0, lower bounds rising, the last upper bound and only the last `null` |
  | `removal_reasons` | a list of distinct reasons, text with no space at either end |
  | `reading_staleness_days`, `wear_rate_min_distance_km`, `odometer_max_daily_km`, `duplicate_inspection_min_hours`, `submitted_at_future_skew_minutes`, `inspection_max_duration_hours`, `wear_rate_alert_multiple`, `forecast_horizon_days`, `inflation_compliance_window_days` | a whole number above 0 |
  | `tread_capture_granularity_mm` | 1.0, 0.5 or 0.1 |

- **Consent** (U138, OR-LEG-005). A client tenant's file carries the
  consent records from the agreement that client signed, at least one. Each
  has a `purpose` (`SERVICE_DELIVERY` or `ANONYMISED_BENCHMARKING`, each at
  most once; a new purpose is a code change), `granted` true or false, and
  `notice_version`, which names the document the client signed. Only the
  owner can fill it in, so the template's are blank and it is refused until
  they are. A platform-owned tenant such as Sandbox Fleet states
  `"platform_owned": true` and carries no consent record, because no client
  signed anything for it.
- **Refused before any SQL is written:** an `id` field (the generator mints
  it), a field the file format does not know, a key written twice in one
  object, `NaN` or `Infinity`, a control character such as a newline in any
  text, a figure with more decimal places than its column holds (the
  database would round it), and a file that is not UTF-8.
- **Running a committed file again** is refused on the tenant id
  (`tenant_pkey`), and generating from the same file again on the subdomain
  (`tenant_subdomain_key`). Nothing is written either way.

## The demonstration tenant (staging only)

The fixture's Appendix E and J data under the name Demonstration Fleet, with
every number kept and every string that names BAC or its vehicles replaced
(OR-TRN-003, U92). Never on production: it holds specification data under
the fixture's ids.

From the repo root, generate it:

```bash
cd db/seeds && python gen_seed_demo.py
```

Open psql as `tyreadmin` from `db/seeds` (**Before any SQL**), then:

```sql
\i /load/demo_tenant.sql
```

It runs as one transaction and commits itself. Then check:

```sql
BEGIN;
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
SELECT id, name, subdomain, state, history_horizon FROM app.tenant WHERE id = app.current_tenant_id();
ROLLBACK;
```

Expect one row: `Demonstration Fleet`, `demo`, `ACTIVE`, and a history
horizon of today where the fleet is. It carries no consent record, as a
platform-owned tenant (U138). The fixture's users stay as the people who
made its inspections and none of them can sign in. Trainers and trainees
are new users: the first ORG_ADMIN through `provision-a-user.md`, drivers
through the in-app invite. Record it on page 10682399 as step 6 does.

## Not covered here

- Vehicles: TYRE-322.
- The baseline round, which builds the tyre register at first inspection
  (U93).
- Importing historical inspections: TYRE-430.
- Users: `provision-a-user.md`.
