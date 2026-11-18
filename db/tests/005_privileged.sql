-- ============================================================================
-- Privileged negative controls, run as postgres via make db-test-privileged.
-- What runs as postgres proves nothing about RLS (B7 spec U12), and a probe
-- after SET LOCAL ROLE to app_login, app_writer or app_job does; see
-- db/CLAUDE.md.
-- Every block ends in ROLLBACK (TYRE-38). db/tests/helpers.sql loads first,
-- the pg_temp prelude of the helpers this file shares with 004.
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
-- row and inserts one dated in the future, as postgres, which no grant
-- binds, to watch tenant_metric_units, tenant_consent_written_once and
-- tenant_consent_not_future_dated refuse it (000062). P15 plants Second
-- Fleet's receipts directly and calls the receipt moves, set_tyre_cost,
-- receive_tyres, its depot included (000062), and record_consent as
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
-- P17 and P18 need a nomination and a trip dated after the caller's now,
-- as one written by a later transaction is while the caller waits on its
-- row locks. No function writes a future instant, and one session cannot
-- hold two transactions open, so postgres writes the row before the probe
-- runs as app_login (TYRE-326, TYRE-472).
--
-- P19 needs open tasks carrying a cancellation reason and a citation, as
-- history from before 000060 may hold them. inspection_task_closes_once
-- refuses either plant to every role, so postgres disables it for the plants
-- and enables it again before a capture as app_login closes both (TYRE-326).
--
-- P20 to P25 are suite cases that write a trip or a nomination at an instant
-- or in a shape no function writes (TYRE-472). postgres stages them, and the
-- probe runs as app_login. P20 to P22 probe as app_writer, the one role
-- besides the owner that may write either table (000061).
--
-- P26 stages each fault suite check 8e looks for, a table app_writer owns,
-- BYPASSRLS, a grant off its list or missing from it, the app login as a
-- member, and shows the shared check names it. P27 is where the WITH CHECK
-- on trip and inspection_task_nomination lives, with a control that shows
-- it would catch an owner that bypasses RLS (ADR-0024, Option C).
--
-- P28 shows the marking function stays in the bound fleet as app_login,
-- and that row security binds app_writer on the three tables it reads and
-- writes, with P27's BYPASSRLS control (ADR-0024, 000062). P29 shows the
-- return's pattern check names the bound fleet under a role that bypasses
-- RLS (000062).
--
-- P30 plants a tenant in each state, which app_login cannot, and probes
-- app_job after SET LOCAL ROLE: the tenant listing only it may call, and
-- that row security binds app_job as it binds app_login (TYRE-371).
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
    PERFORM app.receive_tyres(pg_temp.at_depot(jsonb_build_object(
      'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
      'purchase_price', '4319.91', 'cost_source', 'INVOICE')));
  EXCEPTION WHEN sqlstate 'TY011' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'this fleet has no removal threshold configured, so a priced tyre cannot be rated; configure the removal threshold first, or receive the tyre without its price' THEN
    RAISE EXCEPTION 'FAIL P4: a priced receive with no threshold in force was answered %',
      coalesce('TY011 "' || got || '"', 'by an accepted receive');
  END IF;

  -- An unpriced tyre lands in the awaiting-cost backlog (FR-TYR-041).
  SELECT * INTO r FROM app.receive_tyres(pg_temp.at_depot(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0')));
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
  PERFORM app.log_retread_return(j, app.tenant_today(tz) - 1, true, 'P5-RPT', 2500.00, 16.0, 800.00, p_new_pattern_id => pg_temp.retread_pattern());
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

\echo '== P14. TYRE-283: tenant_consent_written_once refuses a superuser''s UPDATE of a consent row, which no grant does, and tenant_consent_not_future_dated a row dated in the future (FR-TEN-022, TYRE-99)'
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
  msg := NULL;
  BEGIN
    INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, occurred_at)
    VALUES (t2, 'SERVICE_DELIVERY', false, 'P14 MSA v9', now() + interval '1 minute');
  EXCEPTION WHEN sqlstate 'TY027' THEN msg := SQLERRM;
  END;
  IF msg IS DISTINCT FROM 'consent is recorded as given now or earlier, never at a future time' THEN
    RAISE EXCEPTION 'FAIL P14: a superuser''s consent row dated in the future was answered %',
      COALESCE('TY027 "' || msg || '"', 'by an insert');
  END IF;
  RAISE NOTICE 'PASS  P14 a superuser cannot edit a consent row or insert one dated in the future';
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
                  'that brand is not in this fleet''s active catalogue; choose another, leave it blank, or ask an administrator to add it'),
    ('a depot',   jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                     'depot_id', md5('depot2')::uuid),
                  'no such active depot or store in this fleet; choose the depot or store that takes the stock')
  ) v(what, payload, want) LOOP
    st := NULL; msg := NULL;
    BEGIN
      PERFORM app.receive_tyres(pg_temp.at_depot(e.payload || jsonb_build_object('new_tread_mm', '25.0', 'received_date', '2026-10-01')));
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
INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
VALUES ('11111111-1111-1111-1111-111111111111', md5('p17-task')::uuid, md5('driver1')::uuid, now() + interval '1 second');
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P17: the probe runs as %, so RLS is not on trial', current_user;
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

\echo '== P18. TYRE-326: a trip dated after the caller''s now, as a later transaction''s start leaves one, makes a start on its motive and its own end refuse by name as a race lost (FR-VEH-007 as amended, TY028)'
BEGIN;
INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
SELECT md5('p18-horse')::uuid, x.tenant_id, 'P18-H', 'P18H GP', x.configuration_id, 'HORSE', 'ACTIVE'
  FROM app.vehicle x WHERE x.id = md5('veh1')::uuid;
INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
VALUES (md5('p18-driver')::uuid, '11111111-1111-1111-1111-111111111111', 'p18-driver@example.invalid', 'P18 Driver', 'DRIVER');
INSERT INTO app.trip (id, tenant_id, vehicle_id, user_id, started_at)
VALUES (md5('p18-trip')::uuid, '11111111-1111-1111-1111-111111111111', md5('p18-horse')::uuid,
        md5('p18-driver')::uuid, now() + interval '1 second');
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P18: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::uuid::text, true);
  -- Two starts for one motive serialise on its row; the loser meets an open
  -- trip that started after its own now (spec, Starting and ending a trip).
  got := NULL;
  BEGIN
    PERFORM app.start_trip(md5('p18-horse')::uuid, md5('driver3')::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    got := got || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM 'TY028 this unit or driver went on another trip while this one was being started; refresh and try again' THEN
    RAISE EXCEPTION 'FAIL P18: a start that lost the race answered %', COALESCE(got, 'with a trip');
  END IF;
  got := NULL;
  BEGIN
    PERFORM app.end_trip(md5('p18-trip')::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    got := got || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM 'TY028 this trip started after this request began; refresh and try again' THEN
    RAISE EXCEPTION 'FAIL P18: ending a trip that started after the request answered %', COALESCE(got, 'with an end');
  END IF;
  RAISE NOTICE 'PASS  P18 a trip dated after the caller''s now refuses a start on its motive and its own end as a race lost';
END $$;
ROLLBACK;

\echo '== P19. TYRE-326: an open task history left carrying a reason or a citation is not re-judged by an edit that changes neither state nor citation, cannot be cancelled while it cites, and a capture still closes it, by name and by the sweep (FR-INS-052, U150)'
BEGIN;
INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
SELECT md5('p19-horse')::uuid, x.tenant_id, 'P19-H', 'P19H GP', x.configuration_id, 'HORSE', 'ACTIVE'
  FROM app.vehicle x WHERE x.id = md5('veh1')::uuid;
INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
VALUES (md5('p19-driver')::uuid, '11111111-1111-1111-1111-111111111111', 'p19-driver@example.invalid', 'P19 Driver', 'DRIVER');
INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
VALUES ('11111111-1111-1111-1111-111111111111', md5('p19-horse')::uuid, md5('p19-driver')::uuid, now() - interval '1 hour');
ALTER TABLE app.inspection_task DISABLE TRIGGER inspection_task_closes_once;
INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, created_at, cancelled_reason, completed_inspection_id)
SELECT x.id, t.id, md5('p19-horse')::uuid,
       ((app.tenant_today(t.timezone) + 1)::timestamp AT TIME ZONE t.timezone) - interval '1 microsecond',
       now() - interval '12 hours', x.reason, x.cite
  FROM app.tenant t,
       (VALUES (md5('p19-named')::uuid, 'stale', NULL::uuid),
               (md5('p19-swept')::uuid, NULL, md5('insp1')::uuid)) x(id, reason, cite)
 WHERE t.id = '11111111-1111-1111-1111-111111111111';
ALTER TABLE app.inspection_task ENABLE TRIGGER inspection_task_closes_once;
SET LOCAL ROLE app_login;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        horse constant uuid := md5('p19-horse')::uuid;
        res record; got text;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P19: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  IF (SELECT t.tgenabled FROM pg_trigger t
       WHERE t.tgrelid = 'app.inspection_task'::regclass
         AND t.tgname = 'inspection_task_closes_once') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'FAIL P19: inspection_task_closes_once did not come back enabled';
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('p19-driver')::uuid::text, true);
  -- The citation rule judges an open row only as its state or citation
  -- changes, so an edit of neither, as the down's back-fill is, passes.
  BEGIN
    UPDATE app.inspection_task SET cancelled_reason = NULL WHERE id = md5('p19-swept')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL P19: an edit of neither state nor citation re-judged a stale citation: % %', SQLSTATE, SQLERRM;
  END;
  -- A cancel is a change of state, so it is judged, and refused while the
  -- citation stands (the cost the second re-review's fix records).
  got := NULL;
  BEGIN
    UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = 'P19' WHERE id = md5('p19-swept')::uuid;
  EXCEPTION WHEN OTHERS THEN
    got := SQLSTATE || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM 'TY018 this inspection task is cancelled; only a completed task cites a completing inspection' THEN
    RAISE EXCEPTION 'FAIL P19: cancelling an open task that carries a stale citation answered %', COALESCE(got, 'with a cancel');
  END IF;
  -- The reason rule judges a change to the reason alone, never a close, so
  -- the driver's capture lands.
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', horse,
    'started_at', now() - interval '10 minutes', 'submitted_at', now(),
    'task_id', md5('p19-named')::uuid,
    'readings', (SELECT jsonb_build_array(jsonb_build_object(
                          'vehicle_id', horse, 'position_id', p.id, 'pressure_kpa', 800,
                          'treads', jsonb_build_array(8.0, 8.0, 8.0)))
                   FROM app.position p JOIN app.vehicle v ON v.configuration_id = p.configuration_id
                  WHERE v.id = horse AND NOT p.is_spare
                  ORDER BY p.sequence LIMIT 1)));
  IF res.created IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL P19: the capture answered created %', res.created;
  END IF;
  SELECT string_agg(k.state::text || ':' || (k.completed_inspection_id = res.inspection_id)::text, ',' ORDER BY o.ord) INTO got
    FROM app.inspection_task k
    JOIN (VALUES (md5('p19-named')::uuid, 1), (md5('p19-swept')::uuid, 2)) o(id, ord) ON o.id = k.id;
  IF got IS DISTINCT FROM 'COMPLETED:true,COMPLETED:true' THEN
    RAISE EXCEPTION 'FAIL P19: the named and swept tasks read %, not COMPLETED:true,COMPLETED:true', got;
  END IF;
  RAISE NOTICE 'PASS  P19 a stale citation is not re-judged by an edit of neither state nor citation and refuses a cancel, and a capture closes tasks carrying a stale reason or citation, by name and by the sweep';
END $$;
ROLLBACK;

