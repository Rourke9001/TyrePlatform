# Design: the audit trigger reaches the remaining write paths (TYRE-98)

- **Date:** 2026-10-14
- **Ticket:** TYRE-98, under epic TYRE-55. It carries `app.vehicle_tag_map`,
  added on 24 Sep 2026 (comment 13165), and the three `app.app_user` writes
  named on 30 Sep 2026 (comment 13449). TYRE-426 was raised from this spec.
- **Decisions it rests on:** ADR-0014 (mutations are audited by one generic
  trigger), ADR-0013 decision 7 (the tag map's DELETE), ADR-0016 (the session
  binding), 000055 (TYRE-201: the trigger writes `source_ip` and
  `session_id`), and the owner's answers in the TYRE-98 spec session, 14 Oct
  2026, recorded below under "Decisions".
- **Requirements:** FR-AUD-001 and FR-AUD-002 (both in Appendix H.1),
  FR-TEN-002, FR-AUT-003a, DR-013, DR-014, NFR-PRV-004 and NFR-PRV-007
  (neither in H.1), SRS section 5.3, and FR-AUD-008 (not in H.1).

## Why this exists

`app.audit_row_change()` is attached to six tables: `vehicle`, `combination`,
`combination_member`, `inspection_task`, `inspection` and
`composition_observation`. Every other table the app writes is unaudited,
including the ones that price a tyre (`tyre`, `fitment`, `retread_job`) and
the one that decides who can sign in as whom (`app_user`). FR-AUD-001 asks
for an entry on every creation, modification and deletion, and U88's
ordering rule puts this before pilot data exists: an audit trail cannot be
backfilled for writes that already happened.

Three facts shape the design:

1. `app.vehicle_tag_map` has no `id` column, and the trigger resolves
   `NEW.id` by name, so attaching it as written fails the first insert
   (000035's header).
2. The unit edit removes tags with a DELETE (ADR-0013 decision 7), and the
   trigger has no DELETE arm. ADR-0014 names "a write surface is given
   DELETE" as its revisit condition.
3. `app.audit_log.tenant_id` references `app.tenant` `ON DELETE CASCADE`. A
   DELETE arm that fires inside a tenant's own deletion cascade would insert
   a row whose tenant is gone, and the foreign key would refuse the whole
   deletion. The Go suites delete their planted tenants this way
   (`api/internal/httpapi/httpapi_test.go`, `api/internal/store/store_test.go`),
   and `TestPatchUnitReplacesTags` tags a unit first.

## Decisions

Owner answers, 14 Oct 2026, in the TYRE-98 spec session:

| # | Question | Answer |
|---|---|---|
| Q1 | Which tables are attached | The ticket's seven, `vehicle_tag_map`, and `vehicle_tag`. The rest are out with a stated reason (section 4) |
| Q2 | How the tag map is audited | At the unit's grain: the trigger takes an optional argument naming its entity column, the tag map passes `vehicle_id`, and `replaceUnitTags` writes only the difference |
| Q3 | `app_user`'s two ADR-0014 conditions | Audit every row. A `PLATFORM_ADMIN` row's audit entry carries a NULL tenant; personal information in `before`/`after` is re-deferred with its reason |
| Q4 | Do the tag map and snapshot deletes conflict with DR-014 | No. A tag link is a unit's current label, and a snapshot is a derived cache over immutable history. The reading is recorded, with no SRS change |
| Approach | How the function grows | One generic function: an optional entity-column argument and a DELETE arm |
| Section 3 | The 5.3 retention conflict | Ticketed as TYRE-426 |

The three design sections were approved as presented.

The ticket's last definition-of-done item asks for ADR-0014's
`raised as TYRE-NN` placeholder to be replaced. That was done at close-out
(the ADR already reads TYRE-98), so the item becomes recording this widening
in the ADR. Comment 13735 records that the FR-AUD-002 columns arrived with
000055 and are not part of this ticket.

## Design

### 1. The function and the triggers (migration 000056)

`CREATE OR REPLACE FUNCTION app.audit_row_change()`, restating
`SECURITY INVOKER` and `SET search_path = app, pg_temp`, because
`CREATE OR REPLACE` resets every property it does not name (db/CLAUDE.md,
Adding a function). Its body:

- **The row.** `NEW`, or `OLD` on a DELETE. `to_jsonb(OLD)` and
  `to_jsonb(NEW)` are each computed once; the no-op check and the INSERT
  reuse them. Each is NULL where its record is not populated.
- **The no-op UPDATE skip** is unchanged: an UPDATE whose rows agree once
  `updated_at` and `updated_by` are set aside writes nothing (ADR-0014).
- **The entity column.** `TG_ARGV[0]` when the trigger passes one, else
  `id`. `entity_id` is that key read from the row's jsonb and cast to `uuid`.
  A row with no such key raises, naming the table and the column, so a
  trigger attached with the wrong argument fails its first write as the
  `NEW.id` reference does today. It never writes a NULL `entity_id`.
- **The DELETE arm.** `tenant_id` and the entity come from `OLD`;
  `before` is `to_jsonb(OLD)` and `after` is NULL.
- **Tenant closure.** On a DELETE, the INSERT runs in an exception block
  that catches a `foreign_key_violation` on `audit_log_tenant_id_fkey` and
  writes nothing. Tenant closure is the one physical deletion DR-014
  sanctions, and the cascade that removes the tenant's rows removes its
  audit rows too, so a row written here would be refused by the foreign key
  and fail the closure. Any other error refuses the DELETE: an `app_rw`
  session that cannot see its own tenant fails `audit_log`'s policy and is
  refused, never skipped. INSERT and UPDATE file outside the block, which
  costs a subtransaction per row.
- **`source_ip` and `session_id`** are read as 000055 reads them.
- `tenant_id` still comes from the row, never from the session (ADR-0014).

Triggers, each named `<table>_audited`, `AFTER ... FOR EACH ROW EXECUTE
FUNCTION app.audit_row_change()`:

| Table | Events | Argument | Live writers today |
|---|---|---|---|
| `tyre` | INSERT, UPDATE | | `receive_tyres`, `set_tyre_cost`, `dispose_tyre`, `fit_tyre`, `remove_tyre`, `rotate_tyres`, `dispatch_tyre`, `return_tyre_to_stock`, `log_retread_return` |
| `fitment` | INSERT, UPDATE | | `fit_tyre`; the closure in `remove_tyre` and `rotate_tyres` |
| `retread_job` | INSERT, UPDATE | | `dispatch_tyre`, `log_retread_return` |
| `app_user` | INSERT, UPDATE | | `createUser` and its rehire branch (`admin.go`); the provisioning runbook as the owning role |
| `vehicle_driver` | INSERT, UPDATE | | `assignDriver` (`admin.go`) |
| `threshold_policy` | INSERT, UPDATE | | seeds, migrations and the owning role; UPDATE is revoked and refused (000054), attached for uniformity |
| `configuration` | INSERT, UPDATE | | seeds, migrations and the owning role; `app_rw` holds both grants and no route uses them |
| `vehicle_tag` | INSERT, UPDATE | | the unit edit's name upsert (`units.go`) |
| `vehicle_tag_map` | INSERT, UPDATE, DELETE | `vehicle_id` | the unit edit (`units.go`) |

DELETE is attached only to `vehicle_tag_map`, the one audited table
`app_rw` may delete from. The six existing triggers take the new body
without being touched.

Per table, what that means:

- **`app_user`.** The trigger runs as the writer, and `audit_log`'s
  `tenant_isolation` policy is the same expression as `app_user`'s, so an
  audit row for a `PLATFORM_ADMIN` row (NULL tenant) lands exactly when the
  user row itself does, under the owning role. FR-TEN-002 exempts platform
  administrator accounts from carrying a tenant, and no SRS row names a
  tenant reader for a platform-level entry, so the row is readable only by
  the owning role. The runbook binds a tenant and no actor, so the subject
  link, a relink and the interim deactivation (comment 13449) are audited
  with a NULL `actor_id`.
- **`configuration` and `threshold_policy`.** Today only seeds, migrations
  and the owning role write them, so their rows carry a NULL `actor_id`.
  TYRE-425 may revoke `configuration`'s UPDATE; the trigger is unaffected.
- **Seeds.** `make db-reset` now writes an INSERT row, with a NULL actor,
  for every seeded row of the nine tables.

The down migration drops the nine triggers and restores 000055's body of
`app.audit_row_change()`, including its `SECURITY INVOKER` and pinned
`search_path`. It is proven by catalogue at the down state, not by a suite
run (`docs/lessons.md`, the down-file rule): `migrate down 1`, then read back
the function's body, `prosecdef` and `proconfig`, and confirm the nine
triggers are gone and the six earlier ones remain.

### 2. The unit edit writes the difference (`api/internal/httpapi/units.go`)

`replaceUnitTags` keeps its contract: the unit ends with exactly the
requested tag set, in the caller's transaction, after `patchUnit`'s UPDATE
has locked the vehicle row (`docs/architecture.md`).

- It resolves each requested name to a tag id with today's upsert, first.
- It deletes the unit's map rows whose tag id is not in the resolved set.
- It inserts the resolved ids with `ON CONFLICT DO NOTHING`.

The end state is replace-all's. The audit trail differs: one DELETE row per
tag removed and one INSERT row per tag added, each with
`entity_type = 'vehicle_tag_map'` and `entity_id` the unit. An unchanged
tag writes nothing.

Reusing a name writes nothing to `vehicle_tag`'s audit either: the upsert's
`ON CONFLICT DO UPDATE SET name = EXCLUDED.name` changes no column the
no-op skip compares. Only a new name writes a `vehicle_tag` INSERT row.

`patchUnit`'s doc comment and `docs/architecture.md` both say a tags-only
edit writes no audit entry and that tag map rows are not audited. Both
become: a tags-only edit writes no vehicle row, and one tag-map row per tag
it adds or removes.

### 3. Tests

Suite section 72 (`db/tests/004_tests.sql`, as `app_login`):

- **72a, catalogue.** The nine triggers exist, `AFTER ... FOR EACH ROW`,
  calling `app.audit_row_change`, with the events in the table above and
  DELETE on `vehicle_tag_map` alone; `vehicle_tag_map_audited` passes
  `vehicle_id` and no other trigger passes an argument. The function is
  still `SECURITY INVOKER` with its `search_path` pinned.
- **72b, one real write per table.** Through its live writer where there is
  one (the SQL functions; the statements the handlers issue for `app_user`,
  `vehicle_driver` and the tags), each table lands an audit row with the
  right `action`, `entity_type`, `entity_id`, `before` and `after`. The
  UPDATE paths are covered too: `set_tyre_cost` on `tyre`, the closure on
  `fitment`, `log_retread_return` on `retread_job`, the rehire on
  `app_user`, and an UPDATE of a `configuration` row.
- **72c, cross-tenant forge.** For each table, an INSERT naming another
  tenant's `tenant_id` is refused by that table's own policy (42501 on the
  table, not on `audit_log`), and no audit row lands in either tenant.
- **72d, the tag map.** A DELETE writes one row with `action = 'DELETE'`,
  `entity_id` the unit, `before` the map row and `after` NULL. The skip on a
  missing tenant is not reachable as `app_login` and is proven in 005.
- **72e, the entity argument.** A trigger naming a column the row lacks
  raises rather than writing a NULL `entity_id`. The probe stages its own
  throwaway table and trigger and rolls them back; the plan chooses where it
  can be staged as `app_login`, or moves it to 005.

Privileged probes (`db/tests/005_privileged.sql`, staged as `postgres`):

- Deleting a tenant whose unit carries tags succeeds and leaves no
  `audit_log` row for that tenant.
- An owning-role INSERT and UPDATE of a `PLATFORM_ADMIN` `app_user` row
  each write an audit row with a NULL `tenant_id` and a NULL `actor_id`.

Existing assertions that count `audit_log` rows are re-read against seeds
that now write audit rows. None is loosened. Where one counted every row
of the log rather than the entity it is about, it is scoped to that entity,
which asserts the same claim, and the PR names each one.

Go: `TestPatchUnitReplacesTags` extends to the audit trail. Narrowing
`{LONG HAUL, REEFER}` to `{REEFER}` writes exactly one DELETE row under the
unit and no INSERT; resending an unchanged set writes nothing; a second unit
taking an existing name writes one map INSERT and no `vehicle_tag` row. Its
existing `t.Cleanup` tenant delete proves the closure skip from Go.

`make db-volume` loads slower, because every volume tyre and fitment now
writes an audit row. The dashboard read path does not read `audit_log`, so
`make db-explain` is not re-measured.

### 4. What stays unaudited, and why

Recorded in ADR-0014's Consequences:

- **Insert-only record tables** (`tyre_event`, `reading`,
  `reading_measurement`, `inspection_warning`, `inspection_absent_spare`,
  `vehicle_odometer_reading`, `casing_valuation`, `tenant_consent`). Each is
  written once, never updated or deleted by the app role (DR-011, DR-018),
  and carries DR-013's `created_at` and `created_by`, so each row is its own
  record of its creation. `threshold_policy` is insert-only too since 000054,
  and is audited because the ticket names it.
- **`valuation_snapshot`.** A derived cache of `tyre_valuation_asof()`
  (000006, 000018): one row per tyre per date, rebuilt from immutable
  readings and events, so any date is recomputable.
- **`display_code_counter`.** A per-tenant counter with no `id`; its effect
  is the display code on the audited `tyre` row.
- **`user_depot`.** No write path.
- **`inspection_schedule`.** No write path yet; TYRE-133 attaches the
  trigger with the path it adds.
- **Reference and catalogue tables** (`depot`, `operating_group`,
  `tyre_size`, `tyre_brand`, `tyre_pattern`, `tyre_price_list`,
  `casing_estimate_by_size`, `axle_configuration`, `position`,
  `target_pressure`, `exception_rule`, `exception`, `notification`,
  `photo`). No route writes them today. A ticket that adds the first write
  path attaches the trigger, as U4 and U12 already require.

### 5. ADR-0014 and the other documents

ADR-0014 is amended in place:

- **Decision.** The function gains the entity-column argument and the DELETE
  arm with its tenant-closure skip, and the list of attached tables gains
  this ticket's nine.
- **Consequences.** Section 4's list and reasons. A NULL `actor_id` is
  reworded from "loaded, not acted" to "no app actor bound: a seed, a
  migration, or an owner action through a runbook". `PLATFORM_ADMIN` rows
  are audited with a NULL tenant (FR-TEN-002, FR-AUT-003a). Personal
  information in `app_user`'s `before`/`after` is re-deferred: NFR-PRV-004
  is outside H.1, and section 5.3 keeps the audit log apart from application
  logs, so NFR-PRV-007 does not reach it; when pseudonymisation is built, it
  must reach `audit_log.before` and `after` too. The DR-014 reading: a tag
  link and a snapshot are not business records.
- **Revisit when.** The DELETE line becomes: a table given a DELETE path
  adds DELETE to its trigger's events. The 84-month question is TYRE-426.

Also:

- `docs/architecture.md`, the `patchUnit` paragraph (section 2).
- `docs/runbooks/provision-a-user.md`: its writes are audited with no actor.
- 000035's header says the tag map cannot carry the trigger. It is an
  applied migration and is not edited; 000056's header supersedes it
  (TYRE-191 tracks frozen comments of this kind).

## Set aside

For the PR body, not ticketed (U130):

- Auditing the tables in section 4.
- Pseudonymising personal information inside audit rows.
- A NULL actor does not tell a seed from an owner action; FR-AUD-002 names
  no field that would.

## Out of scope

- An audit reader or export (FR-AUD-007, outside H.1).
- Tenant closure itself, and which retention rule governs its audit
  (TYRE-426).
