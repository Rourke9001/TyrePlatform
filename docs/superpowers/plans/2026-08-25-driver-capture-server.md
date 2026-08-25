# Driver Capture — Server Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the platform its first write path, so a driver's completed inspection can be submitted over HTTP, land atomically and idempotently, and re-strike the fleet's valuation — with the reference data the capture client needs to run those checks offline.

**Architecture:** The business rules live in SQL beside the constraints that already enforce the rest of them; Go stays transport. Three focused migrations (a repair, a new table, the submit function) then two endpoints. The database already derives governing tread, checks ordinal contiguity and enforces idempotency — this plan adds only what becomes reachable the moment a client can post.

**Tech Stack:** PostgreSQL 16 (plpgsql, RLS, `golang-migrate`), Go 1.24 (`chi`, `pgx`, `testify/require`), all run through the Makefile in docker.

**Spec:** `docs/superpowers/specs/2026-08-25-driver-capture-and-outbox-design.md` — read it first. This plan argues from it.

**Tickets:** TYRE-66 (Tasks 1–3) · TYRE-71 (Task 4) · TYRE-67 (Tasks 5–6), under epic TYRE-4.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **Tenant isolation lives in the database.** RLS, never application code alone. Every new view needs `security_invoker = true`. The app must not connect as a superuser.
- **All money is `DECIMAL`/`numeric`.** Never float. No monetary field appears anywhere in this plan's endpoints — `ViewValuation` gates money by server-side projection, and a `DRIVER` does not hold it.
- **Readings and fitment events are immutable.** `UPDATE`/`DELETE` are revoked from `app_rw` on `app.reading` and `app.reading_measurement`. Never add an endpoint that edits one.
- **Tread is never a scalar** (CR-011). It is an ordered set of width-wise measurements with a materialised `MIN()` as the governing value.
- **Every threshold, band and rate is tenant configuration** (rule 5). If you are about to type a numeric literal for a threshold, stop and read it from `app.config_for` instead.
- **Timestamps stored UTC**, displayed in tenant timezone.
- **`SECURITY INVOKER` only.** `db/tests/004_tests.sql` asserts the allowlist is exactly `ARRAY['refresh_governing_tread']` and fails the build on any other `SECURITY DEFINER` routine in the `app` schema.
- **Pin `search_path`** on every new function: `SET search_path = app, pg_temp`.
- **Never edit an applied migration.** Add a new one.
- **Test cleanup is `BEGIN`/`ROLLBACK`, never `DELETE`** — DR-014a revoked `DELETE` from `app_rw` on almost everything, so a cleanup `DELETE` cannot work anyway.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code — git holds the history. Cite the requirement ID (`FR-INS-038`, `DR-020`) for any non-obvious rule. `db/migrations/000001_init.up.sql` is the reference for house style.
- **Run `make check` before every commit.** Docker must be running.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| ID | Text |
| --- | --- |
| FR-INS-038 | "reject submission of a second inspection of the same unit within a configurable minimum interval, defaulting to four hours, unless overridden by a `CONTROLLER`" |
| FR-OFF-011 | "process submits idempotently, keyed by a client-generated identifier, such that repeated submission of the same inspection creates exactly one server record" |
| FR-OFF-016 | "resolve conflicting fitment state by accepting the inspection and raising a discrepancy exception for controller resolution, rather than rejecting the inspection" |
| FR-INS-020 | "optional and pre-filled… shall never block a tyre inspection… Confirmed values are recorded to the vehicle odometer timeline with source `INSPECTION`, subject to DR-020" |
| DR-020 | "rejected where it violates monotonicity for its vehicle, or implies a daily distance above a configurable plausibility ceiling" |
| DR-021 | "append-only child record of the inspection (`inspection_warning`): warning code, entered value where applicable, response, and an optional reading reference… The response is **nullable**" |
| FR-VEH-016 | "version axle configurations, so that amending a configuration does not alter the position meaning of historical inspections" |
| BR-VEH-003 | "never stored and never transmitted — every reading is captured and submitted against `unit + own position`" |
| BR-INS-003 | "The governing tread depth for a tyre is the minimum of all width-wise readings taken at that inspection" |
| NFR-SEC-007 | "rate-limit authentication endpoints and submission endpoints per account and per source address" |

## File Structure

| File | Responsibility |
| --- | --- |
| `db/migrations/000021_odometer_configurable_ceiling.{up,down}.sql` | Repair `check_odometer_plausible`: configurable ceiling, trappable ERRCODEs |
| `db/migrations/000022_inspection_warning.{up,down}.sql` | `app.inspection_warning` — DR-021's append-only record |
| `db/migrations/000023_submit_inspection.{up,down}.sql` | `app.submit_inspection` — the one write entry point |
| `db/seeds/gen_seed_configurations.py` | Add the four new tenant config keys (generator is the source of truth) |
| `db/tests/004_tests.sql` | New sections 29–31, appended before the final banner |
| `api/internal/store/store.go` | No change — `InActorTx` is already the only helper needed |
| `api/internal/httpapi/capture.go` | **New.** The capture reference read and the submit handler, kept out of the growing `httpapi.go` |
| `api/internal/httpapi/httpapi.go` | Route registration and the shared body-limit/rate-limit middleware |
| `api/internal/httpapi/capture_test.go` | **New.** Table-driven integration tests for both |

Two new config keys, both seeded per tenant:

| Key | Default | Requirement |
| --- | --- | --- |
| `odometer_max_daily_km` | `1600` | DR-020's "configurable plausibility ceiling" |
| `duplicate_inspection_min_hours` | `4` | FR-INS-038's "configurable minimum interval, defaulting to four hours" |
| `wear_rate_alert_multiple` | `3` | FR-INS-035's "configurable multiple of the fleet average… defaulting to three times" |
| `tread_capture_granularity_mm` | `1.0` | FR-CFG-027's 1.0 / 0.5 / 0.1mm capture granularity, stamped onto every reading (FR-INS-021) |

---

### Task 1: Odometer plausibility — a configurable ceiling and trappable ERRCODEs

Two latent defects, both unreachable until a client can write an odometer, both blocking Task 3.

`app.check_odometer_plausible` hard-codes `max_daily_km constant int := 1600` while DR-020 requires a configurable ceiling and rule 5 forbids the literal outright. And its three refusals raise bare, so each arrives as `P0001` — meaning `app.submit_inspection` could not contain a timeline refusal without also swallowing an FK violation or a serialisation failure on the same `INSERT`, which is the silent-failure mode the whole design refuses.

**Files:**
- Create: `db/migrations/000021_odometer_configurable_ceiling.up.sql`
- Create: `db/migrations/000021_odometer_configurable_ceiling.down.sql`
- Modify: `db/seeds/gen_seed_configurations.py`
- Modify: `db/tests/004_tests.sql` (new section 29, before the final `\echo` banner)

**Interfaces:**
- Consumes: `app.config_for(p_tenant uuid, p_key text, p_before timestamptz) RETURNS jsonb`, already defined in `000007`.
- Produces: SQLSTATE `TY001` (monotonicity refused) and `TY002` (plausibility ceiling exceeded), raised by the `odometer_plausibility` trigger on `app.vehicle_odometer_reading`. Task 3 traps exactly these two and re-raises everything else.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql`, immediately before the final `\echo '================  ALL CHECKS PASSED  ================'` line:

```sql
\echo '== 29. Odometer ceiling is tenant configuration, and refusals are trappable (DR-020, FR-INS-033)'
-- Transaction-scoped: the probe readings and the raised ceiling both roll
-- back (DR-018 leaves the app role no DELETE on the timeline).
BEGIN;
DO $$
DECLARE
  t_id  constant uuid := '11111111-1111-1111-1111-111111111111';
  v_id  uuid;
  got   text;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  SELECT id INTO v_id FROM app.vehicle WHERE tenant_id = t_id ORDER BY fleet_number LIMIT 1;

  INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
  VALUES (t_id, v_id, DATE '2026-01-01', 100000, 'MANUAL');

  -- monotonicity is unconditional (BR-INS-002) and must be trappable by code
  got := NULL;
  BEGIN
    INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
    VALUES (t_id, v_id, DATE '2026-01-02', 99000, 'MANUAL');
  EXCEPTION WHEN SQLSTATE 'TY001' THEN got := 'TY001';
  END;
  IF got IS DISTINCT FROM 'TY001' THEN
    RAISE EXCEPTION 'FAIL: a backwards odometer did not raise TY001 (got %)', COALESCE(got, 'no error');
  END IF;

  -- the ceiling is configuration, not a constant: 5000 km in one day is
  -- refused at the seeded 1600 and accepted once the tenant raises it
  got := NULL;
  BEGIN
    INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
    VALUES (t_id, v_id, DATE '2026-01-02', 105000, 'MANUAL');
  EXCEPTION WHEN SQLSTATE 'TY002' THEN got := 'TY002';
  END;
  IF got IS DISTINCT FROM 'TY002' THEN
    RAISE EXCEPTION 'FAIL: an implausible odometer did not raise TY002 (got %)', COALESCE(got, 'no error');
  END IF;

  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES (t_id, 'odometer_max_daily_km', '6000'::jsonb, TIMESTAMPTZ '2025-01-01T00:00:00Z');

  INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
  VALUES (t_id, v_id, DATE '2026-01-02', 105000, 'MANUAL');

  RAISE NOTICE 'PASS  the odometer ceiling is tenant configuration and its refusals carry TY001/TY002';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `make db-test`
Expected: FAIL — `a backwards odometer did not raise TY001 (got no error)`. The trigger raises `P0001`, so the `WHEN SQLSTATE 'TY001'` handler never catches it and the exception escapes the inner block. (If instead the whole suite aborts with the raw trigger message, that is the same finding.)

- [ ] **Step 3: Write the migration**

`db/migrations/000021_odometer_configurable_ceiling.up.sql`:

```sql
-- ============================================================================
--  Odometer plausibility: a tenant-configured ceiling, and trappable refusals
--  Implements: DR-020, FR-INS-033, BR-INS-002
-- ============================================================================

-- The ceiling is configuration because DR-020 says "configurable" and because
-- a linehaul tenant legitimately covers more ground in a day than a municipal
-- fleet; a constant refuses one of them its own drivers' work.
--
-- Absent configuration the plausibility check stands down while monotonicity
-- still holds: BR-INS-002 is unconditional, but refusing every reading a
-- tenant has not yet configured a ceiling for would block capture on an
-- unmade decision. Seeded for every tenant, so the fail-open path is a
-- backstop rather than the normal case.
--
-- The refusals carry their own SQLSTATEs so app.submit_inspection can contain
-- a timeline refusal (FR-INS-020: it never blocks the inspection) without
-- swallowing an FK violation or a serialisation failure on the same INSERT.
--   TY001 — monotonicity: this reading contradicts one already on the timeline
--   TY002 — plausibility: the implied daily distance exceeds the tenant ceiling
CREATE OR REPLACE FUNCTION app.check_odometer_plausible() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE
  prev       record;
  nxt        record;
  ceiling_km int;
BEGIN
  ceiling_km := (app.config_for(NEW.tenant_id, 'odometer_max_daily_km',
                                (NEW.reading_date + 1)::timestamp AT TIME ZONE 'UTC') #>> '{}')::int;

  SELECT reading_date, odometer_km INTO prev
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date < NEW.reading_date
   ORDER BY reading_date DESC LIMIT 1;

  IF FOUND THEN
    IF NEW.odometer_km < prev.odometer_km THEN
      RAISE EXCEPTION 'odometer went backwards for vehicle % (% km on %, % km on %)',
        NEW.vehicle_id, prev.odometer_km, prev.reading_date, NEW.odometer_km, NEW.reading_date
        USING ERRCODE = 'TY001';
    END IF;
    IF ceiling_km IS NOT NULL
       AND (NEW.odometer_km - prev.odometer_km)
           > ceiling_km * GREATEST(1, (NEW.reading_date - prev.reading_date)) THEN
      RAISE EXCEPTION 'implausible distance for vehicle %: % km in % day(s)',
        NEW.vehicle_id, NEW.odometer_km - prev.odometer_km, NEW.reading_date - prev.reading_date
        USING ERRCODE = 'TY002';
    END IF;
  END IF;

  SELECT reading_date, odometer_km INTO nxt
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date > NEW.reading_date
   ORDER BY reading_date ASC LIMIT 1;

  IF FOUND AND nxt.odometer_km < NEW.odometer_km THEN
    RAISE EXCEPTION 'odometer reading % km on % exceeds later reading % km on %',
      NEW.odometer_km, NEW.reading_date, nxt.odometer_km, nxt.reading_date
      USING ERRCODE = 'TY001';
  END IF;

  RETURN NEW;
END $$;
```

`db/migrations/000021_odometer_configurable_ceiling.down.sql` restores the constant and the bare raises verbatim as `000012` defined them:

```sql
CREATE OR REPLACE FUNCTION app.check_odometer_plausible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev record; nxt record; max_daily_km constant int := 1600;
BEGIN
  SELECT reading_date, odometer_km INTO prev
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date < NEW.reading_date
   ORDER BY reading_date DESC LIMIT 1;

  IF FOUND THEN
    IF NEW.odometer_km < prev.odometer_km THEN
      RAISE EXCEPTION 'odometer went backwards for vehicle % (% km on %, % km on %)',
        NEW.vehicle_id, prev.odometer_km, prev.reading_date, NEW.odometer_km, NEW.reading_date;
    END IF;
    IF (NEW.odometer_km - prev.odometer_km)
       > max_daily_km * GREATEST(1, (NEW.reading_date - prev.reading_date)) THEN
      RAISE EXCEPTION 'implausible distance for vehicle %: % km in % day(s)',
        NEW.vehicle_id, NEW.odometer_km - prev.odometer_km, NEW.reading_date - prev.reading_date;
    END IF;
  END IF;

  SELECT reading_date, odometer_km INTO nxt
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date > NEW.reading_date
   ORDER BY reading_date ASC LIMIT 1;

  IF FOUND AND nxt.odometer_km < NEW.odometer_km THEN
    RAISE EXCEPTION 'odometer reading % km on % exceeds later reading % km on %',
      NEW.odometer_km, NEW.reading_date, nxt.odometer_km, nxt.reading_date;
  END IF;

  RETURN NEW;
END $$;
```

- [ ] **Step 4: Seed the new config key**

`db/seeds/002_seed_configurations.sql` is generated and gitignored — edit the generator, never the output. In `db/seeds/gen_seed_configurations.py`, find the list of scalar per-tenant keys (the ones producing rows like `'reading_staleness_days','28'::jsonb`) and add alongside them:

```python
("odometer_max_daily_km", 1600),          # DR-020's configurable ceiling
("duplicate_inspection_min_hours", 4),    # FR-INS-038, used from Task 3
("wear_rate_alert_multiple", 3),          # FR-INS-035, served to the client by Task 4
("tread_capture_granularity_mm", 1.0),    # FR-CFG-027; 1.0 matches the fixture and app.reading_measurement.granularity_mm
```

Match the surrounding style exactly — if the existing entries are tuples in a list, add tuples; if they are dict entries, add dict entries. Both keys are seeded now so Task 3 does not have to touch the generator again.

- [ ] **Step 5: Regenerate seeds and confirm determinism**

Run: `make db-seeds && make db-reset`
Then run it a second time and confirm the generated file is byte-identical — CI's "Seeds are deterministic" step compares SHA-256 sums and will fail the build otherwise:

```bash
cd db/seeds && python3 gen_seed_configurations.py && sha256sum 002_seed_configurations.sql
python3 gen_seed_configurations.py && sha256sum 002_seed_configurations.sql
```

Expected: the two sums match.

- [ ] **Step 6: Run the suite and verify it passes**

Run: `make db-test`
Expected: `PASS  the odometer ceiling is tenant configuration and its refusals carry TY001/TY002`, and `ALL CHECKS PASSED` at the end. The fifteen Appendix E valuations and the Appendix J exception sets must be untouched — adding a configuration key changes no valuation.

- [ ] **Step 7: Verify the down migration mirrors the up**

Run: `make db-reset` then apply and revert one step to confirm the down migration is valid SQL and restores the previous definition.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/000021_odometer_configurable_ceiling.up.sql \
        db/migrations/000021_odometer_configurable_ceiling.down.sql \
        db/seeds/gen_seed_configurations.py db/tests/004_tests.sql
git commit -m "fix(db): TYRE-66 odometer ceiling is tenant config, refusals carry TY001/TY002"
```

---

### Task 2: `app.inspection_warning` — DR-021's append-only record, and where per-position timing lands

> **NFR-OBS-007 has no column, so add one here.** The requirement is to record *median time-per-position* "so that the effect of the three-reading model on NFR-USE-001 is measured rather than assumed", and `app.inspection` carries only `duration_seconds`. The client sends `seconds` on every reading (web plan, Task 7) and without a column the submit function would silently drop it — and it cannot be backfilled onto inspections already captured, which is the whole reason it lands with this phase. Add to this migration:

> ```sql
> -- NFR-OBS-007: the measurement that settles whether three readings per
> -- position cost NFR-USE-001 its budget. Nullable: an imported or
> -- back-dated reading has no capture time, and a zero would be a claim
> -- (NFR-PRO-002).
> ALTER TABLE app.reading ADD COLUMN capture_seconds int CHECK (capture_seconds >= 0);
> ```

> `app.reading` has `UPDATE`/`DELETE` revoked from `app_rw` (DR-011); adding a column is DDL run by the migration role and does not touch that. Task 3's INSERT must carry it, and the suite section should assert a submitted reading has a non-null `capture_seconds`.

FR-INS-040 has been a Must with no home since v1.3. Errata E2 gave it DR-021 and a named entity; this builds it. The `response` column is nullable for a specific reason: a submit can sit in the outbox for days and be refused server-side with no driver present to answer.

**Also in this migration: the capture scope view.** A rig inspection reads a capture context per member unit, and `app.v_driver_vehicle` is current *assignments* only — so a driver assigned the horse cannot read their own trailers. The fixture demonstrates it exactly: `driver1` holds `veh1` and `veh3`, their `veh2` assignment ended 2024-12-31, and all three are members of `comb1`. Without this view a superlink cannot be captured at all.

> **This is an authorisation widening, taken as a default rather than assumed.** FR-AUT-005 restricts a `DRIVER` to "the vehicle or vehicles currently assigned to them", and FR-INS-053 already establishes that coupling propagates responsibility — "trailer coupled to a horse → that horse's driver". Extending *read for capture* along the same chain follows that reasoning. It is narrower than it looks: reachable only through the current combination of a unit the driver actually holds, and it does not widen `/api/my/vehicles`. Recorded in `docs/spec/QUESTIONS-FOR-ROURKE.md`.

```sql
-- FR-AUT-005 with FR-INS-053: what a driver may read IN ORDER TO CAPTURE.
-- Deliberately not v_driver_vehicle, which is assignment alone and is what
-- /api/my/vehicles answers — widening that would change every caller. The
-- coupling chain is the justification: a driver responsible for the horse is
-- responsible for what it is pulling, and cannot inspect a rig they cannot
-- read.
CREATE VIEW app.v_capture_vehicle WITH (security_invoker = true) AS
SELECT dv.vehicle_id
  FROM app.v_driver_vehicle dv
UNION
SELECT cm.vehicle_id
  FROM app.v_driver_vehicle dv
  JOIN app.combination c
    ON c.motive_vehicle_id = dv.vehicle_id AND c.effective_to IS NULL
  JOIN app.combination_member cm ON cm.combination_id = c.id;
```

> `security_invoker = true` is not optional — `db/tests/004_tests.sql` fails the build on any view without it, because a view running as its owner returns every tenant's rows. Check the column name `v_driver_vehicle` actually exposes before writing the `UNION`; it selects `*` from `app.v_current_assignment`.

**Files:**
- Create: `db/migrations/000022_inspection_warning.up.sql`
- Create: `db/migrations/000022_inspection_warning.down.sql`
- Modify: `db/tests/004_tests.sql` (new section 30)

**Interfaces:**
- Produces: `app.inspection_warning (id, tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source, raised_at, created_at, created_by)`. Task 3 inserts into it; Task 5 never exposes it.
- Enum produced: `app.warning_source AS ENUM ('CLIENT','SERVER')`.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql` before the final banner:

```sql
\echo '== 30. Warning records are append-only, and a server-raised one has no response (DR-021, FR-INS-040)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '11111111-1111-1111-1111-111111111111';
  i_id uuid;
  w_id uuid;
  ok   boolean;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  SELECT id INTO i_id FROM app.inspection WHERE tenant_id = t_id LIMIT 1;

  -- a client-raised warning carries the driver's answer
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, response, source)
  VALUES (t_id, i_id, 'FR-INS-036', '3.2', 'ACKNOWLEDGED', 'CLIENT')
  RETURNING id INTO w_id;

  -- a server-raised refusal has nobody to answer it (DR-021: response nullable)
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, response, source)
  VALUES (t_id, i_id, 'DR-020', '999999', NULL, 'SERVER');

  ok := false;
  BEGIN
    UPDATE app.inspection_warning SET response = 'CHANGED' WHERE id = w_id;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a warning record was updatable'; END IF;

  ok := false;
  BEGIN
    DELETE FROM app.inspection_warning WHERE id = w_id;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a warning record was deletable'; END IF;

  RAISE NOTICE 'PASS  warning records are append-only and a server-raised one needs no response';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `make db-test`
Expected: FAIL — `relation "app.inspection_warning" does not exist`.

- [ ] **Step 3: Write the migration**

`db/migrations/000022_inspection_warning.up.sql`:

```sql
-- ============================================================================
--  inspection_warning — the record FR-INS-040 demands
--  Implements: DR-021 (errata E2), FR-INS-040
-- ============================================================================

-- Who raised it. A client warning is one the driver saw and answered; a
-- server one is a refusal reached after the device was gone, which is why
-- response is nullable below.
CREATE TYPE app.warning_source AS ENUM ('CLIENT','SERVER');

CREATE TABLE app.inspection_warning (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  inspection_id uuid NOT NULL,
  reading_id    uuid,                    -- NULL for an inspection-level warning
  warning_code  text NOT NULL,           -- the requirement ID that raised it
  entered_value text,                    -- what the driver typed, where a value was refused
  -- DR-020's refusal is reached when a queued submit finally lands, days after
  -- the driver put the phone away. FR-INS-040's "the user's response" cannot
  -- exist for it, so this is nullable rather than defaulted to a fiction.
  response      text,
  source        app.warning_source NOT NULL,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  created_by    uuid DEFAULT app.current_actor_id(),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES app.inspection (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reading_id)    REFERENCES app.reading (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by)    REFERENCES app.app_user (tenant_id, id)
);

CREATE INDEX warning_by_inspection ON app.inspection_warning (tenant_id, inspection_id);

CALL app.enable_tenant_rls('app.inspection_warning'::regclass);
GRANT SELECT, INSERT ON app.inspection_warning TO app_rw;

-- DR-021, and DR-014a's rule for every record of fact: the grant is the
-- enforcement, not a convention a later endpoint can talk its way past.
REVOKE UPDATE, DELETE ON app.inspection_warning FROM app_rw;
```

`db/migrations/000022_inspection_warning.down.sql`:

```sql
DROP TABLE IF EXISTS app.inspection_warning;
DROP TYPE IF EXISTS app.warning_source;
```

- [ ] **Step 4: Run the suite and verify it passes**

Run: `make db-test`
Expected: `PASS  warning records are append-only and a server-raised one needs no response`, then `ALL CHECKS PASSED`.

Note the suite already sweeps every table for RLS and every view for `security_invoker`; a new table that missed `enable_tenant_rls` fails those sweeps, not just this section.

- [ ] **Step 5: Run the tenant-isolation auditor**

This is a new table with new grants, so the project instruction applies: run the `rls-auditor` agent over `db/migrations/000022_inspection_warning.up.sql`. Expected: no cross-tenant finding — the composite `(tenant_id, …)` foreign keys and `enable_tenant_rls` are both present.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/000022_inspection_warning.up.sql \
        db/migrations/000022_inspection_warning.down.sql db/tests/004_tests.sql
git commit -m "feat(db): TYRE-66 DR-021 inspection_warning, append-only with a nullable response"
```

---

### Task 3: `app.submit_inspection` — the one write entry point

The heart of the phase. One call, one transaction, no partial vehicle.

**Files:**
- Create: `db/migrations/000023_submit_inspection.up.sql`
- Create: `db/migrations/000023_submit_inspection.down.sql`
- Modify: `db/tests/004_tests.sql` (new section 31)

**Interfaces:**
- Consumes: `TY001`/`TY002` from Task 1; `app.inspection_warning` from Task 2; `app.config_for`, `app.current_tenant_id()`, `app.current_actor_id()`.
- Produces: `app.submit_inspection(p_payload jsonb) RETURNS TABLE (inspection_id uuid, created boolean)`, and these SQLSTATEs, which Task 5 maps to HTTP status codes:

| SQLSTATE | Meaning | HTTP |
| --- | --- | --- |
| `TY003` | second inspection inside the FR-INS-038 window | `409` |
| `TY004` | position does not belong to that vehicle's configuration lineage | `422` |
| `TY005` | tread count disagrees with `tread_reading_count` | `422` |
| `TY006` | payload asserted `governing_tread_mm` | `422` |
| `TY010` | no tenant or actor bound | `500` — a bug, not a client error |

> **Decision — the coupling observation (D5, review finding F4).** FR-INS-062 has the driver confirm the attached units before starting and FR-INS-063 permits starting with a unit not previously associated, "recording the change of composition". §4.8.5 calls that selection "a dated coupling observation", but nothing in the spec says which component writes the new dated `combination` row. Taken here:
>
> **The payload carries `observed_member_vehicle_ids` — the units the driver confirmed, in rig order — and `combination_id`, the composition they were offered. The function does not create a combination.** Where the observed set differs from the named composition's members, it records one inspection-level warning with `warning_code = 'FR-INS-063'`, `source = 'SERVER'` and the observed set as `entered_value`. `combination_id` is null for a solo-unit inspection, and then the observed set is ignored.
>
> The reasoning is FR-OFF-016's, applied to the composition rather than the tyre: the observation is never lost and never blocks the inspection, but creating a dated `combination` is a fleet-state write that closes the previous composition's `effective_to`, and doing that on a queued submit that may arrive days late would rewrite coupling history from stale evidence. Combination management belongs with the unit-lifecycle surface (TYRE-55), and the warning row is what that surface later reconciles from. **Raise the follow-up ticket under TYRE-55 as part of this task** — an observation nothing ever reads is worse than the gap it filled.

**Implementing D5.** The decision above is not self-executing — write it. After the header INSERT and before the reading loop, inside `app.submit_inspection`:

```sql
-- FR-INS-063: the composition the driver confirmed, against the one they
-- were offered. Recorded, never enforced and never used to create a
-- combination: a queued submit can arrive days late, and writing fleet
-- state from stale evidence would rewrite coupling history. The
-- reconciliation surface is TYRE-55's.
IF v_combination IS NOT NULL AND jsonb_array_length(
     COALESCE(p_payload -> 'observed_member_vehicle_ids', '[]'::jsonb)) > 0 THEN
  IF EXISTS (
    SELECT 1
      FROM (SELECT jsonb_array_elements_text(p_payload -> 'observed_member_vehicle_ids')::uuid AS id) obs
      FULL JOIN app.combination_member cm
             ON cm.combination_id = v_combination AND cm.vehicle_id = obs.id
     WHERE obs.id IS NULL OR cm.vehicle_id IS NULL)
  THEN
    INSERT INTO app.inspection_warning (
      tenant_id, inspection_id, warning_code, entered_value, response, source)
    VALUES (v_tenant, v_insp, 'FR-INS-063',
            (p_payload ->> 'observed_member_vehicle_ids'), NULL, 'SERVER');
  END IF;
END IF;
```

Add a suite assertion: a submit whose observed set differs from the named composition leaves exactly one `FR-INS-063` warning and still returns `created = true`. Without this the web plan's stated FR-INS-063 story is false — the client sends the field and nothing reads it.

**The payload contract.** Task 5 builds exactly this shape; the web plan consumes it:

```json
{
  "client_uuid": "0f8f…",
  "vehicle_id": "…",
  "combination_id": null,
  "observed_member_vehicle_ids": [],
  "task_id": null,
  "started_at": "2026-08-25T06:12:00Z",
  "submitted_at": "2026-08-25T06:14:40Z",
  "odometer_km": 812430,
  "duration_seconds": 160,
  "completeness_pct": 100,
  "comment": null,
  "defect_report": null,
  "device_id": "…",
  "app_version": "…",
  "readings": [
    {
      "vehicle_id": "…",
      "position_id": "…",
      "tyre_id": "…",
      "pressure_kpa": 780,
      "pressure_temperature": "COLD",
      "damage_flag": false,
      "note": null,
      "treads": [7.4, 7.1, 6.9],
      "granularity_mm": 0.1,
      "seconds": 6,
      "warnings": [
        { "code": "FR-INS-036", "entered_value": "3.2", "response": "ACKNOWLEDGED" }
      ]
    }
  ],
  "warnings": []
}
```

> **The entry-order frame, settled from the SRS.** `treads` is in **entry order, left to right in the plan view** — the vehicle seen from above, nose up. That is FR-INS-029a verbatim ("presents reading fields left-to-right in the plan view") and the same spatial frame BR-VEH-001 numbers positions in, so the axle diagram and the three entry fields read in one direction and the training message is one sentence. Outer means away from the centreline (CHG-010), so a LEFT position maps ordinal 1 → `OUTER` and a RIGHT position maps ordinal 1 → `INNER`; getting it backwards silently swaps outer and inner on one whole side of every vehicle, and Step 1's test pins both sides.
>
> Do not restate this as "left to right as the driver stands at the tyre". A driver standing at a tyre faces it across the vehicle's fore-aft axis, so their left-to-right is not the width axis at all — the frame is the diagram, not the body. The Confluence prototype labels its three fields *Outer / Centre / Inner*, which FR-INS-029a forbids outright ("the driver never sees the words inner or outer"); the SRS governs and TYRE-69 relabels them.

