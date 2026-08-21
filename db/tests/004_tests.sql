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
-- Appendix J is the exception set of ONE capture sheet, the 2026-07-23 one.
-- v_combination_reading re-presents every reading of every inspection, which
-- is what a tyre-history view needs, so each query here names the sheet it
-- describes rather than relying on the fixture holding a single capture.
DO $$
DECLARE got text; expected text;
BEGIN
  -- FR-EXC-020: governing depth at or below the 4mm removal threshold
  SELECT string_agg(combination_code, ',' ORDER BY combination_position) INTO got
    FROM app.v_combination_reading
   WHERE inspection_id = md5('insp1')::uuid AND governing_tread_mm <= 4;
  expected := '7,8,11,12,13,16,18,21,22';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-020: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-020 below removal threshold -> %', got;

  -- FR-EXC-035: width-wise spread >= 4mm
  SELECT string_agg(combination_code, ',' ORDER BY combination_position) INTO got
    FROM app.v_combination_reading
   WHERE inspection_id = md5('insp1')::uuid AND width_spread_mm >= 4;
  expected := '5,6,7,8,18';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-035: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-035 irregular wear -> %', got;

  -- FR-EXC-038: spare at or below threshold, raised despite BR-RPT-001
  SELECT string_agg(position_code || '@' || governing_tread_mm, ',') INTO got
    FROM app.v_reading_detail
   WHERE inspection_id = md5('insp1')::uuid AND is_spare AND governing_tread_mm <= 4;
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
   WHERE dm.inspection_id = md5('insp1')::uuid AND dm.difference_mm >= 3;
  expected := '17/18 = 7.0mm';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-036: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-036 dual-mate mismatch -> %', got;

  -- FR-EXC-022: pressure below 80% of target
  SELECT string_agg(d.combination_code || ' @ ' || d.pressure_kpa || 'kPa', ',') INTO got
    FROM app.v_combination_reading d
    JOIN LATERAL (SELECT (value->>d.axle_class::text)::int AS target
                    FROM app.configuration WHERE key='target_pressure_kpa' LIMIT 1) t ON true
   WHERE d.inspection_id = md5('insp1')::uuid
     AND d.pressure_kpa::numeric / t.target < 0.80;
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

\echo '== 8c. Routines do not silently bypass RLS (SECURITY DEFINER sweep)'
-- Structural companion to 8b, and its blind spot: 8b sweeps relkind='v', but
-- TYRE-33 moved the register's tenant-scoped logic out of a view and into
-- app.tyre_valuation_asof(), an object class nothing was inspecting. A
-- SECURITY DEFINER routine runs as its owner, and every routine here is owned
-- by the migration superuser, so one added by mistake would bypass RLS
-- entirely (FR-TEN-004) and merge green. Procedures included: prokind 'p'
-- takes SECURITY DEFINER too.
-- Each allowlisted routine needs RLS bypass to do its job and carries its own
-- tenant backstop instead; the reasoning lives at the function itself.
DO $$
DECLARE offenders text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO offenders
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.prokind IN ('f','p')
     AND p.prosecdef
     -- refresh_governing_tread materialises the MIN across a reading's
     -- measurements (CR-011) for rows the writer may not see; 000004 documents
     -- the same-tenant backstop it carries in place of RLS.
     AND p.proname <> ALL (ARRAY['refresh_governing_tread']);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: SECURITY DEFINER routine(s) outside the allowlist, RLS does not bind them: %', offenders;
  END IF;
  RAISE NOTICE 'PASS  no unreviewed routine runs with RLS bypassed';
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
    FROM (SELECT vehicle_id, count(*) AS n FROM app.reading
           WHERE inspection_id = md5('insp1')::uuid GROUP BY vehicle_id) r
    JOIN app.vehicle v ON v.id = r.vehicle_id;
  IF got <> 'HORSE=10, LINK12=9, LINK6=8' THEN
    RAISE EXCEPTION 'FAIL: readings not attributed per constituent unit: %', got; END IF;

  -- The earlier capture omits the spare, so the split differs by exactly that
  -- one position: what holds across both is that the resolution follows the
  -- combination, never the inspection's own vehicle_id.
  SELECT string_agg(v.fleet_number || '=' || n, ', ' ORDER BY v.fleet_number) INTO got
    FROM (SELECT vehicle_id, count(*) AS n FROM app.reading
           WHERE inspection_id = md5('insp0')::uuid GROUP BY vehicle_id) r
    JOIN app.vehicle v ON v.id = r.vehicle_id;
  IF got <> 'HORSE=10, LINK12=8, LINK6=8' THEN
    RAISE EXCEPTION 'FAIL: earlier capture not attributed per constituent unit: %', got; END IF;
  RAISE NOTICE 'PASS  every combination inspection attributes readings to three vehicles';
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
  -- restore the seeded row faithfully: its backdated effective_from is what
  -- lets as-at valuation resolve a policy for historical dates
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','removal_threshold_mm','4'::jsonb,'2024-01-01T00:00:00Z');
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: totals did not restore after policy re-seed, got %', v; END IF;
  RAISE NOTICE 'PASS  no threshold policy means unvalued, never a silent R0.00 estate';
END $$;

-- Foreign-tenant leakage, asserted from the tenant-2 side: the check-8b sweep
-- alone is vacuous for a view whose underlying table holds no foreign rows to
-- leak back, so probe from tenant 2 directly. A single tenant-1 row visible
-- here means the view executed as its owner (a superuser) instead of the
-- invoker. Leak-shaped rather than count(*) = 0 on purpose: later checks
-- seed tenant-2 tyres of their own.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT count(*) INTO n FROM app.v_tyre_valuation
   WHERE tenant_id <> '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant 2 sees % foreign register rows', n; END IF;
  SELECT count(*) INTO n FROM app.v_estate_valuation
   WHERE tenant_id <> '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: tenant 2 sees % foreign estate rows', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  no foreign row reaches the register or estate views from the tenant-2 side';
END $$;

\echo '== 18. As-at valuation and snapshot persistence (FR-VAL-020..022, UC-04)'
-- Fixed dates only: the fixture captures are 2026-06-28 and 2026-07-23 and
-- the seeded policy is backdated to 2024-01-01, so every assertion here is
-- stable no matter when the suite runs.
DO $$
DECLARE n int; v numeric; c numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- Before any reading exists the register is visible but unvalued
  SELECT count(*), count(tread_value) INTO n, v FROM app.tyre_valuation_asof('2026-06-01');
  IF n <> 27 OR v <> 0 THEN
    RAISE EXCEPTION 'FAIL: as at 2026-06-01 rows=% valued=%, expected 27/0', n, v; END IF;

  -- BR-VAL-007 between the two captures: the earlier reading governs, so the
  -- estate is worth more on 2026-07-01 than it is three weeks later. The
  -- spare is read only at the later capture and stays unvalued here, which is
  -- the whole point of the row count sitting beside the valued count.
  SELECT count(*), count(tread_value), sum(tread_value) INTO n, c, v
    FROM app.tyre_valuation_asof('2026-07-01');
  IF n <> 27 OR c <> 26 OR v IS DISTINCT FROM 25096.63 THEN
    RAISE EXCEPTION 'FAIL: as at 2026-07-01 rows=% valued=% tread=%, expected 27/26/25096.63', n, c, v; END IF;
  -- 2102BAC1 wears 0.5mm over the window, so its earlier depth is 13.5mm:
  -- 9.5mm over the threshold at R205.7100/mm is 1954.245, and FR-VAL-005
  -- rounds half up to the cent rather than to even.
  SELECT tread_value INTO v FROM app.tyre_valuation_asof('2026-07-01')
   WHERE branded_number = '2102BAC1';
  IF v IS DISTINCT FROM 1954.25 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 as at 2026-07-01 [%], expected 1954.25', v; END IF;

  -- After the inspection: same cent-exact totals as the live view, all fresh
  SELECT sum(tread_value), sum(casing_value), count(*) FILTER (WHERE stale) INTO v, c, n
    FROM app.tyre_valuation_asof('2026-08-01');
  IF v IS DISTINCT FROM 20571.00 OR c IS DISTINCT FROM 49612.50 OR n <> 0 THEN
    RAISE EXCEPTION 'FAIL: as at 2026-08-01 tread=% casing=% stale=%, expected 20571.00/49612.50/0', v, c, n; END IF;
  SELECT tread_value INTO v FROM app.tyre_valuation_asof('2026-08-01') WHERE branded_number = '2102BAC2';
  IF v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 as at 2026-08-01 [%], expected 2057.10', v; END IF;

  -- FR-VAL-021: months later the same reading still values, flagged stale
  SELECT sum(tread_value), count(*) FILTER (WHERE stale) INTO v, n
    FROM app.tyre_valuation_asof('2026-12-31');
  IF v IS DISTINCT FROM 20571.00 OR n <> 27 THEN
    RAISE EXCEPTION 'FAIL: as at 2026-12-31 tread=% stale=%, expected 20571.00/27 stale', v, n; END IF;
  RAISE NOTICE 'PASS  as-at valuation resolves reading, policy and staleness at the requested date';
