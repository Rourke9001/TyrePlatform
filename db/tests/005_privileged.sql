-- ============================================================================
--  Privileged negative controls. Run as postgres, through make
--  db-test-privileged, inside BEGIN/ROLLBACK. This file is NOT the
--  verification suite and proves nothing about RLS: a superuser bypasses
--  every policy. It exists for the one class of check app_login cannot stage,
--  a composite foreign key removed for the length of a transaction so that a
--  backstop inside a SECURITY DEFINER chain can be watched refusing the row
--  the key would otherwise make unconstructable (TYRE-38; B7 spec U12;
--  000004's note on why refresh_governing_tread's chain carries backstops at
--  all). Every block ends in ROLLBACK; nothing here may commit.
-- ============================================================================
\set ON_ERROR_STOP on
SET search_path = app, public;

\echo '== P0. Confirm we ARE a superuser (the staging below needs one; the suite proper must never be)'
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'FAIL P0: 005_privileged.sql runs as postgres; it stages FK removals. Use make db-test for the suite';
  END IF;
  RAISE NOTICE 'PASS  P0 running as % (superuser, staging only)', current_user;
END $$;

\echo '== P1. TYRE-38: the snapshot trigger refuses a reading whose inspection belongs to another tenant'
BEGIN;
DO $$
DECLARE t1 constant uuid := '11111111-1111-1111-1111-111111111111';
        t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        insp constant uuid := md5('p1insp')::uuid;
        tyre2 constant uuid := md5('p1tyre2')::uuid;
        rd constant uuid := md5('p1rd')::uuid;
        msg text; fired boolean := false;
BEGIN
  -- Staging for TYRE-38's backstop, not part of the assertion. The BAC
  -- inspection is created in THIS transaction: 000040's seal refuses a
  -- reading on any inspection whose created_at is not this transaction's
  -- timestamp, so a seeded inspection can never be reached here. Second
  -- Fleet seeds no tyre, and reading_tyre_id_fkey is composite on
  -- (tenant_id, tyre_id), so one is planted for the reading to name.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
  VALUES (insp, t1, md5('veh1')::uuid, md5('driver1')::uuid, md5('p1cli')::uuid,
          now() - interval '10 minutes', now() - interval '5 minutes', 412600);
  INSERT INTO app.tyre (id, tenant_id, display_code, state)
  VALUES (tyre2, t2, 'P1T2', 'IN_STOCK');
  ALTER TABLE app.reading DROP CONSTRAINT reading_inspection_id_fkey;

  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  SELECT rd, t2, insp, md5('t2veh1')::uuid, pos.id, tyre2, 750
    FROM app.position pos
   WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid AND pos.code = '1';

  -- The measurement is what fires the chain: refresh_governing_tread writes
  -- governing_tread_mm, and the AFTER UPDATE trigger runs
  -- snapshot_on_governing_change, whose first act is the tenant check.
  BEGIN
    -- Three, contiguous from 1: the tenant's tread_reading_count and what a
    -- real capture writes (CR-011), so the row a superuser plants is shaped
    -- like the one the FK is there to stop rather than like a shape 000001's
    -- deferred contiguity trigger would refuse on its own. Only the first
    -- row's AFTER trigger changes governing_tread_mm, so that is the one the
    -- backstop is reached from.
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
    VALUES (t2, rd, 1, 'OUTER', 3.0, true, 1.0),
           (t2, rd, 2, 'CENTRE', 3.0, true, 1.0),
           (t2, rd, 3, 'INNER', 3.0, true, 1.0);
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    -- The message, not the bare SQLSTATE: three other raises in this chain
    -- carry 42501 (000004 once, 000029 twice) and app.inspection's audit
    -- trigger can answer with a fourth from app.audit_log, so a bare code
    -- would pass on any of them (docs/lessons.md 2026-09-08).
    IF msg NOT LIKE 'reading % names an inspection outside its tenant' THEN
      RAISE EXCEPTION 'FAIL P1: refused with another 42501: %', msg;
    END IF;
    fired := true;
  END;
  IF NOT fired THEN
    RAISE EXCEPTION 'FAIL P1: the backstop did not fire; a cross-tenant inspection reference was snapshotted';
  END IF;
  RAISE NOTICE 'PASS  P1 the snapshot trigger refuses a reading naming another tenant''s inspection';
END $$;
ROLLBACK;

\echo '== P2. TYRE-38: reconcile_valuation_snapshots refuses a tyre outside the tenant it is asked to reconcile, with RLS unbound'
BEGIN;
DO $$
DECLARE t1 constant uuid := '11111111-1111-1111-1111-111111111111';
        t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        insp constant uuid := md5('p2insp')::uuid;
        tyre2 constant uuid := md5('p2tyre2')::uuid;
        rd constant uuid := md5('p2rd')::uuid;
        msg text; fired boolean := false;
BEGIN
  -- The mirror of P1, staging TYRE-38's second backstop: a BAC reading
  -- naming a Second Fleet tyre. The inspection check passes (same tenant);
  -- the tyre check inside reconcile_valuation_snapshots (000029) is the one
  -- reached, on the branch section 20 cannot exercise because RLS is bound
  -- there.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
  VALUES (insp, t1, md5('veh1')::uuid, md5('driver1')::uuid, md5('p2cli')::uuid,
          now() - interval '10 minutes', now() - interval '5 minutes', 412600);
  INSERT INTO app.tyre (id, tenant_id, display_code, state, rand_per_mm, casing_value)
  VALUES (tyre2, t2, 'P2T2', 'IN_STOCK', 205.71, 1837.50);
  ALTER TABLE app.reading DROP CONSTRAINT reading_tyre_id_fkey;

  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  SELECT rd, t1, insp, md5('veh1')::uuid, pos.id, tyre2, 750
    FROM app.position pos
   WHERE pos.configuration_id = md5('11111111-1111-1111-1111-111111111111HORSE_6X4')::uuid AND pos.code = '1';

  BEGIN
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
    VALUES (t1, rd, 1, 'OUTER', 3.0, true, 1.0),
           (t1, rd, 2, 'CENTRE', 3.0, true, 1.0),
           (t1, rd, 3, 'INNER', 3.0, true, 1.0);
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'tyre % is not tenant %''s to reconcile' THEN
      RAISE EXCEPTION 'FAIL P2: refused with another 42501: %', msg;
    END IF;
    fired := true;
  END;
  IF NOT fired THEN
    RAISE EXCEPTION 'FAIL P2: the reconcile assert did not fire with RLS unbound';
  END IF;
  RAISE NOTICE 'PASS  P2 reconcile_valuation_snapshots refuses another tenant''s tyre with RLS unbound';
END $$;
ROLLBACK;

\echo ''
\echo '================  PRIVILEGED CONTROLS PASSED  ================'
