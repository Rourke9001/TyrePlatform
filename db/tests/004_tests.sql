-- ============================================================================
--  Verification suite. Intended to run in CI on every build (NFR-SEC-005).
--  Run as a NON-SUPERUSER role (app_login). Running it as postgres proves
--  nothing: superusers bypass RLS.
--  Any failure raises an exception and aborts with a non-zero exit.
-- ============================================================================
\set ON_ERROR_STOP on
SET search_path = app, public;

\echo '== 0. Confirm we are not a superuser (otherwise every test below is vacuous)'
DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'FAIL: running as % which is SUPERUSER or BYPASSRLS; RLS tests are meaningless', current_user;
  END IF;
  RAISE NOTICE 'PASS  running as % (no superuser, no bypassrls)', current_user;
END $$;

\echo '== 1. Fail closed: no tenant context means no rows (FR-TEN-004)'
RESET app.tenant_id;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM app.vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % vehicles visible with no tenant context', n; END IF;
  SELECT count(*) INTO n FROM app.reading;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % readings visible with no tenant context', n; END IF;
  SELECT count(*) INTO n FROM app.tyre;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % tyres visible with no tenant context', n; END IF;
  SELECT count(*) INTO n FROM app.user_depot;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % depot scopings visible with no tenant context', n; END IF;
  RAISE NOTICE 'PASS  unset tenant context sees nothing';
END $$;

\echo '== 2. Cross-tenant isolation (FR-TEN-003, NFR-SEC-004)'
SET app.tenant_id = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE n int; leaked text;
BEGIN
  -- Tenant B's configurations must be invisible while in tenant A's context.
  SELECT count(*) INTO n FROM app.axle_configuration
   WHERE tenant_id = '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % tenant-B configurations visible from tenant A', n; END IF;

  -- Direct primary-key fetch of a tenant-B row must also return nothing.
  SELECT count(*) INTO n FROM app.axle_configuration
   WHERE id = md5('22222222-2222-2222-2222-222222222222BAC_LINKS')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant-B row reachable by primary key'; END IF;

  -- Sweep every tenant-scoped table for foreign rows.
  FOR leaked IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname='app' AND c.relkind='r' AND c.relrowsecurity
       AND c.relname <> 'tenant'          -- keyed by id, checked separately below
  LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id <> %L', leaked,
                   '11111111-1111-1111-1111-111111111111') INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % rows of another tenant visible in app.%', n, leaked; END IF;
  END LOOP;
  -- the tenant table itself is keyed by id, not tenant_id
  SELECT count(*) INTO n FROM app.tenant;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % tenant rows visible, expected exactly 1', n; END IF;
  RAISE NOTICE 'PASS  no foreign-tenant row is visible by any route (swept every RLS table)';
END $$;

\echo '== 3. Writing into another tenant is rejected (WITH CHECK)'
DO $$
BEGIN
  BEGIN
    INSERT INTO app.depot (tenant_id,name,type)
    VALUES ('22222222-2222-2222-2222-222222222222','Smuggled depot','DEPOT');
    RAISE EXCEPTION 'FAIL: inserted a row into another tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS  cross-tenant INSERT rejected by policy';
  END;
END $$;

\echo '== 4. Append-only enforcement (CR-004, DR-011)'
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    UPDATE app.reading SET pressure_kpa = 999 WHERE pressure_kpa = 200;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: app role can UPDATE app.reading'; END IF;

  ok := false;
  BEGIN
    DELETE FROM app.reading_measurement WHERE tread_mm = 0;
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: app role can DELETE app.reading_measurement'; END IF;
  RAISE NOTICE 'PASS  readings, measurements and events cannot be rewritten by the app role';
END $$;

