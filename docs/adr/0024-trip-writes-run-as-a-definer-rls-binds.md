# ADR-0024: Trip and nomination writes run as a definer that row security binds

- **Status:** Proposed (the owner approved the direction on 9 Nov 2026,
  U202; the approval of TYRE-472's spec accepts this record)
- **Date:** 2026-11-16
- **Deciders:** Rourke
- **Related:** TYRE-472 (this record), TYRE-326, TYRE-346, TYRE-467,
  TYRE-209 · ADR-0013 (accepted gaps), ADR-0021 · migrations 000037,
  000044, 000051, 000060 · suite checks 4 and 8c, sections 67, 72 and 76 ·
  FR-TEN-004, FR-VEH-007, FR-INS-051 · CLAUDE.md rules 1 and 3 · spec
  `docs/superpowers/specs/2026-11-16-trip-writes-through-definer-design.md`

## Context

`app_rw` holds INSERT on `app.trip` and `app.inspection_task_nomination`,
and UPDATE on a trip's `ended_at` and `ended_by` (000060:73-74, 205). The
API never uses those grants. It writes through `app.start_trip`,
`app.end_trip` and `app.nominate_for_task`. But a raw INSERT is reachable
as the app role, so 000060 added two triggers, `trip_well_formed` and
`nomination_well_formed`, that repeat each function's rules by hand.

Two implementations of one rule drift. Fourteen of 000060's 33 commits
exist only to bring the triggers back in line with the functions, PR #148
took a review and three re-reviews, and the owner accepted two gaps the
triggers could not close: a raw row can be back-dated (U152), and it
skips the rules only a function holds, such as the due-inspection gate on
a trip start (U153). ADR-0013 records both.

Taking the grants away needs the functions to write rows their caller
cannot, which means SECURITY DEFINER. `db/CLAUDE.md` says "invoker
rights, always", and the one definer, `app.refresh_governing_tread`, runs
with row security off (ADR-0021). That is a fact about its owner, the
migrating role, and not about definers. PostgreSQL skips row security for
a superuser, a role with BYPASSRLS, and a table's owner unless the table
is forced (https://www.postgresql.org/docs/16/ddl-rowsecurity.html). For
any other role the policies apply.

Every tenant policy here is `tenant_id = app.current_tenant_id()` with no
`TO` clause (000001:531-533), so it applies to every role, and the tenant
comes from a session setting that a switch of identity into a definer
leaves alone. No migration reads `current_user` or `session_user`.

Three things make the choice of owner matter:

- The functions call others that find a row by its id alone and leave
  the tenant to row security: `app.end_combination_at` reads
  `WHERE x.id = p_combination` (000044:44), and
  `app.combination_member_in_order` reads a rig the same way (000037:89).
  Today every id that reaches them was first read with the caller's
  tenant named (000060:1593, 1607-1608, 1614-1618), so nothing leaks
  either way. Only review keeps that true of the next edit.
- Staging and production migrate as `tyreadmin`, which is not a
  superuser, so PostgreSQL 16's ownership rules bind there and not on a
  developer's machine.
- The BAC pilot opens in about two weeks, and the owner runs each
  migration by hand.

## Options considered

### Option A: keep both write paths

Nothing changes, and the suite's 74 raw INSERTs keep working.

**Its real downside:** every later change to a trip or nomination rule is
made twice, in a function and in a trigger, and the two accepted gaps
stay open. The cost already paid says the next change pays it again.

### Option B: revoke the raw writes; the three functions run as a role that row security binds

A new role, `app_writer`, with no login, no superuser, no BYPASSRLS and no
tables of its own, owns the three functions and holds only what their
call trees need. `app_rw` loses its INSERT and UPDATE on the two tables
and keeps EXECUTE on the three. Inside a function the policies still
apply, with the caller's tenant.

**Its real downside:** `app_writer`'s grants are a second access list that
no connection ever exercises directly, so the suite has to pin it or it
will grow unnoticed. A row lock needs UPDATE on a column of each locked
table (https://www.postgresql.org/docs/16/sql-select.html), so the role
holds more than "read and insert". The migrating role must be a member
of `app_writer` to hand it the functions and to replace them later, and a
local superuser skips every one of those rules, so a green local run
proves nothing about Azure. The suite's back-dated plants lose their
route and are restaged.

### Option C: revoke the raw writes; the three functions run as the migrating role

ADR-0021's shape, with no new role and no ownership hand-over.

**Its real downside:** row security is off inside functions that
`app_login` calls with ids it chooses. The bodies as written would not
leak, because each id is checked against the tenant before a lookup by
id alone receives it. But isolation would then rest on that ordering in
every later edit, in three call trees, with no policy behind it. Each
lookup would need its tenant predicate written by hand and pinned as
text, as suite section 65 pins the governing-tread chain. ADR-0021
accepted that for one trigger function nobody can call. These three are
the opposite case.

### Option D: keep the grants; a trigger refuses any row the functions did not write

The function sets a transaction-local flag and an INSERT trigger refuses
a row written without it.

**Its real downside:** the app role can set any custom setting itself,
so the flag is one `SET LOCAL` away from a raw INSERT and the second
path stays open.

## Decision

We will revoke `app_rw`'s INSERT on `app.trip` and
`app.inspection_task_nomination` and its UPDATE on `app.trip`, and run
`app.start_trip`, `app.end_trip` and `app.nominate_for_task` as SECURITY
DEFINER functions owned by `app_writer`, a NOLOGIN role that is not a
superuser, does not bypass row security and owns no table (Option B,
U202).

## Consequences

**Good:** a trip or nomination rule lives in one place. A back-dated
trip, a trip that skips the due-inspection gate and a nomination on a
covered unit are no longer reachable as the app role, so U152's and
U153's gaps close and ADR-0013's entry with them. `trip_well_formed` and
`nomination_well_formed` are deleted. Rule 1 holds by the same policies
as before, and rule 3 gets stronger: the app role can no longer write
trip history at an instant it chooses.

**Bad:** there are now two kinds of definer, and the rule for a new one
is no longer one line. The suite's checks 8c and 67a must tell them
apart: one that returns a trigger stays unexecutable by the app role
(TYRE-346), and one on the write list must be owned by a role row
security binds. `app_writer`'s grants need their own exact pin. A later
migration that replaces one of the three must restate SECURITY DEFINER
and the `search_path` pin, and it runs only because the migrating role is
a member of `app_writer`. The app login can no longer reach the two
tables' WITH CHECK or the trip EXCLUDE constraints by a raw INSERT, so
those proofs move to `db/tests/005_privileged.sql`, which stages as
`postgres`.

ADR-0021 named four costs for a role like this one. None applies to these
three functions. They refuse with TY012 when no tenant is bound, where
the governing-tread trigger would have left a NULL. They make no
cross-tenant read. They already run under row security as `app_login`,
so their plans do not change (TYRE-256). And the migration creates the
role itself, because `tyreadmin` holds CREATEROLE (TYRE-305 comment
13834 for staging; Azure grants it to every server administrator,
https://learn.microsoft.com/en-us/azure/postgresql/security/security-manage-database-users).
ADR-0021's own decision stands: `app.refresh_governing_tread` keeps the
migrating role as its owner.

**Revisit when:** a policy gains a `TO` clause or reads the current role,
which would end the premise that a definer sees its caller's tenant; a
fourth function is proposed for the write list (`inspection_task` and
TYRE-467's `app.combination` are the known candidates), which should
reuse `app_writer` and this record, not add a role; or a deployed
`app_writer` reads `rolsuper` or `rolbypassrls` true.