\echo '== P20. TYRE-472, suite 34 (b) to (e): a trip overlaps no other on its unit or its driver, one driver per motive (U143), back to back is accepted, and a probe of another tenant''s trip answers the same inside it and outside it (staged here: its trips overlap or are dated in the past)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '11111111-1111-1111-1111-111111111111';
  h     constant uuid := md5('t34h')::uuid;
  cfg   uuid;
  got   text;
  n2    int;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL P20 (34): the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', t_id::text, true);
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P20 (34): the probe runs as %, not app_writer', current_user; END IF;

  -- (b) A second open trip on a unit or for a driver multiplies the unit
  -- through every coverage read. Melusi's fixture trip on HORSE is open, so
  -- either EXCLUDE may answer first.
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
         VALUES (t_id, md5('veh1')::uuid, md5('driver1')::uuid, now());
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
  END;
  IF got IS NULL OR got NOT IN ('trip_vehicle_no_overlap', 'trip_driver_no_overlap') THEN
    RAISE EXCEPTION 'FAIL P20 (34b): a duplicate open trip was answered by %, not a trip EXCLUDE',
      COALESCE(got, 'an accepted row');
  END IF;

  -- (c) One driver per motive at an instant (U143 closed OI-32), and one
  -- motive per driver. Sipho's fixture trip on HORSE ended in 2025, so only
  -- the unit's key can refuse him.
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
         VALUES (t_id, md5('veh1')::uuid, md5('driver3')::uuid, now());
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
  END;
  IF got IS DISTINCT FROM 'trip_vehicle_no_overlap' THEN
    RAISE EXCEPTION 'FAIL P20 (34c): a second driver on HORSE was answered by %, not trip_vehicle_no_overlap',
      COALESCE(got, 'an accepted row');
  END IF;

  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P20 (34): the probe runs as %, so RLS is not on trial', current_user; END IF;
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (h, t_id, 'T34-H', 'T34 GP', cfg, 'HORSE', 'ACTIVE');
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P20 (34): the probe runs as %, not app_writer', current_user; END IF;
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
         VALUES (t_id, h, md5('driver1')::uuid, now());
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
  END;
  IF got IS DISTINCT FROM 'trip_driver_no_overlap' THEN
    RAISE EXCEPTION 'FAIL P20 (34c): Melusi on a second motive was answered by %, not trip_driver_no_overlap',
      COALESCE(got, 'an accepted row');
  END IF;

  -- (d) Back to back is not an overlap: '[)' lets one trip end at the instant
  -- the next starts.
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
       VALUES (t_id, h, md5('driver3')::uuid, now() - interval '2 hours', now() - interval '1 hour');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
       VALUES (t_id, h, md5('driver3')::uuid, now() - interval '1 hour');

  -- (e) A probe of another tenant's trip answers the same inside it and
  -- outside it. The composite FK refuses both probes with 23503, and the
  -- EXCLUDE keys lead with tenant_id, so neither answers first (suite
  -- section 37). The uuids are hard-coded since the probe cannot see what it
  -- probes for, so the precondition is checked rather than trusted: a quiet
  -- seed change would otherwise leave case (e) discriminating on nothing
  -- while still printing PASS.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO n2 FROM app.trip tr JOIN app.tenant tn ON tn.id = tr.tenant_id
   WHERE tr.id = md5('t2trip1')::uuid
     AND tr.vehicle_id = md5('t2veh1')::uuid
     AND tr.user_id = md5('driver2')::uuid
     AND tr.started_at = ('2026-01-01'::timestamp AT TIME ZONE tn.timezone)
     AND tr.ended_at IS NULL;
  IF n2 <> 1 THEN
    RAISE EXCEPTION 'FAIL P20 (34e): the tenant-2 trip case (e) probes for is absent or moved; the probes below would pass vacuously';
  END IF;
  PERFORM set_config('app.tenant_id', t_id::text, true);

  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
         VALUES (t_id, md5('t2veh1')::uuid, md5('driver2')::uuid, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM '23503' THEN
    RAISE EXCEPTION 'FAIL P20 (34e): a probe inside another tenant''s trip answered % (expected 23503, as outside it), so a probe tells inside from outside', COALESCE(got, 'success');
  END IF;

  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
         VALUES (t_id, md5('t2veh1')::uuid, md5('driver2')::uuid, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM '23503' THEN
    RAISE EXCEPTION 'FAIL P20 (34e): a probe outside another tenant''s trip answered % (expected 23503)', COALESCE(got, 'success');
  END IF;

  RAISE NOTICE 'PASS  P20 (34) trips overlap neither on a unit nor for a driver, one driver per motive (U143), back to back is accepted, and a probe of another tenant''s trip answers the same inside it and outside it';
END $$;
ROLLBACK;

\echo '== P21. TYRE-472, suite 76c: a trip ends once, by its end columns, at the server''s now and by the bound actor, and an ended trip never changes (staged here: its trips started an hour back, which no function writes) (FR-VEH-007, rule 3, TY028)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  ctl constant uuid := md5('t76c')::uuid;
  tr1 uuid; tr2 uuid;
  row_ app.trip;
  n int; st text; msg text;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P21 (76c): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', ctl::text, true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, md5('t76h1')::uuid, md5('t76d1')::uuid, now() - interval '1 hour') RETURNING id INTO tr1;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, md5('t76h2')::uuid, md5('t76d2')::uuid, now() - interval '1 hour') RETURNING id INTO tr2;
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P21 (76c): the probe runs as %, not app_writer', current_user; END IF;

  UPDATE app.trip SET ended_at = now(), ended_by = ctl WHERE id = tr1;
  SELECT * INTO row_ FROM app.trip WHERE id = tr1;
  IF row_.ended_at IS DISTINCT FROM now() OR row_.ended_by IS DISTINCT FROM ctl
     OR row_.updated_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL P21 (76c): the end read back ended_at %, ended_by %, updated_by %',
      row_.ended_at, row_.ended_by, row_.updated_by;
  END IF;
  -- app_writer files audit entries and reads none.
  RESET ROLE;
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P21 (76c): the probe runs as %, so RLS is not on trial', current_user; END IF;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'trip' AND entity_id = tr1 AND action = 'UPDATE' AND actor_id = ctl;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P21 (76c): the end filed % UPDATE audit entries under the controller, not one', n;
  END IF;
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P21 (76c): the probe runs as %, not app_writer', current_user; END IF;

  FOR st, msg IN
    SELECT * FROM (VALUES
      (format('UPDATE app.trip SET ended_at = now() WHERE id = %L', tr1),
       'TY028 an ended trip is never changed'),
      (format('UPDATE app.trip SET ended_at = NULL WHERE id = %L', tr1),
       'TY028 an ended trip is never changed'),
      (format('UPDATE app.trip SET ended_by = %L WHERE id = %L', ctl, tr2),
       'TY028 an open trip can only be ended, never edited'),
      (format('UPDATE app.trip SET ended_at = now() - interval ''1 minute'' WHERE id = %L', tr2),
       'TY028 a trip ends at the server''s now, never earlier or later'),
      (format('UPDATE app.trip SET ended_at = started_at WHERE id = %L', tr2),
       'TY028 a trip ends at the server''s now, never earlier or later'),
      (format('UPDATE app.trip SET ended_at = started_at - interval ''1 minute'' WHERE id = %L', tr2),
       'TY028 a trip ends at the server''s now, never earlier or later'),
      (format('UPDATE app.trip SET ended_at = now() + interval ''1 minute'' WHERE id = %L', tr2),
       'TY028 a trip ends at the server''s now, never earlier or later')
    ) v(s, m)
  LOOP
    DECLARE got_st text; got_msg text; got_con text;
    BEGIN
      BEGIN
        EXECUTE st;
        RAISE EXCEPTION 'FAIL P21 (76c): % was accepted', st;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS got_st = RETURNED_SQLSTATE, got_msg = MESSAGE_TEXT, got_con = CONSTRAINT_NAME;
      END;
      IF got_msg LIKE 'FAIL P21 (76c):%' THEN
        RAISE EXCEPTION '%', got_msg;
      END IF;
      IF (got_st || ' ' || CASE WHEN got_st IN ('23514', '23503') THEN got_con ELSE got_msg END) IS DISTINCT FROM msg THEN
        RAISE EXCEPTION 'FAIL P21 (76c): % answered % %, not %', st, got_st, got_msg, msg;
      END IF;
    END;
  END LOOP;
  SELECT * INTO row_ FROM app.trip WHERE id = tr2;
  IF row_.ended_at IS NOT NULL OR row_.ended_by IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P21 (76c): a refused edit left the open trip ended at % by %', row_.ended_at, row_.ended_by;
  END IF;
  -- The ender is the bound actor, whoever the caller names.
  UPDATE app.trip SET ended_at = now(), ended_by = md5('t76d1')::uuid WHERE id = tr2;
  SELECT * INTO row_ FROM app.trip WHERE id = tr2;
  IF row_.ended_at IS DISTINCT FROM now() OR row_.ended_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL P21 (76c): an end naming another ender read back ended_at %, ended_by %, not now by the controller',
      row_.ended_at, row_.ended_by;
  END IF;
  RAISE NOTICE 'PASS  P21 (76c) a trip ends once by its end columns, at the server''s now and by the bound actor, and an ended trip is frozen';
END $$;
ROLLBACK;

\echo '== P22. TYRE-472, suite 76c: a trip or a nomination that breaks the CHECK, a NOT NULL, or a composite FK by naming another fleet''s user is refused by that constraint, by its code and name (staged here: no function writes such a row) (rule 1, FR-TEN-004)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  ctl constant uuid := md5('t76c')::uuid;
  kn uuid;
  st text; msg text;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P22 (76c): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', ctl::text, true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, md5('t76h3')::uuid, now() + interval '3 days') RETURNING id INTO kn;
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P22 (76c): the probe runs as %, not app_writer', current_user; END IF;
  FOR st, msg IN
    SELECT * FROM (VALUES
      (format('INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at) VALUES (%L, %L, %L, now(), now() - interval ''1 minute'')',
              bac, md5('t76h3')::uuid, md5('t76d3')::uuid),
       '23514 trip_ends_after_start'),
      -- Another fleet's driver answers with the FK's name.
      (format('INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at) VALUES (%L, %L, %L, now())',
              bac, md5('t76h3')::uuid, md5('driver2')::uuid),
       '23503 trip_tenant_id_user_id_fkey'),
      -- No FK refuses a NULL key; NOT NULL does.
      (format('INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at) VALUES (%L, %L, NULL, now())',
              bac, md5('t76h3')::uuid),
       '23502 null value in column "user_id" of relation "trip" violates not-null constraint'),
      (format('INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at) VALUES (%L, NULL, %L, now())',
              bac, md5('t76d3')::uuid),
       '23502 null value in column "vehicle_id" of relation "trip" violates not-null constraint')
    ) v(s, m)
  LOOP
    DECLARE got_st text; got_msg text; got_con text;
    BEGIN
      BEGIN
        EXECUTE st;
        RAISE EXCEPTION 'FAIL P22 (76c): % was accepted', st;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS got_st = RETURNED_SQLSTATE, got_msg = MESSAGE_TEXT, got_con = CONSTRAINT_NAME;
      END;
      IF got_msg LIKE 'FAIL P22 (76c):%' THEN
        RAISE EXCEPTION '%', got_msg;
      END IF;
      IF (got_st || ' ' || CASE WHEN got_st IN ('23514', '23503') THEN got_con ELSE got_msg END) IS DISTINCT FROM msg THEN
        RAISE EXCEPTION 'FAIL P22 (76c): % answered % %, not %', st, got_st, got_msg, msg;
      END IF;
    END;
  END LOOP;

  FOR st, msg IN
    SELECT * FROM (VALUES
      -- Another fleet's nominee answers with the FK's name, and no FK
      -- refuses a NULL key; NOT NULL does. kn holds no nomination at now, so
      -- the one-per-instant key cannot answer first.
      (format('INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id) VALUES (%L, %L, %L)',
              bac, kn, md5('driver2')::uuid),
       '23503 inspection_task_nomination_tenant_id_user_id_fkey'),
      (format('INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id) VALUES (%L, NULL, %L)',
              bac, md5('t76d3')::uuid),
       '23502 null value in column "task_id" of relation "inspection_task_nomination" violates not-null constraint'),
      (format('INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id) VALUES (%L, %L, NULL)',
              bac, kn),
       '23502 null value in column "user_id" of relation "inspection_task_nomination" violates not-null constraint')
    ) v(s, m)
  LOOP
    DECLARE got_st text; got_msg text; got_con text;
    BEGIN
      BEGIN
        EXECUTE st;
        RAISE EXCEPTION 'FAIL P22 (76c): % was accepted', st;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS got_st = RETURNED_SQLSTATE, got_msg = MESSAGE_TEXT, got_con = CONSTRAINT_NAME;
      END;
      IF got_msg LIKE 'FAIL P22 (76c):%' THEN
        RAISE EXCEPTION '%', got_msg;
      END IF;
      IF (got_st || ' ' || CASE WHEN got_st = '23503' THEN got_con ELSE got_msg END) IS DISTINCT FROM msg THEN
        RAISE EXCEPTION 'FAIL P22 (76c): % answered % %, not %', st, got_st, got_msg, msg;
      END IF;
    END;
  END LOOP;
  RAISE NOTICE 'PASS  P22 (76c) a trip or nomination that breaks the CHECK, a NOT NULL or a composite FK is refused by that constraint';
END $$;
ROLLBACK;

\echo '== P23. TYRE-472, suite 76e: the responsible driver: the trip that covers the unit, else the task''s live nominee, else the motive''s for a coupled trailer, else nobody; a nomination lapses at the first covered instant after it and stays lapsed; only while the task is outstanding (FR-INS-053 as amended; as BAC, rolled back) (staged here: its trips and nominations are dated in the past)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; h2 constant uuid := md5('t76h2')::uuid;
  h3 constant uuid := md5('t76h3')::uuid; h4 constant uuid := md5('t76h4')::uuid;
  h5 constant uuid := md5('t76h5')::uuid; h6 constant uuid := md5('t76h6')::uuid;
  t1 constant uuid := md5('t76t1')::uuid; t2 constant uuid := md5('t76t2')::uuid;
  t3 constant uuid := md5('t76t3')::uuid;
  d1 constant uuid := md5('t76d1')::uuid; d2 constant uuid := md5('t76d2')::uuid;
  d3 constant uuid := md5('t76d3')::uuid; d4 constant uuid := md5('t76d4')::uuid;
  one constant text := 'T76 Driver One'; two constant text := 'T76 Driver Two';
  three constant text := 'T76 Driver Three'; four constant text := 'T76 Driver Four';
  rig uuid;
  k_h1 uuid; k_t1 uuid; k_h2 uuid; k_h3 uuid; k_t2 uuid; k_t3 uuid; k_h4 uuid; k_h4b uuid;
  k_h5 uuid; k_h1d uuid; k_h6 uuid; k_h2c uuid; k_now uuid;
  due timestamptz;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();

  -- Rule 1: H1 tows T1 from ten hours ago, and D1's trip on H1 opened five
  -- hours ago.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '10 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h1, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h1;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, t1, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_t1;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 1', k_h1, now(), one || '/TRIP');
  PERFORM pg_temp.t76_expect('P23 (76e) rule 1', k_t1, now(), one || '/TRIP');
  PERFORM pg_temp.t76_expect('P23 (76e) rule 1', k_h1, now() - interval '6 hours', 'nobody/-');
  PERFORM pg_temp.t76_expect('P23 (76e) rule 1', k_t1, now() - interval '6 hours', 'nobody/-');

  -- Rule 2, and a re-nomination: the newest nomination made by then.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h2;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h2, d2, now() - interval '2 hours'), (bac, k_h2, d3, now() - interval '1 hour');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 2', k_h2, now() - interval '3 hours', 'nobody/-');
  PERFORM pg_temp.t76_expect('P23 (76e) rule 2', k_h2, now() - interval '90 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('P23 (76e) rule 2', k_h2, now(), three || '/NOMINATION');

  -- A trip that starts after a nomination takes it over, and the nomination
  -- does not come back when the trip ends (spec, decision 6).
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h3, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h3;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h3, d2, now() - interval '4 hours');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h3, d3, now() - interval '3 hours', now() - interval '2 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a trip', k_h3, now() - interval '210 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a trip', k_h3, now() - interval '150 minutes', three || '/TRIP');
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a trip', k_h3, now(), 'nobody/-');

  -- Coupling to a motive on a trip is the same takeover seen from the
  -- trailer: T2 joins H1's rig for an hour and leaves it again. Each rig is
  -- planted open, given its members, then ended, since an ended rig takes
  -- none (000037).
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, t2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_t2;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_t2, d2, now() - interval '4 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  UPDATE app.combination SET effective_to = now() - interval '3 hours' WHERE id = rig;
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '3 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2), (bac, rig, t2, 3);
  UPDATE app.combination SET effective_to = now() - interval '2 hours' WHERE id = rig;
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '2 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a coupling', k_t2, now() - interval '210 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a coupling', k_t2, now() - interval '150 minutes', one || '/TRIP');
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a coupling', k_t2, now(), 'nobody/-');
  PERFORM pg_temp.t76_expect('P23 (76e) lapse by a coupling', k_t1, now(), one || '/TRIP');

  -- Rule 3: T3 is coupled to H4, which is on no trip, so T3's task goes to
  -- the newest live nomination across H4's outstanding tasks.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h4, now() - interval '10 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h4, 1), (bac, rig, t3, 2);
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, t3, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_t3;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h4, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h4;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h4, d2, now() - interval '1 hour');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 3', k_t3, now(), two || '/MOTIVE_NOMINATION');
  -- The active flag keeps no history, so reading it would rewrite past
  -- attribution (spec, Nominations).
  UPDATE app.app_user SET active = false WHERE id = d2;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 3 ignores the active flag', k_t3, now(), two || '/MOTIVE_NOMINATION');
  UPDATE app.app_user SET active = true WHERE id = d2;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h4, now() + interval '2 days', now() - interval '12 hours') RETURNING id INTO k_h4b;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h4b, d3, now() - interval '30 minutes');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 3 takes the newest across the motive''s tasks', k_t3, now(), three || '/MOTIVE_NOMINATION');

  -- Rule 2 before rule 3: the trailer's own nominee wins.
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_t3, d1, now() - interval '20 minutes');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM pg_temp.t76_expect('P23 (76e) rule 2 before rule 3', k_t3, now(), one || '/NOMINATION');

  -- At the due instant, which the amended criterion 4 reads.
  due := now() - interval '1 hour';
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h5, due, now() - interval '12 hours') RETURNING id INTO k_h5;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h5, d2, now() - interval '11 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h1, due, now() - interval '12 hours') RETURNING id INTO k_h1d;
  PERFORM pg_temp.t76_expect('P23 (76e) at the due instant', k_h5, due, two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('P23 (76e) at the due instant', k_h1d, due, one || '/TRIP');

  -- Nobody.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h6, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h6;
  PERFORM pg_temp.t76_expect('P23 (76e) nobody', k_h6, now(), 'nobody/-');

  -- Not outstanding: each would answer a driver but for the bound, as the
  -- control instants show.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '3 days', now() - interval '12 hours') RETURNING id INTO k_h2c;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h2c, d4, now() - interval '2 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P23 (76e): the probe runs as %, so RLS is not on trial', current_user; END IF;
  UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = '76e' WHERE id = k_h2c;
  PERFORM pg_temp.t76_expect('P23 (76e) a cancelled task', k_h2c, now(), 'nobody/-');
  PERFORM pg_temp.t76_expect('P23 (76e) a cancelled task, before its close', k_h2c, now() - interval '1 hour', four || '/NOMINATION');
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, h1, now() + interval '3 days') RETURNING id INTO k_now;
  PERFORM pg_temp.t76_expect('P23 (76e) a task created now', k_now, now() - interval '1 minute', 'nobody/-');
  PERFORM pg_temp.t76_expect('P23 (76e) a task created now, at now', k_now, now(), one || '/TRIP');
  RAISE NOTICE 'PASS  P23 (76e) each rule answers in order, a nomination lapses at the first covered instant after it by a trip or a coupling and stays lapsed, rule 3 ignores the active flag, and nothing answers outside the task''s outstanding span';
