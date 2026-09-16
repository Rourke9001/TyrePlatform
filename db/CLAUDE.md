# db/

The domain model lives here, not in the API. See `docs/architecture.md` for why.

## Before you change anything

`make db-reset && make db-test` must pass **as `app_login`**, not as `postgres`.
Check 0 in the suite asserts this. A run as a superuser bypasses RLS and every
isolation assertion silently becomes vacuous while still printing PASS.

The one file that runs as `postgres` is `db/tests/005_privileged.sql`
(`make db-test-privileged`): it stages what `app_login` cannot, a composite
FK removed inside a transaction it rolls back, to watch a definer-chain
backstop fire. It is not the suite and proves nothing about isolation: the
isolation proofs are `db/tests/004_tests.sql`, run in CI on every build
(NFR-SEC-005).

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

Nothing to add to the isolation test: its sweep reads `pg_class` for every
table with RLS on and a `tenant_id` column, so a new table enrols itself. If
it does *not* appear, that is the finding — check 12 fails a tenant-scoped
table that was never enrolled.

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

`inspection` is written once too (000040): `UPDATE` is granted on
`(state, void_reason)` only, and `inspection_written_once` allows exactly one
transition — to `VOIDED`, with a reason, once; a voided row is frozen.
`reading` and `reading_measurement` also refuse an `INSERT` whose inspection
was committed by an earlier transaction (`TY020`), so a submitted reading
cannot gain a measurement. Correcting a capture is `app.void_inspection` and
a new capture.

Careful: a blanket `GRANT ALL ON ALL TABLES IN SCHEMA app TO app_rw` in a later
migration silently undoes those revokes. Check 4 catches it.

## Loading readings from outside

Never load `reading_measurement` with triggers disabled.
`session_replication_role = replica`, which is what `pg_restore
--disable-triggers` and most bulk loaders use, switches off every trigger on
the table rather than the one being avoided. `reading_measurement_governs`
goes with it, so `reading.governing_tread_mm` is left NULL and the valuation
and exception views see nothing (TYRE-254).

Nothing forces that choice. Ordinary `INSERT` and ordinary `COPY` both satisfy
the ordinal check, and it constrains numbering rather than completeness: one
measurement is a valid set, so is two. Number ordinals densely from 1 in
capture order, put the anatomy in `position`, and set `orientation_known =
false` where the outer/centre/inner convention did not apply (CHG-011). A
history that cannot be numbered 1..n is a question about what the data means,
to answer before the load.

## Seeds

`gen_seed_configurations.py` and `gen_seed_fixture.py` are the **single source
of truth** for the axle configuration library — SRS Appendix I was produced
from the same model, so the spec and the seed data cannot drift. Change the
generator, never the generated SQL. The output is gitignored and CI asserts it
is deterministic. `seed_policy.py` holds the policy literals both generators
read.

`gen_seed_volume.py` is the third generator and the odd one out: it writes
Sandbox Fleet's volume tenant for the dashboard read-path measurement
(TYRE-247) and is loaded only by `make db-volume`, never by `db-reset`, so
the verification suite stays defined on the pinned fixture. It is hashed by
CI like the other two.