END $$;

-- FR-VAL-022 change-driven snapshots: the seed load itself is the first
-- tread change (NULL -> governing), so the fixture must have snapshotted.
DO $$
DECLARE n int; v numeric; mm numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*) INTO n FROM app.valuation_snapshot WHERE as_at = '2026-07-23';
  IF n <> 27 THEN RAISE EXCEPTION 'FAIL: % snapshots at inspection date, expected 27', n; END IF;
  -- The earlier capture leaves one per position it read, and the spare it did
  -- not read has no row at all: a snapshot follows a reading, never a date.
  SELECT count(*) INTO n FROM app.valuation_snapshot WHERE as_at = '2026-06-28';
  IF n <> 26 THEN RAISE EXCEPTION 'FAIL: % snapshots at the earlier capture, expected 26', n; END IF;
  SELECT s.tread_mm, s.tread_value INTO mm, v
    FROM app.valuation_snapshot s JOIN app.tyre t ON t.id = s.tyre_id
   WHERE t.branded_number = '2102BAC2' AND s.as_at = '2026-07-23';
  IF mm IS DISTINCT FROM 14.0 OR v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 snapshot [% mm / %], expected 14.0 / 2057.10', mm, v; END IF;
  RAISE NOTICE 'PASS  the fixture inspection left one snapshot per tyre at its date';
END $$;

-- Change versus no-change, driven from the tenant-2 side so the append-only
-- residue (readings cannot be deleted) stays out of the tenant-1 pinned
-- figures. Conditional inserts keep the whole suite re-runnable.
DO $$
DECLARE n int; v numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2PROBE1') THEN
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
    VALUES (md5('t2probetyre')::uuid,'22222222-2222-2222-2222-222222222222','T2PROBE1','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  END IF;
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2insp1')::uuid) THEN
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2insp1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2cli1')::uuid,'2026-08-10T08:00:00Z','2026-08-10T08:05:00Z',100000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2rd1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp1')::uuid,md5('t2veh1')::uuid,posid,md5('t2probetyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,1,'OUTER',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,2,'CENTRE',13),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,3,'INNER',14);
  END IF;
  -- date-scoped: the month-end block later adds its own 2026-08-31 row for
  -- this tyre, and the suite must stay re-runnable after it has
  SELECT count(*), min(s.tread_value) INTO n, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2probetyre')::uuid AND s.as_at = '2026-08-10';
  IF n <> 1 OR v IS DISTINCT FROM 800.00 THEN
    RAISE EXCEPTION 'FAIL: tread change made % snapshots at [%], expected 1 at 800.00', n, v; END IF;

  -- An identical re-read is not a change: no second snapshot (FR-VAL-022)
  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2insp2')::uuid) THEN
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2insp2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2cli2')::uuid,'2026-08-15T08:00:00Z','2026-08-15T08:05:00Z',101000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2rd2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp2')::uuid,md5('t2veh1')::uuid,posid,md5('t2probetyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,1,'OUTER',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,2,'CENTRE',13),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,3,'INNER',14);
  END IF;
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tyre_id = md5('t2probetyre')::uuid AND as_at = '2026-08-15';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unchanged re-read wrote % snapshot(s)', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a tread change snapshots once; an unchanged re-read does not';
END $$;

-- A snapshot is priced under the policy in force on ITS OWN date, not the
-- policy in force when the phone happened to sync (FR-CFG-010). Offline
-- capture makes the two diverge routinely: this inspection was taken on
-- 2026-08-01 and reaches the server after the 2026-08-05 policy change, so
-- resolving the threshold at sync time would backdate a 6mm valuation onto
-- a day the tenant's policy was still 4mm — the revisionism 000006 disclaims.
-- 15mm governing over 4mm at R100/mm = R1100.00; under 6mm it would be 900.00.
DO $$
DECLARE v numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('22222222-2222-2222-2222-222222222222','removal_threshold_mm','6'::jsonb,'2026-08-05T00:00:00Z');
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2insp3')::uuid) THEN
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2insp3')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2cli3')::uuid,'2026-08-01T06:00:00Z','2026-08-01T06:05:00Z',99000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2rd3')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp3')::uuid,md5('t2veh1')::uuid,posid,md5('t2probetyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2rd3')::uuid,1,'OUTER',15),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd3')::uuid,2,'CENTRE',16),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd3')::uuid,3,'INNER',17);
  END IF;
  SELECT s.tread_value INTO v FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2probetyre')::uuid AND s.as_at = '2026-08-01';
  IF v IS DISTINCT FROM 1100.00 THEN
    RAISE EXCEPTION 'FAIL: late-synced snapshot priced at [%], expected 1100.00 under the policy of its own date', v; END IF;
  DELETE FROM app.configuration
   WHERE tenant_id = '22222222-2222-2222-2222-222222222222'
     AND key = 'removal_threshold_mm' AND value = '6'::jsonb;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a late-synced inspection is priced under the policy of its own date';
END $$;

-- FR-VAL-022 month-end pass: every valued tyre, once, idempotent. The
-- scheduler owns invoking this; here only the effect is pinned.
DO $$
DECLARE n int; v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  PERFORM app.take_valuation_snapshots('2026-08-31');
  SELECT count(*), sum(tread_value) INTO n, v FROM app.valuation_snapshot WHERE as_at = '2026-08-31';
  IF n <> 27 OR v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: month-end wrote % rows totalling %, expected 27 at 20571.00', n, v; END IF;
  PERFORM app.take_valuation_snapshots('2026-08-31');
  SELECT count(*) INTO n FROM app.valuation_snapshot WHERE as_at = '2026-08-31';
  IF n <> 27 THEN RAISE EXCEPTION 'FAIL: repeated month-end grew to % rows', n; END IF;

  -- and it is tenant-scoped: the same call from tenant 2 sees only its own
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  PERFORM app.take_valuation_snapshots('2026-08-31');
  SELECT count(*), sum(tread_value) INTO n, v
    FROM app.valuation_snapshot WHERE as_at = '2026-08-31';
  IF n <> 1 OR v IS DISTINCT FROM 800.00 THEN
    RAISE EXCEPTION 'FAIL: tenant-2 month-end sees %/% , expected its single 800.00 row', n, v; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  month-end snapshots every valued tyre exactly once, per tenant';
