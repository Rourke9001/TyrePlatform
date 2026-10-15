# ADR-0014: How mutations are audited

- **Status:** Accepted
- **Date:** 2026-09-02
- **Deciders:** Rourke Amiss
- **Related:** ADR-0011 (actor context and authorisation) · ADR-0013 (the
  write-surface contract) · FR-AUD-001 · TYRE-94

## Context

FR-AUD-001 requires "an immutable audit entry for every creation,
modification and deletion of any persisted record." `app.audit_log`
(`tenant_id`, `actor_id`, `action`, `entity_type`, `entity_id`, `before`,
`after`, `at`, `source_ip`, `session_id`) has existed since migration `000001`
(`db/migrations/000001_init.up.sql:502-515`). It is swept into the RLS policy
loop at `000001:546`, so a row lands under the writer's tenant like every
other table, and it has been append-only since the same migration —
`REVOKE UPDATE, DELETE ON app.audit_log FROM app_rw` at `000001:585` — so the
schema has enforced immutability for a table nothing has ever written to.
`000017` added `created_at`/`created_by` stamp columns with no foreign key
(`db/migrations/000017_audit_columns_dr013.up.sql:319-330`), deliberately: an
audit row must stay resolvable even after the actor it names is renamed,
deactivated, or gone from another tenant's view.

Verified: `rg -n "audit_log" db/migrations db/seeds api` shows no writer
anywhere in the tree — every hit is the table's own definition, grant or
stamp columns. `rg -n "INSERT INTO app.audit_log" db api` returns no
matches. That is not for lack of things to audit: thirty migrations and
every write surface built so far have shipped without the table gaining
one. `app.tyre` has carried unaudited update paths since B5 slice 1 —
`app.set_tyre_cost` and `app.dispose_tyre` both `UPDATE app.tyre`
(`db/migrations/000031_tyre_lifecycle_functions.up.sql:156`, `:227`),
reachable from `POST /api/tyres/{tyreID}/cost` and `/dispose` — and
`app.app_user` has carried one since B4.5: the rehire branch of `createUser`
(`POST /api/users`) issues `UPDATE app.app_user` when a deactivated email is
re-invited. `app.vehicle` gains its first update endpoint in this slice
(TYRE-94), which is what turns the gap from a table nobody could mutate yet
into a table someone can mutate silently.

TYRE-94 (AUD-001) is the first ticket that names audit as its subject rather
than a paragraph inside another surface's scope. It requires FR-AUD-001 hold
for `app.vehicle` in this slice; `app.tyre` and `app.app_user` already need
the same coverage today, not eventually, and the decision below records
widening to them as remediation of a live gap, not a speculative list for
tables with no write surface yet.

## Options considered

### Option A — Go writes an audit row per handler

Each handler that mutates a row issues a second insert into `app.audit_log`
inside the same transaction. Attractive because the audit row is written in
the same place the business rule for the mutation is decided, with the full
request context — actor, session, source IP — already in scope.

**Its real downside:** every handler re-implements the same insert, so the
obligation is only as reliable as the least careful handler, and a reviewer
has to check each one rather than one place. Worse, not every mutation goes
through a Go handler with a `before`/`after` pair to hand it — a SQL function
like `app.submit_inspection` writes rows with business logic that has no
per-column Go hook to attach an audit insert to, so this option cannot cover
the write surfaces ADR-0013 already put in SQL.

### Option B — one generic row trigger per audited table

A single trigger function, `app.audit_row_change()`, attached
`AFTER INSERT OR UPDATE FOR EACH ROW` to each table that needs coverage. The
function reads `TG_OP`, `TG_TABLE_NAME`, `NEW` and `OLD` generically, so
adding coverage to another table is one `CREATE TRIGGER` statement, not new
logic. It captures a mutation regardless of whether the row came from a Go
insert, a SQL function, or a seed script — the mechanism sits below all of
them.

**Its real downside:** a full-row `jsonb` snapshot on every insert and update
is one implementation the whole platform depends on, so a bug in it is a bug
in every audited table's history at once, and it says nothing about deletes
(there are none yet — ADR-0013 decision 7 — so this is deferred, not solved).

### Option C — logical decoding / CDC

Stream the write-ahead log through a replication slot into an external
audit sink, decoupling capture from any transaction.

**Its real downside:** infrastructure the pilot does not have — a
replication consumer, a place to run it, and an operational story for when it
falls behind or disconnects. The POC has one Postgres instance and no
message bus. Rejected for this stage; revisit only if audit needs to survive
outside the database that a tenant's row already lives in.

