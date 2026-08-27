# Database Integrity Rules (B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four database integrity gaps that are cheap to fix now and expensive once the pilot holds real rows — a unit's axle configuration changing under its own history, a fitment odometer missing on a unit that has one, duplicate platform-admin emails, and overlapping duplicate driver assignments.

**Architecture:** Three paired migrations and three new sections in the verification suite. Two rules span tables, so they are triggers rather than `CHECK` constraints; two are indexes. Nothing in Go, nothing in the web app. Enforcement lives in the database for the DR-004/DR-005 reason: the constraints that matter are the ones the application cannot route around.

**Tech Stack:** PostgreSQL 16 (plpgsql, RLS, `golang-migrate` via the `migrate` compose service), run through the Makefile in docker.

**Spec:** No design document — the four Jira tickets are the specification and are quoted verbatim below. TYRE-82 implements decision D11(ii) of 27 Aug 2026 (*Decisions of Record — D8–D11*, Confluence). Sequencing rationale: `docs/implementation-order.md`, batch B1.

**Tickets:** TYRE-82 (Task 2) · TYRE-85 (Task 3) · TYRE-30 residuals (Task 4), sequenced after the schema check in Task 1.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **Tenant isolation lives in the database.** RLS, never application code alone. Every new view needs `security_invoker = true`. The app must not connect as a superuser. Run the `rls-auditor` agent over every migration in this plan before its commit — project rule, proactive on any migration, grant or policy change.
- **All money is `DECIMAL`/`numeric`.** No monetary field appears anywhere in this plan.
- **Readings and fitment events are immutable.** `UPDATE`/`DELETE` are revoked from `app_rw` on `app.reading`, `app.reading_measurement`, `app.tyre_event` and `app.audit_log`. Note the exact scope: `app.fitment` itself is *not* `UPDATE`-revoked — removal is recorded by updating the row, and `000017` gave it a `fitment_stamps_updated` trigger. Task 3 depends on that being true.
- **Every threshold, band and rate is tenant configuration** (rule 5). No numeric literal in this plan is a threshold; `unit_kind` values are an enum, not a policy.
- **Timestamps stored UTC**, displayed in tenant timezone.
- **`SECURITY INVOKER` only.** `db/tests/004_tests.sql` asserts the `SECURITY DEFINER` allowlist is exactly `ARRAY['refresh_governing_tread']` and fails the build on any other. Every function in this plan is invoker — do not add `SECURITY DEFINER`.
- **Pin `search_path`** on every new function: `SET search_path = app, pg_temp`.
- **Never edit an applied migration.** Add a new one. Every `up` gets a paired `down` that reverses cleanly — `make db-reset` then `migrate down 3` then `up` must be green.
- **Test cleanup is `BEGIN`/`ROLLBACK`, never `DELETE`.** DR-014a revoked `DELETE` from `app_rw` on almost every table, so a cleanup `DELETE` cannot work anyway.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. Cite the requirement ID for any non-obvious rule. `db/migrations/000001_init.up.sql` is the reference for house style.
- **Test data goes in the Sandbox Fleet tenant**, never in BAC — BAC's rows are the Appendix E / Appendix J acceptance fixture and a stray row moves a pinned number. Every test here uses `BEGIN`/`ROLLBACK` and so touches nothing, but if you need a persistent row, it goes in Sandbox (TYRE-80).
- **Run `make check` before every commit.** Docker must be running.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| Source | Text |
| --- | --- |
| TYRE-82 | "A trigger on `app.vehicle` rejects any change to `configuration_id` when the vehicle has any fitment (open or closed) or any inspection." |
| TYRE-82 | "Correcting a wrong configuration afterwards is a documented migration or retire-and-re-add, never an edit. The error message should say so." |
| TYRE-82 | Definition of done: "the trigger exists with a paired down migration; db test proves the rejection with history present and the permitted change with none; `make check` green." |
| TYRE-85 | "fitted (and removed, at removal) odometer `NOT NULL` where the vehicle's `unit_kind` is HORSE, RIGID or LIGHT. Caveat: `unit_kind` is nullable (CHG-027 backfill left underivable rows NULL) — a NULL `unit_kind` must not block fitment, so the rule only bites where the kind is known to carry an odometer." |
| TYRE-85 | Definition of done: "rule enforced at the chosen layer; tests prove a horse fitment without an odometer is rejected, a trailer fitment without one is accepted, and a NULL-kind unit is not blocked; `make check` green." |
| FR-FIT-002 (SRS v1.4) | odometer at fitment and removal "where the unit has one" |
| FR-VEH-016 | "version axle configurations, so that amending a configuration does not alter the position meaning of historical inspections" |
| FR-INS-061 | `app.reading.vehicle_id` is **the owning unit** — not the motive unit |
| TYRE-30 | "`UNIQUE (tenant_id, email)` treats NULL `tenant_id` as distinct, so two platform admins can share an email… a partial unique index `WHERE tenant_id IS NULL` fixes it." |
| TYRE-30 | "`vehicle_driver` has no exclusion constraint, so an exact-duplicate current assignment multiplies through `v_current_assignment` / `v_driver_vehicle`… An exclusion constraint needs the `btree_gist` extension and has no SRS requirement ID to cite — decide whether to add it." |