END $$;

\echo '== 19. Single-inspection analytics (FR-ANL-023..028, FR-RPT-022/023/037)'
-- Every figure below is hand-computed over the fixture's single 2026-07-23
-- inspection: 27 readings, 26 running plus one spare. Governing treads sum to
-- 194.0mm over all positions and 192.0mm over running ones (BR-INS-003).
-- BR-RPT-001 includes spares in composition reporting by default, so 'ALL' is
-- the headline and RUNNING/SPARE are the disclosure FR-RPT-005 requires.
DO $$
DECLARE n int; tot numeric; av numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  SELECT tyre_count, total_tread_mm, avg_tread_mm INTO n, tot, av
    FROM app.v_tread_summary WHERE level='TENANT' AND position_class='ALL';
  IF n <> 27 OR tot IS DISTINCT FROM 194.0 OR av IS DISTINCT FROM 7.19 THEN
    RAISE EXCEPTION 'FAIL: tenant ALL %/%/%, expected 27/194.0/7.19', n, tot, av; END IF;

  SELECT tyre_count, total_tread_mm, avg_tread_mm INTO n, tot, av
    FROM app.v_tread_summary WHERE level='TENANT' AND position_class='RUNNING';
  IF n <> 26 OR tot IS DISTINCT FROM 192.0 OR av IS DISTINCT FROM 7.38 THEN
    RAISE EXCEPTION 'FAIL: tenant RUNNING %/%/%, expected 26/192.0/7.38', n, tot, av; END IF;

  SELECT tyre_count, total_tread_mm INTO n, tot
    FROM app.v_tread_summary WHERE level='TENANT' AND position_class='SPARE';
  IF n <> 1 OR tot IS DISTINCT FROM 2.0 THEN
    RAISE EXCEPTION 'FAIL: tenant SPARE %/%, expected 1/2.0', n, tot; END IF;

  -- per vehicle (FR-ANL-023): the spare rides on LINK12, so its ALL and
  -- RUNNING figures differ where the other two vehicles' do not
  SELECT avg_tread_mm INTO av FROM app.v_tread_summary
   WHERE level='VEHICLE' AND key_name='HORSE' AND position_class='RUNNING';
  IF av IS DISTINCT FROM 8.80 THEN
    RAISE EXCEPTION 'FAIL: HORSE running avg [%], expected 8.80', av; END IF;
  SELECT avg_tread_mm INTO av FROM app.v_tread_summary
   WHERE level='VEHICLE' AND key_name='LINK6' AND position_class='RUNNING';
  IF av IS DISTINCT FROM 4.25 THEN
    RAISE EXCEPTION 'FAIL: LINK6 running avg [%], expected 4.25', av; END IF;
  SELECT tyre_count, total_tread_mm INTO n, tot FROM app.v_tread_summary
   WHERE level='VEHICLE' AND key_name='LINK12' AND position_class='ALL';
  IF n <> 9 OR tot IS DISTINCT FROM 72.0 THEN
    RAISE EXCEPTION 'FAIL: LINK12 ALL %/%, expected 9/72.0', n, tot; END IF;

  SELECT tyre_count, total_tread_mm INTO n, tot FROM app.v_tread_summary
   WHERE level='DEPOT' AND key_name='Johannesburg' AND position_class='ALL';
  IF n <> 27 OR tot IS DISTINCT FROM 194.0 THEN
    RAISE EXCEPTION 'FAIL: depot ALL %/%, expected 27/194.0', n, tot; END IF;
  RAISE NOTICE 'PASS  average and total governing tread reproduce at tenant, depot and vehicle';
END $$;

-- FR-ANL-024 over the seeded bands (FR-CFG-032): 0-4, 5-7, 8-10, 11-13, 14+.
-- Running counts 9/6/2/7/2; the 2.0mm spare lands in the first band, taking
-- the ALL row to 10.
DO $$
DECLARE got text; pct numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='RUNNING';
  IF got IS DISTINCT FROM '9,6,2,7,2' THEN
    RAISE EXCEPTION 'FAIL: running band distribution [%], expected 9,6,2,7,2', got; END IF;

  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='ALL';
  IF got IS DISTINCT FROM '10,6,2,7,2' THEN
    RAISE EXCEPTION 'FAIL: all-position band distribution [%], expected 10,6,2,7,2', got; END IF;

  -- the label carries the configured bounds; the classification does not
  SELECT band_label INTO got FROM app.v_tread_distribution
   WHERE level='TENANT' AND position_class='ALL' AND band_ordinal=1;
  IF got IS DISTINCT FROM '0-4mm' THEN
    RAISE EXCEPTION 'FAIL: first band label [%], expected 0-4mm', got; END IF;
  SELECT band_label INTO got FROM app.v_tread_distribution
   WHERE level='TENANT' AND position_class='ALL' AND band_ordinal=5;
  IF got IS DISTINCT FROM '14mm+' THEN
    RAISE EXCEPTION 'FAIL: last band label [%], expected 14mm+', got; END IF;

  SELECT pct_of_group INTO pct FROM app.v_tread_distribution
   WHERE level='TENANT' AND position_class='ALL' AND band_ordinal=1;
  IF pct IS DISTINCT FROM 37.04 THEN
    RAISE EXCEPTION 'FAIL: first band share [%], expected 37.04', pct; END IF;

  -- FR-CFG-030 continuity: no reading may fall outside all bands, so the
  -- banded counts must account for every position the summary counted
  IF (SELECT sum(tyre_count) FROM app.v_tread_distribution
       WHERE level='TENANT' AND position_class='ALL') <> 27 THEN
    RAISE EXCEPTION 'FAIL: banded total lost rows against 27 readings'; END IF;
  RAISE NOTICE 'PASS  tread band distribution and shares reproduce over the configured bands';
END $$;

-- A tread depth between two configured bounds must still land in a band.
-- FR-INS-021 accepts one decimal place, so 4.5mm is capturable, and the
-- FR-CFG-032 default names 0-4 then 5-7. Classification is by lower bound
-- (FR-CFG-030 requires continuity), so 4.5 belongs to the 0-4mm band.
DO $$
DECLARE n int; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '2';
  -- deliberately no purchase price, new tread or rate: valuation_complete is
  -- generated from those three, so this probe carries a tread band without
  -- entering any valuation total. Banding does not depend on valuation
  -- (FR-ANL-024 counts fitted tyres, FR-TYR-032 only excludes from value),
  -- and the isolation keeps check 18's tenant-2 figures unmoved.
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2GAP1') THEN
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,state)
    VALUES (md5('t2gaptyre')::uuid,'22222222-2222-2222-2222-222222222222','T2GAP1','NEW','FITTED');
    INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2gaptyre')::uuid,md5('t2veh1')::uuid,posid,'2026-07-01T06:00:00Z',90000,25.0);
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2insp4')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2cli4')::uuid,'2026-08-20T08:00:00Z','2026-08-20T08:05:00Z',102000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2rd4')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp4')::uuid,md5('t2veh1')::uuid,posid,md5('t2gaptyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,1,'OUTER',4.5),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,2,'CENTRE',4.8),
      ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,3,'INNER',4.7);
  END IF;
  -- the invariant, not just the presence of a row: every fitted position the
  -- summary counts must appear in exactly one band
  SELECT (SELECT sum(tyre_count) FROM app.v_tread_distribution
           WHERE level='TENANT' AND position_class='ALL')
       - (SELECT tyre_count FROM app.v_tread_summary
           WHERE level='TENANT' AND position_class='ALL') INTO n;
  IF n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL: banded counts differ from the summary by %, so a tread fell outside every band', n; END IF;
  IF (SELECT tyre_count FROM app.v_tread_distribution
       WHERE level='TENANT' AND position_class='ALL' AND band_ordinal = 1) <> 1 THEN
    RAISE EXCEPTION 'FAIL: the 4.5mm tread did not land in the 0-4mm band'; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a tread between two configured bounds still lands in a band';
