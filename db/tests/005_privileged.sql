-- ============================================================================
-- Privileged negative controls, run as postgres via make db-test-privileged.
-- Proves nothing about RLS on its own (B7 spec U12); see db/CLAUDE.md.
-- Every block ends in ROLLBACK (TYRE-38).
--
-- P3 to P5 probe a tenant with no threshold policy in force. Policy rows are
-- written once (U69), so a configured tenant cannot reach that state as
-- app_login: postgres deletes BAC's tenant-wide row inside the transaction,
-- then SET LOCAL ROLE app_login runs the probe under RLS (TYRE-299).
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
  -- Staging for TYRE-38: the inspection is created in this transaction so
  -- 000040's seal does not refuse it; the tyre is planted since
  -- reading_tyre_id_fkey is composite on (tenant_id, tyre_id).
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
    -- Three readings, contiguous from 1 (CR-011): shaped like a real capture
    -- so 000001's contiguity trigger does not refuse it before the backstop
    -- under test is reached.
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
  -- Mirror of P1, TYRE-38's second backstop: a BAC reading naming a Second
  -- Fleet tyre reaches 000029's tyre check, the branch check 20 cannot
  -- exercise with RLS bound.
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

\echo '== P3. TYRE-299: with no threshold policy in force BAC''s register is unvalued and labelled, never a silent R0.00 (CHG-115, FR-VAL-013)'
-- A tenant with no effective threshold row (fresh provisioning, or a first
-- row dated forward) must surface every tyre unvalued. GREATEST(0, NULL) is
-- 0, so an unguarded call would price the whole estate at R0.00 tread,
-- indistinguishable from a bald fleet. Deleting the tenant-wide row is
-- enough: the class-blind readers never resolve the STEER row (U5).
BEGIN;
DELETE FROM app.threshold_policy
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND operating_group_id IS NULL AND axle_class IS NULL;
SET LOCAL ROLE app_login;
DO $$
DECLARE n int;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P3: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE tread_value IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P3: % tyres priced with no threshold policy configured', n; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE valuation_basis <> 'UNVALUED';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P3: % rows not labelled UNVALUED with no threshold policy', n; END IF;
  SELECT unvalued_count INTO n FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF n IS DISTINCT FROM 27 THEN
    RAISE EXCEPTION 'FAIL P3: unvalued_count=% with no threshold policy, expected 27', n; END IF;
  RAISE NOTICE 'PASS  P3 no threshold policy means unvalued and labelled, never a silent R0.00 estate';
END $$;
ROLLBACK;

\echo '== P4. TYRE-299: with no removal threshold in force a priced receive is refused as TY011 and an unpriced one lands awaiting cost (U129, TYRE-421)'
BEGIN;
DELETE FROM app.threshold_policy
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND operating_group_id IS NULL AND axle_class IS NULL;
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        r record; t app.tyre; got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P4: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  IF app.current_removal_threshold_mm() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P4: BAC still has a removal threshold in force, so the refusal cannot be probed';
  END IF;

  got := NULL;
  BEGIN
    PERFORM app.receive_tyres(jsonb_build_object(
      'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
      'purchase_price', '4319.91', 'cost_source', 'INVOICE'));
  EXCEPTION WHEN sqlstate 'TY011' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'this fleet has no removal threshold configured, so a priced tyre cannot be rated; configure the removal threshold first, or receive the tyre without its price' THEN
    RAISE EXCEPTION 'FAIL P4: a priced receive with no threshold in force was answered %',
      coalesce('TY011 "' || got || '"', 'by an accepted receive');
  END IF;

  -- An unpriced tyre lands in the awaiting-cost backlog (FR-TYR-041).
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0'));
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS NOT NULL OR t.rand_per_mm IS NOT NULL OR t.cost_source <> 'UNKNOWN' THEN
    RAISE EXCEPTION 'FAIL P4: an unpriced receive stored price %, rate %, source %',
      t.purchase_price, t.rand_per_mm, t.cost_source;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = t.id) THEN
    RAISE EXCEPTION 'FAIL P4: an unpriced receive with no threshold in force is not awaiting cost';
  END IF;
  RAISE NOTICE 'PASS  P4 with no threshold in force a priced receive is refused as TY011 and an unpriced one lands awaiting cost';