## Decisions this plan makes, and why

Four judgment calls the tickets left open. Each is settled here so the implementer does not re-litigate it, and each belongs in the migration's own comment.

**1. TYRE-82's history test must include readings, not just fitments and inspections.**
The ticket says "any fitment… or any inspection". That is insufficient as written. `app.inspection.vehicle_id` is *the motive unit* — a trailer inspected as part of a rig has no inspection row of its own. What it has is `app.reading` rows carrying its own `vehicle_id`, which FR-INS-061 defines as the owning unit. A trailer whose configuration changed under twelve recorded readings would pass the ticket's literal test and still violate INV-4. The predicate is fitment **or** inspection **or** reading.

**2. Both cross-table rules are triggers, not `CHECK` constraints.**
A `CHECK` cannot reference another table. TYRE-82 reads `app.fitment` / `app.inspection` / `app.reading`; TYRE-85 reads `app.vehicle.unit_kind`. Neither can be expressed as a column constraint, and a generated column would not help.

**3. The `vehicle_driver` exclusion constraint keys on (vehicle, user), not on vehicle alone.**
Constraining a vehicle to one driver at a time would silently answer OI-32 — fixed per horse versus pooled per trip — which is an open sponsor question (TYRE-44) and not ours to close in a migration. What TYRE-30 actually reported is *exact-duplicate* assignments multiplying rows through `v_current_assignment` and `v_driver_vehicle`. Excluding overlapping ranges for the same `(vehicle_id, user_id)` pair fixes exactly that and prejudges nothing.

**4. Two new SQLSTATEs in the private class: `TY008` and `TY009`.**
`TY001`–`TY007` and `TY010` are taken. Both new refusals are permanent client-side conditions, so when a write path eventually reaches them they will want `422` entries in `submitStatus`. **They get no entry today** — `app.vehicle` and `app.fitment` have no HTTP write path yet, and adding an unreachable map entry is dead code the reviewer cannot verify. Task 5 records this in the migration comment so whoever builds the vehicle or fitment endpoint finds it; TYRE-82's own ticket already asks for that citation.

## File Structure

| Path | Responsibility |
| --- | --- |
| `db/migrations/000024_configuration_immutable_with_history.up.sql` (new) | `app.reject_configuration_change_with_history()` and its `BEFORE UPDATE` trigger on `app.vehicle` (TYRE-82) |
| `db/migrations/000024_...down.sql` (new) | drops trigger then function |
| `db/migrations/000025_fitment_odometer_by_unit_kind.up.sql` (new) | `app.require_odometer_where_unit_has_one()` and its `BEFORE INSERT OR UPDATE` trigger on `app.fitment` (TYRE-85) |
| `db/migrations/000025_...down.sql` (new) | drops trigger then function |
| `db/migrations/000026_tenant_null_email_and_assignment_overlap.up.sql` (new) | partial unique index on `app.app_user`; `btree_gist` and the exclusion constraint on `app.vehicle_driver` (TYRE-30 residuals) |
| `db/migrations/000026_...down.sql` (new) | drops constraint and index; leaves `btree_gist` installed |
| `db/tests/004_tests.sql` (modify, append) | new sections 32, 33, 34 — one per migration |
| `docs/implementation-order.md` (modify) | mark B1 delivered when the branch closes |

Sections run to 31 today. Append 32–34 in order; do not renumber anything.

---

### Task 1: Confirm the live schema before writing a line of SQL

`docs/lessons.md`, 2026-08-26: *"The column definition in 000001 is not the schema."* Twenty-five migrations have run since. Every shape this plan relies on is stated below as an expectation — verify each against the running database, and if one differs, stop and report rather than adapting the plan silently.

**Files:**
- Modify: none. This task produces a verification, not a change.

**Interfaces:**
- Consumes: nothing.
- Produces: confirmation that Tasks 2–4 rest on the real schema.

- [ ] **Step 1: Bring the database up on the current migrations**

```bash
make db-up
make db-reset
```

- [ ] **Step 2: Check every shape this plan depends on**