END $$;

-- CR-005: the bands are configuration. Reconfigure to a two-band policy and
-- the distribution must follow, then restore (check 17's idiom).
DO $$
DECLARE got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','tread_bands','[[0,7],[8,null]]'::jsonb,'2024-06-01T00:00:00Z');
  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='RUNNING';
  IF got IS DISTINCT FROM '15,11' THEN
    RAISE EXCEPTION 'FAIL: reconfigured bands gave [%], expected 15,11', got; END IF;
  DELETE FROM app.configuration
   WHERE tenant_id='11111111-1111-1111-1111-111111111111'
     AND key='tread_bands' AND effective_from='2024-06-01T00:00:00Z';
  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='RUNNING';
  IF got IS DISTINCT FROM '9,6,2,7,2' THEN
    RAISE EXCEPTION 'FAIL: distribution did not restore after band cleanup, got [%]', got; END IF;
  RAISE NOTICE 'PASS  a tread band policy change moves the distribution; nothing is hard-coded';
END $$;

-- FR-ANL-025/026 and BR-RPT-004: compliance is over READINGS in a date range,
-- never over tyres, and never without the counts it derives from. Of 27
-- readings, 26 carry a target for their axle class: one at 26.67% of target
-- and 25 in the correct band (four at 93.33%, twenty-one at 100%). The spare
-- position has no configured SPARE target, so it is unclassifiable rather
-- than compliant -- the FR-TYR-032 pattern of reporting the excluded count.
DO $$
DECLARE pct numeric; rc bigint; tc bigint; uc bigint; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT pct_of_classified, total_readings, total_tyres, unclassified_count
    INTO pct, rc, tc, uc
    FROM app.inflation_compliance('2026-07-01','2026-08-01') WHERE band_key='correct';
  IF pct IS DISTINCT FROM 96.15 OR rc <> 26 OR tc <> 26 OR uc <> 1 THEN
    RAISE EXCEPTION 'FAIL: compliance %/%/%/%, expected 96.15/26/26/1', pct, rc, tc, uc; END IF;

  SELECT string_agg(band_key || '=' || reading_count::text, ',' ORDER BY lower_pct) INTO got
    FROM app.inflation_compliance('2026-07-01','2026-08-01');
  IF got IS DISTINCT FROM 'dangerously_under=1,under=0,correct=25,over=0,dangerously_over=0' THEN
    RAISE EXCEPTION 'FAIL: band spread [%]', got; END IF;

  -- the range is half-open: a window closing on the inspection date sees none
  SELECT total_readings INTO rc FROM app.inflation_compliance('2026-07-01','2026-07-23')
   WHERE band_key='correct';
  IF rc IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL: window ending on the inspection date saw [%] readings, expected 0', rc; END IF;
  RAISE NOTICE 'PASS  inflation compliance reports a percentage with its reading and tyre counts';
END $$;

-- FR-ANL-027/028 rankings (BR-ANL-007/008). Ties are real in this fixture --
-- two positions share a 5.0mm spread -- so the ranking pins a deterministic
-- order as well as the values.
DO $$
DECLARE got text; d int; dall int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT string_agg(branded_number || '=' || width_spread_mm || '#' || rank, ',' ORDER BY rank, branded_number) INTO got
    FROM app.v_irregular_wear_ranking WHERE rank <= 3;
  IF got IS DISTINCT FROM '2102BAC18=8.0#1,2102BAC6=6.0#2,2102BAC7=5.0#3,2102BAC8=5.0#3' THEN
    RAISE EXCEPTION 'FAIL: irregular wear ranking [%]', got; END IF;

  SELECT fleet_number || ' ' || outer_position || '/' || inner_position || '=' || difference_mm
    INTO got FROM app.v_dual_mate_ranking WHERE rank = 1;
  IF got IS DISTINCT FROM 'LINK6 8/7=7.0' THEN
    RAISE EXCEPTION 'FAIL: top dual-mate pair [%], expected LINK6 8/7=7.0', got; END IF;

  -- the ranking presents the same measure FR-EXC-035 raises on, not a second
  -- definition of it: at a 4mm spread the RUNNING positions are exactly the
  -- five check 8 pins, and the sixth is the spare -- BR-RPT-001 keeps spares
  -- out of exception reporting and in composition reporting, so the two
  -- counts differ by exactly that one position and neither is wrong
  SELECT count(*) FILTER (WHERE NOT is_spare), count(*) INTO d, dall
    FROM app.v_irregular_wear_ranking WHERE width_spread_mm >= 4;
  IF d <> 5 OR dall <> 6 THEN
    RAISE EXCEPTION 'FAIL: %/% running/all positions at the 4mm spread margin, expected 5/6', d, dall; END IF;
  RAISE NOTICE 'PASS  irregular wear and dual-mate rankings are ordered and tie-stable';
END $$;


\echo '== 20. Snapshots reconcile to the register (TYRE-37; FR-VAL-022, BR-VAL-007)'
-- A valuation_snapshot row is a cache of app.tyre_valuation_asof(), never an
-- independent record of fact, so the register wins wherever the two disagree
-- (TYRE-37 decision). Everything here runs on tenant 2's own probe tyres:
-- readings are append-only, so a scenario staged against tenant 1 would leave
-- residue in the pinned Appendix E and Appendix J figures forever.
-- Fixed dates throughout, all after 2026-08-31, so check 18's month-end
-- assertions cannot see these tyres.

-- Case A (TYRE-37): two inspections of one tyre on one day, syncing out of
-- order. BR-VAL-007 resolves the day by the greatest submitted_at, so the
-- 09:00Z reading governs however late the 07:00Z one arrives. 9.0mm over the
-- 4mm threshold at R100/mm = R500.00; taking the arrival order instead gives
-- 11.0mm and R700.00, which is the divergence this check exists to catch.
DO $$
DECLARE mm numeric; v numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2SNAP1') THEN
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
    VALUES (md5('t2snap1')::uuid,'22222222-2222-2222-2222-222222222222','T2SNAP1','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  END IF;
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '2';

  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2s1late')::uuid) THEN
    -- the later inspection arrives FIRST; the earlier one syncs after it
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s1late')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s1latecli')::uuid,'2026-09-02T08:55:00Z','2026-09-02T09:00:00Z',110000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s1lateread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s1late')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap1')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,1,'OUTER',9),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,2,'CENTRE',10),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,3,'INNER',11);

    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s1early')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s1earlycli')::uuid,'2026-09-02T06:55:00Z','2026-09-02T07:00:00Z',109000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s1earlyread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s1early')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap1')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,1,'OUTER',11),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,2,'CENTRE',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,3,'INNER',13);

    -- only meaningful on the run that stages it: on a later run the readings
    -- already exist and no trigger re-fires, so the assertion would pass
    -- without proving anything
    SELECT s.tread_mm, s.tread_value INTO mm, v
      FROM app.valuation_snapshot s
     WHERE s.tyre_id = md5('t2snap1')::uuid AND s.as_at = '2026-09-02';
    IF mm IS DISTINCT FROM 9.0 OR v IS DISTINCT FROM 500.00 THEN
      RAISE EXCEPTION 'FAIL: out-of-order sync snapshotted [% mm / %], expected 9.0 / 500.00 (the register resolves the day by submitted_at, not by arrival)', mm, v; END IF;
  END IF;

  -- Case B (TYRE-37): voiding does not touch governing_tread_mm, so nothing
  -- in the reading itself changes -- the repair has to come from the
  -- inspection's own state change. The register falls back to the 07:00Z
  -- reading: 11.0mm over 4mm at R100/mm = R700.00.
  UPDATE app.inspection SET state = 'VOIDED', void_reason = 'TYRE-37 probe'
   WHERE id = md5('t2s1late')::uuid;
  SELECT s.tread_mm, s.tread_value INTO mm, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2snap1')::uuid AND s.as_at = '2026-09-02';
  IF mm IS DISTINCT FROM 11.0 OR v IS DISTINCT FROM 700.00 THEN
    RAISE EXCEPTION 'FAIL: voiding left the snapshot at [% mm / %], expected 11.0 / 700.00', mm, v; END IF;

  -- and back: un-voiding is the same divergence in the other direction, so it
  -- repairs an existing row too
  UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL
   WHERE id = md5('t2s1late')::uuid;
  SELECT s.tread_mm, s.tread_value INTO mm, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2snap1')::uuid AND s.as_at = '2026-09-02';
  IF mm IS DISTINCT FROM 9.0 OR v IS DISTINCT FROM 500.00 THEN
    RAISE EXCEPTION 'FAIL: un-voiding left the snapshot at [% mm / %], expected 9.0 / 500.00', mm, v; END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  out-of-order sync and void/un-void leave the snapshot equal to the register';
