-- ============================================================================
-- Privileged negative controls, run as postgres via make db-test-privileged.
-- Proves nothing about RLS on its own (B7 spec U12); see db/CLAUDE.md.
-- Every block ends in ROLLBACK (TYRE-38).
--
-- P3 to P5 probe a tenant with no threshold policy in force. Policy rows are
-- written once (U69), so a configured tenant cannot reach that state as
-- app_login: postgres deletes BAC's tenant-wide row inside the transaction,
-- then SET LOCAL ROLE app_login runs the probe under RLS (TYRE-299).
--
-- P8 needs a policy row dated days before the transaction that writes it,
-- to stand in for one written between a capture and its late sync.
-- threshold_policy_not_backdated refuses a date before the writer's BEGIN to
-- every role (U70, U131). postgres disables that trigger for the one INSERT
-- and enables it again before the probe runs, inside the rolled-back
-- transaction.
--
-- P9 and P10 delete what app_login cannot: a tenant, for the audit
-- trigger's closure skip (DR-014), and a NULL-tenant app_user row, under a
-- DELETE trigger staged for the probe (TYRE-98).
--
-- P11 runs the catalogue seed and load as postgres, which bypasses RLS as
-- the Azure admin role may, so only the functions' own tenant predicates
-- keep them in the bound tenant. P12 writes a platform catalogue entry,
-- which only a migration's role can, to stand in for a later platform
-- migration (TYRE-369).
--
-- P13 sets a fleet's units to psi, bar and miles, and P14 edits a consent
-- row, as postgres, which no grant binds, to watch tenant_metric_units and
-- tenant_consent_written_once refuse it. P15 plants Second Fleet's receipts
-- directly and calls the receipt moves, set_tyre_cost, receive_tyres and
-- record_consent as
-- postgres bound to another fleet, so only the functions' own tenant
-- predicates keep them in the bound one, then edits a receipt and a tyre's
-- receipt link to watch both receipt triggers refuse a superuser
-- (TYRE-283).
--
-- P16 deletes a schedule, which app_login cannot, so the task's ON DELETE
-- SET NULL (schedule_id) reaches closed tasks: inspection_task_closes_once
-- freezes a closed task's state, citation and reason by name, never the
-- whole row (TYRE-326).
--
-- P17 needs a nomination dated after the caller's now, as one written by a
-- later transaction is while the caller waits on the task's row lock.
-- nomination_well_formed refuses a future instant to every role, and one
-- session cannot hold two transactions open, so postgres disables that
-- trigger for the one INSERT and enables it again before the probe runs as
-- app_login, as P8 does (TYRE-326).
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
  -- Planted with no receipt, since a received tyre is priced on its
  -- receipt (000059), and dated ten days back so the dated send and return
  -- follow it.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'P5-RETREAD', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 25.0, 'IN_STOCK',
          app.tenant_today(tz) - 10)
  RETURNING id INTO rt;
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

  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'P5-NEW', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01')
  RETURNING id AS tyre_id INTO r;
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

\echo '== P7. TYRE-299: the written-once and back-date triggers bind a superuser, which no grant does (U69, U70, FR-CFG-051)'
BEGIN;
DO $$
DECLARE t1   constant uuid := '11111111-1111-1111-1111-111111111111';
        base constant uuid := md5('11111111-1111-1111-1111-111111111111thrpol-default')::uuid;
        msg text;
BEGIN
  -- The row exists, so a refused UPDATE is the trigger on a row it visited.
  IF NOT EXISTS (SELECT 1 FROM app.threshold_policy WHERE id = base) THEN
    RAISE EXCEPTION 'FAIL P7: BAC''s baseline row is missing, so the UPDATE below would visit nothing';
  END IF;
  -- A no-op UPDATE is still an edit: a migration touching a row rewrites it.
  msg := NULL;
  BEGIN
    UPDATE app.threshold_policy SET max_retreads = max_retreads WHERE id = base;
  EXCEPTION WHEN sqlstate 'TY023' THEN msg := SQLERRM;
  END;
  IF msg IS DISTINCT FROM 'a threshold policy row is history and is never edited; a change is a new row with a later effective_from (FR-CFG-051)' THEN
    RAISE EXCEPTION 'FAIL P7: a superuser UPDATE of a policy row was answered %',
      COALESCE('TY023 "' || msg || '"', 'by an edit');
  END IF;
  msg := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, max_retreads, effective_from)
    VALUES (t1, 5.0, 2, now() - interval '1 day');
  EXCEPTION WHEN sqlstate 'TY023' THEN msg := SQLERRM;
  END;
  IF msg IS DISTINCT FROM 'a threshold policy row takes effect when it is written or later, never earlier (FR-CFG-051)' THEN
    RAISE EXCEPTION 'FAIL P7: a superuser back-dated insert was answered %',
      COALESCE('TY023 "' || msg || '"', 'by an accepted row');
  END IF;
  RAISE NOTICE 'PASS  P7 a superuser can neither edit a policy row nor back-date one';
END $$;
ROLLBACK;