\echo '== 5. Governing tread is MIN of the width-wise readings (BR-INS-003, DR-017)'
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM app.reading r
    JOIN (SELECT reading_id, min(tread_mm) AS m FROM app.reading_measurement GROUP BY reading_id) x
      ON x.reading_id = r.id
   WHERE r.governing_tread_mm IS DISTINCT FROM x.m;
  IF bad <> 0 THEN RAISE EXCEPTION 'FAIL: % readings whose governing value is not the minimum', bad; END IF;
  RAISE NOTICE 'PASS  every governing value equals MIN of its measurements';
END $$;

\echo '== 6. One tyre per position, one position per tyre (DR-004, DR-005)'
DO $$
DECLARE ok boolean := false; v uuid; p uuid;
BEGIN
  SELECT f.vehicle_id, f.position_id INTO v, p FROM app.fitment f WHERE f.removed_at IS NULL LIMIT 1;
  BEGIN
    INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer)
    VALUES ('11111111-1111-1111-1111-111111111111',
            (SELECT id FROM app.tyre ORDER BY branded_number LIMIT 1), v, p, now(), 500000);
    RAISE EXCEPTION 'FAIL: two open fitments accepted on one position';
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'PASS  a position cannot hold two tyres at once'; END IF;
END $$;

\echo '== 7. Valuation reproduces SRS Appendix E exactly (BR-VAL-001, BR-VAL-002, FR-VAL-006)'
DO $$
DECLARE r record; got numeric; fails int := 0;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('NBN79',    5::numeric, 135.42::numeric,  135.42::numeric),
      ('NBN56',    8,          135.42,           541.68),
      ('NBN96',   13,          135.42,          1218.78),
      ('NBN95',   16,          135.42,          1625.04),
      ('2102BAC1',14,          205.71,          2057.10),
      ('2107BAC2',20,          284.38,          4550.08),
      ('2108BAC1',21,          284.38,          4834.46),
      ('NBN35',   11,          143.00,          1001.00),
      ('NBN31',    8,          143.00,           572.00),
      ('NBN15',    9,          168.41,           842.05),
      ('2010BAC3',12,          209.77,          1678.16),
      ('NBN301',   6,          105.63,           211.26),
      ('2009BC3',  5,           91.00,            91.00),
      ('NBN33',    3,          135.42,             0.00),   -- at/below threshold floors to zero
      ('NBN1',     2,          135.42,             0.00)
    ) AS t(tyre, tread, rate, expected)
  LOOP
    got := app.tread_value(r.tread, 4, r.rate);
    IF got <> r.expected THEN
      RAISE WARNING 'FAIL % : expected % got %', r.tyre, r.expected, got;
      fails := fails + 1;
    END IF;
  END LOOP;
  IF fails > 0 THEN RAISE EXCEPTION 'FAIL: % valuation rows did not reproduce', fails; END IF;
  RAISE NOTICE 'PASS  all 15 Appendix E valuations reproduce to the cent';
  IF app.rand_per_mm(4319.91, 25.0, 4) <> 205.7100 THEN
    RAISE EXCEPTION 'FAIL: rand_per_mm derivation wrong, got %', app.rand_per_mm(4319.91,25.0,4);
  END IF;
  RAISE NOTICE 'PASS  rand_per_mm = purchase_price / usable tread';
END $$;