END $$;

-- Repair is plural: a month-end row taken after a since-voided reading
-- inherited that reading's value, so every snapshot at or after the voided
-- inspection's date has to be reconciled, not just the one on its own date.
-- Voiding the tyre's LAST live reading leaves it unvalued, and an unvalued
-- tyre has no snapshot to hold -- valuation_snapshot.tread_value is NOT NULL,
-- so the row goes rather than turning null. That is not a DR-014 breach:
-- DR-011 names reading, reading_measurement and tyre_event as the INSERT-only
-- set and deliberately leaves this table out of it.
DO $$
DECLARE n int; v numeric; w numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2SNAP2') THEN
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
    VALUES (md5('t2snap2')::uuid,'22222222-2222-2222-2222-222222222222','T2SNAP2','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  END IF;
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '3';

  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2s2a')::uuid) THEN
    -- in order this time: 15.0mm on the 5th, then 12.0mm on the 6th
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s2a')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s2acli')::uuid,'2026-09-05T06:55:00Z','2026-09-05T07:00:00Z',111000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s2aread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s2a')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap2')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,1,'OUTER',15),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,2,'CENTRE',16),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,3,'INNER',17);

    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s2b')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s2bcli')::uuid,'2026-09-06T06:55:00Z','2026-09-06T07:00:00Z',112000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s2bread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s2b')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap2')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,1,'OUTER',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,2,'CENTRE',13),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,3,'INNER',14);

    -- a month-end row now carries the 6th's value forward
    PERFORM app.take_valuation_snapshots('2026-09-30');
    SELECT tread_value INTO v FROM app.valuation_snapshot
     WHERE tyre_id = md5('t2snap2')::uuid AND as_at = '2026-09-30';
    IF v IS DISTINCT FROM 800.00 THEN
      RAISE EXCEPTION 'FAIL: month-end took [%] for T2SNAP2, expected 800.00', v; END IF;

    -- void the 6th: the register falls back to the 5th's 15.0mm = R1100.00,
    -- and BOTH the 6th's row and the month-end row that inherited it move
    UPDATE app.inspection SET state = 'VOIDED', void_reason = 'TYRE-37 probe'
     WHERE id = md5('t2s2b')::uuid;
    SELECT s1.tread_value, s2.tread_value INTO v, w
      FROM app.valuation_snapshot s1, app.valuation_snapshot s2
     WHERE s1.tyre_id = md5('t2snap2')::uuid AND s1.as_at = '2026-09-06'
       AND s2.tyre_id = md5('t2snap2')::uuid AND s2.as_at = '2026-09-30';
    IF v IS DISTINCT FROM 1100.00 OR w IS DISTINCT FROM 1100.00 THEN
      RAISE EXCEPTION 'FAIL: after voiding the 6th, snapshots read [% / %] at 09-06 / 09-30, expected 1100.00 / 1100.00', v, w; END IF;

    -- void the 5th as well: no live reading left, nothing to value, no rows
    UPDATE app.inspection SET state = 'VOIDED', void_reason = 'TYRE-37 probe'
     WHERE id = md5('t2s2a')::uuid;
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: an unvalued tyre kept % snapshot row(s)', n; END IF;

    -- un-voiding restores the register but mints nothing: a deleted row is a
    -- cache miss, and FR-VAL-022 creates rows on change or at month end, not
    -- on a state transition. The next month-end fills the gap.
    UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL
     WHERE id = md5('t2s2a')::uuid;
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: un-voiding resurrected % deleted snapshot row(s)', n; END IF;
    UPDATE app.inspection SET state = 'VOIDED', void_reason = 'TYRE-37 probe'
     WHERE id = md5('t2s2a')::uuid;
  ELSE
    -- the staged end state, re-asserted on every later run
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: fully voided T2SNAP2 carries % snapshot row(s)', n; END IF;
  END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  voiding repairs every snapshot at or after its date, and drops those it unvalues';
END $$;

-- FR-VAL-022 month-end is a reconcile pass, not a first-write-wins one:
-- re-running a date has to bring whatever sits there back to the register.
-- Self-restoring, so the corruption never outlives the check.
DO $$
DECLARE mm numeric; v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  PERFORM app.take_valuation_snapshots('2026-09-30');
  UPDATE app.valuation_snapshot SET tread_mm = 1.0, tread_value = 1.00
   WHERE tyre_id = md5('t2snap1')::uuid AND as_at = '2026-09-30';
  PERFORM app.take_valuation_snapshots('2026-09-30');
  SELECT tread_mm, tread_value INTO mm, v FROM app.valuation_snapshot
   WHERE tyre_id = md5('t2snap1')::uuid AND as_at = '2026-09-30';
  IF mm IS DISTINCT FROM 9.0 OR v IS DISTINCT FROM 500.00 THEN
    RAISE EXCEPTION 'FAIL: re-running month-end left [% mm / %], expected the register''s 9.0 / 500.00', mm, v; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  re-running month-end reconciles an existing row to the register';
END $$;

