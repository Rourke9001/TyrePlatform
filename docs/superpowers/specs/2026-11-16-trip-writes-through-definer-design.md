# Trips and nominations are written only through their functions: the raw grants go, and the functions run as a role row security binds

Date: 2026-11-16. Ticket: TYRE-472 (epic TYRE-55). Status: approved by
the owner on 16 Nov 2026 (U217). From the 9 Nov 2026 design audit, section 2
(verdict Replace). Owner ruling U202 (9 Nov 2026) approved the direction:
`app_rw` loses its raw writes on the two tables, the three functions run
as a NOLOGIN, NOSUPERUSER, NOBYPASSRLS definer, the cost is restaging the
suite's plants, and an ADR comes first. The ADR is
`docs/adr/0024-trip-writes-run-as-a-definer-rls-binds.md`, Accepted with
this spec's approval.

Requirements this touches, none of them changed: FR-TEN-004 and
NFR-SEC-005 (isolation in the database, proven in CI), FR-VEH-007 as
amended (trips), FR-INS-051 and FR-INS-053 as amended (nominations),
FR-AUD-001 (the audit entry each write files). CLAUDE.md rules 1 and 3.

This spec departs from the ticket's design in eight places, each from
reading the code the ticket summarised:

1. `app_writer` needs more than "INSERT on the two tables and SELECT on
   what the functions read". Inside a definer, every nested function and
   every trigger runs as the definer's owner (section 2).
2. Suite section 67a refuses any definer the app login can execute, with
   no allowlist. The ticket names only check 8c (section 6).
3. `005_privileged.sql` P17 and P18 disable the two triggers this change
   deletes. The ticket's Deletes list misses them (section 7).
4. The fixture generator is not used to restage the suite's plants,
   because the same generator writes the demonstration tenant that loads
   on staging (section 8).
5. The migration is written for a role that is not a superuser, and a
   harness leg proves it, because a local run as `postgres` skips every
   ownership rule that binds `tyreadmin` (sections 4 and 9).
6. ADR-0013's accepted-gaps entry is closed in place, as that list's
   first entry was, not deleted (section 10).
7. The live step the ticket left open is answered for staging: `tyreadmin`
   reads `rolcreaterole` true there (TYRE-305 comment 13834). Production
   is read at its first migrate (section 11).
8. Three rule 1 proofs lose their `app_login` route and move to
   `005_privileged.sql`, probed as a role row security binds, and the
   four lines that say 005 proves nothing about isolation are reworded
   (sections 7 and 10). The owner's approval of this spec rules on that.

## Intent

A trip or a nomination has one set of rules, and today two things hold
them: the SQL function the API calls, and a trigger that repeats the
function for a raw INSERT nobody makes. The trigger exists only because
the app role can still INSERT. Take the grant away and the trigger, its
tests, and two owner-accepted gaps go with it.

The functions then have to write rows their caller cannot, so they become
SECURITY DEFINER. The one thing that keeps that inside rule 1 is who owns
them: a role that row security binds. ADR-0024 carries that argument and
the options weighed.

## What the spec-stage reading showed

- **Nothing in production writes the two tables raw.** The Go API calls
  the three functions as `app_login` (`api/internal/httpapi/trips.go:363`,
  `:487`, `tasks.go:304`). Inside migrations, the only other writers are
  000060's one-off data step (`:433`, `:452`, `:476`), which ran as the
  migrating role.
- **Every other raw writer already runs as a role the revoke does not
  touch.** Seeds 002 and 003 load as `postgres` (`Makefile:98-101`). The
  demonstration tenant loads as `provision_owner` locally
  (`scripts/provision-tenant.test.sh:193`) and as `tyreadmin` on staging.
  The Go tests plant through the admin connection, which is `postgres`
  (`api/internal/httpapi/httpapi_test.go:28-43`).
- **Only `db/tests/004_tests.sql` writes raw as the app role.** It
  connects as `app_login` and never switches role. 85 lines write the two
  tables: 48 trip INSERTs, 26 nomination INSERTs and 11 trip UPDATEs. Of
  those, 36 expect a refusal and 49 succeed, and 43 of the 49 name a past
  instant. Another 51 lines already call the three functions.
- **No policy names a role.** None of the six `CREATE POLICY` statements
  has a `TO` clause, and no migration reads `current_user` or
  `session_user`.
