# Database schema — Fleet Tyre Management Platform

PostgreSQL 16. Implements SRS v1.3 §5 (data requirements), §6 (business rules) and CR-001..CR-011.

| File | Purpose |
|---|---|
| `migrations/000001_init.up.sql` | Tables, constraints, RLS policies, roles, business-rule functions, analytical views |
| `seeds/002_seed_configurations.sql` | The fourteen axle configurations of SRS Appendix I, for two tenants (generated) |
| `seeds/003_seed_fixture.sql` | The R13 acceptance fixture — one 27-position combination inspection (generated) |
| `tests/004_tests.sql` | Verification suite. Runs in CI on every build (NFR-SEC-005) |

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

Every statement below was executed against PostgreSQL 16.13 and all sixteen checks pass.

## The three things most likely to be got wrong

**1. The application must not connect as a superuser.** `FORCE ROW LEVEL SECURITY` binds the
table owner but *not* a superuser, and not a role with `BYPASSRLS`. Connect as `postgres` and
every policy in `000001_init.up.sql` is inert while appearing to be in force. `004_tests.sql` refuses
to run as a privileged role for exactly this reason — a green test suite run as `postgres` would
prove nothing.

**2. Views need `security_invoker = true`.** A view executes with its *owner's* privileges by
default, so an RLS-protected table read through a view owned by the migration role returns every
tenant's rows. All four views set it, and test 8b fails the build if a new view omits it.

**3. Tenant context is set per connection, not per query.** `SET app.tenant_id = '...'` after
checking out a pooled connection, and `RESET` before returning it. An unset context matches no
rows rather than all rows (test 1) — the system fails closed.

## Design notes

**Tread is never a scalar.** `reading_measurement` holds one row per width-wise reading with its
ordinal and label; `reading.governing_tread_mm` is a materialised `MIN()` maintained by trigger.
This is CR-011, and it is the change that makes irregular wear visible at all: position 18 of the
fixture reads `0 / 5 / 8`, which no single-value model can express.

**Readings are stored against constituent vehicles, presented in combination numbering.** A driver
inspecting a superlink sees positions 1–26; the register holds three vehicles each numbered from 1
(BR-VEH-003). `combination_position_map` resolves one to the other and `v_combination_reading` is
the inverse view for capture and reporting.

**Append-only is enforced by grant, not by convention.** `UPDATE` and `DELETE` are revoked from
`app_rw` on `reading`, `reading_measurement`, `tyre_event` and `audit_log`. The application cannot
rewrite history through its own connection even with a bug (CR-004).

**Money is `numeric(12,2)`, tread `numeric(4,1)`, pressure and odometer integer.** Test 7
reproduces all fifteen SRS Appendix E valuations to the cent, which is the shape of the FR-VAL-006
acceptance gate.

## What is not here yet

Indexes tuned against real query plans, partitioning of `reading` /
`reading_measurement` by month (not needed below ~10M rows), notification and import tables beyond
their skeletons, and the `PLATFORM_ADMIN` cross-tenant path — which deliberately does not exist
yet, because the safe version of it is a separate role with auditing rather than a policy exemption.
