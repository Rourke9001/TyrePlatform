# db/

The domain model lives here, not in the API. See `docs/architecture.md` for why.

## Before you change anything

`make db-reset && make db-test` must pass **as `app_login`**, not as `postgres`.
Check 0 in the suite asserts this. A run as a superuser bypasses RLS and every
isolation assertion silently becomes vacuous while still printing PASS.

## Schema changes are migrations

A change is a new pair `migrations/NNNNNN_name.up.sql` + `.down.sql` (next
number in sequence, golang-migrate). Never edit a migration that is already
on `main` — it has run somewhere and will not run again. Migrations never
DROP what they did not create; `make db-reset` owns destruction.

## Adding a table

Three things, all of them, every time:

```sql
CALL app.enable_tenant_rls('app.your_table'::regclass);
```

That procedure does `ENABLE`, `FORCE`, and a policy with both `USING` and
`WITH CHECK`. Without `FORCE`, the table owner bypasses RLS — and the owner is
the role migrations run as. Without `WITH CHECK`, a caller can *write* rows
into another tenant even though it cannot read them.

Then add the table name to the sweep array in the isolation test so the suite
checks it.

## Adding a view

```sql
CREATE VIEW app.v_thing WITH (security_invoker = true) AS ...
```

Not optional. A view without it executes with its **owner's** privileges, so
RLS is evaluated as the migration role and the view returns every tenant's rows
to any caller. Check 8b fails the build if you forget, which is the only reason
this is merely a footgun rather than a breach.

## Money

`numeric`, never `real` or `double precision`. `app.tread_value()` and
`app.rand_per_mm()` are the only implementations of the valuation arithmetic
that may exist anywhere in this codebase. Check 7 pins them to the fifteen
worked examples in SRS Appendix E — all fifteen, to the cent.

## Append-only

`reading`, `reading_measurement`, `tyre_event` and `audit_log` have `UPDATE`
and `DELETE` revoked from `app_rw`. Correcting a reading means appending a
compensating event, never rewriting one.

Careful: a blanket `GRANT ALL ON ALL TABLES IN SCHEMA app TO app_rw` in a later
migration silently undoes those revokes. Check 4 catches it.

## Seeds

`gen_seed_configurations.py` and `gen_seed_fixture.py` are the **single source
of truth** for the axle configuration library — SRS Appendix I was produced
from the same model, so the spec and the seed data cannot drift. Change the
generator, never the generated SQL. The output is gitignored and CI asserts it
is deterministic.