\echo '== 8. Appendix J fixture produces exactly the expected exceptions'
DO $$
DECLARE got text; expected text;
BEGIN
  -- FR-EXC-020: governing depth at or below the 4mm removal threshold
  SELECT string_agg(combination_code, ',' ORDER BY combination_position) INTO got
    FROM app.v_combination_reading WHERE governing_tread_mm <= 4;
  expected := '7,8,11,12,13,16,18,21,22';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-020: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-020 below removal threshold -> %', got;

  -- FR-EXC-035: width-wise spread >= 4mm
  SELECT string_agg(combination_code, ',' ORDER BY combination_position) INTO got
    FROM app.v_combination_reading WHERE width_spread_mm >= 4;
  expected := '5,6,7,8,18';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-035: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-035 irregular wear -> %', got;

  -- FR-EXC-038: spare at or below threshold, raised despite BR-RPT-001
  SELECT string_agg(position_code || '@' || governing_tread_mm, ',') INTO got
    FROM app.v_reading_detail WHERE is_spare AND governing_tread_mm <= 4;
  IF got IS NULL THEN RAISE EXCEPTION 'FAIL FR-EXC-038: spare exception not raised'; END IF;
  RAISE NOTICE 'PASS  FR-EXC-038 spare below threshold -> %', got;

  -- FR-EXC-036: dual-mate mismatch >= 3mm
  -- present the pair in ascending position order; on a right-side axle end the
  -- OUTER tyre carries the higher number (BR-VEH-001: inner then outer)
  SELECT string_agg(least(o.combination_position, i2.combination_position) || '/'
                 || greatest(o.combination_position, i2.combination_position)
                 || ' = ' || dm.difference_mm || 'mm', ', ') INTO got
    FROM app.v_dual_mate_difference dm
    JOIN app.v_combination_reading o  ON o.inspection_id=dm.inspection_id AND o.vehicle_id=dm.vehicle_id
                                     AND o.unit_own_code=dm.outer_position
    JOIN app.v_combination_reading i2 ON i2.inspection_id=dm.inspection_id AND i2.vehicle_id=dm.vehicle_id
                                     AND i2.unit_own_code=dm.inner_position
   WHERE dm.difference_mm >= 3;
  expected := '17/18 = 7.0mm';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-036: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-036 dual-mate mismatch -> %', got;

  -- FR-EXC-022: pressure below 80% of target
  SELECT string_agg(d.combination_code || ' @ ' || d.pressure_kpa || 'kPa', ',') INTO got
    FROM app.v_combination_reading d
    JOIN LATERAL (SELECT (value->>d.axle_class::text)::int AS target
                    FROM app.configuration WHERE key='target_pressure_kpa' LIMIT 1) t ON true
   WHERE d.pressure_kpa::numeric / t.target < 0.80;
  expected := '16 @ 200kPa';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-022: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-022 dangerously under-inflated -> %', got;
END $$;

\echo '== 8b. Views do not leak across tenants (security_invoker)'
DO $$
DECLARE v text; n int; missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname='app' AND c.relkind='v'
     AND COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                    WHERE option_name='security_invoker'), 'false') <> 'true';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: view(s) without security_invoker, RLS would be evaluated as the view owner: %', missing;
  END IF;
  FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
            WHERE ns.nspname='app' AND c.relkind='v'
  LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id <> %L', v,
                   '11111111-1111-1111-1111-111111111111') INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL: view app.% leaked % foreign-tenant rows', v, n; END IF;
  END LOOP;
  RAISE NOTICE 'PASS  every view sets security_invoker and leaks nothing';
END $$;

\echo '== 9. Combination numbering resolves to constituent units (BR-VEH-003, FR-VEH-032)'
DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(x.txt, ' | ') INTO got FROM (
    SELECT m.member_sequence || ': ' || min(m.combination_code::int) || '-' || max(m.combination_code::int)
           || ' -> ' || min(m.member_position_code::int) || '-' || max(m.member_position_code::int) AS txt
      FROM app.combination_position_map m
      JOIN app.axle_configuration c ON c.id = m.configuration_id
     WHERE c.code = 'BAC_LINKS'
     GROUP BY m.member_sequence ORDER BY m.member_sequence) x;
  IF got <> '1: 1-10 -> 1-10 | 2: 11-18 -> 1-8 | 3: 19-26 -> 1-8' THEN
    RAISE EXCEPTION 'FAIL: superlink mapping wrong: %', got; END IF;
  RAISE NOTICE 'PASS  BAC_LINKS maps %', got;
END $$;

