# db/

The domain model lives here, not in the API. See `docs/architecture.md` for why.

## Before you change anything

`make db-reset && make db-test` must pass **as `app_login`**, not as `postgres`.
Check 0 in the suite asserts this. A run as a superuser bypasses RLS and every
isolation assertion silently becomes vacuous while still printing PASS.

The one file that runs as `postgres` is `db/tests/005_privileged.sql`
(`make db-test-privileged`): it stages what `app_login` cannot, a composite
FK removed inside a transaction it rolls back, to watch a definer-chain
backstop fire, a tenant with no threshold policy in force, which rows
written once leave no `app_login` route to, or a policy row dated days before
the transaction that writes it, which no role may write (TYRE-299). P11 and
P12 stage a role that bypasses RLS, as the Azure admin may, and a platform
catalogue entry, which only a migration's role writes (TYRE-369). It is not the
suite and proves nothing about isolation: the
isolation proofs are `db/tests/004_tests.sql`, run in CI on every build
(NFR-SEC-005).

## Schema changes are migrations

A change is a new pair `migrations/NNNNNN_name.up.sql` + `.down.sql` (next
number in sequence, golang-migrate). Never edit a migration that is already
on `develop` — it has run somewhere and will not run again, and a hook
refuses the edit (TYRE-250). A down file never retires what its up did not
create, and an up retires an earlier object only when a decision orders
it. A DROP followed by its CREATE, under the same or a new signature,
retires nothing. `make db-reset` owns destruction.

Numbering spans directories because it is load order: migrations, then
`seeds/002` and `003`, then the suite `tests/004`.

## Adding a table

Three things, all of them, every time:

```sql
CALL app.enable_tenant_rls('app.your_table'::regclass);
```

That procedure does `ENABLE`, `FORCE`, and a policy with both `USING` and
`WITH CHECK`. Without `FORCE`, the table owner bypasses RLS — and the owner is
the role migrations run as. Without `WITH CHECK`, a caller can *write* rows
into another tenant even though it cannot read them.