## Decision

We will use Option B: `app.audit_row_change()` is one generic trigger
function, `LANGUAGE plpgsql`, `SECURITY INVOKER`,
`SET search_path = app, pg_temp`, that writes one row per invocation:

```
tenant_id   = the row's tenant_id
actor_id    = app.current_actor_id()
action      = TG_OP
entity_type = TG_TABLE_NAME
entity_id   = the row's id, or the column the trigger names (TG_ARGV[0])
before      = to_jsonb(OLD)   -- NULL on INSERT
after       = to_jsonb(NEW)   -- NULL on DELETE
```

It is attached `AFTER INSERT OR UPDATE FOR EACH ROW` on each audited table,
with `DELETE` added where the app role may delete, and named
`<table>_audited` (e.g. `vehicle_audited`). `SECURITY INVOKER` is deliberate,
not a default left alone: the trigger runs as the writer, so `tenant_isolation`
on `app.audit_log` evaluates against the writer's own session-bound tenant —
ADR-0013 decision 2's `WITH CHECK` (`000001:531-533`) already policy-checked
that tenant_id for any non-superuser writer before the trigger fires.

An UPDATE that changes nothing writes no row: the trigger returns early when
`OLD` and `NEW` agree once `updated_at`/`updated_by` are set aside. The log
records changes, and a PATCH that resends a unit's current values is not one —
`app.set_vehicle_status` refuses the same no-op with TY016 for the same reason.

A table whose rows have no `id` of their own passes the column its entries
are filed under as the trigger's argument. `app.vehicle_tag_map` passes
`vehicle_id`, so a tag added to or removed from a unit is an entry under that
unit (TYRE-98). An UPDATE that moves a link to another unit is filed under
the unit it moves to, with the old unit in `before`; no route moves one. A
row with no `tenant_id` column, or no value in the column named, raises: a
trigger attached with the wrong argument fails its first write instead of
filing an entry under NULL.

A DELETE files the removed row as `before`, with a NULL `after`. Tenant
closure is the one physical deletion DR-014 sanctions, and the cascade that
removes the tenant's rows removes its audit rows too, so an entry written
during it fails `audit_log_tenant_id_fkey`. On a DELETE the trigger's INSERT
runs in an exception block that swallows that one failure and files nothing;
any other error refuses the statement. An `app_rw` session that cannot see
its own tenant, because it unbound or switched `app.tenant_id` partway
through its own DELETE, fails `audit_log`'s policy and is refused, never
skipped (TYRE-98). A row with a NULL tenant passes the key, so its deletion
is still filed. The block costs a subtransaction per row, so an INSERT or
UPDATE, which meets no closure, files outside it.

`tenant_id` here departs from ADR-0013 decision 2, which rules that
`tenant_id` on an insert comes from `app.current_tenant_id()`, never the
request: the trigger reads the row's own `tenant_id` instead (`OLD`'s on a
DELETE), because
`app.audit_log.tenant_id` is nullable (`000001:504`) and a session-derived
source would write `tenant_id = NULL` on every seed-loaded or
superuser-written audit row — a row `tenant_isolation`'s `USING` clause then
hides from every tenant-bound session, an audit entry that exists and that
no one can read.

TYRE-94 attaches the trigger to `app.vehicle`, the one table that ticket gives
an update endpoint to; B6.1 (migration `000037`, TYRE-72) attaches it to
`app.combination` and `app.combination_member`, the two tables that batch
gives a write path to (spec U12: a table with a write path is audited).
B6.2 (migration `000038`, TYRE-90) attaches it to `app.inspection_task`,
which that slice gives a create path to; the submit's close (000023) is
audited under the driver from then on. B6.3.5 R1 (migration `000040`,
TYRE-164) attaches it to `app.inspection`, which that slice gives its first
UPDATE path — the void. TYRE-98 (migration `000056`) attaches it to `app.tyre`, `app.fitment`,
`app.retread_job`, `app.app_user`, `app.vehicle_driver`,
`app.threshold_policy`, `app.configuration` and `app.vehicle_tag`, and, with
`DELETE` and the `vehicle_id` argument, to `app.vehicle_tag_map`. The tables
that stay unaudited, and why, are listed under Consequences.

## Consequences