\echo '== 10. Readings are attributed to the owning constituent vehicle (FR-INS-061)'
DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(v.fleet_number || '=' || n, ', ' ORDER BY v.fleet_number) INTO got
    FROM (SELECT vehicle_id, count(*) AS n FROM app.reading GROUP BY vehicle_id) r
    JOIN app.vehicle v ON v.id = r.vehicle_id;
  IF got <> 'HORSE=10, LINK12=9, LINK6=8' THEN
    RAISE EXCEPTION 'FAIL: readings not attributed per constituent unit: %', got; END IF;
  RAISE NOTICE 'PASS  one inspection, three vehicles -> %', got;
END $$;

\echo '== 11. Users cannot be deleted by the app role (FR-AUT-011)'
-- A fresh unreferenced user, so the only thing that can stop the DELETE is
-- the grant itself — a seeded user would trip inspection's FK first and the
-- check would pass for the wrong reason.
DO $$
DECLARE ok boolean := false;
BEGIN
  -- ON CONFLICT because the probe row outlives a passing run: cleaning it up
  -- would need the very DELETE this check exists to forbid.
  INSERT INTO app.app_user (tenant_id, email, display_name, role)
  VALUES ('11111111-1111-1111-1111-111111111111', 'deleteme@example.invalid', 'Deletion probe', 'DRIVER')
  ON CONFLICT (tenant_id, email) DO NOTHING;
  BEGIN
    DELETE FROM app.app_user WHERE email = 'deleteme@example.invalid';
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: app role can DELETE app.app_user'; END IF;
  RAISE NOTICE 'PASS  users are deactivated, never deleted';
END $$;

\echo '== 12. Every table in schema app is under forced RLS'
-- Structural companion to the data sweep in check 2: that sweep only visits
-- tables that already have RLS, so a table someone forgot to enrol would
-- never be swept at all. This closes that hole for every future table.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'app' AND c.relkind = 'r'
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: table(s) without forced RLS: %', missing;
  END IF;
  RAISE NOTICE 'PASS  every app table has RLS enabled and forced';
END $$;

\echo '== 13. Depot scoping is tenant-scoped and visible to its own tenant (FR-AUT-004, DR-001)'
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM app.user_depot;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly 1 own-tenant user_depot row, got %', n;
  END IF;
  RAISE NOTICE 'PASS  own-tenant depot scoping rows are visible, foreign ones swept by check 2';
END $$;

\echo '== 14. Fleet number is unique per tenant, not globally (DR-003)'
DO $$
DECLARE ok boolean := false; n int;
BEGIN
  -- Both tenants seed a vehicle called HORSE; the constraint being scoped to
  -- (tenant_id, fleet_number) is what lets them coexist.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT count(*) INTO n FROM app.vehicle WHERE fleet_number = 'HORSE';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected tenant-2 vehicle HORSE to coexist, found %', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  BEGIN
    INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'HORSE',
            md5('11111111-1111-1111-1111-111111111111HORSE_6X4')::uuid);
    RAISE EXCEPTION 'FAIL: duplicate fleet number accepted within a tenant';
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'PASS  fleet numbers collide within a tenant, coexist across tenants'; END IF;
END $$;