END $$;
ROLLBACK;
\echo '== P24. TYRE-472, suite 76h: a trip or task closed mid-capture still passes, a unit never held does not, a nominee reaches the motive''s rig until a trip takes the task over, and every unit the payload attributes is checked (FR-OFF-015 as amended, FR-AUT-005; as BAC, each case rolled back) (staged here: its trips and nominations are dated in the past)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '2 hours', now() - interval '30 minutes');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '40 minutes', now() - interval '10 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a trip closed between start and submit refused the capture';
  END IF;
  IF app.user_could_capture(d1, h1, now() - interval '20 minutes', now() - interval '10 minutes') THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the control window after the trip ended passed';
  END IF;
  RAISE NOTICE 'PASS  P24 (76h) a trip closed between start and submit passes; a window wholly after it does not';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h2 constant uuid := md5('t76h2')::uuid; d2 constant uuid := md5('t76d2')::uuid;
  d3 constant uuid := md5('t76d3')::uuid;
  k uuid; p jsonb; r record;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k, d2, now() - interval '2 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = '76h' WHERE id = k;
  p := pg_temp.t76_capture(ARRAY[h2], now() - interval '40 minutes', now()) || jsonb_build_object('task_id', k);
  IF NOT pg_temp.t76_could(p, d2) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a task cancelled between start and submit refused its nominee';
  END IF;
  IF app.user_could_capture(d2, h2, now(), now()) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the nominee of a cancelled task can capture after the cancel';
  END IF;
  -- Never held: D3 had no trip and no nomination on H2.
  IF app.user_could_capture(d3, h2, now() - interval '1 hour', now()) OR pg_temp.t76_could(p, d3) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a driver who never held the unit passes';
  END IF;
  PERFORM set_config('app.actor_id', d2::text, true);
  SELECT * INTO r FROM app.submit_inspection(p);
  IF NOT r.created THEN RAISE EXCEPTION 'FAIL P24 (76h): the nominee''s submit did not land'; END IF;
  SELECT t.state::text AS state, t.completed_inspection_id INTO r FROM app.inspection_task t WHERE t.id = k;
  IF r.state <> 'CANCELLED' OR r.completed_inspection_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the cancelled task reads % citing % after the submit', r.state, r.completed_inspection_id;
  END IF;
  RAISE NOTICE 'PASS  P24 (76h) a task cancelled mid-capture passes its nominee and stays cancelled; a driver who never held the unit does not pass';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; h4 constant uuid := md5('t76h4')::uuid;
  t3 constant uuid := md5('t76t3')::uuid;
  d2 constant uuid := md5('t76d2')::uuid; d3 constant uuid := md5('t76d3')::uuid;
  rig uuid; k uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h4, now() - interval '10 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h4, 1), (bac, rig, t3, 2);
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h4, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k;
  RESET ROLE;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k, d2, now() - interval '1 hour');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF NOT app.user_could_capture(d2, h4, now(), now()) OR NOT app.user_could_capture(d2, t3, now(), now())
     OR app.user_could_capture(d2, h1, now(), now()) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a motive''s nominee does not reach exactly the motive and its coupled trailer';
  END IF;
  -- A trip then takes the nomination over (spec, decision 6).
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h4, d3, now() - interval '30 minutes');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF app.user_could_capture(d2, h4, now() - interval '20 minutes', now()) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the nominee passes a window wholly after a trip took the task over';
  END IF;
  IF NOT app.user_could_capture(d2, h4, now() - interval '50 minutes', now()) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the nominee fails a window that began before the trip took over';
  END IF;
  RAISE NOTICE 'PASS  P24 (76h) a motive''s nominee captures it and its coupled trailers until a trip takes the task over';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; h2 constant uuid := md5('t76h2')::uuid;
  h4 constant uuid := md5('t76h4')::uuid;
  t1 constant uuid := md5('t76t1')::uuid; t2 constant uuid := md5('t76t2')::uuid;
  t3 constant uuid := md5('t76t3')::uuid;
  d1 constant uuid := md5('t76d1')::uuid;
  rig uuid; old_rig uuid; h4_rig uuid; p jsonb;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P24 (76h): the probe runs as %, so RLS is not on trial', current_user; END IF;
  -- A partial window across an uncouple: T2 was towed from three hours ago
  -- to two hours ago.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '3 hours') RETURNING id INTO old_rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, old_rig, h1, 1), (bac, old_rig, t2, 2);
  UPDATE app.combination SET effective_to = now() - interval '2 hours' WHERE id = old_rig;
  IF NOT app.user_could_capture(d1, t2, now() - interval '150 minutes', now() - interval '60 minutes') THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a window spanning the uncouple refused the trailer held for part of it';
  END IF;
  IF app.user_could_capture(d1, t2, now() - interval '90 minutes', now() - interval '60 minutes') THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a window wholly after the uncouple passed the trailer';
  END IF;

  -- Every unit the payload attributes is checked (spec, Capture).
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '90 minutes') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  p := pg_temp.t76_capture(ARRAY[h1, t1], now() - interval '30 minutes', now());
  IF NOT pg_temp.t76_could(p, d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a capture of the trip''s motive and its trailer was refused';
  END IF;
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1, t1, h2], now() - interval '30 minutes', now()), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a reading on a unit the driver never held passed';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('absent_spares', jsonb_build_array(
         jsonb_build_object('vehicle_id', h2, 'position_id', gen_random_uuid()))), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): an absent spare on a unit the driver never held passed';
  END IF;

  -- combination_id names a rig of the payload's unit, at any time: a tab's
  -- cached context can name a rig a trip start has since re-formed.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h4, now() - interval '10 hours') RETURNING id INTO h4_rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, h4_rig, h4, 1), (bac, h4_rig, t3, 2);
  IF NOT pg_temp.t76_could(p || jsonb_build_object('combination_id', rig), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the payload unit''s open rig was refused';
  END IF;
  IF NOT pg_temp.t76_could(p || jsonb_build_object('combination_id', old_rig), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): the payload unit''s rig ended before the capture was refused';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('combination_id', h4_rig), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): a rig headed by another unit passed';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('combination_id', gen_random_uuid()), d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): an unknown rig passed';
  END IF;
  IF NOT pg_temp.t76_could(p || '{"combination_id": null}'::jsonb, d1) THEN
    RAISE EXCEPTION 'FAIL P24 (76h): an explicit null combination_id, which every solo capture sends, was refused';
  END IF;
  RAISE NOTICE 'PASS  P24 (76h) a window across an uncouple passes the trailer, every attributed unit is checked, and combination_id names a rig of the payload''s unit';