\echo '== P8. TYRE-299: a late-synced inspection is priced under the policy of its own date, not the policy in force when it syncs (FR-CFG-010, FR-VAL-022)'
-- The probe row is dated 2026-08-05, between the 2026-08-01 inspection and
-- its sync. Dated now() instead, a pricing at the sync instant through the
-- exclusive as-at resolver would still see 4.0, and pass.
BEGIN;
SET LOCAL ROLE app_login;
-- Second Fleet's probe tyre and a 2026-08-10 capture, priced at the 4.0
-- baseline before the probe row exists: section 18's staging.
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        posid uuid; v numeric;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P8: the staging runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
  VALUES (md5('p8tyre')::uuid,t2,'P8PROBE1','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('p8insp1')::uuid,t2,md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('p8cli1')::uuid,'2026-08-10T08:00:00Z','2026-08-10T08:05:00Z',100000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('p8rd1')::uuid,t2,md5('p8insp1')::uuid,md5('t2veh1')::uuid,posid,md5('p8tyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    (t2,md5('p8rd1')::uuid,1,'OUTER',12,true),
    (t2,md5('p8rd1')::uuid,2,'CENTRE',13,true),
    (t2,md5('p8rd1')::uuid,3,'INNER',14,true);
  SELECT s.tread_value INTO v FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('p8tyre')::uuid AND s.as_at = '2026-08-10';
  IF v IS DISTINCT FROM 800.00 THEN
    RAISE EXCEPTION 'FAIL P8: the staging capture priced at [%], expected 800.00 under the baseline', v;
  END IF;
END $$;
RESET ROLE;
ALTER TABLE app.threshold_policy DISABLE TRIGGER threshold_policy_not_backdated;
INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, max_retreads, effective_from)
VALUES (md5('p8thrprobe6')::uuid, '22222222-2222-2222-2222-222222222222', 6.0, 2, '2026-08-05T00:00:00Z');
ALTER TABLE app.threshold_policy ENABLE TRIGGER threshold_policy_not_backdated;
SET LOCAL ROLE app_login;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        posid uuid; v numeric;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P8: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  IF (SELECT t.tgenabled FROM pg_trigger t
       WHERE t.tgrelid = 'app.threshold_policy'::regclass
         AND t.tgname = 'threshold_policy_not_backdated') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'FAIL P8: threshold_policy_not_backdated did not come back enabled';
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);
  -- The control: the probe row is Second Fleet's and in force where a
  -- pricing at the sync instant would read it, so the 1100.00 below can only
  -- come from the policy of the snapshot's own date.
  IF app.removal_threshold_mm_for(t2, now()) IS DISTINCT FROM 6.0 THEN
    RAISE EXCEPTION 'FAIL P8: the probe row is not in force for Second Fleet at now() (%)',
      app.removal_threshold_mm_for(t2, now());
  END IF;
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('p8insp3')::uuid,t2,md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('p8cli3')::uuid,'2026-08-01T06:00:00Z','2026-08-01T06:05:00Z',99000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('p8rd3')::uuid,t2,md5('p8insp3')::uuid,md5('t2veh1')::uuid,posid,md5('p8tyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    (t2,md5('p8rd3')::uuid,1,'OUTER',15,true),
    (t2,md5('p8rd3')::uuid,2,'CENTRE',16,true),
    (t2,md5('p8rd3')::uuid,3,'INNER',17,true);
  SELECT s.tread_value INTO v FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('p8tyre')::uuid AND s.as_at = '2026-08-01';
  IF v IS DISTINCT FROM 1100.00 THEN
    RAISE EXCEPTION 'FAIL P8: late-synced snapshot priced at [%], expected 1100.00 under the policy of its own date', v;
  END IF;
  RAISE NOTICE 'PASS  P8 a late-synced inspection is priced under the policy of its own date';
END $$;
ROLLBACK;

\echo '== P9. TYRE-98: a tenant whose unit carries a tag closes, because the audit trigger files nothing for a row its own tenant''s deletion removes (DR-014, ADR-0014)'
-- The control, on a second tenant, shows that an entry written during a
-- closure fails audit_log_tenant_id_fkey, so the closure that succeeds after
-- it succeeds because the trigger stood aside. Nothing here calls
-- app.receive_tyres, because display_code_counter has no tenant cascade and
-- its row would refuse the closure for a reason unrelated to the trigger.
BEGIN;
DO $$
DECLARE t uuid; n int;
BEGIN
  FOREACH t IN ARRAY ARRAY[md5('p9-closed')::uuid, md5('p9-control')::uuid] LOOP
    INSERT INTO app.tenant (id, name, subdomain, state)
    VALUES (t, 'P9 ' || t, 'p9-' || left(t::text, 8), 'ACTIVE');
    INSERT INTO app.axle_configuration (id, tenant_id, code, name, axle_count)
    VALUES (md5('p9cfg' || t)::uuid, t, 'P9RIG', 'P9 rig', 2);
    INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind)
    VALUES (md5('p9veh' || t)::uuid, t, 'P9-U', md5('p9cfg' || t)::uuid, 'TRAILER');
    INSERT INTO app.vehicle_tag (id, tenant_id, name) VALUES (md5('p9tag' || t)::uuid, t, 'P9 tag');
    INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id)
    VALUES (t, md5('p9veh' || t)::uuid, md5('p9tag' || t)::uuid);
    SELECT count(*) INTO n FROM app.audit_log
     WHERE tenant_id = t AND entity_type = 'vehicle_tag_map'
       AND entity_id = md5('p9veh' || t)::uuid AND action = 'INSERT';
    IF n <> 1 THEN
      RAISE EXCEPTION 'FAIL P9: tagging tenant %''s unit filed % entries, not one, so the closure below never meets the trigger', t, n;
    END IF;
  END LOOP;
  -- The task's ON DELETE SET NULL (schedule_id) is an UPDATE the closure
  -- would meet if it ran before the tenant's own cascades, which 000056's
  -- UPDATE arm would refuse (TYRE-98).
  INSERT INTO app.inspection_schedule (id, tenant_id, vehicle_id)
  VALUES (md5('p9sched')::uuid, md5('p9-closed')::uuid, md5('p9veh' || md5('p9-closed')::uuid)::uuid);
  INSERT INTO app.inspection_task (tenant_id, schedule_id, vehicle_id, due_at)
  VALUES (md5('p9-closed')::uuid, md5('p9sched')::uuid, md5('p9veh' || md5('p9-closed')::uuid)::uuid, now());