\echo '== 15. Driver assignment: current set, history, attribution, scoping (FR-VEH-007/008, FR-AUT-005)'
DO $$
DECLARE got text; n int;
BEGIN
  -- Self-contained: pin tenant 1 rather than inherit check 14's session state.
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  -- Multi-driver (HORSE) and multi-vehicle (Melusi) at once; the ended LINK6
  -- assignment must not appear.
  SELECT string_agg(fleet_number || '=' || display_name, ',' ORDER BY fleet_number || '=' || display_name) INTO got
    FROM app.v_current_assignment;
  IF got IS DISTINCT FROM 'HORSE=Melusi,HORSE=Sipho,LINK12=Melusi' THEN
    RAISE EXCEPTION 'FAIL: current assignments wrong: [%]', got; END IF;

  -- FR-VEH-008: the ended assignment stays queryable history.
  SELECT count(*) INTO n FROM app.vehicle_driver;
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL: expected 4 assignment rows including history, got %', n; END IF;

  -- FR-VEH-008: the fixture inspection's driver was among those assigned to
  -- that vehicle on the day it happened.
  SELECT u.display_name INTO got
    FROM app.inspection i
    JOIN app.vehicle_driver vd ON vd.vehicle_id = i.vehicle_id
                              AND vd.from_date <= i.started_at::date
                              AND (vd.to_date IS NULL OR vd.to_date >= i.started_at::date)
    JOIN app.app_user u ON u.id = vd.user_id
   WHERE i.id = md5('insp1')::uuid AND u.id = i.user_id;
  IF got IS DISTINCT FROM 'Melusi' THEN
    RAISE EXCEPTION 'FAIL: inspection driver not assigned at the time, got [%]', got; END IF;
  RAISE NOTICE 'PASS  current assignments, retained history and attribution all hold';
END $$;

DO $$
DECLARE got text; n int;
BEGIN
  -- FR-AUT-005 through the one predicate the API composes (ADR-0006).
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);
  SELECT string_agg(DISTINCT fleet_number, ',' ORDER BY fleet_number) INTO got
    FROM app.v_driver_vehicle;
  IF got IS DISTINCT FROM 'HORSE,LINK12' THEN
    RAISE EXCEPTION 'FAIL: driver sees [%], expected HORSE,LINK12', got; END IF;
  -- A tenant-1 session carrying tenant-2's driver id must see nothing: the
  -- tenant predicate binds before the actor predicate, so a stale or stolen
  -- actor id cannot cross the tenant boundary.
  PERFORM set_config('app.actor_id', md5('driver2')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_driver_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: foreign-tenant actor sees % vehicles', n; END IF;
  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_driver_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % assigned vehicles', n; END IF;
  RAISE NOTICE 'PASS  a driver sees exactly their current vehicles; foreign or unset actor sees none';
END $$;

\echo '== 16. Foreign keys cannot dangle across tenants (CR-001, DR-017)'
-- FK checks bypass RLS by design, so an id-only FK lets a session reference —
-- and through triggers, corrupt — a row it cannot see (TYRE-29). First the
-- reproduced attack: tenant 2 aims a measurement at a tenant-1 reading, which
-- would drag the victim's materialised MIN down (BR-VAL-001, FR-EXC-020).
DO $$
DECLARE victim uuid; before_mm numeric; after_mm numeric; ok boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT id, governing_tread_mm INTO victim, before_mm
    FROM app.reading WHERE governing_tread_mm IS NOT NULL
   ORDER BY governing_tread_mm DESC LIMIT 1;

  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  BEGIN
    -- ordinal 4 keeps 1..n contiguous so only the tenant boundary can reject
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, label, tread_mm)
    VALUES ('22222222-2222-2222-2222-222222222222', victim, 4, 'INJECTED', 0.1);
  EXCEPTION WHEN foreign_key_violation THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: cross-tenant reading_measurement INSERT was accepted';
  END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT governing_tread_mm INTO after_mm FROM app.reading WHERE id = victim;
  IF after_mm IS DISTINCT FROM before_mm THEN
    RAISE EXCEPTION 'FAIL: victim governing tread moved from % to %', before_mm, after_mm;
  END IF;
  RAISE NOTICE 'PASS  cross-tenant measurement rejected, victim governing tread untouched';
END $$;