```bash
docker compose exec -T db psql -U postgres -d tyre <<'SQL'
\echo '-- vehicle.configuration_id and unit_kind'
SELECT column_name, data_type, is_nullable, udt_name
  FROM information_schema.columns
 WHERE table_schema='app' AND table_name='vehicle'
   AND column_name IN ('configuration_id','unit_kind') ORDER BY column_name;

\echo '-- unit_kind enum labels'
SELECT enumlabel FROM pg_enum e
  JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='unit_kind' ORDER BY enumsortorder;

\echo '-- fitment odometer nullability'
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_schema='app' AND table_name='fitment'
   AND column_name IN ('fitted_odometer','removed_odometer','removed_at') ORDER BY column_name;

\echo '-- app_rw may still UPDATE fitment (Task 3 depends on this)'
SELECT privilege_type FROM information_schema.role_table_grants
 WHERE grantee='app_rw' AND table_schema='app' AND table_name='fitment' ORDER BY privilege_type;

\echo '-- reading.vehicle_id exists and is the owning unit (FR-INS-061)'
SELECT column_name FROM information_schema.columns
 WHERE table_schema='app' AND table_name='reading' AND column_name='vehicle_id';

\echo '-- vehicle_driver shape'
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema='app' AND table_name='vehicle_driver' ORDER BY ordinal_position;

\echo '-- app_user email uniqueness as it stands'
SELECT indexname, indexdef FROM pg_indexes
 WHERE schemaname='app' AND tablename='app_user';

\echo '-- SQLSTATEs TY008/TY009 must be unused'
SQL
grep -rn "TY008\|TY009" db/ api/ web/ || echo "TY008/TY009 unused — good"
```

Expected, and each is a stop condition if it differs:
- `vehicle.configuration_id` is `uuid`, `NOT NULL`; `vehicle.unit_kind` is `app.unit_kind`, **nullable**.
- `unit_kind` labels are exactly `HORSE`, `TRAILER`, `RIGID`, `LIGHT`.
- `fitment.fitted_odometer` and `fitment.removed_odometer` are both **nullable** (migration `000011` relaxed them — that relaxation is what TYRE-85 exists to re-bound).
- `app_rw` holds `UPDATE` on `app.fitment`.
- `app.reading.vehicle_id` exists.
- `app.vehicle_driver` has `vehicle_id`, `user_id`, `from_date date`, `to_date date` nullable.
- `app.app_user` has a `UNIQUE (tenant_id, email)` index and **no** partial index on `tenant_id IS NULL`.
- `TY008` and `TY009` appear nowhere.

- [ ] **Step 3: Record the result**

No commit. Report the eight lines back before starting Task 2. If any expectation failed, stop here.

---

### Task 2: A unit's axle configuration is immutable once it has history (TYRE-82)

**Files:**
- Create: `db/migrations/000024_configuration_immutable_with_history.up.sql`
- Create: `db/migrations/000024_configuration_immutable_with_history.down.sql`
- Test: `db/tests/004_tests.sql` — append section 32

**Interfaces:**
- Consumes: the schema confirmed in Task 1.
- Produces: `app.reject_configuration_change_with_history()` returning `trigger`; trigger `vehicle_configuration_is_immutable` on `app.vehicle`; SQLSTATE `TY008` with message `axle configuration cannot change once the unit has history`.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql`:

```sql
\echo '== 32. A unit axle configuration is immutable once it has history (D11(ii), FR-VEH-016, INV-4)'
DO $$
DECLARE ok boolean := false; v uuid; other_cfg uuid; t uuid; cfg uuid; n int;
BEGIN
  -- A unit with recorded history: its configuration is now load-bearing for
  -- every position row its fitments and readings point at.
  SELECT r.vehicle_id INTO v FROM app.reading r LIMIT 1;
  IF v IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no reading to hang this test on'; END IF;

  SELECT ve.tenant_id, ve.configuration_id INTO t, cfg FROM app.vehicle ve WHERE ve.id = v;
  SELECT ac.id INTO other_cfg
    FROM app.axle_configuration ac
   WHERE ac.tenant_id = t AND ac.id <> cfg LIMIT 1;
  IF other_cfg IS NULL THEN RAISE EXCEPTION 'FAIL: tenant has only one configuration to move between'; END IF;

  BEGIN
    UPDATE app.vehicle SET configuration_id = other_cfg WHERE id = v;
  EXCEPTION WHEN SQLSTATE 'TY008' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a unit with history accepted a configuration change'; END IF;

  -- The same edit on a unit with no history is permitted: this is a history
  -- rule, not a freeze, and a data-capture mistake must stay correctable
  -- until something points at the positions.
  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t, 'TY82-CLEAN', cfg, 'HORSE')
    RETURNING id INTO v;
  UPDATE app.vehicle SET configuration_id = other_cfg WHERE id = v;
  SELECT count(*) INTO n FROM app.vehicle WHERE id = v AND configuration_id = other_cfg;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a unit with no history was refused a configuration change'; END IF;

  -- An UPDATE that leaves configuration_id alone must pass whatever the
  -- history, or every future edit to a vehicle row is blocked by this rule.
  SELECT r.vehicle_id INTO v FROM app.reading r LIMIT 1;
  UPDATE app.vehicle SET registration = 'TY82-TOUCHED' WHERE id = v;

  RAISE NOTICE 'PASS  configuration is immutable with history, editable without, and other columns are untouched';