END $$;
CREATE FUNCTION app.p9_unguarded() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
BEGIN
  INSERT INTO app.audit_log (tenant_id, action, entity_type, entity_id)
  VALUES (OLD.tenant_id, 'DELETE', 'p9_unguarded', OLD.vehicle_id);
  RETURN NULL;
END $fn$;
CREATE TRIGGER p9_unguarded AFTER DELETE ON app.vehicle_tag_map
FOR EACH ROW EXECUTE FUNCTION app.p9_unguarded();
DO $$
DECLARE got text;
BEGIN
  BEGIN
    DELETE FROM app.tenant WHERE id = md5('p9-control')::uuid;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
  END;
  IF got IS DISTINCT FROM 'audit_log_tenant_id_fkey' THEN
    RAISE EXCEPTION 'FAIL P9: an entry written during a closure was answered %, so the closure below proves nothing',
      COALESCE(got, 'by a completed deletion');
  END IF;
END $$;
DROP TRIGGER p9_unguarded ON app.vehicle_tag_map;
DROP FUNCTION app.p9_unguarded();
DO $$
DECLARE t constant uuid := md5('p9-closed')::uuid;
        got text; n int;
BEGIN
  BEGIN
    DELETE FROM app.tenant WHERE id = t;
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
    RAISE EXCEPTION 'FAIL P9: closing a tenant with a tagged unit was refused by %', got;
  END;
  IF EXISTS (SELECT 1 FROM app.tenant WHERE id = t) THEN
    RAISE EXCEPTION 'FAIL P9: the tenant survived its deletion';
  END IF;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE tenant_id = t OR entity_id = md5('p9veh' || t)::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P9: % entries for the closed tenant or its unit survived the closure', n;
  END IF;
  RAISE NOTICE 'PASS  P9 a tenant with a tagged unit closes and takes its entries with it; an entry written during the closure would have refused it';
END $$;
ROLLBACK;

\echo '== P10. TYRE-98: the owning role''s app_user writes are filed with no actor: a platform admin''s under a NULL tenant no tenant session reads, a subject relink under its tenant, and a NULL-tenant deletion not mistaken for a closure (FR-TEN-002, FR-AUT-003a, ADR-0014)'
BEGIN;
DO $$
DECLARE pa  constant uuid := md5('p10-admin')::uuid;
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        u uuid; a app.audit_log; n int;
BEGIN
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (pa, NULL, 'p10-admin@example.invalid', 'P10 Platform Admin', 'PLATFORM_ADMIN');
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'app_user' AND entity_id = pa AND action = 'INSERT'
     AND tenant_id IS NULL AND actor_id IS NULL AND before IS NULL
     AND after->>'role' = 'PLATFORM_ADMIN';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P10: the platform admin''s insert filed % entries with no tenant and no actor, not one', n;
  END IF;
  UPDATE app.app_user SET display_name = 'P10 Renamed' WHERE id = pa;
  SELECT * INTO a FROM app.audit_log
   WHERE entity_type = 'app_user' AND entity_id = pa AND action = 'UPDATE';
  IF NOT FOUND OR a.tenant_id IS NOT NULL OR a.actor_id IS NOT NULL
     OR a.before->>'display_name' IS DISTINCT FROM 'P10 Platform Admin'
     OR a.after->>'display_name' IS DISTINCT FROM 'P10 Renamed' THEN
    RAISE EXCEPTION 'FAIL P10: the platform admin''s update is filed under tenant %, actor %, as % to %',
      a.tenant_id, a.actor_id, a.before->>'display_name', a.after->>'display_name';
  END IF;

  -- The runbook's rehire relink, bound to its tenant with no actor
  -- (docs/runbooks/provision-a-user.md).
  PERFORM set_config('app.tenant_id', bac::text, true);
  UPDATE app.app_user SET subject = md5('p10-new-oid')::uuid
   WHERE lower(email) = lower('melusi@example.invalid') AND subject = md5('subject-driver1')::uuid
     AND tenant_id = app.current_tenant_id()
  RETURNING id INTO u;
  IF u IS DISTINCT FROM md5('driver1')::uuid THEN
    RAISE EXCEPTION 'FAIL P10: the relink reached %, not driver1', u;
  END IF;
  SELECT * INTO a FROM app.audit_log
   WHERE entity_type = 'app_user' AND entity_id = u AND action = 'UPDATE'
     AND after->>'subject' = md5('p10-new-oid')::uuid::text;
  IF NOT FOUND OR a.tenant_id IS DISTINCT FROM bac OR a.actor_id IS NOT NULL
     OR a.before->>'subject' IS DISTINCT FROM md5('subject-driver1')::uuid::text THEN
    RAISE EXCEPTION 'FAIL P10: the relink is filed under tenant %, actor %, from subject %',
      a.tenant_id, a.actor_id, a.before->>'subject';
  END IF;
