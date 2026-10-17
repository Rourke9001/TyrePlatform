# Design: provision a tenant from configuration only (TYRE-374, with TYRE-387's activation step)

- **Date:** 2026-10-17
- **Ticket:** TYRE-374, under epic TYRE-9. Comment 13702 folds in
  TYRE-387's tenant activation step, which `provision-a-user.md` step 1
  cites.
- **Decisions it rests on:**
  - **U92** (TYRE-374's description, 30 Sep 2026): a tenant is provisioned
    from configuration only, under a fresh id with its consent row; the
    Appendix E and J fixture becomes a separately named demonstration
    tenant, never under the pilot's id; the suite never runs against a
    deployed environment.
  - **U116** (TYRE-79 comment 13569, applied by TYRE-374 comment 13570):
    staging holds Sandbox Fleet and the demonstration tenant only. The
    pilot tenant is provisioned in production (TYRE-397), never on staging.
  - **TYRE-387 option A** (comment 13473): a platform admin makes a tenant
    ACTIVE by hand once its reference data and configuration are in place,
    and before its first ORG_ADMIN is linked. The TYRE-373 erratum on
    FR-TEN-009 and UC-05 records it.
  - **U93** (TYRE-286 comment 13425): the tyre register is built at first
    inspection, not typed in at onboarding.
  - **U135** (TYRE-369): a size's casing estimate may be dated back only
    while the tenant holds no tyre of that size.
  - **The owner, in this spec's conversation (17 Oct 2026):** keep to the
    POC; assume BAC wants its historical inspection sheets on the platform;
    BAC is the first tenant of a product to be sold to other fleets; BAC
    gives any data and support the pilot needs.
- **Requirements:** FR-TEN-005 to 009, 021 and 022, UC-05 as amended by the
  TYRE-373 erratum, Appendix H.1's TEN row (tenants provisioned by hand),
  FR-CFG-005, 011, 013, 014, 016, 023, 025, 032 and 044 (the defaults a new
  tenant starts from), OR-TRN-003 (the demonstration tenant), OR-LEG-005
  (consent for cross-tenant benchmarking). Read them in Confluence; this
  document does not restate them.

## Why this exists

No code creates a tenant. `gen_seed_configurations.py` writes three fixed
test tenants, and `gen_seed_fixture.py` loads the Appendix E and J fixture
into one of them. Staging's database was dropped and migrated to head when
TYRE-79 brought it up, and it has held no tenants since, so nobody can sign
in there. Production (TYRE-397) will need the same procedure for the BAC
pilot, and every later customer will go through it too.

Onboarding, as discussed in this conversation, runs in four steps. The
first two are this ticket:

1. **Confirm policy** (my call to put this first): the client confirms its
   removal threshold, warning band, retread cap, target pressures and other
   settings against the platform's defaults, and the confirmed figures go
   into its provisioning file. Nothing in the app or the API writes a
   threshold, a target pressure or a setting, and a later threshold row can
   only be dated from the moment it is written (000054). So the open-ended
   baseline that imported history is judged by has to be the client's own
   policy from the start.
2. **Provision:** the tenant, its configuration, its reference data and its
   consent records. No fleet data.
3. **Vehicles:** the client's vehicle list, imported (TYRE-322) or typed in.
4. **Baseline round:** the first inspection of each vehicle builds the tyre
   register (TYRE-286, U93).

BAC also expects its historical inspection sheets on the platform. That
import is not this ticket (see "Raised from this spec"), but provisioning
decides whether it can ever be valued, so this ticket makes every tenant
**history-ready**.

## Goals

1. One procedure provisions any tenant from a provisioning file: the same
   file shape for BAC, Sandbox Fleet and every later customer.
2. A provisioned tenant starts in PROVISIONING under a fresh id and holds
   everything FR-TEN-006 and the TYRE-387 ruling require before activation:
   configuration, threshold policy, target pressures, the unit-type library,
   the exception rule catalogue, the platform tyre catalogue, the display
   code counter where the tenant uses generated codes, and its consent
   records.
3. History-ready: a later import of records older than the tenant itself
   finds a policy, a target pressure and every configuration value in force
   at the record's date, and can be valued.
4. A tenant runbook takes a platform admin from an empty file to an ACTIVE
   tenant whose first ORG_ADMIN can be linked through `provision-a-user.md`.
5. Staging can be populated with exactly two tenants: Sandbox Fleet,
   provisioned through this procedure, and the demonstration tenant, loaded
   from the fixture under a name that is not BAC's.

## Non-goals

- Importing vehicles, tyres, odometer records or historical inspections
  (TYRE-322, and the FR-IMP-009 ticket raised below).
- Creating users or Entra accounts. The runbook ends by handing over to
  `provision-a-user.md`.
- An in-app or API route for provisioning. H.2 defers FR-ADM-*; tenants are
  provisioned by hand (H.1).
- Running anything against staging or production. That is the owner's,
  after the merge (see "After the merge").
- The ordering forecast the owner wants after the POC (ticket raised below).
- Storing a subscription tier. FR-TEN-005 names one, but the schema has no
  column and nothing reads one; it goes on the SRS change list (see "Raised
  from this spec").

## Anti-goals

- A real tenant's file or prices committed to the repository.
- A provisioning value hard-coded where it is policy (rule 5). Every
  threshold, band and rate the tenant starts with is a value it can change.
- Any change to the local fixture's output or to a pin in `make db-test`.
- A procedure that can leave a half-provisioned tenant the operator has to
  clean up by hand.

## Design

### The provisioning file

One file per tenant, kept out of the repository, with a committed template
beside the generator that shows every field. It carries:

- **Identity:** name, subdomain, timezone, locale, currency, pressure and
  distance units, display code policy (FREE or GENERATED) and, for
  GENERATED, the code prefix. Schema defaults apply where a field is left
  out, except name and subdomain, which are required.
- **Depots:** name, type and optional address for each.
- **Policy overrides:** any configuration key, threshold, band or target
  pressure the tenant's confirmed policy sets differently from the
  platform's defaults. An override replaces the default as the baseline
  row; it is not a second, later row. The defaults are the SRS figures
  (FR-CFG-011, 013, 014, 016, 023, 025, 032, 044) and today equal the
  fixture's `seed_policy.py` values.
- **Consent:** one or more records, each a purpose, granted or not, and the
  notice version the client agreed to.

The file **refuses** an `id` field, an unknown key, and a consent record
without a notice version. Refusing `id` means the same file run on staging
and on production yields two different tenants, so the pilot's id never
exists on staging (TYRE-397).

**Consent vocabulary (my call).** Purposes are a closed list in the
generator: `SERVICE_DELIVERY` (processing the fleet's data to run the
service) and `ANONYMISED_BENCHMARKING` (OR-LEG-005). Adding a purpose is a
code change. The notice version has no default: it names the document the
client actually signed, and only the owner can fill it in. What each
client consents to is that client's file content, never this document's.
`actor_id` and `created_by` are NULL, because no app user exists at
provisioning.

### One source for what every tenant starts with

The unit-type library, the exception rule catalogue (severities as amended
by the Part 3 errata), the configuration keys and their defaults, and the
default thresholds and pressures exist once. The fixture generator and the
provisioning path both read them, so a real tenant and the demonstration
tenant cannot drift apart. `002_seed_configurations.sql` and
`003_seed_fixture.sql` stay byte-identical, proved by hash before and
after any shared-code change.

### What the generated SQL does

The generator reads a provisioning file and writes SQL. It mints the fresh
tenant id itself and prints it.

1. Binds the new id (`set_config('app.tenant_id', <id>, true)`) **before**
   inserting the tenant row, because `tenant_self`'s `WITH CHECK` requires
   it, and scopes every statement so it is correct whether or not the
   connecting role bypasses RLS (the `provision-a-user.md` pattern).
2. Inserts the tenant in **PROVISIONING**.
3. Writes the baseline rows: every configuration key, the threshold policy,
   the target pressures.
4. Writes the unit-type library and its positions, the exception rule
   catalogue, the display code counter for a GENERATED tenant, and the
   depots.
5. Calls `app.seed_tenant_catalogue()` for the platform tyre catalogue.
6. Writes the consent records.

**One transaction (my call).** All six steps commit together or not at all,
so a failure leaves nothing behind and the operator re-runs the same file.
db/CLAUDE.md (Append-only, U131) asks that a policy row be written by a
transaction that does nothing else, so that nothing reads the gap between
its effective time and its commit. Here nothing can: the tenant row commits
in the same transaction, the tenant is PROVISIONING so every sign-in is
refused, and it has no readings to judge. The red team should test that
reasoning; if it fails, the fallback is a policy-only transaction followed
by an idempotent re-run path, and the half-provisioned case must be
designed rather than left to the operator.

### History-ready

Every baseline row is in force at any date an import can carry:

- The threshold policy's first rows use `effective_from = -infinity`, as
  SRS §5.1 errata E1 and the fixture do. A first row dated `now()` would
  leave everything older permanently unvalued (db/CLAUDE.md, Append-only).
- Configuration and target pressure rows use the same baseline. Neither
  table has a backdating rule, and the builder check found their resolvers
  accept it: `app.config_for` (000007) and `app.target_pressure_for`
  (000045) compare `effective_from < p_before`, and the Go reads in
  `tenant.go` and `units.go` use `<= now()`. The planner confirms this
  still holds at head.
- A policy that changed at a past date cannot be recorded: 000054 allows
  one row before now per scope, the first at `-infinity`. If a client's
  policy changed inside the period its history covers, that is the import
  ticket's problem, not this one's (see "Raised from this spec").
- The tenant's own catalogue file goes in through
  `provision-a-tenant-catalogue.md` after this procedure and before any
  tyre, so its first casing estimates may still be dated back (U135).
- **The history horizon (my call)** is set at activation to the activation
  date, in the tenant's timezone: live capture cannot start before then,
  because sign-in is refused. A later import loads behind it (FR-TEN-021,
  FR-IMP-014).

### The tenant runbook

A new `docs/runbooks/provision-a-tenant.md`, written like its two siblings:
every step says what it expects, and anything else means `ROLLBACK` and
stop. It runs as the database's owning role (`postgres` locally,
`tyreadmin` in Azure), because `app_rw` cannot write `app.tenant`.

1. Fill in the provisioning file from the template, with the policy the
   client confirmed (onboarding step 1).
2. Generate the SQL, note the printed tenant id, and run it.
3. Check: one tenant in PROVISIONING under that id, and the counts the
   generator printed for each table.
4. Load the tenant's catalogue file, if it has one
   (`provision-a-tenant-catalogue.md`).
5. **Activate:** in one transaction bound to the tenant, set the state to
   ACTIVE and the history horizon to today. This is the step
   `provision-a-user.md` step 1 cites (TYRE-387).
6. Record the tenant id and name on Confluence page 10682399 for that
   environment. The id is needed again for every user's `platformTenantId`
   and for every later import.
7. Provision the first ORG_ADMIN with `provision-a-user.md`.

Production adds one precondition before step 2: TYRE-397's backup gate is
met. The runbook states that the suite (`004_tests.sql`) never runs against
a deployed environment.

### Staging

- **Sandbox Fleet** is provisioned through the tenant runbook (my call), so
  staging rehearses exactly what production will run for BAC. It gets a
  fresh id; nothing on staging may assume the local `3333...` id.
- **The demonstration tenant** is the fixture's BAC tenant with every
  number kept and every string that names BAC or its vehicles replaced (my
  call). The readings are specification data and must never read as
  findings about BAC's vehicles.
  - **Kept:** the fixture's ids, and every tread, pressure and money value,
    so the demonstration dashboard shows the same exceptions and value at
    risk as the local fixture. The pilot's id is fresh, so it never shares
    one.
  - **Replaced:** the tenant name ("Demonstration Fleet") and subdomain
    (`demo`); the `branding` row, which carries BAC's name and brand colour
    and which the API serves ahead of the tenant name (left out, so the
    tenant name shows); the display code counter's prefix; the vehicle
    registrations; the display codes' BAC part; the inspection comment
    copied from a real sheet. Nothing on staging runs the suite, so none of
    these are pins there.
  - **Users:** the fixture's users stay as the people who made its
    inspections, with their `example.invalid` emails and no `subject`, so
    none of them can sign in. Trainers and trainees are new users: the
    first ORG_ADMIN through `provision-a-user.md`, drivers through the
    in-app invite.
  - **No consent records** (my call): no client agreed to anything, and
    the tenant holds specification data only.
  - **Loads correctly under a role that does not bypass RLS:** it binds
    its tenant before the tenant row and runs as one transaction. The local
    `002` inserts all three tenants before binding any, which works only
    because `postgres` bypasses RLS.
- "Second Fleet (isolation control)" stays local.

The demonstration load is generated from the same generators as the local
fixture, never edited by hand, and the local output stays byte-identical.
How the generator is told to emit it is the builder's.

### Docs that change with it

- `docs/runbooks/provision-a-user.md` step 1 cites the new activation step.
- `docs/runbooks/environment-release.md` step 5 points at the tenant runbook
  where it says tenants come from TYRE-374.
- db/CLAUDE.md "Seeds" says the generators call neither catalogue function.
  The provisioning path calls `seed_tenant_catalogue()`, so that sentence
  changes to say the fixture generators call neither.

## Testing

- The verification suite's pins stay defined on the fixture. The provisioning
  test therefore runs against its own fresh database, or after the suite,
  never before it: check 28 asserts per-tenant sets, and the isolation
  sweep enrols every tenant.
- **End to end:** provision a sample file on a fresh database at head, then
  check: the tenant is PROVISIONING under the printed id; every configuration
  key the platform reads has a value; the threshold policy, target pressure
  and configuration baselines are in force at a date years before the
  tenant was created; the unit types, positions and exception rules match
  the fixture tenants'; the platform catalogue is seeded; the counter row
  exists for a GENERATED tenant and not for a FREE one; the consent records
  match the file. Then activate it and check the state and the horizon.
- **Refusals:** a file with an `id`, an unknown key, a consent record with
  no notice version, a purpose outside the list, and a missing name or
  subdomain each refuse before any SQL is written.
- **Atomicity:** a run that fails after the tenant row leaves no tenant.
- **Demonstration load:** on a fresh database at head, under a role that
  does not bypass RLS, it loads one tenant whose rows contain no string
  naming BAC, and whose exception counts and value at risk equal the local
  fixture's BAC tenant.
- **Isolation:** the provisioned tenant sees none of the fixture tenants'
  rows, and they see none of its rows, under `app_login`.
- **No drift:** `002` and `003` hash the same before and after;
  `make db-seeds-check` and `make check` are green.

## Left to the builder

- Whether the provisioning mode lives in `gen_seed_configurations.py` or a
  new module beside it, and how the shared parts are factored.
- The provisioning file's format (JSON, matching the catalogue file, unless
  there is a reason not to), and the template's name and place.