-- The shared writer takes its tenant as an argument because it is reachable
-- from refresh_governing_tread()'s SECURITY DEFINER chain, where RLS never
-- binds (000004 states the reasoning at the function itself): a tyre that
-- does not belong to it must be refused outright rather than silently
-- reconciled or silently skipped.
-- What this pins is the RLS-BOUND branch. Running as app_login, a foreign
-- tyre is invisible, so the lookup finds nothing and the refusal comes from
-- the NULL -- which is the branch most likely to fail open, and it does not.
-- The unbound branch, where the lookup returns a real foreign tenant, cannot
-- be staged from this suite: it needs a SECURITY DEFINER wrapper and check 8c
-- rejects those by design. TYRE-38 owns how a control in that position is
-- proven.
DO $$
DECLARE ok boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  BEGIN
    PERFORM app.reconcile_valuation_snapshots(
      '22222222-2222-2222-2222-222222222222'::uuid, '2026-09-30'::date, md5('t2snap1')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN
    ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: reconcile accepted a tyre outside the tenant it was handed'; END IF;
  RAISE NOTICE 'PASS  the shared snapshot writer refuses a tyre outside its tenant argument';
END $$;

-- Check 2's isolation sweep runs long before any of this exists, so on a
-- fresh database the rows check 20 stages are never swept at all. Repeat it
-- here over exactly the objects this check introduces (FR-TEN-003).
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*) INTO n FROM app.tyre WHERE branded_number IN ('T2SNAP1', 'T2SNAP2');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % check-20 probe tyre(s) visible from tenant 1', n; END IF;
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tenant_id <> '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % foreign snapshot row(s) visible from tenant 1', n; END IF;
  SELECT count(*) INTO n FROM app.inspection
   WHERE tenant_id <> '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % foreign inspection(s) visible from tenant 1', n; END IF;
  SELECT count(*) INTO n FROM app.reading
   WHERE tenant_id <> '11111111-1111-1111-1111-111111111111';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % foreign reading(s) visible from tenant 1', n; END IF;
  RAISE NOTICE 'PASS  nothing check 20 stages in tenant 2 is reachable from tenant 1';
END $$;

\echo '== 21. Wear rate and removal forecast (FR-ANL-001..007, BR-ANL-001/002/004)'
-- Hand-computed over the fixture's two captures, 10,000km and 25 days apart:
-- a tyre that loses d mm over that window wears at d/10 mm per 1000km, and
-- the combination covers 400.00km per day. The three deltas in the fixture
-- are deliberately different, so a rate cannot pass these by being constant.
DO $$
DECLARE r numeric; st text; n int; m int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- FR-ANL-001: 15.0mm -> 14.0mm over 10,000km
  SELECT wear_rate_mm_per_1000km, wear_rate_status INTO r, st
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BAC2';
  IF r IS DISTINCT FROM 0.1000 OR st IS DISTINCT FROM 'MEASURED' THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 wear rate [% / %], expected 0.1000 / MEASURED', r, st; END IF;

  -- twice the loss over the same distance is twice the rate
  SELECT wear_rate_mm_per_1000km INTO r
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BAC9';
  IF r IS DISTINCT FROM 0.2000 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC9 wear rate [%], expected 0.2000', r; END IF;

  -- and half the loss is half the rate, to four places
  SELECT wear_rate_mm_per_1000km INTO r
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BAC1';
  IF r IS DISTINCT FROM 0.0500 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 wear rate [%], expected 0.0500', r; END IF;

  -- FR-ANL-003 and BR-ANL-004: the spare is read once, so it carries a
  -- reason instead of a rate. 000009 holds why the reason is not optional.
  SELECT wear_rate_mm_per_1000km, wear_rate_status INTO r, st
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BACS';
  IF r IS NOT NULL OR st IS DISTINCT FROM 'INSUFFICIENT_READINGS' THEN
    RAISE EXCEPTION 'FAIL: single-reading spare [% / %], expected NULL / INSUFFICIENT_READINGS', r, st; END IF;

  -- every fitted position appears exactly once and every row states itself
  SELECT count(*), count(*) FILTER (WHERE wear_rate_status = 'MEASURED')
    INTO n, m FROM app.v_tyre_wear_rate;
  IF n <> 27 OR m <> 26 THEN
    RAISE EXCEPTION 'FAIL: %/% rows/measured in the wear rate view, expected 27/26', n, m; END IF;
  IF EXISTS (SELECT 1 FROM app.v_tyre_wear_rate
              WHERE (wear_rate_mm_per_1000km IS NULL) <> (wear_rate_status <> 'MEASURED')) THEN
    RAISE EXCEPTION 'FAIL: a row carries a rate without MEASURED, or MEASURED without a rate'; END IF;
  RAISE NOTICE 'PASS  wear rate is measured per tyre, and says why where it cannot be';
END $$;

-- BR-ANL-002. Remaining distance is the tread above the threshold divided by
-- the rate; remaining days applies the vehicle's mean daily distance, which
-- the fixture makes 400.00km.
DO $$
DECLARE km numeric; dys int; dt date; odo bigint; st text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- 2102BAC2: 10.0mm over the threshold at 0.1000mm per 1000km
  SELECT projected_remaining_km, projected_remaining_days, projected_removal_date,
         projected_removal_odometer, forecast_status
    INTO km, dys, dt, odo, st
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC2';
  IF km IS DISTINCT FROM 100000 OR dys <> 250 OR dt <> '2027-03-30'
     OR odo <> 512500 OR st IS DISTINCT FROM 'FORECAST' THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 forecast [%km / %d / % / % / %], expected 100000/250/2027-03-30/512500/FORECAST', km, dys, dt, odo, st; END IF;

  -- the fastest-wearing tyre in the fixture reaches the threshold first
  SELECT projected_remaining_km, projected_remaining_days, projected_removal_date, projected_removal_odometer
    INTO km, dys, dt, odo
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC9';
  IF km IS DISTINCT FROM 10000 OR dys <> 25 OR dt <> '2026-08-17' OR odo <> 422500 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC9 forecast [%km / %d / % / %], expected 10000/25/2026-08-17/422500', km, dys, dt, odo; END IF;

  -- and the slowest, more than a year out
  SELECT projected_remaining_km, projected_remaining_days, projected_removal_date, projected_removal_odometer
    INTO km, dys, dt, odo
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC1';
  IF km IS DISTINCT FROM 180000 OR dys <> 450 OR dt <> '2027-10-16' OR odo <> 592500 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 forecast [%km / %d / % / %], expected 180000/450/2027-10-16/592500', km, dys, dt, odo; END IF;

  -- Neither the distance nor the day count divides evenly here: 2.0mm above
  -- the threshold at 0.1500mm per 1000km is 13,333.33km, and at 400.00km a
  -- day that is 33.33 days. Kilometres round; days floor, so the date given
  -- is the earlier of the two it falls between.
  SELECT projected_remaining_km, projected_remaining_days, projected_removal_date, projected_removal_odometer
    INTO km, dys, dt, odo
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC15';
  IF km IS DISTINCT FROM 13333 OR dys <> 33 OR dt <> '2026-08-25' OR odo <> 425833 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC15 forecast [%km / %d / % / %], expected 13333/33/2026-08-25/425833', km, dys, dt, odo; END IF;

  -- Zero remaining, dated the last reading, per 000009's note on why an
  -- overdue tyre may not project as a negative or a NULL.
  SELECT projected_remaining_km, projected_remaining_days, projected_removal_date, forecast_status
    INTO km, dys, dt, st
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC18';
  IF km IS DISTINCT FROM 0 OR dys <> 0 OR dt <> '2026-07-23'
     OR st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: bald 2102BAC18 forecast [%km / %d / % / %], expected 0/0/2026-07-23/AT_OR_BELOW_THRESHOLD', km, dys, dt, st; END IF;

  -- Precedence: the spare is below the threshold AND has no rate. Being past
  -- the threshold is the answer to "when does this need replacing" without
  -- needing a rate at all, so it outranks the missing-rate reason.
  SELECT forecast_status INTO st
    FROM app.v_removal_forecast WHERE branded_number = '2102BACS';
  IF st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: spare below the threshold forecasts [%], expected AT_OR_BELOW_THRESHOLD', st; END IF;

  SELECT count(*) INTO n FROM app.v_removal_forecast;
  IF n <> 27 THEN RAISE EXCEPTION 'FAIL: % forecast rows, expected 27', n; END IF;
  RAISE NOTICE 'PASS  removal forecast projects distance, days, date and odometer per tyre';