END $$;
ROLLBACK;

\echo '== P25. TYRE-472, suite 76i: a capture longer than the setting is accepted on its last part, a driver who held the unit only before the judged window is refused, and a started_at after submitted_at is judged at submitted_at, beside its control (U148, rule 5, FR-OFF-013; as BAC, each case rolled back) (staged here: its trips are dated in the past)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  -- The trip covers the capture's last five hours only.
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now()), d1) THEN
    RAISE EXCEPTION 'FAIL P25 (76i): a capture longer than the setting was refused though the driver held the unit at its end';
  END IF;
  RAISE NOTICE 'PASS  P25 (76i) a capture longer than the setting is accepted on its last part';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '14 hours', now() - interval '13 hours');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now()), d1) THEN
    RAISE EXCEPTION 'FAIL P25 (76i): a driver who held the unit only before the judged window passed';
  END IF;
  RAISE NOTICE 'PASS  P25 (76i) a driver who held the unit only before the judged window is refused';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '1 hour', now() - interval '10 minutes');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '2 minutes', now() - interval '5 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL P25 (76i): a started_at after submitted_at was judged at started_at, not at submitted_at';
  END IF;
  RAISE NOTICE 'PASS  P25 (76i) a started_at after submitted_at is judged at submitted_at, after the trip ended';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  RESET ROLE;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '1 hour');
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P25 (76i): the probe runs as %, so RLS is not on trial', current_user; END IF;
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '2 minutes', now() - interval '5 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL P25 (76i): the control, the same capture with the trip open, was refused';
  END IF;
  RAISE NOTICE 'PASS  P25 (76i) the control: the same capture passes with the trip open at submitted_at';