END $$;
ROLLBACK;
BEGIN;
```

Match the surrounding transaction discipline: check how the sections immediately above section 32 open and close, and follow that exactly. The `ROLLBACK; BEGIN;` pair above assumes the file's established pattern of a wrapping transaction per section — confirm before copying.

- [ ] **Step 2: Run the suite to verify it fails**

```bash
make db-test
```

Expected: `FAIL: a unit with history accepted a configuration change`.

- [ ] **Step 3: Write the migration**

`db/migrations/000024_configuration_immutable_with_history.up.sql`:

```sql
-- ============================================================================
--  A unit's axle configuration is immutable once it has history (TYRE-82)
--  Implements: D11(ii) of 27 Aug 2026; FR-VEH-016, INV-4
-- ============================================================================

-- Positions belong to a configuration version, not to a vehicle (FR-VEH-016).
-- Repointing vehicle.configuration_id leaves every existing fitment and
-- reading referencing position rows of the old version — a tyre fitted to a
-- position the vehicle no longer has. Nothing downstream can detect that
-- afterwards, which is why this is a constraint and not a review item.
--
-- History means fitment OR inspection OR reading, and the third is not
-- redundant. app.inspection.vehicle_id is the MOTIVE unit, so a trailer
-- inspected as part of a rig has no inspection row of its own; what it has is
-- reading rows carrying its own vehicle_id, which FR-INS-061 defines as the
-- owning unit. Testing only fitment and inspection would let precisely the
-- trailer case through.
--
-- Invoker rights, deliberately: the counts run under the caller's RLS, so a
-- caller who cannot see a tenant's history cannot be the one editing its
-- vehicles either.
CREATE FUNCTION app.reject_configuration_change_with_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NEW.configuration_id IS NOT DISTINCT FROM OLD.configuration_id THEN
    RETURN NEW;
  END IF;

  SELECT (EXISTS (SELECT 1 FROM app.fitment    f WHERE f.vehicle_id = OLD.id)
       OR EXISTS (SELECT 1 FROM app.inspection i WHERE i.vehicle_id = OLD.id)
       OR EXISTS (SELECT 1 FROM app.reading    r WHERE r.vehicle_id = OLD.id))::int
    INTO n;

  IF n = 1 THEN
    RAISE EXCEPTION USING
      ERRCODE  = 'TY008',
      MESSAGE  = 'axle configuration cannot change once the unit has history',
      HINT     = 'correct a wrong configuration by retiring the unit and re-adding it, or by a dated migration that moves the history with it — never by an edit';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE, not AFTER: the refusal must land before any dependent trigger
