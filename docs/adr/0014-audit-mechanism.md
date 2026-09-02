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
`SET search_path = app, pg_temp`, that writes one row per invocation —

```
tenant_id   = NEW.tenant_id
actor_id    = app.current_actor_id()
action      = TG_OP
entity_type = TG_TABLE_NAME
entity_id   = NEW.id
before      = to_jsonb(OLD)   -- NULL on INSERT
after       = to_jsonb(NEW)
```

— attached `AFTER INSERT OR UPDATE FOR EACH ROW` on each audited table, named
`<table>_audited` (e.g. `vehicle_audited`). `SECURITY INVOKER` is deliberate,
not a default left alone: the trigger runs as the writer, so `tenant_isolation`
on `app.audit_log` evaluates against the writer's own session-bound tenant —
ADR-0013 decision 2's `WITH CHECK` (`000001:531-533`) already policy-checked
that tenant_id for any non-superuser writer before the trigger fires.

`tenant_id` here departs from ADR-0013 decision 2, which rules that
`tenant_id` on an insert comes from `app.current_tenant_id()`, never the
request: the trigger reads `NEW.tenant_id` instead, because
`app.audit_log.tenant_id` is nullable (`000001:504`) and a session-derived
source would write `tenant_id = NULL` on every seed-loaded or
superuser-written audit row — a row `tenant_isolation`'s `USING` clause then
hides from every tenant-bound session, an audit entry that exists and that
no one can read.

This slice attaches the trigger to `app.vehicle` only, the one table TYRE-94
gives an update endpoint to.

## Consequences

**Good:** a table gains full FR-AUD-001 coverage from one `CREATE TRIGGER`
statement, with no per-handler code to review or forget, and the mechanism
covers a SQL-function write the same way it covers a Go insert because it
sits on the row, not on the caller. Seed-loaded and suite-planted rows get an
INSERT audit row with a NULL `actor_id`, because `app.current_actor_id()`
returns NULL when no actor is bound (`000001:32-35`) rather than failing the
insert — this is intended, not incidental: a row that entered the system
without a session behind it is audited as "loaded, not acted," and a reader
of the audit log can rely on a NULL actor meaning exactly that. `app.tyre`
and `app.app_user` already carry the unaudited update paths this ADR exists
to close (Context); widening the trigger to them, plus `app.fitment`,
`app.retread_job`, `app.vehicle_driver`, `app.threshold_policy` and
`app.configuration`, is a scope decision for a follow-up ticket, not evidence
those tables lack a write surface to audit (U4) — raised as TYRE-NN at
close-out.

**Bad:** `before`/`after` capture every column on the row, so once the
trigger reaches `app.app_user` it will carry PII into `app.audit_log` on
every update, and NFR-PRV-004's 84-month retention-then-pseudonymisation rule
then has to apply to audit rows as well as the table they describe. A second
condition sits on that same table: `app.app_user.tenant_id` is nullable —
NULL for `PLATFORM_ADMIN` (`000001:100`) — so an audited mutation of a
platform-admin row would write `tenant_id = NULL` on the audit row, which
`tenant_isolation`'s `USING` clause (`000001:532`) then hides from every
tenant-bound session: a record that exists and that no tenant reader can
ever see. Neither condition is a fact about `app.vehicle` today; both gate
widening to `app.app_user`, not this decision. `source_ip` and `session_id`
are also permanently NULL under this mechanism: `api/internal/store/store.go:108`
binds only `app.tenant_id` and `app.actor_id` as session GUCs, the two the
trigger reads, so Option A's request context — actor, session, source IP —
does not survive the move to a trigger; capturing those two columns would
need binding them as GUCs of their own, which this decision does not do. The
trigger also says nothing about `DELETE`, so the day a write surface is
allowed to remove a row, this decision has to be revisited rather than
assumed to already cover it.

**Revisit when:** a table's row is large enough that a full-row `jsonb`
snapshot on every update becomes a storage concern of its own (fitment or
reading history, over a long enough tenant lifetime, are the likely
candidates); when a write surface is given `DELETE`, since `FOR EACH ROW` on
`INSERT OR UPDATE` captures neither the row nor the fact of its removal; or
when CDC infrastructure (Option C) becomes available to the pilot, at which
point per-table triggers may be worth replacing rather than only extending.