END $$;

-- FR-ANL-007. The horizon list is the report surface (FR-RPT-028), and at a
-- zero horizon it must agree exactly with the below-threshold set check 8
-- pins from the readings: two routes to the same nine positions.
DO $$
DECLARE n int; m int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  SELECT string_agg(branded_number, ',' ORDER BY branded_number) INTO got
    FROM app.removal_forecast_within('2026-07-23', 0) WHERE NOT is_spare;
  IF got IS DISTINCT FROM '2102BAC11,2102BAC12,2102BAC13,2102BAC16,2102BAC18,2102BAC21,2102BAC22,2102BAC7,2102BAC8' THEN
    RAISE EXCEPTION 'FAIL: overdue running positions [%]', got; END IF;

  -- thirty days out adds the two tyres inside 12,000km of the threshold.
  -- Spares are carried, never filtered: BR-RPT-001 is a reporting convention
  -- and FR-RPT-005 makes the caller state which it applied.
  SELECT count(*), count(*) FILTER (WHERE NOT is_spare) INTO n, m
    FROM app.removal_forecast_within('2026-07-23', 30);
  IF n <> 12 OR m <> 11 THEN
    RAISE EXCEPTION 'FAIL: %/% all/running within 30 days, expected 12/11', n, m; END IF;

  -- a horizon cannot invent a tyre that has no projection
  IF EXISTS (SELECT 1 FROM app.removal_forecast_within('2026-07-23', 3650)
              WHERE projected_removal_date IS NULL) THEN
    RAISE EXCEPTION 'FAIL: the horizon list carries a row with no projected date'; END IF;
  RAISE NOTICE 'PASS  the horizon list agrees with the below-threshold set and widens with the horizon';
END $$;

-- FR-ANL-002 is tenant configuration, not a constant (rule 5, CR-005). Raise
-- the minimum separation above the fixture's own window and no pair qualifies
-- any more, then restore. BR-ANL-001 computes over the most recent pair
-- separated by at least the minimum, so "below the minimum" means no
-- qualifying pair exists (BR-ANL-004), not that the last two are too close.
DO $$
DECLARE n int; st text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','wear_rate_min_distance_km','20000'::jsonb,'2026-07-01T00:00:00Z');

  SELECT count(*) FILTER (WHERE wear_rate_status = 'BELOW_MIN_DISTANCE')
    INTO n FROM app.v_tyre_wear_rate;
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % rows below the raised minimum, expected 26', n; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_mm_per_1000km IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % rates survived a minimum wider than the window', n; END IF;
  SELECT forecast_status INTO st FROM app.v_removal_forecast WHERE branded_number = '2102BAC2';
  IF st IS DISTINCT FROM 'BELOW_MIN_DISTANCE' THEN
    RAISE EXCEPTION 'FAIL: forecast under the raised minimum [%], expected BELOW_MIN_DISTANCE', st; END IF;

  DELETE FROM app.configuration
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
     AND key = 'wear_rate_min_distance_km' AND value = '20000'::jsonb;
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_status = 'MEASURED';
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % measured after restoring the policy, expected 26', n; END IF;

  -- No configured minimum is not the same as a minimum of zero: an
  -- unconfigured tenant gets no rate and is told why, never a rate computed
  -- from a hard-coded 1,000km that nobody chose.
  DELETE FROM app.configuration
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
     AND key = 'wear_rate_min_distance_km';
  SELECT count(*) FILTER (WHERE wear_rate_status = 'NO_MIN_DISTANCE_POLICY')
    INTO n FROM app.v_tyre_wear_rate;
  IF n <> 27 THEN
    RAISE EXCEPTION 'FAIL: % rows report no minimum-distance policy, expected 27', n; END IF;
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','wear_rate_min_distance_km','1000'::jsonb,'2024-01-01T00:00:00Z');
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_status = 'MEASURED';
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % measured after reseeding the policy, expected 26', n; END IF;
  RAISE NOTICE 'PASS  the minimum separation is configuration; unconfigured means no rate, with the reason';
END $$;

-- BR-ANL-004: a fitment between the two readings makes them readings of the
-- same position rather than of the same tyre's wear. Moving a fitment date is
-- reversible in a way an extra reading is not -- readings are append-only, so
-- staging this with one would leave residue in every pinned figure above.
DO $$
DECLARE st text; r numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  UPDATE app.fitment SET fitted_at = '2026-07-10T06:00:00Z'
   WHERE tyre_id = md5('tyre2')::uuid;

  SELECT wear_rate_status, wear_rate_mm_per_1000km INTO st, r
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BAC2';
  IF st IS DISTINCT FROM 'FITMENT_BETWEEN' OR r IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: refitted tyre [% / %], expected FITMENT_BETWEEN / NULL', st, r; END IF;

  UPDATE app.fitment SET fitted_at = '2025-06-01T06:00:00Z'
   WHERE tyre_id = md5('tyre2')::uuid;
  SELECT wear_rate_status, wear_rate_mm_per_1000km INTO st, r
    FROM app.v_tyre_wear_rate WHERE branded_number = '2102BAC2';
  IF st IS DISTINCT FROM 'MEASURED' OR r IS DISTINCT FROM 0.1000 THEN
    RAISE EXCEPTION 'FAIL: restored fitment [% / %], expected MEASURED / 0.1000', st, r; END IF;
  RAISE NOTICE 'PASS  a fitment between the readings withdraws the rate rather than reporting a swap as wear';
END $$;