-- Structural companion, same shape as check 12: the attack above only probes
-- one FK, so sweep the catalog for any FK between tenant-scoped tables that
-- omits tenant_id — each one is the same dangling-reference class.
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(c.conrelid::regclass || '.' || c.conname, ', ') INTO offender
    FROM pg_constraint c
    JOIN pg_class parent ON parent.oid = c.confrelid
   WHERE c.contype = 'f'
     AND c.connamespace = 'app'::regnamespace
     AND parent.relname <> 'tenant'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(c.conkey) k
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
        WHERE a.attname = 'tenant_id');
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: id-only FK(s) can dangle across tenants: %', offender;
  END IF;
  RAISE NOTICE 'PASS  every FK between tenant-scoped tables carries tenant_id';
END $$;

\echo '== 17. Tyre register and estate valuation (FR-VAL-001..006, 010..012, FR-RPT-020)'
-- Hand-computed from the fixture: 27 identical tyres at R205.71/mm, casing
-- R1837.50 each, governing treads 100mm over the 4mm threshold in total.
DO $$
DECLARE got text; n int; v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- Per-tyre values (BR-VAL-001 through the one implementation, FR-VAL-001/004)
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE branded_number = '2102BAC2';
  IF v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 tread value [%], expected 2057.10', v; END IF;
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE branded_number = '2102BAC18';
  IF v IS DISTINCT FROM 0.00 THEN
    RAISE EXCEPTION 'FAIL: bald 2102BAC18 tread value [%], expected 0.00', v; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE tread_value IS NOT NULL;
  IF n <> 27 THEN RAISE EXCEPTION 'FAIL: % tyres valued, expected all 27', n; END IF;

  -- Estate aggregation (FR-VAL-010/011): per-vehicle and grand totals
  SELECT string_agg(key_name || '=' || tread_value, ',' ORDER BY key_name) INTO got
    FROM app.v_estate_valuation WHERE level = 'VEHICLE' AND location_class = 'ALL';
  IF got IS DISTINCT FROM 'HORSE=11108.34,LINK12=8228.40,LINK6=1234.26' THEN
    RAISE EXCEPTION 'FAIL: per-vehicle tread values [%]', got; END IF;
  SELECT tread_value, casing_value, total_value INTO v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 OR c IS DISTINCT FROM 49612.50 OR tot IS DISTINCT FROM 70183.50 THEN
    RAISE EXCEPTION 'FAIL: grand totals tread=% casing=% total=%, expected 20571.00/49612.50/70183.50', v, c, tot; END IF;

  RAISE NOTICE 'PASS  register values every tyre; vehicle and tenant totals reproduce to the cent';
END $$;

-- Stock split (FR-VAL-012), audit-tread fallback (FR-TYR-030..034) and the
-- FR-TYR-032 exclusion, probed with two throwaway in-stock tyres.
DO $$
DECLARE got text; n int; v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  INSERT INTO app.tyre (id,tenant_id,branded_number,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state,last_tread_mm)
  VALUES (md5('valprobe1')::uuid,'11111111-1111-1111-1111-111111111111','PROBE1','NEW','2024-03-01',4320.00,25.0,205.7100,100.00,'IN_STOCK',10.0);
  INSERT INTO app.tyre (id,tenant_id,branded_number,status,casing_value,state)
  VALUES (md5('valprobe2')::uuid,'11111111-1111-1111-1111-111111111111','PROBE2','NEW',50.00,'IN_STOCK');

  SELECT tread_source, tread_value::text INTO got, v FROM app.v_tyre_valuation WHERE branded_number = 'PROBE1';
  IF got IS DISTINCT FROM 'AUDIT' OR v IS DISTINCT FROM 1234.26 THEN
    RAISE EXCEPTION 'FAIL: PROBE1 source [%] value [%], expected AUDIT/1234.26', got, v; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE branded_number = 'PROBE2' AND tread_value IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: incomplete PROBE2 was given a tread value'; END IF;

  SELECT tyre_count, tread_value, casing_value INTO n, v, c
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'IN_STOCK';
  IF n <> 2 OR v IS DISTINCT FROM 1234.26 OR c IS DISTINCT FROM 150.00 THEN
    RAISE EXCEPTION 'FAIL: IN_STOCK split n=% tread=% casing=%, expected 2/1234.26/150.00', n, v, c; END IF;
  -- Estate total deliberately counts the casing of unvalued tyres — casing is
  -- a stored fact, only the tread side is unknown — so it exceeds the sum of
  -- per-tyre totals (NULL for PROBE2) by exactly PROBE2's casing. The
  -- unvalued_count column is what flags the gap.
  SELECT unvalued_count, tread_value, casing_value, total_value INTO n, v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF n <> 1 OR v IS DISTINCT FROM 21805.26 OR c IS DISTINCT FROM 49762.50 OR tot IS DISTINCT FROM 71567.76 THEN
    RAISE EXCEPTION 'FAIL: with probes unvalued=% tread=% casing=% total=%, expected 1/21805.26/49762.50/71567.76', n, v, c, tot; END IF;

  DELETE FROM app.tyre WHERE branded_number IN ('PROBE1','PROBE2');
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: totals did not restore after probe cleanup, got %', v; END IF;
  RAISE NOTICE 'PASS  stock is split out, audit tread values, incomplete records are excluded not invented';
