# Database schema — Fleet Tyre Management Platform

PostgreSQL 16. Implements SRS §5 (data requirements), §6 (business rules),
CR-001..CR-011 and the sponsor answers of record (CHG/CFL series).

| Path | Purpose |
|---|---|
| `migrations/` | Numbered up/down pairs: tables, constraints, RLS policies, roles, business-rule functions, analytical views |
| `seeds/002_seed_configurations.sql` | The fourteen axle configurations of SRS Appendix I, for two tenants (generated) |
| `seeds/003_seed_fixture.sql` | The acceptance fixture — the 27-position combination capture sheet plus the prior capture that yields wear rates (generated) |
| `tests/004_tests.sql` | Verification suite. Runs in CI on every build (NFR-SEC-005) |

The numbering spans directories because it is load order, not file order:
migrations first, then seeds `002`/`003`, then the suite `004`.

## Migrations

Schema changes are [golang-migrate](https://github.com/golang-migrate/migrate)
migrations: paired `NNNNNN_name.up.sql` / `NNNNNN_name.down.sql` files in
`migrations/`, applied in order and versioned in the `schema_migrations`
table. The runner is the `migrate` service in `docker-compose.yml`, so no
local install is needed, and CI applies the same files with the same image.

- New change → next number, both `.up.sql` and `.down.sql`, never edit an
  applied migration.
- `make db-migrate` applies pending migrations to the running database.
- `make db-reset` drops everything and replays all migrations plus seeds —
  destruction lives here, never inside a migration file.

## Running it

```bash
make db-reset   # start Postgres 16, replay migrations, regenerate + load seeds
make db-test    # the verification suite, as app_login — must be a non-superuser
```

## The three things most likely to be got wrong

**1. The application must not connect as a superuser.** `FORCE ROW LEVEL SECURITY` binds the
table owner but *not* a superuser, and not a role with `BYPASSRLS`. Connect as `postgres` and
every policy in `000001_init.up.sql` is inert while appearing to be in force. `004_tests.sql` refuses
to run as a privileged role for exactly this reason — a green test suite run as `postgres` would
prove nothing.

**2. Views need `security_invoker = true`.** A view executes with its *owner's* privileges by
default, so an RLS-protected table read through a view owned by the migration role returns every
tenant's rows. Every view sets it, and check 8b sweeps the catalog so a new view that omits it
fails the build.

**3. Tenant context is transaction-local, never session-scoped.** The API binds the tenant with
`set_config('app.tenant_id', $1, true)` inside the request's transaction —
`api/internal/store.InTenantTx` is the canonical implementation and says why — so the context
dies with the transaction and a pooled connection cannot carry one tenant into the next request.
An unset context matches no rows rather than all rows (check 1): the system fails closed.

## Design notes

**Tread is never a scalar.** `reading_measurement` holds one row per width-wise reading, each
carrying its ordinal, its canonical position (outer/centre/inner relative to the vehicle
centreline — CHG-010) and its measurement granularity; `reading.governing_tread_mm` is a
materialised `MIN()` maintained by trigger. This is CR-011, and it is the change that makes
irregular wear visible at all: position 18 of the fixture reads `0 / 5 / 8`, which no
single-value model can express.

**Readings are stored against constituent vehicles, presented in combination numbering.** A driver
inspecting a superlink sees positions 1–26; the register holds three vehicles each numbered from 1
(BR-VEH-003). `v_combination_reading` computes the combination numbering from member sequence and
per-vehicle position order — a projection, not a stored map, so recomposing a combination can
never orphan a mapping row.

**Append-only is enforced by grant, not by convention.** `UPDATE` and `DELETE` are revoked from
`app_rw` on `reading`, `reading_measurement`, `tyre_event`, `audit_log`, `casing_valuation`,
`tenant_consent` and `vehicle_odometer_reading`. The application cannot rewrite history through
its own connection even with a bug (CR-004).

**Money is `numeric(12,2)`, tread `numeric(4,1)`, pressure `int` kPa, odometer `bigint` km.**
Check 7 reproduces all fifteen SRS Appendix E valuations to the cent, which is the shape of the
FR-VAL-006 acceptance gate.

## What is not here yet

Indexes tuned against real query plans, partitioning of `reading` /
`reading_measurement` by month (not needed below ~10M rows), writers for the
`audit_log` and `notification` tables (both are enforced skeletons), the
exception *lifecycle* — detection is proven live by the suite, but nothing yet
inserts into `app.exception` or walks RAISED→CLOSED — the fuel-record import
behind the odometer timeline, and the `PLATFORM_ADMIN` cross-tenant path —
which deliberately does not exist yet, because the safe version of it is a
separate role with auditing rather than a policy exemption.