END $$;
SET LOCAL ROLE app_login;
DO $$
DECLARE n int;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P10: the read runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  -- The control: BAC reads its own relink entry, so the zero below is the
  -- NULL tenant hiding the platform admin's, not a read that sees nothing.
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'app_user' AND entity_id = md5('driver1')::uuid
     AND after->>'subject' = md5('p10-new-oid')::uuid::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P10: BAC reads % of its own relink entries, not one', n;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log WHERE entity_id = md5('p10-admin')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P10: a tenant session reads % of the platform admin''s entries', n;
  END IF;
END $$;
RESET ROLE;
CREATE TRIGGER p10_app_user_delete_audited AFTER DELETE ON app.app_user
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
DO $$
DECLARE n int;
BEGIN
  DELETE FROM app.app_user WHERE id = md5('p10-admin')::uuid;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'app_user' AND entity_id = md5('p10-admin')::uuid AND action = 'DELETE'
     AND tenant_id IS NULL AND after IS NULL
     AND before->>'email' = 'p10-admin@example.invalid';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P10: deleting a NULL-tenant row filed % entries, not one; the closure skip took it for a closed tenant', n;
  END IF;
  RAISE NOTICE 'PASS  P10 the owning role''s app_user writes are filed with no actor; a platform admin''s under a NULL tenant no tenant reads; a NULL-tenant deletion is filed';
END $$;
ROLLBACK;

\echo '== P11. TYRE-369: under a role that bypasses RLS, the seed and the file land in the bound tenant alone and resolve names there alone'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sbx constant uuid := '33333333-3333-3333-3333-333333333333';
        others_before text; others_after text; got text; st text; msg text; n int;