**Good:** a table gains full FR-AUD-001 coverage from one `CREATE TRIGGER`
statement, with no per-handler code to review or forget, and the mechanism
covers a SQL-function write the same way it covers a Go insert because it
sits on the row, not on the caller. Seed-loaded and suite-planted rows get an
INSERT audit row with a NULL `actor_id`, because `app.current_actor_id()`
returns NULL when no actor is bound (`000001:32-35`) rather than failing the
insert. This is intended, not incidental: a NULL actor means no app actor
was bound, which is a seed, a migration, or an owner action through a
runbook (`docs/runbooks/provision-a-user.md`). FR-AUD-002 names no field
that tells those three apart. Since TYRE-98 every table the app role writes
in place is audited except `display_code_counter` and `valuation_snapshot`;
those and the other tables that stay unaudited are listed below with their
reasons.

**Bad:** `before`/`after` capture every column on the row, so the entries
for `app.app_user` carry personal information (email, display name, staff
number) into `app.audit_log`. Pseudonymising it is deferred again:
NFR-PRV-004 is outside Appendix H.1, and SRS section 5.3 keeps the audit log
apart from application logs, so NFR-PRV-007 does not reach it. When
pseudonymisation is built, it must reach `audit_log.before` and `after` too.
`app.app_user.tenant_id` is NULL for `PLATFORM_ADMIN` (`000001:100`,
FR-TEN-002), so such a row's entry carries a NULL tenant, which
`tenant_isolation`'s `USING` clause (`000001:532`) hides from every tenant
session. No SRS row names a tenant reader for a platform-level entry, so the
owning role alone reads it (FR-AUT-003a). `source_ip` and `session_id`
survive the move to a trigger as GUCs of their own: `store.InActorTx` binds
`app.session_id` for a bearer request (ADR-0016) and `app.source_ip` when
the request's client address parses, and the trigger reads both (`000055`).
A value in `app.source_ip` that is not an address is stored as NULL through
`app.current_source_ip()`, which both writers of this table read, so an
audit detail never fails the write it records (TYRE-383). The other writer
is `app.record_session_start()`, for authentication events (ADR-0016). An
audited table the app role may delete from carries `DELETE` among its
trigger's events; today that is `app.vehicle_tag_map` alone (ADR-0013
decision 7). The app role also deletes from `valuation_snapshot`, which is
unaudited.

`app.tyre_valuation_asof` (`000036`) pins no `search_path`; the reasoning is
in 000036's own header comment.

**Unaudited, and why** (TYRE-98). FR-AUD-001's text asks for every
creation, modification and deletion; leaving the tables below out is an SRS
change, proposed as an FR-AUD-001 erratum in TYRE-427 (owner ruling U132,
15 Oct 2026). Once the erratum is pasted, it replaces that ticket key here.

- Insert-only record tables: `tyre_event`, `reading`, `reading_measurement`,
  `inspection_warning`, `inspection_absent_spare`,
  `vehicle_odometer_reading`, `casing_valuation` and `tenant_consent`. Each
  is written once, never updated or deleted by the app role (DR-011, DR-018),
  and carries DR-013's `created_at` and `created_by`, so each row is its own
  record of its creation. `threshold_policy` is insert-only too since
  `000054`, and is audited because TYRE-98 names it.
- `valuation_snapshot`: a derived cache of `app.tyre_valuation_asof()`
  (`000006`, `000018`), one row per tyre per date, rebuilt from immutable
  readings and events, so any date is recomputable.
- `display_code_counter`: a per-tenant counter with no `id`; its effect is
  the display code on the audited `tyre` row.
- `user_depot`: no write path.
- `inspection_schedule`: no write path yet; TYRE-133 attaches the trigger
  with the path it adds.
- Reference and catalogue tables: `depot`, `operating_group`, `tyre_size`,
  `tyre_brand`, `tyre_pattern`, `tyre_price_list`, `casing_estimate_by_size`,
  `axle_configuration`, `position`, `target_pressure`, `exception_rule`,
  `exception`, `notification` and `photo`. No route writes them today. A
  ticket that adds the first write path attaches the trigger, as U4 and U12
  already require.

A tag link and a valuation snapshot are deleted, and neither conflicts with
DR-014: a tag link is a unit's current label, and a snapshot is a derived
cache over immutable history. Neither is a business record (owner, 14 Oct
2026, TYRE-98 spec Q4).

**Revisit when:** a table's row is large enough that a full-row `jsonb`
snapshot on every update becomes a storage concern of its own (fitment or
reading history, over a long enough tenant lifetime, are the likely
candidates); when a table is given a DELETE path, which adds `DELETE` to its
trigger's events; when TYRE-426 settles how long a tenant's audit rows
outlive its closure (SRS section 5.3's 84 months); or
when CDC infrastructure (Option C) becomes available to the pilot, at which
point per-table triggers may be worth replacing rather than only extending.