-- (000017's stamp) has done work on a row that is not going to survive.
CREATE TRIGGER vehicle_configuration_is_immutable
  BEFORE UPDATE ON app.vehicle
  FOR EACH ROW EXECUTE FUNCTION app.reject_configuration_change_with_history();

-- TY008 has no entry in api/internal/httpapi/httpapi.go's submitStatus map.
-- That is deliberate: no HTTP path updates app.vehicle yet, and an unreachable
-- map entry is dead code. Whoever builds the vehicle write surface maps it to
-- 422 and disables the field in the UI once history exists — TYRE-82 asks for
-- that citation, and this comment is it.
```

`db/migrations/000024_configuration_immutable_with_history.down.sql`:

```sql
DROP TRIGGER IF EXISTS vehicle_configuration_is_immutable ON app.vehicle;
DROP FUNCTION IF EXISTS app.reject_configuration_change_with_history();
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
make db-reset && make db-test
```

Expected: `PASS  configuration is immutable with history, editable without, and other columns are untouched`, and every earlier section still passing.

- [ ] **Step 5: Verify the down migration reverses cleanly**

```bash
docker compose run --rm migrate -path=/migrations -database "$MIGRATE_URL" down 1
docker compose run --rm migrate -path=/migrations -database "$MIGRATE_URL" up
```

Use whatever the Makefile's own migrate target supplies for the URL rather than inventing one — read the `db-migrate` target and follow it. Expected: both directions clean, no error.

- [ ] **Step 6: Audit and commit**

Run the `rls-auditor` agent over `000024_*.up.sql`. Then:

```bash
make check
git add db/migrations/000024_configuration_immutable_with_history.up.sql \
        db/migrations/000024_configuration_immutable_with_history.down.sql \
        db/tests/004_tests.sql
git commit -m "feat(db): TYRE-82 refuse an axle configuration change once a unit has history"
```

---

### Task 3: Fitment odometer is required where the unit kind has one (TYRE-85)

**Files:**
- Create: `db/migrations/000025_fitment_odometer_by_unit_kind.up.sql`
- Create: `db/migrations/000025_fitment_odometer_by_unit_kind.down.sql`
- Test: `db/tests/004_tests.sql` — append section 33

**Interfaces:**
- Consumes: `app.vehicle.unit_kind` (nullable `app.unit_kind`), confirmed in Task 1.
- Produces: `app.require_odometer_where_unit_has_one()` returning `trigger`; trigger `fitment_odometer_matches_unit_kind` on `app.fitment`; SQLSTATE `TY009` with message `fitment odometer is required for a unit that has one`.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql`:

```sql
\echo '== 33. Fitment odometer is required where the unit kind has one (FR-FIT-002 as corrected in SRS v1.4, CHG-027)'
DO $$
DECLARE ok boolean := false; t uuid; horse uuid; trailer uuid; nullkind uuid;
        cfg uuid; pos uuid; ty uuid; f uuid;
BEGIN
  SELECT v.tenant_id, v.configuration_id INTO t, cfg
    FROM app.vehicle v WHERE v.unit_kind = 'HORSE' LIMIT 1;
  IF t IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no HORSE to test with'; END IF;

  SELECT p.id INTO pos FROM app.position p WHERE p.configuration_id = cfg AND NOT p.is_spare LIMIT 1;
  SELECT ty2.id INTO ty FROM app.tyre ty2 WHERE ty2.tenant_id = t LIMIT 1;

  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t, 'TY85-HORSE', cfg, 'HORSE') RETURNING id INTO horse;
  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t, 'TY85-TRAILER', cfg, 'TRAILER') RETURNING id INTO trailer;
  -- CHG-027 left underivable kinds NULL. Such a unit must not be blocked:
  -- we do not know whether it has an odometer, and guessing would refuse
  -- legitimate work.
  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t, 'TY85-UNKNOWN', cfg, NULL) RETURNING id INTO nullkind;

  -- (a) A horse fitted with no odometer is refused.
  BEGIN
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
         VALUES (t, ty, horse, pos, now(), NULL);
  EXCEPTION WHEN SQLSTATE 'TY009' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a HORSE fitment without an odometer was accepted'; END IF;

  -- (b) A trailer fitted with no odometer is accepted — it has none to give,
  -- and refusing it makes two-thirds of a superlink unrecordable.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
       VALUES (t, ty, trailer, pos, now(), NULL);

  -- (c) A NULL-kind unit is not blocked.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
       VALUES (t, ty, nullkind, pos, now(), NULL);

  -- (d) A horse fitted WITH an odometer is accepted, then refused a removal
  -- that omits the removed odometer — the second half of FR-FIT-002.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
       VALUES (t, ty, horse, pos, now(), 100000) RETURNING id INTO f;

  ok := false;
  BEGIN
    UPDATE app.fitment
       SET removed_at = now(), removed_odometer = NULL, removal_reason = 'WORN'
     WHERE id = f;
  EXCEPTION WHEN SQLSTATE 'TY009' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a HORSE removal without an odometer was accepted'; END IF;

  -- (e) The same removal with an odometer succeeds.
  UPDATE app.fitment
     SET removed_at = now(), removed_odometer = 120000, removal_reason = 'WORN'
   WHERE id = f;

  RAISE NOTICE 'PASS  odometer required on odometer-bearing kinds at fitment and removal, optional elsewhere';
END $$;
ROLLBACK;
BEGIN;
```

If the fixture has no HORSE, or `app.tyre` returns none for the tenant, the test raises rather than passing vacuously — `docs/lessons.md`, 2026-08-20: *"a test that cannot fail is worse than no test."*

- [ ] **Step 2: Run the suite to verify it fails**

```bash
make db-test
```

Expected: `FAIL: a HORSE fitment without an odometer was accepted`.

- [ ] **Step 3: Write the migration**

`db/migrations/000025_fitment_odometer_by_unit_kind.up.sql`:

```sql
-- ============================================================================
--  Fitment odometer is required where the unit kind has one (TYRE-85)
--  Implements: FR-FIT-002 as corrected in SRS v1.4; CHG-027
-- ============================================================================

-- 000011 dropped fitted_odometer NOT NULL so a trailer could be fitted at all:
-- trailers have no odometer and carry roughly two-thirds of the tyres on a
-- superlink. That was half of the corrected requirement. The other half —
-- required where the unit HAS one — has been enforced nowhere since, so a
-- horse fitment with no odometer is silently accepted and its distance
-- degrades to UNAVAILABLE, understating cost-per-km coverage for exactly the
-- units where MEASURED was available.
--
-- A CHECK cannot see app.vehicle, so this is a trigger.
--
-- NULL unit_kind passes. CHG-027's backfill left underivable rows NULL, and a
-- unit whose kind we do not know is a unit whose odometer we cannot reason
-- about; refusing it would block legitimate work to enforce a rule we cannot
-- show applies.
CREATE FUNCTION app.require_odometer_where_unit_has_one()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE k app.unit_kind;
BEGIN
  SELECT v.unit_kind INTO k FROM app.vehicle v WHERE v.id = NEW.vehicle_id;

  IF k IS NULL OR k = 'TRAILER' THEN
    RETURN NEW;
  END IF;

  IF NEW.fitted_odometer IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at fitment; only a trailer, or a unit of unknown kind, may omit it';
  END IF;

  -- The removal half of FR-FIT-002, checked when the removal is recorded
  -- rather than at insert, because a fitment is open for most of its life.
  IF NEW.removed_at IS NOT NULL AND NEW.removed_odometer IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at removal; without it the distance this tyre ran is unrecoverable';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fitment_odometer_matches_unit_kind
  BEFORE INSERT OR UPDATE ON app.fitment
  FOR EACH ROW EXECUTE FUNCTION app.require_odometer_where_unit_has_one();

-- TY009 has no entry in submitStatus for the same reason TY008 has none: no
-- HTTP path writes app.fitment yet. It is a permanent client-side refusal and
-- wants 422 when the fitment write surface arrives.
```

`db/migrations/000025_fitment_odometer_by_unit_kind.down.sql`:

```sql
DROP TRIGGER IF EXISTS fitment_odometer_matches_unit_kind ON app.fitment;
DROP FUNCTION IF EXISTS app.require_odometer_where_unit_has_one();
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
make db-reset && make db-test
```

Expected: `PASS  odometer required on odometer-bearing kinds at fitment and removal, optional elsewhere`.

If `make db-reset` now fails while loading seeds, the seed generator is producing a horse fitment without an odometer. That is a real finding, not a test to weaken: report it, and fix the generator in `db/seeds/`.

- [ ] **Step 5: Verify the down migration reverses cleanly**

Same two commands as Task 2 Step 5, `down 1` then `up`.

- [ ] **Step 6: Audit and commit**

Run `rls-auditor` over `000025_*.up.sql`. Then:

```bash
make check
git add db/migrations/000025_fitment_odometer_by_unit_kind.up.sql \
        db/migrations/000025_fitment_odometer_by_unit_kind.down.sql \
        db/tests/004_tests.sql
git commit -m "feat(db): TYRE-85 require a fitment odometer where the unit kind has one"
```

---

### Task 4: TYRE-30's two remaining constraints

**Files:**
- Create: `db/migrations/000026_tenant_null_email_and_assignment_overlap.up.sql`
- Create: `db/migrations/000026_tenant_null_email_and_assignment_overlap.down.sql`
- Test: `db/tests/004_tests.sql` — append section 34

**Interfaces:**
- Consumes: `app.app_user (tenant_id, email)`, `app.vehicle_driver (vehicle_id, user_id, from_date, to_date)`.
- Produces: unique index `app_user_platform_admin_email_key`; exclusion constraint `vehicle_driver_no_overlap`; the `btree_gist` extension.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql`:

```sql
\echo '== 34. Platform-admin emails are unique, and a driver assignment cannot duplicate itself (TYRE-30, DR-003)'
DO $$
DECLARE ok boolean := false; t uuid; v uuid; u uuid;
BEGIN
  -- (a) UNIQUE (tenant_id, email) treats NULL tenant_id as distinct, so two
  -- platform admins could share an email. Reachable only through the postgres
  -- provisioning path, which is why this runs as a superuser check.
  SET LOCAL ROLE postgres;
  BEGIN
    INSERT INTO app.app_user (tenant_id, email, role, full_name)
         VALUES (NULL, 'ty30-dup@example.test', 'PLATFORM_ADMIN', 'First');
    INSERT INTO app.app_user (tenant_id, email, role, full_name)
         VALUES (NULL, 'ty30-dup@example.test', 'PLATFORM_ADMIN', 'Second');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  RESET ROLE;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: two platform admins accepted the same email'; END IF;

  -- (b) An exact-duplicate current assignment multiplies the vehicle through
  -- v_current_assignment and v_driver_vehicle.
  SELECT vd.tenant_id, vd.vehicle_id, vd.user_id INTO t, v, u
    FROM app.vehicle_driver vd WHERE vd.to_date IS NULL LIMIT 1;
  IF v IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no open driver assignment'; END IF;

  ok := false;
  BEGIN
    INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date, to_date)
         VALUES (t, v, u, current_date, NULL);
  EXCEPTION WHEN exclusion_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a duplicate open assignment was accepted'; END IF;

  -- (c) A SECOND DRIVER on the same vehicle is still permitted. OI-32 —
  -- fixed per horse or pooled per trip — is an open sponsor question
  -- (TYRE-44), and a constraint that answered it would be this migration
  -- deciding scope it has no authority over.
  SELECT au.id INTO u FROM app.app_user au
   WHERE au.tenant_id = t AND au.role = 'DRIVER'
     AND au.id NOT IN (SELECT user_id FROM app.vehicle_driver WHERE vehicle_id = v)
   LIMIT 1;
  IF u IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no second driver to prove OI-32 is left open'; END IF;
  INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date, to_date)
       VALUES (t, v, u, current_date, NULL);

  -- (d) A non-overlapping re-assignment of the SAME driver is permitted —
  -- a driver returning to a unit after a gap is ordinary.
  SELECT vd.user_id INTO u FROM app.vehicle_driver vd
   WHERE vd.vehicle_id = v AND vd.to_date IS NULL LIMIT 1;
  UPDATE app.vehicle_driver SET to_date = current_date - 10
   WHERE vehicle_id = v AND user_id = u AND to_date IS NULL;
  INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date, to_date)
       VALUES (t, v, u, current_date - 5, NULL);

  RAISE NOTICE 'PASS  platform-admin emails unique; assignments cannot overlap themselves, and OI-32 stays open';