BEGIN
  -- postgres bypasses RLS, as the Azure admin role the runbook connects as
  -- may. BAC holds Dunlop, SP431 and 315/80R22.5 as its own rows, and
  -- Sandbox holds 385/65R22.5: what a missing tenant predicate would find.
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM app.tyre_brand   WHERE tenant_id = bac AND name = 'Dunlop'      AND platform_catalogue_id IS NULL
    UNION ALL SELECT 1 FROM app.tyre_pattern WHERE tenant_id = bac AND name = 'SP431' AND platform_catalogue_id IS NULL
    UNION ALL SELECT 1 FROM app.tyre_size    WHERE tenant_id = bac AND name = '315/80R22.5' AND platform_catalogue_id IS NULL
    UNION ALL SELECT 1 FROM app.tyre_size    WHERE tenant_id = sbx AND name = '385/65R22.5') x;
  IF n <> 4 THEN
    RAISE EXCEPTION 'FAIL P11: % of the four fixture rows this control rests on are visible', n;
  END IF;
  -- Sandbox is seeded first, so Second Fleet's seed meets another tenant's
  -- copy of every platform entry, and only the tenant predicates on its
  -- lineage lookups keep it from skipping them all.
  PERFORM set_config('app.tenant_id', sbx::text, true);
  n := app.seed_tenant_catalogue();
  IF n <> 10 THEN
    RAISE EXCEPTION 'FAIL P11: the seed bound to Sandbox inserted %, not 10', n;
  END IF;
  SELECT string_agg(t || '=' || c, ' ' ORDER BY t) INTO others_before FROM (
    SELECT 'size' AS t, count(*) AS c FROM app.tyre_size WHERE tenant_id <> t2
    UNION ALL SELECT 'brand', count(*) FROM app.tyre_brand WHERE tenant_id <> t2
    UNION ALL SELECT 'pattern', count(*) FROM app.tyre_pattern WHERE tenant_id <> t2
    UNION ALL SELECT 'estimate', count(*) FROM app.casing_estimate_by_size WHERE tenant_id <> t2
    UNION ALL SELECT 'price', count(*) FROM app.tyre_price_list WHERE tenant_id <> t2) x;

  -- A row of Second Fleet's own under a platform name is a clash, whoever
  -- else holds a copy of that entry. The handler takes the planted row back
  -- with the refused seed.
  PERFORM set_config('app.tenant_id', t2::text, true);
  BEGIN
    INSERT INTO app.tyre_brand (tenant_id, name) VALUES (t2, 'Evergreen');
    PERFORM app.seed_tenant_catalogue();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF st IS DISTINCT FROM 'TY025'
     OR msg IS DISTINCT FROM 'this fleet already has its own brand ''Evergreen''; a platform entry never adopts a row by name, so nothing was seeded' THEN
    RAISE EXCEPTION 'FAIL P11: a seed over Second Fleet''s own Evergreen, beside Sandbox''s copy, was answered %',
      COALESCE(st || ' ' || msg, 'by a seed');
  END IF;

  n := app.seed_tenant_catalogue();
  IF n <> 10 THEN
    RAISE EXCEPTION 'FAIL P11: the seed bound to Second Fleet inserted %, not 10, beside Sandbox''s copies', n;
  END IF;
  -- The file names 315/80R22.5 and Dunlop, which BAC and Sandbox hold too,
  -- and adds 295/80R22.5, which Sandbox holds.
  SELECT string_agg(s.section || '=' || s.inserted, ' ' ORDER BY s.n) INTO got
    FROM app.provision_catalogue(
      '{"sizes": [{"name": "295/80R22.5", "construction": "RADIAL"}],
        "price_list": [{"size": "315/80R22.5", "brand": "Dunlop", "typical_price": "4319.91", "effective_from": "2026-01-01"}]}')
      WITH ORDINALITY AS s(section, inserted, n);
  IF got IS DISTINCT FROM 'sizes=1 brands=0 patterns=0 casing_estimates=0 price_list=1' THEN
    RAISE EXCEPTION 'FAIL P11: the load bound to Second Fleet answered %', got;
  END IF;
  SELECT count(*) INTO n
    FROM app.tyre_price_list l
    JOIN app.tyre_size s  ON s.id = l.size_id
    JOIN app.tyre_brand b ON b.id = l.brand_id
   WHERE l.tenant_id = t2 AND s.tenant_id = t2 AND b.tenant_id = t2
     AND s.platform_catalogue_id IS NOT NULL AND b.platform_catalogue_id IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P11: the price row does not cite Second Fleet''s seeded size and brand';
  END IF;
  st := NULL;
  msg := NULL;
  BEGIN
    PERFORM app.provision_catalogue(
      '{"casing_estimates": [{"size": "385/65R22.5", "estimated_value": "1.00", "effective_from": "2026-01-01"}]}');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF st IS DISTINCT FROM 'TY024' OR msg IS DISTINCT FROM 'casing_estimates row 1: this fleet has no size named ''385/65R22.5''' THEN
    RAISE EXCEPTION 'FAIL P11: a load naming Sandbox''s size was answered %', COALESCE(st || ' ' || msg, 'by a stored row');
  END IF;

  -- Unbound, the explicit check is the only guard this role has.
  PERFORM set_config('app.tenant_id', '', true);
  st := NULL;
  BEGIN
    PERFORM app.seed_tenant_catalogue();
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  IF st IS DISTINCT FROM 'TY025' THEN
    RAISE EXCEPTION 'FAIL P11: an unbound seed under this role was answered %', COALESCE(st, 'by a seed');
  END IF;
  st := NULL;
  BEGIN
    PERFORM app.provision_catalogue('{}');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
  END;
  IF st IS DISTINCT FROM 'TY024' THEN
    RAISE EXCEPTION 'FAIL P11: an unbound load under this role was answered %', COALESCE(st, 'by a load');
  END IF;

  SELECT string_agg(t || '=' || c, ' ' ORDER BY t) INTO others_after FROM (
    SELECT 'size' AS t, count(*) AS c FROM app.tyre_size WHERE tenant_id <> t2
    UNION ALL SELECT 'brand', count(*) FROM app.tyre_brand WHERE tenant_id <> t2
    UNION ALL SELECT 'pattern', count(*) FROM app.tyre_pattern WHERE tenant_id <> t2
    UNION ALL SELECT 'estimate', count(*) FROM app.casing_estimate_by_size WHERE tenant_id <> t2
    UNION ALL SELECT 'price', count(*) FROM app.tyre_price_list WHERE tenant_id <> t2) x;
  IF others_after IS DISTINCT FROM others_before THEN
    RAISE EXCEPTION 'FAIL P11: the other tenants'' catalogues moved from % to %', others_before, others_after;
  END IF;
  RAISE NOTICE 'PASS  P11 under a role that bypasses RLS the seed and the file stay in Second Fleet and resolve names there alone, beside Sandbox''s copies';
END $$;
ROLLBACK;

\echo '== P12. TYRE-369 D8: platform entries a later migration adds reach a tenant already seeded, only those entries, and a new pattern takes the tenant''s own copy of its brand'
BEGIN;
SET LOCAL ROLE app_login;
DO $$
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  IF app.seed_tenant_catalogue() <> 10 THEN
    RAISE EXCEPTION 'FAIL P12: the first seed did not insert the ten starter entries';
  END IF;