- **The functions lean on row security in places.** 000060's own
  functions name the tenant in every read, but `app.end_combination_at`
  and `app.create_combination_at`, which `app.start_trip` calls, find a
  rig or a unit by id alone (`000044:44`, and the `FOR UPDATE` over
  `app.vehicle`), as does the trigger `app.combination_member_in_order`
  (`000037:89`). Every id that reaches them today was first read with the
  tenant named (`000060:1593`, `:1607-1608`, `:1614-1618`), so nothing
  would leak with row security off. An owner that row security binds
  means the next edit does not have to get that ordering right.
- **PostgreSQL 16 everywhere.** `infra/platform.bicep:245`,
  `docker-compose.yml:6`, `.github/workflows/ci.yml:30`.
- **`tyreadmin` on staging:** `rolsuper` false, `rolbypassrls` true,
  `rolcreaterole` true (TYRE-305 comment 13834, read 19 Oct 2026).
  Migrations reach staging and production by hand, as `tyreadmin`
  (`docs/runbooks/environment-release.md`, Each release, step 2).
- **No SRS text describes the raw path, the triggers or definer rights.**
  A Confluence search of space TYRE for U152, U153, the trigger names,
  "raw INSERT" and "invoker rights" finds no SRS page. No SRS row changes
  and no errata is owed.

## Goals

1. As `app_login`, a raw INSERT into `app.trip` or
   `app.inspection_task_nomination`, and a raw UPDATE of `app.trip`, is
   refused for want of privilege.
2. The three functions behave for every caller exactly as they do today:
   same results, same refusals in the same order with the same codes and
   words, same audit entries, same actor recorded.
3. Inside the three functions, row security applies with the caller's
   tenant, and a check that fails the build says so.
4. `trip_well_formed` and `nomination_well_formed` and their functions
   are gone, with every test and document that existed for them.
5. The migration applies as a role shaped like `tyreadmin`, and a gate
   proves it for a role that already exists. The branch where that role
   creates `app_writer` itself is an accepted gap (section 9).
6. Every rule the suite proved through a raw plant is still proved, by a
   route this spec names.

## Non-goals

- `inspection_task` has the same double-held pattern, but
  `app.submit_inspection` and `app.generate_inspection_tasks` need its
  grants. Not here.
- TYRE-467 (`app.combination` accepts an end before its start on a raw
  UPDATE) and TYRE-209. The same shape would close 467, in its own
  ticket, reusing `app_writer`.
- `app.refresh_governing_tread` keeps its owner. ADR-0021 stands.
- No Go, web or API change. No new SQLSTATE and no changed message.
- `trip_ended_once` stays. It holds the shape of an end for any role,
  the owner included.

## Anti-goals

- A suite-only way to plant rows, in any schema. The database the suite
  tests must be exactly what the migrations produce.
- A weaker suite. A test that loses its route moves to another route. It
  is not deleted unless the rule it tested is deleted.
- An `app_writer` that holds a privilege "in case". Each grant names the
  statement that needs it.
- A second copy of any trip or nomination rule, which is the thing this
  ticket removes.

## Constraints

- **Rule 1.** A verified finding against it stops the run for the owner.
  The `rls-auditor` runs on the migration.
- **Rule 3.** Trip and nomination history. The `append-only-auditor`
  runs on the migration.
- **000060 is on `develop` and is never edited** (TYRE-250). This is a
  new pair, `000061`.
- **A down file never retires what its up did not create**, and
  `make db-reset` keeps cluster roles (`db/CLAUDE.md`, Schema changes are
  migrations; `000001_init.down.sql:2`).
- **The suite runs as `app_login`** and check 0 refuses anything else.
  `005_privileged.sql` is the one file that stages as `postgres`.
- **Roles are cluster-wide.** `make db-provision-test` builds its own
  databases in the same cluster, so they share `app_writer`.
- **The shared local database.** This run does not reset or load it
  while another agent's gate is running.

## Approaches

ADR-0024 weighs four ways to hold the rules once. In short:

- **Keep both paths.** Costs nothing now and the same again at the next
  rule change.
- **A definer owned by `app_writer`, which row security binds.** The
  owner's choice (U202) and this spec's design.
- **A definer owned by the migrating role.** Row security would be off
  inside functions the app role calls with ids it chooses, and the
  combination functions find rows by id alone.
- **Keep the grant and gate the INSERT on a session flag.** The app role
  can set the flag.