- How the generator is asked for the demonstration load.
- Where the end-to-end test runs (a make target, a CI step) and in which
  language, as long as CI runs it.
- Whether a tenant may be provisioned with no depot.

## Raised from this spec

- **SRS change: historical inspection import in the POC.** BAC expects its
  sheets backfilled, but FR-IMP-009 is a Could that H.2 defers. Old sheets
  name a vehicle and position, not a tyre, and the platform never guesses
  which tyre a reading belongs to (FR-TYR-043). The ticket proposes
  position-level history behind the horizon: enough for wear by axle class
  and replacement frequency, not per-tyre valuation. It also asks whether
  BAC's policy changed during the period its sheets cover, because 000054
  cannot record a policy dated in the past.
- **Post-POC, Low: an ordering forecast** on the admin dashboard, from
  usage patterns, so replacements can be budgeted and ordered ahead.
- **On TYRE-373's SRS change list:** FR-TEN-005's subscription tier is not
  stored and has no reader in the POC; F.3's M6 lists FR-ADM-001..008 while
  H.2 defers FR-ADM-*; OR-TRN-003 is a Should outside H.1 and M6, though
  U92 requires the demonstration tenant.

## After the merge (the owner)

1. On staging, run the tenant runbook for Sandbox Fleet and load the
   demonstration tenant.
2. Post the tenant list on TYRE-374 and record both tenants on page
   10682399.
3. BAC's own file, consent notice version included, waits for production
   (TYRE-397).