END $$;
ROLLBACK;
BEGIN;
```

- [ ] **Step 2: Run the suite to verify it fails**

```bash
make db-test
```

Expected: `FAIL: two platform admins accepted the same email`.

- [ ] **Step 3: Write the migration**

`db/migrations/000026_tenant_null_email_and_assignment_overlap.up.sql`:

```sql
-- ============================================================================
--  Platform-admin email uniqueness and driver-assignment overlap (TYRE-30)
--  Implements: the two folded decisions TYRE-30 left open; DR-003
-- ============================================================================

-- UNIQUE (tenant_id, email) in 000001 treats NULL tenant_id as distinct, so
-- two PLATFORM_ADMIN rows can share an email. Hygiene rather than exposure:
-- app_rw's WITH CHECK rejects any NULL-tenant insert, so this is reachable
-- only through the postgres provisioning path. Case folding deliberately
-- matches the existing index rather than improving on it — one email
-- comparison rule in the schema, not two.
CREATE UNIQUE INDEX app_user_platform_admin_email_key
  ON app.app_user (email) WHERE tenant_id IS NULL;

-- gist over uuid equality: btree_gist is what lets a uuid participate in an
-- exclusion constraint alongside a range.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- An exact-duplicate open assignment multiplies its vehicle through
-- v_current_assignment and v_driver_vehicle, so a driver's own vehicle list
-- shows the unit twice.
--
-- Keyed on (vehicle_id, user_id), NOT on vehicle_id alone. Constraining a
-- vehicle to one driver at a time would answer OI-32 — fixed per horse or
-- pooled per trip (TYRE-44) — which is an open sponsor question. This rejects
-- a driver overlapping themselves on one unit and nothing else.
--
-- No SRS requirement ID: TYRE-30 asked for a decision rather than citing one,
-- and this comment is that decision.
--
-- '[]' bounds because from_date and to_date are inclusive under this table's
-- own CHECK (to_date >= from_date); an open assignment has to_date NULL, which
-- daterange reads as unbounded above, so two open assignments always overlap.
ALTER TABLE app.vehicle_driver
  ADD CONSTRAINT vehicle_driver_no_overlap
  EXCLUDE USING gist (
    vehicle_id WITH =,
    user_id    WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  );