END $$;
RESET ROLE;
-- What a later migration does, written as the owning role, which the app
-- role cannot: a size, a brand, and a pattern of that brand.
INSERT INTO app.platform_tyre_size (id, name, construction)
VALUES (md5('platform_tyre_size:P12 SIZE')::uuid, 'P12 SIZE', 'RADIAL');
INSERT INTO app.platform_tyre_brand (id, name)
VALUES (md5('platform_tyre_brand:P12 BRAND')::uuid, 'P12 BRAND');
INSERT INTO app.platform_tyre_pattern (id, name, brand_id, applies_to)
VALUES (md5('platform_tyre_pattern:P12 PATTERN')::uuid, 'P12 PATTERN', md5('platform_tyre_brand:P12 BRAND')::uuid, 'NEW');
-- As postgres, which bypasses RLS: Sandbox is seeded first, so its copy of
-- the new brand is visible when Second Fleet's pattern looks for its own.
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        sbx constant uuid := '33333333-3333-3333-3333-333333333333';
        n int; m int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', sbx::text, true);
  n := app.seed_tenant_catalogue();
  IF n <> 13 THEN
    RAISE EXCEPTION 'FAIL P12: Sandbox''s first seed inserted %, not the 13 platform entries', n;
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);
  n := app.seed_tenant_catalogue();
  m := app.seed_tenant_catalogue();
  IF n <> 3 OR m <> 0 THEN
    RAISE EXCEPTION 'FAIL P12: after the new entries Second Fleet''s seeds inserted % and then %, not 3 and 0', n, m;
  END IF;
  SELECT count(*) INTO n
    FROM app.tyre_pattern p JOIN app.tyre_brand b ON b.id = p.brand_id
   WHERE p.tenant_id = t2 AND b.tenant_id = t2
     AND p.platform_catalogue_id = md5('platform_tyre_pattern:P12 PATTERN')::uuid
     AND b.platform_catalogue_id = md5('platform_tyre_brand:P12 BRAND')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P12: Second Fleet''s copy of P12 PATTERN does not carry its own copy of P12 BRAND';
  END IF;
  SELECT (SELECT count(*) FROM app.tyre_size WHERE tenant_id = t2) || '/'
         || (SELECT count(*) FROM app.tyre_brand WHERE tenant_id = t2) || '/'
         || (SELECT count(*) FROM app.tyre_pattern WHERE tenant_id = t2) INTO got;
  IF got IS DISTINCT FROM '5/4/4' OR NOT EXISTS (
       SELECT 1 FROM app.tyre_size
        WHERE tenant_id = t2 AND name = 'P12 SIZE'
          AND platform_catalogue_id = md5('platform_tyre_size:P12 SIZE')::uuid) THEN
    RAISE EXCEPTION 'FAIL P12: Second Fleet holds %, not 5/4/4 with a copy of P12 SIZE', got;
  END IF;
  RAISE NOTICE 'PASS  P12 a seed after later platform entries inserts those alone, and the new pattern takes Second Fleet''s copy of its brand';
END $$;
ROLLBACK;

\echo '== P13. TYRE-283: tenant_metric_units refuses psi, bar and miles to a superuser, which the older per-column checks admit (FR-CFG-021)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        e record; cname text;
BEGIN
  FOR e IN SELECT * FROM (VALUES
    ('pressure PSI', $q$UPDATE app.tenant SET pressure_unit = 'PSI' WHERE id = '11111111-1111-1111-1111-111111111111'$q$),
    ('pressure BAR', $q$UPDATE app.tenant SET pressure_unit = 'BAR' WHERE id = '11111111-1111-1111-1111-111111111111'$q$),
    ('distance MI',  $q$UPDATE app.tenant SET distance_unit = 'MI' WHERE id = '11111111-1111-1111-1111-111111111111'$q$)
  ) v(what, stmt) LOOP
    cname := NULL;
    BEGIN
      EXECUTE e.stmt;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    END;
    IF cname IS DISTINCT FROM 'tenant_metric_units' THEN
      RAISE EXCEPTION 'FAIL P13: a superuser setting BAC''s % was answered %',
        e.what, COALESCE('a check violation of ' || cname, 'by an accepted row');
    END IF;
  END LOOP;
  IF (SELECT t.pressure_unit || '/' || t.distance_unit FROM app.tenant t WHERE t.id = bac) <> 'KPA/KM' THEN
    RAISE EXCEPTION 'FAIL P13: BAC''s units moved';
  END IF;
  RAISE NOTICE 'PASS  P13 a superuser cannot set psi, bar or miles on a fleet';
END $$;
ROLLBACK;

\echo '== P14. TYRE-283: tenant_consent_written_once refuses a superuser''s UPDATE of a consent row, which no grant does (FR-TEN-022)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        cid uuid; msg text; got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  cid := app.record_consent('SERVICE_DELIVERY', true, 'P14 MSA v1', '2026-10-01T08:00:00Z');
  msg := NULL;
  BEGIN
    UPDATE app.tenant_consent SET granted = false WHERE id = cid;
  EXCEPTION WHEN sqlstate 'TY027' THEN msg := SQLERRM;
  END;
  IF msg IS DISTINCT FROM 'a consent record is written once; a change of consent is a new record' THEN
    RAISE EXCEPTION 'FAIL P14: a superuser UPDATE of a consent row was answered %',
      COALESCE('TY027 "' || msg || '"', 'by an edit');
  END IF;
  SELECT c.granted || ':' || c.notice_version INTO got FROM app.tenant_consent c WHERE c.id = cid;
  IF got IS DISTINCT FROM 'true:P14 MSA v1' THEN
    RAISE EXCEPTION 'FAIL P14: the consent row reads % after the refused UPDATE', got;
  END IF;
  RAISE NOTICE 'PASS  P14 a superuser cannot edit a consent row';
END $$;
ROLLBACK;

\echo '== P15. TYRE-283: under a role that bypasses RLS the receipt moves, set_tyre_cost, receive_tyres and record_consent stay in the bound fleet, and both receipt triggers bind a superuser (FR-TEN-003, FR-CFG-041)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz2 constant uuid := md5('p15-sz')::uuid;
        pt2 constant uuid := md5('p15-pt')::uuid;
        br2 constant uuid := md5('p15-br')::uuid;
        r_un  constant uuid := md5('p15-unpriced')::uuid;
        r_est constant uuid := md5('p15-estimated')::uuid;
        r_inv constant uuid := md5('p15-invoiced')::uuid;
        loose constant uuid := md5('p15-loose')::uuid;
        before_j jsonb; after_j jsonb; e record; msg text; st text; n int;