- [ ] **Step 1: Write the failing test**

Append to `db/tests/004_tests.sql` before the final banner. This is long because the contract is: replay, the window, the lineage, both sides of the mapping, and the odometer containment each need pinning.

```sql
\echo '== 31. Submit is atomic, idempotent, and never loses an inspection to its odometer (FR-OFF-011, FR-INS-020/038, DR-020)'
BEGIN;
DO $$
DECLARE
  t_id   constant uuid := '11111111-1111-1111-1111-111111111111';
  v_id   uuid;
  drv    uuid;
  cu     uuid := gen_random_uuid();
  res    record;
  first  uuid;
  posl   uuid;
  posr   uuid;
  got    text;
  n      int;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  SELECT id INTO drv FROM app.app_user WHERE tenant_id = t_id AND role = 'DRIVER' AND active LIMIT 1;
  PERFORM set_config('app.actor_id', drv::text, true);

  SELECT v.id INTO v_id FROM app.vehicle v WHERE v.tenant_id = t_id ORDER BY v.fleet_number LIMIT 1;
  SELECT p.id INTO posl FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_id AND p.side = 'LEFT' AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO posr FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_id AND p.side = 'RIGHT' AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', cu, 'vehicle_id', v_id,
    'started_at', '2026-08-25T06:12:00Z', 'submitted_at', '2026-08-25T06:14:40Z',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                         'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)),
      jsonb_build_object('vehicle_id', v_id, 'position_id', posr,
                         'pressure_kpa', 790, 'treads', jsonb_build_array(6.5, 6.8, 7.2)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: a first submit reported created = false'; END IF;
  first := res.inspection_id;

  -- BR-INS-003 / DR-017: the MIN is the database's to derive, not the client's
  SELECT governing_tread_mm INTO n FROM app.reading WHERE inspection_id = first AND position_id = posl;
  IF n IS DISTINCT FROM 6.9 THEN RAISE EXCEPTION 'FAIL: governing tread was % not 6.9', n; END IF;

  -- FR-INS-029a: entry order is left-to-right in the plan view, and OUTER is
  -- away from the centreline, so the two sides map in opposite directions
  SELECT position::text INTO got FROM app.reading_measurement m
    JOIN app.reading r ON r.id = m.reading_id
   WHERE r.inspection_id = first AND r.position_id = posl AND m.ordinal = 1;
  IF got <> 'OUTER' THEN RAISE EXCEPTION 'FAIL: left ordinal 1 mapped to % not OUTER', got; END IF;
  SELECT position::text INTO got FROM app.reading_measurement m
    JOIN app.reading r ON r.id = m.reading_id
   WHERE r.inspection_id = first AND r.position_id = posr AND m.ordinal = 1;
  IF got <> 'INNER' THEN RAISE EXCEPTION 'FAIL: right ordinal 1 mapped to % not INNER', got; END IF;

  -- FR-OFF-011: a replay resolves to the same record and writes nothing
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', cu, 'vehicle_id', v_id,
    'started_at', '2026-08-25T06:12:00Z', 'submitted_at', '2026-08-25T06:14:40Z',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                         'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)))));
  IF res.created OR res.inspection_id <> first THEN
    RAISE EXCEPTION 'FAIL: a replay was not a no-op resolving to the same inspection';
  END IF;
  SELECT count(*) INTO n FROM app.reading WHERE inspection_id = first;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: a replay changed the reading count to %', n; END IF;

  -- FR-INS-038: a genuine second inspection inside the window is refused,
  -- which a replay above must NOT have been
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_id,
      'started_at', '2026-08-25T06:20:00Z', 'submitted_at', '2026-08-25T06:22:00Z',
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                           'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)))));
  EXCEPTION WHEN SQLSTATE 'TY003' THEN got := 'TY003';
  END;
  IF got IS DISTINCT FROM 'TY003' THEN
    RAISE EXCEPTION 'FAIL: a second inspection inside the window was not refused (got %)', COALESCE(got, 'no error');
  END IF;

  -- FR-INS-020 + DR-020: the timeline refuses the number, the inspection lives
  INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
  VALUES (t_id, v_id, DATE '2026-08-20', 900000, 'MANUAL');

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_id,
    'started_at', '2026-08-26T06:12:00Z', 'submitted_at', '2026-08-26T06:14:40Z',
    'odometer_km', 100,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                         'pressure_kpa', 780, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: a backwards odometer cost us the inspection'; END IF;

  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND warning_code = 'DR-020' AND source = 'SERVER'
     AND entered_value = '100' AND response IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the refused odometer left % warning records, not 1', n; END IF;

  SELECT count(*) INTO n FROM app.vehicle_odometer_reading
   WHERE vehicle_id = v_id AND odometer_km = 100;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: an implausible odometer reached the timeline'; END IF;

  RAISE NOTICE 'PASS  submit is atomic and idempotent, the window holds, and a refused odometer costs a warning not an inspection';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run it and verify it fails**

Run: `make db-test`
Expected: FAIL — `function app.submit_inspection(jsonb) does not exist`.

- [ ] **Step 3: Write the migration**

`db/migrations/000023_submit_inspection.up.sql`:

```sql
-- ============================================================================
--  submit_inspection — the platform's only write path for captured readings
--  Implements: FR-INS-020..041, FR-INS-060..065, FR-OFF-011, FR-OFF-016,
--              BR-INS-003, BR-VEH-003, DR-015..021, FR-VEH-016
-- ============================================================================