```

`db/migrations/000026_tenant_null_email_and_assignment_overlap.down.sql`:

```sql
ALTER TABLE app.vehicle_driver DROP CONSTRAINT IF EXISTS vehicle_driver_no_overlap;
DROP INDEX IF EXISTS app.app_user_platform_admin_email_key;

-- btree_gist is deliberately left installed. Dropping an extension another
-- migration may later depend on is a wider action than reversing this one.
```

- [ ] **Step 4: Run the suite to verify it passes**

```bash
make db-reset && make db-test
```

Expected: `PASS  platform-admin emails unique; assignments cannot overlap themselves, and OI-32 stays open`.

If `ALTER TABLE ... ADD CONSTRAINT` fails on existing data, the fixture already holds overlapping assignments. That is a finding worth reporting before you touch anything — it means the bug TYRE-30 described is live in the seed, not just possible.

- [ ] **Step 5: Verify the down migration reverses cleanly**

Same two commands as Task 2 Step 5.

- [ ] **Step 6: Audit and commit**

Run `rls-auditor` over `000026_*.up.sql` — this task adds an index and a constraint, so the auditor's attention is on whether either creates a cross-tenant read path. Then:

```bash
make check
git add db/migrations/000026_tenant_null_email_and_assignment_overlap.up.sql \
        db/migrations/000026_tenant_null_email_and_assignment_overlap.down.sql \
        db/tests/004_tests.sql