END $$;
ROLLBACK;

\echo '== P26. TYRE-472: the app_writer shape check fails when app_writer owns a table, bypasses RLS, holds a grant off its list or lacks one on it, or has the app login as a member, and passes with nothing staged (ADR-0024)'
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P26: with nothing staged the shape check reads %', f;
  END IF;
  RAISE NOTICE 'PASS  P26 with nothing staged app_writer has no fault';
END $$;
ROLLBACK;

BEGIN;
CREATE TABLE app.p26_owned (id int);
ALTER TABLE app.p26_owned OWNER TO app_writer;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NULL OR position('app_writer owns relation app.p26_owned' IN f) = 0 THEN
    RAISE EXCEPTION 'FAIL P26: app_writer owning app.p26_owned read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P26 a table app_writer owns is named';
END $$;
ROLLBACK;

BEGIN;
ALTER ROLE app_writer BYPASSRLS;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NULL OR position('app_writer has rolbypassrls' IN f) = 0 THEN
    RAISE EXCEPTION 'FAIL P26: app_writer with BYPASSRLS read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P26 an app_writer that bypasses RLS is named';
END $$;
ROLLBACK;

BEGIN;
GRANT DELETE ON app.trip TO app_writer;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NULL OR position('extra: table app.trip DELETE' IN f) = 0 THEN
    RAISE EXCEPTION 'FAIL P26: a DELETE grant on app.trip read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P26 a grant off the list is named as extra';
END $$;
ROLLBACK;

BEGIN;
REVOKE INSERT ON app.audit_log FROM app_writer;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NULL OR position('missing: table app.audit_log INSERT' IN f) = 0 THEN
    RAISE EXCEPTION 'FAIL P26: app_writer without INSERT on app.audit_log read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P26 a grant on the list and not held is named as missing';
END $$;
ROLLBACK;

BEGIN;
GRANT app_writer TO app_login;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P26: the probe runs as %', current_user; END IF;
  f := pg_temp.app_writer_faults('app_login');
  IF f IS NULL OR position('app_login is a member of app_writer' IN f) = 0 THEN
    RAISE EXCEPTION 'FAIL P26: app_login as a member of app_writer read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P26 the app login as a member is named';
END $$;
ROLLBACK;

\echo '== P27. TYRE-472: row security binds app_writer: bound to BAC it reads none of Second Fleet''s trips, nominations, units, users or rigs and writes neither a trip nor a nomination for it, and the same probes with BYPASSRLS read and write them (rule 1, FR-TEN-004, ADR-0024)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  t2  constant uuid := '22222222-2222-2222-2222-222222222222';
  rig uuid;
BEGIN
  -- Each fleet holds a row of every table the read covers. The fixture has
  -- no nomination and Second Fleet no rig, so those are staged.
  PERFORM set_config('app.actor_id', '', true);
  IF NOT EXISTS (SELECT 1 FROM app.inspection_task_nomination WHERE tenant_id = bac) THEN
    INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at)
    VALUES (md5('p27-bac-task')::uuid, bac, md5('veh1')::uuid, now() + interval '2 days');
    INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
    VALUES (bac, md5('p27-bac-task')::uuid, md5('driver1')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.inspection_task_nomination WHERE tenant_id = t2) THEN
    INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at)
    VALUES (md5('p27-t2-task')::uuid, t2, md5('t2veh1')::uuid, now() + interval '2 days');
    INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
    VALUES (t2, md5('p27-t2-task')::uuid, md5('driver2')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.combination WHERE tenant_id = t2) THEN
    INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
    VALUES (t2, md5('t2veh1')::uuid, now() - interval '1 day') RETURNING id INTO rig;
    INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
    VALUES (t2, rig, md5('t2veh1')::uuid, 1);
  END IF;
  -- The probe rows: a free horse, a driver on no trip, and a task on that
  -- horse with no nomination, so only row security can refuse the writes.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  SELECT md5('p27-horse')::uuid, t2, 'P27-H', 'P27H GP', v.configuration_id, 'HORSE', 'ACTIVE'
    FROM app.vehicle v WHERE v.id = md5('t2veh1')::uuid;
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (md5('p27-driver')::uuid, t2, 'p27-driver@example.invalid', 'P27 Driver', 'DRIVER');
  INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at)
  VALUES (md5('p27-task')::uuid, t2, md5('p27-horse')::uuid, now() + interval '2 days');
END $$;

DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  t2  constant uuid := '22222222-2222-2222-2222-222222222222';
  tbl text; n_t2 int; n_bac int; got text; bad text := '';