BEGIN
  PERFORM set_config('app.actor_id', '', true);
  -- Second Fleet's rows, planted as postgres, each one a move would take if
  -- it saw it: a size with a price row, an unpriced, an estimated and an
  -- invoiced receipt, and a tyre with no receipt.
  INSERT INTO app.tyre_size (id, tenant_id, name) VALUES (sz2, t2, 'P15 SIZE');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to) VALUES (pt2, t2, 'P15 NEW', 'NEW');
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (t2, sz2, NULL, 1000.00, '2026-01-01');
  INSERT INTO app.tyre_receipt (id, tenant_id, size_id, pattern_id, received_date, price_state) VALUES
    (r_un,  t2, sz2, pt2, '2026-10-01', 'UNPRICED'),
    (r_est, t2, sz2, pt2, '2026-10-01', 'ESTIMATED'),
    (r_inv, t2, sz2, pt2, '2026-10-01', 'INVOICED');
  INSERT INTO app.tyre (tenant_id, display_code, size_id, pattern_id, status, retread_count, new_tread_mm,
                        state, received_date, purchase_price, cost_source, rand_per_mm, receipt_id) VALUES
    (t2, 'P15-UN',  sz2, pt2, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01', NULL,    'UNKNOWN',             NULL,     r_un),
    (t2, 'P15-EST', sz2, pt2, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01', 1000.00, 'PRICE_LIST_ESTIMATE', 47.6190, r_est),
    (t2, 'P15-INV', sz2, pt2, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01', 1000.00, 'INVOICE',             47.6190, r_inv);
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status, retread_count, new_tread_mm,
                        state, received_date)
  VALUES (loose, t2, 'P15-LOOSE', sz2, pt2, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01');
  SELECT jsonb_build_object(
           'receipts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.tyre_receipt c WHERE c.tenant_id = t2),
           'tyres', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM app.tyre t
                      WHERE t.tenant_id = t2 AND t.display_code LIKE 'P15-%'))
    INTO before_j;

  PERFORM set_config('app.tenant_id', bac::text, true);
  FOR e IN SELECT * FROM (VALUES
    ('an invoice',     format('SELECT app.record_receipt_invoice(%L, 1100.00)', r_un), 'no such receipt in this fleet'),
    ('the list price', format('SELECT app.apply_receipt_list_price(%L)', r_un),        'no such receipt in this fleet'),
    ('a keep',         format('SELECT app.keep_receipt_estimate(%L)', r_est),          'no such receipt in this fleet'),
    ('a cost',         format('SELECT app.set_tyre_cost(%L, 1100.00, ''INVOICE'')', loose), 'no such tyre in this fleet')
  ) v(what, stmt, want) LOOP
    st := NULL; msg := NULL;
    BEGIN
      EXECUTE e.stmt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    END;
    IF st IS DISTINCT FROM 'TY012' OR msg IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL P15: bound to BAC, % on a Second Fleet row was answered %',
        e.what, COALESCE(st || ' "' || msg || '"', 'by a write');
    END IF;
  END LOOP;
  -- receive_tyres answers another fleet's catalogue row as no row, not
  -- from that row's own state.
  INSERT INTO app.tyre_brand (id, tenant_id, name) VALUES (br2, t2, 'P15 BRAND');
  FOR e IN SELECT * FROM (VALUES
    ('a size',    jsonb_build_object('size_id', sz2, 'pattern_id', md5('pt1')::uuid),
                  'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a pattern', jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', pt2),
                  'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a brand',   jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid, 'brand_id', br2),
                  'that brand is not in this fleet''s active catalogue; choose another, leave it blank, or ask an administrator to add it')
  ) v(what, payload, want) LOOP
    st := NULL; msg := NULL;
    BEGIN
      PERFORM app.receive_tyres(e.payload || jsonb_build_object('new_tread_mm', '25.0', 'received_date', '2026-10-01'));
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    END;
    IF st IS DISTINCT FROM 'TY011' OR msg IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL P15: bound to BAC, a receive naming % of Second Fleet''s was answered %',
        e.what, COALESCE(st || ' "' || msg || '"', 'by a write');
    END IF;
  END LOOP;
  SELECT jsonb_build_object(
           'receipts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.tyre_receipt c WHERE c.tenant_id = t2),
           'tyres', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM app.tyre t
                      WHERE t.tenant_id = t2 AND t.display_code LIKE 'P15-%'))
    INTO after_j;
  IF before_j IS DISTINCT FROM after_j THEN
    RAISE EXCEPTION 'FAIL P15: Second Fleet''s receipts or tyres changed under BAC''s calls';
  END IF;

  -- U144's read names its fleet: BAC's later record does not hold Second
  -- Fleet's earlier one back.
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM app.record_consent('SERVICE_DELIVERY', true, 'P15 BAC later', '2026-10-02T08:00:00Z');
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM app.record_consent('SERVICE_DELIVERY', true, 'P15 MSA v1', '2026-10-01T08:00:00Z');
  SELECT count(*) INTO n FROM app.tenant_consent c WHERE c.notice_version = 'P15 MSA v1' AND c.tenant_id <> t2;
  IF n <> 0 OR NOT EXISTS (SELECT 1 FROM app.tenant_consent c WHERE c.notice_version = 'P15 MSA v1' AND c.tenant_id = t2) THEN
    RAISE EXCEPTION 'FAIL P15: record_consent bound to Second Fleet wrote % rows elsewhere', n;
  END IF;

  FOR e IN SELECT * FROM (VALUES
    ('a move from INVOICED', format('UPDATE app.tyre_receipt SET price_state = ''ESTIMATED'' WHERE id = %L', r_inv),
     'this receipt''s price is final and does not change'),
    ('a tyre''s receipt cleared', format('UPDATE app.tyre SET receipt_id = NULL WHERE tenant_id = %L AND display_code = ''P15-UN''', t2),
     'a tyre''s receipt is set when it is received and never changes')
  ) v(what, stmt, want) LOOP
    st := NULL; msg := NULL;
    BEGIN
      EXECUTE e.stmt;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
    END;
    IF st IS DISTINCT FROM 'TY026' OR msg IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL P15: a superuser''s % was answered %', e.what, COALESCE(st || ' "' || msg || '"', 'by an edit');
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  P15 the receipt moves, set_tyre_cost and receive_tyres find no other fleet''s row, record_consent writes the bound fleet''s alone, and both receipt triggers bind a superuser';
END $$;
ROLLBACK;