git commit -m "feat(db): TYRE-30 unique platform-admin emails and non-overlapping driver assignments"
```

---

### Task 5: Close the branch out

**Files:**
- Modify: `docs/implementation-order.md`
- Modify: `docs/lessons.md` — only if something in this branch failed in a way that would fool the next session

**Interfaces:**
- Consumes: Tasks 2–4 committed.
- Produces: a merged branch and four closed tickets.

- [ ] **Step 1: Prove the three-way agreement still holds**

The Appendix J fixture must still produce exactly **19 exceptions, 11 urgent, 9 running positions below the removal threshold**, and the database, capture app and dashboard must still agree. Run:

```bash
make check
```

Expected: every section of the suite passing, all 15 Appendix E valuations cent-exact, the Appendix J sets unchanged. None of the three constraints in this plan touches a valuation or an exception view, so any movement in those numbers is a bug in this branch and not an expected consequence.

- [ ] **Step 2: Full down-and-up over all three migrations**

```bash
make db-reset
docker compose run --rm migrate -path=/migrations -database "$MIGRATE_URL" down 3
docker compose run --rm migrate -path=/migrations -database "$MIGRATE_URL" up
make db-test
```

Expected: clean both ways, suite green afterwards.

- [ ] **Step 3: Comment audit**

```bash
node scripts/check-comment-style.mjs
```

Then run `/comment-audit` over the branch — the script catches shape, not narration, and `docs/lessons.md` (2026-08-26) records that a green run is not evidence of no narration. Every comment added by this plan must explain a constraint that is not visible in the code, and none may compare to the old behaviour.

- [ ] **Step 4: Mark B1 delivered**

In `docs/implementation-order.md`, update the B1 section to name the three migrations and the branch. Leave the disposition table alone — it is a dated snapshot of the 27 Aug reconciliation, not a live tracker.

- [ ] **Step 5: Commit and push**

```bash
make check
git add docs/implementation-order.md
git commit -m "docs: TYRE-82 record B1 as delivered in the implementation order"
git push -u origin TYRE-82-db-integrity-rules
```

- [ ] **Step 6: Open the PR and stop**

```bash
gh pr create --base develop --title "feat(db): TYRE-82/85/30 database integrity rules before pilot data" --body "..."
```

Do **not** merge. Merges happen in the GitHub web UI, by the repo owner — that is a standing preference, not a step to optimise away. Report the PR URL and stop.

- [ ] **Step 7: Transition the tickets**

Only after the PR is merged: TYRE-82 and TYRE-85 to Done. TYRE-30 to Done as well — this branch closes its last two folded decisions, and DR-014b remains separately tracked as TYRE-60. Comment on each citing the migration that satisfies it.

## Self-review notes

Checked before handing this over:

- **Ticket coverage.** TYRE-82's DoD (trigger, paired down, both test directions) is Task 2. TYRE-85's DoD (all three cases plus the removal half) is Task 3, cases (a)–(e). TYRE-30's two residuals are Task 4, with the third folded decision — `staff_number` uniqueness — already delivered in `8ad7c9f` and correctly absent here.
- **Type consistency.** `app.reject_configuration_change_with_history()` and `app.require_odometer_where_unit_has_one()` are each named identically in their migration, their down migration and their task interface block. `TY008` belongs to Task 2 only, `TY009` to Task 3 only.
- **The one thing this plan cannot verify for you.** The test sections assume the fixture contains a HORSE, a second axle configuration per tenant, an open driver assignment, and a second DRIVER. Each assumption raises an explicit `FAIL` rather than passing vacuously, so a missing fixture row surfaces as a failure and not as a false green. If one fires, extend the Sandbox Fleet seed (TYRE-80) rather than BAC's.