BEGIN
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P27: the probe runs as %, not app_writer', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);

  FOREACH tbl IN ARRAY ARRAY['trip', 'inspection_task_nomination', 'vehicle', 'app_user', 'combination'] LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', tbl) INTO n_t2 USING t2;
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', tbl) INTO n_bac USING bac;
    IF n_t2 <> 0 OR n_bac = 0 THEN
      bad := bad || format(' %s: Second Fleet %s, BAC %s;', tbl, n_t2, n_bac);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FAIL P27: bound to BAC, app_writer read%', bad;
  END IF;

  -- WITH CHECK on both tables, by the table's own policy: audit_log's
  -- would answer a row that got past it with the same 42501.
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id) VALUES (t2, md5('p27-horse')::uuid, md5('p27-driver')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "trip"%' THEN
    RAISE EXCEPTION 'FAIL P27: bound to BAC, app_writer''s trip for Second Fleet was answered %', COALESCE(got, 'by an accepted row');
  END IF;
  got := NULL;
  BEGIN
    INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
    VALUES (t2, md5('p27-task')::uuid, md5('p27-driver')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "inspection_task_nomination"%' THEN
    RAISE EXCEPTION 'FAIL P27: bound to BAC, app_writer''s nomination for Second Fleet was answered %', COALESCE(got, 'by an accepted row');
  END IF;
  RAISE NOTICE 'PASS  P27 bound to BAC, app_writer reads none of Second Fleet''s rows in the five tables and its trip and nomination for Second Fleet are refused by each table''s policy';

  -- The control: an owner that bypasses RLS, which ADR-0024 rejects, reads
  -- and writes Second Fleet's rows through the same probes.
  RESET ROLE;
  ALTER ROLE app_writer BYPASSRLS;
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P27: the control runs as %, not app_writer', current_user; END IF;
  bad := '';
  FOREACH tbl IN ARRAY ARRAY['trip', 'inspection_task_nomination', 'vehicle', 'app_user', 'combination'] LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', tbl) INTO n_t2 USING t2;
    IF n_t2 = 0 THEN
      bad := bad || format(' %s;', tbl);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FAIL P27: with BYPASSRLS, app_writer bound to BAC still read none of Second Fleet''s rows in%', bad;
  END IF;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id) VALUES (t2, md5('p27-horse')::uuid, md5('p27-driver')::uuid);
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
  VALUES (t2, md5('p27-task')::uuid, md5('p27-driver')::uuid);
  RAISE NOTICE 'PASS  P27 the control: with BYPASSRLS the same reads return Second Fleet''s rows and both writes land';
END $$;
ROLLBACK;

\echo '== P28. TYRE-99: app.mark_code_on_sidewall stays in the bound fleet as app_login, and row security binds app_writer on the three tables it reads and writes, beside P27''s BYPASSRLS control (rule 1, DoD 5, ADR-0024)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  t2  constant uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  -- Second Fleet is FREE, so no receive of its own is pending: its pending
  -- tyre on a receipt is staged raw. BAC's comes through the function.
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.tyre_size (id, tenant_id, name) VALUES (md5('p28-sz')::uuid, t2, 'P28 SIZE');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to) VALUES (md5('p28-pt')::uuid, t2, 'P28 NEW', 'NEW');
  INSERT INTO app.tyre_receipt (id, tenant_id, size_id, pattern_id, received_date, price_state)
  VALUES (md5('p28-rc')::uuid, t2, md5('p28-sz')::uuid, md5('p28-pt')::uuid, '2026-10-01', 'UNPRICED');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status, retread_count, new_tread_mm,
                        state, received_date, brand_pending, receipt_id)
  VALUES (md5('p28-tyre')::uuid, t2, 'P28-1', md5('p28-sz')::uuid, md5('p28-pt')::uuid, 'NEW', 0, 25.0,
          'IN_STOCK', '2026-10-01', true, md5('p28-rc')::uuid);
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
  VALUES (t2, md5('p28-tyre')::uuid, 'RECEIVED', '2026-10-01', 'IN_STOCK');
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM app.receive_tyres(pg_temp.at_depot(jsonb_build_object(
    'size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid, 'new_tread_mm', '25.0', 'received_date', '2026-10-01')));
END $$;

DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  got text;
BEGIN
  SET LOCAL ROLE app_login;
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P28: the probe runs as %, not app_login', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  got := pg_temp.t76_try(format('SELECT app.mark_code_on_sidewall(%L, NULL, NULL)', md5('p28-tyre')::uuid));
  IF got IS DISTINCT FROM 'TY012 no such tyre in this fleet' THEN
    RAISE EXCEPTION 'FAIL P28: bound to BAC, marking Second Fleet''s tyre was answered %', got;
  END IF;
  got := pg_temp.t76_try(format('SELECT app.mark_code_on_sidewall(NULL, %L, NULL)', md5('p28-rc')::uuid));
  IF got IS DISTINCT FROM 'TY012 no such receipt in this fleet' THEN
    RAISE EXCEPTION 'FAIL P28: bound to BAC, marking Second Fleet''s receipt was answered %', got;
  END IF;
  RESET ROLE;
  IF NOT (SELECT t.brand_pending FROM app.tyre t WHERE t.id = md5('p28-tyre')::uuid)
     OR EXISTS (SELECT 1 FROM app.tyre_event e WHERE e.tyre_id = md5('p28-tyre')::uuid AND e.payload ? 'marked') THEN
    RAISE EXCEPTION 'FAIL P28: after BAC''s refused markings, Second Fleet''s tyre is no longer pending or carries a marked event';
  END IF;
  RAISE NOTICE 'PASS  P28 as app_login bound to BAC, Second Fleet''s pending tyre and receipt read as no such row and stay unmarked';
END $$;

DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  t2  constant uuid := '22222222-2222-2222-2222-222222222222';
  tbl text; n_t2 int; n_bac int; n int; got text; bad text := '';
BEGIN
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P28: the probe runs as %, not app_writer', current_user; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  FOREACH tbl IN ARRAY ARRAY['tyre', 'tyre_event', 'tyre_receipt'] LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', tbl) INTO n_t2 USING t2;
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id = $1', tbl) INTO n_bac USING bac;
    IF n_t2 <> 0 OR n_bac = 0 THEN
      bad := bad || format(' %s: Second Fleet %s, BAC %s;', tbl, n_t2, n_bac);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FAIL P28: bound to BAC, app_writer read%', bad;
  END IF;
  UPDATE app.tyre SET brand_pending = false WHERE tenant_id = t2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL P28: bound to BAC, app_writer cleared % of Second Fleet''s flags', n;
  END IF;
  got := NULL;
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
    VALUES (t2, md5('p28-tyre')::uuid, 'BRANDED', now(), jsonb_build_object('display_code', 'P28-1', 'marked', true));
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "tyre_event"%' THEN
    RAISE EXCEPTION 'FAIL P28: bound to BAC, app_writer''s marked event for Second Fleet was answered %', COALESCE(got, 'by an accepted row');
  END IF;
  RAISE NOTICE 'PASS  P28 bound to BAC, app_writer reads none of Second Fleet''s tyres, events or receipts, clears none of its flags and writes no event for it';

  -- The control, as P27's: an owner that bypasses RLS reaches Second
  -- Fleet's rows through the same probes.
  RESET ROLE;
  ALTER ROLE app_writer BYPASSRLS;
  SET LOCAL ROLE app_writer;
  IF current_user <> 'app_writer' THEN RAISE EXCEPTION 'FAIL P28: the control runs as %, not app_writer', current_user; END IF;
  UPDATE app.tyre SET brand_pending = false WHERE tenant_id = t2;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P28: with BYPASSRLS, app_writer bound to BAC cleared % of Second Fleet''s flags, not 1', n;
  END IF;
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
  VALUES (t2, md5('p28-tyre')::uuid, 'BRANDED', now(), jsonb_build_object('display_code', 'P28-1', 'marked', true));
  RAISE NOTICE 'PASS  P28 the control: with BYPASSRLS the same UPDATE clears Second Fleet''s flag and the event lands';
END $$;
ROLLBACK;

\echo '== P29. TYRE-102: under a role that bypasses RLS, a retread return naming another fleet''s pattern is refused by the function''s own tenant predicate (rule 1, FR-TEN-003, U225)'
BEGIN;
DO $$
DECLARE
  bac  constant uuid := '11111111-1111-1111-1111-111111111111';
  t2   constant uuid := '22222222-2222-2222-2222-222222222222';
  d_rt constant uuid := md5('p29-rt')::uuid;
  j    constant uuid := md5('p29-job')::uuid;
  tz text; ty uuid; msg text; got text;
BEGIN
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to) VALUES (md5('p29-t2-rt')::uuid, t2, 'P29 RETREAD', 'RETREAD');
  -- An open job on a BAC casing, planted raw as plantOpenRetreadJob plants one.
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'P29 Retreaders', 'RETREADER');
  INSERT INTO app.tyre (tenant_id, display_code, size_id, pattern_id, status, retread_count, new_tread_mm,
                        state, received_date)
  VALUES (bac, 'P29-1', md5('sz1')::uuid, md5('pt1')::uuid, 'NEW', 0, 25.0, 'AT_RETREADER',
          app.tenant_today(tz) - 10)
  RETURNING id INTO ty;
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at)
  VALUES (j, bac, ty, d_rt, app.tenant_today(tz) - 5);

  -- postgres bypasses RLS, so only the function's own predicate keeps the
  -- pattern in the bound fleet.
  PERFORM set_config('app.tenant_id', bac::text, true);
  BEGIN
    PERFORM app.log_retread_return(j, app.tenant_today(tz) - 1, true, 'P29-RPT', 2500.00, 16.0, 800.00,
                                   md5('p29-t2-rt')::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF got IS DISTINCT FROM 'TY014'
     OR msg IS DISTINCT FROM 'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it' THEN
    RAISE EXCEPTION 'FAIL P29: bound to BAC, a return naming Second Fleet''s pattern was answered %',
      COALESCE(got || ' "' || msg || '"', 'by a return');
  END IF;
  SELECT (j2.returned_at IS NULL) || ':' || t.state INTO got
    FROM app.retread_job j2 JOIN app.tyre t ON t.id = j2.tyre_id WHERE j2.id = j;
  IF got IS DISTINCT FROM 'true:AT_RETREADER' THEN
    RAISE EXCEPTION 'FAIL P29: after the refused return the job reads open:state %', got;
  END IF;
  RAISE NOTICE 'PASS  P29 bound to BAC as postgres, a return naming Second Fleet''s pattern is refused and the job stays open';
END $$;
ROLLBACK;

\echo '== P30. TYRE-371: as app_job with no tenant bound, app.active_tenant_ids() lists the ACTIVE tenants and no PROVISIONING, SUSPENDED or CLOSED one; unbound, app_job reads no tenant or unit; bound to BAC it reads BAC''s units and none of Second Fleet''s, and its unit for Second Fleet is refused beside the same insert for BAC (rule 1, FR-TEN-004, ADR-0025)'
BEGIN;
INSERT INTO app.tenant (id, name, subdomain, state) VALUES
  (md5('p30-active')::uuid, 'P30 Active', 'p30-active', 'ACTIVE'),
  (md5('p30-provisioning')::uuid, 'P30 Provisioning', 'p30-provisioning', 'PROVISIONING'),
  (md5('p30-suspended')::uuid, 'P30 Suspended', 'p30-suspended', 'SUSPENDED'),
  (md5('p30-closed')::uuid, 'P30 Closed', 'p30-closed', 'CLOSED');
DO $$
DECLARE
  bac  constant uuid := '11111111-1111-1111-1111-111111111111';
  t2   constant uuid := '22222222-2222-2222-2222-222222222222';
  others constant uuid[] := ARRAY[md5('p30-provisioning')::uuid, md5('p30-suspended')::uuid, md5('p30-closed')::uuid];
  -- Read as postgres before the role changes, so it is every ACTIVE tenant.
  want constant uuid[] := ARRAY(SELECT t.id FROM app.tenant t WHERE t.state = 'ACTIVE' ORDER BY 1);
  got uuid[]; n int; m int; err text;
BEGIN
  SET LOCAL ROLE app_job;
  IF current_user <> 'app_job' THEN RAISE EXCEPTION 'FAIL P30: the probe runs as %, not app_job', current_user; END IF;
  PERFORM set_config('app.tenant_id', '', true);
  got := ARRAY(SELECT id FROM app.active_tenant_ids() id ORDER BY 1);
  IF got IS DISTINCT FROM want OR NOT md5('p30-active')::uuid = ANY (got) OR got && others THEN
    RAISE EXCEPTION 'FAIL P30: app.active_tenant_ids() listed %, not the ACTIVE tenants % (P30 Active included, none of %)',
      got, want, others;
  END IF;
  SELECT count(*) INTO n FROM app.tenant;
  SELECT count(*) INTO m FROM app.vehicle;
  IF n <> 0 OR m <> 0 THEN
    RAISE EXCEPTION 'FAIL P30: with no tenant bound app_job read % tenants and % units, not 0 and 0', n, m;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT count(*) INTO n FROM app.tenant;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P30: bound to BAC app_job read % tenants, not its own 1', n;
  END IF;
  -- The control for the unbound zero: bound, the same read finds BAC's units.
  SELECT count(*) INTO n FROM app.vehicle WHERE tenant_id = bac;
  SELECT count(*) INTO m FROM app.vehicle WHERE tenant_id = t2;
  IF n = 0 OR m <> 0 THEN
    RAISE EXCEPTION 'FAIL P30: bound to BAC app_job read % of BAC''s units and % of Second Fleet''s, not some and 0', n, m;
  END IF;
  BEGIN
    INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
    VALUES (md5('p30-t2-horse')::uuid, t2, 'P30-H', 'P30H GP', md5(t2::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE');
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS err = MESSAGE_TEXT;
  END;
  IF err IS NULL OR err NOT LIKE '%row-level security policy for table "vehicle"%' THEN
    RAISE EXCEPTION 'FAIL P30: bound to BAC, app_job''s unit for Second Fleet was answered %', COALESCE(err, 'by an accepted row');
  END IF;
  -- The control: the same insert for BAC lands (configuration read through
  -- BAC's own veh1), so the refusal above is the policy and not the grant.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  SELECT md5('p30-bac-horse')::uuid, bac, 'P30-H', 'P30H GP', v.configuration_id, 'HORSE', 'ACTIVE'
    FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL P30: bound to BAC, app_job''s unit for BAC inserted % rows, not 1', n;
  END IF;
  RAISE NOTICE 'PASS  P30 app_job lists the % ACTIVE tenants and no other state; unbound it reads no tenant or unit; bound to BAC it reads and writes BAC''s units alone', cardinality(want);
END $$;
ROLLBACK;

\echo '== P31. TYRE-371: the app_job grant check names an UPDATE on a reading column, a DELETE on tyre_event, a default privilege and a lost EXECUTE on the listing, and reads nothing with none staged (rule 3, ADR-0025)'
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P31: the probe runs as %', current_user; END IF;
  f := pg_temp.app_job_grant_faults();
  IF f IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL P31: with nothing staged the grant check reads %', f;
  END IF;
  RAISE NOTICE 'PASS  P31 with nothing staged app_job holds EXECUTE on the listing alone';
END $$;
ROLLBACK;

BEGIN;
GRANT UPDATE (tread_mm) ON app.reading_measurement TO app_job;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P31: the probe runs as %', current_user; END IF;
  f := pg_temp.app_job_grant_faults();
  IF f IS DISTINCT FROM 'extra: column app.reading_measurement.tread_mm UPDATE' THEN
    RAISE EXCEPTION 'FAIL P31: an UPDATE on reading_measurement.tread_mm read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P31 a column grant on a reading is named';
END $$;
ROLLBACK;

BEGIN;
GRANT DELETE ON app.tyre_event TO app_job;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P31: the probe runs as %', current_user; END IF;
  f := pg_temp.app_job_grant_faults();
  IF f IS DISTINCT FROM 'extra: table app.tyre_event DELETE' THEN
    RAISE EXCEPTION 'FAIL P31: a DELETE on tyre_event read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P31 a table grant on a fitment event is named';
END $$;
ROLLBACK;

BEGIN;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT UPDATE ON TABLES TO app_job;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P31: the probe runs as %', current_user; END IF;
  f := pg_temp.app_job_grant_faults();
  IF f IS DISTINCT FROM 'a default privilege grants app_job UPDATE on new objects of type r' THEN
    RAISE EXCEPTION 'FAIL P31: a default UPDATE on new tables read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P31 a default privilege naming app_job is named';
END $$;
ROLLBACK;

BEGIN;
REVOKE EXECUTE ON FUNCTION app.active_tenant_ids() FROM app_job;
SET LOCAL ROLE app_login;
DO $$
DECLARE f text;
BEGIN
  IF current_user <> 'app_login' THEN RAISE EXCEPTION 'FAIL P31: the probe runs as %', current_user; END IF;
  f := pg_temp.app_job_grant_faults();
  IF f IS DISTINCT FROM 'missing: function app.active_tenant_ids() EXECUTE' THEN
    RAISE EXCEPTION 'FAIL P31: app_job without EXECUTE on the listing read %', COALESCE(f, 'no fault');
  END IF;
  RAISE NOTICE 'PASS  P31 a lost EXECUTE on the listing is named as missing';
END $$;
ROLLBACK;

\echo ''
\echo '================  PRIVILEGED CONTROLS PASSED  ================'