END $$;
ROLLBACK;

\echo '== P5. TYRE-299: with no removal threshold in force set_tyre_cost refuses a new tyre''s cost as TY013, and a retreaded tyre is still costed (U129, FR-VAL-006, FR-TYR-019)'
-- The retreaded casing is returned while BAC's baseline is in force, then
-- the baseline goes; its job id is how the second block finds it.
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        d_rt constant uuid := md5('p5rt')::uuid;
        j    constant uuid := md5('p5j')::uuid;
        tz text; rt uuid;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P5: the staging runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT x.timezone INTO tz FROM app.tenant x WHERE x.id = bac;
  -- Received ten days back so the dated send and return follow it.
  SELECT tyre_id INTO rt FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
    'received_date', (app.tenant_today(tz) - 10)::text));
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'P5 Retreaders', 'RETREADER');
  UPDATE app.tyre SET state = 'AT_RETREADER' WHERE id = rt;
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at)
  VALUES (j, bac, rt, d_rt, app.tenant_today(tz) - 5);
  PERFORM app.log_retread_return(j, app.tenant_today(tz) - 1, true, 'P5-RPT', 2500.00, 16.0, 800.00);
END $$;
RESET ROLE;
DELETE FROM app.threshold_policy
 WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
   AND operating_group_id IS NULL AND axle_class IS NULL;
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        rt uuid; rt_rate numeric; r record; t app.tyre; got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P5: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT jb.tyre_id INTO rt FROM app.retread_job jb WHERE jb.id = md5('p5j')::uuid;
  SELECT x.rand_per_mm INTO rt_rate FROM app.tyre x WHERE x.id = rt;
  IF rt_rate IS NULL THEN
    RAISE EXCEPTION 'FAIL P5: the retreaded casing was not staged with a rate';
  END IF;
  IF app.current_removal_threshold_mm() IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P5: BAC still has a removal threshold in force, so the refusal cannot be probed';
  END IF;

  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0'));
  got := NULL;
  BEGIN
    PERFORM app.set_tyre_cost(r.tyre_id, 4319.91, 'INVOICE');
  EXCEPTION WHEN sqlstate 'TY013' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'this fleet has no removal threshold configured, so this tyre''s cost cannot be rated; configure the removal threshold first, then record the cost' THEN
    RAISE EXCEPTION 'FAIL P5: a cost with no threshold in force was answered %',
      coalesce('TY013 "' || got || '"', 'by a stored cost');
  END IF;
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS NOT NULL OR t.rand_per_mm IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = t.id) THEN
    RAISE EXCEPTION 'FAIL P5: a tyre refused with no threshold stored price %, rate % or left the backlog',
      t.purchase_price, t.rand_per_mm;
  END IF;

  -- The guard-agreement control: the retreaded tyre's rate does not come
  -- from its price, so it is costed with no threshold in force.
  PERFORM app.set_tyre_cost(rt, 4319.91, 'INVOICE');
  SELECT * INTO t FROM app.tyre WHERE id = rt;
  IF t.purchase_price IS DISTINCT FROM 4319.91 OR t.rand_per_mm IS DISTINCT FROM rt_rate THEN
    RAISE EXCEPTION 'FAIL P5: a retreaded tyre with no threshold in force stored price %, rate % (retread rate %)',
      t.purchase_price, t.rand_per_mm, rt_rate;
  END IF;
  RAISE NOTICE 'PASS  P5 with no threshold in force a new tyre''s cost is refused as TY013 and stays awaiting cost; a retreaded tyre is costed and keeps its retread rate';
END $$;
ROLLBACK;

\echo '== P6. TYRE-299: P3 to P5 leave BAC''s baseline policy and its register as they found them'
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE n int; v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM app.threshold_policy
   WHERE operating_group_id IS NULL AND axle_class IS NULL AND effective_from = '-infinity';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P6: BAC has % tenant-wide baselines after the rollbacks, expected 1', n; END IF;
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL P6: totals did not come back after the no-policy probes, got %', v; END IF;
  RAISE NOTICE 'PASS  P6 the rollbacks restored BAC''s baseline and its 20571.00 register';
END $$;
ROLLBACK;

\echo ''
\echo '================  PRIVILEGED CONTROLS PASSED  ================'