`SELECT` arrives by default on every table `postgres` creates in `app`:
000001's `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO
app_rw` grants it the moment a table exists, before anyone decides whether
it is tenant-scoped. A blanket `GRANT ALL` run later (see Append-only,
below) is a separate, later hazard, not this one. `enable_tenant_rls` is
what makes the default ACL safe. Check 12 sweeps every table in `app`,
ordinary and partitioned (`relkind` `r` and `p`), not only tables with a
`tenant_id` column, so a table missing `ENABLE`/`FORCE` fails the build
regardless of the default ACL. A partitioned table needs
`enable_tenant_rls` on the parent as well as on each partition: a query on
the parent applies only the parent's policies.

The default ACL covers every relation kind, and a materialized view or a
foreign table cannot carry a policy, so check 12 refuses either one in `app`
outright. Derived rows that must be stored go in a table with RLS, the way
`valuation_snapshot` does.

A tenant-free reference table is the one exception: a fact that belongs to
no tenant, such as `app.jurisdiction_tread_minimum` or the platform
catalogue's `app.platform_tyre_size`, `_brand` and `_pattern` (000058). It
takes `ENABLE` and `FORCE` and a `FOR SELECT USING (true)` policy instead of
`enable_tenant_rls`, its write privileges are revoked from `app_rw`, and a
migration is its only writer. Name it, with its reason, in each of the
suite's five tenant-free allowlists: checks 2, 4, 12 and 16, and 37b's
message.

Nothing to add to the isolation test: its sweep reads `pg_class` for every
table (`r` or `p`) with RLS on and a `tenant_id` column, so a new table
enrols itself. If it does *not* appear, that is the finding — check 12 fails
a tenant-scoped table that was never enrolled.

## Adding a view

```sql
CREATE VIEW app.v_thing WITH (security_invoker = true) AS ...
```

Not optional. A view without it executes with its **owner's** privileges, so
RLS is evaluated as the migration role and the view returns every tenant's rows
to any caller. Check 8b fails the build if you forget, which is the only reason
this is merely a footgun rather than a breach.

## Adding a function

Invoker rights, always; the one definer is `app.refresh_governing_tread`
(000004, body since 000050), and a new definer needs a review and a suite
section before it lands (check 8c). A new function is executable by
PUBLIC by default, so a definer's migration revokes EXECUTE from PUBLIC and
app_rw: a caller who can execute it can attach it as a trigger to a table
of its own (section 67, TYRE-346). Every plpgsql routine pins `SET
search_path = app, pg_temp`, because plpgsql resolves unqualified names
when it runs and would otherwise follow the caller's path (TYRE-181). A
`LANGUAGE sql` table function that a view is built over carries no pin:
the planner inlines
those and a SET clause blocks the inlining (000036). Check 8d holds both
halves. A write-surface function names its inputs with the `p_` prefix,
and one whose whole request is a single jsonb names it `p_payload`, as
`app.submit_inspection` does. The pure valuation functions keep Appendix
E's argument names. `app.receive_tyres(payload)` predates the rule and
keeps its name, because a rename is a migration and breaks a caller that
names the argument (TYRE-213). Cite this section from a migration; do not
restate it.

Everything the definer reaches, including the snapshot reconcile and
`app.tyre_valuation_asof`, runs with RLS off. A lookup there that finds its
rows through a tenant-leading index must name the tenant in its text, or
the planner cannot use the index and one tenant's submit grows with every
tenant's history (TYRE-259). A primary-key probe needs no tenant. Suite
section 65 pins the three predicates in place. The fitment one has no index
to use yet, and `app.tyre_in_estate_asof` names no tenant (both TYRE-347).

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

`threshold_policy` is written once too (000054): `UPDATE` is revoked from
`app_rw`, and `threshold_policy_written_once` refuses an `UPDATE` from any
role (`TY023`). A change is a new row dated no earlier than the `BEGIN` of
the transaction that writes it; `threshold_policy_not_backdated` refuses an
earlier `effective_from`, except an empty scope's first row at `-infinity`
(SRS §5.1, errata E1). There is no tolerance, so a writer stamps `DEFAULT
now()` or a later instant computed in SQL, never one taken from a client
clock or before its `BEGIN`. A tenant's first row decides its history:
provisioning that writes a first row dated `DEFAULT now()` can never add a
`-infinity` baseline afterwards, and the tenant's history before that row
stays UNVALUED.

`tenant_consent` is written once too: `UPDATE` and `DELETE` are revoked
from `app_rw` (000012), and `tenant_consent_written_once` refuses an
`UPDATE` from any role (`TY027`, 000059), because the runbook connects as
the owning role. `DELETE` stays grant-only, since a tenant's deletion
cascades through its ledger (DR-014). A change of consent is a new row
through `app.record_consent`, dated after the purpose's latest row (U144).

`tyre_receipt` is edited in place, but only through `UPDATE (price_state,
invoice_number)` (000059). `tyre_receipt_moves_once` allows four moves,
never from a final state and never ahead of its tyres' prices, so the
receipt's own functions are the way to move one. `tyre.receipt_id` is held
fixed by the `tyre_receipt_fixed` trigger, since `app_rw` holds `UPDATE` on
`app.tyre` at table level.

A trip ends once (000060): `app_rw` holds `INSERT` and `UPDATE (ended_at,
ended_by)` only, and `trip_ended_once` refuses any other change, a second
end, or an end at any instant but the transaction's `now()` (`TY028`). It
records the bound actor as `ended_by`, whoever the caller names.
`inspection_task_nomination` is insert-only: a new nomination supersedes the
last, and `UPDATE` and `DELETE` are revoked. A closed task keeps its state,
completing inspection and reason: `inspection_task_closes_once` refuses a
move out of `COMPLETED` or `CANCELLED`, or a change to
`completed_inspection_id` or `cancelled_reason` once closed (`TY018`), and
stamps `closed_at`, which the responsibility and capture reads judge a past
instant by. An INSERT may plant a past close,
never a future one (`TY018`). Those reads judge by a task's `vehicle_id`,
`created_at` and `due_at` too, so `app_rw` holds `UPDATE (state,
cancelled_reason, completed_inspection_id)` on `inspection_task` only.
`vehicle_driver` is the history of assignments before trips, with
`INSERT`, `UPDATE` and `DELETE` revoked, and nothing reads it for a
decision.

`casing_estimate_by_size` and `tyre_price_list` are insert-only for
`app_rw` (000058): a changed figure is a new row with a later
`effective_from` (FR-CFG-042). `app.provision_catalogue` refuses an estimate
dated before the current UTC day once its size has an estimate or the
tenant holds a tyre of the size, since it would re-price valuations already
computed (FR-CFG-051, U135). A size's first estimate may be dated back only
until the tenant holds such a tyre, so a new tenant loads its estimates
before its tyres.

The guarantee holds from the row's `COMMIT`, not its `BEGIN`. A row dated
`now()` takes effect at the writer's `BEGIN` and is seen only once it
commits, so a read at an instant in between resolves without it and a later
read of the same instant resolves to it. A rate stored or an exception
judged inside that window can then re-resolve to another row (FR-VAL-020).
The gap is bounded by the writing transaction, so a policy row is written
by a transaction that does nothing else and commits at once (U131). The
transaction that inserts a tenant row is the exception: it may write that
tenant's first policy rows beside everything else, because no other
transaction can see the tenant before it commits (TYRE-374). A
commit-time check against `clock_timestamp()` would close the gap but
refuses `DEFAULT now()` rows; it waits for the first route that writes
policy rows.

Careful: a blanket `GRANT ALL ON ALL TABLES IN SCHEMA app TO app_rw` in a later
migration silently undoes those revokes. Check 4 catches it.

Check 4 treats `UPDATE` as deny-by-default: it fails on any table the app
role can update, at table or column level, that is not on its allow-list.
A new table the app edits in place goes on that list in the same change;
everything else stays a record of fact (TYRE-309).

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
capture order, put the anatomy in `position`, and state `orientation_known`
on every row, `false` where the outer/centre/inner convention did not apply
(FR-IMP-009). The column has no default, so a row that leaves it out is
refused (CHG-011 as amended, TYRE-175). A history that cannot be numbered
1..n is a question about what the data means, to answer before the load.

## Seeds

`tenant_library.py` is the **single source of truth** for the axle
configuration library and the exception rule catalogue, and SRS Appendix I
was produced from the same model, so the spec and the seed data cannot
drift. `seed_policy.py` holds the policy values a tenant starts from. Every
generator and the provisioning path read both, so a provisioned tenant and
the fixture tenants cannot drift apart either. Change the generator, never
the generated SQL. The output is gitignored and CI asserts it is
deterministic.

A real tenant's catalogue comes from two functions, never from a
generator. `app.seed_tenant_catalogue()` copies the platform catalogue into
the bound tenant, and `app.provision_catalogue(p_payload jsonb)` loads the
tenant's own file (`docs/runbooks/provision-a-tenant-catalogue.md`,
TYRE-369). The fixture generators call neither, so each fixture tenant keeps
exactly the catalogue its generator writes.

`provision_tenant.py` writes one real tenant from a provisioning file kept
out of the repository, and its SQL calls `app.seed_tenant_catalogue()`
(`docs/runbooks/provision-a-tenant.md`, TYRE-374). `make db-provision-test`
proves it, with activation and the demonstration load, on two databases of
its own, never `tyre`.

`gen_seed_volume.py` is the odd one out among the fixture generators: it
writes Sandbox Fleet's volume tenant for the dashboard read-path measurement
(TYRE-247) and is loaded only by `make db-volume`, never by `db-reset`, so
the verification suite stays defined on the pinned fixture. `gen_seed_demo.py`
writes `demo_tenant.sql`, the fixture's BAC tenant under demonstration names
for staging (U92, U116). `db-reset` never loads it, because it reuses the
fixture's ids; `make db-provision-test` loads it into a database of its own.
CI hashes both with the other seeds.