END $$;

-- The threshold is tenant configuration, not a constant (FR-CFG-010, CR-005):
-- this is the first production consumer of removal_threshold_mm, so prove the
-- valuation follows a policy change. 67mm remain over a 6mm threshold.
DO $$
DECLARE v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  INSERT INTO app.configuration (tenant_id,key,value)
  VALUES ('11111111-1111-1111-1111-111111111111','removal_threshold_mm','6'::jsonb);
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 13782.57 THEN
    RAISE EXCEPTION 'FAIL: at 6mm threshold expected 13782.57, got %', v; END IF;
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE branded_number = '2102BAC2';
  IF v IS DISTINCT FROM 1645.68 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 at 6mm threshold expected 1645.68, got %', v; END IF;
  DELETE FROM app.configuration
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
     AND key = 'removal_threshold_mm' AND value = '6'::jsonb;
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: totals did not restore after threshold cleanup, got %', v; END IF;
  RAISE NOTICE 'PASS  a threshold policy change moves the valuation; nothing is hard-coded';
END $$;

-- A tenant with NO effective threshold row (fresh provisioning, or policy
-- dated forward) must surface every tyre unvalued — GREATEST(0, NULL) is 0,
-- so an unguarded call would silently price the whole estate at R0.00 tread,
-- indistinguishable from a bald fleet (FR-TYR-032).
DO $$
DECLARE n int; v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  DELETE FROM app.configuration
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND key = 'removal_threshold_mm';
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE tread_value IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % tyres priced with no threshold policy configured', n; END IF;
  SELECT unvalued_count INTO n FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF n <> 27 THEN
    RAISE EXCEPTION 'FAIL: unvalued_count=% with no threshold policy, expected 27', n; END IF;
  INSERT INTO app.configuration (tenant_id,key,value)
  VALUES ('11111111-1111-1111-1111-111111111111','removal_threshold_mm','4'::jsonb);
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: totals did not restore after policy re-seed, got %', v; END IF;
  RAISE NOTICE 'PASS  no threshold policy means unvalued, never a silent R0.00 estate';
END $$;

-- Foreign-tenant emptiness, asserted from the tenant-2 side: tenant 2 owns no
-- tyres, so any row here means the view executed as its owner (a superuser)
-- instead of the invoker — the check-8b sweep alone is vacuous for a view
-- whose underlying table has no foreign rows to leak back.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT count(*) INTO n FROM app.v_tyre_valuation;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant 2 sees % register rows', n; END IF;
  SELECT count(*) INTO n FROM app.v_estate_valuation;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant 2 sees % estate rows', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  the register and estate views are empty from the foreign tenant''s side';
END $$;

\echo ''
\echo '================  ALL CHECKS PASSED  ================'