\echo '== P16. TYRE-326: deleting a schedule still clears the schedule_id of the closed tasks it names, whose state, citation and reason stay as they were (FR-INS-052, DR-014)'
BEGIN;
DO $$
DECLARE bac   constant uuid := '11111111-1111-1111-1111-111111111111';
        sched constant uuid := md5('p16-sched')::uuid;
        v uuid; insp uuid; kc uuid; kd uuid; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  SELECT i.id, i.vehicle_id INTO STRICT insp, v
    FROM app.inspection i WHERE i.tenant_id = bac ORDER BY i.id LIMIT 1;
  INSERT INTO app.inspection_schedule (id, tenant_id, vehicle_id) VALUES (sched, bac, v);
  INSERT INTO app.inspection_task (tenant_id, schedule_id, vehicle_id, due_at, state, cancelled_reason, closed_at)
  VALUES (bac, sched, v, now() - interval '2 days', 'CANCELLED', 'P16', now() - interval '1 day')
  RETURNING id INTO kc;
  INSERT INTO app.inspection_task (tenant_id, schedule_id, vehicle_id, due_at, state, completed_inspection_id, closed_at)
  VALUES (bac, sched, v, now() - interval '2 days', 'COMPLETED', insp, now() - interval '1 day')
  RETURNING id INTO kd;
  DELETE FROM app.inspection_schedule WHERE id = sched;
  SELECT string_agg(concat_ws(' ', k.state, COALESCE(k.schedule_id::text, 'unscheduled'),
                              COALESCE(k.cancelled_reason, (k.completed_inspection_id = insp)::text),
                              (k.closed_at = now() - interval '1 day')::text),
                    ',' ORDER BY k.state::text) INTO got
    FROM app.inspection_task k WHERE k.id IN (kc, kd);
  IF got IS DISTINCT FROM 'CANCELLED unscheduled P16 true,COMPLETED unscheduled true true' THEN
    RAISE EXCEPTION 'FAIL P16: after the schedule''s deletion its closed tasks read %', got;
  END IF;
  RAISE NOTICE 'PASS  P16 a schedule''s deletion clears its closed tasks'' schedule_id and leaves their state, citation, reason and close as they were';
END $$;
ROLLBACK;

\echo '== P17. TYRE-326: a nomination dated after the caller''s now, as a later transaction leaves one, is refused by name as a race lost (FR-INS-051 as amended, TY018)'
BEGIN;
INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
SELECT md5('p17-horse')::uuid, x.tenant_id, 'P17-H', 'P17H GP', x.configuration_id, 'HORSE', 'ACTIVE'
  FROM app.vehicle x WHERE x.id = md5('veh1')::uuid;
INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at)
VALUES (md5('p17-task')::uuid, '11111111-1111-1111-1111-111111111111', md5('p17-horse')::uuid, now() + interval '1 day');
ALTER TABLE app.inspection_task_nomination DISABLE TRIGGER nomination_well_formed;
INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
VALUES ('11111111-1111-1111-1111-111111111111', md5('p17-task')::uuid, md5('driver1')::uuid, now() + interval '1 second');
ALTER TABLE app.inspection_task_nomination ENABLE TRIGGER nomination_well_formed;
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P17: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  IF (SELECT t.tgenabled FROM pg_trigger t
       WHERE t.tgrelid = 'app.inspection_task_nomination'::regclass
         AND t.tgname = 'nomination_well_formed') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'FAIL P17: nomination_well_formed did not come back enabled';
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  BEGIN
    PERFORM app.nominate_for_task(md5('p17-task')::uuid, md5('driver3')::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    got := got || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM 'TY018 this inspection was given another driver while this request was being made; refresh and try again' THEN
    RAISE EXCEPTION 'FAIL P17: a nomination over one dated after the caller''s now answered %', COALESCE(got, 'with a nomination');
  END IF;
  RAISE NOTICE 'PASS  P17 a nomination dated after the caller''s now is refused as a race lost';
END $$;
ROLLBACK;

\echo ''
\echo '================  PRIVILEGED CONTROLS PASSED  ================'