For restaging the suite's plants, three ways were weighed. The fixture
generator would put test history into the demonstration tenant. A
planting function installed only for the suite would mean the suite
tests a database production never has. The one left is the repo's own
pattern: the real function where a row dated now serves, and
`005_privileged.sql` where it does not (section 8).

## The design

### 1. The role

Migration 000061 creates `app_writer` if the cluster has none, in a
guarded `DO` block as 000001 creates `app_login` (`000001:709-713`):
NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE.

It then asserts, whether it created the role or found it, that
`rolsuper`, `rolbypassrls`, `rolcanlogin`, `rolcreaterole`, `rolcreatedb`
and `rolreplication` are all false, and raises if any is not. It does not
`ALTER ROLE` an existing role into shape: a role that is not a superuser
may not name the SUPERUSER property at all
(https://www.postgresql.org/docs/16/sql-alterrole.html), and a role
found in the wrong shape is a fact someone should look at.

`app_writer` is a member of no role. Its only member is the role that
runs the migration (section 4).

### 2. What `app_writer` holds

Inside a SECURITY DEFINER function the current user is the owner, so
every nested invoker function, every view with `security_invoker`, every
trigger the writes fire and every policy expression runs as `app_writer`.
Its grants are the three call trees' needs and nothing else.

Read from the code, the set is:

| Object                                     | Privilege                                  | Needed by                                                                         |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- |
| schema `app`                               | USAGE                                      | everything                                                                        |
| `trip`                                     | SELECT, INSERT, UPDATE (ended_at, ended_by) | `start_trip`, `end_trip`                                                          |
| `inspection_task_nomination`               | SELECT, INSERT                             | `nominate_for_task`                                                               |
| `inspection_task`                          | SELECT, row lock                           | `nominate_for_task` (`FOR UPDATE`), `trip_start_blockers`                         |
| `app_user`                                 | SELECT, row lock                           | `start_trip` (`FOR NO KEY UPDATE`), `nominate_for_task`                           |
| `vehicle`                                  | SELECT, row lock                           | `start_trip` and `create_combination_at` (`FOR UPDATE`)                           |
| `combination`                              | SELECT, INSERT, UPDATE (effective_to)      | `end_combination_at`, `create_combination_at`                                     |
| `combination_member`                       | SELECT, INSERT                             | `create_combination_at`, `v_unit_coverage`                                        |
| `tenant`, `configuration`                  | SELECT                                     | `trip_start_blockers`, `config_for`                                               |
| `audit_log`                                | INSERT                                     | `audit_row_change` on each write                                                  |
| sequence `audit_log_id_seq`                | USAGE                                      | `audit_log.id` is `bigserial` (`000001:503`)                                      |
| `v_unit_coverage`                          | SELECT                                     | `nominate_for_task`                                                               |
| `end_combination_at`, `create_combination_at` | EXECUTE                                 | `start_trip`; PUBLIC is revoked on both (`000044:66`, `:181`)                     |

A row lock (`FOR UPDATE`, `FOR NO KEY UPDATE`) needs UPDATE on at least
one column of the locked table
(https://www.postgresql.org/docs/16/sql-select.html). Where `app_writer`
needs a lock and no real update, it gets UPDATE on `updated_at` alone,
the column `app.stamp_updated` overwrites on every UPDATE, so the
privilege can change nothing a reader trusts.

This table is the reading, not the proof. The builder derives the final
set by running the suite and the Go tests against the migration: a
missing grant fails a function call with `42501`. Triggers on
`combination` and `combination_member`, and any function in the trees
with PUBLIC revoked (`app.current_source_ip` is one to check), may add
rows. Each row added names the statement that needs it. Nothing is
granted by `ALL`, by `ON ALL TABLES` or through membership.

000001's default privileges grant new tables' SELECT to `app_rw` only, so
`app_writer` gains nothing when a table is added. A later change that
makes one of the three read a new table adds the grant in its own
migration.

### 3. The three functions

`app.start_trip(uuid, uuid, uuid[])`, `app.end_trip(uuid)` and
`app.nominate_for_task(uuid, uuid)` keep their bodies, signatures,
return types and `SET search_path = app, pg_temp` byte for byte. The
migration uses `ALTER FUNCTION`, not `CREATE OR REPLACE`, so no body is
restated:

- `ALTER FUNCTION ... SECURITY DEFINER`;
- `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO app_rw`;
- `ALTER FUNCTION ... OWNER TO app_writer`.

All of it runs in the migration's one transaction, so no moment exists
where a definer is executable by PUBLIC
(https://www.postgresql.org/docs/16/sql-createfunction.html, Writing
SECURITY DEFINER Functions Safely). The pin already has `pg_temp` last,
as that section asks.

None of the three returns a trigger, so none can be attached to a
caller's table, which is the route TYRE-346 closed for the
governing-tread definer.

`app.create_inspection_task` stays an invoker function and keeps calling
`app.nominate_for_task`. `app.trip_start_blockers` stays an invoker
function: Go reads it as `app_login` before a start, and `app.start_trip`
reads it as `app_writer`.

### 4. The hand-over, written for a role that is not a superuser

`OWNER TO` needs the migrating role to be able to `SET ROLE` to the new
owner, and the new owner to hold CREATE on the function's schema
(https://www.postgresql.org/docs/16/sql-alterfunction.html). Replacing a
function later needs the migrating role to be a member of its owner
(https://www.postgresql.org/docs/16/sql-createfunction.html). A role
that creates another with CREATEROLE gets ADMIN on it but neither SET nor
INHERIT, and may grant itself both
(https://www.postgresql.org/docs/16/role-attributes.html). `postgres`
skips all of this, and `tyreadmin` does not. So the migration, in order:

1. creates or finds the role and asserts its attributes (section 1);
2. `GRANT app_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`;
3. grants `app_writer` its privileges (section 2);
4. `GRANT CREATE ON SCHEMA app TO app_writer`;
5. alters the three functions (section 3);
6. `REVOKE CREATE ON SCHEMA app FROM app_writer`;
7. revokes `app_rw`'s INSERT on both tables and its UPDATE on `trip`;
8. drops the two triggers and their functions (section 5).

The membership in step 2 is permanent. It is what lets a later migration
`CREATE OR REPLACE` one of the three, and it gives the migrating role
nothing it lacks, since that role owns every table `app_writer` can
touch.

### 5. Revokes and deletes

- `REVOKE INSERT ON app.trip FROM app_rw`,
  `REVOKE UPDATE (ended_at, ended_by) ON app.trip FROM app_rw` and
  `REVOKE INSERT ON app.inspection_task_nomination FROM app_rw`. SELECT
  stays.
- `DROP TRIGGER trip_well_formed`, `DROP FUNCTION
  app.trip_is_well_formed()`, `DROP TRIGGER nomination_well_formed`,
  `DROP FUNCTION app.nomination_is_well_formed()`. U202 is the decision
  that orders the retirement (`db/CLAUDE.md`, Schema changes are
  migrations).
- `trip_ended_once`, `trip_stamps_updated`, both audit triggers, the
  EXCLUDE constraints, the CHECK and every FK stay.
- The table comment on `app.trip` and any comment that says `app_rw`
  holds INSERT is rewritten by `COMMENT ON` to say who writes it now.

The down file restores 000060's state in reverse: both trigger functions
and triggers with 000060's bodies, the three grants to `app_rw`, the
functions back to the migrating role as invoker functions with PUBLIC's
EXECUTE as 000060 left it, `app_writer`'s privileges revoked. It leaves
the role and the membership in place, as 000001's down leaves `app_rw`:
`DROP ROLE` fails while any database in the cluster still refers to the
role (https://www.postgresql.org/docs/16/sql-droprole.html), and the
provisioning databases share it.

### 6. The suite, `db/tests/004_tests.sql`

**Check 4.** `trip` and `inspection_task_nomination` join the INSERT
list the app role must not hold, so a later blanket GRANT fails the
build. `trip` leaves the UPDATE allow-list.

**Check 8c** keeps its sweep of every definer in `app` and gets two
named lists in place of one:

- definers that run with row security off: `refresh_governing_tread`,
  as today;
- write-list definers: the three. For each, the owner is `app_writer`,
  the function does not return a trigger, its `proconfig` pins
  `search_path=app, pg_temp`, and its ACL holds exactly the owner and
  `app_rw`.

A definer on neither list fails, as today.

**A new assertion on `app_writer`**, beside 8c:

- `rolsuper`, `rolbypassrls`, `rolcanlogin`, `rolcreaterole`,
  `rolcreatedb` and `rolreplication` are false;
- it owns no relation, and the only functions it owns are the three;
- it holds no CREATE on schema `app` and is a member of no role;
- the app login is not a member: `pg_has_role(current_user,
  'app_writer', 'MEMBER')` is false;
- every member of `app_writer` already bypasses row security (`rolsuper`
  or `rolbypassrls`), so membership gives nobody a power they lacked;
- its schema, table, column, sequence and function privileges in `app`
  equal a literal list in the suite, exactly. One more or one fewer
  fails.

**Section 67a** changes its rule, and this is a change to a rule 1 test.
Today: no definer in `app` is executable by the app login. After: the
definers the app login can execute are exactly the write list, and no
definer that returns a trigger is executable by it. The reason for the
first rule was that an executable definer could be attached as a trigger
and run with row security off (TYRE-346). A function that returns `uuid`
or `void` cannot be attached, and these three run with row security on.
67b stays as it is.

**Section 76a** inverts its grant assertions: no INSERT on either table,
no UPDATE on any column of `trip`, still no DELETE, and EXECUTE on the
three. Its raw plants go (section 8).

**Section 76c** holds a loop of 12 raw trip INSERTs, a loop of 8 raw
nominations and a loop of 8 raw trip UPDATEs, each case expecting a
refusal. They split by what refuses them:

- A case a deleted trigger refused (a trailer, a retired unit, an
  inactive driver or nominee, a closed task, a future instant, a row the
  statement cannot see) goes with the trigger, and its back-dated
  control with it.
- A case a rule that stays refuses moves to 005 (section 7). That is 4
  of the trip INSERTs (the CHECK `trip_ends_after_start`, NOT NULL on
  `user_id` and on `vehicle_id`, the composite FK for another fleet's
  driver), 3 of the nominations (`:14197`, `:14200`, `:14203`), and the
  UPDATEs that test `trip_ended_once`, with the end that names another
  ender.
- The UPDATE of `started_at` (`:14068`) tests the column grant, and
  stays in 004 as one of the refusals below.

In 004, one raw INSERT into each table and one raw UPDATE of `trip` are
refused with `42501`.

**Section 72c** pinned the policy's own message for a raw cross-tenant
INSERT. The app login now meets `42501` before the policy, so those two
lines assert that, and the WITH CHECK proof moves to 005.

**Cross-tenant calls through the functions** stay in 004, as
`app_login`: with tenant A bound, `start_trip`, `end_trip` and
`nominate_for_task` naming tenant B's unit, driver, trip, task or added
trailer each refuse as "no such ... in this fleet" and write nothing.
Section 72b holds some of these today. The builder fills any gap, the
added trailer in particular, since that id reaches
`app.create_combination_at`.

### 7. `db/tests/005_privileged.sql`

- **P17 and P18** drop their `DISABLE TRIGGER` and `ENABLE TRIGGER`
  lines and their `tgenabled` assertions. The row dated a second ahead is
  a plain INSERT as `postgres`.
- **A new case: row security binds `app_writer`.** As `postgres`, stage
  a trip and a nomination in each of two tenants. `SET LOCAL ROLE
  app_writer`, bind tenant A, and show that it reads none of tenant B's
  rows in `trip`, `inspection_task_nomination`, `vehicle`, `app_user`
  and `combination`, and that an INSERT into each of the two tables
  naming tenant B fails with the policy's message. This is where the two
  tables' WITH CHECK is now proved.
- **Its control.** In the same transaction, `ALTER ROLE app_writer
  BYPASSRLS`, repeat the read, and require tenant B's rows to come back.
  That shows the probe would catch the owner the ADR rejects. The
  transaction rolls back.
- **A new case: the suite's owner assertion fails when it should.**
  Stage `app_writer` as the owner of a table, and separately with
  BYPASSRLS, and show the assertion of section 6 raises for each. The
  builder chooses how the predicate is shared so that 004 and 005 do not
  hold two copies that can drift.
- **`trip_ended_once`** cases from 76c, staged as `postgres` and probed
  as `app_writer`, the one role besides the owner that can now UPDATE a
  trip.
- **The constraints 76c reached by a raw INSERT**: the CHECK, the two
  NOT NULLs and the composite FKs on both tables, probed as `app_writer`
  with the SQLSTATE and constraint name each case pinned in 004.
- **The EXCLUDE constraints.** Section 34's raw overlapping INSERTs
  cannot run as `app_login`. They move here, with any cross-tenant case
  they carry.

Three rule 1 proofs then live only in 005: the WITH CHECK on each of the
two tables, and section 34's cross-tenant EXCLUDE probe. No `app_login`
route to them is left, so 004 cannot hold them. Root `CLAUDE.md`,
`db/CLAUDE.md:18-21`, 005's header and `Makefile:134` all say 005
"proves nothing about isolation", which is true of what runs as
`postgres`. The new probes run after `SET LOCAL ROLE` to a role row
security binds, as P3 to P19 already do for `app_login`, and each
asserts `current_user` first. Those four lines are reworded to say so
(section 10). This is a change to where a rule 1 proof lives, and the
owner's approval of this spec is the ruling on it.

### 8. Restaging the suite's plants

43 successful plants in 004 name a past instant, which no function can
write, and 6 more write a row dated now. Each takes the first route that
serves:

1. **The real function, as `app_login`, in 004**, where the test needs
   only that a trip or nomination exists now. A function-made row starts
   at the transaction's `now()`, and coverage at `now()` includes it.
2. **005, staged as `postgres` and probed after `SET LOCAL ROLE
   app_login`**, in P17 to P19's shape, where the test needs a past
   instant, an ended trip with a real span, or a row no function would
   write. A section whose plants all need this moves whole, keeping its
   number in its `\echo` line so a reader can find it.

A section is not split across the two files unless its assertions are
independent. The fixture generator is not used: `fixture_body` also
writes `demo_tenant.sql`, which loads on staging. No helper that plants
on the suite's behalf is added to any schema.

Every assertion in the moved sections survives. The builder keeps a
ledger in the PR body: each of 004's 85 raw lines, by section, with
where it went (function call, 005 case, deleted with the trigger it
tested, or inverted to `42501`).

The Go tests need no change: they plant as `postgres`. If one asserted a
refusal that only a deleted trigger raised, it goes with the trigger.

### 9. Proving the path a superuser skips

`make db-provision-test` already builds fresh databases
(`scripts/provision-tenant.test.sh`). It gains a leg with a new role,
since the harness's `provision_owner` is NOLOGIN and the harness
migrates as `postgres`. The new role is shaped like `tyreadmin` (LOGIN,
NOSUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS). It owns a fresh database
and applies the whole migration chain to it through the same `migrate`
invocation. It must bypass row security, as `tyreadmin` does, because it
becomes a member of `app_writer` in the shared cluster and section 6
asserts every member does. The harness drops its database and the role
when the leg ends. The leg then asserts, in that database, the
owner, security flag, pin and ACL of the three functions, `app_writer`'s
attributes, and that a call to `app.start_trip` as `app_login` succeeds.

Because roles are cluster-wide, `app_rw`, `app_login` and `app_writer`
may already exist when the leg runs, created by `postgres`. A role that
creates another gets ADMIN on it, so the harness gives the stand-in the
same thing on a role it did not create: `GRANT ... WITH ADMIN OPTION`,
no SET and no INHERIT, which is what PostgreSQL gives a creator
(https://www.postgresql.org/docs/16/role-attributes.html).

So the leg proves the branch where 000061 finds the role. It cannot
prove the branch staging and production take first, where `tyreadmin`
runs `CREATE ROLE` itself: `app_writer` exists in the cluster before the
leg can run, and it cannot be dropped while database `tyre` holds its
functions. That branch is an accepted gap. It differs from the proved
one by a single statement, `CREATE ROLE`, which `tyreadmin` has already
run on staging for `app_rw` and `app_login` (`000001:568-572`,
`:709-713`), and the membership PostgreSQL gives a creator is the one
the harness grants. A second, throwaway PostgreSQL in the Makefile and
CI would close it, and is not worth its upkeep for one statement.

If an earlier migration cannot run as that role for a reason that is not
this ticket's, the implementer stops and asks. It does not weaken the
leg to a partial chain without the lead's answer.

### 10. Documents

- **`db/CLAUDE.md`, Adding a function.** "Invoker rights, always" becomes
  the rule with its two named exceptions: the governing-tread definer,
  and the write list owned by `app_writer`, citing ADR-0024. It says what
  a new write-list definer needs (owned by `app_writer`, EXECUTE revoked
  from PUBLIC, not a trigger function, on check 8c's list) and that a
  migration replacing one restates SECURITY DEFINER and the pin.
- **`db/CLAUDE.md`, Append-only.** The trip and nomination paragraph says
  the app role holds neither INSERT nor UPDATE and the functions are the
  writers.
- **`db/CLAUDE.md`, the 005 paragraph** gains the new cases.
- **What 005 proves.** Root `CLAUDE.md` (Commands), `db/CLAUDE.md:18-21`,
  005's header and `Makefile:134` are reworded: a block that runs as
  `postgres` proves nothing about isolation, and a probe run after `SET
  LOCAL ROLE` to `app_login` or `app_writer` does. They name the three
  proofs that live only there and why. `make db-test` stays the suite,
  and `make test` and CI keep running both.
- **ADR-0013, Accepted gaps.** The U152 and U153 entry becomes a closed
  entry in the form of the list's first one: closed by 000061 (TYRE-472,
  U202), with one sentence on how.
- **ADR-0021.** A dated line under "Revisit when" records that the
  second-definer clause fired and ADR-0024 answered it.
- **ADR-0024** is Accepted (U217), and so is its index line in
  `docs/architecture.md`. The lead made both edits.
- **`api/internal/httpapi/refusal_codes.json`.** TY018 loses
  `app.nomination_is_well_formed` and TY028 loses
  `app.trip_is_well_formed` from `raisedBy`.
- **`docs/runbooks/environment-release.md`, Each release, step 4** gains
  the 000061 check (section 11).
- Comments in 004, 005 and the per-trip design spec that name the
  deleted triggers are corrected where the diff touches them or they
  describe changed code.

### 11. Staging and production

The owner applies 000061 with the release runbook's usual migrate step,
as `tyreadmin`. No step comes before it: the migration creates the role.

Step 4 of Each release gains read-only queries and their expected
answers: `app_writer`'s six attributes all false; the three functions
owned by `app_writer`, `prosecdef` true, ACL the owner and `app_rw`;
`has_table_privilege('app_login', 'app.trip', 'INSERT')` false, and the
same for the nomination table.

If production's `tyreadmin` lacked CREATEROLE the migration would fail
at its first statement and change nothing. Azure grants CREATEROLE to
every server administrator
(https://learn.microsoft.com/en-us/azure/postgresql/security/security-manage-database-users),
and staging reads it true, so this is not expected. Step 3 of the
runbook already says what to do with a failed migrate.

## Definition of done

1. `make db-reset && make db-test` passes as `app_login`, with check 4,
   check 8c, the `app_writer` assertion, 67a, 72c, 76a and 76c as
   sections 6 describes.
2. `make db-test-privileged` passes with P17 and P18 rewritten and the
   new cases of section 7, each control shown to fail when its staging
   is removed.
3. `make db-provision-test` passes with the stand-in leg of section 9,
   which proves the branch where the role is found.
4. As `app_login`: a raw INSERT into each table and a raw UPDATE of
   `trip` fail with `42501`; each of the three functions succeeds on its
   ordinary input and files the audit entries it filed before.
5. The down file returns a database to 000060's grants, triggers and
   function attributes, proved by catalogue as `docs/lessons.md`
   (2026-10-01, Down files restore state) requires: the baseline read at
   version 60 before the up, then `prosecdef`, `proowner`, `proacl`,
   `proconfig`, the table and column grants and the two triggers read
   back after `down 1` and again after `up 1`. A green suite after the
   round trip is not the proof.
6. The PR body carries the ledger of 004's 85 raw lines.
7. The `rls-auditor` and the `append-only-auditor` have run on the
   migration, and nothing they verified against rules 1 to 3 is open.
8. The documents of section 10 are true of the code.
9. `make check` passes.
10. After the merge, at the first release that carries 000061, the
    runbook's step 4 queries return the expected answers on staging.
    This item closes on the owner's report.

## Lead's calls

1. **The owner is a dedicated role, not the migrating role.** U202, and
   ADR-0024 Option C: PostgreSQL skips row security only for a
   superuser, BYPASSRLS or an unforced owner
   (https://www.postgresql.org/docs/16/ddl-rowsecurity.html), and
   `000044:44` finds a rig by id alone, safe today only because
   `000060:1607-1608` reads that id with the tenant named.
2. **`ALTER FUNCTION`, not `CREATE OR REPLACE`.** The bodies do not
   change, and a restated body is one more copy to drift. Ownership and
   ACL rules: https://www.postgresql.org/docs/16/sql-alterfunction.html.
3. **Assert an existing role's attributes, do not alter them.** A role
   that is not a superuser cannot name SUPERUSER in `ALTER ROLE`
   (https://www.postgresql.org/docs/16/sql-alterrole.html), and
   `000001:709-713` is the house shape for a guarded create.
4. **CREATE on the schema is granted for the hand-over and revoked in
   the same transaction.**
   https://www.postgresql.org/docs/16/sql-alterfunction.html requires
   it of the new owner at that moment only.
5. **The migrating role stays a member of `app_writer`, with SET and
   INHERIT.** Replacing a function needs membership in its owner
   (https://www.postgresql.org/docs/16/sql-createfunction.html), and a
   CREATEROLE creator may grant itself both
   (https://www.postgresql.org/docs/16/role-attributes.html).
6. **A lock-only table gets UPDATE on `updated_at` alone.** A row lock
   needs UPDATE on one column
   (https://www.postgresql.org/docs/16/sql-select.html), and
   `app.stamp_updated` overwrites that column
   (`000017_audit_columns_dr013.up.sql:54`).
7. **The down file leaves the role.**
   https://www.postgresql.org/docs/16/sql-droprole.html, and
   `000001_init.down.sql:2`.
8. **Plants restage through the real function or 005, never the fixture
   generator or a suite-only helper.** `db/CLAUDE.md:11-21` gives 005
   the job of staging what `app_login` cannot, and
   `db/seeds/gen_seed_demo.py:39` reuses `fixture_body` for staging's
   demonstration tenant.
9. **67a narrows to trigger-returning definers plus an exact write
   list.** PostgreSQL checks EXECUTE on a trigger function when the
   trigger is created (`000051_definer_execute_revoked.up.sql:5-11`), and
   `CREATE TRIGGER` takes only a function declared as returning type
   `trigger` (https://www.postgresql.org/docs/16/sql-createtrigger.html).
10. **The non-superuser path is proved in `make db-provision-test`**,
    which already builds fresh databases and runs `migrate` on them
    (`scripts/provision-tenant.test.sh:104-110`). The leg proves the
    branch where the role exists, and the create branch is an accepted
    gap: a creator's membership is "just as if the bootstrap superuser
    had executed `GRANT created_user TO creating_user WITH ADMIN TRUE,
    SET FALSE, INHERIT FALSE`"
    (https://www.postgresql.org/docs/16/role-attributes.html), which is
    what the harness grants.
11. **ADR-0013's entry is closed in place**, as its first entry was
    (`docs/adr/0013-write-surface-contract.md:419-424`). The ticket said
    delete.
12. **No pre-migrate step on Azure.** Staging's `tyreadmin` reads
    `rolcreaterole` true (TYRE-305 comment 13834), and Azure grants it
    to the administrator.
13. **No product question was open.** The change has no effect a user
    sees, and U202 had settled the direction.

## Left to the builder

- The final grant list for `app_writer`, derived by running the suite
  and the Go tests, each row with the statement that needs it.
- The migration's name after `000061_`, and the order of statements
  inside the constraints of section 4.
- Which of 004's plants take route 1 and which route 2, by the rule in
  section 8, and the 005 case numbers from P20 on.
- How 004 and 005 share the `app_writer` assertion without two copies.
- The exact queries and wording of the runbook's step 4 addition.
- How the stand-in leg supplies its connection URL to `migrate`, and
  what it names its role and database.
- Whether `app.current_tenant_id`, `app.current_actor_id` and
  `app.current_source_ip` need an explicit EXECUTE for `app_writer`.
- Confirming that the compose `migrate` service sends a file as one
  transaction (no migration here carries BEGIN or COMMIT, and
  golang-migrate's postgres driver documents `x-multi-statement` as the
  mode that would split it).

## Rejected

- **Granting `app_writer` to `app_rw` with SET.** It would hand the app
  role the raw writes back through `SET ROLE`.
- **Making `app_writer` the owner of the two tables.** An owner skips
  row security unless forced, can grant, and can drop. The role owns
  three functions and nothing else.
- **A separate role per function.** Three access lists to pin for no
  isolation gain, since `start_trip` already ends trips.
- **Keeping the triggers as a second check behind the functions.** That
  is the cost this ticket exists to stop paying.
- **Moving all of section 76 to 005.** Most of it tests the functions
  and runs unchanged as `app_login`. Only what needs a past row moves.
- **Dropping the membership after the hand-over.** The next migration
  that replaces one of the three would fail on Azure and pass locally.