-- Invoker rights, deliberately: the suite allows exactly one SECURITY DEFINER
-- routine in this schema and this is not it. Everything below is written by
-- the calling driver, under their own tenant's policies.
CREATE FUNCTION app.submit_inspection(p_payload jsonb)
RETURNS TABLE (inspection_id uuid, created boolean)
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant  uuid := app.current_tenant_id();
  v_actor   uuid := app.current_actor_id();
  v_cu      uuid := (p_payload ->> 'client_uuid')::uuid;
  v_vehicle uuid := (p_payload ->> 'vehicle_id')::uuid;
  v_task    uuid := (p_payload ->> 'task_id')::uuid;
  v_insp    uuid;
  v_found   uuid;
  v_reading uuid;
  v_hours   int;
  v_want    int;
  v_side    app.side;
  v_spare   boolean;
  v_fitted  uuid;
  v_odo     bigint;
  v_ord     int;
  v_n       int;
  r         jsonb;
  w         jsonb;
  t         jsonb;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'submit_inspection called with no tenant or actor bound'
      USING ERRCODE = 'TY010';
  END IF;

  -- FR-OFF-011. A lookup, never an upsert: readings are append-only, so a
  -- replay that "corrected" the first submit would be an edit by another name.
  SELECT i.id INTO v_found FROM app.inspection i
   WHERE i.tenant_id = v_tenant AND i.client_uuid = v_cu;
  IF FOUND THEN
    inspection_id := v_found; created := false; RETURN NEXT; RETURN;
  END IF;

  -- FR-INS-038, per UNIT rather than per rig, so a superlink's member units
  -- are each protected. Reached only past the replay check above: resubmitting
  -- one capture is not a second inspection and must never trip this.
  v_hours := (app.config_for(v_tenant, 'duplicate_inspection_min_hours', now()) #>> '{}')::int;
  IF v_hours IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.reading rd
      JOIN app.inspection i ON i.id = rd.inspection_id
     WHERE rd.tenant_id = v_tenant
       AND i.state <> 'VOIDED'
       AND i.submitted_at > now() - make_interval(hours => v_hours)
       AND rd.vehicle_id IN (
             SELECT DISTINCT (e ->> 'vehicle_id')::uuid
               FROM jsonb_array_elements(p_payload -> 'readings') e))
  THEN
    RAISE EXCEPTION 'a unit in this submit was already inspected within % hours', v_hours
      USING ERRCODE = 'TY003';
  END IF;

  INSERT INTO app.inspection (
    tenant_id, vehicle_id, combination_id, user_id, client_uuid,
    started_at, submitted_at, odometer, duration_seconds,
    comment, defect_report, device_id, app_version, completeness_pct, state)
  VALUES (
    v_tenant, v_vehicle, (p_payload ->> 'combination_id')::uuid, v_actor, v_cu,
    (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'submitted_at')::timestamptz,
    (p_payload ->> 'odometer_km')::bigint, (p_payload ->> 'duration_seconds')::int,
    p_payload ->> 'comment', p_payload ->> 'defect_report',
    p_payload ->> 'device_id', p_payload ->> 'app_version',
    COALESCE((p_payload ->> 'completeness_pct')::numeric, 100), 'SYNCED')
  RETURNING id INTO v_insp;

  v_want := (app.config_for(v_tenant, 'tread_reading_count', now()) #>> '{}')::int;

  FOR r IN SELECT * FROM jsonb_array_elements(p_payload -> 'readings') LOOP
    IF r ? 'governing_tread_mm' THEN
      -- CR-011/DR-017: the MIN is derived. Refusing rather than ignoring the
      -- field is what stops a client believing it was honoured.
      RAISE EXCEPTION 'governing_tread_mm is derived and must not be submitted'
        USING ERRCODE = 'TY006';
    END IF;

    -- FR-VEH-016 versions configurations so amending one does not alter the
    -- position meaning of historical inspections. A completed capture can wait
    -- days in the outbox, so validate against the whole lineage: refusing it
    -- because an admin revised the configuration meanwhile would throw away a
    -- finished walk-around, which is the adoption wound ADR-0009 exists to
    -- prevent.
    SELECT p.side, p.is_spare INTO v_side, v_spare
      FROM app.position p
      JOIN app.axle_configuration ac ON ac.id = p.configuration_id
     WHERE p.id = (r ->> 'position_id')::uuid
       AND p.tenant_id = v_tenant
       AND (ac.tenant_id, ac.code) = (
             SELECT a2.tenant_id, a2.code
               FROM app.vehicle v JOIN app.axle_configuration a2 ON a2.id = v.configuration_id
              WHERE v.id = (r ->> 'vehicle_id')::uuid AND v.tenant_id = v_tenant);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'position % is not on any version of vehicle %''s configuration',
        r ->> 'position_id', r ->> 'vehicle_id' USING ERRCODE = 'TY004';
    END IF;

    SELECT jsonb_array_length(r -> 'treads') INTO v_n;
    IF v_want IS NOT NULL AND v_n <> v_want THEN
      RAISE EXCEPTION 'position % carried % tread readings, the tenant configures %',
        r ->> 'position_id', v_n, v_want USING ERRCODE = 'TY005';
    END IF;

    INSERT INTO app.reading (
      tenant_id, inspection_id, vehicle_id, position_id, tyre_id,
      pressure_kpa, pressure_temperature, damage_flag, damage_type,
      wear_pattern, note, source)
    VALUES (
      v_tenant, v_insp, (r ->> 'vehicle_id')::uuid, (r ->> 'position_id')::uuid,
      (r ->> 'tyre_id')::uuid, (r ->> 'pressure_kpa')::int,
      COALESCE((r ->> 'pressure_temperature')::app.temperature_state, 'UNKNOWN'),
      COALESCE((r ->> 'damage_flag')::boolean, false),
      r ->> 'damage_type', r ->> 'wear_pattern', r ->> 'note', 'MANUAL')
    RETURNING id INTO v_reading;

    -- FR-OFF-016: fitment can move between capture and submit. The driver's
    -- eyes are the record of what was on the vehicle, so accept and flag —
    -- rejecting the inspection is the one response the requirement forbids.
    IF (r ->> 'tyre_id') IS NOT NULL THEN
      SELECT f.tyre_id INTO v_fitted FROM app.fitment f
       WHERE f.tenant_id = v_tenant
         AND f.vehicle_id = (r ->> 'vehicle_id')::uuid
         AND f.position_id = (r ->> 'position_id')::uuid
         AND f.removed_at IS NULL
       LIMIT 1;
      IF FOUND AND v_fitted IS DISTINCT FROM (r ->> 'tyre_id')::uuid THEN
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, v_reading, 'FR-OFF-016', (r ->> 'tyre_id'), NULL, 'SERVER');
      END IF;
    END IF;

    -- FR-INS-029a. The driver enters left to right in the plan view — the
    -- frame BR-VEH-001 numbers positions in — and never sees these words;
    -- OUTER is away from the centreline (CHG-010), so the order reverses
    -- between sides. A spare has no vehicle-relative geometry,
    -- so its orientation is recorded as unknown rather than invented — such
    -- rows still count toward MIN but are excluded from directional diagnosis.
    v_ord := 0;
    FOR t IN SELECT * FROM jsonb_array_elements(r -> 'treads') LOOP
      v_ord := v_ord + 1;
      INSERT INTO app.reading_measurement (
        tenant_id, reading_id, ordinal, tread_mm, position, orientation_known, granularity_mm)
      VALUES (
        v_tenant, v_reading, v_ord, (t #>> '{}')::numeric,
        CASE
          WHEN v_n = 1 THEN 'CENTRE'::app.tread_position
          WHEN v_side = 'RIGHT' THEN (ARRAY['INNER','CENTRE','OUTER']::app.tread_position[])[v_ord]
          ELSE (ARRAY['OUTER','CENTRE','INNER']::app.tread_position[])[v_ord]
        END,
        NOT v_spare,
        COALESCE((r ->> 'granularity_mm')::numeric, 1.0));
    END LOOP;

    FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(r -> 'warnings', '[]'::jsonb)) LOOP
      INSERT INTO app.inspection_warning (
        tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
      VALUES (v_tenant, v_insp, v_reading, w ->> 'code', w ->> 'entered_value',
              w ->> 'response', 'CLIENT');
    END LOOP;
  END LOOP;

  -- DR-016's contiguity guard is DEFERRABLE INITIALLY DEFERRED, so left alone
  -- it fires at COMMIT — after the handler has returned, where the API can
  -- only call it a 500. Forcing it here makes a malformed position a refusal
  -- the client can act on.
  SET CONSTRAINTS ALL IMMEDIATE;

  FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload -> 'warnings', '[]'::jsonb)) LOOP
    INSERT INTO app.inspection_warning (
      tenant_id, inspection_id, warning_code, entered_value, response, source)
    VALUES (v_tenant, v_insp, w ->> 'code', w ->> 'entered_value', w ->> 'response', 'CLIENT');
  END LOOP;

  -- FR-INS-020: the odometer never blocks the inspection, and FR-INS-064 puts
  -- only the motive unit's reading on a timeline. DR-020 still refuses a value
  -- that would corrupt the vehicle's rates, and DR-018 makes that refusal the
  -- only safe answer — the timeline is append-only, so an accepted implausible
  -- reading is permanent. Containing it here is what lets both hold at once.
  --
  -- Only the timeline's own SQLSTATEs are trapped. A generic WHEN OTHERS would
  -- turn an FK violation or a serialisation failure into a quiet "warning".
  v_odo := (p_payload ->> 'odometer_km')::bigint;
  IF v_odo IS NOT NULL THEN
    BEGIN
      INSERT INTO app.vehicle_odometer_reading (
        tenant_id, vehicle_id, reading_date, odometer_km, source, inspection_id)
      VALUES (
        v_tenant, v_vehicle,
        ((p_payload ->> 'submitted_at')::timestamptz AT TIME ZONE 'UTC')::date,
        v_odo, 'INSPECTION', v_insp);
    EXCEPTION
      WHEN SQLSTATE 'TY001' OR SQLSTATE 'TY002' OR unique_violation THEN
        -- FR-OFF-014's standard: the number is not discarded. A controller who
        -- checks it against the fuel records can re-enter it (FR-IMP-015).
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, 'DR-020', v_odo::text, NULL, 'SERVER');
    END;
  END IF;

  -- FR-INS-052: a completed task cites the inspection that completed it. The
  -- driver launched from a specific task (FR-INS-048 shows them) and a unit can
  -- carry several at once (FR-INS-051), so the payload names which. Absent one,
  -- close nothing rather than guess at the driver's intent.
  IF v_task IS NOT NULL THEN
    UPDATE app.inspection_task
       SET state = 'COMPLETED', completed_inspection_id = v_insp
     WHERE tenant_id = v_tenant AND id = v_task AND state IN ('OPEN','ESCALATED');
  END IF;

  inspection_id := v_insp; created := true; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION app.submit_inspection(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_inspection(jsonb) TO app_rw;
```

`db/migrations/000023_submit_inspection.down.sql`:

```sql
DROP FUNCTION IF EXISTS app.submit_inspection(jsonb);
```

- [ ] **Step 4: Run the suite and verify it passes**

Run: `make db-test`
Expected: `PASS  submit is atomic and idempotent, the window holds, and a refused odometer costs a warning not an inspection`, then `ALL CHECKS PASSED`.

The `SECURITY DEFINER` sweep must still pass — if it names `submit_inspection`, the `SECURITY INVOKER` default was overridden somewhere and must be removed rather than allowlisted.

- [ ] **Step 5: Confirm the Appendix E and J pins are untouched**

The submit path fires `refresh_governing_tread` and `snapshot_on_governing_change`, so it writes valuation snapshots. The suite's fifteen Appendix E valuations and the 19/11/9 Appendix J exception sets must be unchanged — every new probe rolls back, so a drift here means a probe escaped its transaction.

Run: `make db-test 2>&1 | grep -iE "appendix|valuation|exception"`
Expected: the same PASS lines as before this task.

- [ ] **Step 6: Run the tenant-isolation auditor**

New function, new grants, and it writes to five tables. Run the `rls-auditor` agent over `db/migrations/000023_submit_inspection.up.sql`. Expected: no finding — the function is `SECURITY INVOKER`, every insert carries `tenant_id = app.current_tenant_id()`, and the position lookup is tenant-qualified on both sides.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/000023_submit_inspection.up.sql \
        db/migrations/000023_submit_inspection.down.sql db/tests/004_tests.sql
git commit -m "feat(db): TYRE-66 app.submit_inspection, the one write path for captured readings"
```

---

### Task 4: `GET /api/capture/vehicles/{id}` — the reference surface (TYRE-71)

FR-OFF-001 lets a driver finish and submit with no connectivity "at any point after reference data is loaded". Everything a capture needs must therefore arrive in one round trip, before the driver walks up to the vehicle. FR-OFF-002 as amended by E2 enumerates nine things; this serves the per-vehicle ones.

**Serve all of them, not the easy ones.** Three of the nine exist in FR-OFF-002 precisely because FR-INS-034 and FR-INS-035 cannot evaluate without them once the signal goes, and a payload that omits them turns two Musts inside Appendix H.1 into a silent scope cut:

| FR-OFF-002 item | Field | Warning it feeds |
| --- | --- | --- |
| each position's previous governing reading | `previousGoverningMm`, `previousReadingAt` | FR-INS-034 |
| …with fitment events since | `fitmentSincePrevious` | FR-INS-034's unless-clause (BR-INS-001) |
| fleet average wear rate per position class, cohorted per BR-ANL-009, with the configured multiple | `cohortWearRateMmPerMonth`, `config.wearRateAlertMultiple` | FR-INS-035 |
| targets | per-position `targetKpa` and the four tolerance percentages | FR-INS-037, FR-INS-031a |

**The target does not come from tenant configuration.** Migration `000013` deleted the `target_pressure_kpa`, `inflation_bands` and `pressure_deviation_margin_pct` keys outright (CHG-112) and moved targets to `app.target_pressure`, resolved per `(size_id, axle_class)` with warn/critical tolerances in both directions. Reading the retired key would return null and disable both pressure warnings silently, which is why the target fields sit on each position rather than in the config blob.

> **Decision — FR-INS-031a's confirmation margin (D4).** FR-CFG-025 specifies a pressure deviation margin defaulting to 25%, and CHG-112 retired the key that held it without saying what replaces it. Taken here: **the resolved row's `critical_under_pct` / `critical_over_pct` is the FR-INS-031a confirmation threshold, and `warn_under_pct` / `warn_over_pct` is FR-INS-037's band edge.** That keeps one source for both rules and honours CHG-112 as the later deliberate decision, at the cost of moving the confirmation point from 25% to the seeded 20%. It is a conflict between FR-CFG-025 and CHG-112, not a free choice — record it in `docs/open-issues.md` as D4 and let the sponsor move the seeded percentages if 25% was meant literally. Do not reintroduce the retired key, and do not hard-code 25.

**Files:**
- Create: `api/internal/httpapi/capture.go`
- Create: `api/internal/httpapi/capture_test.go`
- Modify: `api/internal/httpapi/httpapi.go` (route registration only)
- Modify: `docs/open-issues.md` (record D4)

**Interfaces:**
- Consumes: `store.InActorTx`, `withActor`, `require`, `writeJSON`, `auth.CaptureInspection`, `auth.ScopeTenant` — all already present; `app.wear_rate_mm_per_month(uuid)` from migration `000013`; `app.target_pressure` from `000012`.
- Produces: `httpapi.captureContext(s *store.Store) http.HandlerFunc`, and the JSON shape the web plan's reference loader consumes.

- [ ] **Step 1: Write the failing test**

Create `api/internal/httpapi/capture_test.go`:

```go
package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

func TestCaptureContextIsCapabilityGatedAndCarriesNoMoney(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID := plantTenant(t, ctx, admin, "capture")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusOK},
		{auth.RoleTechnician, http.StatusForbidden},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/capture/vehicles/"+vehicleID.String(), tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())

			if tt.want != http.StatusOK {
				return
			}
			// FR-AUT-005a: a DRIVER does not hold ViewValuation, and the
			// control is the projection, not the client omitting a field.
			var body map[string]any
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			raw := rec.Body.String()
			for _, banned := range []string{"randPerMm", "casingValue", "treadValue", "purchasePrice"} {
				require.NotContains(t, raw, banned, "a monetary field reached the capture payload")
			}
			require.NotEmpty(t, body["positions"], "capture cannot proceed without positions")

			// FR-INS-062: the rig the controller set, for the driver to
			// confirm. The fixture's comb1 is horse + 6m + 12m.
			if tt.role == auth.RoleDriver {
				require.NotNil(t, body["combination"], "a rig's motive unit served no composition")
			}

			// The hole v_capture_vehicle exists to close, pinned as its own
			// case: driver1 holds veh1 and veh3, their veh2 assignment ended
			// in 2024, and all three are members of comb1. Before the view,
			// this 403s and a superlink cannot be inspected.
			for _, m := range body["combination"].(map[string]any)["members"].([]any) {
				member := m.(map[string]any)["vehicleId"].(string)
				rec := get(t, h, "/api/capture/vehicles/"+member, tenantID.String(), userID.String())
				require.Equal(t, http.StatusOK, rec.Code,
					"a driver could not read a member unit of their own rig: "+member)
			}
			require.NotNil(t, body["config"], "capture cannot evaluate warnings without thresholds")

			// FR-OFF-002 as amended by E2. Each of these is the sole input to
			// a Must inside Appendix H.1, and each is unreachable once
			// FR-OFF-001 takes the signal away — so an absent field is a
			// warning that silently never fires, not a cosmetic gap.
			cfg, ok := body["config"].(map[string]any)
			require.True(t, ok)
			require.NotNil(t, cfg["wearRateAlertMultiple"], "FR-INS-035 has no multiple")
			require.NotNil(t, cfg["removalThresholdMm"], "FR-INS-036 has no threshold")
			require.NotNil(t, cfg["widthSpreadWarnMm"], "FR-INS-041 has no margin")
			require.NotNil(t, cfg["odometerMaxDailyKm"], "FR-INS-033 has no ceiling")
			require.NotNil(t, body["cohortWearRateMmPerMonth"], "FR-INS-035 has no denominator")

			// A running position must carry a resolvable target; a spare must
			// not (FR-CFG-013 as amended — a spare's pressure is recorded and
			// deliberately unclassified, and a zero would be a claim).
			var sawRunningTarget bool
			for _, raw := range body["positions"].([]any) {
				pos := raw.(map[string]any)
				_, hasPrev := pos["previousGoverningMm"]
				require.True(t, hasPrev, "FR-INS-034 has no previous reading to compare against")
				_, hasFit := pos["fitmentSincePrevious"]
				require.True(t, hasFit, "FR-INS-034 cannot excuse an increase without fitment state")
				if pos["isSpare"] == true {
					require.Nil(t, pos["targetKpa"], "a spare was given a pressure target")
					continue
				}
				if pos["targetKpa"] != nil {
					sawRunningTarget = true
					require.NotNil(t, pos["warnUnderPct"], "FR-INS-037 has no band edge")
					require.NotNil(t, pos["criticalOverPct"], "FR-INS-031a has no confirmation point")
				}
			}
			require.True(t, sawRunningTarget,
				"no running position resolved a target — app.target_pressure is seeded by 000013, "+
					"so this means the resolution join is wrong, not that the tenant has no targets")
		})
	}
}
```

`plantTenant` currently returns `(uuid.UUID, ...)` — check its signature in `httpapi_test.go` and extend it to also return a vehicle id if it does not already, following its existing style.

- [ ] **Step 2: Run it and verify it fails**

Run: `make api-test`
Expected: FAIL — 404 for every role, because the route does not exist.

- [ ] **Step 3: Write the handler**

Create `api/internal/httpapi/capture.go`:

```go
package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

// The capture context is everything FR-OFF-002 requires on the device before
// FR-OFF-001 takes connectivity away. It is one round trip on purpose: a
// driver on a depot forecourt gets one good moment of signal.
type capturePosition struct {
	ID        uuid.UUID  `json:"id"`
	VehicleID uuid.UUID  `json:"vehicleId"`
	Code      string     `json:"code"`
	Sequence  int        `json:"sequence"`
	AxleClass string     `json:"axleClass"`
	AxleType  string     `json:"axleType"`
	// The diagram groups running positions by (vehicle, axle) to draw one row
	// per axle. Position codes are flat in the fixture, so there is nothing to
	// parse out of them. Null on a spare, which has no axle geometry.
	AxleNumber *int      `json:"axleNumber"`
	IsSpare   bool       `json:"isSpare"`
	UnitLabel *string    `json:"unitLabel"`
	TyreID    *uuid.UUID `json:"tyreId"`
	TyreCode  *string    `json:"tyreCode"`

	// FR-INS-034 evaluates offline against this position's own history, so
	// both halves of the rule travel: the previous governing value and
	// whether a fitment since then explains an increase (BR-INS-001).
	PreviousMm           *float64   `json:"previousGoverningMm"`
	PreviousAt           *time.Time `json:"previousReadingAt"`
	FitmentSincePrevious bool       `json:"fitmentSincePrevious"`

	// FR-INS-037 and FR-INS-031a both need the position's own resolved
	// target, not a tenant scalar. Null for a spare: FR-CFG-013 as amended
	// gives SPARE no target, and a recorded-but-unclassified spare pressure
	// is deliberate (BR-RPT-001, NFR-PRO-003) — never a zero.
	TargetKpa        *int     `json:"targetKpa"`
	WarnUnderPct     *float64 `json:"warnUnderPct"`
	CriticalUnderPct *float64 `json:"criticalUnderPct"`
	WarnOverPct      *float64 `json:"warnOverPct"`
	CriticalOverPct  *float64 `json:"criticalOverPct"`
}

// FR-INS-062: the composition a CONTROLLER set, for the driver to confirm.
// Managing it is a controller surface and not part of this phase — the
// driver confirms or reports a difference, never edits the fleet's record
// of what is coupled to what.
type captureMember struct {
	VehicleID   uuid.UUID `json:"vehicleId"`
	FleetNumber string    `json:"fleetNumber"`
	Sequence    int       `json:"sequence"`
	Descriptor  *string   `json:"descriptor"`
}

type captureCombination struct {
	ID      uuid.UUID       `json:"id"`
	Members []captureMember `json:"members"`
}

type captureContextBody struct {
	VehicleID      uuid.UUID         `json:"vehicleId"`
	FleetNumber    string            `json:"fleetNumber"`
	Registration   *string           `json:"registration"`
	LastOdometerKm *int64            `json:"lastOdometerKm"`
	// FR-INS-033 divides by the gap since this date. Serving the value
	// without it leaves the plausibility warning with no denominator.
	LastOdometerAt *time.Time       `json:"lastOdometerAt"`
	Positions      []capturePosition `json:"positions"`
	// Null unless this vehicle heads a current combination. A trailer asked
	// for its own context gets null and is captured as a solo unit, which is
	// correct: the rig is entered through its motive unit.
	Combination    *captureCombination `json:"combination"`
	Config         map[string]any    `json:"config"`

	// FR-INS-035's denominator, cohorted per BR-ANL-006 (position class) and
	// BR-ANL-009 (never blend axle types). Keyed "AXLE_CLASS:AXLE_TYPE" so
	// the client looks up by the two fields each position already carries.
	// A map rather than a field per position: at most a dozen entries for a
	// whole tenant, against 26 repetitions of the same number on a rig
	// (NFR-CST-010, the driver's own airtime).
	CohortWearRateMmPerMonth map[string]float64 `json:"cohortWearRateMmPerMonth"`
}

func captureContext(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		vehicleID, err := uuid.Parse(chi.URLParam(r, "vehicleID"))
		if err != nil {
			http.Error(w, "bad vehicle id", http.StatusBadRequest)
			return
		}
		var body captureContextBody
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			return loadCaptureContext(r.Context(), tx, a, vehicleID, &body)
		})
		if !ok {
			return
		}
		writeJSON(r.Context(), w, body)
	}
}
```

Then `loadCaptureContext` runs four queries on the transaction — the vehicle header, the positions, the cohort wear rates, and the tenant configuration. Compose it from the existing scope views so a driver reads only assigned units:

```go
func loadCaptureContext(ctx context.Context, tx pgx.Tx, a auth.Actor, vehicleID uuid.UUID, out *captureContextBody) error {
	// ADR-0006: the scope predicate lives in SQL and the handler composes the
	// matching view, exactly as listVehicles and listMyVehicles already do. A
	// DRIVER reaches only currently assigned units (FR-AUT-005); a
	// tenant-scoped role reads the register. Refusing through an empty result
	// is what keeps "you may not see this" and "this does not exist"
	// indistinguishable (ADR-0011).
	from := `app.vehicle v`
	if a.Scope() != auth.ScopeTenant {
		// v_capture_vehicle, not v_driver_vehicle: a driver must reach the
		// trailers of a rig they are responsible for, or a superlink cannot
		// be inspected at all (migration 000022).
		from = `app.v_capture_vehicle cv JOIN app.vehicle v ON v.id = cv.vehicle_id`
	}
	err := tx.QueryRow(ctx, `
		SELECT v.id, v.fleet_number, v.registration, o.odometer_km, o.reading_date
		  FROM `+from+`
		  LEFT JOIN LATERAL (
		       SELECT vo.odometer_km, vo.reading_date
		         FROM app.vehicle_odometer_reading vo
		        WHERE vo.vehicle_id = v.id
		        ORDER BY vo.reading_date DESC LIMIT 1) o ON true
		 WHERE v.id = $1`, vehicleID).
		Scan(&out.VehicleID, &out.FleetNumber, &out.Registration, &out.LastOdometerKm, &out.LastOdometerAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return errForbidden
	}
	if err != nil {
		return fmt.Errorf("loading capture vehicle: %w", err)
	}

	// One row per position, carrying everything the phone needs to identify
	// the tyre (FR-INS-026) and to evaluate FR-INS-034/037/031a with no
	// signal. Target resolution is most-specific-wins — a row naming both
	// size and axle class beats one naming only the class — which is the
	// order app.inflation_compliance already resolves in; keep them agreeing.
	rows, err := tx.Query(ctx, `
		SELECT p.id, v.id, p.code, p.sequence, p.axle_class::text, p.axle_type::text,
		       p.axle_number, p.is_spare, p.unit_label, f.tyre_id, t.display_code,
		       prev.governing_tread_mm, prev.submitted_at,
		       EXISTS (SELECT 1 FROM app.fitment fx
		                WHERE fx.position_id = p.id AND fx.vehicle_id = v.id
		                  AND prev.submitted_at IS NOT NULL
		                  AND (fx.fitted_at > prev.submitted_at
		                       OR (fx.removed_at IS NOT NULL AND fx.removed_at > prev.submitted_at))),
		       tgt.target_kpa, tgt.warn_under_pct, tgt.critical_under_pct,
		       tgt.warn_over_pct, tgt.critical_over_pct
		  FROM app.vehicle v
		  JOIN app.position p ON p.configuration_id = v.configuration_id
		  LEFT JOIN app.fitment f
		         ON f.position_id = p.id AND f.vehicle_id = v.id AND f.removed_at IS NULL
		  LEFT JOIN app.tyre t ON t.id = f.tyre_id
		  LEFT JOIN LATERAL (
		       SELECT r.governing_tread_mm, i.submitted_at
		         FROM app.reading r
		         JOIN app.inspection i ON i.id = r.inspection_id
		        WHERE r.position_id = p.id AND r.vehicle_id = v.id AND i.state <> 'VOIDED'
		        ORDER BY i.submitted_at DESC LIMIT 1) prev ON true
		  LEFT JOIN LATERAL (
		       SELECT tp.target_kpa, tp.warn_under_pct, tp.critical_under_pct,
		              tp.warn_over_pct, tp.critical_over_pct
		         FROM app.target_pressure tp
		        WHERE tp.tenant_id = v.tenant_id
		          AND tp.effective_from <= now()
		          AND p.axle_class <> 'SPARE'
		          AND (tp.axle_class IS NULL OR tp.axle_class = p.axle_class)
		          AND (tp.size_id   IS NULL OR tp.size_id   = t.size_id)
		        ORDER BY (tp.size_id IS NOT NULL) DESC,
		                 (tp.axle_class IS NOT NULL) DESC,
		                 tp.effective_from DESC
		        LIMIT 1) tgt ON true
		 WHERE v.id = $1
		 ORDER BY p.sequence`, vehicleID)
	if err != nil {
		return fmt.Errorf("loading capture positions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p capturePosition
		if err := rows.Scan(&p.ID, &p.VehicleID, &p.Code, &p.Sequence, &p.AxleClass,
			&p.AxleType, &p.AxleNumber, &p.IsSpare, &p.UnitLabel, &p.TyreID, &p.TyreCode,
			&p.PreviousMm, &p.PreviousAt, &p.FitmentSincePrevious,
			&p.TargetKpa, &p.WarnUnderPct, &p.CriticalUnderPct,
			&p.WarnOverPct, &p.CriticalOverPct); err != nil {
			return fmt.Errorf("scanning capture position: %w", err)
		}
		out.Positions = append(out.Positions, p)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("reading capture positions: %w", err)
	}

	// FR-INS-035's fleet average, over app.wear_rate_mm_per_month so the
	// regression rule (BR-ANL-001) keeps exactly one implementation. Spares
	// are excluded (BR-RPT-007 judges them on age, not wear) and LIFTING
	// axles assert no rate at all (BR-ANL-009) rather than a flatteringly low
	// one — a raised axle is not touching the road.
	out.CohortWearRateMmPerMonth = map[string]float64{}
	crows, err := tx.Query(ctx, `
		SELECT p.axle_class::text || ':' || p.axle_type::text, avg(w.rate_mm_per_month)
		  FROM app.fitment f
		  JOIN app.position p ON p.id = f.position_id
		  CROSS JOIN LATERAL app.wear_rate_mm_per_month(f.tyre_id) w
		 WHERE f.removed_at IS NULL
		   AND NOT p.is_spare
		   AND p.axle_type <> 'LIFTING'
		   AND w.rate_mm_per_month IS NOT NULL
		 GROUP BY p.axle_class, p.axle_type`)
	if err != nil {
		return fmt.Errorf("loading cohort wear rates: %w", err)
	}
	defer crows.Close()
	for crows.Next() {
		var key string
		var rate float64
		if err := crows.Scan(&key, &rate); err != nil {
			return fmt.Errorf("scanning cohort wear rate: %w", err)
		}
		out.CohortWearRateMmPerMonth[key] = rate
	}
	if err := crows.Err(); err != nil {
		return fmt.Errorf("reading cohort wear rates: %w", err)
	}

	// FR-INS-062's composition, for the driver to confirm before starting.
	// Ordered by member sequence, which with each unit's own position
	// sequence is all FR-VEH-034 needs to compute the rig's 1..n at render
	// time — nothing about that numbering is stored here or anywhere.
	var combo captureCombination
	crows, err := tx.Query(ctx, `
		SELECT c.id, cm.vehicle_id, mv.fleet_number, cm.sequence, cm.descriptor
		  FROM app.combination c
		  JOIN app.combination_member cm ON cm.combination_id = c.id
		  JOIN app.vehicle mv ON mv.id = cm.vehicle_id
		 WHERE c.motive_vehicle_id = $1 AND c.effective_to IS NULL
		 ORDER BY cm.sequence`, vehicleID)
	if err != nil {
		return fmt.Errorf("loading combination: %w", err)
	}
	defer crows.Close()
	for crows.Next() {
		var m captureMember
		if err := crows.Scan(&combo.ID, &m.VehicleID, &m.FleetNumber, &m.Sequence, &m.Descriptor); err != nil {
			return fmt.Errorf("scanning combination member: %w", err)
		}
		combo.Members = append(combo.Members, m)
	}
	if err := crows.Err(); err != nil {
		return fmt.Errorf("reading combination: %w", err)
	}
	if len(combo.Members) > 0 {
		out.Combination = &combo
	}

	// Every threshold the client evaluates against, read through the same
	// tenant-configuration accessor the database uses. Rule 5: none of these
	// may become a literal on the device.
	return tx.QueryRow(ctx, `
		SELECT jsonb_build_object(
		         'treadReadingCount',     app.config_for($1, 'tread_reading_count',      now()),
		         'treadGranularityMm',    app.config_for($1, 'tread_capture_granularity_mm', now()),
		         'widthSpreadWarnMm',     app.config_for($1, 'width_spread_warn_mm',     now()),
		         'odometerMaxDailyKm',    app.config_for($1, 'odometer_max_daily_km',    now()),
		         'wearRateAlertMultiple', app.config_for($1, 'wear_rate_alert_multiple', now()),
		         'removalThresholdMm',    app.removal_threshold_mm_for($1, now()))`,
		a.TenantID).Scan(&out.Config)
}
```

Add `"errors"`, `"fmt"` and `"time"` to the import block; the skeleton above lists only what the handler body itself names.

> **The cohort query runs one regression per fitted tyre in the tenant.** At pilot scale (259 tyres) that is nothing, and NFR-PRF-006 allows 500ms. At NFR-SCL-002 scale (10,000 tyres) it will not hold, and the fix is a materialised cohort view refreshed with the valuation snapshots rather than a cheaper rule here — the rule is BR-ANL-001 and it has one implementation. Raise that as a ticket when the first tenant passes ~2,000 tyres; do not pre-optimise it now, and do not substitute a two-point difference.

The `Scope` table in `api/internal/auth/auth.go` has exactly two values — `ScopeDepot` (the zero value, and what a `DRIVER` gets) and `ScopeTenant` — so the branch above tests for `ScopeTenant` rather than naming a driver constant that does not exist. Do not add a role-name check here; the whole point of the `Scope` table is that role names stay in `auth`.

Register the route in `httpapi.go`, inside the existing `r.Route("/api", ...)` block:

```go
r.Get("/capture/vehicles/{vehicleID}", captureContext(s))
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `make api-test`
Expected: PASS for all three role cases, and no banned monetary substring in the payload.

- [ ] **Step 5: Commit**

```bash
git add api/internal/httpapi/capture.go api/internal/httpapi/capture_test.go api/internal/httpapi/httpapi.go
git commit -m "feat(api): TYRE-71 capture reference context in one round trip"
```

---

### Task 5: `POST /api/inspections` — the submit endpoint (TYRE-67)

The first write endpoint and the first body decode in the codebase. Its whole job is to map the function's SQLSTATEs onto status codes the outbox can reason about — in particular, to distinguish a refusal worth retrying from one that never will be.

**Files:**
- Modify: `api/internal/httpapi/capture.go`
- Modify: `api/internal/httpapi/capture_test.go`
- Modify: `api/internal/httpapi/httpapi.go`

**Interfaces:**
- Consumes: `app.submit_inspection(jsonb)` and its SQLSTATEs from Task 3.
- Produces: `POST /api/inspections` returning `{"inspectionId": "…"}` with `201` on first submit and `200` on replay.

- [ ] **Step 1: Write the failing test**

Add to `capture_test.go`. First add a `post` helper next to the existing `get` helper in `httpapi_test.go`, matching its style:

```go
func post(t *testing.T, h http.Handler, path, tenant, user, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("X-Tenant-ID", tenant)
	req.Header.Set("X-User-ID", user)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

Then the contract the outbox depends on:

```go
func TestSubmitReplayContract(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID := plantTenant(t, ctx, admin, "submit")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	payload := captureFixture(t, ctx, admin, tenantID, vehicleID)

	first := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), payload)
	require.Equal(t, http.StatusCreated, first.Code, first.Body.String())

	var a, b struct {
		InspectionID string `json:"inspectionId"`
	}
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &a))
	require.NotEmpty(t, a.InspectionID)

	// FR-OFF-011: an uncertain network must be safe to retry. The outbox
	// replays on any answer it did not clearly receive, so this is the single
	// most load-bearing assertion in the API.
	replay := post(t, h, "/api/inspections", tenantID.String(), driverID.String(), payload)
	require.Equal(t, http.StatusOK, replay.Code, replay.Body.String())
	require.NoError(t, json.Unmarshal(replay.Body.Bytes(), &b))
	require.Equal(t, a.InspectionID, b.InspectionID, "a replay created a second inspection")
}

func TestSubmitRefusals(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID := plantTenant(t, ctx, admin, "refuse")
	driverID := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	techID := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusForbidden,
		post(t, h, "/api/inspections", tenantID.String(), techID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code,
		"a TECHNICIAN does not hold CaptureInspection")

	require.Equal(t, http.StatusBadRequest,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(), "{not json").Code)

	// FR-INS-038 is a permanent refusal: the outbox must surface FR-OFF-013's
	// recovery action rather than retry it for thirty minutes, which is why it
	// cannot share a status with 422's malformed vehicle.
	require.Equal(t, http.StatusCreated,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code)
	require.Equal(t, http.StatusConflict,
		post(t, h, "/api/inspections", tenantID.String(), driverID.String(),
			captureFixture(t, ctx, admin, tenantID, vehicleID)).Code)
}
```

`captureFixture` builds a valid payload with a fresh `client_uuid` each call, reading real position ids from the planted vehicle. Write it in the same file, using the admin connection to look up positions.

- [ ] **Step 2: Run it and verify it fails**

Run: `make api-test`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Write the handler**

Add to `capture.go`:

```go
// The submit body is passed through to app.submit_inspection as jsonb rather
// than modelled field by field in Go: the payload's shape is a database
// contract (DR-015..021), and a second Go-side model of it would be a second
// place for it to drift.
const maxSubmitBytes = 1 << 20 // 1 MiB: a 26-position rig with 78 measurements is ~30 KB

func submitInspection(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSubmitBytes))
		if err != nil {
			http.Error(w, "body too large or unreadable", http.StatusBadRequest)
			return
		}
		if !json.Valid(raw) {
			http.Error(w, "malformed json", http.StatusBadRequest)
			return
		}

		var id uuid.UUID
		var created bool
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			return tx.QueryRow(r.Context(),
				`SELECT inspection_id, created FROM app.submit_inspection($1::jsonb)`, string(raw)).
				Scan(&id, &created)
		})
		if !ok {
			return
		}
		if created {
			w.WriteHeader(http.StatusCreated)
		}
		writeJSON(r.Context(), w, map[string]string{"inspectionId": id.String()})
	}
}
```

`withActor`'s existing switch maps `errForbidden` to 403 and everything else to 500, so the function's SQLSTATEs need translating before they reach it. Extend the switch in `httpapi.go` — this is the one place it belongs, so every future write endpoint inherits it:

```go
// The submit function raises its refusals with SQLSTATEs in a private class so
// the transport can tell a client mistake from a server fault. The 409 is
// load-bearing beyond politeness: the outbox retries a 5xx with backoff and
// surfaces FR-OFF-013's recovery action on a 409, so conflating the two would
// have a phone hammer a refusal that will never change.
var submitStatus = map[string]int{
	"TY003": http.StatusConflict,
	"TY004": http.StatusUnprocessableEntity,
	"TY005": http.StatusUnprocessableEntity,
	"TY006": http.StatusUnprocessableEntity,
}

func statusForPgError(err error) (int, string, bool) {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return 0, "", false
	}
	if code, found := submitStatus[pgErr.Code]; found {
		return code, pgErr.Message, true
	}
	return 0, "", false
}
```

and add a case to `withActor` ahead of its `default`:

```go
case func() bool { code, msg, ok := statusForPgError(err); if ok { http.Error(w, msg, code) }; return ok }():
	return false
```

If that inline closure reads badly against the surrounding style, hoist it: compute `code, msg, isClient := statusForPgError(err)` before the switch and make it an ordinary `case isClient:`. Prefer the hoisted form.

Register the route:

```go
r.Post("/inspections", submitInspection(s))
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `make api-test`
Expected: all four cases pass — 201, 200 with the same id, 403, 400, 409.

- [ ] **Step 5: Commit**

```bash
git add api/internal/httpapi/capture.go api/internal/httpapi/capture_test.go \
        api/internal/httpapi/httpapi.go api/internal/httpapi/httpapi_test.go
git commit -m "feat(api): TYRE-67 POST /api/inspections with the FR-OFF-011 replay contract"
```

---

### Task 6: Rate limiting on the submission endpoint (NFR-SEC-007)

NFR-SEC-007: "rate-limit authentication endpoints and submission endpoints per account and per source address." No numeric limit is given, so the number is ours to choose and to justify in a comment.

**Files:**
- Create: `api/internal/httpapi/ratelimit.go`
- Create: `api/internal/httpapi/ratelimit_test.go`
- Modify: `api/internal/httpapi/httpapi.go`

**Interfaces:**
- Produces: `rateLimit(perMinute int) func(http.Handler) http.Handler`, applied to `POST /api/inspections` only.

- [ ] **Step 1: Write the failing test**

```go
func TestSubmitIsRateLimited(t *testing.T) {
	h := httpapi.RateLimitForTest(2) // 2 per minute
	var last int
	for i := 0; i < 4; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/inspections", strings.NewReader("{}"))
		req.Header.Set("X-User-ID", "11111111-1111-1111-1111-111111111111")
		h.ServeHTTP(rec, req)
		last = rec.Code
	}
	require.Equal(t, http.StatusTooManyRequests, last)
}
```

- [ ] **Step 2: Run it and verify it fails**

Run: `make api-test`
Expected: FAIL — `undefined: httpapi.RateLimitForTest`.

- [ ] **Step 3: Write the limiter**

Create `api/internal/httpapi/ratelimit.go`:

```go
package httpapi

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// NFR-SEC-007, per account and per source address. In-memory and per-instance
// on purpose: what the requirement asks for is a brake on a runaway or hostile
// client, not a quota, and a shared store would put a network round trip in
// front of the one endpoint whose latency a driver actually feels. Revisit if
// the API ever runs more than a couple of replicas.
//
// Sixty a minute is far above any human capture rate — the whole design target
// is three minutes per vehicle — and far below what a retry loop can manage.
const submitsPerMinute = 60

type rateLimiter struct {
	mu      sync.Mutex
	perMin  int
	windows map[string]*rateWindow
}

type rateWindow struct {
	start time.Time
	count int
}

func newRateLimiter(perMinute int) *rateLimiter {
	return &rateLimiter{perMin: perMinute, windows: make(map[string]*rateWindow)}
}

func (l *rateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Swept on write rather than by a goroutine: the map only grows when
	// somebody is submitting, so that is exactly when it is worth tidying.
	for k, w := range l.windows {
		if now.Sub(w.start) > 2*time.Minute {
			delete(l.windows, k)
		}
	}

	w, seen := l.windows[key]
	if !seen || now.Sub(w.start) >= time.Minute {
		l.windows[key] = &rateWindow{start: now, count: 1}
		return true
	}
	w.count++
	return w.count <= l.perMin
}

func (l *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		if !l.allow(r.Header.Get("X-User-ID")+"|"+host, time.Now()) {
			w.Header().Set("Retry-After", strconv.Itoa(60))
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RateLimitForTest builds the middleware at a chosen rate around a no-op
// handler, so the limit can be exercised without a test waiting a minute for
// the production window to turn over.
func RateLimitForTest(perMinute int) http.Handler {
	return newRateLimiter(perMinute).middleware(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
}
```

Apply it to the submit route alone, in `httpapi.go` — the reference read is a `GET` a driver makes once per vehicle and does not need it:

```go
r.With(newRateLimiter(submitsPerMinute).middleware).Post("/inspections", submitInspection(s))
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `make api-test`
Expected: PASS — the third request in the window is refused.

- [ ] **Step 5: Full check and commit**

Run: `make check`
Expected: db `ALL CHECKS PASSED`, all Go packages ok, web tests unchanged, clean tree.

```bash
git add api/internal/httpapi/ratelimit.go api/internal/httpapi/ratelimit_test.go api/internal/httpapi/httpapi.go
git commit -m "feat(api): TYRE-67 NFR-SEC-007 rate limit on the submission endpoint"
```

---

## When this plan is done

The platform can ingest an inspection. A driver's completed capture submits over HTTP, lands atomically, is safe to replay, closes its task, re-strikes the tyre's valuation through the existing trigger cascade, and cannot be lost to a bad odometer.

**What is deliberately still missing:** the capture UI and the durable outbox that feeds this (TYRE-68, TYRE-69), the mobile browser tests that prove the three-minute constraint (TYRE-70), and TYRE-41 — the exception views do not scope to the latest inspection, which becomes wrong the first time a driver submits a second inspection for one vehicle. **TYRE-41 should be picked up immediately after this plan and before the dashboard is trusted.**

Those are the client-slice plan, which follows this one.