-- Zero measured wear is the ordinary case, not an exotic one: a hard compound
-- over a short window moves less than the gauge resolves. The rate is then a
-- real 0.0000 rather than a missing one, and the projection it implies is
-- infinite, so the forecast withholds it and says which of the two it is.
-- Staged on tenant 2 in September: readings are append-only, so a tenant-1
-- probe would sit inside the pinned figures above forever, and these dates
-- are past check 18's month end. The tyre carries no purchase price, so it
-- never enters a valuation or a snapshot.
DO $$
DECLARE r numeric; st text; km numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '3';
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2FLAT1') THEN
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,state)
    VALUES (md5('t2flattyre')::uuid,'22222222-2222-2222-2222-222222222222','T2FLAT1','NEW','FITTED');
    INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2flattyre')::uuid,md5('t2veh1')::uuid,posid,'2026-09-01T06:00:00Z',119000,25.0);
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2flat1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2flatcli1')::uuid,'2026-09-10T08:00:00Z','2026-09-10T08:05:00Z',120000),
           (md5('t2flat2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2flatcli2')::uuid,'2026-09-20T08:00:00Z','2026-09-20T08:05:00Z',121500);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2flatrd1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2flat1')::uuid,md5('t2veh1')::uuid,posid,md5('t2flattyre')::uuid,750),
           (md5('t2flatrd2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2flat2')::uuid,md5('t2veh1')::uuid,posid,md5('t2flattyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,1,'OUTER',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,2,'CENTRE',13),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,3,'INNER',14),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,1,'OUTER',12),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,2,'CENTRE',13),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,3,'INNER',14);
  END IF;

  SELECT wear_rate_mm_per_1000km, wear_rate_status INTO r, st
    FROM app.v_tyre_wear_rate WHERE branded_number = 'T2FLAT1';
  IF r IS DISTINCT FROM 0.0000 OR st IS DISTINCT FROM 'MEASURED' THEN
    RAISE EXCEPTION 'FAIL: unworn tyre [% / %], expected 0.0000 / MEASURED', r, st; END IF;

  SELECT projected_remaining_km, forecast_status INTO km, st
    FROM app.v_removal_forecast WHERE branded_number = 'T2FLAT1';
  IF km IS NOT NULL OR st IS DISTINCT FROM 'NO_MEASURABLE_WEAR' THEN
    RAISE EXCEPTION 'FAIL: unworn tyre forecast [% / %], expected NULL / NO_MEASURABLE_WEAR', km, st; END IF;

  -- and it stays out of every horizon rather than sitting at the top of one
  IF EXISTS (SELECT 1 FROM app.removal_forecast_within('2026-09-20', 36500)
              WHERE branded_number = 'T2FLAT1') THEN
    RAISE EXCEPTION 'FAIL: a tyre with no measurable wear appeared in a horizon list'; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  zero measured wear is a rate of zero and a withheld projection, not a missing rate';
END $$;

-- Two shapes the fixture cannot contain, both of which the horizon list has to
-- survive: a vehicle that is inspected without moving, and a vehicle with only
-- one capture to its name. The second is every vehicle on the first day of a
-- rollout, which is the worst possible day for an overdue tyre to be missing
-- from the replacement report.
--
-- Staged on tenant 2 and left VOIDED between runs: these tyres sit below the
-- removal threshold, so a live reading would put them in tenant 2's first
-- tread band and move check 19's pinned count. They come live for the length
-- of this check only.
DO $$
DECLARE dys int; dt date; st text; n int; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT pos.id INTO posid
    FROM app.position pos
   WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
     AND pos.code = '1';

  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE branded_number = 'T2PARK1') THEN
    INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,status) VALUES
      (md5('t2veh2')::uuid,'22222222-2222-2222-2222-222222222222','PARKED','CAA222222',md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'ACTIVE'),
      (md5('t2veh3')::uuid,'22222222-2222-2222-2222-222222222222','SOLO','CAA333333',md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'ACTIVE');
    INSERT INTO app.tyre (id,tenant_id,branded_number,status,state) VALUES
      (md5('t2parktyre')::uuid,'22222222-2222-2222-2222-222222222222','T2PARK1','NEW','FITTED'),
      (md5('t2solotyre')::uuid,'22222222-2222-2222-2222-222222222222','T2SOLO1','NEW','FITTED');
    INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2parktyre')::uuid,md5('t2veh2')::uuid,posid,'2027-01-01T06:00:00Z',59000,25.0),
      ('22222222-2222-2222-2222-222222222222',md5('t2solotyre')::uuid,md5('t2veh3')::uuid,posid,'2027-01-01T06:00:00Z',69000,25.0);
    -- the same odometer on two dates: a trailer that sat in the yard
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer) VALUES
      (md5('t2park1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh2')::uuid,md5('driver2')::uuid,md5('t2parkcli1')::uuid,'2027-02-01T08:00:00Z','2027-02-01T08:05:00Z',60000),
      (md5('t2park2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh2')::uuid,md5('driver2')::uuid,md5('t2parkcli2')::uuid,'2027-02-10T08:00:00Z','2027-02-10T08:05:00Z',60000),
      (md5('t2solo1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh3')::uuid,md5('driver2')::uuid,md5('t2solocli1')::uuid,'2027-03-01T08:00:00Z','2027-03-01T08:05:00Z',70000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa) VALUES
      (md5('t2parkrd1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2park1')::uuid,md5('t2veh2')::uuid,posid,md5('t2parktyre')::uuid,750),
      (md5('t2parkrd2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2park2')::uuid,md5('t2veh2')::uuid,posid,md5('t2parktyre')::uuid,750),
      (md5('t2solord1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2solo1')::uuid,md5('t2veh3')::uuid,posid,md5('t2solotyre')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,label,tread_mm) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,1,'OUTER',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,2,'CENTRE',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,3,'INNER',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,1,'OUTER',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,2,'CENTRE',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,3,'INNER',3),
      ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,1,'OUTER',2),
      ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,2,'CENTRE',2),
      ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,3,'INNER',2);
  END IF;
  UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL
   WHERE id IN (md5('t2park1')::uuid, md5('t2park2')::uuid, md5('t2solo1')::uuid);

  -- A parked vehicle divides zero distance by zero days. Reading the whole
  -- view is the assertion: an unguarded division takes down every row, not
  -- one of them, so a single parked trailer would blank the dashboard.
  SELECT count(*) INTO n FROM app.v_removal_forecast;
  IF n < 3 THEN RAISE EXCEPTION 'FAIL: forecast view returned % rows for tenant 2', n; END IF;

  SELECT projected_remaining_days, projected_removal_date, forecast_status
    INTO dys, dt, st FROM app.v_removal_forecast WHERE branded_number = 'T2PARK1';
  IF dys <> 0 OR dt <> '2027-02-10' OR st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: parked below-threshold tyre [%d / % / %], expected 0/2027-02-10/AT_OR_BELOW_THRESHOLD', dys, dt, st; END IF;

  -- One capture yields no daily distance at all, and zero remaining distance
  -- is still zero days: the tyre is already overdue and must be listed.
  SELECT projected_remaining_days, projected_removal_date INTO dys, dt
    FROM app.v_removal_forecast WHERE branded_number = 'T2SOLO1';
  IF dys <> 0 OR dt <> '2027-03-01' THEN
    RAISE EXCEPTION 'FAIL: single-capture below-threshold tyre [%d / %], expected 0/2027-03-01', dys, dt; END IF;
  SELECT count(*) INTO n FROM app.removal_forecast_within('2027-03-01', 0)
   WHERE branded_number = 'T2SOLO1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: an overdue tyre on a once-inspected vehicle is missing from the horizon list'; END IF;

  UPDATE app.inspection SET state = 'VOIDED', void_reason = 'TYRE-35 forecast probe'
   WHERE id IN (md5('t2park1')::uuid, md5('t2park2')::uuid, md5('t2solo1')::uuid);
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a vehicle that does not move, and one inspected only once, still forecast';
END $$;

-- Rule 6: timestamps are stored UTC. A bare cast to date reads the session
-- timezone, so a connection west of UTC would move every projected date by a
-- day against readings captured at 05:45Z.
DO $$
DECLARE dt date;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  PERFORM set_config('TimeZone', 'America/Los_Angeles', true);
  SELECT projected_removal_date INTO dt
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC2';
  IF dt <> '2027-03-30' THEN
    RAISE EXCEPTION 'FAIL: projected date is [%] from a non-UTC session, expected 2027-03-30', dt; END IF;
  SELECT projected_removal_date INTO dt
    FROM app.v_removal_forecast WHERE branded_number = '2102BAC18';
  IF dt <> '2026-07-23' THEN
    RAISE EXCEPTION 'FAIL: overdue date is [%] from a non-UTC session, expected 2026-07-23', dt; END IF;
  RAISE NOTICE 'PASS  projected dates hold from a session in another timezone';
END $$;

-- The horizon list is a set-returning function, so 8b's view sweep does not
-- reach it: prove RLS binds it directly from the other side.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT count(*) INTO n FROM app.removal_forecast_within('2026-07-23', 3650)
   WHERE tenant_id <> '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the horizon list returned % foreign-tenant rows', n; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate
   WHERE tenant_id <> '22222222-2222-2222-2222-222222222222';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the wear rate view returned % foreign-tenant rows', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  neither the wear rate view nor the horizon list crosses the tenant boundary';
END $$;

\echo ''
\echo '================  ALL CHECKS PASSED  ================'
