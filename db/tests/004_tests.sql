-- ============================================================================
-- Verification suite, run in CI as a NON-SUPERUSER (app_login) on every build
-- (NFR-SEC-005); running as postgres bypasses RLS and proves nothing.
-- 005_privileged.sql stages what this role cannot; not part of this suite
-- (B7 spec U12). Grep \echo == for the check index.
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

  -- Sweep every tenant-scoped table for foreign rows. Tenant-less tables are
  -- skipped here and pinned below: the only ones allowed are the isolation
  -- root itself and platform reference data (CHG-019), so a future table that
  -- forgets its tenant_id fails loudly instead of silently escaping the sweep.
  FOR leaked IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname='app' AND c.relkind IN ('r','p') AND c.relrowsecurity
       AND c.relname <> 'tenant'          -- keyed by id, checked separately below
       AND EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_schema='app' AND col.table_name=c.relname
                      AND col.column_name='tenant_id')
  LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE tenant_id <> %L', leaked,
                   '11111111-1111-1111-1111-111111111111') INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % rows of another tenant visible in app.%', n, leaked; END IF;
  END LOOP;
  -- the tenant table itself is keyed by id, not tenant_id
  SELECT count(*) INTO n FROM app.tenant;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: % tenant rows visible, expected exactly 1', n; END IF;

  -- the tenant-less allowlist itself. Each entry belongs to no tenant:
  -- tenant is the isolation root, jurisdiction_tread_minimum is public law
  -- (CHG-019), and the three platform_tyre_ tables are the catalogue every
  -- tenant is seeded from (FR-CFG-005, TYRE-369 D1).
  SELECT string_agg(c.relname, ', ') INTO leaked
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname='app' AND c.relkind IN ('r','p')
     AND c.relname NOT IN ('tenant', 'jurisdiction_tread_minimum',
                           'platform_tyre_size', 'platform_tyre_brand', 'platform_tyre_pattern')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema='app' AND col.table_name=c.relname
                        AND col.column_name='tenant_id');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: table(s) without tenant_id outside the reference-data allowlist: %', leaked;
  END IF;
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
DECLARE bad text;
BEGIN
  -- current_user, not the literal 'app_rw': a grant to app_login itself or
  -- through any other membership reaches the connection just as surely as
  -- one on app_rw's own ACL row.

  -- has_any_column_privilege, not has_table_privilege: a column-level grant
  -- such as GRANT UPDATE (pressure_kpa) ON app.reading reaches that column,
  -- and has_table_privilege sees only a grant on the whole table.

  -- INSERT: platform reference data (CHG-019, FR-CFG-005) and the tenant
  -- row itself (TYRE-158) are written as postgres, never through the app
  -- role.
  SELECT string_agg(t || '.' || v, ', ') INTO bad
    FROM (VALUES
      ('jurisdiction_tread_minimum','INSERT'),
      ('platform_tyre_size','INSERT'),
      ('platform_tyre_brand','INSERT'),
      ('platform_tyre_pattern','INSERT'),
      ('tenant','INSERT')
    ) AS revoked(t, v)
   WHERE has_any_column_privilege(current_user, 'app.' || t, v);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: app role retains revoked privilege(s): %', bad;
  END IF;

  -- UPDATE is deny-by-default (CR-004, DR-011, TYRE-309): a table off this
  -- allow-list, existing or new, is a record of fact the app role may not
  -- rewrite, so any UPDATE grant on it fails here until someone decides the
  -- table is edited in place and adds it.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND has_any_column_privilege(current_user, c.oid, 'UPDATE')
     AND c.relname NOT IN (
       'app_user', 'axle_configuration', 'combination',
       'configuration', 'depot', 'display_code_counter', 'exception',
       'exception_rule', 'fitment', 'inspection_schedule', 'inspection_task',
       'notification', 'operating_group', 'photo', 'position', 'retread_job',
       'target_pressure', 'tyre', 'tyre_brand', 'tyre_pattern',
       'tyre_size', 'user_depot', 'valuation_snapshot',
       'vehicle', 'vehicle_driver', 'vehicle_tag', 'vehicle_tag_map',
       -- inspection's grant is (state, void_reason) alone (000040, FR-INS-012);
       -- section 51 pins that column shape.
       'inspection',
       -- tyre_receipt's grant is (price_state, invoice_number) alone, and
       -- tyre_receipt_moves_once holds its moves (000059, section 75h).
       'tyre_receipt',
       -- trip's grant is (ended_at, ended_by) alone, and trip_is_ended_once
       -- holds its one move (000060, section 76c).
       'trip');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: app role can UPDATE a table off the allow-list: %', bad;
  END IF;

  -- DELETE is read from the catalogue, so every table enrols itself,
  -- including one no REVOKE ever named (CR-004, DR-014a).

  -- The two deliberate DELETE exceptions: valuation_snapshot is a derived
  -- cache the month-end reconcile prunes, so 000018_delete_revoke_dr014a
  -- leaves its DELETE in place (DR-014a), and 000035 restores
  -- vehicle_tag_map's (FR-VEH-041, U6).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND c.relname NOT IN ('valuation_snapshot', 'vehicle_tag_map')
     AND has_table_privilege(current_user, c.oid, 'DELETE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: app role can DELETE an append-only table: %', bad;
  END IF;

  -- TRUNCATE bypasses RLS entirely: it is not a DML statement a policy
  -- inspects, so the allow-list is empty. No migration has ever granted it.
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND has_table_privilege(current_user, c.oid, 'TRUNCATE');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: app role can TRUNCATE a table, which RLS cannot see: %', bad;
  END IF;

  RAISE NOTICE 'PASS  app role holds none of the revoked INSERT grants, can UPDATE only allow-listed tables, cannot DELETE an append-only table, and cannot TRUNCATE any table';
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
            (SELECT id FROM app.tyre ORDER BY display_code LIMIT 1), v, p, now(), 500000);
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
    IF got IS DISTINCT FROM r.expected THEN
      RAISE WARNING 'FAIL % : expected % got %', r.tyre, r.expected, got;
      fails := fails + 1;
    END IF;
  END LOOP;
  IF fails > 0 THEN RAISE EXCEPTION 'FAIL: % valuation rows did not reproduce', fails; END IF;
  RAISE NOTICE 'PASS  all 15 Appendix E valuations reproduce to the cent';
  IF app.rand_per_mm(4319.91, 25.0, 4) IS DISTINCT FROM 205.7100 THEN
    RAISE EXCEPTION 'FAIL: rand_per_mm derivation wrong, got %', app.rand_per_mm(4319.91,25.0,4);
  END IF;
  RAISE NOTICE 'PASS  rand_per_mm = purchase_price / usable tread';
END $$;

\echo '== 8. Appendix J fixture produces exactly the expected exceptions, through app.v_exception'
-- Appendix J is the exception set of ONE capture sheet, the 2026-07-23 one.
-- The view resolves each unit's latest non-voided inspection (spec D2), so
-- no query here names the sheet: section 59 proves the resolution lands on
-- it. The sheet's 1..26 numbering is a display projection (CFL-006), so the
-- position rows join v_combination_reading for it; that view carries running
-- positions only, so the spare's rows are asserted on is_spare.
DO $$
DECLARE got text; expected text;
BEGIN
  -- FR-EXC-020: governing depth at or below the removal threshold (U2)
  SELECT string_agg(c.combination_position::text, ',' ORDER BY c.combination_position) INTO got
    FROM app.v_exception e
    JOIN app.v_combination_reading c
      ON c.inspection_id = e.inspection_id AND c.vehicle_id = e.vehicle_id AND c.unit_own_code = e.position_code
   WHERE e.rule_code = 'FR-EXC-020';
  expected := '7,8,11,12,13,16,18,21,22';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-020: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-020 below removal threshold -> %', got;

  -- FR-EXC-021: the band above the removal threshold and below the warning
  -- threshold (U3); Appendix J.2 lists position 14 alone
  SELECT string_agg(c.combination_position::text, ',' ORDER BY c.combination_position) INTO got
    FROM app.v_exception e
    JOIN app.v_combination_reading c
      ON c.inspection_id = e.inspection_id AND c.vehicle_id = e.vehicle_id AND c.unit_own_code = e.position_code
   WHERE e.rule_code = 'FR-EXC-021';
  expected := '14';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-021: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-021 approaching threshold -> %', got;

  -- FR-EXC-035: width-wise spread at or above the configured margin, running
  -- positions through the projection, the spare on its own (U4)
  SELECT string_agg(c.combination_position::text, ',' ORDER BY c.combination_position) INTO got
    FROM app.v_exception e
    JOIN app.v_combination_reading c
      ON c.inspection_id = e.inspection_id AND c.vehicle_id = e.vehicle_id AND c.unit_own_code = e.position_code
   WHERE e.rule_code = 'FR-EXC-035';
  expected := '5,6,7,8,18';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-035: expected [%] got [%]', expected, got; END IF;
  SELECT string_agg(e.position_code || '@' || e.measure_mm, ',') INTO got
    FROM app.v_exception e WHERE e.rule_code = 'FR-EXC-035' AND e.is_spare;
  IF got IS DISTINCT FROM 'S@4.0' THEN
    RAISE EXCEPTION 'FAIL FR-EXC-035: spare expected [S@4.0] got [%]', got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-035 irregular wear -> 5,6,7,8,18 and the spare';

  -- FR-EXC-038: spare at or below threshold, raised despite BR-RPT-001
  SELECT string_agg(e.position_code || '@' || e.measure_mm, ',') INTO got
    FROM app.v_exception e WHERE e.rule_code = 'FR-EXC-038';
  IF got IS DISTINCT FROM 'S@2.0' THEN
    RAISE EXCEPTION 'FAIL FR-EXC-038: expected [S@2.0] got [%]', got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-038 spare below threshold -> %', got;

  -- FR-EXC-036: dual-mate mismatch, presented in ascending position order; on
  -- a right-side axle end the OUTER tyre carries the higher number (BR-VEH-001)
  SELECT string_agg(least(o.combination_position, i2.combination_position) || '/'
                 || greatest(o.combination_position, i2.combination_position)
                 || ' = ' || e.measure_mm || 'mm', ', ') INTO got
    FROM app.v_exception e
    JOIN app.v_combination_reading o  ON o.inspection_id = e.inspection_id AND o.vehicle_id = e.vehicle_id
                                     AND o.unit_own_code = e.position_code
    JOIN app.v_combination_reading i2 ON i2.inspection_id = e.inspection_id AND i2.vehicle_id = e.vehicle_id
                                     AND i2.unit_own_code = e.position_code_2
   WHERE e.rule_code = 'FR-EXC-036';
  expected := '17/18 = 7.0mm';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-036: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-036 dual-mate mismatch -> %', got;

  -- FR-EXC-022: pressure below the critical band, target resolved by
  -- app.target_pressure_for, the one pressure-target source (CHG-112, U10)
  SELECT string_agg(c.combination_position || ' @ ' || (e.detail ->> 'pressure_kpa') || 'kPa', ',') INTO got
    FROM app.v_exception e
    JOIN app.v_combination_reading c
      ON c.inspection_id = e.inspection_id AND c.vehicle_id = e.vehicle_id AND c.unit_own_code = e.position_code
   WHERE e.rule_code = 'FR-EXC-022';
  expected := '16 @ 200kPa';
  IF got IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL FR-EXC-022: expected [%] got [%]', expected, got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-022 dangerously under-inflated -> %', got;

  -- The three POC rules the sheet does not trip, pinned at zero so the
  -- boundary Appendix J.2 states for FR-EXC-039 ("not raised") is a check
  SELECT string_agg(rule_code || ':' || n, ',' ORDER BY rule_code) INTO got
    FROM (SELECT rule_code, count(*) AS n FROM app.v_exception
           WHERE rule_code IN ('FR-EXC-023', 'FR-EXC-028', 'FR-EXC-039') GROUP BY rule_code) z;
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL FR-EXC-023/028/039: expected none, got [%]', got; END IF;
  RAISE NOTICE 'PASS  FR-EXC-023, 028 and 039 raise nothing on the sheet';
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
-- Companion to 8b's blind spot: 8b sweeps relkind='v', but tenant-scoped
-- logic also lives in routines (app.tyre_valuation_asof, TYRE-33), and a
-- SECURITY DEFINER one owned by the migration superuser would bypass RLS
-- entirely (FR-TEN-004) and merge green. Each allowlisted routine carries
-- its own tenant backstop, documented at the function.
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
     -- the same-tenant backstop it carries in place of RLS (body since 000050).
     AND p.proname <> ALL (ARRAY['refresh_governing_tread']);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: SECURITY DEFINER routine(s) outside the allowlist, RLS does not bind them: %', offenders;
  END IF;
  RAISE NOTICE 'PASS  no unreviewed routine runs with RLS bypassed';
END $$;

\echo '== 8d. search_path is pinned where names resolve at run time and left open where the planner inlines (TYRE-181)'
-- Two halves, one house rule (000043): a plpgsql routine resolves names at
-- run time, so it needs a pinned search_path against the 000004 hijack; a
-- LANGUAGE sql function inlined into a view (000036) is not, since a SET
-- clause there blocks inlining and changes the view's plan. Scalar sql
-- routines may go either way and are not swept.
DO $$
DECLARE unpinned text; pinned_tf text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO unpinned
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.prokind IN ('f','p')
     AND l.lanname = 'plpgsql'
     AND NOT coalesce(p.proconfig @> ARRAY['search_path=app, pg_temp'], false);
  IF unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: plpgsql routine(s) with no pinned search_path: %', unpinned;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO pinned_tf
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'app'::regnamespace
     AND l.lanname = 'sql' AND p.proretset
     AND p.proconfig IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_depend d
                   JOIN pg_rewrite r ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
                   JOIN pg_class c ON c.oid = r.ev_class AND c.relkind = 'v'
                  WHERE d.refclassid = 'pg_proc'::regclass AND d.refobjid = p.oid);
  IF pinned_tf IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: sql table function(s) a view is built over carry a SET clause, which blocks inlining (000036): %', pinned_tf;
  END IF;
  RAISE NOTICE 'PASS  every plpgsql routine pins search_path; every inlined table function leaves it open';
END $$;

\echo '== 9. Combination numbering resolves to constituent units (BR-VEH-003, CFL-006)'
-- The 1..26 projection is computed from combination_member.sequence plus each
-- unit's own position order. No stored mapping exists to drift from the
-- composition (the table that held one is dropped, asserted in check 22).
DO $$
DECLARE got text;
BEGIN
  SELECT string_agg(x.txt, ' | ') INTO got FROM (
    SELECT v.member_sequence || ': ' || min(v.combination_position) || '-' || max(v.combination_position)
           || ' -> ' || min(v.unit_own_code::int) || '-' || max(v.unit_own_code::int) AS txt
      FROM app.v_combination_reading v
     WHERE v.inspection_id = md5('insp1')::uuid
     GROUP BY v.member_sequence ORDER BY v.member_sequence) x;
  IF got IS DISTINCT FROM '1: 1-10 -> 1-10 | 2: 11-18 -> 1-8 | 3: 19-26 -> 1-8' THEN
    RAISE EXCEPTION 'FAIL: superlink projection wrong: %', got; END IF;
  RAISE NOTICE 'PASS  the computed superlink projection maps %', got;
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
-- the grant itself. A seeded user would trip inspection's FK first and the
-- check would pass for the wrong reason.
DO $$
DECLARE ok boolean := false;
BEGIN
  -- ON CONFLICT because the probe row outlives a passing run: cleaning it up
  -- would need the very DELETE this check exists to forbid.
  INSERT INTO app.app_user (tenant_id, email, display_name, role)
  VALUES ('11111111-1111-1111-1111-111111111111', 'deleteme@example.invalid', 'Deletion probe', 'DRIVER')
  -- lower(email): the arbiter must name 000027's folded index or inference
  -- finds nothing and the insert errors instead of skipping.
  ON CONFLICT (tenant_id, lower(email)) DO NOTHING;
  BEGIN
    DELETE FROM app.app_user WHERE email = 'deleteme@example.invalid';
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: app role can DELETE app.app_user'; END IF;
  RAISE NOTICE 'PASS  users are deactivated, never deleted';
END $$;

-- FR-AUT-022 (errata E1 note): staff numbers are unique among ACTIVE users
-- and reusable across time, the display-code lesson of 000011 applied to
-- people. TYRE-64 carries the sponsor question; this partial-index default
-- survives both possible answers. Transaction-scoped: nothing persists.
BEGIN;
DO $$
DECLARE dup boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.app_user (id, tenant_id, email, display_name, staff_number, role, active)
  VALUES (md5('staffprobe1')::uuid, '11111111-1111-1111-1111-111111111111',
          'staffprobe1@example.invalid', 'Staff probe one', 'EMP9001', 'DRIVER', true);
  BEGIN
    INSERT INTO app.app_user (id, tenant_id, email, display_name, staff_number, role, active)
    VALUES (md5('staffprobe2')::uuid, '11111111-1111-1111-1111-111111111111',
            'staffprobe2@example.invalid', 'Staff probe two', 'EMP9001', 'DRIVER', true);
    dup := true;
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF dup THEN RAISE EXCEPTION 'FAIL: two ACTIVE users share staff_number EMP9001'; END IF;
  -- deactivation frees the number: unique among things currently in play
  UPDATE app.app_user SET active = false WHERE id = md5('staffprobe1')::uuid;
  INSERT INTO app.app_user (id, tenant_id, email, display_name, staff_number, role, active)
  VALUES (md5('staffprobe3')::uuid, '11111111-1111-1111-1111-111111111111',
          'staffprobe3@example.invalid', 'Staff probe three', 'EMP9001', 'DRIVER', true);
  RAISE NOTICE 'PASS  staff numbers are unique among active users, reusable after deactivation';
END $$;
ROLLBACK;

\echo '== 12. Every table in schema app is under forced RLS, and app holds nothing that cannot be'
-- Structural companion to the data sweep in check 2: that sweep only visits
-- tables that already have RLS, so a table someone forgot to enrol would
-- never be swept at all. This closes that hole for every future table.
DO $$
DECLARE missing text;
BEGIN
  -- 'p' as well: a query on a partitioned parent applies the parent's
  -- policies, not its partitions', so a parent without forced RLS of its
  -- own returns every partition's rows (TYRE-301).
  SELECT string_agg(c.relname, ', ') INTO missing
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: table(s) without forced RLS: %', missing;
  END IF;
  RAISE NOTICE 'PASS  every app table, partitioned parents included, has RLS enabled and forced';
END $$;

-- A materialized view or a foreign table takes the schema's default SELECT
-- grant to app_rw and can carry no policy, so either one hands the app role
-- every tenant's rows. Neither kind may exist in app (TYRE-301).
DO $$
DECLARE found text;
BEGIN
  SELECT string_agg(c.relname || CASE c.relkind WHEN 'm' THEN ' (materialized view)'
                                                ELSE ' (foreign table)' END,
                    ', ' ORDER BY c.relname) INTO found
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'app' AND c.relkind IN ('m', 'f');
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: app holds relation(s) that cannot carry RLS: %', found;
  END IF;
  RAISE NOTICE 'PASS  app holds no materialized view and no foreign table';
END $$;

-- Policy SHAPE, not just presence: the sweep above cannot tell a policy that
-- binds writes to this tenant from one that does not. Every policy must
-- match the canonical expression exactly, not merely mention the tenant
-- function: a substring match would pass a widened policy such as
-- `USING (tenant_id = app.current_tenant_id() OR true)` (TYRE-178).
DO $$
DECLARE bad text;
BEGIN
  -- The canonical text omits the `app.` qualifier: this session's
  -- search_path puts app first, so pg_get_expr renders the call unqualified.
  SELECT string_agg(c.relname || '.' || p.polname, ', ') INTO bad
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relnamespace = 'app'::regnamespace
     -- The read-everyone policies on platform reference data are the named
     -- exceptions (CHG-019, FR-CFG-005), each matched by table, name and
     -- shape: SELECT only, USING (true), no WITH CHECK. The same name on
     -- another table, or one of these widened to writes, falls through to
     -- the canonical test below (TYRE-309).
     AND NOT ((c.relname, p.polname) IN (('jurisdiction_tread_minimum', 'jurisdiction_public_read'),
                                         ('platform_tyre_size', 'platform_catalogue_public_read'),
                                         ('platform_tyre_brand', 'platform_catalogue_public_read'),
                                         ('platform_tyre_pattern', 'platform_catalogue_public_read'))
              AND p.polcmd = 'r' AND p.polwithcheck IS NULL
              AND pg_get_expr(p.polqual, p.polrelid) = 'true')
     AND (COALESCE(pg_get_expr(p.polqual, p.polrelid), '') <>
            CASE WHEN c.relname = 'tenant' THEN '(id = current_tenant_id())'
                 ELSE '(tenant_id = current_tenant_id())' END
       OR COALESCE(pg_get_expr(p.polwithcheck, p.polrelid), '') <>
            CASE WHEN c.relname = 'tenant' THEN '(id = current_tenant_id())'
                 ELSE '(tenant_id = current_tenant_id())' END);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: policy without the canonical tenant-bound USING and WITH CHECK: %', bad;
  END IF;
  RAISE NOTICE 'PASS  every policy binds USING and WITH CHECK to the tenant context, verbatim';
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
    INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
    VALUES ('11111111-1111-1111-1111-111111111111', 'HORSE',
            md5('11111111-1111-1111-1111-111111111111HORSE_6X4')::uuid, 'HORSE');
    RAISE EXCEPTION 'FAIL: duplicate fleet number accepted within a tenant';
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  IF ok THEN RAISE NOTICE 'PASS  fleet numbers collide within a tenant, coexist across tenants'; END IF;
END $$;

\echo '== 15. Trips: the open set, history, attribution, scoping (FR-VEH-007/008 as amended, FR-AUT-005)'
DO $$
DECLARE got text; n int;
BEGIN
  -- Self-contained: pin tenant 1 rather than inherit check 14's session state.
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  -- One driver per motive at an instant (U143); Sipho's ended trip must not
  -- appear.
  SELECT string_agg(v.fleet_number || '=' || u.display_name, ',' ORDER BY v.fleet_number) INTO got
    FROM app.trip t
    JOIN app.vehicle v ON v.id = t.vehicle_id
    JOIN app.app_user u ON u.id = t.user_id
   WHERE t.ended_at IS NULL;
  IF got IS DISTINCT FROM 'HORSE=Melusi' THEN
    RAISE EXCEPTION 'FAIL: open trips wrong: [%]', got; END IF;

  -- FR-VEH-008: the ended trip stays queryable history.
  SELECT count(*) INTO n FROM app.trip;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 trips including history, got %', n; END IF;

  -- FR-VEH-008: the fixture inspection's driver held a trip on that vehicle
  -- when it started.
  SELECT u.display_name INTO got
    FROM app.inspection i
    JOIN app.trip t ON t.vehicle_id = i.vehicle_id
                   AND tstzrange(t.started_at, t.ended_at, '[)') @> i.started_at
    JOIN app.app_user u ON u.id = t.user_id
   WHERE i.id = md5('insp1')::uuid AND u.id = i.user_id;
  IF got IS DISTINCT FROM 'Melusi' THEN
    RAISE EXCEPTION 'FAIL: inspection driver held no trip at the time, got [%]', got; END IF;
  RAISE NOTICE 'PASS  open trips, retained history and attribution all hold';
END $$;

DO $$
DECLARE got text; n int;
BEGIN
  -- FR-AUT-005 through the one predicate the API composes (ADR-0006): the
  -- trip's motive and the units its open rig tows.
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);
  SELECT string_agg(DISTINCT fleet_number, ',' ORDER BY fleet_number) INTO got
    FROM app.v_driver_vehicle;
  IF got IS DISTINCT FROM 'HORSE,LINK12,LINK6' THEN
    RAISE EXCEPTION 'FAIL: driver sees [%], expected HORSE,LINK12,LINK6', got; END IF;
  -- A tenant-1 session carrying tenant-2's driver id must see nothing: the
  -- tenant predicate binds before the actor predicate, so a stale or stolen
  -- actor id cannot cross the tenant boundary.
  PERFORM set_config('app.actor_id', md5('driver2')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_driver_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: foreign-tenant actor sees % vehicles', n; END IF;
  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_driver_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % vehicles', n; END IF;
  RAISE NOTICE 'PASS  a driver sees exactly their trip''s units; foreign or unset actor sees none';
END $$;

-- The predicate reads "today" from the tenant's calendar (FR-AUT-005,
-- CR-003): at 00:30 SAST the UTC calendar still says yesterday, which under
-- 000003 hid a driver assigned from today exactly when a long-haul pre-trip
-- walk-around happens. Pinned through the injectable clock so the midnight
-- boundary holds whatever time the suite runs.
DO $$
BEGIN
  IF app.tenant_today('Africa/Johannesburg', timestamptz '2026-08-24 00:30:00+02:00')
       IS DISTINCT FROM date '2026-08-24' THEN
    RAISE EXCEPTION 'FAIL: tenant_today reads [%] at 00:30 SAST',
      app.tenant_today('Africa/Johannesburg', timestamptz '2026-08-24 00:30:00+02:00');
  END IF;
  -- control: the same instant on the UTC calendar is the previous day, so
  -- the assertion above genuinely distinguishes the two predicates
  IF (timestamptz '2026-08-24 00:30:00+02:00' AT TIME ZONE 'UTC')::date
       IS DISTINCT FROM date '2026-08-23' THEN
    RAISE EXCEPTION 'FAIL: UTC control no longer distinguishes the calendars';
  END IF;
  RAISE NOTICE 'PASS  tenant_today puts 00:30 SAST on the tenant''s civil date';
END $$;

-- The live path: a handover at now moves the unit and its rig to the new
-- driver at once. Transaction-scoped: nothing persists.
BEGIN;
DO $$
DECLARE got text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  UPDATE app.trip SET ended_at = now() WHERE id = md5('trip1')::uuid;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES ('11111111-1111-1111-1111-111111111111', md5('veh1')::uuid, md5('driver3')::uuid, now());
  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, true);
  SELECT string_agg(DISTINCT fleet_number, ',' ORDER BY fleet_number) INTO got FROM app.v_driver_vehicle;
  IF got IS DISTINCT FROM 'HORSE,LINK12,LINK6' THEN
    RAISE EXCEPTION 'FAIL: the new driver sees [%] after a handover at now, expected HORSE,LINK12,LINK6', got;
  END IF;
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  SELECT count(*) INTO n FROM app.v_driver_vehicle;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: the old driver still sees % vehicles after the handover', n;
  END IF;
  PERFORM set_config('app.actor_id', '', true);
  RAISE NOTICE 'PASS  a handover at now moves the unit and its rig to the new driver';
END $$;
ROLLBACK;

\echo '== 16. Foreign keys cannot dangle across tenants (CR-001, DR-017)'
-- FK checks bypass RLS by design, so an id-only FK lets a session reference a
-- row it cannot see, and through triggers corrupt it (TYRE-29). First the
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
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known)
    VALUES ('22222222-2222-2222-2222-222222222222', victim, 4, 'OUTER', 0.1, true);
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
-- omits tenant_id. Each one is the same dangling-reference class.
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(c.conrelid::regclass || '.' || c.conname, ', ') INTO offender
    FROM pg_constraint c
    JOIN pg_class parent ON parent.oid = c.confrelid
   WHERE c.contype = 'f'
     AND c.connamespace = 'app'::regnamespace
     AND parent.relname <> 'tenant'
     -- The platform catalogue belongs to no tenant and every tenant reads
     -- it, so a reference to it below RLS reaches nothing a session could
     -- not already read (FR-CFG-005, TYRE-369 D1).
     AND parent.relname NOT IN ('platform_tyre_size', 'platform_tyre_brand', 'platform_tyre_pattern')
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
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE display_code = '2102BAC2';
  IF v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 tread value [%], expected 2057.10', v; END IF;
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE display_code = '2102BAC18';
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
-- Transaction-scoped: DR-014a revoked DELETE, so probes roll back instead of
-- cleaning up, and the estate totals later checks pin stay untouched.
BEGIN;
DO $$
DECLARE got text; n int; v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state,last_tread_mm)
  VALUES (md5('valprobe1')::uuid,'11111111-1111-1111-1111-111111111111','PROBE1','NEW','2024-03-01',4320.00,25.0,205.7100,100.00,'IN_STOCK',10.0);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,casing_value,state)
  VALUES (md5('valprobe2')::uuid,'11111111-1111-1111-1111-111111111111','PROBE2','NEW',50.00,'IN_STOCK');

  SELECT tread_source, tread_value::text INTO got, v FROM app.v_tyre_valuation WHERE display_code = 'PROBE1';
  IF got IS DISTINCT FROM 'AUDIT' OR v IS DISTINCT FROM 1234.26 THEN
    RAISE EXCEPTION 'FAIL: PROBE1 source [%] value [%], expected AUDIT/1234.26', got, v; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_valuation WHERE display_code = 'PROBE2' AND tread_value IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: incomplete PROBE2 was given a tread value'; END IF;
  -- CHG-115: the incomplete record is INCLUDED and labelled, not dropped
  SELECT valuation_basis INTO got FROM app.v_tyre_valuation WHERE display_code = 'PROBE2';
  IF got IS DISTINCT FROM 'UNVALUED' THEN
    RAISE EXCEPTION 'FAIL: PROBE2 basis [%], expected UNVALUED', got; END IF;

  SELECT tyre_count, tread_value, casing_value INTO n, v, c
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'IN_STOCK';
  IF n <> 2 OR v IS DISTINCT FROM 1234.26 OR c IS DISTINCT FROM 150.00 THEN
    RAISE EXCEPTION 'FAIL: IN_STOCK split n=% tread=% casing=%, expected 2/1234.26/150.00', n, v, c; END IF;
  -- Estate total deliberately counts the casing of unvalued tyres. Casing is
  -- a stored fact and only the tread side is unknown, so it exceeds the sum of
  -- per-tyre totals (NULL for PROBE2) by exactly PROBE2's casing. The
  -- unvalued_count column is what flags the gap.
  SELECT unvalued_count, tread_value, casing_value, total_value INTO n, v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF n <> 1 OR v IS DISTINCT FROM 21805.26 OR c IS DISTINCT FROM 49762.50 OR tot IS DISTINCT FROM 71567.76 THEN
    RAISE EXCEPTION 'FAIL: with probes unvalued=% tread=% casing=% total=%, expected 1/21805.26/49762.50/71567.76', n, v, c, tot; END IF;

  RAISE NOTICE 'PASS  stock is split out, audit tread values, incomplete records are excluded not invented';
END $$;
ROLLBACK;

-- Rule 8 through the production path: rand_per_mm is the tyre's own figure,
-- never the pattern's. SP431's real batches diverge (R205.71 vs R284.38).
-- Check 7 pins the pure function; this pins the register reading real rows.
-- Transaction-scoped (DR-014a, check 20's cleanup pattern): a persisted
-- SP431 row would move estate totals (BR-VAL-008) and check 20's own
-- coupling probes (TYRE-62).
BEGIN;
DO $$
DECLARE v1 numeric; v2 numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, pattern_id, status, purchase_date,
                        purchase_price, new_tread_mm, rand_per_mm, casing_value, state, last_tread_mm)
  VALUES
    (md5('rateprobe1')::uuid, '11111111-1111-1111-1111-111111111111', 'RATEPROBE1',
     md5('pt1')::uuid, 'NEW', '2021-02-01', 4319.91, 25.0, 205.7100, 100.00, 'IN_STOCK', 12.0),
    (md5('rateprobe2')::uuid, '11111111-1111-1111-1111-111111111111', 'RATEPROBE2',
     md5('pt1')::uuid, 'NEW', '2021-07-01', 5972.00, 25.0, 284.3800, 100.00, 'IN_STOCK', 12.0);
  SELECT tread_value INTO v1 FROM app.v_tyre_valuation WHERE display_code = 'RATEPROBE1';
  SELECT tread_value INTO v2 FROM app.v_tyre_valuation WHERE display_code = 'RATEPROBE2';
  IF v1 IS DISTINCT FROM 1645.68 OR v2 IS DISTINCT FROM 2275.04 THEN
    RAISE EXCEPTION 'FAIL: one pattern, one tread, register valued [%]/[%], expected 1645.68/2275.04', v1, v2;
  END IF;
  RAISE NOTICE 'PASS  two tyres sharing a pattern value at their own rand_per_mm through the register';
END $$;
ROLLBACK;

-- The threshold is tenant policy, not a constant (FR-CFG-010, CR-005, CHG-111):
-- threshold_policy is the one source the resolvers read, so prove the
-- valuation follows a POLICY ROW change. 67mm remain over a 6mm threshold.
-- Transaction-scoped probe; the rollback IS the cleanup under DR-014a.
BEGIN;
DO $$
DECLARE v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.threshold_policy (id,tenant_id,retread_threshold_mm,max_retreads)
  VALUES (md5('thrprobe6')::uuid,'11111111-1111-1111-1111-111111111111',6.0,2);
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 13782.57 THEN
    RAISE EXCEPTION 'FAIL: at 6mm threshold expected 13782.57, got %', v; END IF;
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE display_code = '2102BAC2';
  IF v IS DISTINCT FROM 1645.68 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 at 6mm threshold expected 1645.68, got %', v; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT tread_value INTO v FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF v IS DISTINCT FROM 20571.00 THEN
    RAISE EXCEPTION 'FAIL: totals did not restore after the threshold probe, got %', v; END IF;
  -- the retired config key must be gone (no dual source, CHG-111)
  IF EXISTS (SELECT 1 FROM app.configuration
              WHERE key IN ('removal_threshold_mm','warning_threshold_mm')) THEN
    RAISE EXCEPTION 'FAIL: retired threshold config key still seeded'; END IF;
END $$;

-- ...and inert: a stray retired row must not out-resolve the policy table.
BEGIN;
DO $$
DECLARE v numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.configuration (tenant_id,key,value)
  VALUES ('11111111-1111-1111-1111-111111111111','removal_threshold_mm','9'::jsonb);
  SELECT tread_value INTO v FROM app.v_tyre_valuation WHERE display_code = '2102BAC2';
  IF v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: a stray retired config key moved the valuation to %', v; END IF;
  RAISE NOTICE 'PASS  a threshold policy row change moves the valuation; the retired key is inert';
END $$;
ROLLBACK;

-- With no threshold policy in force the register is unvalued and labelled,
-- never a silent R0.00 (CHG-115): db/tests/005_privileged.sql P3. Policy rows
-- are written once (U69), so only a superuser can stage a configured tenant
-- with no threshold.

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
   WHERE display_code = '2102BAC1';
  IF v IS DISTINCT FROM 1954.25 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 as at 2026-07-01 [%], expected 1954.25', v; END IF;

  -- After the inspection: same cent-exact totals as the live view, all fresh
  SELECT sum(tread_value), sum(casing_value), count(*) FILTER (WHERE stale) INTO v, c, n
    FROM app.tyre_valuation_asof('2026-08-01');
  IF v IS DISTINCT FROM 20571.00 OR c IS DISTINCT FROM 49612.50 OR n <> 0 THEN
    RAISE EXCEPTION 'FAIL: as at 2026-08-01 tread=% casing=% stale=%, expected 20571.00/49612.50/0', v, c, n; END IF;
  SELECT tread_value INTO v FROM app.tyre_valuation_asof('2026-08-01') WHERE display_code = '2102BAC2';
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
   WHERE t.display_code = '2102BAC2' AND s.as_at = '2026-07-23';
  IF mm IS DISTINCT FROM 14.0 OR v IS DISTINCT FROM 2057.10 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 snapshot [% mm / %], expected 14.0 / 2057.10', mm, v; END IF;
  RAISE NOTICE 'PASS  the fixture inspection left one snapshot per tyre at its date';
END $$;

-- Change versus no-change, driven from the tenant-2 side so the append-only
-- residue (readings cannot be deleted) stays out of the tenant-1 pinned
-- figures. The rollback below is what makes this section re-runnable and
-- re-tested, not a guard around the inserts (lesson 2026-09-01).
BEGIN;
DO $$
DECLARE n int; v numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
  VALUES (md5('t2probetyre')::uuid,'22222222-2222-2222-2222-222222222222','T2PROBE1','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t2insp1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t2cli1')::uuid,'2026-08-10T08:00:00Z','2026-08-10T08:05:00Z',100000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t2rd1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp1')::uuid,md5('t2veh1')::uuid,posid,md5('t2probetyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,1,'OUTER',12,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,2,'CENTRE',13,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd1')::uuid,3,'INNER',14,true);
  -- date-scoped: the month-end block later adds its own 2026-08-31 row for
  -- this tyre, and the suite must stay re-runnable after it has
  SELECT count(*), min(s.tread_value) INTO n, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2probetyre')::uuid AND s.as_at = '2026-08-10';
  IF n <> 1 OR v IS DISTINCT FROM 800.00 THEN
    RAISE EXCEPTION 'FAIL: tread change made % snapshots at [%], expected 1 at 800.00', n, v; END IF;

  -- An identical re-read is not a change: no second snapshot (FR-VAL-022)
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t2insp2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t2cli2')::uuid,'2026-08-15T08:00:00Z','2026-08-15T08:05:00Z',101000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t2rd2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp2')::uuid,md5('t2veh1')::uuid,posid,md5('t2probetyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,1,'OUTER',12,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,2,'CENTRE',13,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd2')::uuid,3,'INNER',14,true);
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tyre_id = md5('t2probetyre')::uuid AND as_at = '2026-08-15';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unchanged re-read wrote % snapshot(s)', n; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a tread change snapshots once; an unchanged re-read does not';
END $$;

-- A late-synced snapshot is priced under the policy of its own date, not the
-- policy in force when it syncs (FR-CFG-010): db/tests/005_privileged.sql P8,
-- because its probe row is dated between the two, which 000054 refuses to
-- every role (U70).

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
ROLLBACK;

-- The baseline threshold_policy row is a sentinel (-infinity, SRS §5.1
-- errata E1): history before onboarding resolves to the baseline, never to
-- 'no policy configured'. 2021-10-04 is the survey date, years before any
-- onboarding date the fixture carries, which is the class of as-at date the
-- sentinel exists to resolve.
DO $$
DECLARE mm numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  mm := app.removal_threshold_mm_for('11111111-1111-1111-1111-111111111111',
                                     timestamptz '2021-10-04 00:00:00+00');
  IF mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL: pre-onboarding as-at resolved threshold [%], expected the 4.0 baseline', mm;
  END IF;
  RAISE NOTICE 'PASS  the sentinel baseline policy governs history before onboarding';
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
  IF n IS DISTINCT FROM 27 OR tot IS DISTINCT FROM 194.0 OR av IS DISTINCT FROM 7.19 THEN
    RAISE EXCEPTION 'FAIL: tenant ALL %/%/%, expected 27/194.0/7.19', n, tot, av; END IF;

  SELECT tyre_count, total_tread_mm, avg_tread_mm INTO n, tot, av
    FROM app.v_tread_summary WHERE level='TENANT' AND position_class='RUNNING';
  IF n IS DISTINCT FROM 26 OR tot IS DISTINCT FROM 192.0 OR av IS DISTINCT FROM 7.38 THEN
    RAISE EXCEPTION 'FAIL: tenant RUNNING %/%/%, expected 26/192.0/7.38', n, tot, av; END IF;

  SELECT tyre_count, total_tread_mm INTO n, tot
    FROM app.v_tread_summary WHERE level='TENANT' AND position_class='SPARE';
  IF n IS DISTINCT FROM 1 OR tot IS DISTINCT FROM 2.0 THEN
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
  IF n IS DISTINCT FROM 9 OR tot IS DISTINCT FROM 72.0 THEN
    RAISE EXCEPTION 'FAIL: LINK12 ALL %/%, expected 9/72.0', n, tot; END IF;

  SELECT tyre_count, total_tread_mm INTO n, tot FROM app.v_tread_summary
   WHERE level='DEPOT' AND key_name='Johannesburg' AND position_class='ALL';
  IF n IS DISTINCT FROM 27 OR tot IS DISTINCT FROM 194.0 THEN
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
       WHERE level='TENANT' AND position_class='ALL') IS DISTINCT FROM 27 THEN
    RAISE EXCEPTION 'FAIL: banded total lost rows against 27 readings'; END IF;
  RAISE NOTICE 'PASS  tread band distribution and shares reproduce over the configured bands';
END $$;

-- A tread depth between two configured bounds must still land in a band.
-- FR-INS-021 accepts one decimal place, so 4.5mm is capturable, and the
-- FR-CFG-032 default names 0-4 then 5-7. Classification is by lower bound
-- (FR-CFG-030 requires continuity), so 4.5 belongs to the 0-4mm band.
BEGIN;
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
  INSERT INTO app.tyre (id,tenant_id,display_code,status,state)
  VALUES (md5('t2gaptyre')::uuid,'22222222-2222-2222-2222-222222222222','T2GAP1','NEW','FITTED');
  INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer,fitted_tread_mm)
  VALUES ('22222222-2222-2222-2222-222222222222',md5('t2gaptyre')::uuid,md5('t2veh1')::uuid,posid,'2026-07-01T06:00:00Z',90000,25.0);
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t2insp4')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t2cli4')::uuid,'2026-08-20T08:00:00Z','2026-08-20T08:05:00Z',102000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t2rd4')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2insp4')::uuid,md5('t2veh1')::uuid,posid,md5('t2gaptyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,1,'OUTER',4.5,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,2,'CENTRE',4.8,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2rd4')::uuid,3,'INNER',4.7,true);
  -- the invariant, not just the presence of a row: every fitted position the
  -- summary counts must appear in exactly one band
  SELECT (SELECT sum(tyre_count) FROM app.v_tread_distribution
           WHERE level='TENANT' AND position_class='ALL')
       - (SELECT tyre_count FROM app.v_tread_summary
           WHERE level='TENANT' AND position_class='ALL') INTO n;
  IF n IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL: banded counts differ from the summary by %, so a tread fell outside every band', n; END IF;
  IF (SELECT tyre_count FROM app.v_tread_distribution
       WHERE level='TENANT' AND position_class='ALL' AND band_ordinal = 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: the 4.5mm tread did not land in the 0-4mm band'; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a tread between two configured bounds still lands in a band';
END $$;
ROLLBACK;

-- CR-005: the bands are configuration. Reconfigure to a two-band policy and
-- the distribution must follow (check 17's transactional idiom: the rollback
-- is the cleanup under DR-014a).
BEGIN;
DO $$
DECLARE got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','tread_bands','[[0,7],[8,null]]'::jsonb,'2024-06-01T00:00:00Z');
  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='RUNNING';
  IF got IS DISTINCT FROM '15,11' THEN
    RAISE EXCEPTION 'FAIL: reconfigured bands gave [%], expected 15,11', got; END IF;
  RAISE NOTICE 'PASS  a tread band policy change moves the distribution; nothing is hard-coded';
END $$;
ROLLBACK;

DO $$
DECLARE got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT string_agg(tyre_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.v_tread_distribution WHERE level='TENANT' AND position_class='RUNNING';
  IF got IS DISTINCT FROM '9,6,2,7,2' THEN
    RAISE EXCEPTION 'FAIL: distribution did not come back after the band probe, got [%]', got; END IF;
END $$;

-- FR-ANL-025/026 and BR-RPT-004: compliance is over READINGS in a date range,
-- never over tyres, and never without the counts it derives from. Of 27
-- readings, 26 carry a target for their axle class: one at 26.67% of target
-- and 25 in the correct band (four at 93.33%, twenty-one at 100%). The spare
-- position has no configured SPARE target, so it is unclassifiable rather
-- than compliant, the FR-TYR-032 pattern of reporting the excluded count.
-- Targets resolve from target_pressure (CHG-112); the sheet recorded no
-- temperature state, so every classified reading reports as UNKNOWN, the
-- CHG-035 label that says these are not proven cold-compliant.
DO $$
DECLARE pct numeric; rc bigint; tc bigint; uc bigint; cold bigint; unk bigint; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT pct_of_classified, total_readings, total_tyres, unclassified_count,
         cold_count, unknown_count
    INTO pct, rc, tc, uc, cold, unk
    FROM app.inflation_compliance('2026-07-01','2026-08-01') WHERE band_key='correct';
  IF pct IS DISTINCT FROM 96.15 OR rc IS DISTINCT FROM 26 OR tc IS DISTINCT FROM 26
     OR uc IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: compliance %/%/%/%, expected 96.15/26/26/1', pct, rc, tc, uc; END IF;
  IF cold IS DISTINCT FROM 0 OR unk IS DISTINCT FROM 25 THEN
    RAISE EXCEPTION 'FAIL: correct band cold=% unknown=%, expected 0/25 (unlabelled sheet)', cold, unk; END IF;

  SELECT string_agg(band_key || '=' || reading_count::text, ',' ORDER BY band_ordinal) INTO got
    FROM app.inflation_compliance('2026-07-01','2026-08-01');
  IF got IS DISTINCT FROM 'dangerously_under=1,under=0,correct=25,over=0,dangerously_over=0' THEN
    RAISE EXCEPTION 'FAIL: band spread [%]', got; END IF;

  -- the range is half-open: a window closing on the inspection date sees none
  SELECT total_readings INTO rc FROM app.inflation_compliance('2026-07-01','2026-07-23')
   WHERE band_key='correct';
  IF rc IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL: window ending on the inspection date saw [%] readings, expected 0', rc; END IF;
  RAISE NOTICE 'PASS  inflation compliance reports counts, shares and the temperature label';
END $$;

-- FR-ANL-027/028 rankings (BR-ANL-007/008). Ties are real in this fixture,
-- two positions share a 5.0mm spread, so the ranking pins a deterministic
-- order as well as the values.
DO $$
DECLARE got text; d int; dall int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT string_agg(display_code || '=' || width_spread_mm || '#' || rank, ',' ORDER BY rank, display_code) INTO got
    FROM app.v_irregular_wear_ranking WHERE rank <= 3;
  IF got IS DISTINCT FROM '2102BAC18=8.0#1,2102BAC6=6.0#2,2102BAC7=5.0#3,2102BAC8=5.0#3' THEN
    RAISE EXCEPTION 'FAIL: irregular wear ranking [%]', got; END IF;

  SELECT fleet_number || ' ' || outer_position || '/' || inner_position || '=' || difference_mm
    INTO got FROM app.v_dual_mate_ranking WHERE rank = 1;
  IF got IS DISTINCT FROM 'LINK6 8/7=7.0' THEN
    RAISE EXCEPTION 'FAIL: top dual-mate pair [%], expected LINK6 8/7=7.0', got; END IF;

  -- the ranking presents the same measure FR-EXC-035 raises on, not a second
  -- definition of it: at a 4mm spread the RUNNING positions are exactly the
  -- five check 8 pins, and the sixth is the spare. BR-RPT-001 keeps spares
  -- out of exception reporting and in composition reporting, so the two
  -- counts differ by exactly that one position and neither is wrong
  SELECT count(*) FILTER (WHERE NOT is_spare), count(*) INTO d, dall
    FROM app.v_irregular_wear_ranking WHERE width_spread_mm >= 4;
  IF d IS DISTINCT FROM 5 OR dall IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL: %/% running/all positions at the 4mm spread margin, expected 5/6', d, dall; END IF;
  RAISE NOTICE 'PASS  irregular wear and dual-mate rankings are ordered and tie-stable';
END $$;


\echo '== 20. Snapshots reconcile to the register (TYRE-37; FR-VAL-022, BR-VAL-007)'
-- A valuation_snapshot row is a cache of app.tyre_valuation_asof(), never
-- an independent record of fact, so the register wins wherever the two
-- disagree (TYRE-37 decision). Everything here runs on tenant 2's own probe
-- tyres, dated after check 18's month end: readings are append-only, so a
-- scenario staged against tenant 1 would leave residue in the pinned
-- Appendix E and Appendix J figures forever.

-- Case A (TYRE-37): two inspections of one tyre on one day, syncing out of
-- order. BR-VAL-007 resolves the day by the greatest submitted_at, so the
-- 09:00Z reading governs however late the 07:00Z one arrives. 9.0mm over the
-- 4mm threshold at R100/mm = R500.00; taking the arrival order instead gives
-- 11.0mm and R700.00, which is the divergence this check exists to catch.
--
-- One transaction for the five blocks: the later ones read what the first
-- two stage, and the rollback is what makes the staging guards re-run on a
-- warm database rather than skip the assertions inside them.
BEGIN;
DO $$
DECLARE mm numeric; v numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  -- Section 18 rolls back and leaves nothing behind (TYRE-206), so T2SNAP1's
  -- readings are free to land anywhere in September: there is no persisted
  -- month-end count from check 18 for an August valuation to disturb.
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2SNAP1') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
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
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,1,'OUTER',9,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,2,'CENTRE',10,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1lateread')::uuid,3,'INNER',11,true);

    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s1early')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s1earlycli')::uuid,'2026-09-02T06:55:00Z','2026-09-02T07:00:00Z',109000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s1earlyread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s1early')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap1')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,1,'OUTER',11,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,2,'CENTRE',12,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s1earlyread')::uuid,3,'INNER',13,true);

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
  -- in the reading itself changes, and the repair has to come from the
  -- inspection's own state change. The register falls back to the 07:00Z
  -- reading: 11.0mm over 4mm at R100/mm = R700.00.
  PERFORM app.void_inspection(md5('t2s1late')::uuid, 'TYRE-37 probe');
  SELECT s.tread_mm, s.tread_value INTO mm, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2snap1')::uuid AND s.as_at = '2026-09-02';
  IF mm IS DISTINCT FROM 11.0 OR v IS DISTINCT FROM 700.00 THEN
    RAISE EXCEPTION 'FAIL: voiding left the snapshot at [% mm / %], expected 11.0 / 700.00', mm, v; END IF;

  -- and there is no way back: VOIDED is terminal (Appendix C.2), so the
  -- reverse repair inspection_state_repairs_snapshots (000008) can still
  -- express is unreachable, and the register keeps the 07:00Z reading
  BEGIN
    UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL
     WHERE id = md5('t2s1late')::uuid;
    RAISE EXCEPTION 'FAIL: a void was reversed';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN NULL;
  END;
  SELECT s.tread_mm, s.tread_value INTO mm, v
    FROM app.valuation_snapshot s
   WHERE s.tyre_id = md5('t2snap1')::uuid AND s.as_at = '2026-09-02';
  IF mm IS DISTINCT FROM 11.0 OR v IS DISTINCT FROM 700.00 THEN
    RAISE EXCEPTION 'FAIL: a refused un-void moved the snapshot to [% mm / %]', mm, v; END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  out-of-order sync and a void leave the snapshot equal to the register; a void is final';
END $$;

-- Repair is plural: a month-end row taken after a since-voided reading
-- inherited that reading's value, so every snapshot from that date on must
-- be reconciled, not just the one on its own date. Voiding the tyre's LAST
-- live reading leaves it unvalued, so its snapshot row is deleted rather
-- than nulled (tread_value is NOT NULL); not a DR-014 breach, since
-- DR-011's INSERT-only set names reading, reading_measurement and
-- tyre_event, and deliberately not this one.
DO $$
DECLARE n int; v numeric; w numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  -- Section 18 rolls back and leaves nothing behind (TYRE-206), so T2SNAP2
  -- carries the same freedom as T2SNAP1: no persisted month-end count from
  -- check 18 for an August valuation to disturb.
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2SNAP2') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
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
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,1,'OUTER',15,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,2,'CENTRE',16,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2aread')::uuid,3,'INNER',17,true);

    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2s2b')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2s2bcli')::uuid,'2026-09-06T06:55:00Z','2026-09-06T07:00:00Z',112000);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t2s2bread')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2s2b')::uuid,md5('t2veh1')::uuid,posid,md5('t2snap2')::uuid,750);
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,1,'OUTER',12,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,2,'CENTRE',13,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2s2bread')::uuid,3,'INNER',14,true);

    -- a month-end row now carries the 6th's value forward
    PERFORM app.take_valuation_snapshots('2026-09-30');
    SELECT tread_value INTO v FROM app.valuation_snapshot
     WHERE tyre_id = md5('t2snap2')::uuid AND as_at = '2026-09-30';
    IF v IS DISTINCT FROM 800.00 THEN
      RAISE EXCEPTION 'FAIL: month-end took [%] for T2SNAP2, expected 800.00', v; END IF;

    -- void the 6th: the register falls back to the 5th's 15.0mm = R1100.00,
    -- and BOTH the 6th's row and the month-end row that inherited it move
    PERFORM app.void_inspection(md5('t2s2b')::uuid, 'TYRE-37 probe');
    SELECT s1.tread_value, s2.tread_value INTO v, w
      FROM app.valuation_snapshot s1, app.valuation_snapshot s2
     WHERE s1.tyre_id = md5('t2snap2')::uuid AND s1.as_at = '2026-09-06'
       AND s2.tyre_id = md5('t2snap2')::uuid AND s2.as_at = '2026-09-30';
    IF v IS DISTINCT FROM 1100.00 OR w IS DISTINCT FROM 1100.00 THEN
      RAISE EXCEPTION 'FAIL: after voiding the 6th, snapshots read [% / %] at 09-06 / 09-30, expected 1100.00 / 1100.00', v, w; END IF;

    -- void the 5th as well: no live reading left, nothing to value, no rows
    PERFORM app.void_inspection(md5('t2s2a')::uuid, 'TYRE-37 probe');
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: an unvalued tyre kept % snapshot row(s)', n; END IF;

    -- and there is no way back: VOIDED is terminal (Appendix C.2), so the
    -- un-void that would have restored the register is refused, and the
    -- fully-voided tyre keeps no snapshot row
    BEGIN
      UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL
       WHERE id = md5('t2s2a')::uuid;
      RAISE EXCEPTION 'FAIL: a void was reversed';
    EXCEPTION WHEN SQLSTATE 'TY019' THEN NULL;
    END;
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: a refused un-void left % snapshot row(s)', n; END IF;
  ELSE
    -- the staged end state, re-asserted on every later run
    SELECT count(*) INTO n FROM app.valuation_snapshot WHERE tyre_id = md5('t2snap2')::uuid;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL: fully voided T2SNAP2 carries % snapshot row(s)', n; END IF;
  END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  voiding repairs every snapshot at or after its date, and drops those it unvalues; a void is final';
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
  -- t2s1late's un-void above is refused (VOIDED is terminal), so it stays
  -- voided and the live register for T2SNAP1 is t2s1early's 11.0mm.
  IF mm IS DISTINCT FROM 11.0 OR v IS DISTINCT FROM 700.00 THEN
    RAISE EXCEPTION 'FAIL: re-running month-end left [% mm / %], expected the register''s 11.0 / 700.00', mm, v; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  re-running month-end reconciles an existing row to the register';
END $$;

-- The shared writer takes its tenant as an argument because it is reachable
-- from refresh_governing_tread()'s SECURITY DEFINER chain, where RLS never
-- binds (000004); a foreign tyre must be refused outright. This pins only
-- the RLS-bound branch; the unbound branch needs a SECURITY DEFINER wrapper
-- check 8c refuses by design, so TYRE-38 owns proving that control.
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
  SELECT count(*) INTO n FROM app.tyre WHERE display_code IN ('T2SNAP1', 'T2SNAP2');
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
ROLLBACK;

-- TYRE-52 / BR-VAL-008 (errata E1): a month-end snapshot asserts estate
-- membership AT ITS DATE, judged from the event history, never from
-- tyre.state, or re-running the repair duty after a disposal would eat valid
-- history. Transaction-scoped: nothing persists.
BEGIN;
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, status, rand_per_mm, casing_value, state, last_tread_mm)
  VALUES (md5('scrapprobe')::uuid, '11111111-1111-1111-1111-111111111111',
          'SCRAPPROBE', 'NEW', 100.0000, 100.00, 'IN_STOCK', 10.0);
  -- valued and in the estate: the August month-end holds it
  PERFORM app.reconcile_valuation_snapshots('11111111-1111-1111-1111-111111111111',
                                            '2026-08-31', md5('scrapprobe')::uuid, 'ALWAYS');
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tyre_id = md5('scrapprobe')::uuid AND as_at = '2026-08-31';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: estate-member probe left % August row(s), expected 1', n; END IF;

  -- scrapped mid-September: the September month-end refuses a row
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, from_state, to_state, reason)
  VALUES ('11111111-1111-1111-1111-111111111111', md5('scrapprobe')::uuid,
          'SCRAPPED', '2026-09-15T12:00:00Z', 'IN_STOCK', 'SCRAPPED', 'estate membership probe');
  UPDATE app.tyre SET state = 'SCRAPPED' WHERE id = md5('scrapprobe')::uuid;
  PERFORM app.reconcile_valuation_snapshots('11111111-1111-1111-1111-111111111111',
                                            '2026-09-30', md5('scrapprobe')::uuid, 'ALWAYS');
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tyre_id = md5('scrapprobe')::uuid AND as_at = '2026-09-30';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: disposed tyre got % September month-end row(s)', n; END IF;

  -- repairing August afterwards keeps the valid August row: membership is
  -- as-of the snapshot date, not the current state
  PERFORM app.reconcile_valuation_snapshots('11111111-1111-1111-1111-111111111111',
                                            '2026-08-31', md5('scrapprobe')::uuid, 'ALWAYS');
  SELECT count(*) INTO n FROM app.valuation_snapshot
   WHERE tyre_id = md5('scrapprobe')::uuid AND as_at = '2026-08-31';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: August repair after the disposal left % row(s); valid history must survive', n;
  END IF;
  RAISE NOTICE 'PASS  month-end snapshots assert estate membership as of their own date';
END $$;
ROLLBACK;

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
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BAC2';
  IF r IS DISTINCT FROM 0.1000 OR st IS DISTINCT FROM 'MEASURED' THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 wear rate [% / %], expected 0.1000 / MEASURED', r, st; END IF;

  -- twice the loss over the same distance is twice the rate
  SELECT wear_rate_mm_per_1000km INTO r
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BAC9';
  IF r IS DISTINCT FROM 0.2000 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC9 wear rate [%], expected 0.2000', r; END IF;

  -- and half the loss is half the rate, to four places
  SELECT wear_rate_mm_per_1000km INTO r
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BAC1';
  IF r IS DISTINCT FROM 0.0500 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 wear rate [%], expected 0.0500', r; END IF;

  -- FR-ANL-003 and BR-ANL-004: the spare is read once, so it carries a
  -- reason instead of a rate. 000009 holds why the reason is not optional.
  SELECT wear_rate_mm_per_1000km, wear_rate_status INTO r, st
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BACS';
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

-- CHG-113/CHG-043. The projection is a RANGE anchored to the tyre's own
-- latest reading, from the mm/month regression over all its readings. The
-- fixture pair sits 25 days plus 90 seconds apart, so a 1.0mm loss is
-- 30.44/25.00104 = 1.2175 mm/month. Remaining tread over the rate gives
-- months; the two-reading slack multiplier (0.50) widens it to the band, and
-- each end is months*30.44 days rounded. Every figure below is hand-derived
-- from those inputs, not read back from the view.
DO $$
DECLARE rm numeric; cnt int; d1 date; d2 date; bs text; st text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- 2102BAC2: 10.0mm over the threshold at 1.2175mm/month is 8.2136 months;
  -- +/-50% slack lands 125 and 375 days after 2026-07-23
  SELECT wear_rate_mm_per_month, reading_count, earliest_removal_date,
         latest_removal_date, basis, forecast_status
    INTO rm, cnt, d1, d2, bs, st
    FROM app.v_removal_forecast WHERE display_code = '2102BAC2';
  IF rm IS DISTINCT FROM 1.2175 OR cnt IS DISTINCT FROM 2
     OR d1 IS DISTINCT FROM '2026-11-25'::date OR d2 IS DISTINCT FROM '2027-08-02'::date
     OR bs IS DISTINCT FROM 'REGRESSION_MM_PER_MONTH' OR st IS DISTINCT FROM 'FORECAST' THEN
    RAISE EXCEPTION 'FAIL: 2102BAC2 forecast [% / % / % / % / % / %], expected 1.2175/2/2026-11-25/2027-08-02/REGRESSION_MM_PER_MONTH/FORECAST', rm, cnt, d1, d2, bs, st; END IF;

  -- twice the loss over the same window is twice the rate, and the fastest
  -- wearer reaches the threshold first: 2mm remaining at 2.4351mm/month
  SELECT wear_rate_mm_per_month, earliest_removal_date, latest_removal_date
    INTO rm, d1, d2
    FROM app.v_removal_forecast WHERE display_code = '2102BAC9';
  IF rm IS DISTINCT FROM 2.4351 OR d1 IS DISTINCT FROM '2026-08-05'::date
     OR d2 IS DISTINCT FROM '2026-08-30'::date THEN
    RAISE EXCEPTION 'FAIL: 2102BAC9 forecast [% / % / %], expected 2.4351/2026-08-05/2026-08-30', rm, d1, d2; END IF;

  -- and the slowest, most of a year to two years out
  SELECT wear_rate_mm_per_month, earliest_removal_date, latest_removal_date
    INTO rm, d1, d2
    FROM app.v_removal_forecast WHERE display_code = '2102BAC1';
  IF rm IS DISTINCT FROM 0.6088 OR d1 IS DISTINCT FROM '2027-03-05'::date
     OR d2 IS DISTINCT FROM '2028-05-28'::date THEN
    RAISE EXCEPTION 'FAIL: 2102BAC1 forecast [% / % / %], expected 0.6088/2027-03-05/2028-05-28', rm, d1, d2; END IF;

  -- the odometer sibling rides along (CFL-009): the same tyre still shows its
  -- mm-per-1000km figure beside the regression rate, each under its own name
  SELECT wear_rate_mm_per_1000km INTO rm
    FROM app.v_removal_forecast WHERE display_code = '2102BAC15';
  IF rm IS DISTINCT FROM 0.1500 THEN
    RAISE EXCEPTION 'FAIL: 2102BAC15 sibling rate [%], expected 0.1500', rm; END IF;

  -- Zero remaining: both range ends land on the last reading, per 000009's
  -- note on why an overdue tyre may not project as a negative or a NULL.
  SELECT earliest_removal_date, latest_removal_date, basis, forecast_status
    INTO d1, d2, bs, st
    FROM app.v_removal_forecast WHERE display_code = '2102BAC18';
  IF d1 IS DISTINCT FROM '2026-07-23'::date OR d2 IS DISTINCT FROM '2026-07-23'::date
     OR bs IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' OR st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: bald 2102BAC18 forecast [% / % / % / %], expected 2026-07-23 both ends, AT_OR_BELOW_THRESHOLD', d1, d2, bs, st; END IF;

  -- Precedence: the spare is below the threshold AND has one reading. Being
  -- past the threshold answers "when does this need replacing" without
  -- needing a rate at all, so it outranks the missing-rate reason. Its
  -- reading count still travels so the consumer sees how thin the data is.
  SELECT forecast_status, reading_count, earliest_removal_date INTO st, cnt, d1
    FROM app.v_removal_forecast WHERE display_code = '2102BACS';
  IF st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' OR cnt IS DISTINCT FROM 1
     OR d1 IS DISTINCT FROM '2026-07-23'::date THEN
    RAISE EXCEPTION 'FAIL: spare forecast [% / % / %], expected AT_OR_BELOW_THRESHOLD/1/2026-07-23', st, cnt, d1; END IF;

  SELECT count(*) INTO n FROM app.v_removal_forecast;
  IF n IS DISTINCT FROM 27 THEN RAISE EXCEPTION 'FAIL: % forecast rows, expected 27', n; END IF;
  -- point-date columns are retired (CHG-113): a consumer asking for the old
  -- false precision must fail at parse time, not read a resurrected column
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='app' AND table_name='v_removal_forecast'
                AND column_name IN ('projected_removal_date','projected_remaining_days',
                                    'projected_remaining_km','projected_removal_odometer')) THEN
    RAISE EXCEPTION 'FAIL: a point-projection column survives on the forecast surface'; END IF;
  RAISE NOTICE 'PASS  removal forecast presents a dated range, its rate, count and basis per tyre';
END $$;

-- FR-ANL-007. The horizon list is the report surface (FR-RPT-028), and at a
-- zero horizon it must agree exactly with the below-threshold set check 8
-- pins from the readings: two routes to the same nine positions.
DO $$
DECLARE n int; m int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  SELECT string_agg(display_code, ',' ORDER BY display_code) INTO got
    FROM app.removal_forecast_within('2026-07-23', 0) WHERE NOT is_spare;
  IF got IS DISTINCT FROM '2102BAC11,2102BAC12,2102BAC13,2102BAC16,2102BAC18,2102BAC21,2102BAC22,2102BAC7,2102BAC8' THEN
    RAISE EXCEPTION 'FAIL: overdue running positions [%]', got; END IF;

  -- Thirty days out adds the three tyres whose EARLIEST range end falls
  -- inside the window. The horizon plans for the pessimistic end, because a
  -- forecast that runs late is worth less than one that runs early. Spares
  -- are carried, never filtered: BR-RPT-001 is a reporting convention and
  -- FR-RPT-005 makes the caller state which it applied.
  SELECT count(*), count(*) FILTER (WHERE NOT is_spare) INTO n, m
    FROM app.removal_forecast_within('2026-07-23', 30);
  IF n IS DISTINCT FROM 13 OR m IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'FAIL: %/% all/running within 30 days, expected 13/12', n, m; END IF;

  -- a horizon cannot invent a tyre that has no projection
  IF EXISTS (SELECT 1 FROM app.removal_forecast_within('2026-07-23', 3650)
              WHERE earliest_removal_date IS NULL) THEN
    RAISE EXCEPTION 'FAIL: the horizon list carries a row with no projected range'; END IF;
  RAISE NOTICE 'PASS  the horizon list agrees with the below-threshold set and widens with the horizon';
END $$;

-- FR-ANL-002 is tenant configuration, not a constant (rule 5, CR-005). Raise
-- the minimum separation above the fixture's own window and no pair qualifies
-- any more, then restore. BR-ANL-001 computes over the most recent pair
-- separated by at least the minimum, so "below the minimum" means no
-- qualifying pair exists (BR-ANL-004), not that the last two are too close.
BEGIN;
DO $$
DECLARE n int; st text; r numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.configuration (tenant_id,key,value,effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111','wear_rate_min_distance_km','20000'::jsonb,'2026-07-01T00:00:00Z');

  SELECT count(*) FILTER (WHERE wear_rate_status = 'BELOW_MIN_DISTANCE')
    INTO n FROM app.v_tyre_wear_rate;
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % rows below the raised minimum, expected 26', n; END IF;
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_mm_per_1000km IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % rates survived a minimum wider than the window', n; END IF;
  -- the regression forecast needs no odometer (CHG-043), so it stands while
  -- the odometer sibling withdraws, and each column reports its own truth
  SELECT forecast_status, wear_rate_mm_per_1000km INTO st, r
    FROM app.v_removal_forecast WHERE display_code = '2102BAC2';
  IF st IS DISTINCT FROM 'FORECAST' OR r IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: under the raised minimum forecast [% / %], expected FORECAST with a NULL sibling rate', st, r; END IF;

END $$;
ROLLBACK;

DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_status = 'MEASURED';
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % measured after the raised-minimum probe, expected 26', n; END IF;
END $$;

-- No configured minimum is not the same as a minimum of zero: an
-- unconfigured tenant gets no rate and is told why, never a rate computed
-- from a hard-coded 1,000km that nobody chose. Same +infinity trick as the
-- no-policy valuation probe (DR-014a).
BEGIN;
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  UPDATE app.configuration SET effective_from = 'infinity'
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111'
     AND key = 'wear_rate_min_distance_km';
  SELECT count(*) FILTER (WHERE wear_rate_status = 'NO_MIN_DISTANCE_POLICY')
    INTO n FROM app.v_tyre_wear_rate;
  IF n <> 27 THEN
    RAISE EXCEPTION 'FAIL: % rows report no minimum-distance policy, expected 27', n; END IF;
  RAISE NOTICE 'PASS  the minimum separation is configuration; unconfigured means no rate, with the reason';
END $$;
ROLLBACK;

DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*) INTO n FROM app.v_tyre_wear_rate WHERE wear_rate_status = 'MEASURED';
  IF n <> 26 THEN
    RAISE EXCEPTION 'FAIL: % measured after the no-minimum probe, expected 26', n; END IF;
END $$;

-- BR-ANL-004: a fitment between the two readings makes them readings of the
-- same position, not the same tyre's wear. 000032's fitment_written_once
-- trigger (TY014, rule 3) freezes fitted_at on an open fitment, so the
-- window is staged as a compensating close-and-refit (FR-FIT-015) inside a
-- rolled-back transaction; readings are append-only, so a residue reading
-- would corrupt the pinned figures above rather than leave none.
BEGIN;
DO $$
DECLARE st text; r numeric; pos uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT position_id INTO pos FROM app.fitment
   WHERE tyre_id = md5('tyre2')::uuid AND removed_at IS NULL;

  -- veh1 is a HORSE (TY009): the close and the refit both carry an odometer.
  UPDATE app.fitment SET removed_at = '2025-06-15T06:00:00Z', removed_odometer = 385000,
         removal_reason = 'correction'
   WHERE tyre_id = md5('tyre2')::uuid AND removed_at IS NULL;
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
  VALUES ('11111111-1111-1111-1111-111111111111', md5('tyre2')::uuid, md5('veh1')::uuid, pos,
          '2026-07-10T06:00:00Z', 400000);

  SELECT wear_rate_status, wear_rate_mm_per_1000km INTO st, r
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BAC2';
  IF st IS DISTINCT FROM 'FITMENT_BETWEEN' OR r IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: refitted tyre [% / %], expected FITMENT_BETWEEN / NULL', st, r; END IF;
END $$;
ROLLBACK;

DO $$
DECLARE st text; r numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT wear_rate_status, wear_rate_mm_per_1000km INTO st, r
    FROM app.v_tyre_wear_rate WHERE display_code = '2102BAC2';
  IF st IS DISTINCT FROM 'MEASURED' OR r IS DISTINCT FROM 0.1000 THEN
    RAISE EXCEPTION 'FAIL: restored fitment [% / %], expected MEASURED / 0.1000', st, r; END IF;
  RAISE NOTICE 'PASS  a fitment between the readings withdraws the rate rather than reporting a swap as wear';
END $$;

-- Zero measured wear is ordinary, not exotic: a hard compound over a short
-- window moves less than the gauge resolves, so the rate is a real 0.0000
-- rather than a missing one, and the forecast withholds the resulting
-- infinite projection and says which of the two it is. Staged on tenant 2,
-- past check 18's month end, since readings are append-only and would
-- otherwise leave residue in the pinned figures above.
BEGIN;
DO $$
DECLARE r numeric; st text; km numeric; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '3';
  -- FIXTURE COUPLING (TYRE-62): T2FLAT1 persists FITTED, read twice with no
  -- tread change, in September and with no purchase price, so re-runs give
  -- it a tread band but never a valuation or a snapshot, keeping check 18's
  -- tenant-2 figures unmoved.
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2FLAT1') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,status,state)
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
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,1,'OUTER',12,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,2,'CENTRE',13,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd1')::uuid,3,'INNER',14,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,1,'OUTER',12,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,2,'CENTRE',13,true),
      ('22222222-2222-2222-2222-222222222222',md5('t2flatrd2')::uuid,3,'INNER',14,true);
  END IF;

  SELECT wear_rate_mm_per_1000km, wear_rate_status INTO r, st
    FROM app.v_tyre_wear_rate WHERE display_code = 'T2FLAT1';
  IF r IS DISTINCT FROM 0.0000 OR st IS DISTINCT FROM 'MEASURED' THEN
    RAISE EXCEPTION 'FAIL: unworn tyre [% / %], expected 0.0000 / MEASURED', r, st; END IF;

  -- the regression sees the same flat line: a real 0.0000, a withheld range
  SELECT wear_rate_mm_per_month, forecast_status INTO r, st
    FROM app.v_removal_forecast WHERE display_code = 'T2FLAT1';
  IF r IS DISTINCT FROM 0.0000 OR st IS DISTINCT FROM 'NO_MEASURABLE_WEAR' THEN
    RAISE EXCEPTION 'FAIL: unworn tyre forecast [% / %], expected 0.0000 / NO_MEASURABLE_WEAR', r, st; END IF;
  IF EXISTS (SELECT 1 FROM app.v_removal_forecast
              WHERE display_code = 'T2FLAT1' AND earliest_removal_date IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: a tyre with no measurable wear carries a projected range'; END IF;

  -- and it stays out of every horizon rather than sitting at the top of one
  IF EXISTS (SELECT 1 FROM app.removal_forecast_within('2026-09-20', 36500)
              WHERE display_code = 'T2FLAT1') THEN
    RAISE EXCEPTION 'FAIL: a tyre with no measurable wear appeared in a horizon list'; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  zero measured wear is a rate of zero and a withheld projection, not a missing rate';
END $$;
ROLLBACK;

-- Two shapes the fixture cannot contain, both of which the horizon list must
-- survive: a vehicle inspected without moving, and one with only one capture
-- to its name (every vehicle on rollout day one, the worst day for an
-- overdue tyre to go missing from the report). Staged on tenant 2, live only
-- for this transaction: these tyres sit below the removal threshold, so a
-- surviving reading would move check 19's pinned count.
BEGIN;
DO $$
DECLARE dt date; dt2 date; st text; n int; posid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  SELECT pos.id INTO posid
    FROM app.position pos
   WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
     AND pos.code = '1';

  INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,status) VALUES
    (md5('t2veh2')::uuid,'22222222-2222-2222-2222-222222222222','PARKED','CAA222222',md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'HORSE','ACTIVE'),
    (md5('t2veh3')::uuid,'22222222-2222-2222-2222-222222222222','SOLO','CAA333333',md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'HORSE','ACTIVE');
  INSERT INTO app.tyre (id,tenant_id,display_code,status,state) VALUES
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
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,1,'OUTER',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,2,'CENTRE',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd1')::uuid,3,'INNER',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,1,'OUTER',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,2,'CENTRE',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2parkrd2')::uuid,3,'INNER',3,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,1,'OUTER',2,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,2,'CENTRE',2,true),
    ('22222222-2222-2222-2222-222222222222',md5('t2solord1')::uuid,3,'INNER',2,true);

  -- A parked vehicle divides zero distance by zero days. Reading the whole
  -- view is the assertion: an unguarded division takes down every row, not
  -- one of them, so a single parked trailer would blank the dashboard.
  -- T2PARK1 and T2SOLO1 are the only tenant-2 fitments live at this point in
  -- the transaction, so the exact count also pins that nothing else leaked in.
  SELECT count(*) INTO n FROM app.v_removal_forecast;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: forecast view returned % rows for tenant 2, expected exactly the 2 probes this block plants', n; END IF;

  SELECT earliest_removal_date, latest_removal_date, forecast_status
    INTO dt, dt2, st FROM app.v_removal_forecast WHERE display_code = 'T2PARK1';
  IF dt IS DISTINCT FROM '2027-02-10'::date OR dt2 IS DISTINCT FROM '2027-02-10'::date
     OR st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: parked below-threshold tyre [% / % / %], expected 2027-02-10 both ends, AT_OR_BELOW_THRESHOLD', dt, dt2, st; END IF;

  -- One capture yields no rate at all, and zero remaining tread needs none:
  -- the tyre is already overdue and must be listed, dated its last reading.
  SELECT earliest_removal_date, forecast_status INTO dt, st
    FROM app.v_removal_forecast WHERE display_code = 'T2SOLO1';
  IF dt IS DISTINCT FROM '2027-03-01'::date OR st IS DISTINCT FROM 'AT_OR_BELOW_THRESHOLD' THEN
    RAISE EXCEPTION 'FAIL: single-capture below-threshold tyre [% / %], expected 2027-03-01/AT_OR_BELOW_THRESHOLD', dt, st; END IF;
  SELECT count(*) INTO n FROM app.removal_forecast_within('2027-03-01', 0)
   WHERE display_code = 'T2SOLO1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: an overdue tyre on a once-inspected vehicle is missing from the horizon list'; END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  a vehicle that does not move, and one inspected only once, still forecast';
END $$;
ROLLBACK;

-- Rule 6: timestamps are stored UTC. A bare cast to date reads the session
-- timezone, so a connection west of UTC would move every projected date by a
-- day against readings captured at 05:45Z.
DO $$
DECLARE dt date;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  PERFORM set_config('TimeZone', 'America/Los_Angeles', true);
  SELECT earliest_removal_date INTO dt
    FROM app.v_removal_forecast WHERE display_code = '2102BAC2';
  IF dt IS DISTINCT FROM '2026-11-25'::date THEN
    RAISE EXCEPTION 'FAIL: projected range start is [%] from a non-UTC session, expected 2026-11-25', dt; END IF;
  SELECT earliest_removal_date INTO dt
    FROM app.v_removal_forecast WHERE display_code = '2102BAC18';
  IF dt IS DISTINCT FROM '2026-07-23'::date THEN
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

\echo '== 22. Tyre identity: display codes are reusable, unique while active (CFL-001, CHG-021/022)'
-- BAC brands licence number + position, so a replacement tyre on the same
-- position repeats the code. Uniqueness binds only while a tyre is active;
-- SCRAPPED, LOST and SOLD release the code. Probes are tenant 2's and roll
-- back at the end. Nothing references them, and DR-014a leaves no DELETE.
BEGIN;
DO $$
DECLARE t1 uuid; t2 uuid; ok boolean;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  INSERT INTO app.tyre (tenant_id, display_code, state)
    VALUES ('22222222-2222-2222-2222-222222222222','CA123456-11','FITTED') RETURNING id INTO t1;

  ok := false;
  BEGIN
    INSERT INTO app.tyre (tenant_id, display_code, state)
      VALUES ('22222222-2222-2222-2222-222222222222','CA123456-11','IN_STOCK');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: duplicate code accepted among ACTIVE tyres'; END IF;

  -- scrap the first, then the SAME code must be insertable: uniqueness binds
  -- only while a tyre is active (the section preamble), never globally
  UPDATE app.tyre SET state='SCRAPPED' WHERE id = t1;
  INSERT INTO app.tyre (tenant_id, display_code, state)
    VALUES ('22222222-2222-2222-2222-222222222222','CA123456-11','IN_STOCK') RETURNING id INTO t2;

  -- SOLD releases the code the same way (CHG-037)
  UPDATE app.tyre SET state='SOLD' WHERE id = t2;
  INSERT INTO app.tyre (tenant_id, display_code, state, brand_pending)
    VALUES ('22222222-2222-2222-2222-222222222222','CA123456-11','IN_STOCK', true);

  IF (SELECT count(*) FROM app.tyre WHERE display_code='CA123456-11') <> 3 THEN
    RAISE EXCEPTION 'FAIL: the reused code did not keep three distinct tyre records'; END IF;

  RAISE NOTICE 'PASS  a display code is reusable after scrap or sale, never while two tyres are active';
END $$;
ROLLBACK;

\echo '== 23. Casing value: absent not zero, event-sourced with labelled bases (CFL-002, CHG-015..018)'
-- The register's casing side resolves latest valuation event -> size estimate
-- -> onboarding audit figure, each under its own label (CHG-016, ADR-0010).
-- casing_valuation is append-only, so the staging is rolled back rather than
-- deleted; the probes are stock tyres with no readings, so no pinned figure
-- sees them while they exist.
BEGIN;
DO $$
DECLARE v numeric; got text; ok boolean;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);

  -- CFL-002: a new tyre's casing value is unknown, not zero
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2CASNONE') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,state)
    VALUES (md5('t2casnone')::uuid,'22222222-2222-2222-2222-222222222222','T2CASNONE','IN_STOCK');
  END IF;
  IF (SELECT casing_value FROM app.tyre WHERE display_code='T2CASNONE') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a new tyre carries a casing value it has no evidence for'; END IF;

  IF NOT EXISTS (SELECT 1 FROM app.tyre_size WHERE id = md5('t2sz1')::uuid) THEN
    INSERT INTO app.tyre_size (id,tenant_id,name)
    VALUES (md5('t2sz1')::uuid,'22222222-2222-2222-2222-222222222222','315/80R22.5');
  END IF;

  -- CHG-017: a rejected casing cannot carry a value; an accepted one derives
  -- the turnaround that feeds spare-pool sizing
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2CASACT') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,state)
    VALUES (md5('t2casact')::uuid,'22222222-2222-2222-2222-222222222222','T2CASACT','IN_STOCK');
    ok := false;
    BEGIN
      INSERT INTO app.retread_job (tenant_id,tyre_id,sent_at,returned_at,casing_accepted,casing_value)
      VALUES ('22222222-2222-2222-2222-222222222222',md5('t2casact')::uuid,'2026-07-01','2026-07-15',false,2400.00);
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'FAIL: a rejected casing was given a value'; END IF;

    INSERT INTO app.retread_job (id,tenant_id,tyre_id,sent_at,returned_at,casing_accepted,casing_value,post_tread_mm)
    VALUES (md5('t2casjob')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2casact')::uuid,
            '2026-07-01','2026-07-15',true,2400.00,18.0);
    IF (SELECT turnaround_days FROM app.retread_job WHERE id = md5('t2casjob')::uuid) <> 14 THEN
      RAISE EXCEPTION 'FAIL: retread turnaround not derived'; END IF;

    -- CHG-016: a RETREADER valuation must cite the job it came from
    ok := false;
    BEGIN
      INSERT INTO app.casing_valuation (tenant_id,tyre_id,value,source,effective_from)
      VALUES ('22222222-2222-2222-2222-222222222222',md5('t2casact')::uuid,999.00,'RETREADER','2026-08-01');
    EXCEPTION WHEN check_violation THEN ok := true;
    END;
    IF NOT ok THEN RAISE EXCEPTION 'FAIL: a retreader valuation without its job was accepted'; END IF;

    INSERT INTO app.casing_valuation (tenant_id,tyre_id,value,source,retread_job_id,effective_from)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2casact')::uuid,2400.00,'RETREADER',
            md5('t2casjob')::uuid,'2026-07-15');
  END IF;

  -- CHG-018: an admin size estimate stands in for never-retreaded casings,
  -- always as an estimate
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2CASEST') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,size_id,state)
    VALUES (md5('t2casest')::uuid,'22222222-2222-2222-2222-222222222222','T2CASEST',md5('t2sz1')::uuid,'IN_STOCK');
    INSERT INTO app.casing_estimate_by_size (tenant_id,size_id,estimated_value,effective_from)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2sz1')::uuid,1800.00,'2026-08-01');
  END IF;

  SELECT casing_value::text || '/' || casing_basis INTO got
    FROM app.v_tyre_valuation WHERE display_code = 'T2CASACT';
  IF got IS DISTINCT FROM '2400.00/ACTUAL' THEN
    RAISE EXCEPTION 'FAIL: retreader-valued casing reads [%], expected 2400.00/ACTUAL', got; END IF;
  SELECT casing_value::text || '/' || casing_basis INTO got
    FROM app.v_tyre_valuation WHERE display_code = 'T2CASEST';
  IF got IS DISTINCT FROM '1800.00/ESTIMATED' THEN
    RAISE EXCEPTION 'FAIL: size-estimated casing reads [%], expected 1800.00/ESTIMATED', got; END IF;
  SELECT casing_basis INTO got
    FROM app.v_tyre_valuation WHERE display_code = 'T2CASNONE';
  IF got IS DISTINCT FROM 'UNVALUED' THEN
    RAISE EXCEPTION 'FAIL: unvalued casing reads [%], never a zero', got; END IF;

  -- the fixture's uniform onboarding figure is the AUDIT fallback, labelled
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT casing_value::text || '/' || casing_basis INTO got
    FROM app.v_tyre_valuation WHERE display_code = '2102BAC2';
  IF got IS DISTINCT FROM '1837.50/AUDIT' THEN
    RAISE EXCEPTION 'FAIL: onboarding casing reads [%], expected 1837.50/AUDIT', got; END IF;
  RAISE NOTICE 'PASS  casing value is event-sourced and labelled ACTUAL/ESTIMATED/AUDIT, absent means UNVALUED';
END $$;
ROLLBACK;

\echo '== 24. Trailers are recordable; the odometer is a vehicle timeline (CFL-003/005, CHG-024/042)'
BEGIN;
DO $$
DECLARE ok boolean; src text;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);

  -- CFL-003: a fitment with no odometer is accepted, and its distance
  -- provenance says UNAVAILABLE rather than pretending (CHG-042, ADR-0010)
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2TRL1') THEN
    -- The unit carrying this fitment has to be a TRAILER. FR-FIT-002 requires a
    -- fitted odometer wherever the unit kind has one (TY009, migration 000025),
    -- so a horse is the one kind that cannot demonstrate the odometer-less case
    -- CFL-003 is about. It is the kind the rule refuses.
    INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,status) VALUES
      (md5('t2trlveh')::uuid,'22222222-2222-2222-2222-222222222222','TRAILER1','CAA444444',md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'TRAILER','ACTIVE');
    INSERT INTO app.tyre (id,tenant_id,display_code,state)
    VALUES (md5('t2trltyre')::uuid,'22222222-2222-2222-2222-222222222222','T2TRL1','FITTED');
    INSERT INTO app.fitment (tenant_id,tyre_id,vehicle_id,position_id,fitted_at,fitted_odometer)
    SELECT '22222222-2222-2222-2222-222222222222',md5('t2trltyre')::uuid,md5('t2trlveh')::uuid,pos.id,
           '2027-05-01T06:00:00Z',NULL
      FROM app.position pos
     WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
       AND pos.code = '5';
  END IF;
  SELECT f.distance_source::text INTO src
    FROM app.fitment f WHERE f.tyre_id = md5('t2trltyre')::uuid;
  IF src IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'FAIL: odometer-less fitment provenance [%], expected UNAVAILABLE', src; END IF;

  -- CFL-005: an inspection with no odometer is accepted
  IF NOT EXISTS (SELECT 1 FROM app.inspection WHERE id = md5('t2noodo')::uuid) THEN
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2noodo')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,
            md5('driver2')::uuid,md5('t2noodocli')::uuid,'2027-06-01T08:00:00Z','2027-06-01T08:05:00Z',NULL);
  END IF;

  -- CHG-024: the vehicle timeline validates monotonicity and plausibility.
  -- A transposed digit poisons every rate on the vehicle thereafter
  IF NOT EXISTS (SELECT 1 FROM app.vehicle_odometer_reading
                  WHERE vehicle_id = md5('t2veh1')::uuid AND reading_date = '2027-07-01') THEN
    INSERT INTO app.vehicle_odometer_reading (tenant_id,vehicle_id,reading_date,odometer_km,source)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,'2027-07-01',500000,'FUEL_RECORD'),
           ('22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,'2027-07-31',512000,'FUEL_RECORD');
  END IF;
  ok := false;
  BEGIN
    INSERT INTO app.vehicle_odometer_reading (tenant_id,vehicle_id,reading_date,odometer_km,source)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,'2027-08-01',400000,'MANUAL');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a backwards odometer reading was accepted'; END IF;
  ok := false;
  BEGIN
    -- transposed digit: 512000 -> 5120000 in one day
    INSERT INTO app.vehicle_odometer_reading (tenant_id,vehicle_id,reading_date,odometer_km,source)
    VALUES ('22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,'2027-08-01',5120000,'MANUAL');
  EXCEPTION WHEN others THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: an implausible daily distance was accepted'; END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  trailer fitments and inspections record without an odometer; the timeline rejects bad readings';
END $$;
ROLLBACK;

\echo '== 25. One pressure model: admin targets, banded tolerances, hot/cold label (CHG-034/035/112)'
BEGIN;
DO $$
DECLARE ok boolean; cold bigint; hot bigint; n bigint;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);

  -- a critical band milder than the warning band is a policy that cannot mean
  -- anything; the schema refuses it
  ok := false;
  BEGIN
    INSERT INTO app.target_pressure (tenant_id,axle_class,target_kpa,warn_under_pct,critical_under_pct)
    VALUES ('22222222-2222-2222-2222-222222222222','DRIVE',750,20.0,10.0);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a critical band milder than warning was accepted'; END IF;

  -- the retired pressure keys are gone; the table is the only source (CHG-112)
  IF EXISTS (SELECT 1 FROM app.configuration
              WHERE key IN ('target_pressure_kpa','inflation_bands','pressure_deviation_margin_pct')) THEN
    RAISE EXCEPTION 'FAIL: a retired pressure config key is still seeded'; END IF;

  -- CHG-035: the temperature state rides the reading and surfaces per band.
  -- A HOT 750 against a COLD 750 target is never silently "correct"
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2PRS1') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,state)
    VALUES (md5('t2prstyre')::uuid,'22222222-2222-2222-2222-222222222222','T2PRS1','IN_STOCK');
    INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
    VALUES (md5('t2prs1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2prscli1')::uuid,'2027-08-10T06:00:00Z','2027-08-10T06:05:00Z',NULL),
           (md5('t2prs2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
            md5('t2prscli2')::uuid,'2027-08-11T12:00:00Z','2027-08-11T12:05:00Z',NULL);
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa,pressure_temperature)
    SELECT md5('t2prsrd1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2prs1')::uuid,md5('t2veh1')::uuid,pos.id,
           md5('t2prstyre')::uuid,750,'COLD'
      FROM app.position pos
     WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid AND pos.code = '6';
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa,pressure_temperature)
    SELECT md5('t2prsrd2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2prs2')::uuid,md5('t2veh1')::uuid,pos.id,
           md5('t2prstyre')::uuid,750,'HOT'
      FROM app.position pos
     WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid AND pos.code = '6';
  END IF;
  SELECT cold_count, hot_count, reading_count INTO cold, hot, n
    FROM app.inflation_compliance('2027-08-01','2027-09-01') WHERE band_key = 'correct';
  IF cold IS DISTINCT FROM 1 OR hot IS DISTINCT FROM 1 OR n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL: correct band cold/hot/count %/%/%, expected 1/1/2', cold, hot, n; END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  pressure targets are one table; the hot/cold basis is labelled per band';
END $$;
ROLLBACK;

\echo '== 26. Assigned inspections: schedules, tasks, skip and escalation (CHG-028/032/033)'
-- Transaction-scoped: schedules, tasks and the PARKED probe unit all roll
-- back (DR-014a leaves the app role no DELETE for cleanup).
BEGIN;
DO $$
DECLARE ok boolean; n int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);

  -- a schedule must target a vehicle or a group, never both or neither
  ok := false;
  BEGIN
    INSERT INTO app.inspection_schedule (tenant_id, interval_days)
    VALUES ('22222222-2222-2222-2222-222222222222', 7);
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a schedule with no target was accepted'; END IF;

  -- a completed task must cite the inspection that completed it
  ok := false;
  BEGIN
    INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, state)
    VALUES ('22222222-2222-2222-2222-222222222222', md5('t2veh1')::uuid, now(), 'COMPLETED');
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a completed task without its inspection was accepted'; END IF;

  -- CHG-028 as behaviour: generation skips a PARKED unit, assigns through the
  -- current-driver link where one exists, and escalates where none resolves
  IF NOT EXISTS (SELECT 1 FROM app.vehicle WHERE id = md5('t2veh4')::uuid) THEN
    INSERT INTO app.vehicle (id,tenant_id,fleet_number,configuration_id,unit_kind,status)
    VALUES (md5('t2veh4')::uuid,'22222222-2222-2222-2222-222222222222','PARKED4',
            md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'HORSE','PARKED');
    -- check 21 rolls back (TYRE-206), so this schedule's own target vehicle
    -- is planted here rather than read from that section's residue
    INSERT INTO app.vehicle (id,tenant_id,fleet_number,registration,configuration_id,unit_kind,status)
    VALUES (md5('t2veh3')::uuid,'22222222-2222-2222-2222-222222222222','SOLO','CAA333333',
            md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid,'HORSE','ACTIVE');
  END IF;
  INSERT INTO app.inspection_schedule (id,tenant_id,vehicle_id,interval_days) VALUES
    (md5('t2sched1')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,7),
    (md5('t2sched2')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh4')::uuid,7),
    (md5('t2sched3')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh3')::uuid,7);

  PERFORM app.generate_inspection_tasks('2027-09-01');

  SELECT u.display_name INTO got
    FROM app.inspection_task t JOIN app.app_user u ON u.id = t.assigned_user_id
   WHERE t.schedule_id = md5('t2sched1')::uuid AND t.state = 'OPEN';
  IF got IS DISTINCT FROM 'Thabo' THEN
    RAISE EXCEPTION 'FAIL: driven vehicle task assigned to [%], expected Thabo', got; END IF;

  SELECT count(*) INTO n FROM app.inspection_task WHERE schedule_id = md5('t2sched2')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a PARKED unit was issued % task(s); its schedule must pause', n; END IF;

  SELECT count(*) INTO n FROM app.inspection_task
   WHERE schedule_id = md5('t2sched3')::uuid AND state = 'ESCALATED' AND escalated_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: an unassignable task was not escalated (never silently dropped)'; END IF;

  -- an open task suppresses regeneration
  PERFORM app.generate_inspection_tasks('2027-09-02');
  SELECT count(*) INTO n FROM app.inspection_task WHERE schedule_id = md5('t2sched1')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: regeneration duplicated an open task (% rows)', n; END IF;

  -- CHG-033: overdue = an issued task past its due date
  SELECT count(*) INTO n FROM app.inspection_task
   WHERE state = 'OPEN' AND due_at < '2027-10-01T00:00:00Z';
  IF n < 1 THEN RAISE EXCEPTION 'FAIL: no issued task reads as overdue past its due date'; END IF;

  RAISE NOTICE 'PASS  schedules issue tasks, skip parked units, assign or escalate, and never duplicate';
END $$;
ROLLBACK;

\echo '== 27. Vocabulary, provenance columns and disposal semantics (CHG-011/012/027/030/036/037/039, CFL-006..008)'
BEGIN;
DO $$
DECLARE n int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  IF (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
        FROM pg_type ty JOIN pg_enum e ON e.enumtypid = ty.oid
       WHERE ty.typname='evidential_status') IS DISTINCT FROM ARRAY['CONFIRMED','UNVERIFIED'] THEN
    RAISE EXCEPTION 'FAIL: evidential status is not CONFIRMED / UNVERIFIED only (CHG-039)'; END IF;
  IF (SELECT count(*) FROM pg_type ty JOIN pg_enum e ON e.enumtypid=ty.oid
       WHERE ty.typname='axle_type') <> 3 THEN
    RAISE EXCEPTION 'FAIL: axle_type does not model fixed, self-steering and lifting (CHG-030)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type ty JOIN pg_enum e ON e.enumtypid=ty.oid
                  WHERE ty.typname='vehicle_status' AND e.enumlabel='PARKED') THEN
    RAISE EXCEPTION 'FAIL: vehicle_status lacks PARKED (CHG-028)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type ty JOIN pg_enum e ON e.enumtypid=ty.oid
                  WHERE ty.typname='tyre_state' AND e.enumlabel='SOLD') THEN
    RAISE EXCEPTION 'FAIL: tyre_state lacks SOLD (CHG-037)'; END IF;

  -- CFL-006/CFL-007 structural: the stored map is gone, the projection view
  -- stands, the free-text label is gone, the canonical columns are present
  IF to_regclass('app.combination_position_map') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: combination_position_map survives (CFL-006)'; END IF;
  IF to_regclass('app.v_combination_reading') IS NULL THEN
    RAISE EXCEPTION 'FAIL: v_combination_reading is missing'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='app' AND table_name='reading_measurement' AND column_name='label') THEN
    RAISE EXCEPTION 'FAIL: the free-text measurement label survives (CFL-007)'; END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema='app' AND table_name='reading_measurement'
         AND column_name IN ('position','orientation_known','granularity_mm')) <> 3 THEN
    RAISE EXCEPTION 'FAIL: canonical measurement columns missing (CHG-010..012)'; END IF;
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema='app' AND table_name='reading_measurement' AND column_name='tread_mm')
     <> 'numeric' THEN
    RAISE EXCEPTION 'FAIL: tread is not stored as decimal (CHG-012)'; END IF;

  -- CHG-011: every fixture measurement predates the orientation convention
  -- and says so: 78 on the earlier capture, 81 on the sheet
  SELECT count(*) INTO n FROM app.reading_measurement m
   WHERE m.tenant_id = '11111111-1111-1111-1111-111111111111' AND NOT m.orientation_known;
  IF n <> 159 THEN
    RAISE EXCEPTION 'FAIL: % fixture measurements flagged orientation-unknown, expected all 159', n; END IF;

  -- CHG-027: every fixture vehicle derived its unit kind; none was left NULL
  SELECT count(*) INTO n FROM app.vehicle WHERE unit_kind IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % fixture vehicles without unit_kind', n; END IF;

  -- CHG-036: every fixture tyre is priced, so tenant 1's awaiting-cost queue
  -- is empty, and the unpriced FITTED probe planted on tenant 2 must surface
  -- in tenant 2's.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,state)
  VALUES (md5('t2gaptyre')::uuid,'22222222-2222-2222-2222-222222222222','T2GAP1','NEW','FITTED');
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  SELECT count(*) INTO n FROM app.v_tyre_awaiting_cost;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: % priced fixture tyres sit in the awaiting-cost queue', n; END IF;
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', false);
  IF NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE display_code = 'T2GAP1') THEN
    RAISE EXCEPTION 'FAIL: the unpriced probe tyre is missing from the awaiting-cost queue'; END IF;

  -- CHG-037: SOLD is a disposal, outside the estate, its proceeds a typed
  -- money column on the event log, never a jsonb number
  -- deliberately unpriced and unread: a valued probe would be swept into the
  -- month-end snapshot pass on a re-run (the pass keys on tread_value, not
  -- state) and move check 18's pinned tenant-2 count
  IF NOT EXISTS (SELECT 1 FROM app.tyre WHERE display_code = 'T2SOLD1') THEN
    INSERT INTO app.tyre (id,tenant_id,display_code,status,casing_value,state)
    VALUES (md5('t2soldtyre')::uuid,'22222222-2222-2222-2222-222222222222','T2SOLD1','NEW',500.00,'SOLD');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.v_tyre_valuation WHERE display_code = 'T2SOLD1') THEN
    RAISE EXCEPTION 'FAIL: a SOLD tyre fell out of the register (it is history, not deleted)'; END IF;
  SELECT count(*) INTO n FROM app.v_estate_valuation WHERE location_class = 'SOLD';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: SOLD tyres are counted in the estate, their value has left the fleet'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='app' AND table_name='tyre_event'
                    AND column_name='proceeds' AND data_type='numeric') THEN
    RAISE EXCEPTION 'FAIL: tyre_event.proceeds is missing or not numeric'; END IF;

  -- CHG-019: legal minima are platform reference data, visible from any
  -- tenant context, carrying the citation, and immutable to the app role
  SELECT minimum_mm::text || '|' || citation INTO got
    FROM app.jurisdiction_tread_minimum WHERE jurisdiction='ZA';
  IF got IS DISTINCT FROM '1.0|Regulation 212, National Road Traffic Act 93 of 1996' THEN
    RAISE EXCEPTION 'FAIL: ZA legal minimum reads [%], expected 1.0mm under Regulation 212', got; END IF;

  -- Check 4 proves the app role cannot rewrite casing_valuation,
  -- tenant_consent, vehicle_odometer_reading or the legal minima (CR-004,
  -- DR-011).

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  RAISE NOTICE 'PASS  vocabulary, provenance columns, disposal semantics and reference data all hold';
END $$;

-- 27a. Seven named CHECK constraints (TYRE-190). Each block inserts a row
-- its own constraint's predicate rejects, and GET STACKED DIAGNOSTICS names
-- the constraint that fired, so a block cannot pass by catching an
-- unrelated check_violation. The spare and retread rules are two-sided and
-- are planted on both sides (TYRE-309).
DO $$
DECLARE cn text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- platform_admin_has_no_tenant is two-sided too, but only this side is
  -- reachable as app_login: the policy's WITH CHECK refuses a tenant-less
  -- non-admin row (42501) before the CHECK is evaluated.
  BEGIN
    INSERT INTO app.app_user (tenant_id, email, display_name, role)
    VALUES (app.current_tenant_id(), 'chk190-admin@example.test', 'CHK190', 'PLATFORM_ADMIN');
    RAISE EXCEPTION 'FAIL: platform_admin_has_no_tenant accepted a PLATFORM_ADMIN row with a tenant';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'platform_admin_has_no_tenant' THEN
      RAISE EXCEPTION 'FAIL: expected platform_admin_has_no_tenant, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.position (tenant_id, configuration_id, code, sequence, axle_number, axle_class, side, slot, is_spare)
    SELECT app.current_tenant_id(), ac.id, 'CHK190POS', 999, 1, 'STEER', 'LEFT', 'SINGLE', true
      FROM app.axle_configuration ac WHERE ac.tenant_id = app.current_tenant_id() LIMIT 1;
    RAISE EXCEPTION 'FAIL: spare_has_no_geometry accepted a spare position carrying axle geometry';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'spare_has_no_geometry' THEN
      RAISE EXCEPTION 'FAIL: expected spare_has_no_geometry, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.position (tenant_id, configuration_id, code, sequence, axle_number, axle_class, side, slot, is_spare)
    SELECT app.current_tenant_id(), ac.id, 'CHK190POS2', 998, NULL, 'STEER', NULL, NULL, false
      FROM app.axle_configuration ac WHERE ac.tenant_id = app.current_tenant_id() LIMIT 1;
    RAISE EXCEPTION 'FAIL: spare_has_no_geometry accepted a running position with no axle geometry';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'spare_has_no_geometry' THEN
      RAISE EXCEPTION 'FAIL: expected spare_has_no_geometry, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.tyre (tenant_id, display_code, status, retread_count, state)
    VALUES (app.current_tenant_id(), 'CHK190RETREAD', 'NEW', 1, 'IN_STOCK');
    RAISE EXCEPTION 'FAIL: retread_count_matches_status accepted a NEW tyre with a nonzero retread count';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'retread_count_matches_status' THEN
      RAISE EXCEPTION 'FAIL: expected retread_count_matches_status, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.tyre (tenant_id, display_code, status, retread_count, state)
    VALUES (app.current_tenant_id(), 'CHK190RETREAD0', 'RETREAD', 0, 'IN_STOCK');
    RAISE EXCEPTION 'FAIL: retread_count_matches_status accepted a RETREAD tyre with a zero retread count';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'retread_count_matches_status' THEN
      RAISE EXCEPTION 'FAIL: expected retread_count_matches_status, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer, state, void_reason)
    SELECT app.current_tenant_id(), v.id, u.id, gen_random_uuid(), now(), now(), 0, 'VOIDED', NULL
      FROM app.vehicle v, app.app_user u
     WHERE v.tenant_id = app.current_tenant_id() AND u.tenant_id = app.current_tenant_id()
     LIMIT 1;
    RAISE EXCEPTION 'FAIL: void_has_reason accepted a VOIDED inspection with no reason (FR-INS-012)';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'void_has_reason' THEN
      RAISE EXCEPTION 'FAIL: expected void_has_reason, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.exception (tenant_id, rule_id, subject_type, subject_id, severity, state)
    SELECT app.current_tenant_id(), er.id, 'TYRE', gen_random_uuid(), 'WARNING', 'CLOSED'
      FROM app.exception_rule er WHERE er.tenant_id = app.current_tenant_id() LIMIT 1;
    RAISE EXCEPTION 'FAIL: closure_is_explained accepted a CLOSED exception with no resolution (FR-EXC-009)';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'closure_is_explained' THEN
      RAISE EXCEPTION 'FAIL: expected closure_is_explained, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                              fitted_odometer, removed_at, removed_odometer, removal_reason)
    SELECT app.current_tenant_id(),
           (SELECT id FROM app.tyre WHERE tenant_id = app.current_tenant_id() LIMIT 1),
           (SELECT id FROM app.vehicle WHERE tenant_id = app.current_tenant_id() LIMIT 1),
           (SELECT id FROM app.position WHERE tenant_id = app.current_tenant_id() LIMIT 1),
           now(), 1000, now(), 500, 'CHK190';
    RAISE EXCEPTION 'FAIL: odometer_does_not_decrease accepted a removal odometer before the fitted one';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'odometer_does_not_decrease' THEN
      RAISE EXCEPTION 'FAIL: expected odometer_does_not_decrease, got %', cn;
    END IF;
  END;

  BEGIN
    INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, state, cancelled_reason)
    SELECT app.current_tenant_id(), v.id, now(), 'CANCELLED', NULL
      FROM app.vehicle v WHERE v.tenant_id = app.current_tenant_id() LIMIT 1;
    RAISE EXCEPTION 'FAIL: cancellation_is_explained accepted a CANCELLED task with no reason';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF cn IS DISTINCT FROM 'cancellation_is_explained' THEN
      RAISE EXCEPTION 'FAIL: expected cancellation_is_explained, got %', cn;
    END IF;
  END;

  RAISE NOTICE 'PASS  seven named CHECK constraints reject the row their own predicate names, and the spare and retread rules reject both sides';
END $$;
ROLLBACK;

\echo '== 28. Actor scope predicates: depot and task views (FR-AUT-006/008, FR-DSH-012)'
DO $$
DECLARE got text; n int;
BEGIN
  -- Self-contained: pin tenant 1 rather than inherit check 27's session state.
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- Melusi is scoped to Johannesburg, where all three tenant-1 units are based.
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);
  SELECT string_agg(fleet_number, ',' ORDER BY fleet_number) INTO got FROM app.v_depot_vehicle;
  IF got IS DISTINCT FROM 'HORSE,LINK12,LINK6' THEN
    RAISE EXCEPTION 'FAIL: depot-scoped units read [%], expected HORSE,LINK12,LINK6', got; END IF;

  -- Sipho holds no user_depot row: depot scope is granted, never implied by
  -- tenant membership (FR-AUT-004).
  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: user with no depot scope sees % units', n; END IF;

  -- Tenant 2's user id inside a tenant-1 session: the tenant predicate binds
  -- before the actor predicate, so a stale or stolen actor id cannot cross
  -- the boundary.
  PERFORM set_config('app.actor_id', md5('driver2')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: foreign-tenant actor sees % units', n; END IF;

  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % units', n; END IF;
  RAISE NOTICE 'PASS  depot-scoped units are granted, tenant-bound and fail closed';
END $$;

-- Transaction-scoped: the staged Bloemfontein depot and its tyre roll back
-- (DR-014a leaves the app role no DELETE for cleanup).
BEGIN;
DO $$
DECLARE fitted int; scoped int; n int; other_depot uuid; other_tyre uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);

  -- A tyre is in a depot two ways and FR-AUT-006 means both: sitting there,
  -- or fitted to a unit based there. Scoping on current_depot_id alone would
  -- return zero on this fixture, whose tyres are all fitted.
  SELECT count(*) INTO fitted FROM app.fitment WHERE removed_at IS NULL;
  IF fitted = 0 THEN
    RAISE EXCEPTION 'FAIL: fixture has no open fitments, so this check proves nothing'; END IF;
  SELECT count(*) INTO scoped FROM app.v_depot_tyre;
  IF scoped <> fitted THEN
    RAISE EXCEPTION 'FAIL: depot-scoped tyres = %, open fitments = %', scoped, fitted; END IF;

  -- Same predicate as the vehicle check above: no user_depot row means no
  -- depots (FR-AUT-004).
  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, true);
  SELECT count(*) INTO n FROM app.v_depot_tyre;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: an actor with no depots sees % tyres', n; END IF;

  -- Staged rather than seeded: without a depot Melusi is not a member of,
  -- the count above cannot tell "tyres in my depots" from "every tyre in the
  -- tenant". This fixture's one depot homes every unit (FR-AUT-006).
  INSERT INTO app.depot (tenant_id, name, type)
  VALUES ('11111111-1111-1111-1111-111111111111', 'Bloemfontein', 'DEPOT')
  RETURNING id INTO other_depot;
  INSERT INTO app.tyre (tenant_id, display_code, current_depot_id)
  VALUES ('11111111-1111-1111-1111-111111111111', 'FINALREVIEW-OTHER-DEPOT', other_depot)
  RETURNING id INTO other_tyre;

  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  SELECT count(*) INTO n FROM app.v_depot_tyre WHERE id = other_tyre;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a tyre in a depot the actor does not belong to is visible'; END IF;

  PERFORM set_config('app.actor_id', '', true);
  SELECT count(*) INTO n FROM app.v_depot_tyre;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % tyres', n; END IF;
  RAISE NOTICE 'PASS  depot-scoped tyres reach fitted stock, exclude other depots and fail closed';
END $$;
ROLLBACK;

-- Transaction-scoped, like check 26 on the other tenant: the staged tasks
-- roll back rather than being cleaned up (DR-014a).
BEGIN;
DO $$
DECLARE t1 uuid; t2 uuid; veh uuid; n int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.actor_id', '', true);

  -- Staged here rather than seeded: the fixture carries no tasks at all, and
  -- seeding one would couple this check to check 26's residue.
  SELECT id INTO veh FROM app.vehicle WHERE fleet_number = 'HORSE';
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, state)
  VALUES ('11111111-1111-1111-1111-111111111111', veh, now() - interval '1 day',
          md5('driver1')::uuid, 'OPEN')
  RETURNING id INTO t1;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, state)
  VALUES ('11111111-1111-1111-1111-111111111111', veh, now() + interval '1 day',
          md5('driver3')::uuid, 'OPEN')
  RETURNING id INTO t2;

  -- FR-DSH-012: a driver's own work, and only their own.
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  SELECT string_agg(id::text, ',') INTO got FROM app.v_my_inspection_task;
  IF got IS DISTINCT FROM t1::text THEN
    RAISE EXCEPTION 'FAIL: driver1 sees tasks [%], expected only their own', got; END IF;

  -- Overdue is computed, never stored: app.task_state has no such value, so
  -- the past-due task must read overdue and the future one must not.
  SELECT count(*) INTO n FROM app.v_my_inspection_task WHERE overdue;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: expected 1 overdue task for driver1, got %', n; END IF;

  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, true);
  SELECT string_agg(id::text, ',') INTO got FROM app.v_my_inspection_task;
  IF got IS DISTINCT FROM t2::text THEN
    RAISE EXCEPTION 'FAIL: driver3 sees tasks [%], expected only their own', got; END IF;
  SELECT count(*) INTO n FROM app.v_my_inspection_task WHERE overdue;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a task due tomorrow reads as overdue'; END IF;

  PERFORM set_config('app.actor_id', '', true);
  SELECT count(*) INTO n FROM app.v_my_inspection_task;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % tasks', n; END IF;
  RAISE NOTICE 'PASS  task view is actor-scoped, computes overdue and fails closed';
END $$;
ROLLBACK;

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

\echo '== 31. Submit is atomic, idempotent, and never loses an inspection to its odometer (FR-OFF-011/016, FR-INS-020/038, DR-020, FR-INS-063, TY004/005/006/007)'
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
  -- governing_tread_mm is numeric(4,1). Reading it into an int rounds 6.9
  -- to 7 and the assertion then fails against a CORRECT implementation.
  gov    numeric;
  -- The FR-INS-038 window is measured from now(), which is frozen for the
  -- transaction. Every probe timestamp is derived from it so the section
  -- does not start failing on a date after it was written.
  t_now  constant timestamptz := now();
  -- A second unit, whose window this section has not already consumed: the
  -- odometer-containment probe must submit successfully, and it cannot do
  -- that against the unit the TY003 probe just proved is inside the window.
  v_two  uuid;
  pos2   uuid;   -- v_two's OWN position, not v_id's (TY004 is per-vehicle lineage)
  -- comb1's third member (veh2/LINK6), untouched by any probe above: the D5
  -- observation probe needs its own fresh vehicle too, or it collides with
  -- the window v_id already consumed.
  posx   uuid;
  -- The fixture's three real units (v_id, veh2, v_two) are all consumed by
  -- the probes above, so the branches nothing has ever exercised each need a
  -- fresh, still-virgin vehicle of their own.
  v_probe       uuid;   -- TY004/TY005/TY006: every probe against it fails,
                         -- so its window is never spent and all three share it.
  pos_probe     uuid;
  v_combo       uuid;   -- FR-OFF-016, both CLIENT warning loops, task
                         -- closure, and D5's exact-match case: one submission
                         -- that must succeed, since none of these branches
                         -- interacts with any other.
  pos_combo     uuid;
  v_fitted_tyre uuid;
  probe_task    uuid;
  taskclosed    uuid;
  v_queued      uuid;   -- C1: a queued pair, both submitted_at far from real
                         -- now() and close only to each other.
  pos_queued    uuid;
  v_late        uuid;   -- C2: a stale capture drained after a fresher one is
  pos_late      uuid;    -- already stored, and the near side of that window.
  v_atomic      uuid;   -- the atomicity claim needs a probe whose FIRST
  pos_atomic    uuid;    -- reading is valid and whose SECOND is refused.
  pos_atomic2   uuid;
  v_gran        uuid;   -- the granularity fallback needs a submit that lands.
  pos_gran      uuid;
  v_taskb       uuid;   -- I1: a task on one vehicle, a submit of another.
  pos_taskb     uuid;
  v_taskc       uuid;
  other_task    uuid;
  v_super       uuid;   -- FR-VEH-016: a vehicle on version 2 of its
  pos_super_v1  uuid;    -- configuration, submitting a version-1 position.
  cfg_v1        uuid;
  cfg_v2        uuid;
  t2_drv        uuid;   -- the same client_uuid, accepted in a second tenant.
  t2_veh        uuid;
  t2_pos        uuid;
  a_reading     uuid;
  gran          numeric;
  probe         jsonb;  -- one entry of a table-driven refusal set
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  SELECT id INTO drv FROM app.app_user WHERE tenant_id = t_id AND role = 'DRIVER' AND active LIMIT 1;
  PERFORM set_config('app.actor_id', drv::text, true);

  SELECT v.id INTO v_id FROM app.vehicle v WHERE v.tenant_id = t_id ORDER BY v.fleet_number LIMIT 1;
  SELECT v.id INTO v_two FROM app.vehicle v WHERE v.tenant_id = t_id ORDER BY v.fleet_number OFFSET 1 LIMIT 1;
  SELECT p.id INTO posl FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_id AND p.side = 'LEFT' AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO posr FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_id AND p.side = 'RIGHT' AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos2 FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_two AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO posx FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = md5('veh2')::uuid AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  -- Section-local fixtures, rolled back with everything else here: reusing
  -- an existing tenant-1 configuration (TRAILER_2AXLE) means these vehicles
  -- get real, valid positions for free, with no new axle configuration to
  -- build. The units are trailers because they sit on TRAILER_2AXLE
  -- (000042's rule, TYRE-224), and no assertion in this section depends on
  -- the kind.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-PROBE',  md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_probe;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-COMBO',  md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_combo;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-QUEUED', md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_queued;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-LATE',   md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_late;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-ATOMIC', md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_atomic;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-GRAN',   md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_gran;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-TASK-B', md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_taskb;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind) VALUES
    (gen_random_uuid(), t_id, 'SEC31-TASK-C', md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid, 'TRAILER')
    RETURNING id INTO v_taskc;

  SELECT p.id INTO pos_atomic FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_atomic AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos_atomic2 FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_atomic AND NOT p.is_spare ORDER BY p.sequence OFFSET 1 LIMIT 1;
  SELECT p.id INTO pos_gran FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_gran AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos_taskb FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_taskb AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  -- An OPEN task against TASK-C, which no submit below ever covers.
  INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, state)
  VALUES (gen_random_uuid(), t_id, v_taskc, t_now, 'OPEN') RETURNING id INTO other_task;

  SELECT p.id INTO pos_probe FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_probe AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos_combo FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_combo AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos_queued FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_queued AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pos_late FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = v_late AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  -- A throwaway tyre never fitted anywhere else: the fixture's own tyres are
  -- all already fitted, and DR-005 forbids a second open fitment for one, so
  -- the FR-OFF-016 disagreement probe needs its own "currently fitted"
  -- baseline to disagree with.
  INSERT INTO app.tyre (id, tenant_id, display_code)
  VALUES (gen_random_uuid(), t_id, 'SEC31-PROBE-TYRE') RETURNING id INTO v_fitted_tyre;
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
  VALUES (t_id, v_fitted_tyre, v_combo, pos_combo, t_now - interval '30 days', 100000);

  INSERT INTO app.inspection_task (id, tenant_id, vehicle_id, due_at, state)
  VALUES (gen_random_uuid(), t_id, v_combo, t_now, 'OPEN') RETURNING id INTO probe_task;

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', cu, 'vehicle_id', v_id,
    'started_at', t_now - interval '160 seconds', 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                         'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)),
      jsonb_build_object('vehicle_id', v_id, 'position_id', posr,
                         'pressure_kpa', 790, 'treads', jsonb_build_array(6.5, 6.8, 7.2)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: a first submit reported created = false'; END IF;
  first := res.inspection_id;

  -- BR-INS-003 / DR-017: the MIN is the database's to derive, not the client's
  SELECT governing_tread_mm INTO gov FROM app.reading WHERE inspection_id = first AND position_id = posl;
  IF gov IS DISTINCT FROM 6.9 THEN RAISE EXCEPTION 'FAIL: governing tread was % not 6.9', gov; END IF;

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
    'started_at', t_now - interval '160 seconds', 'submitted_at', t_now,
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
      'started_at', t_now + interval '2 minutes', 'submitted_at', t_now + interval '4 minutes',
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_id, 'position_id', posl,
                           'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)))));
  EXCEPTION WHEN SQLSTATE 'TY003' THEN got := 'TY003';
  END;
  IF got IS DISTINCT FROM 'TY003' THEN
    RAISE EXCEPTION 'FAIL: a second inspection inside the window was not refused (got %)', COALESCE(got, 'no error');
  END IF;

  -- D5 / FR-INS-063: the driver confirmed only the horse, not comb1's full
  -- three-unit membership (horse + both links). A fresh vehicle (veh2, comb1's
  -- other trailer) so this probe does not collide with the window v_id
  -- already consumed above.
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_id,
    'combination_id', md5('comb1')::uuid,
    'observed_member_vehicle_ids', jsonb_build_array(v_id),
    'started_at', t_now - interval '12 minutes', 'submitted_at', t_now - interval '10 minutes',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', md5('veh2')::uuid, 'position_id', posx,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: an observed-composition mismatch cost us the inspection'; END IF;
  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND warning_code = 'FR-INS-063' AND source = 'SERVER';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: an observed set differing from comb1''s membership left % FR-INS-063 warnings, not 1', n;
  END IF;

  -- TY007: a vehicle from another tenant must reach a 422-shaped refusal, not
  -- the composite FK's 23503; RLS makes the row invisible, not merely
  -- foreign. 422 rather than the 403 given elsewhere, since FR-OFF-013's
  -- permanent-refusal set is 409 and 422, and a retryable 403 would hammer a
  -- submit that can never succeed. readings carries a real element, since an
  -- empty one is now its own refusal, raised earlier.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', md5('t2veh1')::uuid,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', md5('t2veh1')::uuid, 'position_id', gen_random_uuid(),
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY007' THEN got := 'TY007';
  END;
  IF got IS DISTINCT FROM 'TY007' THEN
    RAISE EXCEPTION 'FAIL: a vehicle from another tenant was not refused with TY007 (got %)', COALESCE(got, 'no error');
  END IF;

  -- TY004: a position genuinely on the wrong vehicle's configuration within
  -- the same tenant (not off-tenant, TY007 above already covers that). posl
  -- belongs to v_id's HORSE_6X4 lineage; v_probe carries TRAILER_2AXLE.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_probe, 'position_id', posl,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY004' THEN got := 'TY004';
  END;
  IF got IS DISTINCT FROM 'TY004' THEN
    RAISE EXCEPTION 'FAIL: a position off the vehicle''s configuration lineage was not refused with TY004 (got %)', COALESCE(got, 'no error');
  END IF;

  -- TY005, absent case: the treads key is omitted entirely, not sent as [].
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_probe, 'position_id', pos_probe, 'pressure_kpa', 750))));
  EXCEPTION WHEN SQLSTATE 'TY005' THEN got := 'TY005';
  END;
  IF got IS DISTINCT FROM 'TY005' THEN
    RAISE EXCEPTION 'FAIL: a reading with no treads key was not refused with TY005 (got %)', COALESCE(got, 'no error');
  END IF;

  -- TY005, wrong-count case: present, but disagrees with tread_reading_count.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_probe, 'position_id', pos_probe, 'pressure_kpa', 750,
                           'treads', jsonb_build_array(7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY005' THEN got := 'TY005';
  END;
  IF got IS DISTINCT FROM 'TY005' THEN
    RAISE EXCEPTION 'FAIL: a reading with the wrong tread count was not refused with TY005 (got %)', COALESCE(got, 'no error');
  END IF;

  -- TY006: the client asserted the derived field.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_probe, 'position_id', pos_probe, 'pressure_kpa', 750,
                           'treads', jsonb_build_array(7.0, 7.0, 7.0), 'governing_tread_mm', 6.9))));
  EXCEPTION WHEN SQLSTATE 'TY006' THEN got := 'TY006';
  END;
  IF got IS DISTINCT FROM 'TY006' THEN
    RAISE EXCEPTION 'FAIL: a payload asserting governing_tread_mm was not refused with TY006 (got %)', COALESCE(got, 'no error');
  END IF;
  -- None of the four refusals above ever committed a reading, confirming
  -- each was reached and refused on its own terms, not masked by an earlier
  -- one silently succeeding.
  SELECT count(*) INTO n FROM app.reading WHERE vehicle_id = v_probe;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a refused submit left % reading rows on v_probe', n; END IF;

  -- FR-OFF-016, both CLIENT warning loops, task closure, and D5's
  -- exact-match case, folded into one submission: none of these branches
  -- interacts with any other, so one successful submit exercises all four.
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_combo, 'task_id', probe_task,
    'combination_id', md5('comb1')::uuid,
    'observed_member_vehicle_ids', jsonb_build_array(v_id, md5('veh2')::uuid, v_two),
    'started_at', t_now - interval '32 minutes', 'submitted_at', t_now - interval '30 minutes',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_combo, 'position_id', pos_combo,
                         'tyre_id', md5('tyre2')::uuid,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0),
                         'warnings', jsonb_build_array(
                           jsonb_build_object('code', 'FR-INS-036', 'entered_value', '3.2', 'response', 'ACKNOWLEDGED')))),
    'warnings', jsonb_build_array(
      jsonb_build_object('code', 'FR-INS-030a', 'entered_value', 'driver comment noted', 'response', 'ACKNOWLEDGED'))));
  IF NOT res.created THEN
    RAISE EXCEPTION 'FAIL: the combined FR-OFF-016/warnings/task-closure/D5 probe reported created = false';
  END IF;

  -- FR-OFF-016: pos_combo's currently-fitted tyre is v_fitted_tyre, the
  -- reading named a different one.
  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND warning_code = 'FR-OFF-016' AND source = 'SERVER'
     AND entered_value = (md5('tyre2')::uuid)::text;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a fitment disagreement left % FR-OFF-016 warnings, not 1', n; END IF;

  -- Per-reading CLIENT warning: the driver answered it, so the response survives.
  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND reading_id IS NOT NULL
     AND warning_code = 'FR-INS-036' AND source = 'CLIENT' AND response = 'ACKNOWLEDGED'
     AND entered_value = '3.2';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a reading-level CLIENT warning did not land, got % rows', n; END IF;

  -- Payload-level CLIENT warning: same shape, no reading to hang off.
  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND reading_id IS NULL
     AND warning_code = 'FR-INS-030a' AND source = 'CLIENT' AND response = 'ACKNOWLEDGED';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a payload-level CLIENT warning did not land, got % rows', n; END IF;

  -- D5, the exact-match case: the observed set equals comb1's real
  -- membership, so no FR-INS-063 warning at all. The earlier D5 probe in
  -- this section already pins the mismatch case; this pins the match.
  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND warning_code = 'FR-INS-063';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: an observed set matching comb1 exactly still raised % FR-INS-063 warnings', n;
  END IF;

  -- Task closure: an OPEN task cited by task_id is completed and cites the
  -- new inspection.
  SELECT it.state::text, it.completed_inspection_id INTO got, taskclosed
    FROM app.inspection_task it WHERE it.id = probe_task;
  IF got <> 'COMPLETED' OR taskclosed IS DISTINCT FROM res.inspection_id THEN
    RAISE EXCEPTION 'FAIL: task closure left state=% completed_inspection_id=%', got, taskclosed;
  END IF;

  -- C1: the window compares capture-clock to capture-clock, not the real
  -- server clock. Both submits below claim a submitted_at two days in the
  -- past, an hour apart from each other, the shape of a pair queued offline
  -- and drained together. A server-clock predicate would miss this: the
  -- first's stored submitted_at is nowhere near real now(), so its EXISTS
  -- check would find nothing and wrongly accept the second.
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_queued,
    'started_at', t_now - interval '2 days' - interval '10 minutes',
    'submitted_at', t_now - interval '2 days',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_queued, 'position_id', pos_queued,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: the first of a queued pair reported created = false'; END IF;

  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_queued,
      'started_at', t_now - interval '2 days' + interval '50 minutes',
      'submitted_at', t_now - interval '2 days' + interval '1 hour',
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_queued, 'position_id', pos_queued,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY003' THEN got := 'TY003';
  END;
  IF got IS DISTINCT FROM 'TY003' THEN
    RAISE EXCEPTION 'FAIL: a queued pair an hour apart, both stale by real now(), was not refused with TY003 (got %)', COALESCE(got, 'no error');
  END IF;

  -- C2, the mirror of C1: the window is symmetric, so a payload OLDER than
  -- what is stored is judged the same as a newer one, which the outbox makes
  -- ordinary (a capture held offline drains after a later one has landed).
  -- TY003 reaches the device as a 409, which the outbox treats as permanent,
  -- so a wrongly refused submit is a completed walk-around discarded
  -- (FR-OFF-014).
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_late,
    'started_at', t_now - interval '10 minutes', 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_late, 'position_id', pos_late,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: the fresher of an out-of-order pair reported created = false'; END IF;

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_late,
    'started_at', t_now - interval '2 days' - interval '10 minutes',
    'submitted_at', t_now - interval '2 days',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_late, 'position_id', pos_late,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN
    RAISE EXCEPTION 'FAIL: a capture two days older than the stored one was refused as a duplicate';
  END IF;

  -- And the near side of the same window still bites: two hours before an
  -- inspection already stored is two hours apart, whichever order they
  -- arrived in.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_late,
      'started_at', t_now - interval '2 hours' - interval '10 minutes',
      'submitted_at', t_now - interval '2 hours',
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_late, 'position_id', pos_late,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY003' THEN got := 'TY003';
  END;
  IF got IS DISTINCT FROM 'TY003' THEN
    RAISE EXCEPTION 'FAIL: a capture two hours BEFORE a stored one was not refused with TY003 (got %)', COALESCE(got, 'no error');
  END IF;

  -- FR-INS-020 + DR-020: the timeline refuses the number, the inspection
  -- lives. Against v_two, not v_id: v_id's window is already consumed above,
  -- and reusing it here would trip TY003 instead of exercising DR-020.
  INSERT INTO app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date, odometer_km, source)
  VALUES (t_id, v_two, (t_now AT TIME ZONE 'UTC')::date - 5, 900000, 'MANUAL');

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_two,
    'started_at', t_now - interval '1 day' - interval '160 seconds', 'submitted_at', t_now - interval '1 day',
    'odometer_km', 100,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_two, 'position_id', pos2,
                         'pressure_kpa', 780, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN RAISE EXCEPTION 'FAIL: a backwards odometer cost us the inspection'; END IF;

  SELECT count(*) INTO n FROM app.inspection_warning
   WHERE inspection_id = res.inspection_id AND warning_code = 'DR-020' AND source = 'SERVER'
     AND entered_value = '100' AND response IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: the refused odometer left % warning records, not 1', n; END IF;

  SELECT count(*) INTO n FROM app.vehicle_odometer_reading
   WHERE vehicle_id = v_two AND odometer_km = 100;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: an implausible odometer reached the timeline'; END IF;

  -- Every payload shape that can ONLY ever fail must refuse by name.
  -- ADR-0009's outbox retries a 5xx forever, so a generic integrity SQLSTATE
  -- (which the transport can only call a 500) would retry a submit that can
  -- never succeed, FR-OFF-020's queue would never drain, and only a database
  -- support engineer could clear it. FR-OFF-013 gives the driver a named
  -- refusal to act on instead.
  FOR probe IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('why', 'no client_uuid', 'payload', jsonb_build_object(
        'vehicle_id', v_probe, 'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0))))),
      jsonb_build_object('why', 'no submitted_at', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe, 'started_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0))))),
      -- inspection.started_at is NOT NULL, and the column's own 23502 would
      -- reach the driver canned (000060, FR-OFF-013).
      jsonb_build_object('why', 'no started_at', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0))))),
      -- FR-INS-020: an inspection is its readings. All three shapes below
      -- landed a SYNCED inspection at 100% completeness recording nothing, or
      -- reached jsonb_array_elements as a scalar.
      jsonb_build_object('why', 'no readings key', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now)),
      jsonb_build_object('why', 'a null readings key', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now) || '{"readings": null}'::jsonb),
      jsonb_build_object('why', 'an empty readings array', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now, 'readings', '[]'::jsonb)),
      jsonb_build_object('why', 'a readings key that is not an array', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now, 'readings', '"nope"'::jsonb)),
      -- FR-INS-030/031's hard ranges, reached by a client for the first time
      -- in this branch. jsonb_array_length counts a JSON null as an entry, so
      -- the null below passes the width check and only the element guard sees it.
      jsonb_build_object('why', 'a null inside treads', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 750) || '{"treads": [7.0, null, 7.0]}'::jsonb))),
      jsonb_build_object('why', 'a tread of 40mm', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 40.0, 7.0))))),
      jsonb_build_object('why', 'a pressure of 5000 kPa', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe,
          'pressure_kpa', 5000, 'treads', jsonb_build_array(7.0, 7.0, 7.0))))),
      jsonb_build_object('why', 'a gauge granularity of 0.25mm', 'payload', jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(jsonb_build_object(
          'vehicle_id', v_probe, 'position_id', pos_probe, 'pressure_kpa', 750,
          'granularity_mm', 0.25, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))))
    )) LOOP
    got := NULL;
    BEGIN
      PERFORM app.submit_inspection(probe -> 'payload');
    EXCEPTION WHEN SQLSTATE 'TY005' THEN got := 'TY005';
    END;
    IF got IS DISTINCT FROM 'TY005' THEN
      RAISE EXCEPTION 'FAIL: a payload carrying % was not refused with TY005 (got %)',
        probe ->> 'why', COALESCE(got, 'no error');
    END IF;
  END LOOP;

  -- Eleven more refusals, still nothing written: each was reached and refused on
  -- its own terms rather than masked by an earlier one quietly succeeding.
  SELECT count(*) INTO n FROM app.reading WHERE vehicle_id = v_probe;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a refused payload left % reading rows on v_probe', n; END IF;

  -- The function's range guards echo these constraints so a refusal can name
  -- the position; the constraints remain the authority for the numbers. Pin
  -- that they are still there, reached directly rather than through the
  -- function, so the two can never drift apart silently.
  SELECT id INTO a_reading FROM app.reading WHERE inspection_id = first AND position_id = posl;
  got := NULL;
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, tread_mm, position, granularity_mm, orientation_known)
    VALUES (t_id, a_reading, 4, 40.0, 'CENTRE', 1.0, true);
  EXCEPTION WHEN check_violation THEN got := 'check_violation';
  END;
  IF got IS DISTINCT FROM 'check_violation' THEN
    RAISE EXCEPTION 'FAIL: reading_measurement accepted a 40mm tread (got %)', COALESCE(got, 'no error');
  END IF;

  got := NULL;
  BEGIN
    INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id, pressure_kpa)
    VALUES (t_id, first, v_id, pos_probe, 5000);
  EXCEPTION WHEN check_violation THEN got := 'check_violation';
  END;
  IF got IS DISTINCT FROM 'check_violation' THEN
    RAISE EXCEPTION 'FAIL: reading accepted a 5000 kPa pressure (got %)', COALESCE(got, 'no error');
  END IF;

  -- tread_reading_count is tenant config, unconstrained (CR-011 maps 1 or 3
  -- positions only). 4 overflows the width array into a NOT NULL violation;
  -- 2 silently mislabels the far edge as CENTRE, compensable but never
  -- correctable (DR-014a); unconfigured hits NULL NOT IN (1,3) IS NULL.
  -- A plpgsql EXCEPTION block is a savepoint, so these three run against the
  -- shared tenant without disturbing what follows.
  FOR probe IN SELECT * FROM jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('cfg', '4'::jsonb,    'treads', jsonb_build_array(7.0, 7.0, 7.0, 7.0)),
      jsonb_build_object('cfg', '2'::jsonb,    'treads', jsonb_build_array(7.0, 7.0)),
      jsonb_build_object('cfg', 'null'::jsonb, 'treads', '[]'::jsonb)
    )) LOOP
    got := NULL;
    BEGIN
      INSERT INTO app.configuration (tenant_id, key, value, effective_from)
      VALUES (t_id, 'tread_reading_count', probe -> 'cfg', t_now - interval '1 minute');
      PERFORM app.submit_inspection(jsonb_build_object(
        'client_uuid', gen_random_uuid(), 'vehicle_id', v_probe,
        'started_at', t_now, 'submitted_at', t_now,
        'readings', jsonb_build_array(
          jsonb_build_object('vehicle_id', v_probe, 'position_id', pos_probe,
                             'pressure_kpa', 750, 'treads', probe -> 'treads'))));
    EXCEPTION WHEN SQLSTATE 'TY005' THEN got := 'TY005';
    END;
    IF got IS DISTINCT FROM 'TY005' THEN
      RAISE EXCEPTION 'FAIL: tread_reading_count = % was not refused with TY005 (got %)',
        probe ->> 'cfg', COALESCE(got, 'no error');
    END IF;
  END LOOP;

  -- ... and the tenant's real configuration survived all three, which is what
  -- makes every probe after this one sound.
  IF (app.config_for(t_id, 'tread_reading_count', now()) #>> '{}')::int <> 3 THEN
    RAISE EXCEPTION 'FAIL: the tread_reading_count probes left the tenant configured at %',
      app.config_for(t_id, 'tread_reading_count', now());
  END IF;

  -- Atomicity, which no probe above reaches: every refusal so far fires on
  -- the FIRST reading, so none of them can show that an accepted reading is
  -- rolled back when a later one is refused. Reading 1 here is valid and
  -- lands; reading 2 carries the wrong tread count. A partial vehicle is the
  -- one outcome DR-014a cannot be undone from.
  got := NULL;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_atomic,
      'started_at', t_now, 'submitted_at', t_now,
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_atomic, 'position_id', pos_atomic,
                           'pressure_kpa', 780, 'treads', jsonb_build_array(7.4, 7.1, 6.9)),
        jsonb_build_object('vehicle_id', v_atomic, 'position_id', pos_atomic2,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0)))));
  EXCEPTION WHEN SQLSTATE 'TY005' THEN got := 'TY005';
  END;
  IF got IS DISTINCT FROM 'TY005' THEN
    RAISE EXCEPTION 'FAIL: a wrong tread count on the SECOND reading was not refused (got %)',
      COALESCE(got, 'no error');
  END IF;
  SELECT count(*) INTO n FROM app.reading WHERE vehicle_id = v_atomic;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL: a refused second reading left % rows written by the first', n;
  END IF;
  SELECT count(*) INTO n FROM app.inspection WHERE vehicle_id = v_atomic;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: a refused submit left % inspection rows', n; END IF;

  -- FR-INS-052 requires a completed task to CITE its inspection, so closure
  -- must name a vehicle the submit actually covers: closing TASK-C from a
  -- submit of TASK-B would falsely assert C was inspected, standing down its
  -- next task and dropping the unit from the controller's outstanding view.
  -- FR-INS-051 lets a driver hold several open tasks at once, so one index
  -- slip in the client's list is all it takes.
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_taskb, 'task_id', other_task,
    'started_at', t_now, 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_taskb, 'position_id', pos_taskb,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN
    RAISE EXCEPTION 'FAIL: citing another vehicle''s task cost us the inspection';
  END IF;
  SELECT it.state::text, it.completed_inspection_id INTO got, taskclosed
    FROM app.inspection_task it WHERE it.id = other_task;
  IF got <> 'OPEN' OR taskclosed IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: a submit of one vehicle closed another vehicle''s task (state=%, cites=%)',
      got, taskclosed;
  END IF;

  -- FR-VEH-016: amending a configuration must not invalidate a capture taken
  -- against the version it replaced, the adoption wound ADR-0009 exists to
  -- prevent for a walk-around that waited days in the outbox. The function
  -- compares the (tenant_id, code) lineage rather than the vehicle's current
  -- configuration_id; the fixture ships only version 1, so this path had
  -- never run before.
  cfg_v1 := md5('11111111-1111-1111-1111-111111111111TRAILER_2AXLE')::uuid;
  INSERT INTO app.axle_configuration (tenant_id, code, name, version, axle_count, default_spare_count)
  SELECT ac.tenant_id, ac.code, ac.name, ac.version + 1, ac.axle_count, ac.default_spare_count
    FROM app.axle_configuration ac WHERE ac.id = cfg_v1
  RETURNING id INTO cfg_v2;
  INSERT INTO app.position (tenant_id, configuration_id, code, sequence, axle_number,
                            axle_class, side, slot, is_spare, unit_label, axle_type, spare_ordinal)
  SELECT p.tenant_id, cfg_v2, p.code, p.sequence, p.axle_number,
         p.axle_class, p.side, p.slot, p.is_spare, p.unit_label, p.axle_type, p.spare_ordinal
    FROM app.position p WHERE p.configuration_id = cfg_v1;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind)
  VALUES (gen_random_uuid(), t_id, 'SEC31-SUPER', cfg_v2, 'TRAILER') RETURNING id INTO v_super;
  SELECT p.id INTO pos_super_v1 FROM app.position p
   WHERE p.configuration_id = cfg_v1 AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_super,
    'started_at', t_now, 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_super, 'position_id', pos_super_v1,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created THEN
    RAISE EXCEPTION 'FAIL: a position from a superseded version of the vehicle''s OWN configuration was refused';
  END IF;

  -- ADR-0010 provenance: granularity_mm claims which gauge took the reading,
  -- on an append-only table, so a wrong value is permanent and silently
  -- degrades every later analysis. The client omits the field, easy to since
  -- it is session reference data, and must inherit the tenant's configured
  -- capture granularity rather than a literal fallback that would stamp
  -- 1.0mm precision on a 0.1mm tenant's measurement.
  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES (t_id, 'tread_capture_granularity_mm', '0.1'::jsonb, t_now - interval '1 minute');
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_gran,
    'started_at', t_now, 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_gran, 'position_id', pos_gran,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.4, 7.1, 6.9)))));
  SELECT DISTINCT m.granularity_mm INTO gran
    FROM app.reading_measurement m JOIN app.reading rd ON rd.id = m.reading_id
   WHERE rd.inspection_id = res.inspection_id;
  IF gran IS DISTINCT FROM 0.1 THEN
    RAISE EXCEPTION 'FAIL: a payload omitting granularity_mm recorded % mm, not the tenant''s configured 0.1', gran;
  END IF;

  -- TY010 is ADR-0011's invariant-breach backstop: a submit missing tenant or
  -- actor is unmapped on purpose (api/internal/httpapi/httpapi.go), so it
  -- surfaces as a 500, not a payload fault. Each half of `v_tenant IS NULL OR
  -- v_actor IS NULL` is probed alone, with a control passing once both are
  -- bound; set_config('', true), not RESET, is the unbound state 000001
  -- reads, and WHEN SQLSTATE 'P0001' precedes WHEN OTHERS so a probe's own
  -- RAISE is never relabelled as the function's failure.
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.actor_id', '', true);
  BEGIN
    PERFORM app.submit_inspection('{}'::jsonb);
    RAISE EXCEPTION 'FAIL 31: submit_inspection ran with no tenant or actor bound';
  EXCEPTION
    WHEN sqlstate 'TY010' THEN NULL;
    WHEN sqlstate 'P0001' THEN RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL 31: a submit with no context bound was refused as % (%), not TY010', SQLSTATE, SQLERRM;
  END;
  PERFORM set_config('app.actor_id', drv::text, true);
  BEGIN
    PERFORM app.submit_inspection('{}'::jsonb);
    RAISE EXCEPTION 'FAIL 31: submit_inspection ran with an actor but no tenant bound';
  EXCEPTION
    WHEN sqlstate 'TY010' THEN NULL;
    WHEN sqlstate 'P0001' THEN RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL 31: a submit with no tenant bound was refused as % (%), not TY010', SQLSTATE, SQLERRM;
  END;
  PERFORM set_config('app.tenant_id', t_id::text, true);
  PERFORM set_config('app.actor_id', '', true);
  BEGIN
    PERFORM app.submit_inspection('{}'::jsonb);
    RAISE EXCEPTION 'FAIL 31: submit_inspection ran with a tenant but no actor bound';
  EXCEPTION
    WHEN sqlstate 'TY010' THEN NULL;
    WHEN sqlstate 'P0001' THEN RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL 31: a submit with no actor bound was refused as % (%), not TY010', SQLSTATE, SQLERRM;
  END;
  PERFORM set_config('app.actor_id', drv::text, true);
  BEGIN
    PERFORM app.submit_inspection('{}'::jsonb);
    RAISE EXCEPTION 'FAIL 31: an empty payload was accepted with the context bound';
  EXCEPTION
    WHEN sqlstate 'TY005' THEN NULL;
    WHEN sqlstate 'P0001' THEN RAISE;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'FAIL 31: the control with context bound was refused as % (%), not TY005', SQLSTATE, SQLERRM;
  END;
  RAISE NOTICE 'PASS  31 each half of the tenant-or-actor guard is refused as TY010 with the other half bound, and the same payload with both bound reaches the payload guards';

  -- FR-OFF-011's uniqueness is per tenant, UNIQUE (tenant_id, client_uuid), so
  -- two tenants' devices generating the same uuid must not collide, and the
  -- second must get a NEW inspection, not the first's replay. Last in the
  -- section since it rebinds tenant and actor for the rest of the block:
  -- tenant first, then the lookup, because under tenant 1's policies the
  -- second tenant's driver is invisible, not merely forbidden, and a lookup
  -- before the rebind would silently yield NULL.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT id INTO t2_drv FROM app.app_user WHERE role = 'DRIVER' AND active LIMIT 1;
  PERFORM set_config('app.actor_id', t2_drv::text, true);

  -- A section-local unit on tenant 2's own configuration: its seeded vehicles
  -- all carry a fixture inspection inside the FR-INS-038 window, which would
  -- refuse this submit for a reason that has nothing to do with the uuid.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind)
  SELECT gen_random_uuid(), '22222222-2222-2222-2222-222222222222', 'SEC31-T2', v.configuration_id, 'HORSE'
    FROM app.vehicle v ORDER BY v.fleet_number LIMIT 1
  RETURNING id INTO t2_veh;
  SELECT p.id INTO t2_pos FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = t2_veh AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', cu, 'vehicle_id', t2_veh,
    'started_at', t_now, 'submitted_at', t_now,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', t2_veh, 'position_id', t2_pos,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  IF NOT res.created OR res.inspection_id = first THEN
    RAISE EXCEPTION 'FAIL: tenant 1''s client_uuid in tenant 2 gave created=%, id=% (expected a new inspection)',
      res.created, res.inspection_id;
  END IF;

  RAISE NOTICE 'PASS  submit is atomic and idempotent, the window is capture-clock not server-clock, every refusal branch fires on its own terms, every payload and configuration shape that can only fail refuses by name, a superseded configuration version is still accepted, D5 warns on mismatch and stays silent on match, and a refused odometer costs a warning not an inspection';
END $$;
ROLLBACK;

\echo '== 32. A unit axle configuration is immutable once it has history (D11(ii), FR-VEH-016, INV-4)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '11111111-1111-1111-1111-111111111111';
  ok        boolean := false;
  v         uuid;
  clean     uuid;
  cfg       uuid;
  other_cfg uuid;
  n         int;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);

  -- A unit with recorded history: its configuration is now load-bearing for
  -- every position row its fitments and readings point at.
  SELECT r.vehicle_id INTO v FROM app.reading r ORDER BY r.id LIMIT 1;
  IF v IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no reading to hang this test on'; END IF;

  SELECT ve.configuration_id INTO cfg FROM app.vehicle ve WHERE ve.id = v;
  SELECT ac.id INTO other_cfg
    FROM app.axle_configuration ac
   WHERE ac.tenant_id = t_id AND ac.id <> cfg ORDER BY ac.id LIMIT 1;
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
       VALUES (t_id, 'TY82-CLEAN', cfg, 'HORSE')
    RETURNING id INTO clean;
  UPDATE app.vehicle SET configuration_id = other_cfg WHERE id = clean;
  SELECT count(*) INTO n FROM app.vehicle WHERE id = clean AND configuration_id = other_cfg;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: a unit with no history was refused a configuration change'; END IF;

  -- An UPDATE that leaves configuration_id alone must pass whatever the
  -- history, or every future edit to a vehicle row is blocked by this rule.
  UPDATE app.vehicle SET registration = 'TY82-TOUCHED' WHERE id = v;

  RAISE NOTICE 'PASS  configuration is immutable with history, editable without, and other columns are untouched';
END $$;
ROLLBACK;

\echo '== 33. Fitment odometer is required where the unit kind has one (FR-FIT-002 as corrected in SRS v1.4, CHG-027)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '11111111-1111-1111-1111-111111111111';
  ok       boolean := false;
  horse    uuid;
  trailer  uuid;
  cfg      uuid;
  pos      uuid;
  f        uuid;
  spare    uuid[];
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);

  SELECT v.configuration_id INTO cfg
    FROM app.vehicle v WHERE v.unit_kind = 'HORSE' ORDER BY v.fleet_number LIMIT 1;
  IF cfg IS NULL THEN RAISE EXCEPTION 'FAIL: fixture has no HORSE to test with'; END IF;

  SELECT p.id INTO pos FROM app.position p
   WHERE p.configuration_id = cfg AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  IF pos IS NULL THEN RAISE EXCEPTION 'FAIL: the HORSE configuration has no running position'; END IF;

  -- DR-005 allows a tyre one open fitment, so every open fitment below needs
  -- its own tyre or the refusal under test arrives as one_open_fitment_per_tyre
  -- and proves nothing about TY009. The section makes its own rather than
  -- drawing on the fixture: every seeded tyre is fitted, so there is no slack
  -- to draw on, and a test that depends on there being some is a test that
  -- breaks the next time the seed fills a position.
  WITH made AS (
    INSERT INTO app.tyre (tenant_id, display_code)
    SELECT t_id, 'TY85-SPARE-' || g FROM generate_series(1, 3) g
    RETURNING id)
  SELECT array_agg(id) INTO spare FROM made;

  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t_id, 'TY85-HORSE', cfg, 'HORSE') RETURNING id INTO horse;
  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
       VALUES (t_id, 'TY85-TRAILER', cfg, 'TRAILER') RETURNING id INTO trailer;

  -- (a) A horse fitted with no odometer is refused.
  BEGIN
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
         VALUES (t_id, spare[1], horse, pos, now(), NULL);
  EXCEPTION WHEN SQLSTATE 'TY009' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: a HORSE fitment without an odometer was accepted'; END IF;

  -- (b) A trailer fitted with no odometer is accepted. It has none to give,
  -- and refusing it makes two-thirds of a superlink unrecordable.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
       VALUES (t_id, spare[2], trailer, pos, now(), NULL);

  -- (c) unit_kind is NOT NULL (000042), so a unit of unknown kind cannot
  -- exist; the exemption 000025 wrote for CHG-027's underivable rows has no
  -- row left to apply to.
  ok := false;
  BEGIN
    INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
         VALUES (t_id, 'TY85-UNKNOWN', cfg, NULL);
    RAISE EXCEPTION 'FAIL: a vehicle without a unit_kind was accepted';
  EXCEPTION WHEN not_null_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: the NULL-kind insert was not refused'; END IF;

  -- (d) A horse fitted WITH an odometer is accepted, then refused a removal
  -- that omits the removed odometer, the second half of FR-FIT-002.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
       VALUES (t_id, spare[3], horse, pos, now(), 100000) RETURNING id INTO f;

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

\echo '== 34. Platform-admin emails are unique, and a trip overlaps no other on its unit or its driver (TYRE-30, DR-003, FR-VEH-007, U143)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '11111111-1111-1111-1111-111111111111';
  h     constant uuid := md5('t34h')::uuid;
  cfg   uuid;
  n     int;
  got   text;
  n2    int;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);

  -- (a) 000027's unique index app_user_tenant_email_key on
  -- (tenant_id, lower(email)) treats NULL tenant_id as distinct, so two
  -- platform admins could share an email. Asserted through the catalog, not
  -- behaviour: the suite runs as app_login (member of app_rw only, never
  -- postgres, section 0 enforces this), and app_rw's WITH CHECK already
  -- rejects a NULL-tenant insert, so the index's existence is the strongest
  -- true statement this suite can make about the duplicate case.
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'app' AND tablename = 'app_user'
     AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
     AND indexdef ILIKE '%(email)%'
     AND indexdef ILIKE '%tenant\_id IS NULL%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected exactly one partial unique index on app_user(email) WHERE tenant_id IS NULL, found %', n;
  END IF;

  -- And prove app_login really is barred from the path that would exercise it,
  -- so the catalog assertion above is not quietly standing in for a check that
  -- could have been behavioural all along.
  -- app_user is audited, so audit_log's policy would answer a row this
  -- table's policy let through with the same 42501, and only the message
  -- says which refused (docs/lessons.md 2026-09-08). WITH CHECK runs before
  -- the CHECK constraint, so the policy is what answers.
  got := NULL;
  BEGIN
    INSERT INTO app.app_user (tenant_id, email, display_name, role)
         VALUES (NULL, 'ty30-dup@example.test', 'First', 'PLATFORM_ADMIN');
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "app_user"%' THEN
    RAISE EXCEPTION 'FAIL: app_login''s NULL-tenant insert was answered %, not by app_user''s own policy; the catalogue check above stands in for a behavioural one only while that policy refuses it',
      COALESCE(got, 'by an accepted row');
  END IF;

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
    RAISE EXCEPTION 'FAIL 34b: a duplicate open trip was answered by %, not a trip EXCLUDE',
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
    RAISE EXCEPTION 'FAIL 34c: a second driver on HORSE was answered by %, not trip_vehicle_no_overlap',
      COALESCE(got, 'an accepted row');
  END IF;

  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (h, t_id, 'T34-H', 'T34 GP', cfg, 'HORSE', 'ACTIVE');
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
         VALUES (t_id, h, md5('driver1')::uuid, now());
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS got = CONSTRAINT_NAME;
  END;
  IF got IS DISTINCT FROM 'trip_driver_no_overlap' THEN
    RAISE EXCEPTION 'FAIL 34c: Melusi on a second motive was answered by %, not trip_driver_no_overlap',
      COALESCE(got, 'an accepted row');
  END IF;

  -- (d) Back to back is not an overlap: '[)' lets one trip end at the instant
  -- the next starts.
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
       VALUES (t_id, h, md5('driver3')::uuid, now() - interval '2 hours', now() - interval '1 hour');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
       VALUES (t_id, h, md5('driver3')::uuid, now() - interval '1 hour');

  -- (e) The EXCLUDEs must not become a cross-tenant oracle. An exclusion
  -- check bypasses RLS, so a key without tenant_id would answer "is that
  -- driver on that unit then?" for a tenant this session cannot see:
  -- exclusion_violation inside the foreign trip, foreign_key_violation
  -- outside it. Both probes must fail identically, on the FK. The uuids are
  -- hard-coded since the probe cannot see what it probes for, so the
  -- precondition is checked rather than trusted: a quiet seed change would
  -- otherwise leave case (e) discriminating on nothing while still printing
  -- PASS.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO n2 FROM app.trip tr JOIN app.tenant tn ON tn.id = tr.tenant_id
   WHERE tr.id = md5('t2trip1')::uuid
     AND tr.vehicle_id = md5('t2veh1')::uuid
     AND tr.user_id = md5('driver2')::uuid
     AND tr.started_at = ('2026-01-01'::timestamp AT TIME ZONE tn.timezone)
     AND tr.ended_at IS NULL;
  IF n2 <> 1 THEN
    RAISE EXCEPTION 'FAIL 34e: the tenant-2 trip case (e) probes for is absent or moved; the probes below would pass vacuously';
  END IF;
  PERFORM set_config('app.tenant_id', t_id::text, true);

  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
         VALUES (t_id, md5('t2veh1')::uuid, md5('driver2')::uuid, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM '23503' THEN
    RAISE EXCEPTION 'FAIL 34e: a probe inside another tenant''s trip answered % (expected 23503 foreign_key_violation); the EXCLUDE is a cross-tenant oracle', COALESCE(got, 'success');
  END IF;

  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
         VALUES (t_id, md5('t2veh1')::uuid, md5('driver2')::uuid, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE;
  END;
  IF got IS DISTINCT FROM '23503' THEN
    RAISE EXCEPTION 'FAIL 34e: a probe outside another tenant''s trip answered % (expected 23503)', COALESCE(got, 'success');
  END IF;

  RAISE NOTICE 'PASS  platform-admin emails unique; trips overlap neither on a unit nor for a driver, one driver per motive (U143), back to back is accepted, and the EXCLUDEs are not a cross-tenant oracle';
END $$;
ROLLBACK;

\echo '== 35. Email uniqueness is case-folded per tenant (TYRE-95, FR-VEH-008)'
-- 000027: one email comparison rule. A rehire retyped in different case must
-- meet the same index the exact-case duplicate meets, or the INSERT path
-- quietly splits one person into two rows. Folding is per tenant: the same
-- address in another tenant is a different person and must stay insertable.
-- Transaction-scoped: nothing persists.
BEGIN;
DO $$
DECLARE
  t_one constant uuid := '11111111-1111-1111-1111-111111111111';
  t_two constant uuid := '22222222-2222-2222-2222-222222222222';
  ok boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', t_one::text, true);

  -- The seeded address is lowercase; the probe differs only in case.
  BEGIN
    INSERT INTO app.app_user (tenant_id, email, display_name, role)
         VALUES (t_one, 'MELUSI@Example.INVALID', 'Case probe', 'DRIVER');
  EXCEPTION WHEN unique_violation THEN ok := true;
  END;
  IF NOT ok THEN
    RAISE EXCEPTION 'FAIL: a case-variant of an existing email was accepted in the same tenant';
  END IF;

  -- The identical case-variant in ANOTHER tenant is not a collision: the
  -- index folds case, not tenancy.
  PERFORM set_config('app.tenant_id', t_two::text, true);
  INSERT INTO app.app_user (tenant_id, email, display_name, role)
       VALUES (t_two, 'MELUSI@Example.INVALID', 'Case probe two', 'DRIVER');

  RAISE NOTICE 'PASS  email uniqueness folds case within a tenant and nowhere else';
END $$;
ROLLBACK;

\echo '== 36. TYRE-88: history triggers pass legacy rows, refuse edits (TY008/TY009); the NULL-kind backfill path is closed by 000042'
BEGIN;
DO $$
DECLARE cfg uuid; pos uuid; veh uuid := md5('t88veh')::uuid; veh2 uuid := md5('t88veh2')::uuid;
        fit uuid := md5('t88fit')::uuid; t1 uuid := md5('t88tyre1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  SELECT id INTO pos FROM app.position WHERE configuration_id = cfg ORDER BY id LIMIT 1;

  -- A trailer takes an odometer-less fitment (legal, FR-FIT-002 via 000025).
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (veh, '11111111-1111-1111-1111-111111111111', 'T88-1', 'T88 GP', cfg, 'TRAILER', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T88TYRE1', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at)
  VALUES (fit, '11111111-1111-1111-1111-111111111111', t1, veh, pos, now() - interval '30 days');

  -- (a) an odometer-less fitment on a trailer closes without one (FR-FIT-002
  -- binds only units that carry an odometer)
  UPDATE app.fitment SET removed_at = now(), removed_odometer = NULL,
         removed_tread_mm = 9.0, removal_reason = 'WORN'
   WHERE id = fit;
  RAISE NOTICE 'PASS  36a odometer-less fitment on a TRAILER closed without one';

  -- (b) an UPDATE cannot null out a supplied fitted_odometer, proven on a
  -- fitment this section creates, so the probe cannot silently match nothing
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (veh2, '11111111-1111-1111-1111-111111111111', 'T88-2', 'T88B GP', cfg, 'HORSE', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (md5('t88tyre2')::uuid, '11111111-1111-1111-1111-111111111111', 'T88TYRE2', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
  VALUES (md5('t88fit2')::uuid, '11111111-1111-1111-1111-111111111111',
          md5('t88tyre2')::uuid, veh2, pos, now(), 100000);
  BEGIN
    UPDATE app.fitment SET fitted_odometer = NULL WHERE id = md5('t88fit2')::uuid;
    RAISE EXCEPTION 'FAIL: nulling a fitted_odometer was accepted';
  EXCEPTION WHEN sqlstate 'TY009' THEN RAISE NOTICE 'PASS  36b nulling fitted_odometer refused';
  END;

  -- (c) a vehicle repoint does not ride the legacy gate out of TY009
  BEGIN
    UPDATE app.fitment SET vehicle_id = veh2 WHERE id = fit;
    RAISE EXCEPTION 'FAIL: repointing a NULL-odometer fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY009' THEN RAISE NOTICE 'PASS  36c repoint refused';
  END;

  -- (d) known-to-different unit_kind with history raises
  BEGIN
    UPDATE app.vehicle SET unit_kind = 'RIGID' WHERE id = veh;
    RAISE EXCEPTION 'FAIL: unit_kind edit with history was accepted';
  EXCEPTION WHEN sqlstate 'TY008' THEN RAISE NOTICE 'PASS  36d unit_kind edit refused with history';
  END;
END $$;
ROLLBACK;

\echo '== 37. TYRE-87: unique/exclusion keys on tenant tables lead with tenant_id'
BEGIN;
DO $$
DECLARE bad text;
BEGIN
  -- The generalisation of B1's cross-tenant date oracle: a unique or
  -- exclusion check whose key omits tenant_id fires before RLS and before
  -- the composite FK, so its distinguishable error discloses another
  -- tenant's values to a caller who chose the probe value. PKs are excluded
  -- (opaque uuids; and every PK index carries a pg_constraint row the second
  -- arm skips). The allowlist names each deliberate exception and why.
  WITH tenant_tables AS (
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  ),
  keys AS (
    SELECT t.relname AS tbl, con.conname AS keyname,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.attnum = con.conkey[1]) AS first_col
      FROM pg_constraint con JOIN tenant_tables t ON t.oid = con.conrelid
     WHERE con.contype IN ('u','x')
    UNION ALL
    -- Standalone unique indexes with no pg_constraint row, the three-of-seven
    -- blind spot the ticket names. indkey[0] = 0 (an expression) yields NULL
    -- and is treated as an offender unless allowlisted.
    SELECT t.relname, ic.relname,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.attnum = i.indkey[0])
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN tenant_tables t ON t.oid = i.indrelid
     WHERE i.indisunique
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conindid = i.indexrelid)
  )
  SELECT string_agg(tbl || '.' || keyname, ', ') INTO bad
    FROM keys
   WHERE first_col IS DISTINCT FROM 'tenant_id'
     AND keyname NOT IN (
       -- Allowlist. Every entry states its reason; an unexplained entry is a
       -- review defect.
       'app_user_platform_admin_email_key',    -- 000026: PLATFORM_ADMIN rows are tenant-free by design; unreachable by app_rw (PR #29 RLS audit: informational)
       -- TYRE-87 sweep (D9): keys over opaque uuids alone carry no
       -- caller-chosen natural value for a probe to exploit, unlike
       -- vehicle_driver_no_overlap's uuid-pair-plus-daterange shape, which
       -- was re-keyed in 000026 because a date IS such a value.
       'reading_inspection_id_position_id_vehicle_id_key',  -- 000001: (inspection_id, position_id, vehicle_id) is three opaque uuids; none is a value a caller chooses to probe
       'one_open_fitment_per_position',  -- 000001: (position_id, vehicle_id) is two opaque uuids
       'one_open_fitment_per_tyre'       -- 000001: tyre_id alone is one opaque uuid
       -- exception.one_open_exception_per_subject is NOT here: it paired two
       -- opaque uuids with subject_type, a caller-chosen natural value. That
       -- is the vehicle_driver_no_overlap shape, not this arm's, so 000029
       -- re-keyed it tenant-first instead of allowlisting it.
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: unique/exclusion keys not led by tenant_id: %', bad;
  END IF;
  -- Second arm (TYRE-158): a table WITHOUT a tenant_id column is outside the
  -- sweep above by construction, yet its unique keys are global by the same
  -- construction.
  -- Such a key is safe only when the app role cannot write the table at all.
  -- A probe needs a write to read the outcome. Every table here states why
  -- it has no tenant column; an unexplained entry is a review defect.
  SELECT string_agg(c.relname || ':' || priv, ', ') INTO bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) p(priv)
   WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND NOT i.indisprimary)
     -- current_user and any column, for check 4's two reasons.
     AND has_any_column_privilege(current_user, c.oid, priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 37: the app role can write a tenant-free table with a global unique key: %', bad;
  END IF;
  RAISE NOTICE 'PASS  37a every tenant-table unique/exclusion key leads with tenant_id or is allowlisted';
  RAISE NOTICE 'PASS  37b no tenant-free table with a global unique key is writable by the app role (tenant: it is the tenant; jurisdiction_tread_minimum: platform reference data, 000012; platform_tyre_size, platform_tyre_brand, platform_tyre_pattern: the platform catalogue, 000058)';
END $$;
ROLLBACK;

\echo '== 38. D12/D13 schema and the TYRE-48 event vocabulary (CHG-023/CHG-037, FR-TYR-004 as amended)'
BEGIN;
DO $$
DECLARE t1 uuid := md5('t48tyre')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T48TYRE', 'NEW', 'IN_STOCK');

  -- The vocabulary is closed
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'REBALANCED', now(), 'IN_STOCK');
    RAISE EXCEPTION 'FAIL: an off-vocabulary event type was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38a vocabulary is closed';
  END;

  -- A state-changing event must say what state it produced, or
  -- app.tyre_in_estate_asof (000016) cannot see it
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SCRAPPED', now());
    RAISE EXCEPTION 'FAIL: a SCRAPPED event with no to_state was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38b state changes carry to_state';
  END;

  -- Only a sale carries proceeds, and a sale must (CHG-037, FR-FIT-023)
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, from_state, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SOLD', now(), 'REMOVED', 'SOLD');
    RAISE EXCEPTION 'FAIL: a SOLD event with no proceeds was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38c a sale records proceeds';
  END;

  -- D12: policies are seeded as decided. BAC and Sandbox generate, and a
  -- FREE tenant exists so both branches stay provable (tenant 2)
  IF (SELECT display_code_policy FROM app.tenant
       WHERE id = '11111111-1111-1111-1111-111111111111') <> 'GENERATED' THEN
    RAISE EXCEPTION 'FAIL: BAC is not GENERATED (D12)';
  END IF;
  RAISE NOTICE 'PASS  38d display_code_policy seeded per D12';

  -- D13: the column exists, defaulted UNKNOWN, and is not yet load-bearing
  IF (SELECT count(*) FROM app.fitment WHERE mount_orientation <> 'UNKNOWN') <> 0 THEN
    RAISE EXCEPTION 'FAIL: mount_orientation carries a value nothing has written';
  END IF;
  RAISE NOTICE 'PASS  38e mount_orientation defaults UNKNOWN (D13)';
END $$;
ROLLBACK;

\echo '== 39. Tyre lifecycle: receive, cost, dispose, dated lookup (TYRE-48/91, FR-TYR-040..043, D12)'
BEGIN;
DO $$
DECLARE r record; a uuid; b uuid; c uuid; d uuid; e uuid; n int; rate numeric;
        stored_price numeric; stored_rate numeric; tcost uuid; tgone uuid;
        -- What app.receive_tyres requires a receive to name (FR-TYR-031):
        -- BAC's seeded entries, and a size and pattern Second Fleet is given
        -- below.
        cat1 jsonb := jsonb_build_object('size_id', md5('sz1')::uuid,
                                         'pattern_id', md5('pt1')::uuid, 'new_tread_mm', '25.0');
        cat2 jsonb := jsonb_build_object('size_id', md5('t39t2sz')::uuid,
                                         'pattern_id', md5('t39t2pt')::uuid, 'new_tread_mm', '25.0');
BEGIN
  -- BAC is GENERATED (D12): a hand-typed code is refused, an issued one is
  -- sequential from the counter
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    PERFORM app.receive_tyres(cat1 || '{"display_code":"HAND-1"}'::jsonb);
    RAISE EXCEPTION 'FAIL: hand-typed code accepted under GENERATED';
  EXCEPTION WHEN sqlstate 'TY011' THEN
    -- The catalogue refusals are TY011 too (FR-TYR-031), so the message
    -- pins which one fired.
    IF SQLERRM <> 'this fleet''s display codes are issued by the platform; leave the code blank and the next one is assigned' THEN
      RAISE EXCEPTION 'FAIL 39a: TY011 fired for another reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  39a hand-typed code refused (D12)';
  END;

  -- received_date is pinned to the past, not tenant_today(): near a UTC day
  -- boundary tenant_today() can land ahead of now(), which would let a later
  -- disposal stamped at now() sort before this receipt.
  SELECT * INTO r FROM app.receive_tyres(cat1 || '{"new_tread_mm":"25.0","received_date":"2026-08-25"}'::jsonb);
  a := r.tyre_id;
  IF r.display_code !~ '^BAC-\d{5}$' THEN
    RAISE EXCEPTION 'FAIL: issued code % is not the ADR-0008 scheme', r.display_code;
  END IF;
  RAISE NOTICE 'PASS  39b generated code issued: %', r.display_code;

  -- Unpriced receipt sits in the awaiting-cost queue (FR-TYR-041) with no
  -- invented rate; costing it computes rand_per_mm through the one permitted
  -- implementation (rule: check 7 pins the arithmetic, this pins the wiring)
  SELECT count(*) INTO n FROM app.v_tyre_awaiting_cost WHERE tyre_id = a;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: unpriced tyre not in awaiting-cost queue'; END IF;
  -- A received tyre is priced on its receipt (000059), so set_tyre_cost's
  -- own path is costed on a tyre planted with no receipt.
  BEGIN
    PERFORM app.set_tyre_cost(a, 4319.91, 'INVOICE');
    RAISE EXCEPTION 'FAIL 39c: a received tyre was costed one by one';
  EXCEPTION WHEN sqlstate 'TY013' THEN
    IF SQLERRM <> 'this tyre was received on a receipt, so its price is recorded on the receipt for the whole set; open the receipt to record it' THEN
      RAISE EXCEPTION 'FAIL 39c: TY013 fired for another reason: %', SQLERRM;
    END IF;
  END;
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T39-COST', md5('sz1')::uuid, md5('br1')::uuid, md5('pt1')::uuid,
          'NEW', 0, 25.0, 'IN_STOCK', '2026-08-25')
  RETURNING id INTO tcost;
  PERFORM app.set_tyre_cost(tcost, 4319.91, 'INVOICE');
  SELECT rand_per_mm INTO rate FROM app.tyre WHERE id = tcost;
  IF rate IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, app.current_removal_threshold_mm()) THEN
    RAISE EXCEPTION 'FAIL: costing did not recompute rand_per_mm through app.rand_per_mm';
  END IF;
  RAISE NOTICE 'PASS  39c a received tyre is sent to its receipt, and a tyre with none is costed with its rate recomputed: %', rate;
  BEGIN
    PERFORM app.set_tyre_cost(tcost, 1.00, 'INVOICE');
    RAISE EXCEPTION 'FAIL: a second costing was accepted';
  EXCEPTION WHEN sqlstate 'TY013' THEN RAISE NOTICE 'PASS  39d re-pricing refused';
  END;

  -- Bulk issue is sequential and atomic
  SELECT count(DISTINCT display_code) INTO n FROM app.receive_tyres(cat1 || '{"quantity":3}'::jsonb);
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL: bulk receive issued % codes, expected 3', n; END IF;
  RAISE NOTICE 'PASS  39e bulk receive issues distinct sequential codes';

  -- Disposal transitions (Appendix C): SOLD from REMOVED only; a scrap
  -- carries its reason; a sale its proceeds; events append with to_state so
  -- app.tyre_in_estate_asof sees them
  BEGIN
    PERFORM app.dispose_tyre(a, 'SOLD', NULL, 100.00, now());
    RAISE EXCEPTION 'FAIL: sale from IN_STOCK accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39f REMOVED→SOLD only';
  END;
  BEGIN
    PERFORM app.dispose_tyre(a, 'SCRAPPED', NULL, NULL, now());
    RAISE EXCEPTION 'FAIL: scrap without reason accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39g a scrap records its reason';
  END;
  PERFORM app.dispose_tyre(a, 'SCRAPPED', 'sidewall breach', NULL, now());
  IF (SELECT state FROM app.tyre WHERE id = a) <> 'SCRAPPED'
     OR NOT EXISTS (SELECT 1 FROM app.tyre_event
                     WHERE tyre_id = a AND type = 'SCRAPPED' AND to_state = 'SCRAPPED') THEN
    RAISE EXCEPTION 'FAIL: scrap did not move state and event together';
  END IF;
  IF app.tyre_in_estate_asof(a, current_date + 1) THEN
    RAISE EXCEPTION 'FAIL: a scrapped tyre is still in the estate as-of tomorrow';
  END IF;
  RAISE NOTICE 'PASS  39h disposal appends the event, moves the state, leaves the estate';

  -- FREE tenant (2): the code is the tenant''s own, required, and reusable
  -- across history with the dated lookup resolving by date (FR-TYR-042)
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  -- Second Fleet seeds no catalogue, so the receives below get their own.
  INSERT INTO app.tyre_size (id, tenant_id, name)
  VALUES (md5('t39t2sz')::uuid, '22222222-2222-2222-2222-222222222222', '315/80R22.5');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to)
  VALUES (md5('t39t2pt')::uuid, '22222222-2222-2222-2222-222222222222', 'T39 NEW', 'NEW');
  BEGIN
    PERFORM app.receive_tyres(cat2);
    RAISE EXCEPTION 'FAIL: FREE receive without a code accepted';
  EXCEPTION WHEN sqlstate 'TY011' THEN
    IF SQLERRM <> 'this fleet brands its own tyres; enter the code branded on the sidewall' THEN
      RAISE EXCEPTION 'FAIL 39i: TY011 fired for another reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  39i FREE requires the tenant''s code';
  END;
  SELECT tyre_id INTO b FROM app.receive_tyres(cat2 || '{"display_code":"CA123-11","received_date":"2026-01-10"}'::jsonb);
  BEGIN
    PERFORM app.receive_tyres(cat2 || '{"display_code":"CA123-11"}'::jsonb);
    RAISE EXCEPTION 'FAIL: second active tyre with the same code accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS  39j duplicate active code refused by the DB';
  END;
  PERFORM app.dispose_tyre(b, 'SCRAPPED', 'worn out', NULL, '2026-06-01T08:00:00Z');
  SELECT tyre_id INTO c FROM app.receive_tyres(cat2 || '{"display_code":"CA123-11","received_date":"2026-06-15"}'::jsonb);
  IF (SELECT app.tyre_for_code('CA123-11', '2026-03-01')) IS DISTINCT FROM b
     OR (SELECT app.tyre_for_code('CA123-11', '2026-07-01')) IS DISTINCT FROM c THEN
    RAISE EXCEPTION 'FAIL: dated code lookup did not resolve historical reuse';
  END IF;
  RAISE NOTICE 'PASS  39k code lookup resolves by date across reuse';

  -- Cross-tenant: tenant 2 disposing tenant 1''s tyre finds nothing to
  -- dispose; RLS makes another tenant's uuid indistinguishable from a
  -- missing one. tyre1 is seeded FITTED, an invalid LOST source state on
  -- its own terms too, so a bare TY012 could mean either RLS hid the row
  -- or leaked it and the state check caught it (TYRE-91). The message text
  -- pins which.
  BEGIN
    PERFORM app.dispose_tyre(md5('tyre1')::uuid, 'LOST', NULL, NULL, now());
    RAISE EXCEPTION 'FAIL: cross-tenant disposal was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such tyre in this fleet' THEN
      RAISE EXCEPTION 'FAIL: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  39l cross-tenant tyre invisible to disposal';
  END;

  -- A second, independent probe: tyre1's cost is already set (seeded), so a
  -- leaked row would raise TY013 (already-priced) from a different function,
  -- never TY012 (TYRE-91).
  BEGIN
    PERFORM app.set_tyre_cost(md5('tyre1')::uuid, 1.00, 'INVOICE');
    RAISE EXCEPTION 'FAIL: cross-tenant cost entry was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39m cross-tenant tyre invisible to costing';
  END;

  -- FR-VAL-006: the two writers of rand_per_mm agree to the cent only if
  -- each rounds the price into its column before dividing. Pinned at 3dp
  -- deliberately: a 2dp price cannot fail this.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'RATE-3DP', md5('t39t2sz')::uuid, NULL, md5('t39t2pt')::uuid,
          'NEW', 0, 25.0, 'IN_STOCK', '2026-01-05')
  RETURNING id INTO d;
  PERFORM app.set_tyre_cost(d, 4319.915, 'INVOICE');
  SELECT purchase_price, rand_per_mm INTO stored_price, stored_rate
    FROM app.tyre WHERE id = d;
  IF stored_rate IS DISTINCT FROM
     app.rand_per_mm(stored_price, 25.0, app.current_removal_threshold_mm()) THEN
    RAISE EXCEPTION 'FAIL: set_tyre_cost stored a rate (%) not reproducible from its own stored price (%)',
      stored_rate, stored_price;
  END IF;
  RAISE NOTICE 'PASS  39n cost-path rate reproducible from the stored price: %', stored_rate;

  -- A receive dated in the future would stamp its RECEIVED event after every
  -- later event, and app.tyre_in_estate_asof reads the LATEST to_state, so a
  -- tyre disposed afterwards would sit in the valuation estate for good
  -- (FR-VAL-022). Refused outright.
  BEGIN
    PERFORM app.receive_tyres(
      cat2 || format('{"display_code":"FUTURE-1","received_date":"%s"}', current_date + 30)::jsonb);
    RAISE EXCEPTION 'FAIL: a receive dated in the future was accepted';
  EXCEPTION WHEN sqlstate 'TY011' THEN
    IF SQLERRM <> 'a tyre is received on or before today, never on a future date' THEN
      RAISE EXCEPTION 'FAIL 39o: TY011 fired for the wrong reason (%)', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  39o a future received_date is refused';
  END;

  -- The clamp behind 39o's refusal: today's date cast to timestamptz is
  -- still ahead of now() for a tenant east of UTC, so the stamp is
  -- least(date, now()) and never outruns a disposal moments later. This
  -- check only discriminates part of the day; a deterministic version needs
  -- an injected clock, not worth the seam.
  SELECT tyre_id INTO e FROM app.receive_tyres(cat2 || '{"display_code":"CLAMP-1"}'::jsonb);
  PERFORM app.dispose_tyre(e, 'SCRAPPED', 'audit', NULL, now());
  IF app.tyre_in_estate_asof(e, current_date + 365) THEN
    RAISE EXCEPTION 'FAIL: a disposed tyre is back in the estate, its receipt outranks its disposal';
  END IF;
  RAISE NOTICE 'PASS  39p a same-day receipt never outranks a later disposal';

  -- Costing recomputes rand_per_mm, so a tyre that has left the estate must
  -- not be re-rated behind valuations already taken against it. Extends D5,
  -- which specified no state guard. The tyre is planted with no receipt,
  -- because a received one is refused first for its receipt (000059), and
  -- the message pins the state guard.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T39-GONE', md5('t39t2sz')::uuid, NULL, md5('t39t2pt')::uuid,
          'NEW', 0, 25.0, 'IN_STOCK', '2026-01-05')
  RETURNING id INTO tgone;
  PERFORM app.dispose_tyre(tgone, 'SCRAPPED', 'audit', NULL, now());
  BEGIN
    PERFORM app.set_tyre_cost(tgone, 500.00, 'INVOICE');
    RAISE EXCEPTION 'FAIL: a scrapped tyre was costed';
  EXCEPTION WHEN sqlstate 'TY013' THEN
    IF SQLERRM <> 'this tyre is SCRAPPED and has left the fleet; its cost cannot be recorded now' THEN
      RAISE EXCEPTION 'FAIL 39q: TY013 fired for another reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  39q a disposed tyre cannot be costed';
  END;

  -- A FITTED tyre is unpriced-but-in-service: still in v_tyre_awaiting_cost
  -- (CFL-002) and still costable. This is the check that keeps 39q's guard
  -- from being written as "not IN_STOCK".
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'FITGUARD-1', md5('t39t2sz')::uuid, NULL, md5('t39t2pt')::uuid,
          'NEW', 0, 20.0, 'IN_STOCK', '2026-01-05')
  RETURNING id INTO d;
  UPDATE app.tyre SET state = 'FITTED' WHERE id = d;
  PERFORM app.set_tyre_cost(d, 900.00, 'INVOICE');
  RAISE NOTICE 'PASS  39r a fitted tyre is still costable';

  -- The disposal side of the same ordering invariant 39p guards on receipt.
  SELECT tyre_id INTO d FROM app.receive_tyres(
    cat2 || '{"display_code":"BACKDATE-1","received_date":"2026-02-01"}'::jsonb);
  BEGIN
    PERFORM app.dispose_tyre(d, 'SCRAPPED', 'audit', NULL, now() + interval '1 day');
    RAISE EXCEPTION 'FAIL: a disposal dated in the future was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  39s a future disposal is refused';
  END;
  BEGIN
    PERFORM app.dispose_tyre(d, 'SCRAPPED', 'audit', NULL, '2026-01-01T00:00:00Z');
    RAISE EXCEPTION 'FAIL: a disposal predating the receipt was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  39t a disposal cannot predate the tyre''s last movement';
  END;
END $$;
ROLLBACK;

\echo '== 40. TYRE-92: a fitment is written once and closed once (TY014); the vocabulary carries the breakdown dispatch'
BEGIN;
DO $$
DECLARE cfg uuid; pos uuid; pos2 uuid; veh uuid := md5('t40veh')::uuid;
        t1 uuid := md5('t40tyre1')::uuid; fit uuid := md5('t40fit')::uuid; n int; tid text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  SELECT id INTO pos  FROM app.position WHERE configuration_id = cfg ORDER BY sequence LIMIT 1;
  SELECT id INTO pos2 FROM app.position WHERE configuration_id = cfg ORDER BY sequence OFFSET 1 LIMIT 1;
  -- TRAILER, deliberately: require_odometer_where_unit_has_one (000025:31-33)
  -- short-circuits on a TRAILER, so 40c/40d reach TY014 rather than TY009.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (veh, '11111111-1111-1111-1111-111111111111', 'T40-1', 'T40 GP', cfg, 'TRAILER', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T40TYRE1', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at, mount_orientation)
  VALUES (fit, '11111111-1111-1111-1111-111111111111', t1, veh, pos, now() - interval '10 days', 'MARK_OUTBOARD');

  -- (a) an identity column cannot change on an open fitment
  BEGIN
    UPDATE app.fitment SET position_id = pos2 WHERE id = fit;
    RAISE EXCEPTION 'FAIL: repositioning an open fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40a open fitment identity is immutable';
  END;
  -- (b) nor can the orientation (a flip is a remove-and-fit, D13)
  BEGIN
    UPDATE app.fitment SET mount_orientation = 'MARK_INBOARD' WHERE id = fit;
    RAISE EXCEPTION 'FAIL: flipping an open fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40b mount_orientation is immutable';
  END;
  -- (g) nor the row's own primary key
  BEGIN
    UPDATE app.fitment SET id = gen_random_uuid() WHERE id = fit;
    RAISE EXCEPTION 'FAIL: changing an open fitment''s id was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40g the fitment id is immutable';
  END;
  -- (h), (i) The closure columns, on a row not being closed.
  -- removal_is_complete (000001, narrowed by 000011) ties removed_at to
  -- removal_reason only, so a removal tread, distance or provenance could
  -- otherwise land on a still-open fitment and be read as fact downstream
  -- (FR-FIT-014). Split in two: a guard covering only the tread would leave
  -- (i) passing.
  BEGIN
    UPDATE app.fitment SET removed_tread_mm = 7.0 WHERE id = fit;
    RAISE EXCEPTION 'FAIL: a removal tread was written to an open fitment';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    RAISE NOTICE 'PASS  40h an open fitment takes no removal tread';
  END;
  BEGIN
    UPDATE app.fitment SET distance_km = 1000, distance_source = 'MEASURED' WHERE id = fit;
    RAISE EXCEPTION 'FAIL: a distance was written to an open fitment';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    RAISE NOTICE 'PASS  40i an open fitment takes no distance';
  END;
  -- (c) closure is the one permitted UPDATE, and it stamps updated_at
  UPDATE app.fitment SET removed_at = now(), removed_tread_mm = 9.0, removal_reason = 'damage',
         distance_source = 'UNAVAILABLE' WHERE id = fit;
  SELECT count(*) INTO n FROM app.fitment WHERE id = fit AND removed_at IS NOT NULL AND updated_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: closure did not land'; END IF;
  RAISE NOTICE 'PASS  40c closure is permitted';
  -- (d) a closed fitment is frozen entirely, even its closure columns
  BEGIN
    UPDATE app.fitment SET removal_reason = 'worn_to_threshold' WHERE id = fit;
    RAISE EXCEPTION 'FAIL: editing a closed fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40d closed fitment is frozen';
  END;
  -- (e) the vocabulary accepts the breakdown dispatch and still refuses a stranger
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
  VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SENT_TO_BREAKDOWN_SUPPLIER', now(), 'AT_BREAKDOWN_SUPPLIER');
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'REBALANCED', now(), 'FITTED');
    RAISE EXCEPTION 'FAIL: REBALANCED accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  40e vocabulary gained exactly the breakdown dispatch';
  END;
  -- (f) every seeded tenant carries removal_reasons with the FR-FIT-008
  -- minimum. Looped per-tenant, not a single count under tenant 1: app.
  -- configuration is RLS-scoped, so one tenant's count cannot see another
  -- tenant's seed gap.
  FOREACH tid IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111',
                             '22222222-2222-2222-2222-222222222222',
                             '33333333-3333-3333-3333-333333333333'] LOOP
    PERFORM set_config('app.tenant_id', tid, true);
    SELECT count(*) INTO n FROM app.configuration
     WHERE key = 'removal_reasons' AND value ? 'worn_to_threshold' AND value ? 'rotation' AND value ? 'correction';
    IF n < 1 THEN RAISE EXCEPTION 'FAIL: removal_reasons not seeded for tenant %', tid; END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  RAISE NOTICE 'PASS  40f removal_reasons is tenant configuration';
END $$;
ROLLBACK;

\echo '== 41. TYRE-92: fit, remove, rotate, dispatch and return (FR-FIT-001..016, D2)'
BEGIN;
DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  t_two uuid := '22222222-2222-2222-2222-222222222222';
  cfg uuid; cfg2 uuid; tz text;
  -- Both units sit on veh1's configuration, so they share every position id
  -- (position ids repeat across units of one axle configuration), which is
  -- why 41e reaches for a position on ANOTHER configuration. The seed fills
  -- every position on veh1-veh3, so this section plants its own empty units.
  vh uuid := md5('t41h')::uuid;   -- HORSE: TY009 requires a fitment odometer
  vt uuid := md5('t41t')::uuid;   -- TRAILER: has no odometer to give
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p7 uuid; p9 uuid; p10 uuid; px uuid;
  d_rt uuid := md5('t41rt')::uuid;  d_bd uuid := md5('t41bd')::uuid;
  sz1  uuid := md5('sz1')::uuid;    sz2  uuid := md5('t41sz2')::uuid;
  ty1  uuid := md5('t41ty1')::uuid;  ty2  uuid := md5('t41ty2')::uuid;
  ty3  uuid := md5('t41ty3')::uuid;  ty4  uuid := md5('t41ty4')::uuid;
  ty5  uuid := md5('t41ty5')::uuid;  ty6  uuid := md5('t41ty6')::uuid;
  ty7  uuid := md5('t41ty7')::uuid;  ty8  uuid := md5('t41ty8')::uuid;
  tyr  uuid := md5('t41tyr')::uuid;  tys  uuid := md5('t41tys')::uuid;
  tyd1 uuid := md5('t41tyd1')::uuid; tyd2 uuid := md5('t41tyd2')::uuid;
  tyc  uuid := md5('t41tyc')::uuid;
  r record; fit1 uuid; fit3 uuid; fit4 uuid; fitd1 uuid; fitd2 uuid;
  n int; cname text; job uuid;
  ty9 uuid := md5('t41ty9')::uuid;  -- I1: raw-inserted fitments (41u/41v/41w)
  fitu uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  cfg2 := md5(bac::text || 'TRAILER_2AXLE')::uuid;
  SELECT p.id INTO p1  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  SELECT p.id INTO p2  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '2';
  SELECT p.id INTO p3  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  SELECT p.id INTO p4  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '4';
  SELECT p.id INTO p7  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '7';
  SELECT p.id INTO p9  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '9';
  SELECT p.id INTO p10 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '10';
  SELECT p.id INTO px  FROM app.position p WHERE p.configuration_id = cfg2 ORDER BY p.sequence LIMIT 1;
  IF px IS NULL OR p10 IS NULL OR p1 IS NULL THEN
    RAISE EXCEPTION 'FAIL: section 41 cannot resolve the positions it tests against';
  END IF;

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (vh, bac, 'T41-H', 'T41H GP', cfg, 'HORSE',   md5('depot1')::uuid, 'ACTIVE'),
         (vt, bac, 'T41-T', 'T41T GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  -- BAC seeds one depot and one tyre size, so the retreader, the breakdown
  -- supplier and the second size that FR-FIT-005/013 need are planted here.
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES
    (d_rt, bac, 'T41 Retreaders', 'RETREADER'),
    (d_bd, bac, 'T41 Roadside',   'BREAKDOWN_SUPPLIER');
  INSERT INTO app.tyre_size (id, tenant_id, name, construction)
  VALUES (sz2, bac, '295/80R22.5', 'RADIAL');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (ty1,  bac, 'T41TYRE1',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty2,  bac, 'T41TYRE2',  sz1, 'NEW',     0, 'REMOVED'),
    (ty3,  bac, 'T41TYRE3',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty4,  bac, 'T41TYRE4',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty5,  bac, 'T41TYRE5',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty6,  bac, 'T41TYRE6',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty7,  bac, 'T41TYRE7',  sz1, 'NEW',     0, 'IN_STOCK'),
    (ty8,  bac, 'T41TYRE8',  sz1, 'NEW',     0, 'IN_STOCK'),
    (tyr,  bac, 'T41TYRER',  sz1, 'RETREAD', 1, 'IN_STOCK'),
    (tys,  bac, 'T41TYRES',  sz2, 'NEW',     0, 'IN_STOCK'),
    (tyd1, bac, 'T41TYRED1', sz1, 'NEW',     0, 'IN_STOCK'),
    (tyd2, bac, 'T41TYRED2', sz1, 'NEW',     0, 'IN_STOCK'),
    (tyc,  bac, 'T41TYREC',  sz1, 'RETREAD', 1, 'REMOVED'),
    (ty9,  bac, 'T41TYRE9',  sz1, 'NEW',     0, 'IN_STOCK');

  -- (a) A clean fit off the trailer: no odometer is owed, nothing else sits
  -- on axle 3 and the tyre is NEW, so the warning array has to be empty
  -- rather than merely unasserted (FR-FIT-001, U8, U10, D13).
  SELECT * INTO r FROM app.fit_tyre(ty1, vt, p10, 14.0, 'MARK_OUTBOARD');
  fit1 := r.fitment_id;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.id = fit1 AND f.tyre_id = ty1 AND f.vehicle_id = vt AND f.position_id = p10
     AND f.removed_at IS NULL AND f.fitted_tread_mm = 14.0
     AND f.mount_orientation = 'MARK_OUTBOARD';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41a: the fitment row is not the one asked for'; END IF;
  IF r.warnings IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 41a: a clean fit returned warnings %', r.warnings;
  END IF;
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty1) IS DISTINCT FROM 'FITTED'
     OR (SELECT t.last_tread_mm FROM app.tyre t WHERE t.id = ty1) IS DISTINCT FROM 14.0
     OR (SELECT t.last_tread_at FROM app.tyre t WHERE t.id = ty1) IS NULL THEN
    RAISE EXCEPTION 'FAIL 41a: the tyre did not move to FITTED carrying its tread';
  END IF;
  -- A fitted casing is on a unit, not in a depot's stock count.
  IF (SELECT t.current_depot_id FROM app.tyre t WHERE t.id = ty1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 41a: a fitted tyre is still counted at a depot';
  END IF;
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.tyre_id = ty1 AND e.type = 'FITTED' AND e.to_state = 'FITTED'
     AND e.payload->>'fitment_id' = fit1::text AND e.payload->>'position_code' = '10'
     AND e.payload->>'vehicle_id' = vt::text;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41a: the FITTED event did not land exactly once'; END IF;
  RAISE NOTICE 'PASS  41a fit from stock writes fitment, state, event and tread together';

  -- (b) D14: a busy tyre is refused by name and location, so the driver knows
  -- which unit to go to rather than only that the fit failed.
  BEGIN
    PERFORM app.fit_tyre(ty1, vt, p9, 14.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 41b: a fitted tyre was fitted a second time';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM NOT LIKE '%FITTED%' OR SQLERRM NOT LIKE '%position 10%' THEN
      RAISE EXCEPTION 'FAIL 41b: the refusal does not name the current location: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41b a fitted tyre is refused, naming its current location';
  END;

  -- (c) U1: a REMOVED tyre comes back to stock as an explicit action, never
  -- implicitly inside a fit (FR-FIT-003).
  BEGIN
    PERFORM app.fit_tyre(ty2, vt, p9, 14.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 41c: a REMOVED tyre was fitted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM NOT LIKE '%REMOVED%' THEN
      RAISE EXCEPTION 'FAIL 41c: the refusal does not name the state: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41c a fit is from IN_STOCK only, naming the state that refused it';
  END;

  -- (d) Occupancy is the database's rule, not the function's (FR-FIT-004):
  -- both probes go in raw, past app.fit_tyre. A different tyre onto the
  -- occupied position can only trip the position index; the fitted tyre onto
  -- an empty one can only trip the tyre index.
  BEGIN
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_tread_mm)
    VALUES (bac, ty6, vt, p10, now(), 12.0);
    RAISE EXCEPTION 'FAIL 41d: a second tyre was accepted on an occupied position';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'one_open_fitment_per_position' THEN
      RAISE EXCEPTION 'FAIL 41d: refused by %, not the position index', cname;
    END IF;
  END;
  BEGIN
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_tread_mm)
    VALUES (bac, ty1, vt, p9, now(), 12.0);
    RAISE EXCEPTION 'FAIL 41d: a fitted tyre was accepted on a second position';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'one_open_fitment_per_tyre' THEN
      RAISE EXCEPTION 'FAIL 41d: refused by %, not the tyre index', cname;
    END IF;
  END;
  RAISE NOTICE 'PASS  41d double occupancy and a second open fitment are refused by the DB';

  -- (e) The composite FK accepts any position of this tenant, so only an
  -- explicit (position, configuration) check catches one belonging to a
  -- different configuration (lesson 2026-08-26: position ids repeat across
  -- units of the same axle configuration).
  BEGIN
    PERFORM app.fit_tyre(ty6, vt, px, 14.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 41e: a position from another configuration was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM <> 'no such position on this unit' THEN
      RAISE EXCEPTION 'FAIL 41e: wrong TY014 message: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41e a position off this unit''s configuration is refused';
  END;

  -- (f) FR-FIT-002: the odometer rule stays in the trigger (000025). The
  -- function passes the value through, so TY009 arrives through the function
  -- rather than being restated inside it.
  BEGIN
    PERFORM app.fit_tyre(ty6, vh, p7, 14.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 41f: a horse fitment with no odometer was accepted';
  EXCEPTION WHEN sqlstate 'TY009' THEN
    RAISE NOTICE 'PASS  41f the unit-kind odometer rule reaches through the function';
  END;

  -- (g) All three warnings warn and none blocks (FR-FIT-005/006/020, U11).
  -- p1/p2 are the STEER pair where the seeded policy sets
  -- retreads_permitted = false; p3/p4 are planted MARK_INBOARD so 41l's
  -- carry-over assertion fails if orientation defaults instead.
  SELECT * INTO r FROM app.fit_tyre(tyr, vh, p1, 12.0, 'MARK_OUTBOARD', 400000);
  IF NOT (r.warnings @> '[{"code":"RETREAD_ON_NON_PERMITTED_AXLE"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 41g: a retread on a non-permitted axle did not warn: %', r.warnings;
  END IF;
  SELECT * INTO r FROM app.fit_tyre(tys, vh, p2, 12.0, 'MARK_OUTBOARD', 400000);
  IF NOT (r.warnings @> '[{"code":"SIZE_DIFFERS_ON_AXLE"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 41g: two sizes on one axle did not warn: %', r.warnings;
  END IF;
  SELECT * INTO r FROM app.fit_tyre(tyd1, vh, p3, 12.0, 'MARK_INBOARD', 400000);
  fitd1 := r.fitment_id;
  IF r.warnings IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 41g: the outer half of an empty dual warned: %', r.warnings;
  END IF;
  SELECT * INTO r FROM app.fit_tyre(tyd2, vh, p4, 8.0, 'MARK_INBOARD', 400000);
  fitd2 := r.fitment_id;
  IF NOT (r.warnings @> '[{"code":"DUAL_MATE_TREAD_GAP"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 41g: a 4mm dual gap under a 3mm threshold did not warn: %', r.warnings;
  END IF;
  SELECT count(*) INTO n FROM app.fitment f WHERE f.vehicle_id = vh AND f.removed_at IS NULL;
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL 41g: a warning blocked a fit; % open rows, expected 4', n; END IF;
  RAISE NOTICE 'PASS  41g size, retread-axle and dual-mate warn without blocking';

  -- (h) Removal validates its reason against tenant configuration (D1,
  -- FR-FIT-008, rule 5) and writes distance provenance rather than letting
  -- the column default stand in for it (FR-FIT-009, CR-012).
  SELECT * INTO r FROM app.fit_tyre(ty3, vh, p7, 20.0, 'MARK_OUTBOARD', 400000);
  fit3 := r.fitment_id;
  BEGIN
    PERFORM app.remove_tyre(fit3, 'wrong_reason', 9.0, 410000);
    RAISE EXCEPTION 'FAIL 41h: a reason outside the tenant''s list was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN NULL;
  END;
  PERFORM app.remove_tyre(fit3, 'damage', 9.0, 410000);
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.id = fit3 AND f.removed_at IS NOT NULL AND f.removal_reason = 'damage'
     AND f.removed_tread_mm = 9.0 AND f.distance_source = 'MEASURED' AND f.distance_km = 10000;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41h: the closure did not carry MEASURED provenance'; END IF;
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty3) <> 'REMOVED'
     OR (SELECT t.current_depot_id FROM app.tyre t WHERE t.id = ty3)
        IS DISTINCT FROM (SELECT v.home_depot_id FROM app.vehicle v WHERE v.id = vh) THEN
    RAISE EXCEPTION 'FAIL 41h: a removed tyre did not come to rest at its unit''s home depot';
  END IF;
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.tyre_id = ty3 AND e.type = 'REMOVED' AND e.to_state = 'REMOVED' AND e.reason = 'damage';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41h: the REMOVED event did not land once with its reason'; END IF;
  BEGIN
    PERFORM app.remove_tyre(fit3, 'damage', 9.0, 411000);
    RAISE EXCEPTION 'FAIL 41h: a closed fitment was removed a second time';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  41h removal validates its reason, measures its distance, closes once';
  END;

  -- (i) CR-012: an absent odometer is recorded as absent. The failure this
  -- catches is a NULL distance beside a MEASURED label, which reads
  -- downstream as a measured zero (FR-FIT-009).
  PERFORM app.remove_tyre(fit1, 'irregular_wear', 11.0);
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.id = fit1 AND f.distance_source = 'UNAVAILABLE' AND f.distance_km IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41i: an odometer-less removal did not label its provenance'; END IF;
  RAISE NOTICE 'PASS  41i an odometer-less removal is UNAVAILABLE, not silently NULL';

  -- (j) FR-FIT-009: a distance cannot run backwards. The bound is a function
  -- rule so the refusal is trappable as TY014 instead of a raw 23514 the
  -- client cannot act on.
  SELECT * INTO r FROM app.fit_tyre(ty4, vh, p9, 18.0, 'MARK_OUTBOARD', 400000,
                                    now() - interval '30 days',
                                    'fitment backfilled from the paper sheet');
  fit4 := r.fitment_id;
  BEGIN
    PERFORM app.remove_tyre(fit4, 'damage', 9.0, 399000);
    RAISE EXCEPTION 'FAIL 41j: a removal odometer below the fitment odometer was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    RAISE NOTICE 'PASS  41j a distance cannot run backwards';
  END;

  -- (k) FR-FIT-016: an instant never predates the tyre's own history, and a
  -- backdate of more than a day is a claim someone has to stand behind.
  BEGIN
    PERFORM app.remove_tyre(fit4, 'damage', 9.0, 405000, now() - interval '40 days');
    RAISE EXCEPTION 'FAIL 41k: a removal predating the fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN NULL;
  END;
  BEGIN
    PERFORM app.remove_tyre(fit4, 'damage', 9.0, 405000, now() - interval '25 hours');
    RAISE EXCEPTION 'FAIL 41k: an unjustified backdate was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN NULL;
  END;
  PERFORM app.remove_tyre(fit4, 'damage', 9.0, 405000, now() - interval '25 hours',
                          'recorded from the workshop book on return');
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty4) <> 'REMOVED' THEN
    RAISE EXCEPTION 'FAIL 41k: a justified backdate was refused';
  END IF;
  RAISE NOTICE 'PASS  41k an instant cannot predate the tyre, and a long backdate is justified';

  -- (l) FR-FIT-010: a rotation moves tyres within one unit and does not flip
  -- them, so the orientation comes off the closed row rather than the column
  -- default (D13).
  SELECT count(*) INTO n FROM app.rotate_tyres(vh,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tyd1, 'to_position_id', p4, 'tread_mm', 11.0),
      jsonb_build_object('tyre_id', tyd2, 'to_position_id', p3, 'tread_mm', 7.0)),
    jsonb_build_object(vh::text, 405000));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41l: rotation returned % rows, expected 2', n; END IF;
  -- Closed with the reason, and with the distance the one odometer reading
  -- makes measurable: 405000 against the 400000 both were fitted at.
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.id IN (fitd1, fitd2) AND f.removed_at IS NOT NULL AND f.removal_reason = 'rotation'
     AND f.distance_source = 'MEASURED' AND f.distance_km = 5000;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41l: the rotated-out fitments were not closed with reason and measured distance'; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.vehicle_id = vh AND f.removed_at IS NULL AND f.mount_orientation = 'MARK_INBOARD'
     AND ((f.tyre_id = tyd1 AND f.position_id = p4) OR (f.tyre_id = tyd2 AND f.position_id = p3));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41l: the new fitments did not land swapped with the orientation carried'; END IF;
  -- The actual codes, not merely two different ones: a payload that swapped
  -- from for to, or named the axle instead of the position, would pass an
  -- inequality check and still misreport the move.
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.type = 'ROTATED' AND e.to_state = 'FITTED'
     AND e.payload->>'fitment_id' IS NOT NULL
     AND ((e.tyre_id = tyd1 AND e.payload->>'from_position_code' = '3'
                           AND e.payload->>'to_position_code'   = '4')
       OR (e.tyre_id = tyd2 AND e.payload->>'from_position_code' = '4'
                           AND e.payload->>'to_position_code'   = '3'));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41l: the ROTATED events do not record the move'; END IF;
  RAISE NOTICE 'PASS  41l a rotation closes, reopens and carries the orientation';

  -- (m) FR-FIT-014: a refused rotation leaves nothing behind. The TY014 is
  -- the half with teeth. A caught exception rolls its subtransaction back
  -- whatever the function did, so the row counts below state the invariant
  -- while the refusal is what proves the position check exists at all.
  BEGIN
    PERFORM app.rotate_tyres(vh,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyd1, 'to_position_id', p3, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tyd2, 'to_position_id', px, 'tread_mm', 7.0)),
      jsonb_build_object(vh::text, 406000));
    RAISE EXCEPTION 'FAIL 41m: a rotation onto a position off the unit was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN NULL;
  END;
  SELECT count(*) INTO n FROM app.fitment f WHERE f.tyre_id IN (tyd1, tyd2);
  IF n <> 4 THEN RAISE EXCEPTION 'FAIL 41m: % fitment rows for the rotated pair, expected 4', n; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id IN (tyd1, tyd2) AND f.removed_at IS NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41m: the refused rotation left % open rows, expected 2', n; END IF;
  RAISE NOTICE 'PASS  41m a refused rotation leaves no half state';

  -- (n) A rotation is a set of moves (FR-FIT-010), and every tyre in it is
  -- one this unit is actually carrying (U3).
  BEGIN
    PERFORM app.rotate_tyres(vh,
      jsonb_build_array(jsonb_build_object('tyre_id', tyd1, 'to_position_id', p3, 'tread_mm', 11.0)),
      jsonb_build_object(vh::text, 406000));
    RAISE EXCEPTION 'FAIL 41n: a one-move rotation was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN NULL;
  END;
  BEGIN
    PERFORM app.rotate_tyres(vh,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyd1, 'to_position_id', p3, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', ty2,  'to_position_id', p4, 'tread_mm', 7.0)),
      jsonb_build_object(vh::text, 406000));
    RAISE EXCEPTION 'FAIL 41n: a rotation naming a tyre not on this unit was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  41n a rotation is at least two moves of tyres this unit carries';
  END;

  -- (o) U2: dispatch is from REMOVED only, to a depot of the destination's
  -- own kind (FR-FIT-012, FR-FIT-013).
  BEGIN
    PERFORM app.dispatch_tyre(ty5, 'AT_RETREADER', d_rt);
    RAISE EXCEPTION 'FAIL 41o: a tyre was dispatched straight out of stock';
  EXCEPTION WHEN sqlstate 'TY012' THEN NULL;
  END;
  BEGIN
    PERFORM app.dispatch_tyre(ty3, 'AT_RETREADER', md5('depot1')::uuid);
    RAISE EXCEPTION 'FAIL 41o: a retread dispatch to an ordinary depot was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN NULL;
  END;
  SELECT * INTO r FROM app.dispatch_tyre(ty3, 'AT_RETREADER', d_rt);
  job := r.retread_job_id;
  SELECT count(*) INTO n FROM app.retread_job j
   WHERE j.id = job AND j.tyre_id = ty3 AND j.retreader_depot_id = d_rt
     AND j.sent_at = app.tenant_today(tz);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41o: the retread job was not opened as at the tenant''s today'; END IF;
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty3) <> 'AT_RETREADER'
     OR (SELECT t.current_depot_id FROM app.tyre t WHERE t.id = ty3) IS DISTINCT FROM d_rt
     OR NOT EXISTS (SELECT 1 FROM app.tyre_event e
                     WHERE e.tyre_id = ty3 AND e.type = 'SENT_FOR_RETREAD'
                       AND e.to_state = 'AT_RETREADER') THEN
    RAISE EXCEPTION 'FAIL 41o: the retread dispatch did not move state, depot and event together';
  END IF;
  SELECT * INTO r FROM app.dispatch_tyre(ty4, 'AT_BREAKDOWN_SUPPLIER', d_bd);
  IF r.retread_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 41o: a breakdown dispatch opened a retread job';
  END IF;
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty4) <> 'AT_BREAKDOWN_SUPPLIER'
     OR NOT EXISTS (SELECT 1 FROM app.tyre_event e
                     WHERE e.tyre_id = ty4 AND e.type = 'SENT_TO_BREAKDOWN_SUPPLIER'
                       AND e.to_state = 'AT_BREAKDOWN_SUPPLIER') THEN
    RAISE EXCEPTION 'FAIL 41o: the breakdown dispatch did not move state and event together';
  END IF;
  RAISE NOTICE 'PASS  41o dispatch is from REMOVED, to the matching depot kind';

  -- (p) BR-FIT-009, FR-CFG-044: the cap is the one dispatch rule that
  -- refuses. A REMOVED casing has no axle class, so the cap it resolves to is
  -- the tenant-wide policy row (U5), lowered here, on that row.
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm,
                                    warning_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t41pol')::uuid, bac, 4.0, 6.0, 1, now());
  BEGIN
    PERFORM app.dispatch_tyre(tyc, 'AT_RETREADER', d_rt);
    RAISE EXCEPTION 'FAIL 41p: a casing at its retread cap was sent for retreading';
  EXCEPTION WHEN sqlstate 'TY015' THEN
    IF SQLERRM NOT LIKE '%a purchase, not a retread candidate%'
       OR SQLERRM NOT LIKE '%retreaded 1 time%'
       OR SQLERRM NOT LIKE '%cap of 1%' THEN
      RAISE EXCEPTION 'FAIL 41p: the cap refusal does not name the count, the cap and the reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41p a casing at its cap is a purchase, not a retread candidate';
  END;

  -- (q) FR-FIT-013: a casing at the retreader leaves only through Log Retread
  -- (D3), so the receipt-back surface must refuse it rather than quietly
  -- restocking a tyre the retreader still holds.
  PERFORM app.return_tyre_to_stock(ty4);
  IF (SELECT t.state FROM app.tyre t WHERE t.id = ty4) <> 'IN_STOCK'
     OR NOT EXISTS (SELECT 1 FROM app.tyre_event e
                     WHERE e.tyre_id = ty4 AND e.type = 'RETURNED' AND e.to_state = 'IN_STOCK') THEN
    RAISE EXCEPTION 'FAIL 41q: the breakdown return did not restock the tyre';
  END IF;
  BEGIN
    PERFORM app.return_tyre_to_stock(ty3);
    RAISE EXCEPTION 'FAIL 41q: a casing at the retreader was restocked directly';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  41q a breakdown return restocks; a retreader return does not';
  END;

  -- (r) Two independent cross-tenant probes through two functions (lesson
  -- 2026-09-01: two refusal branches sharing a SQLSTATE make a cross-tenant
  -- probe vacuous). Neither target can refuse for any reason but
  -- invisibility here. app.actor_id is left unset throughout so nothing can
  -- fail on the created_by FK instead (lesson 2026-08-28).
  SELECT f.id INTO fitd1 FROM app.fitment f
   WHERE f.tyre_id = tyd1 AND f.removed_at IS NULL;
  PERFORM set_config('app.tenant_id', t_two::text, true);
  BEGIN
    PERFORM app.fit_tyre(ty5, vt, p9, 14.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 41r: another tenant''s tyre was fitted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such tyre in this fleet' THEN
      RAISE EXCEPTION 'FAIL 41r: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.remove_tyre(fitd1, 'damage', 9.0, 407000);
    RAISE EXCEPTION 'FAIL 41r: another tenant''s fitment was closed';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such fitment in this fleet' THEN
      RAISE EXCEPTION 'FAIL 41r: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
  END;
  PERFORM set_config('app.tenant_id', bac::text, true);
  RAISE NOTICE 'PASS  41r another fleet''s tyre and fitment are invisible to fit and remove';

  -- (s) U8: the event separates a casing's first fitment from its later ones,
  -- which is what a fitment history is read for (FR-FIT-003).
  PERFORM app.return_tyre_to_stock(ty1);
  SELECT * INTO r FROM app.fit_tyre(ty1, vt, p10, 13.0, 'MARK_OUTBOARD');
  IF NOT EXISTS (SELECT 1 FROM app.tyre_event e
                  WHERE e.tyre_id = ty1 AND e.type = 'REFITTED' AND e.to_state = 'FITTED'
                    AND e.payload->>'fitment_id' = r.fitment_id::text) THEN
    RAISE EXCEPTION 'FAIL 41s: a tyre with a prior fitment was recorded as a first fit';
  END IF;
  SELECT count(*) INTO n FROM app.tyre_event e WHERE e.tyre_id = ty1 AND e.type = 'FITTED';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 41s: the refit also wrote a FITTED event'; END IF;
  RAISE NOTICE 'PASS  41s a casing''s second fitment is REFITTED, not FITTED';

  -- (t) FR-FIT-016: a dispatch dated today means now(), not midnight, since
  -- app.tyre_in_estate_asof resolves by LATEST to_state event, and a
  -- midnight stamp would lose to the same day's removal (FR-VAL-022). The
  -- removal is placed an hour back since now() is fixed for the whole
  -- transaction and two now() events cannot be strictly ordered.
  SELECT * INTO r FROM app.fit_tyre(ty7, vt, p9, 16.0, 'MARK_OUTBOARD', NULL,
                                    now() - interval '2 hours');
  PERFORM app.remove_tyre(r.fitment_id, 'damage', 8.0, NULL, now() - interval '1 hour');
  PERFORM app.dispatch_tyre(ty7, 'AT_RETREADER', d_rt);
  IF (SELECT e.occurred_at FROM app.tyre_event e
       WHERE e.tyre_id = ty7 AND e.type = 'SENT_FOR_RETREAD')
     <= (SELECT e.occurred_at FROM app.tyre_event e
          WHERE e.tyre_id = ty7 AND e.type = 'REMOVED') THEN
    RAISE EXCEPTION 'FAIL 41t: the dispatch is stamped at or before the removal it follows';
  END IF;
  -- And a dated dispatch that would land before the tyre's last movement is
  -- refused rather than clamped: clamping two to_state events onto one
  -- instant leaves the estate resolution ambiguous.
  SELECT * INTO r FROM app.fit_tyre(ty8, vt, p1, 16.0, 'MARK_OUTBOARD', NULL,
                                    now() - interval '2 hours');
  PERFORM app.remove_tyre(r.fitment_id, 'damage', 8.0, NULL, now() - interval '1 hour');
  BEGIN
    PERFORM app.dispatch_tyre(ty8, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 1);
    RAISE EXCEPTION 'FAIL 41t: a dispatch dated before the tyre''s last movement was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    RAISE NOTICE 'PASS  41t a dispatch is stamped now, and never predates the movement before it';
  END;

  -- (u) I1: fitment_instant_ok (000033) bounds an instant only against the
  -- tyre's LATEST to_state EVENT, so a fitment opened outside app.fit_tyre
  -- (planted raw, like 41d, with zero tyre_event rows) has no event to bound
  -- against; without the per-fitment fitted_at check the removal below would
  -- close it an hour before it was opened. Both instants stay inside 24
  -- hours so TY014's separate backdate rule (FR-FIT-016) does not fire
  -- instead. On vh (HORSE): TY009 (000025) needs a fitted_odometer even on a
  -- raw INSERT, supplied here though app.remove_tyre never reads it.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                           fitted_odometer, fitted_tread_mm)
  VALUES (bac, ty9, vh, p9, now() - interval '1 hour', 300000, 12.0)
  RETURNING id INTO fitu;
  BEGIN
    PERFORM app.remove_tyre(fitu, 'damage', 9.0, 300500, now() - interval '2 hours');
    RAISE EXCEPTION 'FAIL 41u: a removal predating its own fitment, with no to_state event to catch it, was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> format('this tyre was fitted at %s; a removal cannot predate its own fitment',
                         (SELECT f.fitted_at FROM app.fitment f WHERE f.id = fitu)) THEN
      RAISE EXCEPTION 'FAIL 41u: wrong TY012 message: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41u a removal cannot predate the fitment it closes, even with no bounding event';
  END;

  -- (v) I1, the rotation half: ty9's raw fitment has no to_state event
  -- either; ty5 is fitted twenty days back so its own check already passes
  -- and cannot be the one refusing. Only the per-move check against each
  -- tyre's own fitted_at can catch ty9. Stamped two hours back, inside the
  -- 24-hour rule rotate_tyres cannot satisfy with a reason (TYRE-108).
  SELECT * INTO r FROM app.fit_tyre(ty5, vh, p7, 12.0, 'MARK_OUTBOARD', 290000,
                                    now() - interval '20 days',
                                    'fitment backfilled from the paper sheet');
  BEGIN
    PERFORM app.rotate_tyres(vh,
      jsonb_build_array(
        jsonb_build_object('tyre_id', ty9, 'to_position_id', p7, 'tread_mm', 10.0),
        jsonb_build_object('tyre_id', ty5, 'to_position_id', p9, 'tread_mm', 10.0)),
      jsonb_build_object(vh::text, 310000), now() - interval '2 hours');
    RAISE EXCEPTION 'FAIL 41v: a rotation predating one moved tyre''s own fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM NOT LIKE format('tyre %s was fitted at%%', ty9) THEN
      RAISE EXCEPTION 'FAIL 41v: the refusal does not name the tyre and instant: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  41v a rotation cannot predate any moved tyre''s own fitment';
  END;
  SELECT count(*) INTO n FROM app.fitment f WHERE f.id IN (fitu, r.fitment_id) AND f.removed_at IS NULL;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 41v: the refused rotation left % open rows, expected 2', n; END IF;

  -- (w) I1(b), the enforced form: removal_does_not_predate_fitment (000032)
  -- catches the same backwards closure at the constraint, for a caller that
  -- reaches app.fitment directly. Without it, fitment_written_once (000032)
  -- permits the closing UPDATE and removal_is_complete (000001/000011) only
  -- ties removed_at to removal_reason, not to fitted_at, so nothing else
  -- would refuse.
  BEGIN
    -- removed_odometer is supplied only to clear TY009 (000025, ty9's unit is
    -- a HORSE): the constraint under test is the fitment-order one, not the
    -- odometer rule, so the probe must not trip on the wrong SQLSTATE.
    UPDATE app.fitment
       SET removed_at = fitted_at - interval '1 day', removal_reason = 'damage',
           removed_odometer = fitted_odometer + 1000
     WHERE id = fitu;
    RAISE EXCEPTION 'FAIL 41w: a raw UPDATE closed a fitment before it was opened';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'removal_does_not_predate_fitment' THEN
      RAISE EXCEPTION 'FAIL 41w: refused by %, not the fitment-order constraint', cname;
    END IF;
    RAISE NOTICE 'PASS  41w a closure predating its own fitment is refused at the constraint';
  END;
END $$;
ROLLBACK;

\echo '== 42. TYRE-93: a retread return propagates to the tyre (FR-FIT-021/022, FR-TYR-009/018/019, BR-VAL-004/006, D3)'
BEGIN;
DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  t_two uuid := '22222222-2222-2222-2222-222222222222';
  tz    text;
  sz1   uuid := md5('sz1')::uuid;
  pt1   uuid := md5('pt1')::uuid;
  d_rt  uuid := md5('t42rt')::uuid;
  ta    uuid := md5('t42ta')::uuid;   -- accepted return: the money path
  tb    uuid := md5('t42tb')::uuid;   -- rejected casing
  tf    uuid := md5('t42tf')::uuid;   -- the refused inputs
  tg    uuid := md5('t42tg')::uuid;   -- already at the cap
  th    uuid := md5('t42th')::uuid;   -- at the retreader, probed by dispose_tyre
  ti    uuid := md5('t42ti')::uuid;   -- the open BAC job tenant 2 probes
  tj    uuid := md5('t42tj')::uuid;   -- the REMOVED BAC tyre tenant 2 probes
  tk1   uuid := md5('t42tk1')::uuid;  -- same-day return
  tk2   uuid := md5('t42tk2')::uuid;  -- a return that would predate the dispatch
  tl    uuid := md5('t42tl')::uuid;   -- fitted, worn, retreaded: 42l's tread
  vl    uuid := md5('t42vl')::uuid;   -- TRAILER: owes no fitment odometer (TY009)
  tm    uuid := md5('t42tm')::uuid;   -- the raw-insert probes of retread_job's own constraints
  cfgl uuid; posl uuid; fitl uuid; jl uuid; reg record; last_at_l timestamptz;
  bad_cost numeric; ok_cost numeric;
  ja uuid; jb uuid; jf uuid; ji uuid;
  jg  uuid := md5('t42jg')::uuid;
  jk2 uuid := md5('t42jk2')::uuid;
  r record; n int; thr numeric; cname text;
  sent_at_k timestamptz; ret_at_k timestamptz;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  thr := app.current_removal_threshold_mm();

  INSERT INTO app.depot (id, tenant_id, name, type)
  VALUES (d_rt, bac, 'T42 Retreaders', 'RETREADER');
  -- ta carries a complete cost record so 42a's rate assertion is about the
  -- retread arithmetic and not about a missing input; the rest need only a
  -- state and a size.
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, purchase_price, cost_source, new_tread_mm,
                        rand_per_mm, state)
  VALUES (ta, bac, 'T42TYREA', sz1, pt1, 'NEW', 0, 4319.91, 'INVOICE', 25.0,
          app.rand_per_mm(4319.91, 25.0, thr), 'REMOVED');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, state) VALUES
    (tb,  bac, 'T42TYREB',  sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tf,  bac, 'T42TYREF',  sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tg,  bac, 'T42TYREG',  sz1, pt1, 'RETREAD', 1, 'AT_RETREADER'),
    (th,  bac, 'T42TYREH',  sz1, pt1, 'NEW',     0, 'AT_RETREADER'),
    (ti,  bac, 'T42TYREI',  sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tj,  bac, 'T42TYREJ',  sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tk1, bac, 'T42TYREK1', sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tk2, bac, 'T42TYREK2', sz1, pt1, 'NEW',     0, 'REMOVED'),
    (tm,  bac, 'T42TYREM',  sz1, pt1, 'NEW',     0, 'REMOVED');

  -- The dated send and return sit in the past deliberately.
  -- app.v_tyre_valuation slices at (now() AT TIME ZONE 'UTC')::date
  -- (000011:397) while casing_valuation.effective_from is a date in the
  -- tenant's calendar (rule 6), so a valuation effective on the tenant's
  -- today is outside the register's window for the hours that day runs ahead
  -- of UTC's. A return logged at 00:30 SAST is invisible to 42b's read until
  -- the UTC day rolls over. Dating the return at tenant_today - 1 sidesteps
  -- that window at every hour. The five-day send also gives 42c a turnaround
  -- that is not zero.
  SELECT * INTO r FROM app.dispatch_tyre(ta, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5);
  ja := r.retread_job_id;

  -- (a) FR-TYR-018/019, BR-VAL-006. Both stored figures are quoted past
  -- their column's scale so the rounding order is observable: a cost at three
  -- decimals and a tread at two, each rounded into its column's own type
  -- before the divide, yield a rate reproducible from the row it is stored
  -- beside; dividing either raw parameter does not (lesson 2026-09-01: a
  -- function parameter's numeric(p,s) is discarded; only a local rounds). Both
  -- inputs
  -- are read back off the rows rather than restated, so only the stored
  -- figures are on trial.
  PERFORM app.log_retread_return(ja, app.tenant_today(tz) - 1, true, 'T42-RPT-A',
                                 2500.005, 16.04, 800.00);
  SELECT t.retread_count, t.status, t.new_tread_mm, t.pattern_id, t.state,
         t.current_depot_id, t.rand_per_mm
    INTO r FROM app.tyre t WHERE t.id = ta;
  IF r.retread_count IS DISTINCT FROM 1 OR r.status IS DISTINCT FROM 'RETREAD'
     OR r.new_tread_mm IS DISTINCT FROM 16.0
     OR r.pattern_id IS DISTINCT FROM pt1 OR r.state IS DISTINCT FROM 'IN_STOCK'
     OR r.current_depot_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 42a: the return did not propagate to the tyre: %', r;
  END IF;
  IF (SELECT j.retread_cost FROM app.retread_job j WHERE j.id = ja) IS DISTINCT FROM 2500.01 THEN
    RAISE EXCEPTION 'FAIL 42a: the job stored % rather than the cost rounded to cents',
      (SELECT j.retread_cost FROM app.retread_job j WHERE j.id = ja);
  END IF;
  IF r.rand_per_mm IS NULL OR r.rand_per_mm IS DISTINCT FROM
     (SELECT app.rand_per_mm(j.retread_cost, t.new_tread_mm, app.current_removal_threshold_mm())
        FROM app.retread_job j JOIN app.tyre t ON t.id = j.tyre_id WHERE j.id = ja) THEN
    RAISE EXCEPTION 'FAIL 42a: stored rate % is not reproducible from the stored cost and tread',
      r.rand_per_mm;
  END IF;
  RAISE NOTICE 'PASS  42a a retread return re-rates the casing from the cost it stores: %', r.rand_per_mm;

  -- (b) FR-FIT-022: the casing figure is the retreader's, on a report, so
  -- the register reads it as ACTUAL, not an estimate (000013's precedence).
  -- app.tyre.casing_value (the AUDIT fallback) stays untouched, or one
  -- casing would carry two figures of different provenance.
  SELECT count(*) INTO n FROM app.casing_valuation c WHERE c.tyre_id = ta;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 42b: % casing valuations for one return, expected 1', n; END IF;
  SELECT count(*) INTO n FROM app.casing_valuation c
   WHERE c.tyre_id = ta AND c.value = 800.00 AND c.source = 'RETREADER'
     AND c.retread_job_id = ja AND c.effective_from = app.tenant_today(tz) - 1;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 42b: the valuation row does not cite the job at the return date';
  END IF;
  IF (SELECT t.casing_value FROM app.tyre t WHERE t.id = ta) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 42b: the return also wrote the AUDIT fallback column';
  END IF;
  SELECT v.casing_value, v.casing_basis INTO r FROM app.v_tyre_valuation v WHERE v.tyre_id = ta;
  IF r.casing_value IS DISTINCT FROM 800.00 OR r.casing_basis IS DISTINCT FROM 'ACTUAL' THEN
    RAISE EXCEPTION 'FAIL 42b: the register reads % / %, not the retreader''s actual figure',
      r.casing_value, r.casing_basis;
  END IF;
  RAISE NOTICE 'PASS  42b the retreader''s casing figure reaches the register as ACTUAL';

  -- (c) FR-FIT-021: turnaround is the table's generated column, so the job
  -- carries it without the function entering it.
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.tyre_id = ta AND e.type = 'RETURNED' AND e.from_state = 'AT_RETREADER'
     AND e.to_state = 'IN_STOCK' AND e.payload->>'retread_job_id' = ja::text
     AND e.payload->>'retread_count' = '1';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 42c: the RETURNED event did not land once carrying the job'; END IF;
  SELECT count(*) INTO n FROM app.retread_job j
   WHERE j.id = ja AND j.returned_at = app.tenant_today(tz) - 1
     AND j.casing_accepted AND j.report_reference = 'T42-RPT-A'
     AND j.post_tread_mm = 16.0 AND j.casing_value = 800.00 AND j.turnaround_days = 4;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 42c: the job did not close with every return field'; END IF;
  RAISE NOTICE 'PASS  42c the return closes the job, its turnaround and the event together';

  -- (d) A closed job is not an open one. The message is exact because the
  -- API surface (D6) maps this one string to its 404.
  BEGIN
    PERFORM app.log_retread_return(ja, app.tenant_today(tz) - 1, true, 'T42-RPT-A',
                                   2500.005, 16.04, 800.00);
    RAISE EXCEPTION 'FAIL 42d: a job was returned twice';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such open retread job in this fleet' THEN
      RAISE EXCEPTION 'FAIL 42d: wrong TY012 message: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  42d a returned job cannot be returned again';
  END;

  -- (e) FR-TYR-009, BR-VAL-004, U9: a rejected casing is the one legitimate
  -- source of a zero casing value, recorded as a valuation citing the job,
  -- never as an absence (absence reads as UNVALUED, a different claim).
  SELECT * INTO r FROM app.dispatch_tyre(tb, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5);
  jb := r.retread_job_id;
  PERFORM app.log_retread_return(jb, app.tenant_today(tz) - 1, false, 'T42-RPT-B');
  SELECT t.state, t.status, t.retread_count, t.new_tread_mm INTO r FROM app.tyre t WHERE t.id = tb;
  IF r.state <> 'SCRAPPED' OR r.status <> 'NEW' OR r.retread_count <> 0
     OR r.new_tread_mm IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 42e: a rejected casing was retreaded rather than scrapped: %', r;
  END IF;
  SELECT count(*) INTO n FROM app.casing_valuation c
   WHERE c.tyre_id = tb AND c.value = 0 AND c.source = 'RETREADER' AND c.retread_job_id = jb;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 42e: the rejection did not write a zero valuation citing the job';
  END IF;
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.tyre_id = tb AND e.type = 'SCRAPPED' AND e.from_state = 'AT_RETREADER'
     AND e.to_state = 'SCRAPPED' AND e.reason = 'casing rejected by retreader'
     AND e.payload->>'retread_job_id' = jb::text;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 42e: the scrap event does not name the rejection'; END IF;
  SELECT v.casing_value, v.casing_basis INTO r FROM app.v_tyre_valuation v WHERE v.tyre_id = tb;
  IF r.casing_value IS DISTINCT FROM 0.00 OR r.casing_basis IS DISTINCT FROM 'ACTUAL' THEN
    RAISE EXCEPTION 'FAIL 42e: the register reads % / % for a rejected casing',
      r.casing_value, r.casing_basis;
  END IF;
  RAISE NOTICE 'PASS  42e a rejected casing scraps the tyre and books an actual zero';

  -- (f) The inputs this surface refuses, each probe leaving the other
  -- parameters valid so only the rule under test can fire. jf stays open
  -- after all eleven since each caught exception rolls back its own
  -- subtransaction. Each probe pins its own message fragment so a reordered
  -- guard cannot let one pass on another rule's refusal.
  SELECT * INTO r FROM app.dispatch_tyre(tf, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5);
  jf := r.retread_job_id;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, false, 'T42-RPT-F', NULL, NULL, 900.00);
    RAISE EXCEPTION 'FAIL 42f: a rejected casing was given a value';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%a rejected casing carries no retread cost%' THEN
      RAISE EXCEPTION 'FAIL 42f: a valued rejection was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F', 1000.00, thr, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a post-retread tread at the removal threshold was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%must exceed the removal threshold%' THEN
      RAISE EXCEPTION 'FAIL 42f: a threshold tread was refused by another rule: %', SQLERRM;
    END IF;
  END;
  -- A tread that rounds ONTO the threshold: numeric(4,1) is the column's
  -- scale, so the guard has to see the rounded figure or it admits a casing
  -- whose stored tread yields no rate at all (BR-VAL-002).
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F', 1000.00, thr + 0.04, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a tread that rounds onto the removal threshold was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%must exceed the removal threshold%' THEN
      RAISE EXCEPTION 'FAIL 42f: a rounding tread was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 6, true, 'T42-RPT-F', 1000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a return dated before the send was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%on or after the day it was sent%' THEN
      RAISE EXCEPTION 'FAIL 42f: a backwards date was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) + 1, true, 'T42-RPT-F', 1000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a return dated in the future was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%never on a future date%' THEN
      RAISE EXCEPTION 'FAIL 42f: a future date was refused by another rule: %', SQLERRM;
    END IF;
  END;
  -- FR-TYR-009, BR-VAL-004: a zero on an accepted casing would reach the
  -- register as an ACTUAL zero indistinguishable from a rejection, so it is
  -- refused, including the zero a sub-cent figure rounds into.
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F', 1000.00, 16.0, 0.00);
    RAISE EXCEPTION 'FAIL 42f: an accepted casing was valued at zero';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%a zero belongs to a rejection%' THEN
      RAISE EXCEPTION 'FAIL 42f: a zero casing value was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F', 1000.00, 16.0, 0.004);
    RAISE EXCEPTION 'FAIL 42f: an accepted casing value that rounds to zero was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%a zero belongs to a rejection%' THEN
      RAISE EXCEPTION 'FAIL 42f: a rounding casing value was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F', NULL, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a paid retread was logged without its cost';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%records what the retread cost%' THEN
      RAISE EXCEPTION 'FAIL 42f: a missing cost was refused by another rule: %', SQLERRM;
    END IF;
  END;
  -- The two money parameters, past what numeric(12,2) can hold: bounded for
  -- the same reason the tread bound is (ADR-0012). Unbounded, the locals'
  -- column type would raise a bare 22003 at assignment, outside the TY
  -- class, which the wire maps to a 500 the outbox retries forever. The
  -- excess is one cent past the ceiling, not an absurd value.
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F',
                                   10000000000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a retread cost wider than its column was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%a retread cost is a non-negative amount%' THEN
      RAISE EXCEPTION 'FAIL 42f: an oversized cost was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F',
                                   1000.00, 16.0, 10000000000.00);
    RAISE EXCEPTION 'FAIL 42f: a casing value wider than its column was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%a casing value is an amount%' THEN
      RAISE EXCEPTION 'FAIL 42f: an oversized casing value was refused by another rule: %', SQLERRM;
    END IF;
  END;
  -- The rate ceiling, not implied by the cost ceiling above: BR-VAL-002
  -- divides cost by usable tread, and rand_per_mm holds numeric(12,4), so a
  -- cost well inside its own column can still overflow on the way to the
  -- register (FR-VAL-006). The straddle is asserted first: two costs on the
  -- same side of the ceiling would pass without testing anything.
  bad_cost := round(100000000 * (16.0 - thr), 2);
  ok_cost  := bad_cost - 0.12;
  IF app.rand_per_mm(bad_cost, 16.0, thr) IS NULL OR app.rand_per_mm(ok_cost, 16.0, thr) IS NULL
     OR app.rand_per_mm(bad_cost, 16.0, thr) < 100000000
     OR app.rand_per_mm(ok_cost, 16.0, thr) >= 100000000
     OR bad_cost > 9999999999.99 THEN
    RAISE EXCEPTION 'FAIL 42f: the rate-ceiling probe does not straddle the boundary (% then %, cost %)',
      app.rand_per_mm(bad_cost, 16.0, thr), app.rand_per_mm(ok_cost, 16.0, thr), bad_cost;
  END IF;
  BEGIN
    PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F',
                                   bad_cost, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42f: a cost yielding a rate past the register''s ceiling was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%is a rate above what the register carries%' THEN
      RAISE EXCEPTION 'FAIL 42f: the rate ceiling was refused by another rule: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  42f eleven inputs this surface does not accept, each refused by its own rule';
  END;
  -- The other side of the same edge, and the reason it is last in 42f: this
  -- one is accepted, so it closes jf. The stored rate is read back against
  -- app.rand_per_mm rather than against a literal. The ceiling must refuse
  -- what will not fit and nothing else (FR-VAL-006, one implementation).
  PERFORM app.log_retread_return(jf, app.tenant_today(tz) - 1, true, 'T42-RPT-F',
                                 ok_cost, 16.0, 500.00);
  IF (SELECT t.rand_per_mm FROM app.tyre t WHERE t.id = tf)
     IS DISTINCT FROM app.rand_per_mm(ok_cost, 16.0, thr) THEN
    RAISE EXCEPTION 'FAIL 42f: the highest rate the column holds stored as %',
      (SELECT t.rand_per_mm FROM app.tyre t WHERE t.id = tf);
  END IF;
  RAISE NOTICE 'PASS  42f the cent below that ceiling is accepted and stored: %',
    (SELECT t.rand_per_mm FROM app.tyre t WHERE t.id = tf);

  -- (g) BR-FIT-009, FR-CFG-044, U5: the cap is re-read here because policy
  -- can be lowered between send and return; a casing with no axle class
  -- resolves to the tenant-wide row. jg goes in directly, since
  -- app.dispatch_tyre would refuse it at the door, exactly what this
  -- backstop exists to catch. The return is dated today: a return reads the
  -- policy of its own day (U70), and the lowered cap takes effect at now().
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm,
                                    warning_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t42pol')::uuid, bac, 4.0, 6.0, 1, now());
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at)
  VALUES (jg, bac, tg, d_rt, app.tenant_today(tz) - 3);
  BEGIN
    PERFORM app.log_retread_return(jg, app.tenant_today(tz), true, 'T42-RPT-G', 1000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42g: a casing past its cap was retreaded on return';
  EXCEPTION WHEN sqlstate 'TY015' THEN
    IF SQLERRM NOT LIKE '%a purchase, not a retread candidate%' THEN
      RAISE EXCEPTION 'FAIL 42g: wrong TY015 message: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  42g the cap is re-checked on return, not only on dispatch';
  END;

  -- (h) FR-TYR-009: the rejected-casing scrap belongs to this function, so
  -- the general disposal surface must keep refusing a casing the retreader
  -- still holds, or the same scrap would exist twice.
  BEGIN
    PERFORM app.dispose_tyre(th, 'SCRAPPED', 'audit', NULL, now());
    RAISE EXCEPTION 'FAIL 42h: a casing at the retreader was scrapped outside Log Retread';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM NOT LIKE '%AT_RETREADER%' THEN
      RAISE EXCEPTION 'FAIL 42h: TY012 fired for the wrong reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  42h the only scrap path from the retreader is the retread return';
  END;

  -- (i) Two cross-tenant probes through two functions (lesson 2026-09-01:
  -- two refusal branches sharing a SQLSTATE make a cross-tenant probe
  -- vacuous). Neither target can refuse for any reason but invisibility.
  -- app.actor_id is left unset throughout so nothing fails on the
  -- created_by FK instead (lesson 2026-08-28).
  SELECT * INTO r FROM app.dispatch_tyre(ti, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5);
  ji := r.retread_job_id;
  PERFORM set_config('app.tenant_id', t_two::text, true);
  BEGIN
    PERFORM app.log_retread_return(ji, app.tenant_today(tz) - 1, true, 'T42-RPT-I', 1000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42i: another fleet''s retread job was returned';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such open retread job in this fleet' THEN
      RAISE EXCEPTION 'FAIL 42i: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.dispatch_tyre(tj, 'AT_RETREADER', d_rt);
    RAISE EXCEPTION 'FAIL 42i: another fleet''s tyre was dispatched';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such tyre in this fleet' THEN
      RAISE EXCEPTION 'FAIL 42i: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
  END;
  PERFORM set_config('app.tenant_id', bac::text, true);
  RAISE NOTICE 'PASS  42i another fleet''s open job and removed casing are invisible here';

  -- (j) The local sentinel for check 7's Appendix E pin: nothing in this
  -- section may redefine the one implementation of the rate (FR-VAL-006).
  IF app.rand_per_mm(4319.91, 25.0, 4.0) IS DISTINCT FROM 205.7100 THEN
    RAISE EXCEPTION 'FAIL 42j: rand_per_mm no longer derives Appendix E, got %',
      app.rand_per_mm(4319.91, 25.0, 4.0);
  END IF;
  RAISE NOTICE 'PASS  42j the Appendix E rate derivation is untouched by this surface';

  -- (k) FR-FIT-016, FR-VAL-022: a return dated today means now(), not
  -- midnight, since app.tyre_in_estate_asof resolves by LATEST to_state
  -- event and a midnight return would sort behind the same day's dispatch.
  -- now() is fixed for the whole transaction, so what is asserted is that
  -- the return stamps at now() and never behind the dispatch.
  SELECT * INTO r FROM app.dispatch_tyre(tk1, 'AT_RETREADER', d_rt);
  PERFORM app.log_retread_return(r.retread_job_id, app.tenant_today(tz), true,
                                 'T42-RPT-K', 1000.00, 16.0, 500.00);
  SELECT e.occurred_at INTO sent_at_k FROM app.tyre_event e
   WHERE e.tyre_id = tk1 AND e.type = 'SENT_FOR_RETREAD';
  SELECT e.occurred_at INTO ret_at_k FROM app.tyre_event e
   WHERE e.tyre_id = tk1 AND e.type = 'RETURNED';
  IF ret_at_k IS DISTINCT FROM now() OR sent_at_k IS NULL OR ret_at_k < sent_at_k THEN
    RAISE EXCEPTION 'FAIL 42k: a same-day return is stamped % against a dispatch at % and a now() of %',
      ret_at_k, sent_at_k, now();
  END IF;
  -- The other half of the same rule: an instant falling behind the tyre's
  -- last movement is refused, never clamped. jk2 goes in directly since
  -- app.dispatch_tyre cannot produce the divergence; a job carried over from
  -- a paper record can.
  PERFORM app.dispatch_tyre(tk2, 'AT_RETREADER', d_rt);
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at)
  VALUES (jk2, bac, tk2, d_rt, app.tenant_today(tz) - 3);
  BEGIN
    PERFORM app.log_retread_return(jk2, app.tenant_today(tz) - 2, true,
                                   'T42-RPT-K2', 1000.00, 16.0, 500.00);
    RAISE EXCEPTION 'FAIL 42k: a return predating the dispatch it follows was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM NOT LIKE '%cannot predate it%' THEN
      RAISE EXCEPTION 'FAIL 42k: TY012 fired for the wrong reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  42k a return is stamped now, and never predates the movement before it';
  END;

  -- (l) FR-TYR-018, U10, CR-012: the defect exists only at the join.
  -- app.remove_tyre leaves last_tread_mm at the pulled depth; a return that
  -- re-treads without moving that column would price the new tread at the
  -- old figure, neither correct answer. Instants are spread twelve days
  -- back since last_tread_at only moves forward (U10) and the return must
  -- sit clearly after the removal at every hour of the tenant's day.
  SELECT v.configuration_id INTO cfgl FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO posl FROM app.position p WHERE p.configuration_id = cfgl AND p.code = '1';
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, status)
  VALUES (vl, bac, 'T42-L', 'T42L GP', cfgl, 'TRAILER', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, purchase_price, cost_source, new_tread_mm,
                        rand_per_mm, state)
  VALUES (tl, bac, 'T42TYREL', sz1, pt1, 'NEW', 0, 4319.91, 'INVOICE', 22.0,
          app.rand_per_mm(4319.91, 22.0, thr), 'IN_STOCK');
  SELECT * INTO r FROM app.fit_tyre(tl, vl, posl, 22.0, 'MARK_OUTBOARD', NULL,
                                    now() - interval '20 days', 'fitted from a paper card');
  fitl := r.fitment_id;
  PERFORM app.remove_tyre(fitl, 'worn_to_threshold', 4.5, NULL,
                          now() - interval '12 days', 'removed from a paper card');
  IF (SELECT t.last_tread_mm FROM app.tyre t WHERE t.id = tl) IS DISTINCT FROM 4.5 THEN
    RAISE EXCEPTION 'FAIL 42l: the removal did not leave the worn tread this probe starts from';
  END IF;
  SELECT * INTO r FROM app.dispatch_tyre(tl, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5);
  jl := r.retread_job_id;
  PERFORM app.log_retread_return(jl, app.tenant_today(tz) - 1, true, 'T42-RPT-L',
                                 2500.00, 16.0, 800.00);
  -- The event's own instant, not now(): the return is dated, and a column
  -- stamped at the moment of logging would make a backdated return outrank a
  -- measurement taken after it.
  SELECT e.occurred_at INTO last_at_l FROM app.tyre_event e
   WHERE e.tyre_id = tl AND e.type = 'RETURNED';
  SELECT t.last_tread_mm, t.last_tread_at, t.rand_per_mm INTO r
    FROM app.tyre t WHERE t.id = tl;
  IF r.last_tread_mm IS DISTINCT FROM 16.0 OR r.last_tread_at IS DISTINCT FROM last_at_l THEN
    RAISE EXCEPTION 'FAIL 42l: the casing came back at 16.0 and the tyre reads % at %',
      r.last_tread_mm, r.last_tread_at;
  END IF;
  -- The money: tl has no readings, so the register reads the AUDIT
  -- fallback; the expected figure comes from app.tread_value against the
  -- row's own rate and threshold, never restated arithmetic (FR-VAL-006,
  -- one implementation). The threshold is read off the register row, not
  -- this block's thr, since 42g's policy row supersedes it.
  SELECT v.current_tread_mm, v.tread_source, v.tread_value, v.rand_per_mm,
         v.removal_threshold_mm
    INTO reg FROM app.v_tyre_valuation v WHERE v.tyre_id = tl;
  IF reg.current_tread_mm IS DISTINCT FROM 16.0 OR reg.tread_source IS DISTINCT FROM 'AUDIT' THEN
    RAISE EXCEPTION 'FAIL 42l: the register prices the retread at % (%)',
      reg.current_tread_mm, reg.tread_source;
  END IF;
  IF reg.rand_per_mm IS DISTINCT FROM
     app.rand_per_mm(2500.00, 16.0, reg.removal_threshold_mm) THEN
    RAISE EXCEPTION 'FAIL 42l: the register carries rate % rather than the retread rate',
      reg.rand_per_mm;
  END IF;
  IF reg.tread_value IS DISTINCT FROM
     app.tread_value(16.0, reg.removal_threshold_mm, reg.rand_per_mm) THEN
    RAISE EXCEPTION 'FAIL 42l: tread value % is not the 16.0 mm value at the register''s own rate and threshold',
      reg.tread_value;
  END IF;
  RAISE NOTICE 'PASS  42l an accepted return moves the tread the register prices: % mm / %',
    reg.current_tread_mm, reg.tread_value;

  -- (m)(n) retread_job's own constraints, driven directly: log_retread_return
  -- refuses these shapes earlier, so a raw INSERT is the only way to reach
  -- them. Each probe violates exactly one constraint, since two violated at
  -- once report whichever the executor checks first.
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at, returned_at, casing_accepted)
  VALUES (md5('t42jm0')::uuid, bac, tm, d_rt, app.tenant_today(tz) - 3, app.tenant_today(tz) - 1, true);
  BEGIN
    INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at, returned_at, casing_accepted)
    VALUES (md5('t42jm1')::uuid, bac, tm, d_rt, app.tenant_today(tz) - 3, app.tenant_today(tz) - 1, NULL);
    RAISE EXCEPTION 'FAIL 42m: a returned casing with no accept/reject verdict was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'return_is_complete' THEN
      RAISE EXCEPTION 'FAIL 42m: refused by %, not return_is_complete', cname;
    END IF;
  END;
  RAISE NOTICE 'PASS  42m a return without a casing verdict is refused at the constraint';
  BEGIN
    INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at, returned_at, casing_accepted)
    VALUES (md5('t42jn1')::uuid, bac, tm, d_rt, app.tenant_today(tz) - 3, app.tenant_today(tz) - 5, true);
    RAISE EXCEPTION 'FAIL 42n: a return dated before its own dispatch was accepted';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    IF cname <> 'returned_after_sent' THEN
      RAISE EXCEPTION 'FAIL 42n: refused by %, not returned_after_sent', cname;
    END IF;
  END;
  RAISE NOTICE 'PASS  42n a return that predates its dispatch is refused at the constraint';
END $$;
ROLLBACK;

\echo '== 43. TYRE-94: unit status transitions and the audited row (FR-VEH-005/006, FR-INS-054, FR-AUD-001, ADR-0014)'
BEGIN;
DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  t_two uuid := '22222222-2222-2222-2222-222222222222';
  -- A seeded BAC user, not a fresh uuid: app.vehicle.created_by and
  -- app.inspection_schedule.created_by both default to app.current_actor_id()
  -- behind a composite FK, so an invented actor would kill a plant on the FK
  -- and read as a fault in the surface under test (lesson 2026-08-28).
  act   uuid := md5('controller1')::uuid;
  veh1  uuid := md5('veh1')::uuid;  -- seeded, ACTIVE, BAC: 43g's cross-tenant target
  vu    uuid := md5('t43u')::uuid;  -- TRAILER: owes no fitment odometer (TY009)
  ghost uuid := md5('t43ghost')::uuid;
  sch   uuid := md5('t43sch')::uuid;
  ty    uuid := md5('t43ty')::uuid;
  ty2   uuid := md5('t43ty2')::uuid;  -- IN_STOCK throughout: 43k's fit must reach the unit
  tag   uuid := md5('t43tag')::uuid;
  sz1   uuid := md5('sz1')::uuid;
  cfg uuid; pos uuid; fit uuid; r record; a app.audit_log;
  n int; before_n int; got app.vehicle_status;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- Planted with no actor bound, which is what 43i reads back: the INSERT
  -- audit row carries a NULL actor because app.current_actor_id() returns
  -- NULL rather than raising when no session actor exists (ADR-0014).
  PERFORM set_config('app.actor_id', '', true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = veh1;
  SELECT p.id INTO pos FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  IF cfg IS NULL OR pos IS NULL THEN
    RAISE EXCEPTION 'FAIL: section 43 cannot resolve the configuration it plants against';
  END IF;
  -- The seed fills every position on veh1, so the unit under test is planted
  -- on the same configuration to have an empty one (as sections 36 and 41 do).
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (vu, bac, 'T43-U', 'T43U GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (ty,  bac, 'T43TYRE1', sz1, 'NEW', 0, 'IN_STOCK'),
    (ty2, bac, 'T43TYRE2', sz1, 'NEW', 0, 'IN_STOCK');
  INSERT INTO app.vehicle_tag (id, tenant_id, name) VALUES (tag, bac, 'T43 Long Haul');
  INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id) VALUES (bac, vu, tag);
  SELECT * INTO r FROM app.fit_tyre(ty, vu, pos, 14.0, 'MARK_OUTBOARD');
  fit := r.fitment_id;

  -- (a) INV-2, FR-VEH-005: the reason is supplied, so only the open-fitment
  -- rule can refuse this call, since a casing on a disposed unit would be
  -- stranded with no removal path left to take it off.
  BEGIN
    PERFORM app.set_vehicle_status(vu, 'DISPOSED', 'sold');
    RAISE EXCEPTION 'FAIL 43a: a unit with a fitted tyre was disposed';
  EXCEPTION WHEN sqlstate 'TY016' THEN
    IF SQLERRM NOT LIKE '%still has fitted tyres%' THEN
      RAISE EXCEPTION 'FAIL 43a: the disposal was refused by another rule: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  43a a unit with an open fitment cannot be disposed';
  END;

  -- (b) FR-AUD-001, ADR-0014: counted as a delta, not a literal, since the
  -- planting above already wrote INSERT rows and an absolute count would
  -- pass on those alone (lesson 2026-08-26). The actor is bound here and
  -- only here, so a NULL would be visible as a failure.
  PERFORM set_config('app.actor_id', act::text, true);
  SELECT count(*) INTO before_n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE';
  PERFORM app.set_vehicle_status(vu, 'PARKED');
  SELECT v.status INTO got FROM app.vehicle v WHERE v.id = vu;
  IF got <> 'PARKED' THEN
    RAISE EXCEPTION 'FAIL 43b: the unit is % after a park', got;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE';
  IF n <> before_n + 1 THEN
    RAISE EXCEPTION 'FAIL 43b: one status change wrote % audit rows, not one', n - before_n;
  END IF;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE'
   ORDER BY al.id DESC LIMIT 1;
  -- IS DISTINCT FROM, not <>: a trigger writing NULL into before on an
  -- UPDATE would make <> evaluate to NULL and the branch fall through, so
  -- the assertion would pass on a missing value (lesson 2026-08-26).
  IF a.before->>'status' IS DISTINCT FROM 'ACTIVE'
     OR a.after->>'status' IS DISTINCT FROM 'PARKED' THEN
    RAISE EXCEPTION 'FAIL 43b: the audit row reads % to %', a.before->>'status', a.after->>'status';
  END IF;
  -- Against the literal bound above, not against app.current_actor_id(): two
  -- NULLs compare equal under IS NOT DISTINCT FROM, so reading the setting
  -- back would let a trigger that never resolved an actor pass vacuously.
  IF a.actor_id IS DISTINCT FROM act THEN
    RAISE EXCEPTION 'FAIL 43b: the audit row names actor %, not the one bound', a.actor_id;
  END IF;
  -- ADR-0014 chose a full-row snapshot over a changed-columns diff, so the
  -- stamp columns the BEFORE trigger wrote are in it too: after carries every
  -- column of app.vehicle, not just the one this call set.
  IF a.after->>'updated_by' IS DISTINCT FROM act::text THEN
    RAISE EXCEPTION 'FAIL 43b: the snapshot records updated_by %, not the actor', a.after->>'updated_by';
  END IF;
  -- The SECURITY INVOKER half of ADR-0014: the trigger runs as the writer, so
  -- the row lands under the writer's tenant and tenant_isolation's USING
  -- clause lets that writer read it back.
  IF a.tenant_id IS DISTINCT FROM bac THEN
    RAISE EXCEPTION 'FAIL 43b: the audit row landed under tenant %', a.tenant_id;
  END IF;
  RAISE NOTICE 'PASS  43b a status change writes exactly one audit row, actored and tenant-scoped';

  -- (c) Two refusals that share TY016 with 43a and 43e, so each pins its own
  -- fragment: a no-op would otherwise pass on the terminal branch and an
  -- invisible unit on the no-op branch.
  BEGIN
    PERFORM app.set_vehicle_status(vu, 'PARKED');
    RAISE EXCEPTION 'FAIL 43c: a no-op transition was accepted';
  EXCEPTION WHEN sqlstate 'TY016' THEN
    IF SQLERRM NOT LIKE '%already PARKED%' THEN
      RAISE EXCEPTION 'FAIL 43c: the no-op was refused by another rule: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.set_vehicle_status(ghost, 'PARKED');
    RAISE EXCEPTION 'FAIL 43c: an unknown unit was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such unit in this fleet' THEN
      RAISE EXCEPTION 'FAIL 43c: wrong TY012 message: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  43c a no-op and an unknown unit are each refused on their own rule';
  END;

  -- (d) FR-VEH-006, FR-INS-054: asserted as behaviour, not trusted to
  -- app.generate_inspection_tasks' v.status filter (000012), since a filter
  -- that drifts would show up here and nowhere else. The same as-of date
  -- drives both calls, so only the unit's status differs between them.
  INSERT INTO app.inspection_schedule (id, tenant_id, vehicle_id, interval_days)
  VALUES (sch, bac, vu, 7);
  PERFORM app.generate_inspection_tasks(current_date);
  SELECT count(*) INTO n FROM app.inspection_task t WHERE t.vehicle_id = vu;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 43d: a parked unit was issued % inspection task(s)', n;
  END IF;
  PERFORM app.set_vehicle_status(vu, 'ACTIVE');
  PERFORM app.generate_inspection_tasks(current_date);
  SELECT count(*) INTO n FROM app.inspection_task t WHERE t.vehicle_id = vu;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 43d: an active unit with a due schedule got % task(s), not one', n;
  END IF;
  RAISE NOTICE 'PASS  43d a parked unit issues no inspection task; reactivating it issues one';

  -- (e) The casing goes back to the pool first, then the three remaining
  -- TY016 branches in the order a disposal meets them; the missing-reason
  -- and terminal probes run on units that cannot pass on 43a's rule
  -- instead.
  PERFORM app.remove_tyre(fit, 'vehicle_disposal', 10.0);
  BEGIN
    PERFORM app.set_vehicle_status(vu, 'DISPOSED');
    RAISE EXCEPTION 'FAIL 43e: a disposal without a reason was accepted';
  EXCEPTION WHEN sqlstate 'TY016' THEN
    IF SQLERRM NOT LIKE '%reason%' THEN
      RAISE EXCEPTION 'FAIL 43e: the reasonless disposal was refused by another rule: %', SQLERRM;
    END IF;
  END;
  PERFORM app.set_vehicle_status(vu, 'DISPOSED', 'sold at auction');
  SELECT v.status INTO got FROM app.vehicle v WHERE v.id = vu;
  IF got <> 'DISPOSED' THEN
    RAISE EXCEPTION 'FAIL 43e: the unit is % after a disposal', got;
  END IF;
  BEGIN
    PERFORM app.set_vehicle_status(vu, 'ACTIVE');
    RAISE EXCEPTION 'FAIL 43e: a disposed unit was returned to service';
  EXCEPTION WHEN sqlstate 'TY016' THEN
    IF SQLERRM NOT LIKE '%DISPOSED%' THEN
      RAISE EXCEPTION 'FAIL 43e: the terminal refusal fired for another reason: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  43e disposal needs an empty unit and a reason, and is terminal';
  END;

  -- (f) CR-004 / DR-011 reaching the new writer: the trigger may add rows and
  -- nothing may rewrite them. The suite runs as app_login, not a superuser,
  -- so the revoke at 000001:585 is what has to refuse this.
  BEGIN
    UPDATE app.audit_log SET action = 'x' WHERE entity_id = vu;
    RAISE EXCEPTION 'FAIL 43f: an audit row was rewritten through the app role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS  43f audit rows stay append-only for the app role';
  END;

  -- (g) Two cross-tenant probes (lesson 2026-09-01: two refusal branches
  -- sharing a SQLSTATE make a cross-tenant probe vacuous). veh1 is ACTIVE
  -- with no open-fitment bar, so a leaked row would be parked, not refused.
  -- The raw UPDATE writes description, which has no constraint or history
  -- trigger, so 0 rows can only mean RLS hid it.
  PERFORM set_config('app.actor_id', '', true);
  PERFORM set_config('app.tenant_id', t_two::text, true);
  BEGIN
    PERFORM app.set_vehicle_status(veh1, 'PARKED');
    RAISE EXCEPTION 'FAIL 43g: another fleet''s unit was parked';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'no such unit in this fleet' THEN
      RAISE EXCEPTION 'FAIL 43g: TY012 fired for the wrong reason (%), not RLS invisibility', SQLERRM;
    END IF;
  END;
  UPDATE app.vehicle SET description = 'x' WHERE id = veh1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 43g: a raw update reached % of another fleet''s unit rows', n;
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  RAISE NOTICE 'PASS  43g another fleet''s unit is invisible to the function and to a raw update';

  -- (h) FR-VEH-041, U6: a tag map row is a current label, so the edit
  -- replaces the set with DELETE on the map alone; app.vehicle_tag itself
  -- stays undeletable (000018), so a tag other units carry survives.
  DELETE FROM app.vehicle_tag_map m WHERE m.vehicle_id = vu;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 43h: the tag map delete reached % rows, not the one planted', n;
  END IF;
  DELETE FROM app.vehicle_tag_map m WHERE m.vehicle_id = vu;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 43h: a second tag map delete reached % rows', n;
  END IF;
  BEGIN
    DELETE FROM app.vehicle_tag t WHERE t.id = tag;
    RAISE EXCEPTION 'FAIL 43h: a tag name was deleted through the app role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS  43h the tag map is deletable and the tag itself is not';
  END;

  -- (i) ADR-0014's NULL actor (no app actor bound): planted with none, so
  -- the INSERT audit row has a NULL actor rather than failing. before IS
  -- NULL is the row shape's other half: a trigger stamping to_jsonb(NEW)
  -- into both columns would make a creation indistinguishable from a no-op
  -- edit.
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'INSERT';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 43i: planting one unit wrote % INSERT audit rows', n;
  END IF;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'INSERT';
  IF a.actor_id IS NOT NULL OR a.before IS NOT NULL
     OR a.tenant_id IS DISTINCT FROM bac
     OR a.after->>'status' IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'FAIL 43i: the unactored insert audited as actor %, before %, tenant %',
      a.actor_id, a.before, a.tenant_id;
  END IF;
  -- The seed loads veh1 as a superuser with no tenant bound: ADR-0014
  -- departs from ADR-0013 decision 2 here, sourcing tenant_id from NEW so
  -- the row is readable, rather than from app.current_tenant_id(), which
  -- would be NULL and hidden by tenant_isolation's own USING clause.
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh1
     AND al.action = 'INSERT' AND al.tenant_id = bac AND al.actor_id IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 43i: the seed-loaded unit has % readable unactored insert audit rows', n;
  END IF;
  RAISE NOTICE 'PASS  43i a row loaded with no actor bound is audited as loaded, not acted';

  -- (j) The fifth TY016 branch, probed on the visible, ACTIVE veh1 so no
  -- other rule refuses first: without this guard, a NULL status would fail
  -- as a bare 23502 the outbox retries forever (ADR-0012).
  BEGIN
    PERFORM app.set_vehicle_status(veh1, NULL::app.vehicle_status);
    RAISE EXCEPTION 'FAIL 43j: a status change with no status was accepted';
  EXCEPTION WHEN sqlstate 'TY016' THEN
    IF SQLERRM NOT LIKE '%names the status%' THEN
      RAISE EXCEPTION 'FAIL 43j: the empty target was refused by another rule: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  43j a status change naming no target status is refused as an input';
  END;

  -- (k) INV-2's converse: app.set_vehicle_status proves the unit is empty
  -- at disposal, but nothing keeps it empty afterwards, so a fit onto a
  -- disposed unit would strand a casing. vu is DISPOSED with its position
  -- free, and ty2 is IN_STOCK and never fitted, so this reaches the unit
  -- check rather than refusing on the casing's own state first.
  BEGIN
    PERFORM app.fit_tyre(ty2, vu, pos, 12.0, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 43k: a tyre was fitted to a disposed unit';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'this unit is disposed; nothing is fitted to it' THEN
      RAISE EXCEPTION 'FAIL 43k: the fit was refused by another rule: %', SQLERRM;
    END IF;
  END;
  -- The rotation guard sits on the same read, ahead of every input check,
  -- so the refusal names the unit, not the payload; a disposed unit has no
  -- open fitments to rotate by construction, so the moves here only need
  -- the shape the next check would look at.
  BEGIN
    PERFORM app.rotate_tyres(vu, jsonb_build_array(
      jsonb_build_object('tyre_id', ty2, 'to_position_id', pos),
      jsonb_build_object('tyre_id', ty,  'to_position_id', pos)));
    RAISE EXCEPTION 'FAIL 43k: a rotation ran on a disposed unit';
  EXCEPTION WHEN sqlstate 'TY012' THEN
    IF SQLERRM <> 'this unit is disposed; nothing is fitted to it' THEN
      RAISE EXCEPTION 'FAIL 43k: the rotation was refused by another rule: %', SQLERRM;
    END IF;
    RAISE NOTICE 'PASS  43k a disposed unit accepts neither a fit nor a rotation';
  END;

  -- (l) FR-AUD-001, ADR-0014: app.set_vehicle_status refuses a no-op
  -- transition (43c) so the log never claims a change that did not happen;
  -- the unit PATCH reaches the table as a COALESCE UPDATE, so this is
  -- written in the handler's own shape, not a bare self-assignment, to
  -- cover the path that actually produces the rows.
  SELECT count(*) INTO before_n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE';
  UPDATE app.vehicle v
     SET registration = COALESCE(NULL, v.registration),
         description  = COALESCE(NULL, v.description),
         body_type    = COALESCE(NULL, v.body_type)
   WHERE v.id = vu;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE';
  IF n <> before_n THEN
    RAISE EXCEPTION 'FAIL 43l: an update that changed nothing wrote % audit rows', n - before_n;
  END IF;
  -- The other half, and the reason the comparison cannot be over whole
  -- records: app.stamp_updated (000017) writes updated_at on every UPDATE
  -- before this trigger sees the row, so a guard that compared OLD to NEW
  -- entire would find both statements distinct and cover neither.
  UPDATE app.vehicle v SET description = 'T43 edited' WHERE v.id = vu;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE';
  IF n <> before_n + 1 THEN
    RAISE EXCEPTION 'FAIL 43l: a real edit wrote % audit rows, not one', n - before_n;
  END IF;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = vu AND al.action = 'UPDATE'
   ORDER BY al.id DESC LIMIT 1;
  IF a.after->>'description' IS DISTINCT FROM 'T43 edited'
     OR a.before->>'description' IS NOT DISTINCT FROM a.after->>'description' THEN
    RAISE EXCEPTION 'FAIL 43l: the audit row for a real edit reads % to %',
      a.before->>'description', a.after->>'description';
  END IF;
  RAISE NOTICE 'PASS  43l an update that changes nothing is not audited; a real edit is';
END $$;
ROLLBACK;

\echo '== 44. TYRE-92: the as-at register reads a dated tread only from its own date on (FR-VAL-020, CR-012, U10)'
BEGIN;
DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  tp   uuid := md5('t44tp')::uuid;   -- an onboarding figure with no date
  vp   uuid := md5('t44vp')::uuid;   -- TRAILER: owes no fitment odometer (TY009)
  sz1  uuid := md5('sz1')::uuid;
  cfg uuid; pos uuid; today date; r record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- The register slices its own window at the UTC day (000011:397), so the
  -- probe asks its questions in the same calendar the function answers in.
  today := (now() AT TIME ZONE 'UTC')::date;
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO pos FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, status)
  VALUES (vp, bac, 'T44-P', 'T44P GP', cfg, 'TRAILER', 'ACTIVE');
  -- last_tread_at deliberately NULL: this is the onboarding audit figure, the
  -- shape CR-012 says must keep answering for every date because absence of a
  -- measurement date is absence, not a date that fails a test.
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count,
                        purchase_price, cost_source, new_tread_mm, rand_per_mm,
                        last_tread_mm, last_tread_at, state)
  VALUES (tp, bac, 'T44TYREP', sz1, 'NEW', 0, 4319.91, 'INVOICE', 25.0,
          app.rand_per_mm(4319.91, 25.0, app.current_removal_threshold_mm()),
          12.0, NULL, 'IN_STOCK');

  -- (a) The undated figure prices yesterday. Without this first read the rest
  -- of the probe cannot tell "the guard removed the value" from "the tyre was
  -- never valued here".
  SELECT a.current_tread_mm, a.tread_source, a.tread_value INTO r
    FROM app.tyre_valuation_asof(today - 1) a WHERE a.tyre_id = tp;
  IF r.current_tread_mm IS DISTINCT FROM 12.0 OR r.tread_source IS DISTINCT FROM 'AUDIT'
     OR r.tread_value IS NULL THEN
    RAISE EXCEPTION 'FAIL 44a: an undated onboarding figure reads % / % / % as at yesterday',
      r.current_tread_mm, r.tread_source, r.tread_value;
  END IF;
  RAISE NOTICE 'PASS  44a an onboarding figure with no measurement date values every date';

  -- (b) FR-VAL-020, U10. The fit dates the column. Yesterday is then a date
  -- this casing had not been measured on, and the register declines to price
  -- it rather than pricing it at a depth nobody had read yet; today, the day
  -- of the measurement, carries the measured depth.
  PERFORM app.fit_tyre(tp, vp, pos, 20.0, 'MARK_OUTBOARD');
  SELECT a.current_tread_mm, a.tread_source, a.tread_value, a.casing_value INTO r
    FROM app.tyre_valuation_asof(today - 1) a WHERE a.tyre_id = tp;
  IF r.current_tread_mm IS NOT NULL OR r.tread_source IS NOT NULL
     OR r.tread_value IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 44b: a tread measured today priced yesterday at % / % / %',
      r.current_tread_mm, r.tread_source, r.tread_value;
  END IF;
  SELECT a.current_tread_mm, a.tread_source, a.tread_value INTO r
    FROM app.tyre_valuation_asof(today) a WHERE a.tyre_id = tp;
  IF r.current_tread_mm IS DISTINCT FROM 20.0 OR r.tread_source IS DISTINCT FROM 'AUDIT'
     OR r.tread_value IS NULL THEN
    RAISE EXCEPTION 'FAIL 44b: the day of the measurement reads % / % / %',
      r.current_tread_mm, r.tread_source, r.tread_value;
  END IF;
  RAISE NOTICE 'PASS  44b a dated tread prices its own date and declines the one before it';
END $$;
ROLLBACK;

-- (c) and (d) run in a transaction of their own because they read section
-- 18's whole-fixture counts back: the tyre (a) and (b) plant would be a
-- twenty-eighth row in the register and would move the very figure the pin
-- exists to hold still.
BEGIN;
DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  fitb uuid; odo bigint; r record; n int; c int;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- (c) Section 18's pins, against the writer that would move them. 2102BAC1
  -- is fitted in the fixture and its casing carries no dated tread, so a
  -- removal logged today is the first thing to date the column, and with an
  -- undated read of it, June 2026 and June 2021 both pick up today's 5.0 mm.
  -- Without the date guard this read answers 27 rows / 1 valued at
  -- 2026-06-01, against the 27/0 section 18 pins. The odometer is derived
  -- from the row rather than typed, so the removal is refused by the rule
  -- under test or by nothing.
  SELECT f.id, COALESCE(f.fitted_odometer, 0) + 100000 INTO fitb, odo
    FROM app.fitment f JOIN app.tyre t ON t.id = f.tyre_id
   WHERE t.display_code = '2102BAC1' AND f.removed_at IS NULL;
  IF fitb IS NULL THEN
    RAISE EXCEPTION 'FAIL 44c: the fixture has no open fitment on 2102BAC1 to remove';
  END IF;
  PERFORM app.remove_tyre(fitb, 'worn_to_threshold', 5.0, odo);
  -- Non-vacuity: the writer under test has to have fired, or (c) passes on a
  -- removal that never touched the column.
  SELECT t.last_tread_mm, t.last_tread_at INTO r
    FROM app.tyre t WHERE t.display_code = '2102BAC1';
  IF r.last_tread_mm IS DISTINCT FROM 5.0 OR r.last_tread_at IS NULL THEN
    RAISE EXCEPTION 'FAIL 44c: the removal did not date the column (% at %)',
      r.last_tread_mm, r.last_tread_at;
  END IF;
  SELECT count(*), count(a.tread_value) INTO n, c FROM app.tyre_valuation_asof('2026-06-01') a;
  IF n <> 27 OR c <> 0 THEN
    RAISE EXCEPTION 'FAIL 44c: as at 2026-06-01 rows=% valued=%, expected section 18''s 27/0', n, c;
  END IF;
  SELECT count(*), count(a.tread_value) INTO n, c FROM app.tyre_valuation_asof('2021-06-30') a;
  IF n <> 27 OR c <> 0 THEN
    RAISE EXCEPTION 'FAIL 44c: as at 2021-06-30 rows=% valued=%, expected 27/0', n, c;
  END IF;
  RAISE NOTICE 'PASS  44c a removal logged today leaves the historical as-at register where it was';

  -- (d) The rank between the two sources, which (c) cannot see: a reading
  -- outranks this column wherever one exists. 2102BAC1 was read on
  -- 2026-07-23, so the live register still prices it from that reading and
  -- the 5.0mm removal stays invisible there, the case the AUDIT branch is a
  -- fallback FROM.
  SELECT v.tread_source, v.current_tread_mm INTO r
    FROM app.v_tyre_valuation v WHERE v.display_code = '2102BAC1';
  IF r.tread_source IS DISTINCT FROM 'READING' THEN
    RAISE EXCEPTION 'FAIL 44d: the live register reads 2102BAC1 as % / %, not from its reading',
      r.tread_source, r.current_tread_mm;
  END IF;
  RAISE NOTICE 'PASS  44d a reading outranks the dated fallback in the live register';
END $$;
ROLLBACK;

\echo '== 45. TYRE-72: a rig is created once, ended once, and offered to the driver the same minute (FR-VEH-030/031, FR-INS-062, INV-4, U5-U9)'
BEGIN;
DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  h     uuid := md5('t45h')::uuid;   -- HORSE, heads the rig under test
  hx    uuid := md5('t45hx')::uuid;  -- HORSE, never in a rig: the motive for every refusal probe
  hz    uuid := md5('t45hz')::uuid;  -- LIGHT, never in a rig: the non-trailer a probe tries to tow
  ta    uuid := md5('t45ta')::uuid;  -- TRAILER
  tb    uuid := md5('t45tb')::uuid;  -- TRAILER
  tp    uuid := md5('t45tp')::uuid;  -- TRAILER, PARKED, free: U9's positive control at 45c
  drv   uuid := md5('t45drv')::uuid;
  ctl   uuid := md5('t45ctl')::uuid; -- planted, not assumed: created_by is a composite FK (000017)
  cfg uuid; rig uuid; rig2 uuid; tz text; today date; r record; n int;
  msg text;
BEGIN
  -- TimeZone pinned to UTC: BAC is UTC+2, so a check that read the session
  -- zone instead of the tenant's would fail here rather than pass by luck
  -- (lesson 2026-09-01).
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  today := app.tenant_today(tz);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  -- Every fixture unit is in comb1, so a refusal probe that borrows one meets
  -- INV-4 before the rule it means to exercise. Each probe below names units
  -- that are in no open rig, so the refusal it pins is the one it claims.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (h,  bac, 'T45-H',  'T45H GP',  cfg, 'HORSE',   'ACTIVE'),
         (hx, bac, 'T45-HX', 'T45HX GP', cfg, 'HORSE',   'ACTIVE'),
         (hz, bac, 'T45-HZ', 'T45HZ GP', cfg, 'LIGHT',   'ACTIVE'),
         (ta, bac, 'T45-TA', 'T45TA GP', cfg, 'TRAILER', 'ACTIVE'),
         (tb, bac, 'T45-TB', 'T45TB GP', cfg, 'TRAILER', 'PARKED'),
         (tp, bac, 'T45-TP', 'T45TP GP', cfg, 'TRAILER', 'PARKED');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (drv, bac, 't45drv@example.invalid', 'T45 Driver', 'DRIVER'),
         (ctl, bac, 't45ctl@example.invalid', 'T45 Controller', 'CONTROLLER');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h, drv, now() - interval '1 minute');
  PERFORM set_config('app.actor_id', ctl::text, true);

  -- (a) Create. The motive is member 1 (U7), the towed follow in the order
  -- given, effective_from is now() for today (U8), and the driver assigned
  -- to the horse can now read both trailers for capture (FR-AUT-005/D3).
  rig := app.create_combination(h,
           jsonb_build_array(jsonb_build_object('vehicle_id', ta, 'descriptor', 'front'),
                             jsonb_build_object('vehicle_id', tb, 'descriptor', NULL)));
  SELECT c.effective_from, c.effective_to, c.motive_vehicle_id INTO r FROM app.combination c WHERE c.id = rig;
  IF r.motive_vehicle_id <> h OR r.effective_to IS NOT NULL
     OR r.effective_from < now() - interval '5 seconds' OR r.effective_from > now() THEN
    RAISE EXCEPTION 'FAIL 45a: rig row reads % / % / %', r.motive_vehicle_id, r.effective_from, r.effective_to;
  END IF;
  SELECT string_agg(cm.vehicle_id::text || ':' || cm.sequence || ':' || COALESCE(cm.descriptor, '-'), ',' ORDER BY cm.sequence)
    INTO msg FROM app.combination_member cm WHERE cm.combination_id = rig;
  IF msg IS DISTINCT FROM (h::text || ':1:-,' || ta::text || ':2:front,' || tb::text || ':3:-') THEN
    RAISE EXCEPTION 'FAIL 45a: members read %', msg;
  END IF;
  PERFORM set_config('app.actor_id', drv::text, true);
  SELECT count(*) INTO n FROM app.v_capture_vehicle cv WHERE cv.vehicle_id IN (h, ta, tb);
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL 45a: the horse''s driver reads % of 3 rig units for capture', n;
  END IF;
  PERFORM set_config('app.actor_id', ctl::text, true);
  RAISE NOTICE 'PASS  45a a rig is created with the motive first and the driver reads its members';

  -- (b) INV-4 through the function, naming the rig the trailer is in, and
  -- through a raw insert, which meets the trigger backstop. The motive is
  -- the free horse, so the refusal is the trailer's and not the motive's.
  BEGIN
    PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('vehicle_id', ta)));
    RAISE EXCEPTION 'FAIL 45b: a trailer joined a second open rig';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T45-TA is in the rig headed by T45-H; end that rig first' THEN
      RAISE EXCEPTION 'FAIL 45b: wrong message %', msg;
    END IF;
  END;
  -- This raw insert meets only the trigger's open-rig branch; its history
  -- branch (a start before the unit's last membership ended) is met at 45e.
  BEGIN
    INSERT INTO app.combination (id, tenant_id, motive_vehicle_id) VALUES (md5('t45raw')::uuid, bac, hx);
    INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
    VALUES (bac, md5('t45raw')::uuid, ta, 2);
    RAISE EXCEPTION 'FAIL 45b: a raw insert put a trailer in two open rigs';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN NULL;
  END;
  RAISE NOTICE 'PASS  45b a unit is in at most one open rig, by function and by trigger (INV-4)';

  -- (c) Kinds and shape (U9, U10). Each probe pins its message text, so a
  -- refusal raised by INV-4 (the membership trigger) would fail the match
  -- rather than pass: hx and hz are in no rig; ta and tb are members of
  -- (a)'s still-open rig until it ends at 45e.
  BEGIN
    PERFORM app.create_combination(ta, jsonb_build_array(jsonb_build_object('vehicle_id', tb)));
    RAISE EXCEPTION 'FAIL 45c: a trailer headed a rig';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a rig is headed by a horse, rigid or light vehicle; T45-TA is a trailer' THEN
      RAISE EXCEPTION 'FAIL 45c: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('vehicle_id', hz)));
    RAISE EXCEPTION 'FAIL 45c: a light vehicle was towed';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'only a trailer is towed; T45-HZ is a light' THEN
      RAISE EXCEPTION 'FAIL 45c: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.create_combination(hx, '[]'::jsonb);
    RAISE EXCEPTION 'FAIL 45c: a rig with nothing towed was created';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a rig has at least one towed unit; a unit on its own needs no rig' THEN
      RAISE EXCEPTION 'FAIL 45c: wrong message %', msg;
    END IF;
  END;
  -- U9 positive control: PARKED pauses a unit's inspection schedule
  -- (FR-VEH-006), not the yard's ability to couple it. A rig towing a
  -- PARKED trailer is created, not refused. hz heads it (a LIGHT unit is a
  -- valid motive, U9) and is never reused as a motive elsewhere in this
  -- section, so leaving this rig open does not disturb a later probe.
  PERFORM app.create_combination(hz, jsonb_build_array(jsonb_build_object('vehicle_id', tp)));
  BEGIN
    PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('vehicle_id', tb), jsonb_build_object('vehicle_id', tb)));
    RAISE EXCEPTION 'FAIL 45c: a trailer was named twice';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T45-TB is named twice in this rig' THEN
      RAISE EXCEPTION 'FAIL 45c: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('descriptor', 'x')));
    RAISE EXCEPTION 'FAIL 45c: a towed entry with no vehicle was accepted';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'every towed unit names a vehicle' THEN
      RAISE EXCEPTION 'FAIL 45c: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  45c a rig is a horse, rigid or light unit towing distinct trailers, PARKED included';

  -- (d) The date rule (U8): tomorrow is refused; yesterday is tenant-local
  -- midnight, never a bare cast. Needs a free horse: end (a)'s rig first
  -- at (e) below, so this probe uses a second horse.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (md5('t45h2')::uuid, bac, 'T45-H2', 'T45H2 GP', cfg, 'RIGID', 'ACTIVE'),
         (md5('t45tc')::uuid, bac, 'T45-TC', 'T45TC GP', cfg, 'TRAILER', 'ACTIVE');
  BEGIN
    PERFORM app.create_combination(md5('t45h2')::uuid,
              jsonb_build_array(jsonb_build_object('vehicle_id', md5('t45tc')::uuid)), today + 1);
    RAISE EXCEPTION 'FAIL 45d: a rig was set for tomorrow';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a rig is set as at today or earlier, never in the future' THEN
      RAISE EXCEPTION 'FAIL 45d: wrong message %', msg;
    END IF;
  END;
  rig2 := app.create_combination(md5('t45h2')::uuid,
            jsonb_build_array(jsonb_build_object('vehicle_id', md5('t45tc')::uuid)), today - 1);
  SELECT c.effective_from INTO r FROM app.combination c WHERE c.id = rig2;
  IF r.effective_from IS DISTINCT FROM ((today - 1)::timestamp AT TIME ZONE tz) THEN
    RAISE EXCEPTION 'FAIL 45d: a rig set yesterday starts at %, not tenant-local midnight', r.effective_from;
  END IF;
  IF (r.effective_from AT TIME ZONE tz)::date IS DISTINCT FROM today - 1
     OR (r.effective_from AT TIME ZONE tz)::time <> '00:00' THEN
    RAISE EXCEPTION 'FAIL 45d: a rig set yesterday reads % in the tenant zone, not midnight', r.effective_from;
  END IF;
  -- Session TimeZone is pinned to UTC above; BAC is Africa/Johannesburg
  -- (UTC+2), so a bare cast of "yesterday" in the session zone lands on a
  -- different instant than the tenant-zone midnight above. This catches the
  -- regression the 2026-09-01 lesson names directly, on any host.
  IF r.effective_from = (today - 1)::timestamptz THEN
    RAISE EXCEPTION 'FAIL 45d: yesterday was cast in the session zone, not the tenant''s';
  END IF;
  RAISE NOTICE 'PASS  45d a rig starts today at now() or on an earlier day at tenant-local midnight, never tomorrow';

  -- (e) End: effective_to is stamped, the capture read narrows, the trailer
  -- is free to join another rig, and ending twice or before the start is
  -- refused.
  BEGIN
    PERFORM app.end_combination(rig, today - 1);
    RAISE EXCEPTION 'FAIL 45e: a rig ended before it started';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN NULL;
  END;
  PERFORM app.end_combination(rig);
  SELECT c.effective_to INTO r FROM app.combination c WHERE c.id = rig;
  IF r.effective_to IS NULL OR r.effective_to > now() THEN
    RAISE EXCEPTION 'FAIL 45e: effective_to reads %', r.effective_to;
  END IF;
  BEGIN
    PERFORM app.end_combination(rig);
    RAISE EXCEPTION 'FAIL 45e: an ended rig was ended again';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    -- combination_is_written_once (the trigger) also raises TY017 on this
    -- UPDATE, so an unpinned catch here would be vacuous against a handler
    -- that never runs: the message is what proves end_combination's own
    -- "already ended" check fired first.
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'this rig ended on %' THEN
      RAISE EXCEPTION 'FAIL 45e: wrong message %', msg;
    END IF;
  END;
  PERFORM set_config('app.actor_id', drv::text, true);
  SELECT count(*) INTO n FROM app.v_capture_vehicle cv WHERE cv.vehicle_id IN (ta, tb);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 45e: the driver still reads % trailer(s) of an ended rig', n;
  END IF;
  PERFORM set_config('app.actor_id', ctl::text, true);
  PERFORM app.create_combination(h, jsonb_build_array(jsonb_build_object('vehicle_id', ta)));
  -- A start before the previous membership's end is refused, not clamped:
  -- T45-TB left (a)'s rig at now(), so a rig starting yesterday cannot hold
  -- it. The free horse heads the probe so the refusal is the trailer's.
  BEGIN
    PERFORM app.create_combination(hx,
              jsonb_build_array(jsonb_build_object('vehicle_id', tb)), today - 1);
    RAISE EXCEPTION 'FAIL 45e: a rig started before its trailer left the last one';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'T45-TB left the rig headed by T45-H on %; this rig cannot start before that' THEN
      RAISE EXCEPTION 'FAIL 45e: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  45e a rig ends once, frees its trailers, and history stays in order';

  -- (f) Written once (U6): an open rig only ends; an ended rig is frozen;
  -- a member row is never updated (revoked) and never deleted (000018).
  SELECT c.id INTO rig2 FROM app.combination c WHERE c.motive_vehicle_id = h AND c.effective_to IS NULL;
  BEGIN
    UPDATE app.combination SET motive_vehicle_id = md5('veh1')::uuid WHERE id = rig2;
    RAISE EXCEPTION 'FAIL 45f: an open rig''s motive was edited';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN NULL;
  END;
  BEGIN
    UPDATE app.combination SET effective_to = NULL WHERE id = rig;
    RAISE EXCEPTION 'FAIL 45f: an ended rig was reopened';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN NULL;
  END;
  -- U6, by raw INSERT this time: combination_member_in_order refuses growing
  -- an ended rig's membership before it ever reaches the open-rig-conflict
  -- check, so this is a genuinely free trailer (tb), not one INV-4 would
  -- refuse for an unrelated reason.
  BEGIN
    INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
    VALUES (bac, rig, tb, 3);
    RAISE EXCEPTION 'FAIL 45f: a member was added to an ended rig';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'an ended rig''s members are never changed' THEN
      RAISE EXCEPTION 'FAIL 45f: wrong message %', msg;
    END IF;
  END;
  -- WHERE false: privilege is checked at rewrite time against the table, not
  -- the predicate, so this proves the REVOKE without depending on rig2 still
  -- holding the rows it did when this section began.
  BEGIN
    UPDATE app.combination_member SET sequence = 9 WHERE false;
    RAISE EXCEPTION 'FAIL 45f: app role can UPDATE app.combination_member';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM app.combination_member WHERE false;
    RAISE EXCEPTION 'FAIL 45f: app role can DELETE app.combination_member';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS  45f a rig is written once and ended once; members are never updated or deleted, and never added to an ended rig';

  -- (g) Cross-tenant, through both functions, with the pinned message: a
  -- composite-FK death (000004/000017) would also be red but not TY012, so
  -- the message is the discriminating assert (lesson 2026-09-01). h/ta stay
  -- out of the probe (already in the open rig from 45e); hx/tb are free,
  -- and the same two calls succeeding for the owning tenant is the control.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  BEGIN
    PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('vehicle_id', tb)));
    RAISE EXCEPTION 'FAIL 45g: tenant 2 set a rig on tenant 1''s horse';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'no such unit in this fleet' THEN RAISE EXCEPTION 'FAIL 45g: wrong message %', msg; END IF;
  END;
  BEGIN
    PERFORM app.end_combination(rig2);
    RAISE EXCEPTION 'FAIL 45g: tenant 2 ended tenant 1''s rig';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'no such rig in this fleet' THEN RAISE EXCEPTION 'FAIL 45g: wrong message %', msg; END IF;
  END;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM app.create_combination(hx, jsonb_build_array(jsonb_build_object('vehicle_id', tb)));
  PERFORM app.end_combination(rig2);
  RAISE NOTICE 'PASS  45g another tenant''s units and rigs do not exist here';

  -- (h) Audited (ADR-0014, U12): the create wrote INSERT rows for the rig
  -- and each member under the bound actor; the end wrote an UPDATE row.
  SELECT count(*) FILTER (WHERE a.action = 'INSERT') INTO n FROM app.audit_log a
   WHERE a.entity_type = 'combination' AND a.entity_id = rig AND a.actor_id = ctl;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 45h: % INSERT audit rows for the rig, expected 1', n; END IF;
  SELECT count(*) FILTER (WHERE a.action = 'UPDATE') INTO n FROM app.audit_log a
   WHERE a.entity_type = 'combination' AND a.entity_id = rig AND a.actor_id = ctl;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 45h: % UPDATE audit rows for the rig, expected 1', n; END IF;
  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.entity_type = 'combination_member' AND a.action = 'INSERT'
     AND a.entity_id IN (SELECT cm.id FROM app.combination_member cm WHERE cm.combination_id = rig);
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL 45h: % member audit rows, expected 3', n; END IF;
  RAISE NOTICE 'PASS  45h a rig''s creation and its end are audited';
END $$;
ROLLBACK;

\echo '== 46. TYRE-90: an inspection task is scheduled for a driver who can capture the unit, seen on DriverHome, and closed by the submit (FR-INS-048/051/052/053, FR-AUT-005, U4, U11, U12)'
BEGIN;
DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  t2    uuid := '22222222-2222-2222-2222-222222222222';
  h     uuid := md5('t46h')::uuid;    -- HORSE, heads the rig under test; drv's own unit
  ta    uuid := md5('t46ta')::uuid;   -- TRAILER in h's rig: reachable by drv only through the rig (U4)
  hx    uuid := md5('t46hx')::uuid;   -- HORSE, drv3's unit, never in a rig
  hd    uuid := md5('t46hd')::uuid;   -- HORSE, DISPOSED: the retired-unit probe
  drv   uuid := md5('t46drv')::uuid;  -- on a trip on h
  drv2  uuid := md5('t46drv2')::uuid; -- on no trip
  drv3  uuid := md5('t46drv3')::uuid; -- on a trip on hx, then deactivated
  ctl   uuid := md5('t46ctl')::uuid;  -- planted, not assumed: created_by is a composite FK (000017)
  t2drv uuid := md5('t46t2drv')::uuid;
  t2ctl uuid := md5('t46t2ctl')::uuid;
  cfg uuid; rig uuid; task uuid; task_ta uuid; task_ctl uuid; tz text; today date; r record; n int;
  msg text; posl uuid; res record; cu uuid := gen_random_uuid();
BEGIN
  -- Session zone pinned to UTC so a due instant computed in the session zone
  -- instead of the tenant's lands on a different instant on any host
  -- (BAC is Africa/Johannesburg, UTC+2; section 45's reasoning).
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  today := app.tenant_today(tz);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (h,  bac, 'T46-H',  'T46H GP',  cfg, 'HORSE',   'ACTIVE'),
         (ta, bac, 'T46-TA', 'T46TA GP', cfg, 'TRAILER', 'ACTIVE'),
         (hx, bac, 'T46-HX', 'T46HX GP', cfg, 'HORSE',   'ACTIVE'),
         (hd, bac, 'T46-HD', 'T46HD GP', cfg, 'HORSE',   'DISPOSED');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (drv,  bac, 't46drv@example.invalid',  'T46 Driver',     'DRIVER'),
         (drv2, bac, 't46drv2@example.invalid', 'T46 Driver Two', 'DRIVER'),
         (drv3, bac, 't46drv3@example.invalid', 'T46 Driver Three', 'DRIVER'),
         (ctl,  bac, 't46ctl@example.invalid',  'T46 Controller', 'CONTROLLER');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h, drv, now() - interval '1 minute'), (bac, hx, drv3, now() - interval '1 minute');
  PERFORM set_config('app.actor_id', ctl::text, true);
  rig := app.create_combination(h, jsonb_build_array(jsonb_build_object('vehicle_id', ta)));

  -- (a) The predicate, asked about someone else (U4, FR-AUT-005 as amended
  -- by D3 and TYRE-326): drv reaches h by the trip and ta through the rig;
  -- drv2 reaches nothing; and v_capture_vehicle answers the same set for the
  -- acting driver. The capture read and the predicate are one rule
  -- (FR-AUT-005/D3).
  IF NOT app.user_could_capture(drv, h, now(), now())  THEN RAISE EXCEPTION 'FAIL 46a: the trip driver cannot capture the horse'; END IF;
  IF NOT app.user_could_capture(drv, ta, now(), now()) THEN RAISE EXCEPTION 'FAIL 46a: the horse''s driver cannot capture its trailer'; END IF;
  IF app.user_could_capture(drv2, h, now(), now())     THEN RAISE EXCEPTION 'FAIL 46a: a driver on no trip can capture the horse'; END IF;
  IF app.user_could_capture(drv, hx, now(), now())     THEN RAISE EXCEPTION 'FAIL 46a: the driver can capture a unit their trip does not cover'; END IF;
  SELECT string_agg(ucv.vehicle_id::text || '<' || ucv.via_vehicle_id::text, ',' ORDER BY ucv.vehicle_id::text)
    INTO msg FROM app.v_user_capture_vehicle ucv WHERE ucv.user_id = drv;
  IF msg IS DISTINCT FROM (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY[h::text || '<' || h::text, ta::text || '<' || h::text]) x) THEN
    RAISE EXCEPTION 'FAIL 46a: the driver''s capture set reads %', msg;
  END IF;
  PERFORM set_config('app.actor_id', drv::text, true);
  SELECT count(*) INTO n FROM app.v_capture_vehicle cv WHERE cv.vehicle_id IN (h, ta, hx);
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 46a: v_capture_vehicle reads % of the driver''s 2 units', n; END IF;
  PERFORM set_config('app.actor_id', ctl::text, true);
  RAISE NOTICE 'PASS  46a a user can capture a unit by its trip or through the rig its horse heads, and the capture read agrees';

  -- (b) Schedule (FR-INS-051/052): OPEN, assigned, requested and created by
  -- the controller, due at the tenant-local end of today, not overdue now
  -- but overdue once the tenant's day ends, and the trailer's task goes to the
  -- horse's driver (U4, FR-INS-053). The driver then reads both on their
  -- own list (FR-INS-048).
  task := app.create_inspection_task(h, drv);
  SELECT t.state, t.assigned_user_id, t.requested_by, t.created_by, t.due_at, t.overdue, t.schedule_id
    INTO STRICT r FROM app.v_inspection_task t WHERE t.id = task;
  IF r.state <> 'OPEN' OR r.assigned_user_id <> drv OR r.requested_by <> ctl OR r.created_by <> ctl
     OR r.schedule_id IS NOT NULL OR r.overdue THEN
    RAISE EXCEPTION 'FAIL 46b: task row reads % / % / % / % / overdue %', r.state, r.assigned_user_id, r.requested_by, r.created_by, r.overdue;
  END IF;
  -- The instant itself, not merely the day it falls in: the rule is the last
  -- microsecond of the tenant's day, so a coarser end-of-day would still sit
  -- inside the day and pass a range check. r.due_at > now() is the separate
  -- claim that a task due today is not overdue at creation.
  IF r.due_at <> ((today + 1)::timestamp AT TIME ZONE tz) - interval '1 microsecond'
     OR r.due_at <= now() THEN
    RAISE EXCEPTION 'FAIL 46b: a task due today is due at %, not the tenant-local end of today', r.due_at;
  END IF;
  task_ta := app.create_inspection_task(ta, drv);
  PERFORM set_config('app.actor_id', drv::text, true);
  SELECT count(*) INTO n FROM app.v_my_inspection_task t WHERE t.id IN (task, task_ta) AND NOT t.overdue;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 46b: the driver reads % of their 2 open tasks', n; END IF;
  PERFORM set_config('app.actor_id', ctl::text, true);
  RAISE NOTICE 'PASS  46b a task is scheduled OPEN for today, for the unit''s driver or the horse''s, and the driver reads it';

  -- (c) Refusals, each pinned by message so a refusal from another branch
  -- cannot pass for the one under test. The rig leg is proven live: the
  -- trailer's task for drv succeeded at (b); after the rig ends the same
  -- call is refused, so the predicate is reading the rig and not merely the
  -- unit.
  BEGIN
    PERFORM app.create_inspection_task(h, drv2);
    RAISE EXCEPTION 'FAIL 46c: a task was scheduled for a driver not assigned to the unit';
  EXCEPTION WHEN SQLSTATE 'TY018' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T46 Driver Two is not assigned to T46-H or to the horse pulling it' THEN
      RAISE EXCEPTION 'FAIL 46c: wrong message %', msg;
    END IF;
  END;
  PERFORM app.end_combination(rig);
  BEGIN
    PERFORM app.create_inspection_task(ta, drv);
    RAISE EXCEPTION 'FAIL 46c: the horse''s driver was scheduled on a trailer the horse no longer pulls';
  EXCEPTION WHEN SQLSTATE 'TY018' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T46 Driver is not assigned to T46-TA or to the horse pulling it' THEN
      RAISE EXCEPTION 'FAIL 46c: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.create_inspection_task(hd, drv);
    RAISE EXCEPTION 'FAIL 46c: a task was scheduled on a disposed unit';
  EXCEPTION WHEN SQLSTATE 'TY018' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T46-HD is disposed; a retired unit is not inspected' THEN
      RAISE EXCEPTION 'FAIL 46c: wrong message %', msg;
    END IF;
  END;
  -- Capture never reads app_user.active, which keeps no history, so a
  -- deactivation leaves drv3's trip covering hx; withActor refuses an
  -- inactive actor before any query runs (ADR-0011). The write still
  -- refuses an inactive driver by name.
  IF NOT app.user_could_capture(drv3, hx, now(), now()) THEN
    RAISE EXCEPTION 'FAIL 46c: an active driver on the unit''s trip fails the predicate';
  END IF;
  UPDATE app.app_user SET active = false WHERE id = drv3;
  IF NOT app.user_could_capture(drv3, hx, now(), now()) THEN
    RAISE EXCEPTION 'FAIL 46c: the predicate read the active flag';
  END IF;
  BEGIN
    PERFORM app.create_inspection_task(hx, drv3);
    RAISE EXCEPTION 'FAIL 46c: a task was scheduled for a deactivated driver';
  EXCEPTION WHEN SQLSTATE 'TY018' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'T46 Driver Three is no longer active' THEN
      RAISE EXCEPTION 'FAIL 46c: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  46c an unassigned, rig-less, retired or deactivated target is refused by name';

  -- (d) The due-day rule: yesterday is refused, never clamped; tomorrow is
  -- the tenant-local end of tomorrow.
  BEGIN
    PERFORM app.create_inspection_task(h, drv, today - 1);
    RAISE EXCEPTION 'FAIL 46d: a task was scheduled for yesterday';
  EXCEPTION WHEN SQLSTATE 'TY018' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a task is due today or later, never in the past' THEN
      RAISE EXCEPTION 'FAIL 46d: wrong message %', msg;
    END IF;
  END;
  task_ctl := app.create_inspection_task(h, drv, today + 1);
  SELECT t.due_at, t.overdue INTO STRICT r FROM app.v_inspection_task t WHERE t.id = task_ctl;
  IF r.due_at <> ((today + 2)::timestamp AT TIME ZONE tz) - interval '1 microsecond'
     OR r.overdue THEN
    RAISE EXCEPTION 'FAIL 46d: a task due tomorrow is due at %', r.due_at;
  END IF;
  RAISE NOTICE 'PASS  46d a task is due today or later at the tenant-local end of its day, never yesterday';

  -- (e) Closed by the submit that names it (FR-INS-052, 000023): the horse's
  -- task completes citing the inspection; the second task on the same unit
  -- stays OPEN, which is the control that the close is by id and not by
  -- unit. Section 31's minimal payload shape; BAC configures three treads.
  SELECT p.id INTO posl FROM app.position p WHERE p.configuration_id = cfg AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  PERFORM set_config('app.actor_id', drv::text, true);
  SELECT * INTO res FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', cu, 'vehicle_id', h, 'task_id', task,
    'started_at', now() - interval '150 seconds', 'submitted_at', now(),
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', h, 'position_id', posl,
                         'pressure_kpa', 800, 'treads', jsonb_build_array(8.0, 8.5, 8.2)))));
  SELECT t.state, t.completed_inspection_id INTO r FROM app.inspection_task t WHERE t.id = task;
  IF r.state <> 'COMPLETED' OR r.completed_inspection_id IS DISTINCT FROM res.inspection_id THEN
    RAISE EXCEPTION 'FAIL 46e: after the submit the task reads % citing %', r.state, r.completed_inspection_id;
  END IF;
  SELECT t.state INTO STRICT r FROM app.inspection_task t WHERE t.id = task_ctl;
  IF r.state <> 'OPEN' THEN RAISE EXCEPTION 'FAIL 46e: a task the submit did not name was closed'; END IF;
  SELECT count(*) INTO n FROM app.v_my_inspection_task t WHERE t.id = task;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 46e: the driver still reads a completed task'; END IF;
  PERFORM set_config('app.actor_id', ctl::text, true);
  RAISE NOTICE 'PASS  46e the submit that names the task completes it citing the inspection, and no other';

  -- (f) Append-only where it matters (000018): a task is never deleted by the
  -- app role. UPDATE stays granted because the submit's close IS an update.
  BEGIN
    DELETE FROM app.inspection_task WHERE false;
    RAISE EXCEPTION 'FAIL 46f: app role can DELETE app.inspection_task';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%permission denied for table inspection_task%' THEN
      RAISE EXCEPTION 'FAIL 46f: refused for another reason: %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  46f a task is never deleted';

  -- (g) Cross-tenant, three ways, each with a control proving the refusal
  -- was tenant-caused (FR-TEN-004, NFR-SEC-004). Through the function, a
  -- composite-FK death (000012/000004) would also be red but not TY012, so
  -- code and message discriminate; the raw INSERT is refused only by
  -- tenant_isolation's WITH CHECK, whose message is pinned since an unpinned
  -- catch would pass on app.audit_log's own 42501 instead (TYRE-75).
  PERFORM set_config('app.tenant_id', t2::text, true);
  -- Unbound with '' (app.current_actor_id is nullif(..., ''), 000001:32):
  -- with BAC's controller still bound, the tenant-2 plants below would
  -- default created_by to it and die 23503 on the composite FK (000017).
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (t2drv, t2, 't46t2drv@example.invalid', 'T46 Tenant Two Driver', 'DRIVER'),
         (t2ctl, t2, 't46t2ctl@example.invalid', 'T46 Tenant Two Controller', 'CONTROLLER');
  PERFORM set_config('app.actor_id', t2ctl::text, true);
  BEGIN
    PERFORM app.create_inspection_task(h, drv);
    RAISE EXCEPTION 'FAIL 46g: tenant 2 scheduled a task on tenant 1''s unit';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'no such unit in this fleet' THEN RAISE EXCEPTION 'FAIL 46g: wrong message %', msg; END IF;
  END;
  BEGIN
    PERFORM app.create_inspection_task(md5('t2veh1')::uuid, drv);
    RAISE EXCEPTION 'FAIL 46g: tenant 2 scheduled tenant 1''s driver';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'no such user in this fleet' THEN RAISE EXCEPTION 'FAIL 46g: wrong message %', msg; END IF;
  END;
  -- The predicate itself, below the refusals that name it: under tenant 2's
  -- session app.v_capture_span must answer no row for BAC's pair, so
  -- user_could_capture is false rather than reading BAC's trip.
  IF app.user_could_capture(drv, h, now(), now()) THEN
    RAISE EXCEPTION 'FAIL 46g: the predicate answers true across tenants';
  END IF;
  -- Thabo's fixture trip covers md5('t2veh1'), the fixture's ACTIVE tenant-2
  -- horse, so the control schedules him.
  PERFORM app.create_inspection_task(md5('t2veh1')::uuid, md5('driver2')::uuid);
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', ctl::text, true);
  BEGIN
    INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, assigned_user_id, requested_by, created_by)
    VALUES (t2, md5('t2veh1')::uuid, now() + interval '1 day', t2drv, t2ctl, t2ctl);
    RAISE EXCEPTION 'FAIL 46g: a raw insert landed a task in another tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security policy for table "inspection_task"%' THEN
      RAISE EXCEPTION 'FAIL 46g: refused by something other than inspection_task''s own policy: %', msg;
    END IF;
  END;
  PERFORM app.create_inspection_task(h, drv);
  RAISE NOTICE 'PASS  46g another tenant''s units, users and tasks do not exist here, and a task cannot be aimed at another tenant';

  -- (h) Audited (ADR-0014, U12): the schedule wrote an INSERT row under the
  -- controller; the submit's close wrote an UPDATE row under the driver.
  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.entity_type = 'inspection_task' AND a.entity_id = task AND a.action = 'INSERT' AND a.actor_id = ctl;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 46h: % INSERT audit rows for the task, expected 1', n; END IF;
  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.entity_type = 'inspection_task' AND a.entity_id = task AND a.action = 'UPDATE' AND a.actor_id = drv;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 46h: % UPDATE audit rows for the task, expected 1 from the submit', n; END IF;
  RAISE NOTICE 'PASS  46h a task''s scheduling and its completion are audited';
END $$;
ROLLBACK;

\echo '== 47. TYRE-101: a rotation moves casings across the units of one open rig (FR-FIT-010, BR-FIT-005, U15-U23)'
BEGIN;
DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  -- A TRAILER: 000025 asks a horse for an odometer before any of the four
  -- functions below reaches its tread bound, and this section is about the
  -- bound (U21).
  va   uuid := md5('t47av')::uuid;
  d_rt uuid := md5('t47art')::uuid;
  sz1  uuid := md5('sz1')::uuid;
  typ  uuid := md5('t47atyp')::uuid;   -- the rotation pair, fitted and left fitted
  tyq  uuid := md5('t47atyq')::uuid;
  tyr  uuid := md5('t47atyr')::uuid;   -- the fit target: every call on it is refused
  tys  uuid := md5('t47atys')::uuid;   -- the casing whose open retread job both probes reuse
  cfg uuid; tz text; p1 uuid; p2 uuid; p3 uuid;
  r record; fn record; fit1 uuid; job uuid; mx numeric; bound_re text;
  m1 text; m2 text; m3 text; m4 text;
  n1 text; n2 text; n3 text; n4 text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO p1 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  SELECT p.id INTO p2 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '2';
  SELECT p.id INTO p3 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  IF p1 IS NULL OR p2 IS NULL OR p3 IS NULL THEN
    RAISE EXCEPTION 'FAIL: section 47 cannot resolve the positions it tests against';
  END IF;

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (va, bac, 'T47-AV', 'T47AV GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'T47 Retreaders', 'RETREADER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (typ, bac, 'T47ATYREP', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyq, bac, 'T47ATYREQ', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyr, bac, 'T47ATYRER', sz1, 'NEW', 0, 'IN_STOCK'),
    (tys, bac, 'T47ATYRES', sz1, 'NEW', 0, 'REMOVED');
  SELECT * INTO r FROM app.fit_tyre(typ, va, p1, 12.0, 'MARK_OUTBOARD');
  fit1 := r.fitment_id;
  PERFORM app.fit_tyre(tyq, va, p2, 12.0, 'MARK_OUTBOARD');
  SELECT * INTO r FROM app.dispatch_tyre(tys, 'AT_RETREADER', d_rt);
  job := r.retread_job_id;

  -- (a) U21: one bound, four voices. Each refusal is caught for its message
  -- rather than its code alone, because a single shared message would be the
  -- shape of four call sites collapsed into one refusal, which is what the
  -- workshop loses if the bound is shared carelessly (FR-FIT-001, FR-FIT-007,
  -- FR-FIT-010, FR-FIT-022). The bound is read from the function, so the
  -- probe cannot restate the number it exists to stop being restated.
  mx := app.max_tread_mm();
  IF mx IS NULL OR mx <= 0 THEN
    RAISE EXCEPTION 'FAIL 47a: the shared tread ceiling reads %, not a positive depth', mx;
  END IF;
  BEGIN
    PERFORM app.fit_tyre(tyr, va, p3, mx + 0.1, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 47a: a fit above the shared ceiling was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m1 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.remove_tyre(fit1, 'damage', mx + 0.1);
    RAISE EXCEPTION 'FAIL 47a: a removal above the shared ceiling was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m2 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.rotate_tyres(va,
      jsonb_build_array(
        jsonb_build_object('tyre_id', typ, 'to_position_id', p2, 'tread_mm', mx + 0.1),
        jsonb_build_object('tyre_id', tyq, 'to_position_id', p1, 'tread_mm', mx + 0.1)),
      NULL::jsonb, now());
    RAISE EXCEPTION 'FAIL 47a: a rotation above the shared ceiling was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m3 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.log_retread_return(job, app.tenant_today(tz), true, 'T47-RPT-A',
                                   100.00, mx + 0.1, 500.00);
    RAISE EXCEPTION 'FAIL 47a: a retread return above the shared ceiling was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m4 = MESSAGE_TEXT;
  END;
  IF m1 = m2 OR m1 = m3 OR m1 = m4 OR m2 = m3 OR m2 = m4 OR m3 = m4 THEN
    RAISE EXCEPTION 'FAIL 47a: two of the four ceiling refusals share a voice: % / % / % / %',
      m1, m2, m3, m4;
  END IF;
  -- The bound reaches the message from the function rather than as a fifth
  -- copy of the number (U21): a literal in a message is still a literal.
  IF strpos(m1, mx::text) = 0 OR strpos(m2, mx::text) = 0
     OR strpos(m3, mx::text) = 0 OR strpos(m4, mx::text) = 0 THEN
    RAISE EXCEPTION 'FAIL 47a: a ceiling refusal does not carry the bound %: % / % / % / %',
      mx, m1, m2, m3, m4;
  END IF;
  -- The same rule at the source (U21): four sites carry the bound as a
  -- literal and four read one function, so it is the literals that can drift.
  -- The pattern is built from a whole-number rendering, since a scaled bound
  -- would put a wildcard dot in a regex and silently stop matching; a bound
  -- that is not whole is refused outright rather than approximated. What
  -- precedes the number separates a bound from a citation: a migration
  -- reference (000031:25-30) sits behind a digit, colon or hyphen, none of
  -- which is how a bound is written.
  IF mx <> trunc(mx) THEN
    RAISE EXCEPTION 'FAIL 47a: the shared ceiling is %, which no source check can match as a whole number', mx;
  END IF;
  bound_re := '(?<![0-9.:-])' || trunc(mx)::bigint::text || '(\.0+)?(?![0-9.])';
  FOR fn IN SELECT p.proname AS name, pg_get_functiondef(p.oid) AS src
              FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
             WHERE ns.nspname = 'app'
               AND p.proname IN ('fit_tyre', 'remove_tyre', 'rotate_tyres', 'log_retread_return', 'submit_inspection')
  LOOP
    IF strpos(fn.src, 'app.max_tread_mm()') = 0 THEN
      RAISE EXCEPTION 'FAIL 47a: app.% does not read the shared tread ceiling', fn.name;
    END IF;
    IF fn.src ~ bound_re THEN
      RAISE EXCEPTION 'FAIL 47a: app.% still carries % as a literal of its own', fn.name, mx;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  47a one tread ceiling, interpolated into five refusals that keep their own words';

  -- (b) The same four inputs absent rather than out of range. The retread
  -- return owes a distinct answer here: app.log_retread_return names which of
  -- three figures is missing (000034), and that wording is what a workshop
  -- retyping a report reads, so it must survive the shared bound rather than
  -- be folded into it (FR-FIT-022).
  BEGIN
    PERFORM app.fit_tyre(tyr, va, p3, NULL, 'MARK_OUTBOARD');
    RAISE EXCEPTION 'FAIL 47b: a fit with no tread was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS n1 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.remove_tyre(fit1, 'damage', NULL);
    RAISE EXCEPTION 'FAIL 47b: a removal with no tread was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS n2 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.rotate_tyres(va,
      jsonb_build_array(
        jsonb_build_object('tyre_id', typ, 'to_position_id', p2, 'tread_mm', NULL),
        jsonb_build_object('tyre_id', tyq, 'to_position_id', p1, 'tread_mm', NULL)),
      NULL::jsonb, now());
    RAISE EXCEPTION 'FAIL 47b: a rotation with no tread was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS n3 = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.log_retread_return(job, app.tenant_today(tz), true, 'T47-RPT-B',
                                   100.00, NULL, 500.00);
    RAISE EXCEPTION 'FAIL 47b: a retread return with no tread was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS n4 = MESSAGE_TEXT;
  END;
  IF n1 = n2 OR n1 = n3 OR n1 = n4 OR n2 = n3 OR n2 = n4 OR n3 = n4 THEN
    RAISE EXCEPTION 'FAIL 47b: two of the four absent-tread refusals share a voice: % / % / % / %',
      n1, n2, n3, n4;
  END IF;
  IF n4 <> 'a retread return records the tread the casing came back on' THEN
    RAISE EXCEPTION 'FAIL 47b: the missing-figure refusal reads %', n4;
  END IF;
  IF n4 = m4 THEN
    RAISE EXCEPTION 'FAIL 47b: the return answers a missing tread in the ceiling''s words';
  END IF;
  RAISE NOTICE 'PASS  47b an absent tread is refused by each function in its own words, the retread return''s included';
END $$;

DO $$
DECLARE
  bac   uuid := '11111111-1111-1111-1111-111111111111';
  t_two uuid := '22222222-2222-2222-2222-222222222222';
  -- The rig: a horse and two trailers. ta sits on the horse's own axle
  -- configuration so the two share every position id, which is what U18's
  -- "same position id on two units" probe needs; tb sits on another, so a
  -- target that p_vehicle's configuration does not contain is exercised too.
  h   uuid := md5('t47h')::uuid;
  ta  uuid := md5('t47ta')::uuid;
  tb  uuid := md5('t47tb')::uuid;
  hx  uuid := md5('t47hx')::uuid;   -- visible, same tenant, in no rig with h
  ctl uuid := md5('t47ctl')::uuid;  -- planted, not assumed: created_by is a composite FK (000017)
  sz1 uuid := md5('sz1')::uuid;
  fty uuid := md5('t47fty')::uuid;  -- a casing of the other fleet
  tya uuid := md5('t47tya')::uuid;
  tyb uuid := md5('t47tyb')::uuid;
  tyc uuid := md5('t47tyc')::uuid;
  tyd uuid := md5('t47tyd')::uuid;
  tye uuid := md5('t47tye')::uuid;
  cfg uuid; cfg2 uuid; rig uuid; t2pos uuid;
  p1 uuid; p2 uuid; p3 uuid; p5 uuid; p6 uuid; p7 uuid; p8 uuid; p9 uuid; p10 uuid;
  q1 uuid; q2 uuid;
  at0 timestamptz; r record; n int; msg text; fleet text;
  h_open uuid; closed_fit uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT v.configuration_id INTO cfg  FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT v.configuration_id INTO cfg2 FROM app.vehicle v WHERE v.id = md5('veh2')::uuid;
  SELECT p.id INTO p1  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  SELECT p.id INTO p2  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '2';
  SELECT p.id INTO p3  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  SELECT p.id INTO p5  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '5';
  SELECT p.id INTO p6  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '6';
  SELECT p.id INTO p7  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '7';
  SELECT p.id INTO p8  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '8';
  SELECT p.id INTO p9  FROM app.position p WHERE p.configuration_id = cfg AND p.code = '9';
  SELECT p.id INTO p10 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '10';
  SELECT p.id INTO q1  FROM app.position p WHERE p.configuration_id = cfg2 AND p.code = '1';
  SELECT p.id INTO q2  FROM app.position p WHERE p.configuration_id = cfg2 AND p.code = '2';
  IF p10 IS NULL OR q2 IS NULL OR cfg = cfg2 THEN
    RAISE EXCEPTION 'FAIL 47: the two configurations this section rotates between did not resolve';
  END IF;

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (h,  bac, 'T47-H',  'T47H GP',  cfg,  'HORSE',   md5('depot1')::uuid, 'ACTIVE'),
         (ta, bac, 'T47-TA', 'T47TA GP', cfg,  'TRAILER', md5('depot1')::uuid, 'ACTIVE'),
         (tb, bac, 'T47-TB', 'T47TB GP', cfg2, 'TRAILER', md5('depot1')::uuid, 'ACTIVE'),
         (hx, bac, 'T47-HX', 'T47HX GP', cfg,  'HORSE',   md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (ctl, bac, 't47ctl@example.invalid', 'T47 Controller', 'CONTROLLER');
  PERFORM set_config('app.actor_id', ctl::text, true);
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (tya, bac, 'T47TYREA', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyb, bac, 'T47TYREB', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyc, bac, 'T47TYREC', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyd, bac, 'T47TYRED', sz1, 'NEW', 0, 'IN_STOCK'),
    (tye, bac, 'T47TYREE', sz1, 'NEW', 0, 'IN_STOCK');
  rig := app.create_combination(h, jsonb_build_array(jsonb_build_object('vehicle_id', ta),
                                                     jsonb_build_object('vehicle_id', tb)));

  -- Both casings are fitted an hour back so the rotation's own instant is the
  -- only one its events can share: fits stamped at now() would put two more
  -- to_state events on that instant and 47d's count would pass on them.
  SELECT * INTO r FROM app.fit_tyre(tya, h,  p9, 14.0, 'MARK_OUTBOARD', 400000, now() - interval '1 hour');
  SELECT * INTO r FROM app.fit_tyre(tyb, ta, p1, 13.0, 'MARK_OUTBOARD', NULL,   now() - interval '1 hour');

  -- (c) The ticket's own move: one rotation, two units of one open rig, the
  -- source closed on the unit it was on and the new row opened on the unit it
  -- went to, so both units' fitment histories carry the move (FR-FIT-010,
  -- U15, U16, U19). to_vehicle_id is named on each move; the source is not,
  -- because the open fitment is already the one answer to where a casing is.
  at0 := now();
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p2,  'tread_mm', 11.0),
      jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', h,  'to_position_id', p10, 'tread_mm', 10.0)),
    jsonb_build_object(h::text, 405000), at0);
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47c: the rotation returned % rows, expected 2', n; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at = at0 AND f.removal_reason = 'rotation'
     AND ((f.tyre_id = tya AND f.vehicle_id = h  AND f.position_id = p9)
       OR (f.tyre_id = tyb AND f.vehicle_id = ta AND f.position_id = p1));
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47c: % source fitments closed at the rotation instant with the reason, expected 2', n;
  END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at IS NULL AND f.fitted_at = at0
     AND ((f.tyre_id = tya AND f.vehicle_id = ta AND f.position_id = p2)
       OR (f.tyre_id = tyb AND f.vehicle_id = h  AND f.position_id = p10));
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47c: % fitments opened on the destination units, expected 2', n;
  END IF;
  -- The DoD in one assertion: the casing's closed row and its open row name
  -- different units, which is the whole of what "across the units of a rig"
  -- means to a reader of either unit's history.
  IF (SELECT f.vehicle_id FROM app.fitment f WHERE f.tyre_id = tya AND f.removed_at = at0)
     = (SELECT f.vehicle_id FROM app.fitment f WHERE f.tyre_id = tya AND f.removed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL 47c: the casing left and arrived on the same unit';
  END IF;
  RAISE NOTICE 'PASS  47c a rotation closes on the source unit and opens on the destination unit of one rig';

  -- (d) U19: one ROTATED per casing, FITTED to FITTED, carrying both units
  -- and both position codes. Counted over every event sharing the instant,
  -- not over the ROTATED rows alone: a REMOVED and a FITTED pair stamped here
  -- would satisfy "at least one ROTATED" while leaving two to_state events on
  -- one instant, which is the ambiguity app.tyre_in_estate_asof cannot
  -- resolve (FR-VAL-022).
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.tyre_id IN (tya, tyb) AND e.occurred_at = at0;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47d: % events share the rotation instant, expected one per casing', n;
  END IF;
  SELECT count(*) INTO n FROM app.tyre_event e
   WHERE e.type = 'ROTATED' AND e.from_state = 'FITTED' AND e.to_state = 'FITTED'
     AND ((e.tyre_id = tya AND e.payload->>'from_vehicle_id' = h::text
                          AND e.payload->>'to_vehicle_id'   = ta::text
                          AND e.payload->>'from_position_code' = '9'
                          AND e.payload->>'to_position_code'   = '2')
       OR (e.tyre_id = tyb AND e.payload->>'from_vehicle_id' = ta::text
                          AND e.payload->>'to_vehicle_id'   = h::text
                          AND e.payload->>'from_position_code' = '1'
                          AND e.payload->>'to_position_code'   = '10'));
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47d: the ROTATED events do not record both units and both positions';
  END IF;
  RAISE NOTICE 'PASS  47d one ROTATED event per casing carries the unit it left and the unit it went to';

  -- (e) The register is the surface a fleet manager reads, so the move is not
  -- recorded until it reads there: one row per casing, against the new unit
  -- (FR-VAL-001, FR-RPT-020).
  SELECT count(*) INTO n FROM app.v_tyre_valuation v WHERE v.tyre_id = tya;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 47e: the register shows % rows for one casing', n; END IF;
  SELECT v.fleet_number INTO fleet FROM app.v_tyre_valuation v WHERE v.tyre_id = tya;
  IF fleet IS DISTINCT FROM 'T47-TA' THEN
    RAISE EXCEPTION 'FAIL 47e: the register still shows the rotated casing against %', fleet;
  END IF;
  SELECT v.fleet_number INTO fleet FROM app.v_tyre_valuation v WHERE v.tyre_id = tyb;
  IF fleet IS DISTINCT FROM 'T47-H' THEN
    RAISE EXCEPTION 'FAIL 47e: the register shows the casing that moved onto the horse against %', fleet;
  END IF;
  RAISE NOTICE 'PASS  47e the register reads each rotated casing against the unit it now sits on';

  -- (f) The DoD's cross-tenant half, both directions a rotation can name
  -- another fleet: destination resolves by visibility, casing by the OPEN
  -- fitment its move derives its source from (U15). Every other-fleet row is
  -- shown invisible first, with the policy off, so neither can refuse for a
  -- second reason (lesson 2026-09-01; 41r), and the TY012 asserted below can
  -- only be RLS.
  PERFORM set_config('app.tenant_id', t_two::text, true);
  -- Unbound with '': app.current_actor_id is nullif(..., ''), so BAC's
  -- controller would default created_by to a user this fleet cannot see.
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, status, retread_count, state)
  VALUES (fty, t_two, 'T47TYREF', 'NEW', 0, 'FITTED');
  -- Queried, never assumed: no position id is hardcoded here, because DR-004
  -- admits only one open fitment per (position, unit) and this section has no
  -- guarantee that every position on t2veh1 is still free by this point in
  -- the suite, so the query finds whichever one currently carries no open
  -- fitment.
  SELECT p.id INTO t2pos
    FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = md5('t2veh1')::uuid
     AND NOT EXISTS (SELECT 1 FROM app.fitment f
                      WHERE f.vehicle_id = v.id AND f.position_id = p.id
                        AND f.removed_at IS NULL)
   ORDER BY p.code
   LIMIT 1;
  IF t2pos IS NULL THEN
    RAISE EXCEPTION 'FAIL 47f: the other fleet''s unit has no free position to plant a casing on';
  END IF;
  -- Written directly rather than through app.fit_tyre: what this probe rests
  -- on is the fitment existing, not the function's refusals. t2veh1 is a
  -- HORSE, so the reading is not optional (000025, FR-FIT-002), and the fit is
  -- backdated so it shares no instant with anything this section stamps.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                           fitted_odometer, fitted_tread_mm, mount_orientation)
  VALUES (t_two, fty, md5('t2veh1')::uuid, t2pos, now() - interval '1 day',
          120000, 12.0, 'MARK_OUTBOARD');
  SELECT count(*) INTO n FROM app.tyre v WHERE v.id = fty;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 47f: the other fleet''s casing was not planted'; END IF;
  SELECT count(*) INTO n FROM app.fitment f WHERE f.tyre_id = fty AND f.removed_at IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 47f: the other fleet''s casing has no open fitment for a source lookup to find';
  END IF;
  SELECT count(*) INTO n FROM app.vehicle v WHERE v.id = md5('t2veh1')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 47f: the other fleet''s unit is not there to probe with'; END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', ctl::text, true);
  SELECT count(*) INTO n FROM app.tyre v WHERE v.id = fty;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 47f: the other fleet''s casing is visible in this fleet'; END IF;
  SELECT count(*) INTO n FROM app.fitment f WHERE f.tyre_id = fty AND f.removed_at IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 47f: the other fleet''s open fitment is visible in this fleet';
  END IF;
  SELECT count(*) INTO n FROM app.vehicle v WHERE v.id = md5('t2veh1')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 47f: the other fleet''s unit is visible in this fleet'; END IF;
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', md5('t2veh1')::uuid,
                           'to_position_id', p9, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', ta, 'to_position_id', p1, 'tread_mm', 10.0)),
      jsonb_build_object(h::text, 406000), now());
    RAISE EXCEPTION 'FAIL 47f: a rotation onto another fleet''s unit was accepted';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    -- The visibility answer, not the membership one: a unit this fleet cannot
    -- see is not a unit that is out of the rig, and TY014 naming an empty
    -- fleet number here would mean membership was resolved first.
    IF msg <> 'no such unit in this fleet' THEN
      RAISE EXCEPTION 'FAIL 47f: the destination refusal reads %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', fty, 'to_vehicle_id', ta, 'to_position_id', p3, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', ta, 'to_position_id', p1, 'tread_mm', 10.0)),
      jsonb_build_object(h::text, 406000), now());
    RAISE EXCEPTION 'FAIL 47f: a rotation of another fleet''s casing was accepted';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> format('tyre %s is not on this unit or its rig', fty) THEN
      RAISE EXCEPTION 'FAIL 47f: the casing refusal reads %', msg;
    END IF;
  END;
  -- The control both refusals rest on: the same call shape, with this fleet's
  -- own unit and its own casing, succeeds. Without it either probe above
  -- would pass on a rotation that refuses everything.
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tya, 'to_vehicle_id', h,  'to_position_id', p9, 'tread_mm', 10.5),
      jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', ta, 'to_position_id', p1, 'tread_mm', 9.5)),
    jsonb_build_object(h::text, 406000), now());
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47f: the same-fleet control returned % rows, expected 2', n; END IF;
  RAISE NOTICE 'PASS  47f another fleet''s unit and another fleet''s casing are both invisible to a rotation';

  -- (g) The DoD's other half: a unit this fleet can see, that shares no rig
  -- with the one the rotation is addressed to. The refusal names the unit,
  -- which is what tells this apart from 47f's visibility branch. An
  -- unnamed unit would mean the two answers had been merged (U16).
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', hx, 'to_position_id', p1, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', h,  'to_position_id', p9, 'tread_mm', 10.0)),
      jsonb_build_object(h::text, 407000), now());
    RAISE EXCEPTION 'FAIL 47g: a rotation onto a unit outside the rig was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%T47-HX%' THEN
      RAISE EXCEPTION 'FAIL 47g: the refusal does not name the unit that is not in the rig: %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  47g a rotation onto a unit sharing no rig is refused by that unit''s name';

  -- (q) 47g's twin at the source. A move's source resolves on the same two
  -- branches as its destination, in the same order: visibility, then
  -- membership (U11, U16, ADR-0012), so the membership half owes its own
  -- probe, or a body that dropped the source's rig check would rotate a
  -- casing off a unit the rig never held and leave the suite green. hx is
  -- visible but shares no rig with h, and the destination named IS in the
  -- rig, so only the source can refuse.
  PERFORM app.fit_tyre(tyd, hx, p1, 12.0, 'MARK_OUTBOARD', 300000, now() - interval '1 hour');
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyd, 'to_vehicle_id', ta, 'to_position_id', p3,  'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', h,  'to_position_id', p10, 'tread_mm', 10.0)),
      jsonb_build_object(h::text, 407000), now());
    RAISE EXCEPTION 'FAIL 47q: a rotation of a casing sitting outside the rig was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%T47-HX%' THEN
      RAISE EXCEPTION 'FAIL 47q: the refusal does not name the unit the casing is on: %', msg;
    END IF;
    -- And it is the source's answer, not the destination's: ta is in the rig,
    -- so a message about where this casing is GOING would mean the two
    -- branches had been merged into one.
    IF msg NOT LIKE format('tyre %s is on %%', tyd) THEN
      RAISE EXCEPTION 'FAIL 47q: the refusal reads as the destination''s, not the source''s: %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  47q a rotation of a casing sitting on a unit outside the rig is refused by that unit''s name';

  -- (i) U17: p_vehicle is the unit the request was addressed to and the
  -- anchor the rig is resolved from, not a unit every move has to touch. A
  -- trailer swap inside a rig is a real yard move and routing it through the
  -- horse's screen would be the only reason to refuse it.
  PERFORM app.fit_tyre(tyc, tb, q1, 12.0, 'MARK_OUTBOARD');
  SELECT f.id INTO h_open FROM app.fitment f WHERE f.vehicle_id = h AND f.removed_at IS NULL;
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tyb, 'to_vehicle_id', tb, 'to_position_id', q2, 'tread_mm', 9.0),
      jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', ta, 'to_position_id', p3, 'tread_mm', 12.0)),
    NULL::jsonb);
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47i: a trailer-to-trailer rotation returned % rows, expected 2', n; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at IS NULL
     AND ((f.tyre_id = tyb AND f.vehicle_id = tb AND f.position_id = q2)
       OR (f.tyre_id = tyc AND f.vehicle_id = ta AND f.position_id = p3));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47i: the trailer-to-trailer move did not land'; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.vehicle_id = h AND f.removed_at IS NULL AND f.id = h_open;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 47i: a rotation naming no move on the anchor unit changed it anyway'; END IF;
  RAISE NOTICE 'PASS  47i a rotation addressed to the horse may move nothing on it';

  -- (j) U18: position identity is per axle configuration, so h and ta share
  -- every position id and two moves onto the same id are two different
  -- targets. The pair is what the duplicate rule is on, proven both ways:
  -- the same id on two units is accepted, the same id on one unit is not.
  IF q2 IN (SELECT p.id FROM app.position p WHERE p.configuration_id = cfg) THEN
    RAISE EXCEPTION 'FAIL 47j: the cross-configuration target is not off the anchor''s configuration';
  END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id = tyb AND f.vehicle_id = tb AND f.position_id = q2 AND f.removed_at IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 47j: a target resolved against the destination''s own configuration did not stand';
  END IF;
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p5, 'tread_mm', 10.0),
      jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', h,  'to_position_id', p5, 'tread_mm', 11.0)),
    jsonb_build_object(h::text, 407000));
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47j: one position id on two units returned % rows, expected 2', n;
  END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at IS NULL AND f.position_id = p5
     AND ((f.tyre_id = tya AND f.vehicle_id = ta) OR (f.tyre_id = tyc AND f.vehicle_id = h));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47j: the two same-numbered targets did not both land'; END IF;
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', ta, 'to_position_id', p6, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p6, 'tread_mm', 10.0)),
      jsonb_build_object(h::text, 408000));
    RAISE EXCEPTION 'FAIL 47j: two moves onto one unit''s one position were accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'two moves cannot target the same position' THEN
      RAISE EXCEPTION 'FAIL 47j: the duplicate-target refusal reads %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  47j a target is the (unit, position) pair, so one position id serves two units and not one';

  -- (k) U20: a horse records an odometer and a trailer has none, so TY009 is
  -- answered per unit and the reading each closure and each opening carries
  -- is that row's own unit's (FR-FIT-002, FR-FIT-009, CR-012). The two
  -- refusals below are two different inputs, a reading for the wrong unit
  -- and no reading at all, and both leave the horse's rows without one.
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', ta, 'to_position_id', p6, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', h,  'to_position_id', p7, 'tread_mm', 10.0)),
      NULL::jsonb);
    RAISE EXCEPTION 'FAIL 47k: a rotation touching the horse with no odometer at all was accepted';
  EXCEPTION WHEN SQLSTATE 'TY009' THEN NULL;
  END;
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', ta, 'to_position_id', p6, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', h,  'to_position_id', p7, 'tread_mm', 10.0)),
      jsonb_build_object(ta::text, 500000));
    RAISE EXCEPTION 'FAIL 47k: a rotation reading only the trailer was accepted for the horse';
  EXCEPTION WHEN SQLSTATE 'TY009' THEN NULL;
  END;
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tyc, 'to_vehicle_id', ta, 'to_position_id', p6, 'tread_mm', 11.0),
      jsonb_build_object('tyre_id', tya, 'to_vehicle_id', h,  'to_position_id', p7, 'tread_mm', 10.0)),
    jsonb_build_object(h::text, 408000));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47k: the horse-only odometer returned % rows, expected 2', n; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id = tyc AND f.vehicle_id = h AND f.position_id = p5 AND f.removed_at IS NOT NULL
     AND f.removed_odometer = 408000 AND f.distance_source = 'MEASURED' AND f.distance_km = 1000;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 47k: the horse''s closed row did not measure its own unit''s distance';
  END IF;
  -- CR-012: the trailer has no reading to give, and absence is recorded as
  -- absence rather than as a measured zero the cost-per-kilometre would read
  -- as fact.
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id = tya AND f.vehicle_id = ta AND f.position_id = p5 AND f.removed_at IS NOT NULL
     AND f.removed_odometer IS NULL AND f.distance_source = 'UNAVAILABLE' AND f.distance_km IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 47k: the trailer''s closed row did not record its distance as unavailable';
  END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at IS NULL
     AND ((f.tyre_id = tya AND f.vehicle_id = h  AND f.fitted_odometer = 408000)
       OR (f.tyre_id = tyc AND f.vehicle_id = ta AND f.fitted_odometer IS NULL));
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47k: the opened rows did not take the odometer of their own unit';
  END IF;
  RAISE NOTICE 'PASS  47k a rotation reads an odometer per unit, and the trailer''s absence is recorded as absence';

  -- (l) U20's bound, per unit. Each reading is compared against the fitments
  -- being rotated out of ITS OWN unit, so a low figure refuses on the unit it
  -- belongs to and a sound figure on the other unit does not save it. The
  -- two refusals carry different readings on purpose: a body comparing every
  -- fitment against the anchor unit's figure would report the horse's number
  -- in the second probe, and the message match is what catches that.
  PERFORM app.fit_tyre(tye, ta, p8, 12.0, 'MARK_OUTBOARD', 500000);
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p9,  'tread_mm', 10.0),
        jsonb_build_object('tyre_id', tye, 'to_vehicle_id', h,  'to_position_id', p10, 'tread_mm', 11.0)),
      jsonb_build_object(h::text, 400000, ta::text, 501000));
    RAISE EXCEPTION 'FAIL 47l: a horse reading below its own fitment''s odometer was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%400000%' THEN
      RAISE EXCEPTION 'FAIL 47l: the refusal does not name the horse''s own reading: %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.rotate_tyres(h,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p9,  'tread_mm', 10.0),
        jsonb_build_object('tyre_id', tye, 'to_vehicle_id', h,  'to_position_id', p10, 'tread_mm', 11.0)),
      jsonb_build_object(h::text, 409000, ta::text, 401000));
    RAISE EXCEPTION 'FAIL 47l: a trailer reading below its own fitment''s odometer was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%401000%' THEN
      RAISE EXCEPTION 'FAIL 47l: the refusal does not name the trailer''s own reading: %', msg;
    END IF;
  END;
  SELECT count(*) INTO n FROM app.rotate_tyres(h,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tya, 'to_vehicle_id', ta, 'to_position_id', p9,  'tread_mm', 10.0),
      jsonb_build_object('tyre_id', tye, 'to_vehicle_id', h,  'to_position_id', p10, 'tread_mm', 11.0)),
    jsonb_build_object(h::text, 409000, ta::text, 501000));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47l: two sound readings returned % rows, expected 2', n; END IF;
  RAISE NOTICE 'PASS  47l the odometer bound is answered against each row''s own unit';

  -- (o) Rule 3 across a cross-unit move: the closure is the one UPDATE
  -- app.fitment permits and a closed row is frozen entire (000032), so the
  -- record of where a casing was is a compensating event away, never an edit
  -- (FR-FIT-014, FR-FIT-015). The closed row chosen is a trailer's, so
  -- TY009's removal leg cannot answer first.
  SELECT f.id INTO closed_fit FROM app.fitment f
   WHERE f.tyre_id = tye AND f.vehicle_id = ta AND f.removed_at IS NOT NULL;
  IF closed_fit IS NULL THEN RAISE EXCEPTION 'FAIL 47o: the rotation left no closed row to probe'; END IF;
  BEGIN
    UPDATE app.fitment SET removed_tread_mm = 1.0 WHERE id = closed_fit;
    RAISE EXCEPTION 'FAIL 47o: a closed fitment was edited';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a closed fitment cannot be changed' THEN
      RAISE EXCEPTION 'FAIL 47o: the closed row refused with %', msg;
    END IF;
  END;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.id = closed_fit AND f.removal_reason = 'rotation' AND f.removed_tread_mm = 11.0;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 47o: the closed row does not stand as the rotation wrote it'; END IF;
  -- WHERE false: privilege is checked at rewrite time against the table, so
  -- this proves the REVOKE (000018) without depending on which rows exist.
  BEGIN
    DELETE FROM app.fitment WHERE false;
    RAISE EXCEPTION 'FAIL 47o: app role can DELETE app.fitment';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS  47o a rotation adds rows and edits none; a closed fitment stays closed';
END $$;

DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  h2   uuid := md5('t47h2')::uuid;
  t3   uuid := md5('t47t3')::uuid;
  ctl3 uuid := md5('t47ctl3')::uuid;
  rig  uuid := md5('t47rigold')::uuid;
  sz1  uuid := md5('sz1')::uuid;
  tyh  uuid := md5('t47tyh')::uuid;
  tyt  uuid := md5('t47tyt')::uuid;
  cfg uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid;
  mid timestamptz; n int; msg text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO p1 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  SELECT p.id INTO p2 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '2';
  SELECT p.id INTO p3 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  SELECT p.id INTO p4 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '4';
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (h2, bac, 'T47-H2', 'T47H2 GP', cfg, 'HORSE',   md5('depot1')::uuid, 'ACTIVE'),
         (t3, bac, 'T47-T3', 'T47T3 GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (ctl3, bac, 't47ctl3@example.invalid', 'T47 Yard Controller', 'CONTROLLER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (tyh, bac, 'T47TYREH', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyt, bac, 'T47TYRET', sz1, 'NEW', 0, 'IN_STOCK');
  PERFORM set_config('app.actor_id', ctl3::text, true);

  -- U16 needs a rig whose window closed less than a day ago, which no
  -- function-call pair can produce: a rig created and ended on one date has
  -- a zero-width window (U8), and app.fitment_instant_ok refuses a rotation
  -- backdated over 24 hours (000033) before membership is ever reached. So
  -- the composition is written directly at explicit instants, members added
  -- while the rig is still open, since combination_member_in_order (000037)
  -- refuses growing an ended one.
  INSERT INTO app.combination (id, tenant_id, motive_vehicle_id, effective_from)
  VALUES (rig, bac, h2, now() - interval '3 hours');
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h2, 1), (bac, rig, t3, 2);
  UPDATE app.combination SET effective_to = now() - interval '1 hour' WHERE id = rig;

  -- Both casings start on the anchor unit, which is in scope at every
  -- instant. A casing parked on t3 would make t3 the answer to two questions
  -- at once, a source outside the rig and a destination outside it, and the
  -- refusal below would be free to come from either, leaving the probe unable
  -- to say which rule it caught (U15, U16).
  PERFORM app.fit_tyre(tyh, h2, p1, 12.0, 'MARK_OUTBOARD', 400000, now() - interval '3 hours');
  PERFORM app.fit_tyre(tyt, h2, p2, 12.0, 'MARK_OUTBOARD', 400000, now() - interval '3 hours');
  mid := now() - interval '2 hours';

  -- (h) U16: the rig a rotation is scoped to is the one that was true at
  -- p_occurred_at, not the one that is open now. A yard move recorded after
  -- the units were uncoupled is still a move that happened while they were
  -- coupled (FR-VEH-031). The refusing leg runs first and writes nothing, so
  -- the succeeding leg below is the same call with only the instant moved.
  BEGIN
    PERFORM app.rotate_tyres(h2,
      jsonb_build_array(
        jsonb_build_object('tyre_id', tyh, 'to_vehicle_id', t3, 'to_position_id', p3, 'tread_mm', 11.0),
        jsonb_build_object('tyre_id', tyt, 'to_vehicle_id', h2, 'to_position_id', p4, 'tread_mm', 11.0)),
      jsonb_build_object(h2::text, 405000), now());
    RAISE EXCEPTION 'FAIL 47h: a rotation stamped after the rig ended was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%T47-T3%' THEN
      RAISE EXCEPTION 'FAIL 47h: the refusal does not name the unit that had left the rig: %', msg;
    END IF;
  END;
  SELECT count(*) INTO n FROM app.rotate_tyres(h2,
    jsonb_build_array(
      jsonb_build_object('tyre_id', tyh, 'to_vehicle_id', t3, 'to_position_id', p3, 'tread_mm', 11.0),
      jsonb_build_object('tyre_id', tyt, 'to_vehicle_id', h2, 'to_position_id', p4, 'tread_mm', 11.0)),
    jsonb_build_object(h2::text, 405000), mid);
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 47h: a rotation inside the ended rig''s window returned % rows, expected 2', n;
  END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.removed_at IS NULL AND f.fitted_at = mid
     AND ((f.tyre_id = tyh AND f.vehicle_id = t3 AND f.position_id = p3)
       OR (f.tyre_id = tyt AND f.vehicle_id = h2 AND f.position_id = p4));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47h: the dated cross-unit move did not land'; END IF;
  RAISE NOTICE 'PASS  47h a rotation is scoped to the rig that was true at its own instant';
END $$;

DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  h4   uuid := md5('t47h4')::uuid;
  drv4 uuid := md5('t47drv4')::uuid;
  sz1  uuid := md5('sz1')::uuid;
  m1   uuid := md5('t47m1')::uuid;  -- the mate whose reading contradicts its column
  m2   uuid := md5('t47m2')::uuid;
  m3   uuid := md5('t47m3')::uuid;
  m4   uuid := md5('t47m4')::uuid;
  m5   uuid := md5('t47m5')::uuid;
  m6   uuid := md5('t47m6')::uuid;
  cfg uuid; band numeric;
  p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid; p8 uuid;
  r record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO p3 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  SELECT p.id INTO p4 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '4';
  SELECT p.id INTO p5 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '5';
  SELECT p.id INTO p6 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '6';
  SELECT p.id INTO p7 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '7';
  SELECT p.id INTO p8 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '8';
  -- The band is tenant configuration (rule 5); every gap below is chosen
  -- against the figure the tenant actually carries, not against a constant.
  SELECT (c.value #>> '{}')::numeric INTO band
    FROM app.configuration c
   WHERE c.tenant_id = bac AND c.key = 'dual_mate_warn_mm' AND c.effective_from <= now()
   ORDER BY c.effective_from DESC LIMIT 1;
  IF band IS NULL OR band >= 7 THEN
    RAISE EXCEPTION 'FAIL 47m: the configured dual-mate band (%) cannot separate the readings this probe plants', band;
  END IF;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (h4, bac, 'T47-H4', 'T47H4 GP', cfg, 'HORSE', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (drv4, bac, 't47drv4@example.invalid', 'T47 Mate Driver', 'DRIVER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (m1, bac, 'T47TYREM1', sz1, 'NEW', 0, 'IN_STOCK'),
    (m2, bac, 'T47TYREM2', sz1, 'NEW', 0, 'IN_STOCK'),
    (m3, bac, 'T47TYREM3', sz1, 'NEW', 0, 'IN_STOCK'),
    (m4, bac, 'T47TYREM4', sz1, 'NEW', 0, 'IN_STOCK'),
    (m5, bac, 'T47TYREM5', sz1, 'NEW', 0, 'IN_STOCK'),
    (m6, bac, 'T47TYREM6', sz1, 'NEW', 0, 'IN_STOCK');

  -- (m) U22: the warning is about the depth the register would show, which
  -- ranks a reading above app.tyre.last_tread_mm (000013's precedence). Every
  -- mate below is fitted an hour back and read half an hour back, so a
  -- warning computed off the column would be off a depth nobody would see
  -- (FR-FIT-020, TYRE-126). Readings are planted as rows, since
  -- app.submit_inspection would date them at its own instant.
  PERFORM app.fit_tyre(m1, h4, p3, 12.0, 'MARK_OUTBOARD', 100000, now() - interval '1 hour');
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid,
                              started_at, submitted_at, odometer)
  VALUES (md5('t47ins1')::uuid, bac, h4, drv4, md5('t47cli1')::uuid,
          now() - interval '35 minutes', now() - interval '30 minutes', 100000);
  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  VALUES (md5('t47rd1')::uuid, bac, md5('t47ins1')::uuid, h4, p3, m1, 800);
  INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known) VALUES
    (bac, md5('t47rd1')::uuid, 1, 'OUTER',  5.0, true),
    (bac, md5('t47rd1')::uuid, 2, 'CENTRE', 6.0, true),
    (bac, md5('t47rd1')::uuid, 3, 'INNER',  7.0, true);
  SELECT * INTO r FROM app.fit_tyre(m2, h4, p4, 12.0, 'MARK_OUTBOARD', 100100);
  IF NOT (r.warnings @> '[{"code":"DUAL_MATE_TREAD_GAP"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 47m: a mate reading 5mm against this 12mm did not warn: %', r.warnings;
  END IF;

  -- The other direction, so the probe is not satisfied by a rule that warns
  -- on every dual: the column would warn here and the reading says there is
  -- no gap.
  PERFORM app.fit_tyre(m3, h4, p5, 5.0, 'MARK_OUTBOARD', 100200, now() - interval '1 hour');
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid,
                              started_at, submitted_at, odometer)
  VALUES (md5('t47ins2')::uuid, bac, h4, drv4, md5('t47cli2')::uuid,
          now() - interval '35 minutes', now() - interval '30 minutes', 100200);
  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  VALUES (md5('t47rd2')::uuid, bac, md5('t47ins2')::uuid, h4, p5, m3, 800);
  INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known) VALUES
    (bac, md5('t47rd2')::uuid, 1, 'OUTER',  12.0, true),
    (bac, md5('t47rd2')::uuid, 2, 'CENTRE', 13.0, true),
    (bac, md5('t47rd2')::uuid, 3, 'INNER',  14.0, true);
  SELECT * INTO r FROM app.fit_tyre(m4, h4, p6, 12.0, 'MARK_OUTBOARD', 100300);
  IF r.warnings IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 47m: a mate read at 12mm warned against this 12mm: %', r.warnings;
  END IF;

  -- As at the fitment instant, not latest overall, the precedence
  -- app.tyre_valuation_asof already uses. A reading taken after the fit
  -- describes a tyre the fitter had not seen.
  PERFORM app.fit_tyre(m5, h4, p7, 12.0, 'MARK_OUTBOARD', 100400, now() - interval '1 hour');
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid,
                              started_at, submitted_at, odometer)
  VALUES (md5('t47ins3')::uuid, bac, h4, drv4, md5('t47cli3')::uuid,
          now() - interval '5 minutes', now(), 100400);
  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  VALUES (md5('t47rd3')::uuid, bac, md5('t47ins3')::uuid, h4, p7, m5, 800);
  INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known) VALUES
    (bac, md5('t47rd3')::uuid, 1, 'OUTER',  5.0, true),
    (bac, md5('t47rd3')::uuid, 2, 'CENTRE', 6.0, true),
    (bac, md5('t47rd3')::uuid, 3, 'INNER',  7.0, true);
  SELECT * INTO r FROM app.fit_tyre(m6, h4, p8, 12.0, 'MARK_OUTBOARD', 100500,
                                    now() - interval '30 minutes');
  IF r.warnings IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 47m: a reading submitted after the fitment instant was used anyway: %', r.warnings;
  END IF;
  RAISE NOTICE 'PASS  47m the dual-mate warning reads the mate''s reading as at the fitment, ahead of its column';
END $$;

DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  d_rt uuid := md5('t47nrt')::uuid;
  sz1  uuid := md5('sz1')::uuid;
  n1   uuid := md5('t47n1')::uuid;  -- dispatched as at the tenant's today
  n2   uuid := md5('t47n2')::uuid;  -- dispatched and returned on earlier days
  n3   uuid := md5('t47n3')::uuid;  -- the future-day refusal
  tz text; today date; ja uuid; jb uuid; stamp timestamptz;
  r record; d1 text; d2 text;
BEGIN
  -- Session zone pinned to UTC: BAC is Africa/Johannesburg (UTC+2), so a
  -- day resolved in the session's zone lands on a different instant than the
  -- tenant's on any host, rather than passing by coincidence where the two
  -- agree (section 45's reasoning, lesson 2026-09-01).
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  today := app.tenant_today(tz);
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'T47 Casing Works', 'RETREADER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (n1, bac, 'T47TYREN1', sz1, 'NEW', 0, 'REMOVED'),
    (n2, bac, 'T47TYREN2', sz1, 'NEW', 0, 'REMOVED'),
    (n3, bac, 'T47TYREN3', sz1, 'NEW', 0, 'REMOVED');

  -- (n) U8: one day-to-instant rule for both ends of the retread journey.
  -- Today means now(), since a midnight stamp would lose to the same day's
  -- earlier movements (FR-VAL-022); an earlier day means midnight in the
  -- TENANT's zone (rule 6); a future day is refused by each function in its
  -- own words. Both instants are asserted against app.tenant_day_instant
  -- rather than a restated expression, so a second copy of the rule would be
  -- visible here, not merely absent.
  SELECT * INTO r FROM app.dispatch_tyre(n1, 'AT_RETREADER', d_rt, today);
  ja := r.retread_job_id;
  SELECT e.occurred_at INTO stamp FROM app.tyre_event e
   WHERE e.tyre_id = n1 AND e.type = 'SENT_FOR_RETREAD';
  IF stamp IS DISTINCT FROM app.tenant_day_instant(today) OR stamp IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'FAIL 47n: a dispatch dated today is stamped %, not now()', stamp;
  END IF;

  SELECT * INTO r FROM app.dispatch_tyre(n2, 'AT_RETREADER', d_rt, today - 2);
  jb := r.retread_job_id;
  SELECT e.occurred_at INTO stamp FROM app.tyre_event e
   WHERE e.tyre_id = n2 AND e.type = 'SENT_FOR_RETREAD';
  IF stamp IS DISTINCT FROM app.tenant_day_instant(today - 2) THEN
    RAISE EXCEPTION 'FAIL 47n: a dispatch dated two days back is stamped %, not the shared day instant', stamp;
  END IF;
  -- The inverse pin: the tenant's own midnight, and not the session zone's
  -- cast of the same date, so the two checks cannot both be fooled by a
  -- third unrelated instant.
  IF (stamp AT TIME ZONE tz)::date IS DISTINCT FROM today - 2
     OR (stamp AT TIME ZONE tz)::time <> '00:00'
     OR stamp = (today - 2)::timestamptz THEN
    RAISE EXCEPTION 'FAIL 47n: an earlier day was resolved outside the tenant''s zone: %', stamp;
  END IF;
  PERFORM app.log_retread_return(jb, today - 1, true, 'T47-RPT-N', 2500.00, 12.0, 800.00);
  SELECT e.occurred_at INTO stamp FROM app.tyre_event e
   WHERE e.tyre_id = n2 AND e.type = 'RETURNED';
  IF stamp IS DISTINCT FROM app.tenant_day_instant(today - 1) THEN
    RAISE EXCEPTION 'FAIL 47n: a return dated yesterday is stamped %, not the shared day instant', stamp;
  END IF;

  BEGIN
    PERFORM app.dispatch_tyre(n3, 'AT_RETREADER', d_rt, today + 1);
    RAISE EXCEPTION 'FAIL 47n: a casing was sent on a future date';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS d1 = MESSAGE_TEXT;
    IF d1 <> 'a casing is sent on or before today, never on a future date' THEN
      RAISE EXCEPTION 'FAIL 47n: the dispatch refusal reads %', d1;
    END IF;
  END;
  BEGIN
    PERFORM app.log_retread_return(ja, today + 1, true, 'T47-RPT-F', 2500.00, 12.0, 800.00);
    RAISE EXCEPTION 'FAIL 47n: a casing returned on a future date';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN
    GET STACKED DIAGNOSTICS d2 = MESSAGE_TEXT;
    IF d2 <> 'a casing returns on or before today, never on a future date' THEN
      RAISE EXCEPTION 'FAIL 47n: the return refusal reads %', d2;
    END IF;
  END;
  -- The shared function answers NULL for a future day so each caller refuses
  -- in its own code and words; one wording for both would be the shape of a
  -- refusal that had moved into the helper.
  IF d1 = d2 THEN
    RAISE EXCEPTION 'FAIL 47n: the dispatch and the return refuse a future day in one voice: %', d1;
  END IF;
  RAISE NOTICE 'PASS  47n dispatch and retread return resolve a day through one rule and refuse the future in their own words';
END $$;

DO $$
DECLARE
  bac  uuid := '11111111-1111-1111-1111-111111111111';
  hp   uuid := md5('t47php')::uuid;
  tp   uuid := md5('t47ptp')::uuid;
  ctl5 uuid := md5('t47pctl')::uuid;
  sz1  uuid := md5('sz1')::uuid;
  tyx  uuid := md5('t47ptyx')::uuid;
  tyy  uuid := md5('t47ptyy')::uuid;
  tyz  uuid := md5('t47ptyz')::uuid;
  cfg uuid; p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid;
  moves jsonb; recv jsonb; n int;
  m_zero text; m_half text; m_str text; m_neg text; m_recv text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO p1 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  SELECT p.id INTO p2 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '2';
  SELECT p.id INTO p3 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '3';
  SELECT p.id INTO p4 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '4';
  SELECT p.id INTO p5 FROM app.position p WHERE p.configuration_id = cfg AND p.code = '5';
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (hp, bac, 'T47-PH', 'T47PH GP', cfg, 'HORSE',   md5('depot1')::uuid, 'ACTIVE'),
         (tp, bac, 'T47-PT', 'T47PT GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (ctl5, bac, 't47pctl@example.invalid', 'T47 Yard Clerk', 'CONTROLLER');
  PERFORM set_config('app.actor_id', ctl5::text, true);
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state) VALUES
    (tyx, bac, 'T47TYREX', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyy, bac, 'T47TYREY', sz1, 'NEW', 0, 'IN_STOCK'),
    (tyz, bac, 'T47TYREZ', sz1, 'NEW', 0, 'IN_STOCK');
  PERFORM app.create_combination(hp, jsonb_build_array(jsonb_build_object('vehicle_id', tp)));
  PERFORM app.fit_tyre(tyx, hp, p1, 12.0, 'MARK_OUTBOARD', 400000);
  PERFORM app.fit_tyre(tyy, tp, p2, 12.0, 'MARK_OUTBOARD');
  -- A second casing on the trailer, so a set can be built in which the horse
  -- only RECEIVES: two casings leaving one unit for another is the ordinary
  -- shape of a trailer stripped onto the horse, and it is the only shape in
  -- which a unit's reading meets no rotated-out fitment of its own.
  PERFORM app.fit_tyre(tyz, tp, p5, 12.0, 'MARK_OUTBOARD');
  -- One set of moves for every leg below, so the only thing that varies is
  -- the reading: a leg that refused for some second reason would refuse the
  -- control too, and the control is what says none of them did.
  moves := jsonb_build_array(
             jsonb_build_object('tyre_id', tyx, 'to_vehicle_id', tp, 'to_position_id', p3, 'tread_mm', 11.0),
             jsonb_build_object('tyre_id', tyy, 'to_vehicle_id', hp, 'to_position_id', p4, 'tread_mm', 11.0));

  -- (p) ADR-0012, U20: a reading this surface does not accept is refused as a
  -- rule, with a message a form can put beside a field, never as the bigint
  -- cast error the raw value would raise. A JSON encoder sending 405000.0 for
  -- a driver's 405000 is the same input to app.fitment as 405000.5: neither
  -- is a whole number of kilometres, and neither is rounded on the caller's
  -- behalf, since a stored odometer nobody entered is a distance nobody can
  -- check (FR-FIT-002, FR-FIT-009).
  BEGIN
    PERFORM app.rotate_tyres(hp, moves, jsonb_build_object(hp::text, 405000.0));
    RAISE EXCEPTION 'FAIL 47p: a reading carrying a scale was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m_zero = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.rotate_tyres(hp, moves, jsonb_build_object(hp::text, 405000.5));
    RAISE EXCEPTION 'FAIL 47p: a fractional reading was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m_half = MESSAGE_TEXT;
  END;
  BEGIN
    PERFORM app.rotate_tyres(hp, moves, jsonb_build_object(hp::text, '405000'));
    RAISE EXCEPTION 'FAIL 47p: a reading given as a string was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m_str = MESSAGE_TEXT;
  END;
  -- The wording is compared, not merely the SQLSTATE: TY014 is the whole of
  -- this surface's input vocabulary, so a scale caught by some other rule
  -- would answer the same code with a different sentence and this probe
  -- would pass on it.
  IF split_part(m_zero, '; ', 2) <> 'an odometer is a whole number of kilometres'
     OR split_part(m_half, '; ', 2) <> split_part(m_zero, '; ', 2)
     OR split_part(m_str,  '; ', 2) <> split_part(m_zero, '; ', 2) THEN
    RAISE EXCEPTION 'FAIL 47p: the three refusals do not share the whole-number wording: % / % / %',
      m_zero, m_half, m_str;
  END IF;
  -- And each carries its own reading, so the message is about the figure the
  -- caller sent rather than a sentence the function says to everyone.
  IF m_zero = m_half THEN
    RAISE EXCEPTION 'FAIL 47p: two different readings were refused in identical words: %', m_zero;
  END IF;
  -- A negative reading, on a unit that does have a fitment being rotated
  -- out, so which rule refused it is read, not assumed: it must be the input
  -- rule, not the per-unit bound, since that bound is answered only for
  -- units a casing is leaving and a sign caught there would miss the next
  -- unit, the case that follows. The bound keeps its own coverage in 47l, on
  -- low positive readings.
  BEGIN
    PERFORM app.rotate_tyres(hp, moves, jsonb_build_object(hp::text, -1));
    RAISE EXCEPTION 'FAIL 47p: a negative reading was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m_neg = MESSAGE_TEXT;
  END;
  IF m_neg NOT LIKE '%whole number%' THEN
    RAISE EXCEPTION 'FAIL 47p: a negative reading is not refused as an input: %', m_neg;
  END IF;
  IF m_neg LIKE '%below the odometer%' THEN
    RAISE EXCEPTION 'FAIL 47p: a negative reading was answered by a bound not every unit meets: %', m_neg;
  END IF;

  -- The same reading on a unit that only RECEIVES. The per-unit bound is
  -- answered against fitments being rotated OUT, so a destination-only unit
  -- meets no bound and its reading goes straight into fitted_odometer.
  -- Nothing but the input rule stands between a signed reading and 000001's
  -- CHECK (fitted_odometer >= 0), whose 23514 names no unit and no TY class
  -- for the outbox to retry against (ADR-0012).
  recv := jsonb_build_array(
            jsonb_build_object('tyre_id', tyy, 'to_vehicle_id', hp, 'to_position_id', p4, 'tread_mm', 11.0),
            jsonb_build_object('tyre_id', tyz, 'to_vehicle_id', hp, 'to_position_id', p3, 'tread_mm', 11.0));
  BEGIN
    PERFORM app.rotate_tyres(hp, recv, jsonb_build_object(hp::text, -1));
    RAISE EXCEPTION 'FAIL 47p: a negative reading on a unit that only receives was accepted';
  EXCEPTION WHEN SQLSTATE 'TY014' THEN GET STACKED DIAGNOSTICS m_recv = MESSAGE_TEXT;
  END;
  IF m_recv NOT LIKE '%whole number%' THEN
    RAISE EXCEPTION 'FAIL 47p: the destination-only refusal does not read as the input rule: %', m_recv;
  END IF;
  IF m_recv NOT LIKE '%-1%' THEN
    RAISE EXCEPTION 'FAIL 47p: the destination-only refusal does not carry the reading: %', m_recv;
  END IF;
  -- And it refused the whole set: a rotation is all of its moves or none
  -- (FR-FIT-010), so nothing may have landed on the horse.
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id IN (tyy, tyz) AND f.vehicle_id = hp;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 47p: % rows were opened on the receiving unit by a refused rotation', n;
  END IF;

  -- The control every refusal above rests on: the same moves and the same
  -- unit, read as a whole number, land.
  SELECT count(*) INTO n FROM app.rotate_tyres(hp, moves, jsonb_build_object(hp::text, 405000));
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL 47p: the whole-number control returned % rows, expected 2', n; END IF;
  SELECT count(*) INTO n FROM app.fitment f
   WHERE f.tyre_id = tyx AND f.vehicle_id = hp AND f.position_id = p1
     AND f.removed_at IS NOT NULL AND f.removed_odometer = 405000;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 47p: the horse''s closed row does not carry the reading it was given';
  END IF;
  RAISE NOTICE 'PASS  47p a scaled, string or signed reading is refused as an input, not as a cast or a constraint';
END $$;
ROLLBACK;

\echo '== 48. TYRE-185: the tread ceiling has one definition, read by capture and fitment alike (FR-INS-030)'
BEGIN;
DO $$
DECLARE
  t_id      constant uuid := '22222222-2222-2222-2222-222222222222';
  drv       constant uuid := md5('driver2')::uuid;
  mx        numeric;
  m         text;
  ok        boolean := false;
  payload   jsonb;
  posa      uuid;
  posb      uuid;
  v_raw     uuid;
  v_insp    uuid;
  v_reading uuid;
  v_second  uuid;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  PERFORM set_config('app.actor_id', drv::text, true);
  mx := app.max_tread_mm();
  IF mx IS DISTINCT FROM 35 THEN
    RAISE EXCEPTION 'FAIL 48: app.max_tread_mm() reads %, FR-INS-030 says 35', mx;
  END IF;

  -- Two positions off HORSE_6X4, tenant 2's configuration for t2veh1 and
  -- every unit planted below, shared by configuration, the way
  -- submit_inspection itself reads them.
  SELECT p.id INTO posa FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO posb FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence OFFSET 1 LIMIT 1;
  IF posa IS NULL OR posb IS NULL THEN
    RAISE EXCEPTION 'FAIL 48: section 48 cannot resolve the positions it tests against';
  END IF;

  -- A throwaway unit of its own for the raw CHECK probe below: it must carry
  -- no reading submit_inspection could later mistake as a prior inspection
  -- of the SAME unit inside FR-INS-038's window (000023).
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (md5('t2veh48raw')::uuid, t_id, 'SEC48-RAW', 'CAA484801',
          md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE')
  RETURNING id INTO v_raw;
  INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid,
                              started_at, submitted_at, odometer)
  VALUES (t_id, v_raw, drv, gen_random_uuid(), now(), now(), 750)
  RETURNING id INTO v_insp;
  INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id)
  VALUES (t_id, v_insp, v_raw, posa)
  RETURNING id INTO v_reading;

  -- The CHECK and the function agree: a row at the ceiling lands, a row past
  -- it is 23514.
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known)
  VALUES (t_id, v_reading, 1, 'CENTRE', mx, true);
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known)
    VALUES (t_id, v_reading, 2, 'OUTER', mx + 0.1, true);
    RAISE EXCEPTION 'FAIL 48: reading_measurement accepted % mm', mx + 0.1;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 48: the tread CHECK did not refuse % mm', mx + 0.1; END IF;

  -- The capture path reads the same number: a submit at the ceiling is
  -- accepted, one past it is TY005 carrying the ceiling in its message.
  -- t2veh1 is the fixture's own unit, untouched above, so FR-INS-038's
  -- window sees no prior inspection of it in this transaction.
  payload := jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', md5('t2veh1')::uuid,
    'started_at', now(), 'submitted_at', now(),
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', md5('t2veh1')::uuid, 'position_id', posa,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(mx, mx, mx))));
  PERFORM app.submit_inspection(payload);

  -- A further, still different unit for the refused submit, so FR-INS-038's
  -- window does not refuse it as a second inspection of t2veh1 above.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (md5('t2veh48')::uuid, t_id, 'SEC48-CEIL', 'CAA484802',
          md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE')
  RETURNING id INTO v_second;
  ok := false;
  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v_second,
      'started_at', now(), 'submitted_at', now(),
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v_second, 'position_id', posb,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(mx + 0.1, mx, mx)))));
    RAISE EXCEPTION 'FAIL 48: submit_inspection accepted a % mm tread', mx + 0.1;
  EXCEPTION WHEN SQLSTATE 'TY005' THEN GET STACKED DIAGNOSTICS m = MESSAGE_TEXT; ok := true;
  END;
  -- Matched against the ceiling clause itself, not a bare mx::text: the
  -- refused value is always mx + 0.1 (35.1), whose digits already contain
  -- "35", so a message that reverted to 000023's original wording (naming
  -- only the offending reading, never the bound) would still pass that
  -- weaker check.
  IF NOT ok OR strpos(m, '0 to ' || trunc(mx)::text || ' mm') = 0 THEN
    RAISE EXCEPTION 'FAIL 48: the capture refusal does not name the ceiling: %', m;
  END IF;
  RAISE NOTICE 'PASS  one tread ceiling (35 mm, FR-INS-030): the CHECK, the capture path and the fitment writers read it';
END $$;
ROLLBACK;

\echo '== 49. TYRE-166: a submitted_at ahead of the server clock beyond the tenant skew is refused; the past stays open (ADR-0009) (TY021, TYRE-215)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '22222222-2222-2222-2222-222222222222';
  drv  constant uuid := md5('driver2')::uuid;
  posa uuid;
  v2   uuid;
  v3   uuid;
  v4   uuid;
  m    text;
  ok   boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  PERFORM set_config('app.actor_id', drv::text, true);

  SELECT p.id INTO posa FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  -- Three units beyond the fixture's t2veh1, one per probe below, so
  -- FR-INS-038's per-unit window never explains a result this section means
  -- to attribute to the future-side bound instead.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status) VALUES
    (md5('t2veh49b')::uuid, t_id, 'SEC49-B', 'CAA494901', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE'),
    (md5('t2veh49c')::uuid, t_id, 'SEC49-C', 'CAA494902', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE'),
    (md5('t2veh49d')::uuid, t_id, 'SEC49-D', 'CAA494903', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE');
  v2 := md5('t2veh49b')::uuid;
  v3 := md5('t2veh49c')::uuid;
  v4 := md5('t2veh49d')::uuid;

  -- control: a device four minutes fast is inside the seeded five and lands
  PERFORM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', md5('t2veh1')::uuid,
    'started_at', now() - interval '150 seconds', 'submitted_at', now() + interval '4 minutes',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', md5('t2veh1')::uuid, 'position_id', posa,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));

  -- the past side is open: yesterday's capture drains from the outbox
  PERFORM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v2,
    'started_at', now() - interval '1 day' - interval '150 seconds', 'submitted_at', now() - interval '1 day',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v2, 'position_id', posa,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));

  BEGIN
    PERFORM app.submit_inspection(jsonb_build_object(
      'client_uuid', gen_random_uuid(), 'vehicle_id', v3,
      'started_at', now() - interval '150 seconds', 'submitted_at', now() + interval '6 minutes',
      'readings', jsonb_build_array(
        jsonb_build_object('vehicle_id', v3, 'position_id', posa,
                           'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
    RAISE EXCEPTION 'FAIL 49: a submit six minutes ahead of the server clock was accepted';
  EXCEPTION WHEN SQLSTATE 'TY021' THEN GET STACKED DIAGNOSTICS m = MESSAGE_TEXT; ok := true;
  END;
  IF NOT ok OR strpos(m, '5 minutes') = 0 THEN
    RAISE EXCEPTION 'FAIL 49: the refusal does not name the tenant allowance: %', m;
  END IF;

  -- rule 5: the allowance is the tenant's, not a literal. Widen it and the
  -- same shape of payload lands
  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES (t_id, 'submitted_at_future_skew_minutes', '10'::jsonb, now() - interval '1 second');
  PERFORM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v4,
    'started_at', now() - interval '150 seconds', 'submitted_at', now() + interval '6 minutes',
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v4, 'position_id', posa,
                         'pressure_kpa', 750, 'treads', jsonb_build_array(7.0, 7.0, 7.0)))));
  RAISE NOTICE 'PASS  submitted_at is bounded above by now() plus the tenant skew, open below';
END $$;
ROLLBACK;

\echo '== 50. TYRE-145: a submitted inspection is sealed; readings and measurements are written in its own transaction only (CR-011, DR-011)'
BEGIN;
DO $$
DECLARE r_id uuid; before_mm numeric; after_mm numeric; ok boolean := false; posid uuid; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  -- a seeded BAC reading: its inspection was committed by the seed, long before this transaction
  SELECT r.id, r.governing_tread_mm INTO r_id, before_mm FROM app.reading r
   WHERE r.governing_tread_mm IS NOT NULL ORDER BY r.id LIMIT 1;
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
    VALUES (app.current_tenant_id(), r_id, 99, 'OUTER', 0.5, false, 0.5);
    RAISE EXCEPTION 'FAIL 50: a measurement was appended to a sealed reading';
  EXCEPTION WHEN SQLSTATE 'TY020' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 50: the append was not refused TY020'; END IF;
  SELECT governing_tread_mm INTO after_mm FROM app.reading WHERE id = r_id;
  IF after_mm IS DISTINCT FROM before_mm THEN
    RAISE EXCEPTION 'FAIL 50: governing tread moved % -> %', before_mm, after_mm; END IF;
  -- the same door on app.reading: a new position cannot be added to an old inspection
  ok := false;
  BEGIN
    INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
    SELECT r.tenant_id, r.inspection_id, r.vehicle_id, p.id, NULL, 700
      FROM app.reading r JOIN app.vehicle v ON v.id = r.vehicle_id
      JOIN app.position p ON p.configuration_id = v.configuration_id
     WHERE r.id = r_id AND NOT EXISTS (SELECT 1 FROM app.reading x WHERE x.inspection_id = r.inspection_id AND x.position_id = p.id AND x.vehicle_id = r.vehicle_id)
     LIMIT 1;
    -- a zero-row INSERT ... SELECT raises nothing at all: without this check
    -- an unmatched free position would still print PASS on the "appended"
    -- exception below, having proven nothing about the trigger.
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN
      RAISE EXCEPTION 'FAIL 50: the reading probe found no free position';
    END IF;
    RAISE EXCEPTION 'FAIL 50: a reading was appended to a sealed inspection';
  EXCEPTION WHEN SQLSTATE 'TY020' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 50: the reading append was not refused TY020'; END IF;
  -- control: the legitimate path, inspection, reading and measurements in one
  -- transaction, still lands, and the governing MIN is materialised
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT p.id INTO posid FROM app.position p
   WHERE p.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t50insp')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t50cli')::uuid, now(), now(), 750);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t50rd')::uuid,'22222222-2222-2222-2222-222222222222',md5('t50insp')::uuid,md5('t2veh1')::uuid,posid,NULL,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t50rd')::uuid,1,'OUTER',9,true),
    ('22222222-2222-2222-2222-222222222222',md5('t50rd')::uuid,2,'CENTRE',8,true),
    ('22222222-2222-2222-2222-222222222222',md5('t50rd')::uuid,3,'INNER',10,true);
  SELECT governing_tread_mm INTO after_mm FROM app.reading WHERE id = md5('t50rd')::uuid;
  IF after_mm IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'FAIL 50: the same-transaction write did not materialise its MIN (got %)', after_mm; END IF;
  -- A row this session can see but cannot date is not this transaction's:
  -- every writer in one transaction gets created_at from that same now(), so
  -- an explicit NULL is a claim nobody made. created_at is nullable (000017:
  -- DEFAULT now(), not NOT NULL) and app_rw holds INSERT, so this is directly
  -- reachable, not hypothetical, and must seal rather than read as
  -- "unsealed forever".
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer,created_at)
  VALUES (md5('t50inspnull')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t50clinull')::uuid, now(), now(), 750, NULL);
  ok := false;
  BEGIN
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t50rdnull')::uuid,'22222222-2222-2222-2222-222222222222',md5('t50inspnull')::uuid,md5('t2veh1')::uuid,posid,NULL,700);
    RAISE EXCEPTION 'FAIL 50: a reading was appended to an inspection whose created_at is NULL';
  EXCEPTION WHEN SQLSTATE 'TY020' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 50: an inspection with a NULL created_at was not sealed'; END IF;
  -- rls-auditor (TYRE-145 fix round 2): a future-dated created_at is the
  -- same hole from the other side. app_rw can set the column to anything,
  -- so a row dated ahead of its own transaction would stay appendable until
  -- that instant passed. Only equality to transaction_timestamp() is sound.
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer,created_at)
  VALUES (md5('t50inspfuture')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t50clifuture')::uuid, now(), now(), 750, now() + interval '1 day');
  ok := false;
  BEGIN
    INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
    VALUES (md5('t50rdfuture')::uuid,'22222222-2222-2222-2222-222222222222',md5('t50inspfuture')::uuid,md5('t2veh1')::uuid,posid,NULL,700);
    RAISE EXCEPTION 'FAIL 50: a reading was appended to an inspection dated ahead of its own transaction';
  EXCEPTION WHEN SQLSTATE 'TY020' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 50: an inspection dated ahead of its own transaction was not sealed'; END IF;
  RAISE NOTICE 'PASS  a submitted inspection is sealed: later readings and measurements are refused TY020, the submitting transaction still writes';
END $$;
ROLLBACK;

\echo '== 51. TYRE-144: an inspection is written once; the void is the one update, and it is final (rule 3, FR-INS-011, FR-INS-012)'
BEGIN;
DO $$
DECLARE i_id uuid; ok boolean := false; st app.inspection_state;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  -- a live SYNCED row for the grant and trigger probes below; the reading's
  -- own values do not matter, only that the row is real
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t51insp')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t51cli')::uuid, now(), now(), 750);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t51rd')::uuid,'22222222-2222-2222-2222-222222222222',md5('t51insp')::uuid,md5('t2veh1')::uuid,
          (SELECT p.id FROM app.position p
             WHERE p.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
               AND NOT p.is_spare ORDER BY p.sequence LIMIT 1),
          NULL,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t51rd')::uuid,1,'OUTER',9,true),
    ('22222222-2222-2222-2222-222222222222',md5('t51rd')::uuid,2,'CENTRE',8,true),
    ('22222222-2222-2222-2222-222222222222',md5('t51rd')::uuid,3,'INNER',10,true);
  i_id := md5('t51insp')::uuid;
  -- the grant, not a trigger, refuses the columns that price a tyre (rule 3)
  BEGIN
    UPDATE app.inspection SET odometer = odometer + 100000 WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: the app role rewrote odometer';
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: odometer UPDATE was not refused by grant'; END IF;
  ok := false;
  BEGIN
    UPDATE app.inspection SET submitted_at = submitted_at + interval '1 year' WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: the app role rewrote submitted_at';
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: submitted_at UPDATE was not refused by grant'; END IF;
  IF has_table_privilege('app_rw', 'app.inspection', 'UPDATE')
     OR NOT has_column_privilege('app_rw', 'app.inspection', 'state', 'UPDATE')
     OR NOT has_column_privilege('app_rw', 'app.inspection', 'void_reason', 'UPDATE')
     OR has_column_privilege('app_rw', 'app.inspection', 'odometer', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 51: app_rw''s UPDATE on app.inspection is not exactly (state, void_reason)';
  END IF;
  -- the trigger bounds the shape the grant leaves open
  ok := false;
  BEGIN
    UPDATE app.inspection SET state = 'QUEUED' WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: state moved somewhere other than VOIDED';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: a non-void state change was not refused TY019'; END IF;
  ok := false;
  BEGIN
    UPDATE app.inspection SET state = 'VOIDED' WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: a void without a reason was accepted';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: a reasonless void was not refused TY019'; END IF;
  -- the grant admits a void_reason-only UPDATE on a live row (state stays
  -- SYNCED), which is a shape the terminal-void branch above never reaches;
  -- this is the trigger's other branch, closing that door too
  ok := false;
  BEGIN
    UPDATE app.inspection SET void_reason = 'stray' WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: void_reason was written on a live row without a void';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: a void_reason edit on a live row was not refused TY019'; END IF;
  -- control: the one permitted shape lands
  UPDATE app.inspection SET state = 'VOIDED', void_reason = 'section 51 probe' WHERE id = i_id;
  SELECT state INTO st FROM app.inspection WHERE id = i_id;
  IF st IS DISTINCT FROM 'VOIDED' THEN RAISE EXCEPTION 'FAIL 51: the void did not land'; END IF;
  -- and it is final: no un-void, no second void, no edit of the reason
  ok := false;
  BEGIN
    UPDATE app.inspection SET state = 'SYNCED', void_reason = NULL WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: a void was reversed';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: an un-void was not refused TY019'; END IF;
  ok := false;
  BEGIN
    UPDATE app.inspection SET void_reason = 'rewritten' WHERE id = i_id;
    RAISE EXCEPTION 'FAIL 51: a void reason was rewritten';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 51: editing a voided row was not refused TY019'; END IF;
  RAISE NOTICE 'PASS  app.inspection: only (state, void_reason) are updatable, only SYNCED -> VOIDED with a reason, and a void is final';
END $$;
ROLLBACK;

\echo '== 52. TYRE-164: app.void_inspection is the correction path -- reason required, audited, tenant-bound, final (FR-INS-012, FR-AUD-001)'
BEGIN;
DO $$
DECLARE i_id uuid; posid uuid; ok boolean := false; n int; st app.inspection_state; rsn text; wst text;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  PERFORM set_config('app.actor_id', md5('driver2')::text::uuid::text, true);

  -- A fitted probe tyre with two readings 1500km apart, past the tenant's
  -- configured wear_rate_min_distance_km of 1000, so v_tyre_wear_rate reads
  -- MEASURED before anything below runs. A single reading would already read
  -- INSUFFICIENT_READINGS with or without a void, which would make the
  -- exclusion assertion below pass regardless of whether the trigger chain
  -- works, the vacuous-check trap this section exists to avoid.
  SELECT pos.id INTO posid
    FROM app.position pos JOIN app.vehicle vh ON vh.configuration_id = pos.configuration_id
   WHERE vh.id = md5('t2veh1')::uuid AND pos.code = '1';
  INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,casing_value,state)
  VALUES (md5('t52tyre')::uuid,'22222222-2222-2222-2222-222222222222','T52TYRE','NEW','2024-03-01',2100.00,25.0,100.0000,500.00,'IN_STOCK');
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer, fitted_tread_mm)
  VALUES ('22222222-2222-2222-2222-222222222222', md5('t52tyre')::uuid, md5('t2veh1')::uuid, posid, '2026-08-01T00:00:00Z', 90000, 10.0);

  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t52insp_early')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t52clie')::uuid,'2026-08-01T06:55:00Z','2026-08-01T07:00:00Z',90000);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t52read_early')::uuid,'22222222-2222-2222-2222-222222222222',md5('t52insp_early')::uuid,md5('t2veh1')::uuid,posid,md5('t52tyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t52read_early')::uuid,1,'OUTER',10,true),
    ('22222222-2222-2222-2222-222222222222',md5('t52read_early')::uuid,2,'CENTRE',10,true),
    ('22222222-2222-2222-2222-222222222222',md5('t52read_early')::uuid,3,'INNER',10,true);

  -- md5('t52insp') is the LATER of the pair and the one this section voids
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t52insp')::uuid,'22222222-2222-2222-2222-222222222222',md5('t2veh1')::uuid,md5('driver2')::uuid,
          md5('t52cli')::uuid,'2026-08-08T06:55:00Z','2026-08-08T07:00:00Z',91500);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t52read')::uuid,'22222222-2222-2222-2222-222222222222',md5('t52insp')::uuid,md5('t2veh1')::uuid,posid,md5('t52tyre')::uuid,750);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known) VALUES
    ('22222222-2222-2222-2222-222222222222',md5('t52read')::uuid,1,'OUTER',9,true),
    ('22222222-2222-2222-2222-222222222222',md5('t52read')::uuid,2,'CENTRE',9,true),
    ('22222222-2222-2222-2222-222222222222',md5('t52read')::uuid,3,'INNER',9,true);
  i_id := md5('t52insp')::uuid;

  SELECT wear_rate_status INTO wst FROM app.v_tyre_wear_rate WHERE tyre_id = md5('t52tyre')::uuid;
  IF wst IS DISTINCT FROM 'MEASURED' THEN
    RAISE EXCEPTION 'FAIL 52: probe tyre read % before any void, expected MEASURED (the exclusion check below would be vacuous)', wst; END IF;

  BEGIN
    PERFORM app.void_inspection(i_id, '   ');
    RAISE EXCEPTION 'FAIL 52: a blank reason was accepted';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 52: a blank reason was not refused TY019'; END IF;
  PERFORM app.void_inspection(i_id, '  wrong vehicle  ');
  SELECT state, void_reason INTO st, rsn FROM app.inspection WHERE id = i_id;
  IF st IS DISTINCT FROM 'VOIDED' OR rsn IS DISTINCT FROM 'wrong vehicle' THEN
    RAISE EXCEPTION 'FAIL 52: void landed as [% / %]', st, rsn; END IF;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'inspection' AND entity_id = i_id AND action = 'UPDATE'
     AND (after ->> 'state') = 'VOIDED' AND actor_id = md5('driver2')::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 52: expected one audit row for the void, found %', n; END IF;
  ok := false;
  BEGIN
    PERFORM app.void_inspection(i_id, 'again');
    RAISE EXCEPTION 'FAIL 52: a second void was accepted';
  EXCEPTION WHEN SQLSTATE 'TY019' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 52: a second void was not refused TY019'; END IF;
  -- the analytics exclusion FR-INS-012 asks for is the existing state <> 'VOIDED'
  -- predicate; prove one reader honours it. The void above removed the probe
  -- tyre's only reading past the tenant's minimum distance, so the wear rate,
  -- proven MEASURED above, now carries the reason instead of a stale rate
  SELECT wear_rate_status INTO wst FROM app.v_tyre_wear_rate WHERE tyre_id = md5('t52tyre')::uuid;
  IF wst IS DISTINCT FROM 'INSUFFICIENT_READINGS' THEN
    RAISE EXCEPTION 'FAIL 52: a voided inspection still feeds the wear rate (status %, expected INSUFFICIENT_READINGS)', wst; END IF;
  -- tenant-bound: another tenant's inspection is invisible, and the answer is
  -- TY012, not a silent zero-row update (lesson 2026-09-01: a shared
  -- SQLSTATE makes the probe vacuous, so this one is the only TY012 here)
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  ok := false;
  BEGIN
    PERFORM app.void_inspection(i_id, 'not mine');
    RAISE EXCEPTION 'FAIL 52: tenant 1 voided tenant 2''s inspection';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 52: cross-tenant void was not refused TY012'; END IF;
  RAISE NOTICE 'PASS  void_inspection: reason required and trimmed, audited under the actor, final, tenant-bound (TY012), excludes the tyre from the wear rate';
END $$;
ROLLBACK;

\echo '== 53. TYRE-155: a spare a unit does not carry is an observation on the inspection, append-only, tenant-bound (FR-INS-066, BR-VEH-002)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '22222222-2222-2222-2222-222222222222';
  drv  constant uuid := md5('driver2')::uuid;
  -- Three units, one per submit below, so FR-INS-038's per-unit duplicate
  -- window (default 4h) cannot explain a refusal this section means to
  -- attribute to something else: all three submits below stamp submitted_at
  -- ~ now(), and reusing one vehicle across them would trip TY003 instead of
  -- the SQLSTATE each control exists to pin (section 49's own reasoning).
  v_a constant uuid := md5('t2veh53a')::uuid;
  v_b constant uuid := md5('t2veh53b')::uuid;
  v_c constant uuid := md5('t2veh53c')::uuid;
  p_run   uuid;
  p_spare uuid;
  insp uuid;
  n int;
  ok boolean := false;
  m text;
  -- Position-shaped and header-shaped templates, completed per submit with
  -- the vehicle and position the case needs; positions belong to the axle
  -- CONFIGURATION (not to a vehicle), so p_run/p_spare hold for all three.
  reading jsonb := jsonb_build_object(
    'tyre_id', NULL, 'pressure_kpa', 800, 'pressure_temperature', 'UNKNOWN',
    'damage_flag', false, 'note', NULL, 'treads', '[12,13,14]'::jsonb,
    'granularity_mm', 1.0, 'seconds', 30, 'warnings', '[]'::jsonb);
  base jsonb := jsonb_build_object(
    'combination_id', NULL, 'observed_member_vehicle_ids', '[]'::jsonb, 'task_id', NULL,
    'started_at', now() - interval '150 seconds', 'submitted_at', now(),
    'odometer_km', NULL, 'duration_seconds', 150, 'completeness_pct', 100,
    'comment', NULL, 'defect_report', NULL, 'device_id', 'suite', 'app_version', 'suite',
    'warnings', '[]'::jsonb);
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  PERFORM set_config('app.actor_id', drv::text, true);

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status) VALUES
    (v_a, t_id, 'SEC53-A', 'CAA535301', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE'),
    (v_b, t_id, 'SEC53-B', 'CAA535302', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE'),
    (v_c, t_id, 'SEC53-C', 'CAA535303', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE');

  SELECT p.id INTO p_run FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO p_spare FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND p.is_spare ORDER BY p.sequence LIMIT 1;

  -- The observation lands, once, against the unit and the spare position.
  SELECT inspection_id INTO insp FROM app.submit_inspection(
    base || jsonb_build_object('client_uuid', gen_random_uuid(), 'vehicle_id', v_a,
      'readings', jsonb_build_array(reading || jsonb_build_object('vehicle_id', v_a, 'position_id', p_run)),
      'absent_spares', jsonb_build_array(jsonb_build_object('vehicle_id', v_a, 'position_id', p_spare))));
  SELECT count(*) INTO n FROM app.inspection_absent_spare
   WHERE inspection_id = insp AND vehicle_id = v_a AND position_id = p_spare;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 53: expected one absent-spare row, found %', n; END IF;

  -- A running position cannot be "absent": only a spare may be reported so.
  -- Trapped on the message, not the bare SQLSTATE: deleting the "is not a
  -- spare" guard in 000041 would fall through to the has-a-reading branch
  -- below, which also raises TY005 for this exact payload (p_run carries a
  -- reading here, so a bare SQLSTATE trap could not tell the two guards
  -- apart, which is the whole point of a control).
  BEGIN
    PERFORM app.submit_inspection(
      base || jsonb_build_object('client_uuid', gen_random_uuid(), 'vehicle_id', v_b,
        'readings', jsonb_build_array(reading || jsonb_build_object('vehicle_id', v_b, 'position_id', p_run)),
        'absent_spares', jsonb_build_array(jsonb_build_object('vehicle_id', v_b, 'position_id', p_run))));
    RAISE EXCEPTION 'FAIL 53: a running position was accepted as an absent spare';
  EXCEPTION WHEN SQLSTATE 'TY005' THEN
    GET STACKED DIAGNOSTICS m = MESSAGE_TEXT;
    ok := m LIKE '%is not a spare%';
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 53: wrong refusal: %', m; END IF;

  -- A spare cannot be both read and absent in one submit.
  ok := false;
  BEGIN
    PERFORM app.submit_inspection(
      base || jsonb_build_object('client_uuid', gen_random_uuid(), 'vehicle_id', v_c,
        'readings', jsonb_build_array(
          reading || jsonb_build_object('vehicle_id', v_c, 'position_id', p_run),
          reading || jsonb_build_object('vehicle_id', v_c, 'position_id', p_spare)),
        'absent_spares', jsonb_build_array(jsonb_build_object('vehicle_id', v_c, 'position_id', p_spare))));
    RAISE EXCEPTION 'FAIL 53: a spare was accepted as both read and absent';
  EXCEPTION WHEN SQLSTATE 'TY005' THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 53: second control did not run'; END IF;

  -- Rule 3 by grant: the app role cannot rewrite or remove the observation.
  ok := false;
  BEGIN
    UPDATE app.inspection_absent_spare SET position_id = p_run WHERE inspection_id = insp;
    RAISE EXCEPTION 'FAIL 53: UPDATE on inspection_absent_spare was allowed';
  EXCEPTION WHEN insufficient_privilege THEN ok := true;
  END;
  BEGIN
    DELETE FROM app.inspection_absent_spare WHERE inspection_id = insp;
    RAISE EXCEPTION 'FAIL 53: DELETE on inspection_absent_spare was allowed';
  EXCEPTION WHEN insufficient_privilege THEN ok := ok AND true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 53: grant control did not run'; END IF;

  RAISE NOTICE 'PASS  an absent spare is recorded once, only for a spare, never beside a reading, and never rewritten';
END $$;
-- Tenant isolation (RLS, rule 1): switched to tenant 1 via set_config inside
-- its own DO block, not a bare SET LOCAL. The plant above belongs to
-- tenant 2, so this has to land on the OTHER tenant to prove anything.
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM app.inspection_absent_spare;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 53: another tenant reads % absent-spare row(s)', n; END IF;
  RAISE NOTICE 'PASS  absent-spare observations do not cross tenants';
END $$;
ROLLBACK;

\echo '== 54. TYRE-150: NFR-USE-001 reads active seconds (the sum of per-position capture time), not the wall clock from Start (NFR-OBS-007, H.3 criterion 2)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '22222222-2222-2222-2222-222222222222';
  drv  constant uuid := md5('driver2')::uuid;
  -- Two vehicles, one per submit, so FR-INS-038's per-unit duplicate window
  -- cannot explain the control's refusal (section 53's reasoning).
  v_a constant uuid := md5('t2veh54a')::uuid;
  v_b constant uuid := md5('t2veh54b')::uuid;
  p_run  uuid;
  p_run2 uuid;
  insp uuid;
  elapsed int;
  active  int;
  base jsonb;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  PERFORM set_config('app.actor_id', drv::text, true);

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status) VALUES
    (v_a, t_id, 'SEC54-A', 'CAA545401', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE'),
    (v_b, t_id, 'SEC54-B', 'CAA545402', md5(t_id::text || 'HORSE_6X4')::uuid, 'HORSE', 'ACTIVE');

  SELECT p.id INTO p_run FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO p_run2 FROM app.position p
   WHERE p.configuration_id = md5(t_id::text || 'HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence OFFSET 1 LIMIT 1;

  -- Two readings, 40 and 50 seconds of capture time, against a started_at
  -- two hours before submitted_at: elapsed_seconds must report the two
  -- hours and active_seconds the 90, proving the view reads the wall clock
  -- and the per-position sum from two different sources rather than one
  -- derived from the other.
  base := jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v_a,
    'started_at', now() - interval '2 hours', 'submitted_at', now(),
    'duration_seconds', 7200,
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v_a, 'position_id', p_run,
        'pressure_kpa', 800, 'treads', '[12,13,14]'::jsonb, 'seconds', 40),
      jsonb_build_object('vehicle_id', v_a, 'position_id', p_run2,
        'pressure_kpa', 800, 'treads', '[12,13,14]'::jsonb, 'seconds', 50)));

  SELECT inspection_id INTO insp FROM app.submit_inspection(base);
  SELECT elapsed_seconds, active_seconds INTO elapsed, active
    FROM app.v_inspection_timing WHERE inspection_id = insp;
  IF elapsed <> 7200 THEN RAISE EXCEPTION 'FAIL 54: elapsed_seconds is %, expected 7200', elapsed; END IF;
  IF active <> 90 THEN RAISE EXCEPTION 'FAIL 54: active_seconds is %, expected 90 (40 + 50)', active; END IF;

  -- Control: one reading with no capture time beside one that has 50 must
  -- withhold the sum entirely, never report the 50 alone (ADR-0010 rule 2,
  -- absence is absence). A single missing reading cannot prove this, since
  -- sum() over one NULL is already NULL with no guard, so a second, present
  -- value is needed for a guardless sum to leak. Both readings move to v_b,
  -- inside their reading objects too: the duplicate-window check reads
  -- readings[].vehicle_id, not the payload header, so leaving them at v_a
  -- would trip TY003 rather than exercise this control.
  SELECT inspection_id INTO insp FROM app.submit_inspection(
    base || jsonb_build_object('client_uuid', gen_random_uuid(), 'vehicle_id', v_b,
      'readings', jsonb_build_array(
        ((base -> 'readings' -> 0) - 'seconds') || jsonb_build_object('vehicle_id', v_b),
        (base -> 'readings' -> 1) || jsonb_build_object('vehicle_id', v_b))));
  SELECT active_seconds INTO active FROM app.v_inspection_timing WHERE inspection_id = insp;
  IF active IS NOT NULL THEN RAISE EXCEPTION 'FAIL 54: one missing capture time beside a present 50 summed to % instead of NULL', active; END IF;

  RAISE NOTICE 'PASS  v_inspection_timing reports elapsed and active seconds apart, and absence as NULL';
END $$;
ROLLBACK;

\echo '== 55. TYRE-158: the app role cannot write app.tenant, so tenant_subdomain_key cannot answer whether another tenant holds a subdomain (rule 1, TYRE-87)'
BEGIN;
DO $$
DECLARE ok boolean := false; updated boolean := false; n int; own text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  -- control: the row is readable, so a refusal below is the grant and not RLS
  SELECT count(*) INTO n FROM app.tenant WHERE id = app.current_tenant_id();
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 55: own tenant row not visible (%)', n; END IF;
  SELECT subdomain INTO own FROM app.tenant WHERE id = app.current_tenant_id();
  -- The oracle: app.tenant's UNIQUE (subdomain) is global, so it alone can
  -- answer whether a guessed subdomain belongs to another tenant. Both
  -- probes must be refused by the grant (insufficient_privilege) and not by
  -- anything else that could still carry the answer: RLS's WITH CHECK also
  -- raises 42501 but with a different message (lesson 2026-09-01), and the
  -- unique key itself raises 23505 for the taken value while succeeding for
  -- a free one, so a probe that reaches the key answers with the very oracle
  -- this section closes. That class is caught and named, not left to escape
  -- the DO block as a raw error.
  BEGIN
    UPDATE app.tenant SET subdomain = 'sandbox' WHERE id = app.current_tenant_id();
    updated := true;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM LIKE 'permission denied%' THEN ok := true;
    ELSE RAISE EXCEPTION 'FAIL 55: taken-subdomain probe refused by something other than the grant: %', SQLERRM; END IF;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL 55: taken-subdomain probe refused by % (%), not by the grant', SQLSTATE, SQLERRM;
  END;
  IF updated THEN RAISE EXCEPTION 'FAIL 55: app_rw updated app.tenant (taken subdomain probe)'; END IF;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 55: the taken-subdomain probe was not refused by grant'; END IF;
  ok := false;
  updated := false;
  BEGIN
    UPDATE app.tenant SET subdomain = 'zz-' || substr(md5(random()::text), 1, 8) WHERE id = app.current_tenant_id();
    updated := true;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM LIKE 'permission denied%' THEN ok := true;
    ELSE RAISE EXCEPTION 'FAIL 55: free-subdomain probe refused by something other than the grant: %', SQLERRM; END IF;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL 55: free-subdomain probe refused by % (%), not by the grant', SQLSTATE, SQLERRM;
  END;
  IF updated THEN RAISE EXCEPTION 'FAIL 55: app_rw updated app.tenant (free subdomain probe)'; END IF;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 55: the free-subdomain probe was not refused by grant'; END IF;
  RAISE NOTICE 'PASS  55 app.tenant is not writable by app_rw: taken and free subdomains are indistinguishable (permission denied both), own row (%) still readable', own;
END $$;
ROLLBACK;

\echo '== 56. TYRE-170: the server the suite runs against reads UTC as app_login (rule 6)'
DO $$
DECLARE tz text;
BEGIN
  -- The API pins its own sessions (store.New). This pins the server the
  -- suite's own date predicates run under, so a changed postgresql.conf or a
  -- role setting fails the build here instead of shifting the tyre
  -- register's dates by a day in production.
  tz := current_setting('TimeZone');
  IF tz <> 'UTC' THEN
    RAISE EXCEPTION 'FAIL 56: session TimeZone is % for %, expected UTC', tz, current_user;
  END IF;
  RAISE NOTICE 'PASS  56 session TimeZone is UTC for %', current_user;
END $$;

\echo '== 57. TYRE-172: unit_kind is required by the schema, not only by the API (ADR-0013 accepted gap, closed)'
BEGIN;
DO $$
DECLARE ok boolean := false; nullable text; cfg uuid;
BEGIN
  SELECT is_nullable INTO nullable FROM information_schema.columns
   WHERE table_schema = 'app' AND table_name = 'vehicle' AND column_name = 'unit_kind';
  IF nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'FAIL 57: vehicle.unit_kind is_nullable = %', nullable;
  END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  BEGIN
    INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id)
    VALUES ('11111111-1111-1111-1111-111111111111', 'T172-NOKIND', cfg);
    RAISE EXCEPTION 'FAIL 57: a vehicle without a unit_kind was accepted';
  EXCEPTION WHEN not_null_violation THEN
    IF SQLERRM LIKE '%unit_kind%' THEN ok := true;
    ELSE RAISE EXCEPTION 'FAIL 57: refused on another NOT NULL column, not unit_kind: %', SQLERRM; END IF;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 57: the kind-less insert was not refused as 23502'; END IF;
  -- control: the same row with a kind lands, so the refusal above is the
  -- column and not something else about the row
  INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
  VALUES ('11111111-1111-1111-1111-111111111111', 'T172-KIND', cfg, 'HORSE');
  RAISE NOTICE 'PASS  57 unit_kind is NOT NULL; a kind-less insert is 23502 and the same row with a kind lands';
END $$;
ROLLBACK;

\echo '== 58. TYRE-75: a reported composition is applied into a dated rig change, or dismissed with a reason (FR-INS-063 as corrected by D5, BR-FIT-008, TY022)'
BEGIN;
DO $$
DECLARE
  t_id constant uuid := '22222222-2222-2222-2222-222222222222';
  ctl  constant uuid := md5('t58ctl')::uuid;
  cfg  constant uuid := md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid;
  h    constant uuid := md5('t58ah')::uuid;
  tr   constant uuid := md5('t58at')::uuid;
  h2   constant uuid := md5('t58ah2')::uuid;
  args text; rig uuid; rig2 uuid; ended timestamptz; started timestamptz; msg text;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (ctl, t_id, 't58ctl@example.invalid', 'T58 Controller', 'CONTROLLER');
  PERFORM set_config('app.actor_id', ctl::text, true);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind, status) VALUES
    (h,  t_id, 'T58A-H',  cfg, 'HORSE',   'ACTIVE'),
    (h2, t_id, 'T58A-H2', cfg, 'HORSE',   'ACTIVE'),
    (tr, t_id, 'T58A-T',  cfg, 'TRAILER', 'ACTIVE');

  -- The cores exist under the signatures app.apply_composition_observation
  -- calls, pinned as identity arguments rather than a bare name: an overload
  -- added later would leave a name-only check green while the call below
  -- resolved elsewhere (U11's reasoning applied to routines). regprocedure
  -- renders a name relative to search_path, and the suite sets app first at
  -- its head, so the expected spelling is unqualified.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO args
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.proname IN ('create_combination_at', 'end_combination_at');
  IF args IS DISTINCT FROM
     'create_combination_at(uuid,jsonb,timestamp with time zone), end_combination_at(uuid,timestamp with time zone)' THEN
    RAISE EXCEPTION 'FAIL 58a: the instant-taking cores read as [%]', COALESCE(args, 'absent');
  END IF;

  -- A future instant is refused in the core, in 000037's own words, so the
  -- date wrapper and a direct instant caller answer the same sentence.
  BEGIN
    PERFORM app.create_combination_at(h, jsonb_build_array(jsonb_build_object('vehicle_id', tr)),
                                      now() + interval '1 hour');
    RAISE EXCEPTION 'FAIL 58a: a rig was set at a future instant';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a rig is set as at today or earlier, never in the future' THEN
      RAISE EXCEPTION 'FAIL 58a: wrong message %', msg;
    END IF;
  END;

  -- The three instants are ordered on purpose, effective_from < started <
  -- now(): an assertion that a core wrote the instant it was GIVEN is only
  -- meaningful where that instant differs from the transaction clock, so
  -- both rigs use the core with an explicit offset (offsets relative to
  -- now(), not a date, so no tenant timezone can move them across a day
  -- boundary, lesson 2026-09-03). The end and the create still share ONE
  -- instant, which is what a resolution does: combination_member_in_order
  -- compares c.effective_to > starts strictly (000037), so a trailer leaving
  -- at that instant may join the next rig starting at it.
  rig := app.create_combination_at(h, jsonb_build_array(jsonb_build_object('vehicle_id', tr)),
                                   now() - interval '2 hours');
  started := now() - interval '1 hour';
  -- Each instant is read back immediately after the call that set it, before
  -- the next call. Asserting both at the end instead would let the member
  -- trigger answer first: a core that stored now() leaves the offered rig
  -- ending after the next one starts, and INV-4 refuses that with its own
  -- message, so the mutation would be caught by the wrong assertion.
  PERFORM app.end_combination_at(rig, started);
  SELECT c.effective_to INTO ended FROM app.combination c WHERE c.id = rig;
  IF ended IS DISTINCT FROM started THEN
    RAISE EXCEPTION 'FAIL 58a: the offered rig ended at %, not at the instant given (%)', ended, started;
  END IF;
  rig2 := app.create_combination_at(h2, jsonb_build_array(jsonb_build_object('vehicle_id', tr)), started);
  SELECT c.effective_from INTO ended FROM app.combination c WHERE c.id = rig2;
  IF ended IS DISTINCT FROM started THEN
    RAISE EXCEPTION 'FAIL 58a: the new rig starts at %, not at the instant given (%)', ended, started;
  END IF;

  -- The end side's own future refusal, in 000037's words. Without it nothing
  -- here exercises end_combination_at's date guard, and only the create side
  -- would show that a core consults p_at at all. rig2 is still open at this
  -- point, so what answers is the date check and not the already-ended one.
  BEGIN
    PERFORM app.end_combination_at(rig2, now() + interval '1 hour');
    RAISE EXCEPTION 'FAIL 58a: a rig was ended at a future instant';
  EXCEPTION WHEN SQLSTATE 'TY017' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a rig is ended as at today or earlier, never in the future' THEN
      RAISE EXCEPTION 'FAIL 58a: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  58a the instant-taking cores exist, store the instant given rather than the clock, refuse a future instant on both sides, and hand a trailer straight from one rig to the next at one instant';
END $$;

DO $$
DECLARE
  t_id  constant uuid := '22222222-2222-2222-2222-222222222222';
  t_one constant uuid := '11111111-1111-1111-1111-111111111111';
  ctl   constant uuid := md5('t58bctl')::uuid;
  drv   constant uuid := md5('t58bdrv')::uuid;
  cfg   constant uuid := md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid;
  h1 constant uuid := md5('t58h1')::uuid;  t1 constant uuid := md5('t58t1')::uuid;
  t2 constant uuid := md5('t58t2')::uuid;
  h2 constant uuid := md5('t58h2')::uuid;  t3 constant uuid := md5('t58t3')::uuid;
  t4 constant uuid := md5('t58t4')::uuid;
  h3 constant uuid := md5('t58h3')::uuid;  t5 constant uuid := md5('t58t5')::uuid;
  t6 constant uuid := md5('t58t6')::uuid;
  h4 constant uuid := md5('t58h4')::uuid;  t7 constant uuid := md5('t58t7')::uuid;
  t8 constant uuid := md5('t58t8')::uuid;
  h5 constant uuid := md5('t58h5')::uuid;  t9 constant uuid := md5('t58t9')::uuid;
  h6 constant uuid := md5('t58h6')::uuid;  t10 constant uuid := md5('t58t10')::uuid;
  t11 constant uuid := md5('t58t11')::uuid;
  h7 constant uuid := md5('t58h7')::uuid;  t12 constant uuid := md5('t58t12')::uuid;
  t13 constant uuid := md5('t58t13')::uuid;
  h8 constant uuid := md5('t58h8')::uuid;  t14 constant uuid := md5('t58t14')::uuid;
  t15 constant uuid := md5('t58t15')::uuid;
  h9 constant uuid := md5('t58h9')::uuid;  t16 constant uuid := md5('t58t16')::uuid;
  t17 constant uuid := md5('t58t17')::uuid;
  p_run uuid;
  rig1 uuid; rig2 uuid; rig3 uuid; rig4 uuid; rig5 uuid; rig6 uuid;
  rig7 uuid; rig8 uuid;
  insp uuid; new_rig uuid; got uuid; open_before int; open_after int;
  w1 uuid; w_stale uuid; w_void uuid; w_notours uuid; w_client uuid;
  w_outside uuid; w_ghost uuid; w_nomotive uuid; w_nullel uuid;
  w_early uuid; w_future uuid;
  w_dismiss uuid;
  ghost uuid; started timestamptz; from_at timestamptz; received timestamptz;
  n int; msg text; members text;
  reading jsonb;
BEGIN
  PERFORM set_config('app.tenant_id', t_id::text, true);
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role) VALUES
    (ctl, t_id, 't58bctl@example.invalid', 'T58 Controller B', 'CONTROLLER'),
    (drv, t_id, 't58bdrv@example.invalid', 'T58 Driver B',     'DRIVER');
  PERFORM set_config('app.actor_id', ctl::text, true);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind, status) VALUES
    (h1, t_id, 'T58-H1', cfg, 'HORSE', 'ACTIVE'), (t1, t_id, 'T58-T1', cfg, 'TRAILER', 'ACTIVE'),
    (t2, t_id, 'T58-T2', cfg, 'TRAILER', 'ACTIVE'),
    (h2, t_id, 'T58-H2', cfg, 'HORSE', 'ACTIVE'), (t3, t_id, 'T58-T3', cfg, 'TRAILER', 'ACTIVE'),
    (t4, t_id, 'T58-T4', cfg, 'TRAILER', 'ACTIVE'),
    (h3, t_id, 'T58-H3', cfg, 'HORSE', 'ACTIVE'), (t5, t_id, 'T58-T5', cfg, 'TRAILER', 'ACTIVE'),
    (t6, t_id, 'T58-T6', cfg, 'TRAILER', 'ACTIVE'),
    (h4, t_id, 'T58-H4', cfg, 'HORSE', 'ACTIVE'), (t7, t_id, 'T58-T7', cfg, 'TRAILER', 'ACTIVE'),
    (t8, t_id, 'T58-T8', cfg, 'TRAILER', 'ACTIVE'),
    (h5, t_id, 'T58-H5', cfg, 'HORSE', 'ACTIVE'), (t9, t_id, 'T58-T9', cfg, 'TRAILER', 'ACTIVE'),
    (h6, t_id, 'T58-H6', cfg, 'HORSE', 'ACTIVE'), (t10, t_id, 'T58-T10', cfg, 'TRAILER', 'ACTIVE'),
    (t11, t_id, 'T58-T11', cfg, 'TRAILER', 'ACTIVE'),
    (h7, t_id, 'T58-H7', cfg, 'HORSE', 'ACTIVE'), (t12, t_id, 'T58-T12', cfg, 'TRAILER', 'ACTIVE'),
    (t13, t_id, 'T58-T13', cfg, 'TRAILER', 'ACTIVE'),
    (h8, t_id, 'T58-H8', cfg, 'HORSE', 'ACTIVE'), (t14, t_id, 'T58-T14', cfg, 'TRAILER', 'ACTIVE'),
    (t15, t_id, 'T58-T15', cfg, 'TRAILER', 'ACTIVE'),
    (h9, t_id, 'T58-H9', cfg, 'HORSE', 'ACTIVE'), (t16, t_id, 'T58-T16', cfg, 'TRAILER', 'ACTIVE'),
    (t17, t_id, 'T58-T17', cfg, 'TRAILER', 'ACTIVE');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (t_id, h1, drv, now() - interval '1 day');
  SELECT p.id INTO p_run FROM app.position p
   WHERE p.configuration_id = cfg AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;

  -- Set two hours ago through the core: now() is one instant for the whole
  -- transaction, and a capture may not start before the rig it names was set
  -- (apply's own guard).
  rig1 := app.create_combination_at(h1, jsonb_build_array(
            jsonb_build_object('vehicle_id', t1, 'descriptor', 'front'),
            jsonb_build_object('vehicle_id', t2, 'descriptor', NULL),
            jsonb_build_object('vehicle_id', t13, 'descriptor', 'rear')),
            now() - interval '2 hours');
  rig2 := app.create_combination_at(h2, jsonb_build_array(
            jsonb_build_object('vehicle_id', t3), jsonb_build_object('vehicle_id', t4)),
            now() - interval '2 hours');
  rig3 := app.create_combination_at(h3, jsonb_build_array(
            jsonb_build_object('vehicle_id', t5), jsonb_build_object('vehicle_id', t6)),
            now() - interval '2 hours');
  rig4 := app.create_combination_at(h4, jsonb_build_array(
            jsonb_build_object('vehicle_id', t7), jsonb_build_object('vehicle_id', t8)),
            now() - interval '2 hours');
  rig5 := app.create_combination_at(h5, jsonb_build_array(jsonb_build_object('vehicle_id', t9)),
            now() - interval '2 hours');
  rig6 := app.create_combination_at(h6, jsonb_build_array(
            jsonb_build_object('vehicle_id', t10), jsonb_build_object('vehicle_id', t11)),
            now() - interval '2 hours');
  -- 58e's two bounded-instant legs, each on its own rig: both apply, and one
  -- rig cannot serve two applies.
  rig7 := app.create_combination_at(h8, jsonb_build_array(
            jsonb_build_object('vehicle_id', t14), jsonb_build_object('vehicle_id', t15)),
            now() - interval '2 hours');
  rig8 := app.create_combination_at(h9, jsonb_build_array(
            jsonb_build_object('vehicle_id', t16), jsonb_build_object('vehicle_id', t17)),
            now() - interval '2 hours');

  -- (b) The DoD, end to end. The driver captures the horse and two of its
  -- three trailers, unticking the middle one, so 000041 raises exactly one
  -- FR-INS-063 warning (section 31 pins that half), and the controller
  -- applies it. The payload is section 53's, with the composition keys the
  -- untick fills in. Two trailers survive the untick on purpose: with one, the
  -- membership assertion below could not tell walk order from any other order.
  PERFORM set_config('app.actor_id', drv::text, true);
  reading := jsonb_build_object(
    'vehicle_id', h1, 'position_id', p_run, 'tyre_id', NULL, 'pressure_kpa', 800,
    'pressure_temperature', 'UNKNOWN', 'damage_flag', false, 'note', NULL,
    'treads', '[12,13,14]'::jsonb, 'granularity_mm', 1.0, 'seconds', 30,
    'warnings', '[]'::jsonb);
  SELECT inspection_id INTO insp FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', h1,
    'combination_id', rig1,
    'observed_member_vehicle_ids', jsonb_build_array(h1, t1, t13),
    'started_at', now() - interval '150 seconds', 'submitted_at', now(),
    'duration_seconds', 150, 'completeness_pct', 100,
    'device_id', 'suite', 'app_version', 'suite', 'warnings', '[]'::jsonb,
    'readings', jsonb_build_array(reading)));
  SELECT w.id INTO w1 FROM app.inspection_warning w
   WHERE w.inspection_id = insp AND w.warning_code = 'FR-INS-063' AND w.source = 'SERVER';
  SELECT count(*) INTO n FROM app.inspection_warning w
   WHERE w.inspection_id = insp AND w.warning_code = 'FR-INS-063';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 58b: the submit left % FR-INS-063 warnings, not 1', n; END IF;

  PERFORM set_config('app.actor_id', ctl::text, true);
  new_rig := app.apply_composition_observation(w1, 'seen in the yard');
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig1;
  IF started IS DISTINCT FROM (SELECT i.started_at FROM app.inspection i WHERE i.id = insp) THEN
    RAISE EXCEPTION 'FAIL 58b: the offered rig ended at %, not at the capture''s started_at', started;
  END IF;
  IF new_rig IS NULL THEN RAISE EXCEPTION 'FAIL 58b: the apply opened no rig'; END IF;
  SELECT string_agg(v.fleet_number || ':' || cm.sequence || ':' || COALESCE(cm.descriptor, '-'),
                    ',' ORDER BY cm.sequence)
    INTO members FROM app.combination_member cm
    JOIN app.vehicle v ON v.id = cm.vehicle_id WHERE cm.combination_id = new_rig;
  IF members IS DISTINCT FROM 'T58-H1:1:-,T58-T1:2:front,T58-T13:3:rear' THEN
    RAISE EXCEPTION 'FAIL 58b: the new rig reads [%], not the observed members in the offered order', members;
  END IF;
  SELECT c.effective_from INTO started FROM app.combination c WHERE c.id = new_rig;
  IF started IS DISTINCT FROM (SELECT i.started_at FROM app.inspection i WHERE i.id = insp) THEN
    RAISE EXCEPTION 'FAIL 58b: the new rig starts at %, not at the capture''s started_at', started;
  END IF;
  SELECT o.resulting_combination_id INTO got FROM app.composition_observation o WHERE o.warning_id = w1;
  IF got IS DISTINCT FROM new_rig THEN
    RAISE EXCEPTION 'FAIL 58b: the row cites % as the resulting rig, not %', got, new_rig;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.entity_type = 'composition_observation' AND a.action = 'INSERT' AND a.actor_id = ctl
     AND a.entity_id = (SELECT o.id FROM app.composition_observation o WHERE o.warning_id = w1);
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 58b: % audit rows for the resolution, expected 1', n; END IF;
  -- The control the DoD turns on: the unticked trailer is free, which is only
  -- observable by coupling it somewhere else. Without it, "the new rig has two
  -- members" would pass even if the old rig had never been ended.
  PERFORM app.create_combination(h7, jsonb_build_array(jsonb_build_object('vehicle_id', t2)));
  RAISE NOTICE 'PASS  58b an applied report ends the offered rig at the capture''s instant, opens one with the observed members in the offered walk order, cites it, is audited, and frees the unticked trailer';

  -- (c) One resolution per report, whichever way it is resolved.
  BEGIN
    PERFORM app.apply_composition_observation(w1, NULL);
    RAISE EXCEPTION 'FAIL 58c: a report was applied twice';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'this report was already applied on %' THEN
      RAISE EXCEPTION 'FAIL 58c: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.dismiss_composition_observation(w1, 'changed my mind');
    RAISE EXCEPTION 'FAIL 58c: an applied report was dismissed afterwards';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'this report was already applied on %' THEN
      RAISE EXCEPTION 'FAIL 58c: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  58c a report is resolved once, by apply or by dismissal, and the second attempt names what happened';

  -- (d) A report the register has moved past. Each warning is planted with the
  -- inspection it belongs to: the submit path is proven at 58b, and planting
  -- lets each leg name its own condition instead of FR-INS-038's per-unit
  -- window deciding what may run.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58istale')::uuid, t_id, h2, rig2, drv, gen_random_uuid(),
          now() - interval '1 hour', now() - interval '1 hour', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58istale')::uuid, 'FR-INS-063',
          jsonb_build_array(h2, t3)::text, 'SERVER')
  RETURNING id INTO w_stale;
  PERFORM app.end_combination(rig2);
  BEGIN
    PERFORM app.apply_composition_observation(w_stale, NULL);
    RAISE EXCEPTION 'FAIL 58d: a report against an ended rig was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'stale: the rig ended on %' THEN
      RAISE EXCEPTION 'FAIL 58d: wrong message %', msg;
    END IF;
  END;

  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58ivoid')::uuid, t_id, h3, rig3, drv, gen_random_uuid(),
          now() - interval '1 hour', now() - interval '1 hour', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58ivoid')::uuid, 'FR-INS-063',
          jsonb_build_array(h3, t5)::text, 'SERVER')
  RETURNING id INTO w_void;
  PERFORM app.void_inspection(md5('t58ivoid')::uuid, 'wrong vehicle');
  BEGIN
    PERFORM app.apply_composition_observation(w_void, NULL);
    RAISE EXCEPTION 'FAIL 58d: a report on a voided capture was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'the inspection was voided; nothing to apply' THEN
      RAISE EXCEPTION 'FAIL 58d: wrong message %', msg;
    END IF;
  END;

  -- The offered rig is still open here (rig3 was never ended), so this leg
  -- cannot be passing on the stale branch above.
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig3;
  IF started IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58d: the voided leg''s rig was ended, so the void check was not what refused';
  END IF;

  -- A warning of another kind is not a composition report, however it arrived.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58i4a')::uuid, t_id, h4, rig4, drv, gen_random_uuid(),
          now() - interval '30 minutes', now() - interval '30 minutes', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-OFF-016', NULL, 'SERVER')
  RETURNING id INTO w_notours;
  BEGIN
    PERFORM app.apply_composition_observation(w_notours, NULL);
    RAISE EXCEPTION 'FAIL 58d: a fitment-mismatch warning was applied as a composition';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'this warning is not a composition report' THEN
      RAISE EXCEPTION 'FAIL 58d: wrong message %', msg;
    END IF;
  END;

  -- The right code, from the phone (000044's kind check holds the reason). The
  -- observed set is one an apply would otherwise act on and the offered rig is
  -- open, so the source is the only thing left that can refuse it.
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-INS-063',
          jsonb_build_array(h4, t7)::text, 'CLIENT')
  RETURNING id INTO w_client;
  BEGIN
    PERFORM app.apply_composition_observation(w_client, NULL);
    RAISE EXCEPTION 'FAIL 58d: a warning the client named FR-INS-063 was applied as a composition';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'this warning is not a composition report' THEN
      RAISE EXCEPTION 'FAIL 58d: wrong message %', msg;
    END IF;
  END;
  BEGIN
    PERFORM app.dismiss_composition_observation(w_client, 'the phone named the code itself');
    RAISE EXCEPTION 'FAIL 58d: a warning the client named FR-INS-063 was dismissed as a composition';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'this warning is not a composition report' THEN
      RAISE EXCEPTION 'FAIL 58d: wrong message %', msg;
    END IF;
  END;
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig4;
  IF started IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58d: the client-named report ended the offered rig at %', started;
  END IF;
  RAISE NOTICE 'PASS  58d a stale rig, a voided capture, a warning of another kind and an FR-INS-063 the client named itself are each refused in their own words';

  -- (e) What the report itself says, and where the observed instant lands.
  -- The three refusals hang off rig4, which stays open throughout, so none of
  -- them writes a resolution row; the two bounded-instant legs that follow the
  -- rig4 control apply, and each has its own rig for that reason.
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-INS-063', jsonb_build_array(h4, t7, t12)::text, 'SERVER')
  RETURNING id INTO w_outside;
  BEGIN
    PERFORM app.apply_composition_observation(w_outside, NULL);
    RAISE EXCEPTION 'FAIL 58e: a report naming a unit outside the rig was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'the report names T58-T12, which is not in the offered rig; set the rig by hand' THEN
      RAISE EXCEPTION 'FAIL 58e: wrong message %', msg;
    END IF;
  END;

  -- An observed id no unit in this fleet answers to. It is outside the offered
  -- rig like any other, and the refusal names the raw id because that is all
  -- there is to name: an inner join to app.vehicle here would drop the id from
  -- the check and let the resolution run as though the driver had never sent
  -- it.
  ghost := gen_random_uuid();
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-INS-063', jsonb_build_array(h4, t7, ghost)::text, 'SERVER')
  RETURNING id INTO w_ghost;
  BEGIN
    PERFORM app.apply_composition_observation(w_ghost, NULL);
    RAISE EXCEPTION 'FAIL 58e: a report naming a unit this fleet does not know was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> format('the report names %s, which is not in the offered rig; set the rig by hand', ghost) THEN
      RAISE EXCEPTION 'FAIL 58e: wrong message %', msg;
    END IF;
  END;

  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-INS-063', jsonb_build_array(t7)::text, 'SERVER')
  RETURNING id INTO w_nomotive;
  BEGIN
    PERFORM app.apply_composition_observation(w_nomotive, NULL);
    RAISE EXCEPTION 'FAIL 58e: a report omitting the motive was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'the report does not name T58-H4, the rig''s motive unit; set the rig by hand' THEN
      RAISE EXCEPTION 'FAIL 58e: wrong message %', msg;
    END IF;
  END;

  -- A JSON null in the array 000041 forwards. It casts to a NULL id, which
  -- every check below reads as "no unit named here" rather than as a bad
  -- report: the outside check's COALESCE renders it absent and
  -- `= ANY(observed)` answers NULL, so an unrefused one would end rig4 and
  -- open T58-H4 alone. Planted as text because jsonb_build_array cannot
  -- carry a bare SQL NULL as a JSON null.
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4a')::uuid, 'FR-INS-063', '[null]', 'SERVER')
  RETURNING id INTO w_nullel;
  BEGIN
    PERFORM app.apply_composition_observation(w_nullel, NULL);
    RAISE EXCEPTION 'FAIL 58e: a report whose observed set is a null element was applied';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'the report carries no observed set; set the rig by hand' THEN
      RAISE EXCEPTION 'FAIL 58e: wrong message %', msg;
    END IF;
  END;
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig4;
  IF started IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58e: the null-element report ended the offered rig at %', started;
  END IF;

  -- The control for all four: rig4 is untouched, so none of them
  -- half-applied. Read here, before the two legs that DO write, so a later
  -- write can never be mistaken for one of these four leaking through.
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig4;
  IF started IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58e: a refused report still ended the offered rig';
  END IF;
  SELECT count(*) INTO n FROM app.composition_observation o WHERE o.combination_id = rig4;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 58e: a refused report wrote % resolution row(s)', n; END IF;

  -- A slow phone. The capture is stamped a day before the rig it names was
  -- set, so the observed instant is the rig's own effective_from and the
  -- offered rig becomes a zero-length record, set and immediately reported
  -- different, rather than a refusal a controller cannot act on (owner,
  -- 8 Sep 2026). Its own rig: this leg applies, and one rig serves one apply.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58i4b')::uuid, t_id, h8, rig7, drv, gen_random_uuid(),
          now() - interval '1 day', now() - interval '1 hour', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4b')::uuid, 'FR-INS-063', jsonb_build_array(h8, t14)::text, 'SERVER')
  RETURNING id INTO w_early;
  SELECT c.effective_from INTO from_at FROM app.combination c WHERE c.id = rig7;
  new_rig := app.apply_composition_observation(w_early, NULL);
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig7;
  IF started IS DISTINCT FROM from_at THEN
    RAISE EXCEPTION 'FAIL 58e: the slow phone''s rig ended at %, not at its own start (%)', started, from_at;
  END IF;
  IF new_rig IS NULL THEN
    RAISE EXCEPTION 'FAIL 58e: the slow phone''s report opened no rig';
  END IF;
  SELECT c.effective_from INTO started FROM app.combination c WHERE c.id = new_rig;
  IF started IS DISTINCT FROM from_at THEN
    RAISE EXCEPTION 'FAIL 58e: the rig that replaced it starts at %, not at % where the last one ended', started, from_at;
  END IF;

  -- A fast phone. 000041 bounds submitted_at by the tenant's configured skew
  -- but leaves started_at alone, so a started_at ahead of the server's clock
  -- is reachable, and the observed instant is the server's own receipt.
  -- received_at is planted rather than defaulted, since a defaulted value
  -- would equal now() and the apply instant too, hiding the distinction the
  -- ruling turns on.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, received_at, state)
  VALUES (md5('t58i4c')::uuid, t_id, h9, rig8, drv, gen_random_uuid(),
          now() + interval '1 hour', now(), now() - interval '30 minutes', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58i4c')::uuid, 'FR-INS-063', jsonb_build_array(h9, t16)::text, 'SERVER')
  RETURNING id INTO w_future;
  SELECT i.received_at INTO received FROM app.inspection i WHERE i.id = md5('t58i4c')::uuid;
  new_rig := app.apply_composition_observation(w_future, NULL);
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig8;
  IF started IS DISTINCT FROM received THEN
    RAISE EXCEPTION 'FAIL 58e: the fast phone''s rig ended at %, not at the server''s receipt (%)', started, received;
  END IF;
  IF started = (SELECT i.started_at FROM app.inspection i WHERE i.id = md5('t58i4c')::uuid) THEN
    RAISE EXCEPTION 'FAIL 58e: the fast phone''s own stamp was taken as the observed instant';
  END IF;
  SELECT c.effective_from INTO started FROM app.combination c WHERE c.id = new_rig;
  IF started IS DISTINCT FROM received THEN
    RAISE EXCEPTION 'FAIL 58e: the rig that replaced it starts at %, not at the receipt (%)', started, received;
  END IF;
  RAISE NOTICE 'PASS  58e a report naming a unit outside the rig, naming an id this fleet does not know, omitting the motive, or carrying a null element is refused and writes nothing; a slow phone lands on the rig''s own instant and a fast phone on the server''s receipt';

  -- (f) The motive alone, and the dismissal.
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58ialone')::uuid, t_id, h5, rig5, drv, gen_random_uuid(),
          now() - interval '10 minutes', now() - interval '9 minutes', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58ialone')::uuid, 'FR-INS-063', jsonb_build_array(h5)::text, 'SERVER')
  RETURNING id INTO w_dismiss;
  new_rig := app.apply_composition_observation(w_dismiss, NULL);
  IF new_rig IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58f: an uncoupled motive opened rig %, but U10 declines a one-member rig', new_rig;
  END IF;
  SELECT c.effective_to INTO started FROM app.combination c WHERE c.id = rig5;
  IF started IS NULL THEN RAISE EXCEPTION 'FAIL 58f: the uncoupled motive''s rig is still open'; END IF;
  SELECT o.resulting_combination_id INTO got FROM app.composition_observation o WHERE o.warning_id = w_dismiss;
  IF got IS NOT NULL THEN RAISE EXCEPTION 'FAIL 58f: the row cites a resulting rig that was never opened'; END IF;

  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, state)
  VALUES (md5('t58idis')::uuid, t_id, h6, rig6, drv, gen_random_uuid(),
          now() - interval '20 minutes', now() - interval '19 minutes', 'SYNCED');
  INSERT INTO app.inspection_warning (tenant_id, inspection_id, warning_code, entered_value, source)
  VALUES (t_id, md5('t58idis')::uuid, 'FR-INS-063', jsonb_build_array(h6, t10)::text, 'SERVER')
  RETURNING id INTO w_dismiss;
  SELECT count(*) INTO open_before FROM app.combination c WHERE c.effective_to IS NULL;
  BEGIN
    PERFORM app.dismiss_composition_observation(w_dismiss, '   ');
    RAISE EXCEPTION 'FAIL 58f: a dismissal with a blank reason was accepted';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'a dismissal carries a reason' THEN
      RAISE EXCEPTION 'FAIL 58f: wrong message %', msg;
    END IF;
  END;
  PERFORM app.dismiss_composition_observation(w_dismiss, '  the link was there  ');
  SELECT count(*) INTO open_after FROM app.combination c WHERE c.effective_to IS NULL;
  IF open_after <> open_before THEN
    RAISE EXCEPTION 'FAIL 58f: a dismissal moved the open-rig count from % to %', open_before, open_after;
  END IF;
  SELECT o.action::text, o.note, o.resulting_combination_id INTO msg, members, got
    FROM app.composition_observation o WHERE o.warning_id = w_dismiss;
  IF msg IS DISTINCT FROM 'DISMISSED' OR members IS DISTINCT FROM 'the link was there' OR got IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 58f: the dismissal row reads [% / % / %]', msg, members, got;
  END IF;
  -- 58c's rule from the dismissal side, and it lives here because 58c has no
  -- dismissed report to dismiss again: the resolved check answers first, and
  -- composition_observation_once is underneath it if it ever does not.
  BEGIN
    PERFORM app.dismiss_composition_observation(w_dismiss, 'still not convinced');
    RAISE EXCEPTION 'FAIL 58f: a report was dismissed twice';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'this report was already dismissed on %' THEN
      RAISE EXCEPTION 'FAIL 58f: wrong message %', msg;
    END IF;
  END;
  RAISE NOTICE 'PASS  58f an uncoupled motive ends its rig and opens none; a dismissal needs a trimmed reason, changes no rig, and happens once';

  -- (g) Rule 1, both halves, plus the append-only grants. The cross-tenant
  -- probe pairs the SAME call under both tenants: under the owning tenant it
  -- answers TY022 "already applied", so a leak could not present as TY012 and
  -- the refusal cannot be some other branch firing (lesson 2026-09-01).
  PERFORM set_config('app.tenant_id', t_one::text, true);
  SELECT count(*) INTO n FROM app.composition_observation;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL 58g: another tenant reads % resolution row(s)', n; END IF;
  BEGIN
    PERFORM app.apply_composition_observation(w1, NULL);
    RAISE EXCEPTION 'FAIL 58g: tenant 1 applied tenant 2''s report';
  EXCEPTION WHEN SQLSTATE 'TY012' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg <> 'no such observation in this fleet' THEN
      RAISE EXCEPTION 'FAIL 58g: wrong message %', msg;
    END IF;
  END;
  -- The write half of the policy. Every column is a value the policy is not
  -- under test for: created_by and both combination references are the
  -- TARGET tenant's, so the row is valid in every way but the one being
  -- proved (lesson 2026-09-01), and w_outside is unresolved so
  -- composition_observation_once cannot answer first. The mutation this
  -- stands against is `WITH CHECK (true)`, since a FOR ALL policy omitting
  -- the clause reuses USING for writes and would change nothing. The message
  -- is trapped, not the SQLSTATE, because this table is audited: a row that
  -- cleared its own WITH CHECK would carry the other tenant's id into
  -- app.audit_log, whose identical 42501 would otherwise stand in for the
  -- check under test (section 46g's pattern, lesson 2026-09-08).
  BEGIN
    INSERT INTO app.composition_observation
      (tenant_id, warning_id, combination_id, action, note, created_by)
    VALUES (t_id, w_outside, rig4, 'DISMISSED', 'smuggled', ctl);
    RAISE EXCEPTION 'FAIL 58g: tenant 1 wrote a resolution into tenant 2';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security policy for table "composition_observation"%' THEN
      RAISE EXCEPTION 'FAIL 58g: refused by something other than composition_observation''s own policy: %', msg;
    END IF;
  END;
  PERFORM set_config('app.tenant_id', t_id::text, true);
  BEGIN
    PERFORM app.apply_composition_observation(w1, NULL);
    RAISE EXCEPTION 'FAIL 58g: the control call succeeded, so the TY012 above proved nothing';
  EXCEPTION WHEN SQLSTATE 'TY022' THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'this report was already applied on %' THEN
      RAISE EXCEPTION 'FAIL 58g: the control refused for a third reason: %', msg;
    END IF;
  END;
  -- The decider, by constraint rather than by default: app_rw holds INSERT, so
  -- an explicit NULL passes the column default by (000044's reasoning). Valid
  -- in every other way, this tenant, an unresolved warning, its own rig, so
  -- the not-null constraint is the only thing left to answer, and the message
  -- is read for the column because any other 23502 on this row would otherwise
  -- stand in for it.
  BEGIN
    INSERT INTO app.composition_observation
      (tenant_id, warning_id, combination_id, action, note, created_by)
    VALUES (t_id, w_outside, rig4, 'DISMISSED', 'no decider', NULL);
    RAISE EXCEPTION 'FAIL 58g: a resolution was written without its decider';
  EXCEPTION WHEN not_null_violation THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%"created_by"%' THEN
      RAISE EXCEPTION 'FAIL 58g: a column other than created_by refused the row: %', msg;
    END IF;
  END;
  -- Rule 3 by grant. WHERE false: privilege is checked at rewrite time against
  -- the table, not the predicate (section 45f's reasoning).
  BEGIN
    UPDATE app.composition_observation SET note = 'edited' WHERE false;
    RAISE EXCEPTION 'FAIL 58g: app role can UPDATE app.composition_observation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM app.composition_observation WHERE false;
    RAISE EXCEPTION 'FAIL 58g: app role can DELETE app.composition_observation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS  58g another tenant neither reads nor writes a resolution, the owning tenant''s same call refuses differently, a resolution names its decider, and it is never rewritten or removed';
END $$;
ROLLBACK;

\echo '== 59. B7.1: the exception view, the resolvers and value at risk (TYRE-41, TYRE-211, TYRE-183, TYRE-193)'
-- Section 8 asserts the Appendix J position SETS through app.v_exception;
-- this section pins the NUMBERS the documents state and the substrate the
-- dashboard reads. Every block is BEGIN/ROLLBACK and plants under the tenant
-- it exercises (sections 25 and 58's pattern).

\echo '== 59a. threshold_policy_for and target_pressure_for resolve the tenant-wide row, never a spare target (spec D1, U5, U10)'
BEGIN;
DO $$
DECLARE t1  constant uuid := '11111111-1111-1111-1111-111111111111';
        grp constant uuid := md5('t59agrp')::uuid;
        pol app.threshold_policy; tgt app.target_pressure; mm numeric; args text;
        ts_g timestamptz; ts_t timestamptz;
BEGIN
  -- Self-contained: pin the tenant rather than inherit an earlier section's
  -- session state (section 28's rule).
  PERFORM set_config('app.tenant_id', t1::text, true);

  -- Signatures pinned as identity arguments (58a). regprocedure renders a
  -- type unqualified only because the suite sets app first in search_path.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO args
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.proname IN ('threshold_policy_for', 'target_pressure_for');
  IF args IS DISTINCT FROM
     'target_pressure_for(uuid,uuid,axle_class,timestamp with time zone), threshold_policy_for(uuid,uuid,axle_class,timestamp with time zone)' THEN
    RAISE EXCEPTION 'FAIL 59a: the resolvers read as [%]', COALESCE(args, 'absent');
  END IF;

  -- The baseline rows carry -infinity, so any instant resolves them (U5).
  pol := app.threshold_policy_for(t1, NULL, NULL, '2021-10-04T00:00:00Z');
  IF pol.retread_threshold_mm IS DISTINCT FROM 4.0 OR pol.warning_threshold_mm IS DISTINCT FROM 6.0
     OR pol.axle_class IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 59a: tenant-wide policy at 2021 resolved to retread % warning % axle %',
      pol.retread_threshold_mm, pol.warning_threshold_mm, pol.axle_class;
  END IF;
  -- Asking for STEER returns the STEER row (the fit_tyre shape); asking for
  -- DRIVE, which has no row, falls back to the tenant-wide one.
  pol := app.threshold_policy_for(t1, NULL, 'STEER', now());
  -- IS NOT FALSE, not a bare read: an unresolved lookup leaves pol a NULL
  -- composite, and a bare boolean would let that pass as permitted = false.
  IF pol.axle_class IS DISTINCT FROM 'STEER' OR pol.retreads_permitted IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL 59a: STEER did not resolve to its own row';
  END IF;
  pol := app.threshold_policy_for(t1, NULL, 'DRIVE', now());
  IF pol.axle_class IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 59a: DRIVE resolved to an axle row that does not exist';
  END IF;
  -- The wrapper answers what the resolver answers.
  mm := app.removal_threshold_mm_for(t1, now());
  IF mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 59a: removal_threshold_mm_for answered %', mm;
  END IF;

  -- The operating-group tier is the one dimension this migration adds. No
  -- tenant has a seeded group row and app.fit_tyre implements only the axle
  -- tier, so nothing else in the suite would notice the group sort key being
  -- inverted or dropped. Plant one and make it decide. It takes effect at
  -- now(), the earliest instant a dated row may carry (U70), so the reads
  -- that need it in force ask one microsecond later.
  ts_g := now();
  INSERT INTO app.operating_group (id, tenant_id, name, created_by)
  VALUES (grp, t1, 'T59A Northern', NULL);
  INSERT INTO app.threshold_policy (tenant_id, operating_group_id, retread_threshold_mm,
                                    max_retreads, effective_from, created_by)
  VALUES (t1, grp, 5.0, 2, ts_g, NULL);
  -- A group row carrying no axle class outranks the STEER row and the
  -- tenant-wide row together: the group key sorts ahead of the axle key.
  pol := app.threshold_policy_for(t1, grp, 'STEER', ts_g + interval '1 microsecond');
  IF pol.operating_group_id IS DISTINCT FROM grp OR pol.retread_threshold_mm IS DISTINCT FROM 5.0 THEN
    RAISE EXCEPTION 'FAIL 59a: the group row did not outrank the axle row (group % retread %)',
      pol.operating_group_id, pol.retread_threshold_mm;
  END IF;
  -- A caller naming no group never reaches it, which is what keeps the
  -- register pricing through the tenant-wide row while a group policy exists.
  pol := app.threshold_policy_for(t1, NULL, 'STEER', ts_g + interval '1 microsecond');
  IF pol.operating_group_id IS NOT NULL OR pol.retread_threshold_mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 59a: a group row leaked into a group-blind lookup';
  END IF;
  mm := app.removal_threshold_mm_for(t1, ts_g + interval '1 microsecond');
  IF mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 59a: the wrapper answered % once a group policy existed', mm;
  END IF;
  -- p_before is the exclusive upper edge of an as-at day (000036's
  -- convention), so a row effective exactly at it is not yet in force and
  -- this falls back to the tenant-wide row. Asserted at the planted instant
  -- itself: any instant after it passes under both < and <=, and proves
  -- nothing about which one the resolver spells.
  pol := app.threshold_policy_for(t1, grp, NULL, ts_g);
  IF pol.operating_group_id IS NOT NULL OR pol.retread_threshold_mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 59a: a policy effective exactly at p_before was already in force (group % retread %)',
      pol.operating_group_id, pol.retread_threshold_mm;
  END IF;

  -- Pressure: class row for a TRAILER; NULL for a spare even once a
  -- tenant-wide row exists (FR-CFG-013 errata E1, U10). The tenant-wide row
  -- is planted first so the spare's NULL is the rule, not the absence of data.
  -- effective_from a minute ago, not the default now(): the resolver reads
  -- effective_from < p_before and both would be transaction_timestamp()
  ts_t := now() - interval '1 minute';
  INSERT INTO app.target_pressure (tenant_id, target_kpa, effective_from)
  VALUES (t1, 700, ts_t);
  tgt := app.target_pressure_for(t1, NULL, 'TRAILER', now());
  IF tgt.target_kpa IS DISTINCT FROM 750 OR tgt.axle_class IS DISTINCT FROM 'TRAILER' THEN
    RAISE EXCEPTION 'FAIL 59a: TRAILER resolved to % (axle %), not its class row', tgt.target_kpa, tgt.axle_class;
  END IF;
  tgt := app.target_pressure_for(t1, NULL, 'SPARE', now());
  IF tgt.target_kpa IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 59a: a spare resolved a pressure target (%)', tgt.target_kpa;
  END IF;
  -- A class-blind lookup passes over every class row and reaches the
  -- tenant-wide one, which is the fallback a caller with no axle to name gets.
  tgt := app.target_pressure_for(t1, NULL, NULL, now());
  IF tgt.target_kpa IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'FAIL 59a: the tenant-wide target row is unreachable (%)', tgt.target_kpa;
  END IF;
  -- The exclusive upper edge holds on the second store too, at the planted
  -- instant itself; no other row carries a NULL axle class, so a resolved
  -- target here could only be this one arriving a moment early.
  tgt := app.target_pressure_for(t1, NULL, NULL, ts_t);
  IF tgt.target_kpa IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 59a: a target effective exactly at p_before was already in force (%)', tgt.target_kpa;
  END IF;
  RAISE NOTICE 'PASS  59a resolvers: tenant-wide baseline, group over axle over blind, exclusive p_before, spare never classified';
END $$;
ROLLBACK;

\echo '== 59b. The numbers: 19 exceptions, 11 urgent, 9 running below the removal threshold (TYRE-183, spec D6)'
BEGIN;
DO $$
DECLARE total int; urgent int; below int; total_open int; urgent_open int; below_open int;
        per text; latest text; leaked int;
BEGIN
  -- Self-contained: pin the tenant rather than inherit an earlier section's
  -- session state (section 28's rule).
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);

  -- Qualified through the alias: the view's urgent column and this block's
  -- urgent variable share a name, and plpgsql refuses the bare reference.
  SELECT count(*), count(*) FILTER (WHERE e.urgent), count(*) FILTER (WHERE e.rule_code = 'FR-EXC-020'),
         count(*) FILTER (WHERE NOT e.resolved_by_fitment),
         count(*) FILTER (WHERE e.urgent AND NOT e.resolved_by_fitment),
         count(*) FILTER (WHERE e.rule_code = 'FR-EXC-020' AND NOT e.resolved_by_fitment)
    INTO total, urgent, below, total_open, urgent_open, below_open
    FROM app.v_exception e;
  IF (total, urgent, below) IS DISTINCT FROM (19, 11, 9) THEN
    RAISE EXCEPTION 'FAIL 59b: expected 19/11/9, got %/%/%', total, urgent, below; END IF;
  IF (total_open, urgent_open, below_open) IS DISTINCT FROM (19, 11, 9) THEN
    RAISE EXCEPTION 'FAIL 59b: open counts %/%/% differ from the unfiltered ones on a fixture with no resolution',
      total_open, urgent_open, below_open; END IF;

  SELECT string_agg(rule_code || ':' || n, ',' ORDER BY rule_code) INTO per
    FROM (SELECT rule_code, count(*) AS n FROM app.v_exception GROUP BY rule_code) z;
  IF per IS DISTINCT FROM
     'FR-EXC-020:9,FR-EXC-021:1,FR-EXC-022:1,FR-EXC-035:6,FR-EXC-036:1,FR-EXC-038:1' THEN
    RAISE EXCEPTION 'FAIL 59b: per-rule counts [%]', per; END IF;

  -- insp0 is invisible: every row comes from the July sheet
  IF EXISTS (SELECT 1 FROM app.v_exception WHERE inspection_id = md5('insp0')::uuid) THEN
    RAISE EXCEPTION 'FAIL 59b: a row of the June inspection surfaced'; END IF;
  SELECT string_agg(v.fleet_number || ':' || (l.inspection_id = md5('insp1')::uuid), ',' ORDER BY v.fleet_number) INTO latest
    FROM app.v_latest_unit_inspection l JOIN app.vehicle v ON v.id = l.vehicle_id;
  IF latest IS DISTINCT FROM 'HORSE:true,LINK12:true,LINK6:true' THEN
    RAISE EXCEPTION 'FAIL 59b: latest inspection per unit resolved as [%]', latest; END IF;

  -- The catalogue is read, not decorative: disabling one rule removes its row
  UPDATE app.exception_rule SET enabled = false
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'FR-EXC-021';
  SELECT count(*), count(*) FILTER (WHERE e.urgent) INTO total, urgent FROM app.v_exception e;
  IF (total, urgent) IS DISTINCT FROM (18, 11) THEN
    RAISE EXCEPTION 'FAIL 59b: with FR-EXC-021 disabled expected 18/11, got %/%', total, urgent; END IF;
  UPDATE app.exception_rule SET enabled = true
   WHERE tenant_id = '11111111-1111-1111-1111-111111111111' AND code = 'FR-EXC-021';

  -- A later policy row does not re-judge July's sheet (U18): the rule is
  -- judged at the inspection's instant, the register at today (59d).
  INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111', 5.0, 7.0, 2, now());
  SELECT count(*) INTO below FROM app.v_exception WHERE rule_code = 'FR-EXC-020';
  IF below IS DISTINCT FROM 9 THEN
    RAISE EXCEPTION 'FAIL 59b: a policy effective after the sheet re-judged it (020 = %)', below; END IF;
  IF EXISTS (SELECT 1 FROM app.v_exception WHERE threshold_mm IS DISTINCT FROM 4.0 AND rule_code IN ('FR-EXC-020', 'FR-EXC-038')) THEN
    RAISE EXCEPTION 'FAIL 59b: a below-threshold row carries a threshold other than the one in force at the sheet'; END IF;

  -- Second Fleet plants a unit, a tyre and an inspection with one worn
  -- reading; BAC sees none of it (section 8b sweeps the views; this is the
  -- row-level control with a row that WOULD be an exception)
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, state)
  VALUES (md5('t59tyre')::uuid, '22222222-2222-2222-2222-222222222222', 'T59W1', 'IN_STOCK');
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
  VALUES (md5('t59insp')::uuid, '22222222-2222-2222-2222-222222222222', md5('t2veh1')::uuid, md5('driver2')::uuid,
          md5('t59cli')::uuid, now() - interval '10 minutes', now() - interval '5 minutes', 1000);
  INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
  SELECT md5('t59rd')::uuid, '22222222-2222-2222-2222-222222222222', md5('t59insp')::uuid, md5('t2veh1')::uuid, pos.id,
         md5('t59tyre')::uuid, 750
    FROM app.position pos
   WHERE pos.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid AND pos.code = '3';
  INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
  VALUES ('22222222-2222-2222-2222-222222222222', md5('t59rd')::uuid, 1, 'OUTER', 2.0, true, 1.0),
         ('22222222-2222-2222-2222-222222222222', md5('t59rd')::uuid, 2, 'CENTRE', 2.0, true, 1.0),
         ('22222222-2222-2222-2222-222222222222', md5('t59rd')::uuid, 3, 'INNER', 2.0, true, 1.0);
  SELECT count(*) INTO leaked FROM app.v_exception WHERE rule_code = 'FR-EXC-020' AND vehicle_id = md5('t2veh1')::uuid;
  IF leaked <> 1 THEN
    RAISE EXCEPTION 'FAIL 59b: Second Fleet does not see its own worn tyre (%)', leaked; END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO leaked FROM app.v_exception WHERE vehicle_id = md5('t2veh1')::uuid;
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'FAIL 59b: BAC sees % Second Fleet exception row(s)', leaked; END IF;
  SELECT count(*) INTO total FROM app.v_exception;
  IF total <> 19 THEN
    RAISE EXCEPTION 'FAIL 59b: BAC total moved to % after another tenant captured', total; END IF;

  RAISE NOTICE 'PASS  59b 19 exceptions, 11 urgent, 9 running below threshold; per rule as Appendix J.2; catalogue read; judged at the sheet; tenant-bound';
END $$;
ROLLBACK;

\echo '== 59c. FR-EXC-039 raises once per inspection, subject the motive unit (spec D3, U13)'
BEGIN;
DO $$
DECLARE t1 constant uuid := '11111111-1111-1111-1111-111111111111';
        solo constant uuid := md5('t59solo')::uuid;
        insp constant uuid := md5('t59soloinsp')::uuid;
        n int; total int; subj text;
BEGIN
  -- Self-contained: pin the tenant rather than inherit an earlier section's
  -- session state (section 28's rule).
  PERFORM set_config('app.tenant_id', t1::text, true);

  -- A solo unit, so the one inspection resolves one unit: a rig inspection
  -- resolves three in v_latest_unit_inspection and the rule must still raise
  -- once (spec D3). Six equal pressures and no tread: the anomaly view's
  -- own predicate (000012), and no TYRE row can fire without a tyre.
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, configuration_id, unit_kind, status)
  VALUES (solo, t1, 'T59-SOLO', md5('11111111-1111-1111-1111-111111111111HORSE_6X4')::uuid, 'HORSE', 'ACTIVE');
  INSERT INTO app.inspection (id, tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
  VALUES (insp, t1, solo, md5('driver1')::uuid, md5('t59solocli')::uuid,
          now() - interval '10 minutes', now() - interval '5 minutes', 1000);
  INSERT INTO app.reading (tenant_id, inspection_id, vehicle_id, position_id, pressure_kpa)
  SELECT t1, insp, solo, pos.id, 750
    FROM app.position pos
   WHERE pos.configuration_id = md5('11111111-1111-1111-1111-111111111111HORSE_6X4')::uuid
     AND pos.code IN ('1', '2', '3', '4', '5', '6');
  SELECT count(*), min(subject_type) INTO n, subj FROM app.v_exception WHERE rule_code = 'FR-EXC-039';
  IF (n, subj) IS DISTINCT FROM (1, 'VEHICLE') THEN
    RAISE EXCEPTION 'FAIL 59c: % FR-EXC-039 row(s), subject %', n, subj; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.v_exception
                  WHERE rule_code = 'FR-EXC-039' AND vehicle_id = solo AND subject_id = solo) THEN
    RAISE EXCEPTION 'FAIL 59c: the transcription row does not name the solo unit'; END IF;
  SELECT count(*) INTO total FROM app.v_exception;
  IF total <> 20 THEN
    RAISE EXCEPTION 'FAIL 59c: total % after one planted anomaly, expected 20', total; END IF;
  RAISE NOTICE 'PASS  59c a uniform-pressure inspection raises one FR-EXC-039 row, subject its motive unit';
END $$;
ROLLBACK;

\echo '== 59d. Value at risk: the casing rands on tyres at or below the removal threshold, provenance disclosed (FR-VAL-031, FR-VAL-013, FR-RPT-040; TYRE-193)'
BEGIN;
DO $$
DECLARE r record; running_sum numeric; spare_sum numeric; depot_sum numeric; n int;
        ca int; ce int; cau int; exc020 int; exc_total int;
BEGIN
  -- Self-contained: pin the tenant rather than inherit an earlier section's
  -- session state (section 28's rule).
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);

  -- INTO STRICT wherever a row is selected from a view: a bare INTO takes the
  -- first row of many and sets no flag, so a grouping-set mistake that emitted
  -- two TENANT rows would leave this block green. The aggregate reads below
  -- return exactly one row by construction and stay bare.
  SELECT * INTO STRICT r FROM app.v_casing_value_at_risk WHERE level = 'TENANT' AND position_class = 'RUNNING';
  IF (r.tyre_count, r.actual_count, r.estimated_or_audit_count, r.audit_count, r.unvalued_count, r.casing_value_at_risk)
     IS DISTINCT FROM (9::bigint, 0::bigint, 9::bigint, 9::bigint, 0::bigint, 16537.50::numeric) THEN
    RAISE EXCEPTION 'FAIL 59d: RUNNING row is count % actual % estimated_or_audit % audit % unvalued % rands %',
      r.tyre_count, r.actual_count, r.estimated_or_audit_count, r.audit_count, r.unvalued_count, r.casing_value_at_risk;
  END IF;
  running_sum := r.casing_value_at_risk;
  SELECT * INTO STRICT r FROM app.v_casing_value_at_risk WHERE level = 'TENANT' AND position_class = 'SPARE';
  IF (r.tyre_count, r.casing_value_at_risk) IS DISTINCT FROM (1::bigint, 1837.50::numeric) THEN
    RAISE EXCEPTION 'FAIL 59d: SPARE row is count % rands %', r.tyre_count, r.casing_value_at_risk;
  END IF;
  spare_sum := r.casing_value_at_risk;
  -- DEPOT rows sum to the TENANT row (ADR-0006: a depot actor reads its rows,
  -- a tenant actor the whole)
  SELECT sum(casing_value_at_risk) INTO depot_sum FROM app.v_casing_value_at_risk WHERE level = 'DEPOT' AND position_class = 'RUNNING';
  IF depot_sum IS DISTINCT FROM running_sum THEN
    RAISE EXCEPTION 'FAIL 59d: DEPOT running rows sum to %, TENANT says %', depot_sum, running_sum;
  END IF;
  -- The per-tyre list names the nine and the spare, every one an audit-basis casing
  SELECT count(*), count(*) FILTER (WHERE casing_basis = 'AUDIT') INTO n, cau FROM app.v_tyre_at_risk;
  IF (n, cau) IS DISTINCT FROM (10, 10) THEN
    RAISE EXCEPTION 'FAIL 59d: v_tyre_at_risk has % rows, % on the audit basis', n, cau;
  END IF;

  -- The estate view discloses the casing side's provenance as well as the
  -- tread side's (FR-DSH-002): every one of the fixture's 27 held casings is
  -- the onboarding audit figure, none priced by a retreader or a size
  -- estimate. Asserted here, ahead of the two casings nulled below.
  SELECT casing_actual_count, casing_estimated_count, casing_audit_count INTO STRICT ca, ce, cau
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF (ca, ce, cau) IS DISTINCT FROM (0, 0, 27) THEN
    RAISE EXCEPTION 'FAIL 59d: estate casing split actual % estimated % audit %', ca, ce, cau;
  END IF;

  -- An unvalued casing is counted and named, never zero-filled (FR-VAL-013,
  -- NFR-PRO-002/003). Every casing on the fixture carries a figure, so a
  -- COALESCE(sum(...), 0) wrapped round casing_value_at_risk would keep the
  -- assertions above green while the money silently understated; these two
  -- plants make that a failure. A sum over nothing is NULL, so nulling the
  -- spare's casing (the only one of its class) empties the SPARE row's sum
  -- rather than lowering it.
  UPDATE app.tyre SET casing_value = NULL WHERE display_code = '2102BACS';
  SELECT * INTO STRICT r FROM app.v_casing_value_at_risk WHERE level = 'TENANT' AND position_class = 'SPARE';
  IF r.casing_value_at_risk IS NOT NULL
     OR (r.tyre_count, r.unvalued_count) IS DISTINCT FROM (1::bigint, 1::bigint) THEN
    RAISE EXCEPTION 'FAIL 59d: with the spare casing unvalued the SPARE row is count % unvalued % rands %, expected 1/1/NULL',
      r.tyre_count, r.unvalued_count, r.casing_value_at_risk;
  END IF;
  -- One of nine: the row keeps its count and names the gap, and the figure
  -- falls by exactly that casing rather than treating it as worth nothing.
  UPDATE app.tyre SET casing_value = NULL WHERE display_code = '2102BAC7';
  SELECT * INTO STRICT r FROM app.v_casing_value_at_risk WHERE level = 'TENANT' AND position_class = 'RUNNING';
  IF (r.tyre_count, r.unvalued_count, r.casing_value_at_risk)
     IS DISTINCT FROM (9::bigint, 1::bigint, 14700.00::numeric) THEN
    RAISE EXCEPTION 'FAIL 59d: with one running casing unvalued the RUNNING row is count % unvalued % rands %, expected 9/1/14700.00',
      r.tyre_count, r.unvalued_count, r.casing_value_at_risk;
  END IF;

  -- The register is judged at TODAY while a rule is judged at its sheet
  -- (U18), and both halves are asserted here under the same plant so the
  -- contrast belongs to this block: a policy row effective now moves sheet
  -- position 14 (LINK6 position 4, 5.0mm) into the at-risk list, and leaves
  -- every exception row where the July sheet put it.
  INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111', 5.0, 7.0, 2, now());
  SELECT tyre_count INTO STRICT n FROM app.v_casing_value_at_risk WHERE level = 'TENANT' AND position_class = 'RUNNING';
  SELECT count(*) FILTER (WHERE rule_code = 'FR-EXC-020'), count(*) INTO exc020, exc_total FROM app.v_exception;
  IF (n, exc020, exc_total) IS DISTINCT FROM (10, 9, 19) THEN
    RAISE EXCEPTION 'FAIL 59d: under a 5.0 policy the running at-risk count is %, FR-EXC-020 is % and the view holds % rows, expected 10/9/19',
      n, exc020, exc_total;
  END IF;
  RAISE NOTICE 'PASS  59d value at risk R% running, R% spare, audit basis disclosed; an unvalued casing is named, never zero-filled; register at today, rules at the sheet', running_sum, spare_sum;
END $$;
ROLLBACK;

\echo '== 59e. Spares judged on age on the tenant day; unit inspection status; the forecast horizon is configuration (FR-DSH-005/006/009/019, FR-EXC-027; spec D7, U9)'
BEGIN;
DO $$
DECLARE r record; n int; sched int; cov int; st int; horizon int; due int;
        probe text; tz text; d1 date; d2 date; age int;
BEGIN
  -- Self-contained: pin the tenant rather than inherit an earlier section's
  -- session state (section 28's rule).
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);

  -- The spare: one row, and "last measured" is the spare's own latest
  -- reading, which the fixture has, rather than app.tyre.last_tread_at, which
  -- on this tyre is null. INTO STRICT pins the single row (59d's rule); a
  -- duplicate open fitment is what it would catch.
  SELECT * INTO STRICT r FROM app.v_spare_tyre_age;
  IF r.display_code IS DISTINCT FROM '2102BACS' OR r.measured_source IS DISTINCT FROM 'READING'
     OR r.current_tread_mm IS DISTINCT FROM 2.0 OR (r.last_measured_at AT TIME ZONE 'UTC')::date IS DISTINCT FROM DATE '2026-07-23' THEN
    RAISE EXCEPTION 'FAIL 59e: spare row % source % tread % measured %', r.display_code, r.measured_source, r.current_tread_mm, r.last_measured_at;
  END IF;
  -- age_days is an integer number of tenant days, not timestamp arithmetic
  IF pg_typeof(r.age_days)::text <> 'integer' OR r.age_days < 0 THEN
    RAISE EXCEPTION 'FAIL 59e: age_days is % (%)', r.age_days, pg_typeof(r.age_days);
  END IF;

  -- U9's headline, and the reason the status VIEW exists apart from the
  -- function the reads below call with a date: both count on the TENANT's
  -- day and must not follow the session TimeZone the way current_date does
  -- (rule 6). Kiritimati (UTC+14) and Niue (UTC-11) sit 25 hours apart, so
  -- at least one is always on a different calendar day from the tenant,
  -- which is what keeps these equalities non-vacuous; the control below
  -- asserts the two probes really did disagree.
  tz  := current_setting('TimeZone');
  age := r.age_days;
  FOREACH probe IN ARRAY ARRAY['Pacific/Kiritimati', 'Pacific/Niue'] LOOP
    PERFORM set_config('TimeZone', probe, true);
    SELECT age_days INTO STRICT n FROM app.v_spare_tyre_age;
    IF n IS DISTINCT FROM age THEN
      RAISE EXCEPTION 'FAIL 59e: age_days is % under % and % under the session zone', n, probe, age; END IF;
    SELECT count(*) INTO st FROM app.v_unit_inspection_status;
    IF st IS DISTINCT FROM 3 THEN
      RAISE EXCEPTION 'FAIL 59e: the status view holds % rows under %, expected 3', st, probe; END IF;
    IF EXISTS (SELECT * FROM app.v_unit_inspection_status
                EXCEPT SELECT * FROM app.unit_inspection_status((SELECT app.tenant_today(timezone) FROM app.tenant))) THEN
      RAISE EXCEPTION 'FAIL 59e: under % the status view is not the function at the tenant day', probe; END IF;
    IF d1 IS NULL THEN d1 := current_date; ELSE d2 := current_date; END IF;
  END LOOP;
  PERFORM set_config('TimeZone', tz, true);
  IF d1 = d2 THEN
    RAISE EXCEPTION 'FAIL 59e: both probe zones read the server day as %, so the equalities above proved nothing', d1;
  END IF;

  -- Unit inspection status at two dates: nine days after the sheet nothing
  -- is stale; forty days after, everything is. No schedule is seeded, so
  -- coverage is NULL (unscheduled disclosed), never 100% by default.
  SELECT count(*), count(*) FILTER (WHERE scheduled), count(*) FILTER (WHERE covered), count(*) FILTER (WHERE stale)
    INTO n, sched, cov, st FROM app.unit_inspection_status('2026-08-01');
  IF (n, sched, cov, st) IS DISTINCT FROM (3, 0, 0, 0) THEN
    RAISE EXCEPTION 'FAIL 59e: at 2026-08-01 units % scheduled % covered % stale %', n, sched, cov, st; END IF;
  SELECT count(*) FILTER (WHERE stale) INTO st FROM app.unit_inspection_status('2026-09-01');
  IF st IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 59e: at 2026-09-01 stale units %, expected 3', st; END IF;
  -- With a weekly schedule on the horse, coverage becomes computable for that
  -- unit and stays NULL for the other two: false at 2026-08-01, where the
  -- sheet is nine days old, and true at 2026-07-28, where it is five.
  INSERT INTO app.inspection_schedule (tenant_id, vehicle_id, interval_days)
  VALUES ('11111111-1111-1111-1111-111111111111', md5('veh1')::uuid, 7);
  SELECT count(*) FILTER (WHERE scheduled), count(*) FILTER (WHERE covered), count(*) FILTER (WHERE covered IS NULL)
    INTO sched, cov, n FROM app.unit_inspection_status('2026-08-01');
  IF (sched, cov, n) IS DISTINCT FROM (1, 0, 2) THEN
    RAISE EXCEPTION 'FAIL 59e: with one schedule: scheduled % covered % unscheduled %', sched, cov, n; END IF;
  SELECT count(*) FILTER (WHERE covered) INTO cov FROM app.unit_inspection_status('2026-07-28');
  IF cov IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL 59e: five days after the sheet the horse reads uncovered'; END IF;

  -- Staleness comes from reading_staleness_days, the FR-VAL-021 key, not a
  -- constant: the seeded 28 leaves nothing stale nine days after the sheet,
  -- while tightening it to seven turns all three units stale that same day.
  -- effective_from is dated ahead of the as-at bound, not a minute back,
  -- since the function resolves the key at (p_as_at + 1), not now(): a row
  -- stamped now() is not in force on 1 Aug 2026 and would move nothing.
  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111', 'reading_staleness_days', '7'::jsonb, TIMESTAMPTZ '2026-07-01');
  SELECT count(*) FILTER (WHERE stale) INTO st FROM app.unit_inspection_status('2026-08-01');
  IF st IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 59e: on a seven day staleness threshold % of three units read stale at 2026-08-01, expected 3', st; END IF;

  -- FR-DSH-009's horizon is a key, and the count is read off the resolved
  -- value. Judged at a fixed as-at day, as the two status reads above are:
  -- app.predicted_threshold_range anchors every forecast on the reading that
  -- produced it and never on the clock, so a count taken against the tenant's
  -- today would move with the calendar while the fixture stood still. Of the
  -- 17 tyres the two sheets yield a wear rate for, six fall due within 30
  -- days of 1 Aug 2026, and a dated override of seven moves the count to two.
  -- What that pins is the resolution, not a wiring: nothing in db, api or web
  -- reads forecast_horizon_days yet. The FR-DSH-009 tile and
  -- /api/analytics/removal-forecast are B7.2's (spec D7), and the seeded
  -- default is here so they have one to read.
  horizon := (app.config_for('11111111-1111-1111-1111-111111111111', 'forecast_horizon_days', now()) #>> '{}')::int;
  IF horizon IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'FAIL 59e: forecast_horizon_days resolved to %', horizon; END IF;
  SELECT count(*) INTO due FROM app.v_removal_forecast
   WHERE forecast_status = 'FORECAST' AND NOT is_spare
     AND earliest_removal_date <= DATE '2026-08-01' + horizon;
  IF due IS DISTINCT FROM 6 THEN
    RAISE EXCEPTION 'FAIL 59e: % tyres forecast within % days of 2026-08-01, expected 6', due, horizon; END IF;
  -- effective_from a minute back: app.config_for reads effective_from strictly
  -- before p_before, so a row stamped now() is not yet in force.
  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES ('11111111-1111-1111-1111-111111111111', 'forecast_horizon_days', '7'::jsonb, now() - interval '1 minute');
  horizon := (app.config_for('11111111-1111-1111-1111-111111111111', 'forecast_horizon_days', now()) #>> '{}')::int;
  SELECT count(*) INTO due FROM app.v_removal_forecast
   WHERE forecast_status = 'FORECAST' AND NOT is_spare
     AND earliest_removal_date <= DATE '2026-08-01' + horizon;
  IF (horizon, due) IS DISTINCT FROM (7, 2) THEN
    RAISE EXCEPTION 'FAIL 59e: on a shortened horizon of % days the count is %, expected 7/2', horizon, due; END IF;
  RAISE NOTICE 'PASS  59e spare on the tenant day from its reading; status computable and honest about schedules; the forecast horizon answers to configuration';
END $$;
ROLLBACK;

\echo '== 60. Measurement ordinals are checked per statement, scoped to the readings the statement touched (TYRE-252, DR-016)'
-- 000046's header holds the rationale. What is proven here is that the
-- refusals survived the move to a statement trigger, against a planted
-- inspection, as BAC, inside each block's own BEGIN/ROLLBACK (sections 25
-- and 59 use the same pattern). The cost it removes is measured against the
-- volume tenant (TYRE-247), not here. 60b holds the two shapes that must
-- keep passing: the fixture's, and the one app.submit_inspection writes.

\echo '== 60a. a gapped multi-row insert and an out-of-order single row are both refused, in the words 000001 used'
BEGIN;
DO $$
DECLARE t1   constant uuid := '11111111-1111-1111-1111-111111111111';
        insp uuid := md5('t252-insp')::uuid;
        rd   uuid := md5('t252-rd')::uuid;
        ok   boolean;
        msg  text;
BEGIN
  PERFORM set_config('app.tenant_id', t1::text, true);
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds)
  VALUES (insp, t1, md5('veh1')::uuid, md5('comb1')::uuid, md5('driver1')::uuid, md5('t252-cli')::uuid,
          '2026-09-10T05:38:00Z', '2026-09-10T05:45:00Z', 420000, 'suite', '0.0.0-suite', 60);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  SELECT rd, t1, insp, md5('veh1')::uuid, pos.id, NULL, 800
    FROM app.position pos JOIN app.vehicle v ON v.configuration_id = pos.configuration_id
   WHERE v.id = md5('veh1')::uuid AND pos.code = '1';

  -- (a) ordinals 1 and 3 in one statement: a gap the statement closes over.
  ok := false;
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
    VALUES (t1, rd, 1, 'OUTER', 10.0, false, 1.0), (t1, rd, 3, 'INNER', 10.0, false, 1.0);
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'reading % has non-contiguous measurement ordinals (n=2, lo=1, hi=3)' THEN
      RAISE EXCEPTION 'FAIL 60a: gapped insert refused with the wrong message: %', msg;
    END IF;
    ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 60a: a gapped multi-row insert (1, 3) was accepted'; END IF;

  -- (b) ordinal 2 alone, before 1: the set does not start at 1.
  ok := false;
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
    VALUES (t1, rd, 2, 'CENTRE', 10.0, false, 1.0);
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE 'reading % has non-contiguous measurement ordinals (n=1, lo=2, hi=2)' THEN
      RAISE EXCEPTION 'FAIL 60a: out-of-order insert refused with the wrong message: %', msg;
    END IF;
    ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL 60a: ordinal 2 inserted before 1 was accepted'; END IF;
  RAISE NOTICE 'PASS  60a a gapped multi-row insert and an out-of-order single row are refused in 000001''s words';
END $$;
ROLLBACK;

\echo '== 60b. a whole position in one statement passes, and so do three single-row statements in order (the submit_inspection shape)'
BEGIN;
DO $$
DECLARE t1   constant uuid := '11111111-1111-1111-1111-111111111111';
        insp uuid := md5('t252-insp2')::uuid;
        rd1  uuid := md5('t252-rd1')::uuid;
        rd2  uuid := md5('t252-rd2')::uuid;
        n    int;
        g    numeric;
BEGIN
  PERFORM set_config('app.tenant_id', t1::text, true);
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,combination_id,user_id,client_uuid,started_at,submitted_at,odometer,device_id,app_version,duration_seconds)
  VALUES (insp, t1, md5('veh1')::uuid, md5('comb1')::uuid, md5('driver1')::uuid, md5('t252-cli2')::uuid,
          '2026-09-10T05:38:00Z', '2026-09-10T05:45:00Z', 420000, 'suite', '0.0.0-suite', 60);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  SELECT rd1, t1, insp, md5('veh1')::uuid, pos.id, NULL, 800
    FROM app.position pos JOIN app.vehicle v ON v.configuration_id = pos.configuration_id
   WHERE v.id = md5('veh1')::uuid AND pos.code = '1';
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  SELECT rd2, t1, insp, md5('veh1')::uuid, pos.id, NULL, 800
    FROM app.position pos JOIN app.vehicle v ON v.configuration_id = pos.configuration_id
   WHERE v.id = md5('veh1')::uuid AND pos.code = '2';

  -- the fixture's shape: a whole position in one statement
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
  VALUES (t1, rd1, 1, 'OUTER', 10.0, false, 1.0), (t1, rd1, 2, 'CENTRE', 9.0, false, 1.0), (t1, rd1, 3, 'INNER', 10.0, false, 1.0);
  -- app.submit_inspection's shape (000041): one row per statement, in order
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
  VALUES (t1, rd2, 1, 'OUTER', 12.0, false, 1.0);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
  VALUES (t1, rd2, 2, 'CENTRE', 11.0, false, 1.0);
  INSERT INTO app.reading_measurement (tenant_id,reading_id,ordinal,position,tread_mm,orientation_known,granularity_mm)
  VALUES (t1, rd2, 3, 'INNER', 12.0, false, 1.0);
  SELECT count(*) INTO n FROM app.reading_measurement WHERE reading_id IN (rd1, rd2);
  IF n <> 6 THEN RAISE EXCEPTION 'FAIL 60b: expected 6 measurements across the two readings, found %', n; END IF;
  SELECT governing_tread_mm INTO g FROM app.reading WHERE id = rd2;
  IF g IS DISTINCT FROM 11.0 THEN RAISE EXCEPTION 'FAIL 60b: governing depth on the single-row path is %, expected 11.0', g; END IF;
  RAISE NOTICE 'PASS  60b a whole position in one statement and three ordered single-row statements both pass, governing MIN intact';
END $$;
ROLLBACK;

\echo '== 60c. the catalogue holds statement-level ordinal triggers and nothing deferrable'
BEGIN;
DO $$
DECLARE n int; d int;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'app' AND c.relname = 'reading_measurement'
     AND tg.tgname LIKE 'reading_measurement_ordinals_%'
     AND NOT tg.tgisinternal
     AND (tg.tgtype & 1) = 0;              -- bit 0 set means FOR EACH ROW; clear means FOR EACH STATEMENT
  SELECT count(*) INTO d FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'app' AND c.relname = 'reading_measurement' AND tg.tgdeferrable;
  IF n <> 3 OR d <> 0 THEN
    RAISE EXCEPTION 'FAIL 60c: expected three statement-level ordinal triggers and no deferrable trigger on reading_measurement, found % and %', n, d;
  END IF;
  RAISE NOTICE 'PASS  60c three statement-level ordinal triggers, none deferrable';
END $$;
ROLLBACK;

\echo '== 61. B7.1.5: the dashboard substrate index exists as declared (TYRE-247)'
-- Asserted through the catalog (section 34's pattern): an index has no
-- behaviour the suite can watch fail on the 53-reading fixture, and the
-- harm it prevents (a full-history sort at volume) is measured by
-- `make db-explain`, not here. What this pins is that a later migration
-- cannot drop or narrow it silently; TYRE-95's lesson is that a renamed or
-- dropped catalog object orphans everything that assumed it.
BEGIN;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'app' AND tablename = 'reading'
     AND indexname = 'reading_by_vehicle'
     AND indexdef ILIKE '%(tenant_id, vehicle_id, inspection_id)%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 61: expected reading_by_vehicle ON app.reading (tenant_id, vehicle_id, inspection_id), found %', n;
  END IF;
  RAISE NOTICE 'PASS  61 reading_by_vehicle exists on (tenant_id, vehicle_id, inspection_id)';
END $$;
ROLLBACK;

\echo '== 62. B7.2: inflation_compliance_window_days resolves to the seeded default (TYRE-36, U28)'
-- What this pins is the resolution, not a wiring: GET /api/dashboard and
-- /api/analytics/inflation-compliance answer "not configured" when the key
-- is absent (rule 5), so a seed edit that drops one tenant's row would show
-- that tenant a blank rather than fail. The suite runs as app_login, so each
-- tenant is set in turn to reach all three.
BEGIN;
DO $$
DECLARE tid uuid; got int;
BEGIN
  FOREACH tid IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111'::uuid,
                             '22222222-2222-2222-2222-222222222222'::uuid,
                             '33333333-3333-3333-3333-333333333333'::uuid] LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    got := (app.config_for(tid, 'inflation_compliance_window_days', now()) #>> '{}')::int;
    IF got IS DISTINCT FROM 30 THEN
      RAISE EXCEPTION 'FAIL 62: inflation_compliance_window_days is % for %', got, tid;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  62 inflation_compliance_window_days resolves to 30 on every seeded tenant';
END $$;
ROLLBACK;

\echo '== 63. TYRE-211, TYRE-142: the policy in force now has one inclusive resolver, and one call reads one row (FR-CFG-051, FR-CFG-044, FR-VAL-006)'
-- An as-at reader passes a day's exclusive edge to threshold_policy_for. A
-- writer asks what is in force at the instant its call stands for, through
-- threshold_policy_in_force_at, where a row effective at that instant
-- already governs; threshold_policy_in_force asks at now() (000054). The
-- blocks plant at the transaction's own now(), the one instant where the two
-- readings part, or later, and date their returns today so each resolves at
-- now(). Every block rolls back, and 63e proves it.

\echo '== 63a. a row effective at now() is in force for the now readers and not for an as-at edge at that instant; a row effective after now() is in force for neither; both resolvers share one precedence, at now() and at any instant'
BEGIN;
DO $$
DECLARE t1    constant uuid := '11111111-1111-1111-1111-111111111111';
        grp   constant uuid := md5('t63agrp')::uuid;
        pnow  constant uuid := md5('t63apnow')::uuid;
        pstr  constant uuid := md5('t63apstr')::uuid;
        pgrp  constant uuid := md5('t63apgrp')::uuid;
        pgdr  constant uuid := md5('t63apgdr')::uuid;
        psoon constant uuid := md5('t63apsoon')::uuid;
        pday  constant uuid := md5('t63apday')::uuid;
        pfstr constant uuid := md5('t63apfstr')::uuid;
        base  constant uuid := md5('11111111-1111-1111-1111-111111111111thrpol-default')::uuid;
        bstr  constant uuid := md5('11111111-1111-1111-1111-111111111111thrpol-steer')::uuid;
        pol app.threshold_policy; mm numeric; n int; stray int; props text; src text;
        g uuid; c app.axle_class; want uuid; got uuid; edge uuid; wide uuid; steer uuid;
        inst timestamptz;
BEGIN
  PERFORM set_config('app.tenant_id', t1::text, true);

  -- Invoker rights, so RLS on threshold_policy binds the lookup to the
  -- caller's tenant (check 8c), and no SET clause, the same shape as
  -- threshold_policy_for. The now() resolver keeps the signature
  -- v_removal_forecast depends on; the instant resolver beside it carries
  -- the one body (U70).
  SELECT string_agg(p.oid::regprocedure::text || ' ' || l.lanname || ' ' || p.provolatile::text
                    || ' definer=' || p.prosecdef::text
                    || ' config=' || COALESCE(p.proconfig::text, 'none'), '; ' ORDER BY p.proname)
    INTO props
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.proname IN ('threshold_policy_in_force', 'threshold_policy_in_force_at');
  IF props IS DISTINCT FROM 'threshold_policy_in_force(uuid,uuid,axle_class) sql s definer=false config=none; threshold_policy_in_force_at(uuid,uuid,axle_class,timestamp with time zone) sql s definer=false config=none' THEN
    RAISE EXCEPTION 'FAIL 63a: the in-force resolvers read as [%]', COALESCE(props, 'absent');
  END IF;
  -- The predicate and the precedence exist once: the now() resolver is a
  -- projection of the instant resolver, with no FROM of its own.
  SELECT p.prosrc INTO src FROM pg_proc p
   WHERE p.oid = 'app.threshold_policy_in_force(uuid,uuid,app.axle_class)'::regprocedure;
  IF src NOT LIKE '%app.threshold_policy_in_force_at(%now()%' OR src ILIKE '%from%' THEN
    RAISE EXCEPTION 'FAIL 63a: threshold_policy_in_force carries a body of its own: %', src;
  END IF;

  -- The group rows are their scopes' -infinity baselines, behind every
  -- tenant-wide row in time, so the precedence probes below are decided by
  -- the tier and not by the instant. -infinity is the one past instant a
  -- scope's first row may carry (U70; SRS §5.1, errata E1).
  INSERT INTO app.operating_group (id, tenant_id, name, created_by)
  VALUES (grp, t1, 'T63A Northern', NULL);
  INSERT INTO app.threshold_policy (id, tenant_id, operating_group_id, axle_class,
                                    retread_threshold_mm, max_retreads, effective_from)
  VALUES (pnow, t1, NULL, NULL,    6.0, 2, now()),
         (pstr, t1, NULL, 'STEER', 5.0, 2, now()),
         (pgrp, t1, grp,  NULL,    5.5, 2, '-infinity'),
         (pgdr, t1, grp,  'DRIVE', 7.0, 2, '-infinity');

  -- now() is the upper edge of "in force now": a row is not in force before
  -- its own effective_from (FR-CFG-051, TYRE-302). These three sit one
  -- microsecond and one day past now() at a 9.0 no row in force carries,
  -- one on the STEER tier, and every now reader must pass over them.
  INSERT INTO app.threshold_policy (id, tenant_id, operating_group_id, axle_class,
                                    retread_threshold_mm, max_retreads, effective_from)
  VALUES (psoon, t1, NULL, NULL,    9.0, 2, now() + interval '1 microsecond'),
         (pday,  t1, NULL, NULL,    9.0, 2, now() + interval '1 day'),
         (pfstr, t1, NULL, 'STEER', 9.0, 2, now() + interval '1 microsecond');
  wide  := (app.threshold_policy_in_force(t1, NULL, NULL)).id;
  steer := (app.threshold_policy_in_force(t1, NULL, 'STEER')).id;
  mm    := app.current_removal_threshold_mm();
  SELECT count(*) FILTER (WHERE f.removal_threshold_mm = 9.0) INTO stray FROM app.v_removal_forecast f;
  IF wide IS NULL OR wide IN (psoon, pday) OR steer IS NULL OR steer = pfstr
     OR mm IS NULL OR mm = 9.0 OR stray <> 0 THEN
    RAISE EXCEPTION 'FAIL 63a: no row, or a row effective after now(), is in force now (tenant-wide %, STEER %, current_removal_threshold_mm %, % forecast rows at 9.0)',
      wide, steer, mm, stray;
  END IF;

  pol := app.threshold_policy_in_force(t1, NULL, NULL);
  IF pol.id IS DISTINCT FROM pnow THEN
    RAISE EXCEPTION 'FAIL 63a: a row effective at now() was not in force now (resolved % at %)',
      pol.id, pol.retread_threshold_mm;
  END IF;
  -- The same instant as an as-at edge keeps the row out, so a day is still
  -- valued under the policy of that day (000036's convention, FR-CFG-051).
  pol := app.threshold_policy_for(t1, NULL, NULL, now());
  mm  := app.removal_threshold_mm_for(t1, now());
  IF pol.retread_threshold_mm IS DISTINCT FROM 4.0 OR mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 63a: an as-at edge at now() already saw the row effective at it (% / %)',
      pol.retread_threshold_mm, mm;
  END IF;
  mm := app.current_removal_threshold_mm();
  IF mm IS DISTINCT FROM 6.0 THEN
    RAISE EXCEPTION 'FAIL 63a: current_removal_threshold_mm answered % with a 6.0 row in force', mm;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE f.removal_threshold_mm IS DISTINCT FROM 6.0)
    INTO n, stray FROM app.v_removal_forecast f;
  IF n = 0 OR stray <> 0 THEN
    RAISE EXCEPTION 'FAIL 63a: % of % forecast rows project against a threshold other than the 6.0 in force',
      stray, n;
  END IF;

  -- timestamptz counts whole microseconds, so an exclusive edge one
  -- microsecond past now() is the same instant read inclusively, and the two
  -- resolvers must then agree on every tier. The expected row is named as
  -- well, so the pair cannot agree by both being wrong.
  FOR g, c, want IN
    SELECT * FROM (VALUES (NULL::uuid, NULL::app.axle_class, pnow),
                          (NULL, 'STEER', pstr), (NULL, 'DRIVE', pnow),
                          (grp,  NULL,    pgrp), (grp,  'STEER', pgrp),
                          (grp,  'DRIVE', pgdr)) v
  LOOP
    got  := (app.threshold_policy_in_force(t1, g, c)).id;
    edge := (app.threshold_policy_for(t1, g, c, now() + interval '1 microsecond')).id;
    IF got IS DISTINCT FROM want OR edge IS DISTINCT FROM want THEN
      RAISE EXCEPTION 'FAIL 63a: group % class % resolved % in force and % at the next microsecond, expected %',
        g, c, got, edge, want;
    END IF;
  END LOOP;
  -- The same agreement at instants other than now() (U70): a day on, where
  -- pday is effective exactly at the instant asked, and in 2021, before
  -- every finite row, where the group baselines still outrank the seeded
  -- ones. The expected row is named, so the pair cannot agree by both being
  -- wrong.
  FOR inst, g, c, want IN
    SELECT * FROM (VALUES
      (now() + interval '1 day', NULL::uuid, NULL::app.axle_class, pday),
      (now() + interval '1 day', NULL, 'STEER', pfstr),
      (now() + interval '1 day', NULL, 'DRIVE', pday),
      (now() + interval '1 day', grp,  NULL,    pgrp),
      (now() + interval '1 day', grp,  'STEER', pgrp),
      (now() + interval '1 day', grp,  'DRIVE', pgdr),
      (timestamptz '2021-06-01 00:00:00+00', NULL, NULL,    base),
      (timestamptz '2021-06-01 00:00:00+00', NULL, 'STEER', bstr),
      (timestamptz '2021-06-01 00:00:00+00', NULL, 'DRIVE', base),
      (timestamptz '2021-06-01 00:00:00+00', grp,  NULL,    pgrp),
      (timestamptz '2021-06-01 00:00:00+00', grp,  'STEER', pgrp),
      (timestamptz '2021-06-01 00:00:00+00', grp,  'DRIVE', pgdr)) v
  LOOP
    got  := (app.threshold_policy_in_force_at(t1, g, c, inst)).id;
    edge := (app.threshold_policy_for(t1, g, c, inst + interval '1 microsecond')).id;
    IF got IS DISTINCT FROM want OR edge IS DISTINCT FROM want THEN
      RAISE EXCEPTION 'FAIL 63a: at % group % class % resolved % in force and % at the next microsecond, expected %',
        inst, g, c, got, edge, want;
    END IF;
  END LOOP;
  -- Inclusive against exclusive at that later instant: the as-at edge still
  -- takes psoon, effective before it, and not pday, effective at it.
  edge := (app.threshold_policy_for(t1, NULL, NULL, now() + interval '1 day')).id;
  IF edge IS DISTINCT FROM psoon THEN
    RAISE EXCEPTION 'FAIL 63a: the as-at edge at now() + 1 day resolved %, expected the row effective just after now()', edge;
  END IF;
  RAISE NOTICE 'PASS  63a a row effective at now() governs current_removal_threshold_mm and the forecast, not an as-at edge at that instant; a row effective after now() governs neither; one precedence at now(), a day on and in 2021';
END $$;
ROLLBACK;

\echo '== 63b. one policy row written in the transaction prices every stored rate and caps every retread in the calls that follow (FR-VAL-006, BR-FIT-009, FR-CFG-044)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        pol  constant uuid := md5('t63bpol')::uuid;
        d_rt constant uuid := md5('t63brt')::uuid;
        ta   constant uuid := md5('t63bta')::uuid;   -- returned and accepted
        tb   constant uuid := md5('t63btb')::uuid;   -- returning at the planted cap
        tc   constant uuid := md5('t63btc')::uuid;   -- dispatched at the planted cap
        ja   constant uuid := md5('t63bja')::uuid;
        jb   constant uuid := md5('t63bjb')::uuid;
        tz text; r record; rate numeric;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  -- Every figure differs from the seeded row's (4.0, cap 2), so each
  -- assertion names the row that governed the call.
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm,
                                    warning_threshold_mm, max_retreads, effective_from)
  VALUES (pol, bac, 6.0, 8.0, 1, now());

  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
    'purchase_price', '4319.91', 'cost_source', 'INVOICE'));
  SELECT t.rand_per_mm INTO rate FROM app.tyre t WHERE t.id = r.tyre_id;
  IF rate IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, 6.0) THEN
    RAISE EXCEPTION 'FAIL 63b: receive_tyres stored % where the 6.0 in force gives % (4.0 gives %)',
      rate, app.rand_per_mm(4319.91, 25.0, 6.0), app.rand_per_mm(4319.91, 25.0, 4.0);
  END IF;
  -- Planted with no receipt, since a received tyre is priced on its
  -- receipt (000059) and set_tyre_cost's own path is the one under test.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T63-COST', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 25.0, 'IN_STOCK',
          app.tenant_today(tz))
  RETURNING id INTO r;
  PERFORM app.set_tyre_cost(r.id, 4319.91, 'INVOICE');
  SELECT t.rand_per_mm INTO rate FROM app.tyre t WHERE t.id = r.id;
  IF rate IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, 6.0) THEN
    RAISE EXCEPTION 'FAIL 63b: set_tyre_cost stored % where the 6.0 in force gives %',
      rate, app.rand_per_mm(4319.91, 25.0, 6.0);
  END IF;

  INSERT INTO app.depot (id, tenant_id, name, type)
  VALUES (d_rt, bac, 'T63B Retreaders', 'RETREADER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, state) VALUES
    (ta, bac, 'T63TYREA', sz1, pt1, 'NEW',     0, 'AT_RETREADER'),
    (tb, bac, 'T63TYREB', sz1, pt1, 'RETREAD', 1, 'AT_RETREADER'),
    (tc, bac, 'T63TYREC', sz1, pt1, 'RETREAD', 1, 'REMOVED');
  -- Raw jobs, 42g's pattern, because dispatch_tyre would refuse tb at the door.
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at) VALUES
    (ja, bac, ta, d_rt, app.tenant_today(tz) - 3),
    (jb, bac, tb, d_rt, app.tenant_today(tz) - 3);

  -- 5.5 mm clears the seeded 4.0 and not the 6.0 in force. Each return is
  -- dated today, so it reads the policy in force at now() (U70); 70e holds
  -- the back-dated half.
  BEGIN
    PERFORM app.log_retread_return(ja, app.tenant_today(tz), true, 'T63-RPT-A', 2500.00, 5.5, 800.00);
    RAISE EXCEPTION 'FAIL 63b: a casing returned at 5.5 mm was accepted under the 6.0 threshold in force';
  EXCEPTION WHEN sqlstate 'TY014' THEN
    IF SQLERRM NOT LIKE '%removal threshold of 6.0 mm%' THEN
      RAISE EXCEPTION 'FAIL 63b: the 5.5 mm return was refused for another reason: %', SQLERRM;
    END IF;
  END;
  PERFORM app.log_retread_return(ja, app.tenant_today(tz), true, 'T63-RPT-A', 2500.00, 16.0, 800.00);
  SELECT t.rand_per_mm INTO rate FROM app.tyre t WHERE t.id = ta;
  IF rate IS DISTINCT FROM app.rand_per_mm(2500.00, 16.0, 6.0) THEN
    RAISE EXCEPTION 'FAIL 63b: log_retread_return stored % where the 6.0 in force gives %',
      rate, app.rand_per_mm(2500.00, 16.0, 6.0);
  END IF;

  -- The cap comes off the same row. At cap 1 a casing retreaded once is
  -- refused, where the seeded cap of 2 would pass it.
  BEGIN
    PERFORM app.log_retread_return(jb, app.tenant_today(tz), true, 'T63-RPT-B', 2500.00, 16.0, 800.00);
    RAISE EXCEPTION 'FAIL 63b: a return past the cap in force was retreaded';
  EXCEPTION WHEN sqlstate 'TY015' THEN
    IF SQLERRM NOT LIKE '%cap of 1%' THEN
      RAISE EXCEPTION 'FAIL 63b: the return was refused at another cap: %', SQLERRM;
    END IF;
  END;
  BEGIN
    PERFORM app.dispatch_tyre(tc, 'AT_RETREADER', d_rt);
    RAISE EXCEPTION 'FAIL 63b: a dispatch past the cap in force was sent';
  EXCEPTION WHEN sqlstate 'TY015' THEN
    IF SQLERRM NOT LIKE '%cap of 1%' THEN
      RAISE EXCEPTION 'FAIL 63b: the dispatch was refused at another cap: %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'PASS  63b a row written in the transaction prices receive_tyres, set_tyre_cost and log_retread_return at 6.0 and caps the return and the dispatch at 1';
END $$;
ROLLBACK;

\echo '== 63c. a class row and a group row in force at now() reach none of the class-blind readers (U5, FR-CFG-044)'
-- These readers name no axle class and no group, because a casing off the
-- vehicle has neither (U5), so only a tenant-wide row can govern them. A
-- newer STEER row and a newer group row, at cap 0 and a 7.0 threshold, must
-- move nothing they read. The return is dated today, so both rows are in
-- force at its instant (U70).
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        grp  constant uuid := md5('t63cgrp')::uuid;
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        d_rt constant uuid := md5('t63crt')::uuid;
        td   constant uuid := md5('t63ctd')::uuid;
        tz text; mm numeric; job uuid; rate numeric;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  INSERT INTO app.operating_group (id, tenant_id, name, created_by)
  VALUES (grp, bac, 'T63C Northern', NULL);
  INSERT INTO app.threshold_policy (id, tenant_id, operating_group_id, axle_class,
                                    retread_threshold_mm, max_retreads,
                                    retreads_permitted, effective_from)
  VALUES (md5('t63cstr')::uuid, bac, NULL, 'STEER', 7.0, 0, false, now()),
         (md5('t63cgrppol')::uuid, bac, grp, NULL, 7.0, 0, false, now());

  mm := app.current_removal_threshold_mm();
  IF mm IS DISTINCT FROM 4.0 THEN
    RAISE EXCEPTION 'FAIL 63c: current_removal_threshold_mm reached a class or group row (%)', mm;
  END IF;

  INSERT INTO app.depot (id, tenant_id, name, type)
  VALUES (d_rt, bac, 'T63C Retreaders', 'RETREADER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, state)
  VALUES (td, bac, 'T63TYRED', sz1, pt1, 'NEW', 0, 'REMOVED');
  BEGIN
    SELECT d.retread_job_id INTO job
      FROM app.dispatch_tyre(td, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 3) d;
  EXCEPTION WHEN sqlstate 'TY015' THEN
    RAISE EXCEPTION 'FAIL 63c: dispatch_tyre read a class or group cap: %', SQLERRM;
  END;
  BEGIN
    PERFORM app.log_retread_return(job, app.tenant_today(tz), true, 'T63-RPT-D', 2500.00, 16.0, 800.00);
  EXCEPTION WHEN sqlstate 'TY015' THEN
    RAISE EXCEPTION 'FAIL 63c: log_retread_return read a class or group cap: %', SQLERRM;
  END;
  SELECT t.rand_per_mm INTO rate FROM app.tyre t WHERE t.id = td;
  IF rate IS DISTINCT FROM app.rand_per_mm(2500.00, 16.0, 4.0) THEN
    RAISE EXCEPTION 'FAIL 63c: log_retread_return priced at % rather than the tenant-wide 4.0 (%)',
      rate, app.rand_per_mm(2500.00, 16.0, 4.0);
  END IF;
  RAISE NOTICE 'PASS  63c the tenant-wide row alone governs current_removal_threshold_mm, the dispatch cap and the return''s cap and rate';
END $$;
ROLLBACK;

\echo '== 63d. fit_tyre reads the axle-class row in force at now(), so a DRIVE rule written in the transaction reaches the next fit (FR-FIT-006, FR-CFG-044, U11)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        vh  constant uuid := md5('t63dh')::uuid;
        sz1 constant uuid := md5('sz1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        ty1 constant uuid := md5('t63dty1')::uuid;
        ty2 constant uuid := md5('t63dty2')::uuid;
        cfg uuid; pa uuid; pb uuid; r record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- The seed fills every position on veh1, so this block plants its own
  -- empty HORSE on the same configuration (section 41's pattern); a HORSE
  -- owes a fitment odometer (TY009).
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO pa FROM app.position p
   WHERE p.configuration_id = cfg AND p.axle_class = 'DRIVE' AND NOT p.is_spare
   ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO pb FROM app.position p
   WHERE p.configuration_id = cfg AND p.axle_class = 'DRIVE' AND NOT p.is_spare
   ORDER BY p.sequence OFFSET 1 LIMIT 1;
  IF pa IS NULL OR pb IS NULL THEN
    RAISE EXCEPTION 'FAIL 63d: veh1''s configuration has no two DRIVE positions to fit';
  END IF;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (vh, bac, 'T63-H', 'T63H GP', cfg, 'HORSE', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, state) VALUES
    (ty1, bac, 'T63TYRE1', sz1, pt1, 'RETREAD', 1, 'IN_STOCK'),
    (ty2, bac, 'T63TYRE2', sz1, pt1, 'RETREAD', 1, 'IN_STOCK');

  -- The control. The seeded rows permit retreads on DRIVE, so nothing warns.
  SELECT * INTO r FROM app.fit_tyre(ty1, vh, pa, 12.0, 'MARK_OUTBOARD', 400000);
  IF r.warnings @> '[{"code":"RETREAD_ON_NON_PERMITTED_AXLE"}]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 63d: a retread on DRIVE warned before any DRIVE rule existed: %', r.warnings;
  END IF;
  -- One DRIVE row later, at the same instant. The class row outranks the
  -- tenant-wide one and is in force from now(). Its threshold and cap are
  -- stated because neither has a default (rule 5); no reader takes either
  -- off a class row (U5).
  INSERT INTO app.threshold_policy (id, tenant_id, axle_class, retread_threshold_mm,
                                    max_retreads, retreads_permitted, effective_from)
  VALUES (md5('t63ddrv')::uuid, bac, 'DRIVE', 4.0, 2, false, now());
  SELECT * INTO r FROM app.fit_tyre(ty2, vh, pb, 12.0, 'MARK_OUTBOARD', 400000);
  IF NOT (r.warnings @> '[{"code":"RETREAD_ON_NON_PERMITTED_AXLE"}]'::jsonb) THEN
    RAISE EXCEPTION 'FAIL 63d: a DRIVE rule in force at now() did not reach the fit: %', r.warnings;
  END IF;
  RAISE NOTICE 'PASS  63d a DRIVE rule written at now() warns the next retread fitted on DRIVE, and not the one before it';
END $$;
ROLLBACK;

\echo '== 63e. nothing 63a to 63d planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT (SELECT count(*) FROM app.threshold_policy
           WHERE id IN (md5('t63apnow')::uuid, md5('t63apstr')::uuid, md5('t63apgrp')::uuid,
                        md5('t63apgdr')::uuid, md5('t63bpol')::uuid, md5('t63cstr')::uuid,
                        md5('t63cgrppol')::uuid, md5('t63ddrv')::uuid, md5('t63apsoon')::uuid,
                        md5('t63apday')::uuid, md5('t63apfstr')::uuid))
       + (SELECT count(*) FROM app.operating_group
           WHERE id IN (md5('t63agrp')::uuid, md5('t63cgrp')::uuid))
       + (SELECT count(*) FROM app.tyre WHERE display_code LIKE 'T63TYRE%')
       -- 63b's two receipts carry issued codes, so they are found by their rate.
       + (SELECT count(*) FROM app.tyre WHERE rand_per_mm = app.rand_per_mm(4319.91, 25.0, 6.0))
       + (SELECT count(*) FROM app.retread_job
           WHERE tyre_id IN (md5('t63bta')::uuid, md5('t63btb')::uuid, md5('t63ctd')::uuid))
       + (SELECT count(*) FROM app.depot WHERE id IN (md5('t63brt')::uuid, md5('t63crt')::uuid))
       + (SELECT count(*) FROM app.vehicle WHERE id = md5('t63dh')::uuid)
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 63e: % rows planted by section 63 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  63e section 63 leaves no residue';
END $$;

\echo '== 64. An estate group with no valued member totals NULL, not 0 (TYRE-269, U36, NFR-PRO-002)'
-- total_value adds each side's known sum (000011). With neither side known
-- the total is unknown too, and a 0 would render as a figure; 64b and 64c
-- pin the one-side-known cases in both directions, so a regression that
-- nulls a partial sum fails here too (TYRE-269). BAC's baseline has no IN_STOCK
-- tyre, so each planted tyre is the whole TENANT/IN_STOCK group. Rolled
-- back (DR-014a).
BEGIN;
DO $$
DECLARE n int; v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,state)
  VALUES (md5('estnull64a')::uuid,'11111111-1111-1111-1111-111111111111','PROBE64A','NEW','IN_STOCK');

  SELECT tyre_count, tread_value, casing_value, total_value INTO STRICT n, v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'IN_STOCK';
  IF n <> 1 OR v IS NOT NULL OR c IS NOT NULL OR tot IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 64a: unvalued group n=% tread=% casing=% total=%, expected 1/NULL/NULL/NULL', n, v, c, tot;
  END IF;
  SELECT total_value INTO STRICT tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'ALL';
  IF tot IS DISTINCT FROM 70183.50 THEN
    RAISE EXCEPTION 'FAIL 64a: grand total %, expected 70183.50', tot;
  END IF;
  RAISE NOTICE 'PASS  64a a group with no valued member totals NULL; the grand total holds';
END $$;
ROLLBACK;

-- 64b: section 17's PROBE1 without its casing, so its tread is the same
-- AUDIT value, 6mm over the threshold at R205.71/mm. The total is the known
-- side, never NULL and never 0.
BEGIN;
DO $$
DECLARE v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,purchase_date,purchase_price,new_tread_mm,rand_per_mm,state,last_tread_mm)
  VALUES (md5('estnull64b')::uuid,'11111111-1111-1111-1111-111111111111','PROBE64B','NEW','2024-03-01',4320.00,25.0,205.7100,'IN_STOCK',10.0);

  SELECT tread_value, casing_value, total_value INTO STRICT v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'IN_STOCK';
  IF v IS DISTINCT FROM 1234.26 OR c IS NOT NULL OR tot IS DISTINCT FROM 1234.26 THEN
    RAISE EXCEPTION 'FAIL 64b: tread-only group tread=% casing=% total=%, expected 1234.26/NULL/1234.26', v, c, tot;
  END IF;
  RAISE NOTICE 'PASS  64b a group with only the tread side known totals that side';
END $$;
ROLLBACK;

-- 64c: section 17's PROBE2, casing known and no tread input. The mirror of
-- 64b, in the other direction: the total is the casing side alone, never
-- NULL and never 0.
BEGIN;
DO $$
DECLARE v numeric; c numeric; tot numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id,tenant_id,display_code,status,casing_value,state)
  VALUES (md5('estnull64c')::uuid,'11111111-1111-1111-1111-111111111111','PROBE64C','NEW',50.00,'IN_STOCK');

  SELECT tread_value, casing_value, total_value INTO STRICT v, c, tot
    FROM app.v_estate_valuation WHERE level = 'TENANT' AND location_class = 'IN_STOCK';
  IF v IS NOT NULL OR c IS DISTINCT FROM 50.00 OR tot IS DISTINCT FROM 50.00 THEN
    RAISE EXCEPTION 'FAIL 64c: casing-only group tread=% casing=% total=%, expected NULL/50.00/50.00', v, c, tot;
  END IF;
  RAISE NOTICE 'PASS  64c a group with only the casing side known totals that side';
END $$;
ROLLBACK;

\echo '== 65. The governing-tread definer chain names its tenant in the MIN(), the latest-reading lookup and the fitment join (TYRE-259, rule 1)'
-- Why the chain must name its tenant: db/CLAUDE.md, Adding a function. No
-- fixture result moves with the predicates, so the pin is on the text of the
-- function the trigger runs, and a rewrite (TYRE-257) has to carry them. The
-- fitment one has no index to use until TYRE-347. 65a proves the matcher on
-- planted text. The two temporary functions serve 65 and 66b and are dropped
-- after 66b.
--
-- Block comments are stripped before line comments, because a line comment
-- inside a block comment would otherwise take the block's closing marker
-- with it.
CREATE FUNCTION pg_temp.sans_comments(body text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(regexp_replace(body, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g')
$fn$;
-- \m and \M anchor each alias, so pr.tenant_id is not r.tenant_id.
CREATE FUNCTION pg_temp.names_tenant(body text, lhs text, rhs text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT pg_temp.sans_comments(body)
         ~ ('\m' || replace(lhs, '.', '\.') || '\s*=\s*' || replace(rhs, '.', '\.') || '\M|'
            || '\m' || replace(rhs, '.', '\.') || '\s*=\s*' || replace(lhs, '.', '\.') || '\M')
$fn$;

\echo '== 65a. the matcher finds a predicate in either operand order and any spacing, and not in a comment or under a longer alias'
DO $$
DECLARE
  l constant text := 'r.tenant_id';
  r constant text := 't.tenant_id';
BEGIN
  IF NOT pg_temp.names_tenant('WHERE r.tenant_id = t.tenant_id', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: the plain predicate was not found';
  END IF;
  IF NOT pg_temp.names_tenant('WHERE t.tenant_id=r.tenant_id', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: the reversed, unspaced predicate was not found';
  END IF;
  IF NOT pg_temp.names_tenant(E'WHERE r.tenant_id\n    = t.tenant_id', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: a predicate broken across lines was not found';
  END IF;
  IF NOT pg_temp.names_tenant('/* a */ AND r.tenant_id = t.tenant_id /* b */', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: live text between two block comments was stripped with them';
  END IF;
  IF pg_temp.names_tenant('AND pr.tenant_id = t.tenant_id', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: pr.tenant_id was taken for r.tenant_id';
  END IF;
  IF pg_temp.names_tenant('-- AND r.tenant_id = t.tenant_id', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: a predicate in a line comment was found';
  END IF;
  IF pg_temp.names_tenant(E'/*\n AND r.tenant_id = t.tenant_id\n*/', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: a predicate in a block comment was found';
  END IF;
  IF pg_temp.names_tenant('/* AND r.tenant_id = t.tenant_id -- x */', l, r) THEN
    RAISE EXCEPTION 'FAIL 65a: a predicate in a block comment holding a line comment was found';
  END IF;
  RAISE NOTICE 'PASS  65a the matcher finds both spellings and ignores comments and longer aliases';
END $$;

\echo '== 65b. the MIN() the trigger runs, the latest-reading lookup and the fitment join each carry the predicate'
DO $$
DECLARE
  governs  regprocedure;
  enabled  "char";
  register text := pg_get_functiondef('app.tyre_valuation_asof(date)'::regprocedure);
  missing  text[] := '{}';
BEGIN
  SELECT t.tgfoid::regprocedure, t.tgenabled INTO governs, enabled
    FROM pg_trigger t
   WHERE t.tgrelid = 'app.reading_measurement'::regclass
     AND t.tgname = 'reading_measurement_governs';
  IF governs IS NULL THEN
    RAISE EXCEPTION 'FAIL 65b: reading_measurement_governs is gone; point this pin at whatever maintains governing_tread_mm now';
  END IF;
  IF enabled NOT IN ('O', 'A') THEN
    RAISE EXCEPTION 'FAIL 65b: reading_measurement_governs is not enabled (tgenabled %)', enabled;
  END IF;
  IF NOT pg_temp.names_tenant(pg_get_functiondef(governs), 'm.tenant_id', 'row_tenant') THEN
    missing := array_append(missing, governs::text || ': m.tenant_id = row_tenant');
  END IF;
  IF NOT pg_temp.names_tenant(register, 'r.tenant_id', 't.tenant_id') THEN
    missing := array_append(missing, 'tyre_valuation_asof: r.tenant_id = t.tenant_id');
  END IF;
  IF NOT pg_temp.names_tenant(register, 'f.tenant_id', 't.tenant_id') THEN
    missing := array_append(missing, 'tyre_valuation_asof: f.tenant_id = t.tenant_id');
  END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'FAIL 65b: definer-chain lookup(s) without a tenant predicate: %',
      array_to_string(missing, '; ');
  END IF;
  RAISE NOTICE 'PASS  65b % and the register''s latest-reading lookup and fitment join each name the tenant', governs;
END $$;

\echo '== 66. When captures of a unit share a submitted_at, the register values each tyre on the reading v_exception judges (TYRE-348, FR-VAL-006)'
-- v_latest_unit_inspection (000045) breaks a submitted_at tie on received_at
-- and then id. The register has to break it the same way, or a tyre is
-- valued on one reading and judged on another. Three captures of veh1 share
-- one submitted_at, two of them one received_at too, so both keys decide.
-- 66a catches a wrong order in either key. An order with no tiebreaker
-- picks by plan and passed 66a on this fixture, so 66b pins the text.

\echo '== 66a. the tie resolves to the same reading in the register and in v_exception (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE
  t1      constant uuid := '11111111-1111-1111-1111-111111111111';
  veh     constant uuid := md5('veh1')::uuid;
  s       constant timestamptz := date_trunc('minute', now()) - interval '1 hour';
  first_in constant uuid := md5('t348-a')::uuid;
  tie_b   constant uuid := md5('t348-b')::uuid;
  tie_c   constant uuid := md5('t348-c')::uuid;
  winner  uuid := least(tie_b, tie_c);
  loser   uuid := greatest(tie_b, tie_c);
  pos1 uuid; pos2 uuid; tyre1 uuid; tyre2 uuid;
  picked uuid; judged numeric; valued numeric;
  insp uuid; tyre uuid; expected numeric;
  n int := 0;
BEGIN
  PERFORM set_config('app.tenant_id', t1::text, true);
  SELECT f.position_id, f.tyre_id INTO STRICT pos1, tyre1
    FROM app.fitment f JOIN app.position p ON p.id = f.position_id
   WHERE f.vehicle_id = veh AND p.code = '1' AND f.removed_at IS NULL;
  SELECT f.position_id, f.tyre_id INTO STRICT pos2, tyre2
    FROM app.fitment f JOIN app.position p ON p.id = f.position_id
   WHERE f.vehicle_id = veh AND p.code = '2' AND f.removed_at IS NULL;

  INSERT INTO app.inspection (id, tenant_id, vehicle_id, combination_id, user_id, client_uuid,
                              started_at, submitted_at, received_at, state)
  VALUES (first_in, t1, veh, md5('comb1')::uuid, md5('driver1')::uuid, md5('t348-cli-a')::uuid,
          s - interval '5 minutes', s, s + interval '10 minutes', 'SYNCED'),
         (tie_b, t1, veh, md5('comb1')::uuid, md5('driver1')::uuid, md5('t348-cli-b')::uuid,
          s - interval '5 minutes', s, s + interval '20 minutes', 'SYNCED'),
         (tie_c, t1, veh, md5('comb1')::uuid, md5('driver1')::uuid, md5('t348-cli-c')::uuid,
          s - interval '5 minutes', s, s + interval '20 minutes', 'SYNCED');

  -- The winner reads 7.0 on tyre1 and 8.0 on tyre2; every other reading is
  -- deeper, so a wrong pick shows as a deeper tread.
  FOREACH insp IN ARRAY ARRAY[winner, first_in, loser] LOOP
    n := n + 1;
    INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
    VALUES (md5('t348-1-' || insp)::uuid, t1, insp, veh, pos1, tyre1, 800);
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
    VALUES (t1, md5('t348-1-' || insp)::uuid, 1, 'OUTER', 5.0 + 2 * n, false, 1.0);
  END LOOP;
  n := 0;
  FOREACH insp IN ARRAY ARRAY[loser, first_in, winner] LOOP
    n := n + 1;
    INSERT INTO app.reading (id, tenant_id, inspection_id, vehicle_id, position_id, tyre_id, pressure_kpa)
    VALUES (md5('t348-2-' || insp)::uuid, t1, insp, veh, pos2, tyre2, 800);
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known, granularity_mm)
    VALUES (t1, md5('t348-2-' || insp)::uuid, 1, 'OUTER', 14.0 - 2 * n, false, 1.0);
  END LOOP;

  SELECT u.inspection_id INTO STRICT picked
    FROM app.v_latest_unit_inspection u WHERE u.vehicle_id = veh;
  IF picked IS DISTINCT FROM winner THEN
    RAISE EXCEPTION 'FAIL 66a: v_latest_unit_inspection took %, not the tie''s winner %; the premise is wrong', picked, winner;
  END IF;
  FOR i IN 1..2 LOOP
    tyre := (ARRAY[tyre1, tyre2])[i];
    expected := (ARRAY[7.0, 8.0])[i];
    SELECT lr.governing_tread_mm INTO STRICT judged
      FROM app.v_latest_reading lr WHERE lr.vehicle_id = veh AND lr.tyre_id = tyre;
    SELECT tv.current_tread_mm INTO STRICT valued
      FROM app.tyre_valuation_asof((now() AT TIME ZONE 'UTC')::date) tv WHERE tv.tyre_id = tyre;
    IF judged IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'FAIL 66a: v_latest_reading judges tyre % on % mm, not the winner''s %', tyre, judged, expected;
    END IF;
    IF valued IS DISTINCT FROM judged THEN
      RAISE EXCEPTION 'FAIL 66a: the register values tyre % on % mm but v_exception judges it on % mm', tyre, valued, judged;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  66a a submitted_at tie resolves to the same reading in the register and in v_exception';
END $$;
ROLLBACK;

\echo '== 66b. the register orders its latest-reading lookup by v_latest_unit_inspection''s three keys'
DO $$
BEGIN
  IF pg_temp.sans_comments(pg_get_functiondef('app.tyre_valuation_asof(date)'::regprocedure))
     !~ 'ORDER BY\s+i\.submitted_at\s+DESC\s*,\s*i\.received_at\s+DESC\s*,\s*i\.id\M' THEN
    RAISE EXCEPTION 'FAIL 66b: the register''s latest-reading lookup no longer orders by submitted_at DESC, received_at DESC, id';
  END IF;
  RAISE NOTICE 'PASS  66b the register breaks a submitted_at tie on received_at and then id';
END $$;

\echo '== 67. The app login cannot attach the governing-tread definer to a table of its own (TYRE-346, rule 1)'
-- PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER, not when
-- the trigger fires, so reading_measurement_governs keeps working without the
-- grant: section 31's submit and 60b still read the MIN it writes.

\echo '== 67a. no SECURITY DEFINER routine in app is executable by the app login'
DO $$
DECLARE offenders text;
BEGIN
  IF to_regprocedure('app.refresh_governing_tread()') IS NULL THEN
    RAISE EXCEPTION 'FAIL 67a: app.refresh_governing_tread() is gone; point this section at whatever definer replaced it';
  END IF;
  -- has_function_privilege counts PUBLIC and app_rw, the two grants 000001 left.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO offenders
    FROM pg_proc p
   WHERE p.pronamespace = 'app'::regnamespace
     AND p.prosecdef
     AND has_function_privilege(current_user, p.oid, 'EXECUTE');
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 67a: % may execute %, so it can attach it as a trigger and run it with RLS off',
      current_user, offenders;
  END IF;
  RAISE NOTICE 'PASS  67a no definer in app is executable by %', current_user;
END $$;

\echo '== 67b. attaching the definer to the login''s own temp table is refused'
DO $$
DECLARE err text;
BEGIN
  CREATE TEMP TABLE probe_67 (reading_id uuid, tenant_id uuid);
  -- Control: an invoker trigger function attaches, so a refusal below is the
  -- definer's grant and not the login's right to create triggers at all.
  CREATE TRIGGER probe_67_control AFTER INSERT ON probe_67
    FOR EACH STATEMENT EXECUTE FUNCTION app.check_measurement_ordinals();
  BEGIN
    CREATE TRIGGER probe_67_t AFTER INSERT ON probe_67
      FOR EACH ROW EXECUTE FUNCTION app.refresh_governing_tread();
  EXCEPTION WHEN insufficient_privilege THEN err := SQLERRM;
  END;
  DROP TABLE probe_67;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 67b: % attached app.refresh_governing_tread() to its own temp table', current_user;
  END IF;
  IF err NOT LIKE '%refresh_governing_tread%' THEN
    RAISE EXCEPTION 'FAIL 67b: the trigger was refused, but not for the definer (%)', err;
  END IF;
  RAISE NOTICE 'PASS  67b the definer cannot be attached to a table the login owns';
END $$;
DROP FUNCTION pg_temp.names_tenant(text, text, text);
DROP FUNCTION pg_temp.sans_comments(text);

\echo '== 68. A sign-in subject links one app_user row, only the owning role writes it, and a session start is recorded once (TYRE-317, ADR-0016, FR-AUD-004)'
-- The app role writes every app_user column except subject, so no handler
-- can re-link a login to another person's row (ADR-0016 decision 6).

\echo '== 68a. the app login holds INSERT and UPDATE on every app_user column except subject'
DO $$
DECLARE bad text; n int;
BEGIN
  -- Control: the sweep reads the live column list, so a column added later
  -- enrols itself. With too few columns the sweep below would be vacuous.
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid = 'app.app_user'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname <> 'subject';
  IF n < 11 THEN
    RAISE EXCEPTION 'FAIL 68a: app.app_user has only % columns besides subject; the sweep would prove nothing', n;
  END IF;
  SELECT string_agg(a.attname || ' ' || p.priv, ', ' ORDER BY a.attnum, p.priv) INTO bad
    FROM pg_attribute a
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE')) AS p(priv)
   WHERE a.attrelid = 'app.app_user'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname <> 'subject'
     AND NOT has_column_privilege(current_user, 'app.app_user', a.attname, p.priv);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 68a: the app login cannot write app_user %; createUser needs every column but subject', bad;
  END IF;
  IF has_column_privilege(current_user, 'app.app_user', 'subject', 'INSERT')
     OR has_column_privilege(current_user, 'app.app_user', 'subject', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 68a: the app login can write app_user.subject, so a handler could re-link a login';
  END IF;
  RAISE NOTICE 'PASS  68a the app login writes every app_user column except subject';
END $$;

\echo '== 68b. an UPDATE or INSERT that names subject is refused for privilege (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE err text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  -- Control: the same row takes an UPDATE of a granted column, so the
  -- refusal below is the grant, not RLS and not a missing row.
  UPDATE app.app_user SET display_name = display_name WHERE id = md5('driver1')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 68b: the control UPDATE matched no row, so the refusal below would prove nothing';
  END IF;
  BEGIN
    UPDATE app.app_user SET subject = md5('probe-68b')::uuid WHERE id = md5('driver1')::uuid;
  EXCEPTION WHEN insufficient_privilege THEN err := SQLERRM;
  END;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 68b: the app login re-linked driver1 to another subject';
  END IF;
  -- insufficient_privilege is also an RLS WITH CHECK failure; the message
  -- tells the grant from a policy.
  IF err NOT LIKE 'permission denied%' THEN
    RAISE EXCEPTION 'FAIL 68b: the UPDATE was refused, but not by the column grant (%)', err;
  END IF;
  err := NULL;
  BEGIN
    INSERT INTO app.app_user (tenant_id, email, display_name, role, subject)
    VALUES ('11111111-1111-1111-1111-111111111111', 'probe-68b@example.invalid', 'Probe', 'DRIVER',
            md5('probe-68b')::uuid);
  EXCEPTION WHEN insufficient_privilege THEN err := SQLERRM;
  END;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 68b: the app login inserted a user that already carries a subject';
  END IF;
  IF err NOT LIKE 'permission denied%' THEN
    RAISE EXCEPTION 'FAIL 68b: the INSERT was refused, but not by the column grant (%)', err;
  END IF;
  RAISE NOTICE 'PASS  68b only the owning role writes app_user.subject';
END $$;
ROLLBACK;

\echo '== 68c. the subject key and the session-start key are unique, partial and lead with tenant_id'
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO def
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('app.app_user_tenant_subject_key') AND i.indisunique;
  IF def IS NULL OR def !~ '\(tenant_id, subject\) WHERE \(subject IS NOT NULL\)' THEN
    RAISE EXCEPTION 'FAIL 68c: app_user_tenant_subject_key is missing or not unique on (tenant_id, subject) WHERE subject IS NOT NULL: %', def;
  END IF;
  SELECT pg_get_indexdef(i.indexrelid) INTO def
    FROM pg_index i
   WHERE i.indexrelid = to_regclass('app.audit_log_session_start_key') AND i.indisunique;
  IF def IS NULL OR def !~ '\(tenant_id, session_id\) WHERE \(action = ''SESSION_START''::text\)' THEN
    RAISE EXCEPTION 'FAIL 68c: audit_log_session_start_key is missing or not unique on (tenant_id, session_id) WHERE action = SESSION_START: %', def;
  END IF;
  RAISE NOTICE 'PASS  68c both keys are unique, partial and lead with tenant_id';
END $$;

\echo '== 68d. a subject resolves only inside its own tenant (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE n int;
BEGIN
  -- Control: Second Fleet's subject exists and resolves with its own tenant
  -- bound, so the zero below is the boundary and not a missing seed
  -- (docs/lessons.md, 2026-09-19).
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO n FROM app.app_user WHERE subject = md5('subject-driver2')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 68d: Second Fleet''s seeded subject found % rows with Second Fleet bound; the control needs exactly one', n;
  END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM app.app_user WHERE subject = md5('subject-driver1')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 68d: BAC''s seeded subject found % rows with BAC bound; the control needs exactly one', n;
  END IF;
  SELECT count(*) INTO n FROM app.app_user WHERE subject = md5('subject-driver2')::uuid;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 68d: Second Fleet''s seeded subject is visible with BAC bound';
  END IF;
  RAISE NOTICE 'PASS  68d a subject resolves only inside its own tenant';
END $$;
ROLLBACK;

\echo '== 68e. app.record_session_start() writes one row per session, only its tenant sees it, and it refuses an unbound session, actor or tenant (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE n int; err text;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  PERFORM set_config('app.session_id', 'sid:probe-68e-one', true);
  PERFORM app.record_session_start();
  PERFORM app.record_session_start();
  SELECT count(*) INTO n FROM app.audit_log
   WHERE action = 'SESSION_START' AND session_id = 'sid:probe-68e-one';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 68e: two calls for one session left % rows, not 1', n;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE session_id = 'sid:probe-68e-one' AND tenant_id = '11111111-1111-1111-1111-111111111111'
     AND actor_id = md5('driver1')::uuid AND entity_type = 'app_user' AND entity_id = md5('driver1')::uuid
     AND before IS NULL AND after IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 68e: the session-start row does not name the tenant, the actor and the actor''s own row';
  END IF;
  PERFORM set_config('app.session_id', 'sid:probe-68e-two', true);
  PERFORM app.record_session_start();
  SELECT count(*) INTO n FROM app.audit_log
   WHERE action = 'SESSION_START' AND session_id IN ('sid:probe-68e-one', 'sid:probe-68e-two');
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 68e: a second session left % rows in all, not 2', n;
  END IF;

  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO n FROM app.audit_log
   WHERE session_id IN ('sid:probe-68e-one', 'sid:probe-68e-two');
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 68e: Second Fleet sees % of BAC''s session starts', n;
  END IF;

  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.session_id', '', true);
  BEGIN
    PERFORM app.record_session_start();
  EXCEPTION WHEN raise_exception THEN err := SQLERRM;
  END;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 68e: a call with no session bound returned instead of raising';
  END IF;
  err := NULL;
  PERFORM set_config('app.session_id', 'sid:probe-68e-three', true);
  PERFORM set_config('app.actor_id', '', true);
  BEGIN
    PERFORM app.record_session_start();
  EXCEPTION WHEN raise_exception THEN err := SQLERRM;
  END;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 68e: a call with no actor bound returned instead of raising';
  END IF;
  -- With no tenant bound the function refuses (FR-AUD-004) instead of
  -- writing a row no tenant can read (ADR-0014).
  err := NULL;
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  PERFORM set_config('app.tenant_id', '', true);
  BEGIN
    PERFORM app.record_session_start();
  EXCEPTION WHEN raise_exception THEN err := SQLERRM;
  END;
  IF err IS NULL THEN
    RAISE EXCEPTION 'FAIL 68e: a call with no tenant bound wrote a session start';
  END IF;
  RAISE NOTICE 'PASS  68e one session-start row per session, visible only to its tenant, never unattributed';
END $$;
ROLLBACK;

\echo '== 69. TYRE-318: a receive names an active size and a new-tyre pattern, a new tread above the removal threshold, and a source for its price (FR-TYR-031, FR-CFG-004, FR-CFG-007, NFR-USE-006, U93)'

\echo '== 69a. every refusal is TY011 with its own message, and a deactivated row, a missing id and Second Fleet''s size, pattern and brand read alike (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        t2   constant uuid := '22222222-2222-2222-2222-222222222222';
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;      -- seeded NEW, brand br1
        br2  constant uuid := md5('t69br2')::uuid;   -- active, owns no pattern
        brx  constant uuid := md5('t69brx')::uuid;   -- deactivated
        szx  constant uuid := md5('t69szx')::uuid;   -- deactivated
        ptu  constant uuid := md5('t69ptu')::uuid;   -- NEW, no brand
        ptr  constant uuid := md5('t69ptr')::uuid;   -- RETREAD only
        ptx  constant uuid := md5('t69ptx')::uuid;   -- deactivated
        ptxb constant uuid := md5('t69ptxb')::uuid;  -- active, its brand deactivated
        t2pt constant uuid := md5('t69t2pt')::uuid;  -- Second Fleet's, receivable there
        t2sz constant uuid := md5('t69t2sz')::uuid;  -- Second Fleet's, active
        t2br constant uuid := md5('t69t2br')::uuid;  -- Second Fleet's, active
        thr numeric; c record; got text;
BEGIN
  -- Second Fleet's size, pattern and brand are active, and the pattern is
  -- NEW, so if RLS let BAC see one the receive would pass every check and
  -- fail on the composite foreign key (23503), not as TY011. Only
  -- invisibility gives the missing-id message.
  PERFORM set_config('app.tenant_id', t2::text, true);
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to)
  VALUES (t2pt, t2, 'T69 SECOND', 'NEW');
  INSERT INTO app.tyre_size (id, tenant_id, name) VALUES (t2sz, t2, 'T69 SECOND');
  INSERT INTO app.tyre_brand (id, tenant_id, name) VALUES (t2br, t2, 'T69 SECOND');

  PERFORM set_config('app.tenant_id', bac::text, true);
  thr := app.current_removal_threshold_mm();
  IF thr IS NULL THEN
    RAISE EXCEPTION 'FAIL 69a: BAC has no removal threshold in force, so the threshold refusal cannot be probed';
  END IF;
  INSERT INTO app.tyre_size (id, tenant_id, name, active) VALUES (szx, bac, 'T69 RETIRED', false);
  INSERT INTO app.tyre_brand (id, tenant_id, name, active) VALUES
    (br2, bac, 'T69 OTHER', true),
    (brx, bac, 'T69 RETIRED', false);
  INSERT INTO app.tyre_pattern (id, tenant_id, name, brand_id, applies_to, active) VALUES
    (ptu,  bac, 'T69 UNBRANDED', NULL, 'NEW',     true),
    (ptr,  bac, 'T69 RETREAD',   NULL, 'RETREAD', true),
    (ptx,  bac, 'T69 RETIRED',   NULL, 'NEW',     false),
    (ptxb, bac, 'T69 ORPHANED',  brx,  'NEW',     true);

  -- Each payload breaks exactly one rule, so each message names the rule
  -- that refused it.
  FOR c IN SELECT * FROM (VALUES
    ('no size',
     jsonb_build_object('pattern_id', pt1, 'new_tread_mm', '25.0'),
     'a received tyre needs its size; choose one from the catalogue'),
    ('no pattern',
     jsonb_build_object('size_id', sz1, 'new_tread_mm', '25.0'),
     'a received tyre needs its pattern; choose one from the catalogue'),
    ('no new tread',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1),
     'a received tyre needs its new tread depth in millimetres'),
    ('a new tread of zero',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '0'),
     format('a new tread is in millimetres, above 0 and at most %s; check the depth entered',
            app.max_tread_mm())),
    ('a new tread above the ceiling',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1,
                        'new_tread_mm', (app.max_tread_mm() + 0.1)::text),
     format('a new tread is in millimetres, above 0 and at most %s; check the depth entered',
            app.max_tread_mm())),
    ('a deactivated size',
     jsonb_build_object('size_id', szx, 'pattern_id', pt1, 'new_tread_mm', '25.0'),
     'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a size id nobody holds',
     jsonb_build_object('size_id', md5('t69nosuch')::uuid, 'pattern_id', pt1, 'new_tread_mm', '25.0'),
     'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('Second Fleet''s size',
     jsonb_build_object('size_id', t2sz, 'pattern_id', pt1, 'new_tread_mm', '25.0'),
     'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a deactivated pattern',
     jsonb_build_object('size_id', sz1, 'pattern_id', ptx, 'new_tread_mm', '25.0'),
     'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a pattern id nobody holds',
     jsonb_build_object('size_id', sz1, 'pattern_id', md5('t69nosuch')::uuid, 'new_tread_mm', '25.0'),
     'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('Second Fleet''s pattern',
     jsonb_build_object('size_id', sz1, 'pattern_id', t2pt, 'new_tread_mm', '25.0'),
     'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it'),
    ('a pattern whose brand is deactivated',
     jsonb_build_object('size_id', sz1, 'pattern_id', ptxb, 'new_tread_mm', '25.0'),
     'that pattern''s brand is not in this fleet''s active catalogue; choose another pattern, or ask an administrator to restore the brand'),
    ('a deactivated brand',
     jsonb_build_object('size_id', sz1, 'pattern_id', ptu, 'brand_id', brx, 'new_tread_mm', '25.0'),
     'that brand is not in this fleet''s active catalogue; choose another, leave it blank, or ask an administrator to add it'),
    -- Unbranded, so no brand-mismatch check stands between a leak and 23503.
    ('Second Fleet''s brand',
     jsonb_build_object('size_id', sz1, 'pattern_id', ptu, 'brand_id', t2br, 'new_tread_mm', '25.0'),
     'that brand is not in this fleet''s active catalogue; choose another, leave it blank, or ask an administrator to add it'),
    ('a retread-only pattern',
     jsonb_build_object('size_id', sz1, 'pattern_id', ptr, 'new_tread_mm', '25.0'),
     'that pattern is for retreads only; a received tyre takes a new-tyre pattern'),
    ('a brand the pattern does not belong to',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'brand_id', br2, 'new_tread_mm', '25.0'),
     'that pattern belongs to a different brand; choose its own brand or leave the brand blank'),
    ('a new tread at the removal threshold',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', thr::text),
     format('new tread must exceed the removal threshold of %s mm; check the depth entered', thr)),
    -- 0.1 mm of usable tread puts R10 000 000.00 at 10^8 a millimetre,
    -- past rand_per_mm's numeric(12,4), so the bound answers before a bare
    -- 22003 can (TYRE-421).
    ('a rate past what the register carries',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', (thr + 0.1)::text,
                        'purchase_price', '10000000.00', 'cost_source', 'INVOICE'),
     format('a purchase price of %s over %s mm of usable tread is a rate above what the register carries; check the price and the new tread entered',
            10000000.00::numeric(12,2), (thr + 0.1)::numeric(4,1) - thr)),
    ('a price with no source',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
                        'purchase_price', '4319.91'),
     'a purchase price needs a cost source; choose invoice or price list estimate'),
    ('a price with an UNKNOWN source',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
                        'purchase_price', '4319.91', 'cost_source', 'UNKNOWN'),
     'a purchase price needs a known cost source; choose invoice or price list estimate'),
    ('a source with no price',
     jsonb_build_object('size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
                        'cost_source', 'INVOICE'),
     'a cost source is recorded with its purchase price; enter the price, or leave the source out until it is known')
  ) AS v(label, payload, want)
  LOOP
    got := NULL;
    BEGIN
      PERFORM app.receive_tyres(c.payload);
    EXCEPTION WHEN sqlstate 'TY011' THEN got := SQLERRM;
    END;
    IF got IS DISTINCT FROM c.want THEN
      RAISE EXCEPTION 'FAIL 69a: % was answered %, not TY011 "%"',
        c.label, coalesce('TY011 "' || got || '"', 'by an accepted receive'), c.want;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  69a twenty-one incomplete receives refused, each with its own TY011 message; Second Fleet''s size, pattern and brand read as missing ones';
END $$;
ROLLBACK;

\echo '== 69b. a receive stores its entries, takes an omitted brand from its pattern, rates the tyre through app.rand_per_mm from its rounded price, and leaves an unpriced one UNKNOWN (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        br1 constant uuid := md5('br1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        br2 constant uuid := md5('t69br2')::uuid;
        ptu constant uuid := md5('t69ptu')::uuid;    -- NEW, no brand
        ptb constant uuid := md5('t69ptb')::uuid;    -- BOTH, no brand
        r record; t app.tyre;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  INSERT INTO app.tyre_brand (id, tenant_id, name) VALUES (br2, bac, 'T69 OTHER');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, brand_id, applies_to) VALUES
    (ptu, bac, 'T69 UNBRANDED', NULL, 'NEW'),
    (ptb, bac, 'T69 EITHER',    NULL, 'BOTH');

  -- NFR-USE-006: a branded pattern with its brand omitted stores the
  -- pattern's brand. 6969.69 is a price no fixture tyre carries, so 69c can
  -- find the row.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
    'purchase_price', '6969.69', 'cost_source', 'INVOICE'));
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.size_id IS DISTINCT FROM sz1 OR t.pattern_id IS DISTINCT FROM pt1
     OR t.brand_id IS DISTINCT FROM br1 THEN
    RAISE EXCEPTION 'FAIL 69b: stored size %, pattern %, brand %; the brand should be the pattern''s own',
      t.size_id, t.pattern_id, t.brand_id;
  END IF;
  IF t.cost_source <> 'INVOICE' OR t.new_tread_mm <> 25.0 OR t.rand_per_mm IS NULL
     OR t.rand_per_mm IS DISTINCT FROM
        app.rand_per_mm(6969.69, 25.0, app.current_removal_threshold_mm()) THEN
    RAISE EXCEPTION 'FAIL 69b: a priced receive stored rate % from source %', t.rand_per_mm, t.cost_source;
  END IF;

  -- The pattern's own brand sent explicitly is accepted.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'brand_id', br1, 'new_tread_mm', '25.0',
    'purchase_price', '6969.69', 'cost_source', 'INVOICE'));
  IF (SELECT brand_id FROM app.tyre WHERE id = r.tyre_id) IS DISTINCT FROM br1 THEN
    RAISE EXCEPTION 'FAIL 69b: the pattern''s own brand, sent, was not stored';
  END IF;

  -- A pattern with no brand keeps the brand sent.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', ptu, 'brand_id', br2, 'new_tread_mm', '25.0'));
  IF (SELECT brand_id FROM app.tyre WHERE id = r.tyre_id) IS DISTINCT FROM br2 THEN
    RAISE EXCEPTION 'FAIL 69b: an unbranded pattern did not keep the brand sent';
  END IF;

  -- A BOTH pattern is receivable; no brand stays NULL (NFR-PRO-002); an
  -- unpriced receive is UNKNOWN, unrated and awaiting cost (FR-TYR-041).
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', ptb, 'new_tread_mm', '25.0'));
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.brand_id IS NOT NULL OR t.cost_source <> 'UNKNOWN' OR t.purchase_price IS NOT NULL
     OR t.rand_per_mm IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 69b: an unpriced receive stored brand %, source %, price %, rate %',
      t.brand_id, t.cost_source, t.purchase_price, t.rand_per_mm;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = t.id) THEN
    RAISE EXCEPTION 'FAIL 69b: an unpriced receive is not awaiting cost';
  END IF;

  -- U128's control: UNKNOWN sent explicitly with no price is the one
  -- combination that means "no price yet", so it is accepted. Without this,
  -- 69a's "a source with no price" row could pass by refusing every source.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', ptb, 'new_tread_mm', '25.0', 'cost_source', 'UNKNOWN'));
  IF (SELECT cost_source FROM app.tyre WHERE id = r.tyre_id) <> 'UNKNOWN' THEN
    RAISE EXCEPTION 'FAIL 69b: an unpriced receive naming UNKNOWN did not store UNKNOWN';
  END IF;

  -- FR-VAL-006 on the receive path: a third decimal is rounded into the
  -- price column before app.rand_per_mm divides, so the stored rate
  -- reproduces from the stored price. A 2dp price cannot fail this. The
  -- rounding is the same whatever the source, and an estimate must equal
  -- the price list's figure (75g), so this is an invoice price.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', ptu, 'new_tread_mm', '25.0',
    'purchase_price', '6969.695', 'cost_source', 'INVOICE'));
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price <> 6969.70
     OR t.rand_per_mm IS DISTINCT FROM
        app.rand_per_mm(t.purchase_price, t.new_tread_mm, app.current_removal_threshold_mm()) THEN
    RAISE EXCEPTION 'FAIL 69b: stored price % and rate %, which do not reproduce', t.purchase_price, t.rand_per_mm;
  END IF;

  -- The rate bound's control: a rate just under 10^8 fits numeric(12,4)
  -- and is stored, so 69a's rate row could not pass by refusing every
  -- large price.
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', ptu,
    'new_tread_mm', (app.current_removal_threshold_mm() + 0.1)::text,
    'purchase_price', '9999999.99', 'cost_source', 'INVOICE'));
  IF (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id) IS DISTINCT FROM 99999999.9000 THEN
    RAISE EXCEPTION 'FAIL 69b: a rate just under the bound stored %, not 99999999.9000',
      (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id);
  END IF;
  RAISE NOTICE 'PASS  69b entries stored, the pattern''s brand taken when omitted, the rate reproducible from the rounded price, a rate just under the bound stored, an unpriced receive UNKNOWN whether named or omitted';
END $$;
ROLLBACK;

\echo '== 69c. nothing 69a and 69b planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT (SELECT count(*) FROM app.tyre_size WHERE id = md5('t69szx')::uuid)
       + (SELECT count(*) FROM app.tyre_brand WHERE id IN (md5('t69br2')::uuid, md5('t69brx')::uuid))
       + (SELECT count(*) FROM app.tyre_pattern
           WHERE id IN (md5('t69ptu')::uuid, md5('t69ptr')::uuid, md5('t69ptx')::uuid,
                        md5('t69ptxb')::uuid, md5('t69ptb')::uuid))
       + (SELECT count(*) FROM app.tyre
           WHERE purchase_price IN (6969.69, 6969.70)
              OR pattern_id IN (md5('t69ptu')::uuid, md5('t69ptb')::uuid))
    INTO n;
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  n := n + (SELECT count(*) FROM app.tyre_pattern WHERE id = md5('t69t2pt')::uuid)
         + (SELECT count(*) FROM app.tyre_size WHERE id = md5('t69t2sz')::uuid)
         + (SELECT count(*) FROM app.tyre_brand WHERE id = md5('t69t2br')::uuid);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 69c: % rows planted by section 69 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  69c section 69 leaves no residue';
END $$;

-- 69d, a receive with no removal threshold in force (U129, TYRE-421), is
-- db/tests/005_privileged.sql P4, for section 17's reason.

\echo '== 69e. set_tyre_cost refuses a price with UNKNOWN as TY013 and stores an INVOICE or PRICE_LIST_ESTIMATE cost with its rate (U128, TYRE-422; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        br1 constant uuid := md5('br1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        src app.cost_source; r record; t app.tyre; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);

  -- Each costed tyre is planted with no receipt, since a received one is
  -- priced on its receipt (000059), and carries what an unpriced receive of
  -- size, pattern and tread would store.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T69E-UNKNOWN', sz1, br1, pt1, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01')
  RETURNING id INTO r;
  got := NULL;
  BEGIN
    PERFORM app.set_tyre_cost(r.id, 4319.91, 'UNKNOWN');
  EXCEPTION WHEN sqlstate 'TY013' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'a purchase price needs a known cost source; choose invoice or price list estimate' THEN
    RAISE EXCEPTION 'FAIL 69e: a price with UNKNOWN was answered %, not TY013 with receipt''s message',
      coalesce('TY013 "' || got || '"', 'by a stored cost');
  END IF;
  SELECT * INTO t FROM app.tyre WHERE id = r.id;
  IF t.purchase_price IS NOT NULL OR t.rand_per_mm IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 69e: a refused cost stored price % and rate %', t.purchase_price, t.rand_per_mm;
  END IF;

  -- The refusal's controls: each known source is stored with its price
  -- and rated, so the row above could not pass by refusing every cost.
  FOREACH src IN ARRAY ARRAY['INVOICE', 'PRICE_LIST_ESTIMATE']::app.cost_source[] LOOP
    INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                          new_tread_mm, state, received_date)
    VALUES (app.current_tenant_id(), 'T69E-' || src, sz1, br1, pt1, 'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01')
    RETURNING id INTO r;
    PERFORM app.set_tyre_cost(r.id, 4319.91, src);
    SELECT * INTO t FROM app.tyre WHERE id = r.id;
    IF t.purchase_price IS DISTINCT FROM 4319.91 OR t.cost_source IS DISTINCT FROM src
       OR t.rand_per_mm IS DISTINCT FROM
          app.rand_per_mm(4319.91, 25.0, app.current_removal_threshold_mm()) THEN
      RAISE EXCEPTION 'FAIL 69e: a % cost stored price %, source %, rate %',
        src, t.purchase_price, t.cost_source, t.rand_per_mm;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  69e set_tyre_cost refuses a price with UNKNOWN as TY013 and stores INVOICE and PRICE_LIST_ESTIMATE costs with their rate';
END $$;
ROLLBACK;

\echo '== 69f. costing a retreaded tyre stores its price and keeps the rate its retread cost gives (FR-TYR-019, BR-VAL-006; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        d_rt constant uuid := md5('t69frt')::uuid;
        j    constant uuid := md5('t69fj')::uuid;
        tz text; r record; t app.tyre; want numeric;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT x.timezone INTO tz FROM app.tenant x WHERE x.id = bac;

  -- Planted with no receipt, since a received tyre is priced on its
  -- receipt (000059), and dated ten days back so the dated send and return
  -- follow it.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T69F-1', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 25.0, 'IN_STOCK',
          app.tenant_today(tz) - 10)
  RETURNING id AS tyre_id INTO r;
  -- A dispatch is from REMOVED only, so the casing and a raw job are
  -- planted at the retreader, 63b's way.
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'T69F Retreaders', 'RETREADER');
  UPDATE app.tyre SET state = 'AT_RETREADER' WHERE id = r.tyre_id;
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at)
  VALUES (j, bac, r.tyre_id, d_rt, app.tenant_today(tz) - 5);
  PERFORM app.log_retread_return(j, app.tenant_today(tz) - 1, true, 'T69F-RPT', 2500.00, 16.0, 800.00);
  want := app.rand_per_mm(2500.00, 16.0, app.current_removal_threshold_mm());
  IF (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id) IS DISTINCT FROM want OR want IS NULL THEN
    RAISE EXCEPTION 'FAIL 69f: the return stored rate %, not the retread''s %',
      (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id), want;
  END IF;

  PERFORM app.set_tyre_cost(r.tyre_id, 4319.91, 'INVOICE');
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS DISTINCT FROM 4319.91 OR t.cost_source IS DISTINCT FROM 'INVOICE' THEN
    RAISE EXCEPTION 'FAIL 69f: costing a retreaded tyre stored price % from source %',
      t.purchase_price, t.cost_source;
  END IF;
  IF t.rand_per_mm IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 69f: costing a retreaded tyre replaced its retread rate % with %',
      want, t.rand_per_mm;
  END IF;
  RAISE NOTICE 'PASS  69f costing a retreaded tyre stores its price and keeps its retread rate %', want;
END $$;
ROLLBACK;

\echo '== 69g. set_tyre_cost refuses as TY013 a cost it cannot rate, and the tyre stays awaiting cost (U129, FR-VAL-006; as BAC, rolled back)'
-- With no threshold in force, the refusal and the retreaded tyre it does not
-- block are db/tests/005_privileged.sql P5, for section 17's reason.
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        pol  constant uuid := md5('t69gpol')::uuid;
        thr numeric; r record; t app.tyre; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  thr := app.current_removal_threshold_mm();

  -- 0.1 mm of usable tread puts R10 000 000.00 at 10^8 a millimetre, past
  -- rand_per_mm's numeric(12,4), so the bound answers before a bare 22003.
  -- Each tyre here is planted with no receipt, since a received one is
  -- priced on its receipt (000059).
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T69G-BOUND', sz1, md5('br1')::uuid, pt1, 'NEW', 0, thr + 0.1,
          'IN_STOCK', '2026-10-01')
  RETURNING id AS tyre_id INTO r;
  got := NULL;
  BEGIN
    PERFORM app.set_tyre_cost(r.tyre_id, 10000000.00, 'INVOICE');
  EXCEPTION WHEN sqlstate 'TY013' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM format('a purchase price of %s over %s mm of usable tread is a rate above what the register carries; check the price entered',
                                 10000000.00::numeric(12,2), (thr + 0.1)::numeric(4,1) - thr) THEN
    RAISE EXCEPTION 'FAIL 69g: a rate past the register was answered %',
      coalesce('TY013 "' || got || '"', 'by a stored cost');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = r.tyre_id) THEN
    RAISE EXCEPTION 'FAIL 69g: a tyre refused a rate past the register is no longer awaiting cost';
  END IF;
  -- The bound's control: a rate just under 10^8 is stored, so the row
  -- above could not pass by refusing every large price.
  PERFORM app.set_tyre_cost(r.tyre_id, 9999999.99, 'INVOICE');
  IF (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id) IS DISTINCT FROM 99999999.9000 THEN
    RAISE EXCEPTION 'FAIL 69g: a rate just under the bound stored %, not 99999999.9000',
      (SELECT rand_per_mm FROM app.tyre WHERE id = r.tyre_id);
  END IF;

  -- A tread received above one threshold sits at the next one: 6.0 mm
  -- clears the seeded 4.0 and equals the 6.0 planted after it, the
  -- boundary BR-VAL-002 cannot rate.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T69G-AT-THR', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 6.0,
          'IN_STOCK', '2026-10-01')
  RETURNING id AS tyre_id INTO r;
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm,
                                    warning_threshold_mm, max_retreads, effective_from)
  VALUES (pol, bac, 6.0, 8.0, 2, now());
  got := NULL;
  BEGIN
    PERFORM app.set_tyre_cost(r.tyre_id, 4319.91, 'INVOICE');
  EXCEPTION WHEN sqlstate 'TY013' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'this tyre''s new tread of 6.0 mm does not exceed the removal threshold of 6.0 mm, so its cost cannot be rated; check the removal threshold configured' THEN
    RAISE EXCEPTION 'FAIL 69g: a new tread at the threshold in force was answered %',
      coalesce('TY013 "' || got || '"', 'by a stored cost');
  END IF;
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS NOT NULL OR t.rand_per_mm IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = t.id) THEN
    RAISE EXCEPTION 'FAIL 69g: a tyre refused at the threshold stored price %, rate % or left the backlog',
      t.purchase_price, t.rand_per_mm;
  END IF;

  -- receive_tyres refuses a missing new tread (U93), so the tyre is
  -- planted without one, a tyre app.rand_per_mm cannot rate.
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T69G-NO-TREAD', sz1, md5('br1')::uuid, pt1, 'NEW', 0, NULL,
          'IN_STOCK', '2026-10-01')
  RETURNING id AS tyre_id INTO r;
  got := NULL;
  BEGIN
    PERFORM app.set_tyre_cost(r.tyre_id, 4319.91, 'INVOICE');
  EXCEPTION WHEN sqlstate 'TY013' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM 'this tyre has no new tread recorded, so its cost cannot be rated; leave it awaiting its cost until its new tread is recorded' THEN
    RAISE EXCEPTION 'FAIL 69g: a tyre with no new tread was answered %',
      coalesce('TY013 "' || got || '"', 'by a stored cost');
  END IF;
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS NOT NULL OR t.rand_per_mm IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM app.v_tyre_awaiting_cost WHERE tyre_id = t.id) THEN
    RAISE EXCEPTION 'FAIL 69g: a tyre refused for no new tread stored price %, rate % or left the backlog',
      t.purchase_price, t.rand_per_mm;
  END IF;

  RAISE NOTICE 'PASS  69g a rate past the register, a tread at the threshold and no new tread each refused as TY013, the tyre still awaiting cost; a rate under the bound stored';
END $$;
ROLLBACK;

\echo '== 70. TYRE-299: a threshold policy row is written once, one per scope and instant, and never back-dated (U68, U69, U70, FR-CFG-051, FR-VAL-020)'

\echo '== 70a. the app role cannot UPDATE a policy row, and the written-once trigger stands behind the grant (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        base constant uuid := md5('11111111-1111-1111-1111-111111111111thrpol-default')::uuid;
        def text; refused boolean := false;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- The row is visible, so the refusal below is the grant and not RLS
  -- finding nothing to update.
  IF NOT EXISTS (SELECT 1 FROM app.threshold_policy WHERE id = base) THEN
    RAISE EXCEPTION 'FAIL 70a: BAC''s baseline is not visible, so the UPDATE below proves nothing';
  END IF;
  BEGIN
    UPDATE app.threshold_policy SET max_retreads = max_retreads WHERE id = base;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'permission denied for table threshold_policy' THEN
      RAISE EXCEPTION 'FAIL 70a: the UPDATE was refused for another reason: %', SQLERRM;
    END IF;
    refused := true;
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'FAIL 70a: the app role edited a policy row';
  END IF;
  -- The trigger binds the owner and a superuser, which no grant does;
  -- db/tests/005_privileged.sql P7 stages that half.
  SELECT pg_get_triggerdef(t.oid) INTO def FROM pg_trigger t
   WHERE t.tgrelid = 'app.threshold_policy'::regclass
     AND t.tgname = 'threshold_policy_written_once' AND t.tgenabled = 'O';
  IF def IS NULL OR def NOT LIKE '%BEFORE UPDATE ON % FOR EACH ROW EXECUTE FUNCTION %threshold_policy_is_written_once()' THEN
    RAISE EXCEPTION 'FAIL 70a: the written-once trigger reads as [%]', COALESCE(def, 'absent');
  END IF;
  RAISE NOTICE 'PASS  70a an UPDATE is refused for privilege, and threshold_policy_written_once stands behind the grant';
END $$;
ROLLBACK;

\echo '== 70b. two rows in one scope at one instant are refused, the tenant-wide scope included, and the same instant in another scope is not (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        inst constant timestamptz := now() + interval '1 day';
        def text; cname text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- NULLS NOT DISTINCT: the tenant-wide scope is a NULL group and a NULL
  -- class, which a plain UNIQUE would let tie.
  SELECT pg_get_constraintdef(k.oid) INTO def FROM pg_constraint k
   WHERE k.conrelid = 'app.threshold_policy'::regclass
     AND k.conname = 'threshold_policy_one_row_per_instant';
  IF def IS DISTINCT FROM 'UNIQUE NULLS NOT DISTINCT (tenant_id, operating_group_id, axle_class, effective_from)' THEN
    RAISE EXCEPTION 'FAIL 70b: the one-row-per-instant constraint reads as [%]', COALESCE(def, 'absent');
  END IF;
  -- TYRE-310's tie: 5.0 at cap 3 and 7.0 at cap 1, one scope, one instant.
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t70b1')::uuid, bac, 5.0, 3, inst);
  cname := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, max_retreads, effective_from)
    VALUES (md5('t70b2')::uuid, bac, 7.0, 1, inst);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
  END;
  IF cname IS DISTINCT FROM 'threshold_policy_one_row_per_instant' THEN
    RAISE EXCEPTION 'FAIL 70b: a second tenant-wide row at one instant was answered by %', COALESCE(cname, 'an accepted row');
  END IF;
  -- The control: another scope at the same instant is a different row, and
  -- the tie's survivor is the row in force there.
  INSERT INTO app.threshold_policy (id, tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t70b3')::uuid, bac, 'DRIVE', 7.0, 1, inst);
  IF (app.threshold_policy_for(bac, NULL, NULL, inst + interval '1 microsecond')).id IS DISTINCT FROM md5('t70b1')::uuid THEN
    RAISE EXCEPTION 'FAIL 70b: the tenant-wide row at % is not the one in force there', inst;
  END IF;
  RAISE NOTICE 'PASS  70b one row per scope and instant, the NULL scope included; another class at the same instant is accepted';
END $$;
ROLLBACK;

\echo '== 70c. a row dated before now() is refused as TY023 unless it is an empty scope''s first row at -infinity; now() and later are accepted; another tenant''s -infinity row is refused by RLS (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        m2  constant text := 'a threshold policy row takes effect when it is written or later, never earlier (FR-CFG-051)';
        m3  constant text := 'this scope already has a threshold policy; only its first row may be the -infinity baseline (SRS 5.1, errata E1)';
        m4  constant text := '42501 new row violates row-level security policy for table "threshold_policy"';
        c app.axle_class; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  -- One microsecond before the transaction's now(), in the seeded
  -- tenant-wide scope and in DRIVE, which is empty: -infinity is the only
  -- past instant the exemption covers, whatever the scope holds.
  FOR c IN SELECT v.c FROM (VALUES (NULL::app.axle_class), ('DRIVE')) v(c) LOOP
    got := NULL;
    BEGIN
      INSERT INTO app.threshold_policy (tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from)
      VALUES (bac, c, 6.0, 2, now() - interval '1 microsecond');
    EXCEPTION WHEN sqlstate 'TY023' THEN got := SQLERRM;
    END;
    IF got IS DISTINCT FROM m2 THEN
      RAISE EXCEPTION 'FAIL 70c: a row a microsecond in the past, class %, was answered %',
        COALESCE(c::text, 'none'), COALESCE('TY023 "' || got || '"', 'by an accepted row');
    END IF;
  END LOOP;

  -- The controls: DEFAULT now() and a later instant are accepted.
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, max_retreads)
  VALUES (md5('t70c1')::uuid, bac, 6.0, 2);
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t70c2')::uuid, bac, 6.5, 2, now() + interval '1 hour');

  -- -infinity where the scope has a row: BAC's tenant-wide baseline.
  got := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, max_retreads, effective_from)
    VALUES (bac, 6.0, 2, '-infinity');
  EXCEPTION WHEN sqlstate 'TY023' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM m3 THEN
    RAISE EXCEPTION 'FAIL 70c: a second tenant-wide baseline was answered %',
      COALESCE('TY023 "' || got || '"', 'by an accepted row');
  END IF;

  -- An empty scope's first row at -infinity is accepted, once: the next
  -- statement's trigger sees it.
  INSERT INTO app.threshold_policy (id, tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t70c3')::uuid, bac, 'DRIVE', 4.0, 2, '-infinity');
  got := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from)
    VALUES (bac, 'DRIVE', 4.0, 2, '-infinity');
  EXCEPTION WHEN sqlstate 'TY023' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM m3 THEN
    RAISE EXCEPTION 'FAIL 70c: a second DRIVE baseline was answered %',
      COALESCE('TY023 "' || got || '"', 'by an accepted row');
  END IF;

  -- Two baselines for one empty scope in one statement: a row-level BEFORE
  -- trigger sees the rows its statement already wrote, so the second is
  -- refused the same way.
  got := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from)
    VALUES (bac, 'TRAILER', 4.0, 2, '-infinity'), (bac, 'TRAILER', 4.0, 2, '-infinity');
  EXCEPTION WHEN sqlstate 'TY023' THEN got := SQLERRM;
  END;
  IF got IS DISTINCT FROM m3 THEN
    RAISE EXCEPTION 'FAIL 70c: two TRAILER baselines in one statement were answered %',
      COALESCE('TY023 "' || got || '"', 'by accepted rows');
  END IF;

  -- BAC writes a -infinity row for Second Fleet's tenant-wide scope, which
  -- has its baseline. The trigger cannot see that row under RLS and passes,
  -- so WITH CHECK is what refuses it. TY023 here would mean the trigger read
  -- another tenant's rows.
  PERFORM set_config('app.tenant_id', t2::text, true);
  IF NOT EXISTS (SELECT 1 FROM app.threshold_policy
                  WHERE tenant_id = t2 AND operating_group_id IS NULL
                    AND axle_class IS NULL AND effective_from = '-infinity') THEN
    RAISE EXCEPTION 'FAIL 70c: Second Fleet has no tenant-wide baseline, so the probe below proves nothing';
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);
  got := NULL;
  BEGIN
    INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, max_retreads, effective_from)
    VALUES (t2, 4.0, 2, '-infinity');
  EXCEPTION WHEN OTHERS THEN got := SQLSTATE || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM m4 THEN
    RAISE EXCEPTION 'FAIL 70c: BAC''s -infinity row for Second Fleet was answered %',
      COALESCE(got, 'by an accepted row');
  END IF;
  RAISE NOTICE 'PASS  70c a past instant is refused in a seeded scope and an empty one; now() and later are accepted; -infinity is accepted once per empty scope, across two statements or within one; another tenant''s -infinity row is refused by WITH CHECK';
END $$;
ROLLBACK;

\echo '== 70d. the scrap and insurance columns are gone, the threshold and cap carry no default, and a warning sits above the retread threshold (U68, TYRE-189 F5, S1; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        cols text; defs text; def text; cname text; col text; w numeric;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT string_agg(a.attname, ', ' ORDER BY a.attname) INTO cols
    FROM pg_attribute a
   WHERE a.attrelid = 'app.threshold_policy'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname IN ('scrap_threshold_mm', 'insurance_minimum_mm', 'insurance_note');
  IF cols IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 70d: app.threshold_policy still carries %', cols;
  END IF;
  -- effective_from keeps DEFAULT now(), a date and not a threshold, and
  -- retreads_permitted its true, which F5 did not name.
  SELECT string_agg(c.column_name || '=' || COALESCE(c.column_default, 'none') || '/' || c.is_nullable,
                    ', ' ORDER BY c.column_name) INTO defs
    FROM information_schema.columns c
   WHERE c.table_schema = 'app' AND c.table_name = 'threshold_policy'
     AND c.column_name IN ('effective_from', 'max_retreads', 'retread_threshold_mm', 'retreads_permitted');
  IF defs IS DISTINCT FROM 'effective_from=now()/NO, max_retreads=none/NO, retread_threshold_mm=none/NO, retreads_permitted=true/NO' THEN
    RAISE EXCEPTION 'FAIL 70d: the defaults read as [%]', defs;
  END IF;
  -- Omitting either is a NOT NULL refusal naming the column, never a default.
  FOREACH col IN ARRAY ARRAY['retread_threshold_mm', 'max_retreads'] LOOP
    cname := NULL;
    BEGIN
      IF col = 'retread_threshold_mm' THEN
        INSERT INTO app.threshold_policy (tenant_id, max_retreads, effective_from)
        VALUES (bac, 2, now() + interval '1 hour');
      ELSE
        INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, effective_from)
        VALUES (bac, 4.0, now() + interval '1 hour');
      END IF;
    EXCEPTION WHEN not_null_violation THEN
      GET STACKED DIAGNOSTICS cname = COLUMN_NAME;
    END;
    IF cname IS DISTINCT FROM col THEN
      RAISE EXCEPTION 'FAIL 70d: a row omitting % was answered by %', col,
        COALESCE('a NOT NULL refusal of ' || cname, 'an accepted row');
    END IF;
  END LOOP;

  SELECT pg_get_constraintdef(k.oid) INTO def FROM pg_constraint k
   WHERE k.conrelid = 'app.threshold_policy'::regclass AND k.conname = 'warning_above_retread';
  IF def IS DISTINCT FROM 'CHECK ((warning_threshold_mm > retread_threshold_mm))' THEN
    RAISE EXCEPTION 'FAIL 70d: warning_above_retread reads as [%]', COALESCE(def, 'absent');
  END IF;
  -- The controls: no warning, and a warning a tenth above, are accepted.
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads, effective_from)
  VALUES (md5('t70d1')::uuid, bac, 6.0, NULL, 2, now() + interval '2 hours'),
         (md5('t70d2')::uuid, bac, 6.0, 6.1,  2, now() + interval '3 hours');
  -- At the retread threshold and below it, the band is empty.
  FOREACH w IN ARRAY ARRAY[6.0, 5.9]::numeric[] LOOP
    cname := NULL;
    BEGIN
      INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads, effective_from)
      VALUES (bac, 6.0, w, 2, now() + interval '4 hours');
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS cname = CONSTRAINT_NAME;
    END;
    IF cname IS DISTINCT FROM 'warning_above_retread' THEN
      RAISE EXCEPTION 'FAIL 70d: a warning of % over a 6.0 retread threshold was answered by %', w,
        COALESCE(cname, 'an accepted row');
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  70d three columns gone; threshold and cap carry no default; a warning at or below the retread threshold is refused, a NULL or higher one accepted';
END $$;
ROLLBACK;

\echo '== 70e. a back-dated retread return is priced and capped by the policy of its own day, and a return dated today by the policy in force now (U70 item 1, TYRE-310, FR-VAL-020, BR-FIT-009; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac   constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1   constant uuid := md5('sz1')::uuid;
        pt1   constant uuid := md5('pt1')::uuid;
        d_rt  constant uuid := md5('t70ert')::uuid;
        tpast constant uuid := md5('t70etpast')::uuid;  -- retreaded once, returned five days back
        tnow  constant uuid := md5('t70etnow')::uuid;   -- new, returned today
        tcap  constant uuid := md5('t70etcap')::uuid;   -- retreaded once, returned today
        jpast constant uuid := md5('t70ejpast')::uuid;
        jnow  constant uuid := md5('t70ejnow')::uuid;
        jcap  constant uuid := md5('t70ejcap')::uuid;
        tz text; rate numeric; n int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'T70E Retreaders', 'RETREADER');
  -- Raw tyres and jobs, 63b's way: no to_state event, so the return's
  -- last-movement guard is silent and the policy is what decides.
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status,
                        retread_count, state) VALUES
    (tpast, bac, 'T70TYREP', sz1, pt1, 'RETREAD', 1, 'AT_RETREADER'),
    (tnow,  bac, 'T70TYREN', sz1, pt1, 'NEW',     0, 'AT_RETREADER'),
    (tcap,  bac, 'T70TYREC', sz1, pt1, 'RETREAD', 1, 'AT_RETREADER');
  INSERT INTO app.retread_job (id, tenant_id, tyre_id, retreader_depot_id, sent_at) VALUES
    (jpast, bac, tpast, d_rt, app.tenant_today(tz) - 6),
    (jnow,  bac, tnow,  d_rt, app.tenant_today(tz) - 6),
    (jcap,  bac, tcap,  d_rt, app.tenant_today(tz) - 6);
  -- Over the seeded 4.0 at cap 2, a 6.0 at cap 1 from now().
  INSERT INTO app.threshold_policy (id, tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads)
  VALUES (md5('t70epol')::uuid, bac, 6.0, 8.0, 1);

  -- Five tenant days back the baseline governs both figures: 2500.00 over
  -- 16.0 - 4.0 mm, and a casing retreaded once is under its cap of 2.
  BEGIN
    PERFORM app.log_retread_return(jpast, app.tenant_today(tz) - 5, true, 'T70-RPT-P', 2500.00, 16.0, 800.00);
  EXCEPTION WHEN sqlstate 'TY015' THEN
    RAISE EXCEPTION 'FAIL 70e: a return five days back was capped by the row written now: %', SQLERRM;
  END;
  SELECT t.rand_per_mm, t.retread_count INTO rate, n FROM app.tyre t WHERE t.id = tpast;
  IF rate IS DISTINCT FROM 208.3333 OR rate IS DISTINCT FROM app.rand_per_mm(2500.00, 16.0, 4.0)
     OR n IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'FAIL 70e: a return five days back stored % at retread count %, expected 208.3333 (the 4.0 baseline) at 2',
      rate, n;
  END IF;

  -- Today the row written now governs both: 2500.00 over 16.0 - 6.0 mm, and
  -- a casing retreaded once is at its cap of 1.
  PERFORM app.log_retread_return(jnow, app.tenant_today(tz), true, 'T70-RPT-N', 2500.00, 16.0, 800.00);
  SELECT t.rand_per_mm INTO rate FROM app.tyre t WHERE t.id = tnow;
  IF rate IS DISTINCT FROM 250.0000 OR rate IS DISTINCT FROM app.rand_per_mm(2500.00, 16.0, 6.0) THEN
    RAISE EXCEPTION 'FAIL 70e: a return today stored %, expected 250.0000 (the 6.0 row in force now)', rate;
  END IF;
  got := NULL;
  BEGIN
    PERFORM app.log_retread_return(jcap, app.tenant_today(tz), true, 'T70-RPT-C', 2500.00, 16.0, 800.00);
  EXCEPTION WHEN sqlstate 'TY015' THEN got := SQLERRM;
  END;
  IF got IS NULL OR got NOT LIKE '%at a cap of 1;%' THEN
    RAISE EXCEPTION 'FAIL 70e: a casing retreaded once, returned today, was answered %',
      COALESCE('TY015 "' || got || '"', 'by an accepted return');
  END IF;
  RAISE NOTICE 'PASS  70e five days back the baseline prices 208.3333 and caps at 2; today the row written now prices 250.0000 and caps at 1';
END $$;
ROLLBACK;

\echo '== 70f. nothing section 70 planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  IF (SELECT count(*) FROM app.threshold_policy) <> 2 THEN
    RAISE EXCEPTION 'FAIL 70f: BAC holds % policy rows, not its two seeded baselines',
      (SELECT count(*) FROM app.threshold_policy);
  END IF;
  SELECT (SELECT count(*) FROM app.tyre WHERE display_code LIKE 'T70TYRE%')
       + (SELECT count(*) FROM app.depot WHERE id = md5('t70ert')::uuid)
       + (SELECT count(*) FROM app.retread_job
           WHERE id IN (md5('t70ejpast')::uuid, md5('t70ejnow')::uuid, md5('t70ejcap')::uuid))
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 70f: % rows planted by section 70 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  70f section 70 leaves no residue';
END $$;

\echo '== 71. TYRE-201: an audit row carries the bound client address and session, and an address that is not one is NULL, never a refusal (FR-AUD-002, FR-AUD-004, TYRE-383)'

\echo '== 71a. an audited insert and update record the address and the session bound for them, IPv4 and IPv6 (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        -- A seeded BAC user: app.vehicle.created_by defaults to the bound
        -- actor behind a composite FK, so an invented one would kill the
        -- plant and read as a fault in the trigger (lesson 2026-08-28).
        act constant uuid := md5('controller1')::uuid;
        veh constant uuid := md5('t71a')::uuid;
        cfg uuid; a app.audit_log;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'FAIL 71a: BAC''s veh1 is not visible, so the plant below proves nothing';
  END IF;
  PERFORM set_config('app.source_ip', '203.0.113.9', true);
  PERFORM set_config('app.session_id', 'sid:probe-71a', true);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (veh, bac, 'T71-A', 'T71A GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh AND al.action = 'INSERT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71a: the insert wrote no audit row';
  END IF;
  -- Against the literals bound above, with IS DISTINCT FROM: a NULL in either
  -- column fails instead of comparing as unknown, and reading the setting
  -- back would let two NULLs agree (lesson 2026-08-26).
  IF a.source_ip IS DISTINCT FROM '203.0.113.9'::inet
     OR a.session_id IS DISTINCT FROM 'sid:probe-71a' THEN
    RAISE EXCEPTION 'FAIL 71a: the insert''s audit row records address % and session %',
      a.source_ip, a.session_id;
  END IF;

  -- The registration changes, so the trigger's no-op skip cannot swallow
  -- the UPDATE row this reads.
  PERFORM set_config('app.source_ip', '2001:db8::1', true);
  PERFORM set_config('app.session_id', 'sid:probe-71a-two', true);
  UPDATE app.vehicle SET registration = 'T71A GP2' WHERE id = veh;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh AND al.action = 'UPDATE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71a: the update wrote no audit row';
  END IF;
  IF a.source_ip IS DISTINCT FROM '2001:db8::1'::inet
     OR a.session_id IS DISTINCT FROM 'sid:probe-71a-two' THEN
    RAISE EXCEPTION 'FAIL 71a: the update''s audit row records address % and session %',
      a.source_ip, a.session_id;
  END IF;
  RAISE NOTICE 'PASS  71a an audited insert and update record the bound address, IPv4 and IPv6, and the bound session';
END $$;
ROLLBACK;

\echo '== 71b. with neither bound, an audited write records no address and no session (as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        act constant uuid := md5('controller1')::uuid;
        veh constant uuid := md5('t71b')::uuid;
        cfg uuid; a app.audit_log;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  -- Empty, because a placeholder an earlier transaction set reads as '' once
  -- that transaction ends, which is what a pooled connection's next request
  -- sees when InActorTx binds neither.
  PERFORM set_config('app.source_ip', '', true);
  PERFORM set_config('app.session_id', '', true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'FAIL 71b: BAC''s veh1 is not visible, so the plant below proves nothing';
  END IF;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (veh, bac, 'T71-B', 'T71B GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh AND al.action = 'INSERT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71b: the insert wrote no audit row';
  END IF;
  IF a.source_ip IS NOT NULL OR a.session_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 71b: with nothing bound the row records address % and session %',
      a.source_ip, a.session_id;
  END IF;
  RAISE NOTICE 'PASS  71b with nothing bound the row records neither an address nor a session';
END $$;
ROLLBACK;

\echo '== 71c. an app.source_ip that is not an address, or carries a zone, lets the audited write through with a NULL address and the session still recorded (TYRE-383; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        act constant uuid := md5('controller1')::uuid;
        veh constant uuid := md5('t71c')::uuid;
        cfg uuid; a app.audit_log;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  PERFORM set_config('app.session_id', 'sid:probe-71c', true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'FAIL 71c: BAC''s veh1 is not visible, so the plant below proves nothing';
  END IF;
  PERFORM set_config('app.source_ip', 'not-an-ip', true);
  BEGIN
    INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                             unit_kind, home_depot_id, status)
    VALUES (veh, bac, 'T71-C', 'T71C GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'FAIL 71c: an address that is not one refused the insert: %', SQLERRM;
  END;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh AND al.action = 'INSERT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71c: the insert wrote no audit row';
  END IF;
  IF a.source_ip IS NOT NULL OR a.session_id IS DISTINCT FROM 'sid:probe-71c' THEN
    RAISE EXCEPTION 'FAIL 71c: with app.source_ip [not-an-ip] the row records address % and session %',
      a.source_ip, a.session_id;
  END IF;

  -- PostgreSQL 16 refuses a zone in an inet, so this is a bad address too.
  PERFORM set_config('app.source_ip', 'fe80::1%eth0', true);
  BEGIN
    UPDATE app.vehicle SET registration = 'T71C GP2' WHERE id = veh;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'FAIL 71c: an address with a zone refused the update: %', SQLERRM;
  END;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'vehicle' AND al.entity_id = veh AND al.action = 'UPDATE';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71c: the update wrote no audit row';
  END IF;
  IF a.source_ip IS NOT NULL OR a.session_id IS DISTINCT FROM 'sid:probe-71c' THEN
    RAISE EXCEPTION 'FAIL 71c: with app.source_ip [fe80::1%%eth0] the row records address % and session %',
      a.source_ip, a.session_id;
  END IF;
  RAISE NOTICE 'PASS  71c an address that is not one, or carries a zone, records NULL and refuses nothing; the session is still recorded';
END $$;
ROLLBACK;

\echo '== 71d. app.record_session_start() stores a session start with a NULL address for an app.source_ip that is not one, and the bound address for one that is (TYRE-383; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE v text; src inet;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, true);
  FOREACH v IN ARRAY ARRAY['not-an-ip', 'fe80::1%eth0'] LOOP
    PERFORM set_config('app.source_ip', v, true);
    PERFORM set_config('app.session_id', 'sid:probe-71d-' || v, true);
    BEGIN
      PERFORM app.record_session_start();
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'FAIL 71d: a session start with app.source_ip [%] raised instead of storing NULL: %',
        v, SQLERRM;
    END;
    IF NOT EXISTS (SELECT 1 FROM app.audit_log al
                    WHERE al.action = 'SESSION_START' AND al.session_id = 'sid:probe-71d-' || v
                      AND al.source_ip IS NULL) THEN
      RAISE EXCEPTION 'FAIL 71d: no session start with a NULL address for app.source_ip [%]', v;
    END IF;
  END LOOP;
  -- The control: an address that is one is stored, so the NULLs above are
  -- the helper turning a bad value away, not a writer ignoring the setting.
  PERFORM set_config('app.source_ip', '203.0.113.9', true);
  PERFORM set_config('app.session_id', 'sid:probe-71d-good', true);
  PERFORM app.record_session_start();
  SELECT al.source_ip INTO src FROM app.audit_log al
   WHERE al.action = 'SESSION_START' AND al.session_id = 'sid:probe-71d-good';
  IF src IS DISTINCT FROM '203.0.113.9'::inet THEN
    RAISE EXCEPTION 'FAIL 71d: a session start records address %, not the one bound', src;
  END IF;
  RAISE NOTICE 'PASS  71d a session start stores NULL for an address that is not one, without raising, and the address bound for one that is';
END $$;
ROLLBACK;

\echo '== 71e. app.current_source_ip() is STABLE, runs with invoker rights and is executable as app.current_actor_id() is'
DO $$
DECLARE r record;
BEGIN
  SELECT p.provolatile, p.prosecdef, p.proacl,
         (SELECT q.proacl FROM pg_proc q WHERE q.oid = 'app.current_actor_id()'::regprocedure) AS ref_acl
    INTO r
    FROM pg_proc p WHERE p.oid = to_regprocedure('app.current_source_ip()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 71e: app.current_source_ip() does not exist';
  END IF;
  IF r.provolatile IS DISTINCT FROM 's' OR r.prosecdef IS DISTINCT FROM false
     OR r.proacl IS DISTINCT FROM r.ref_acl THEN
    RAISE EXCEPTION 'FAIL 71e: the helper reads volatility %, definer %, acl %, against app.current_actor_id()''s acl %',
      r.provolatile, r.prosecdef, r.proacl, r.ref_acl;
  END IF;
  RAISE NOTICE 'PASS  71e app.current_source_ip() is STABLE, invoker and granted as app.current_actor_id() is';
END $$;

\echo '== 71f. nothing section 71 planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT (SELECT count(*) FROM app.vehicle WHERE fleet_number LIKE 'T71-%')
       + (SELECT count(*) FROM app.audit_log WHERE session_id LIKE 'sid:probe-71%')
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 71f: % rows planted by section 71 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  71f section 71 leaves no residue';
END $$;

\echo '== 72. TYRE-98: the audit trigger reaches every table the app writes in place, files the tag map under its unit, and stands aside only for a closed tenant (FR-AUD-001, ADR-0014, ADR-0013 decision 7)'
-- 72b and 72d read entries through this: exactly one for the entity and
-- action, under the tenant and actor passed in, returned for the caller's
-- field checks. Dropped at the end of 72f.
CREATE FUNCTION pg_temp.t72_one(p_type text, p_entity uuid, p_action text,
                                p_tenant uuid, p_actor uuid)
RETURNS app.audit_log
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE a app.audit_log; n int;
BEGIN
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = p_type AND al.entity_id = p_entity AND al.action = p_action;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72: % % entries for % %, not one', n, p_action, p_type, p_entity;
  END IF;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = p_type AND al.entity_id = p_entity AND al.action = p_action;
  -- Against the values passed, not the settings read back: two NULLs would
  -- agree (lesson 2026-08-26).
  IF a.tenant_id IS DISTINCT FROM p_tenant OR a.actor_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'FAIL 72: the % % entry for % landed under tenant % and actor %',
      p_action, p_type, p_entity, a.tenant_id, a.actor_id;
  END IF;
  RETURN a;
END $fn$;

\echo '== 72a. the twenty-three audited tables call app.audit_row_change() AFTER each row, DELETE and an argument on the tag map alone, and the function keeps invoker rights and its pinned search_path (ADR-0014, db/CLAUDE.md)'
DO $$
DECLARE r record; n int;
BEGIN
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE. 21 is
  -- AFTER INSERT OR UPDATE FOR EACH ROW; 29 adds DELETE.
  FOR r IN SELECT * FROM (VALUES
      ('app.tyre', 'tyre_audited', 21), ('app.fitment', 'fitment_audited', 21),
      ('app.retread_job', 'retread_job_audited', 21), ('app.app_user', 'app_user_audited', 21),
      ('app.vehicle_driver', 'vehicle_driver_audited', 21),
      ('app.threshold_policy', 'threshold_policy_audited', 21),
      ('app.configuration', 'configuration_audited', 21),
      ('app.vehicle_tag', 'vehicle_tag_audited', 21),
      ('app.vehicle_tag_map', 'vehicle_tag_map_audited', 29),
      ('app.vehicle', 'vehicle_audited', 21), ('app.combination', 'combination_audited', 21),
      ('app.combination_member', 'combination_member_audited', 21),
      ('app.inspection_task', 'inspection_task_audited', 21),
      ('app.inspection', 'inspection_audited', 21),
      ('app.composition_observation', 'composition_observation_audited', 21),
      ('app.tyre_size', 'tyre_size_audited', 21), ('app.tyre_brand', 'tyre_brand_audited', 21),
      ('app.tyre_pattern', 'tyre_pattern_audited', 21),
      ('app.casing_estimate_by_size', 'casing_estimate_by_size_audited', 21),
      ('app.tyre_price_list', 'tyre_price_list_audited', 21),
      ('app.tyre_receipt', 'tyre_receipt_audited', 21),
      ('app.trip', 'trip_audited', 21),
      ('app.inspection_task_nomination', 'inspection_task_nomination_audited', 21)
    ) v(tbl, tgname, tgtype)
  LOOP
    SELECT count(*) INTO n FROM pg_trigger t
     WHERE t.tgrelid = r.tbl::regclass AND t.tgname = r.tgname
       AND t.tgfoid = 'app.audit_row_change()'::regprocedure
       AND t.tgtype = r.tgtype AND t.tgenabled = 'O';
    IF n <> 1 THEN
      RAISE EXCEPTION 'FAIL 72a: % on % is missing, disabled, or not of tgtype % calling app.audit_row_change()',
        r.tgname, r.tbl, r.tgtype;
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgfoid = 'app.audit_row_change()'::regprocedure
     AND t.tgname <> 'vehicle_tag_map_audited'
     AND ((t.tgtype & 8) <> 0 OR t.tgnargs <> 0);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 72a: % audit triggers besides the tag map''s fire on DELETE or pass an argument', n;
  END IF;
  -- The argument as stored: the name, then a zero byte.
  SELECT count(*) INTO n FROM pg_trigger t
   WHERE t.tgrelid = 'app.vehicle_tag_map'::regclass AND t.tgname = 'vehicle_tag_map_audited'
     AND t.tgnargs = 1
     AND encode(t.tgargs, 'hex') = encode(convert_to('vehicle_id', 'UTF8'), 'hex') || '00';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72a: vehicle_tag_map_audited does not pass vehicle_id as its one argument';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p
   WHERE p.oid = 'app.audit_row_change()'::regprocedure
     AND NOT p.prosecdef
     AND coalesce(p.proconfig @> ARRAY['search_path=app, pg_temp'], false);
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72a: app.audit_row_change() lost its invoker rights or its pinned search_path';
  END IF;
  RAISE NOTICE 'PASS  72a twenty-three audit triggers, AFTER each row, DELETE and vehicle_id on the tag map alone; the function is invoker with its search_path pinned';
END $$;

\echo '== 72b. each of the nine tables files a real write through the path that writes it: action, entity, before and after, under the bound tenant and actor; a seeded row is filed with no actor (FR-AUD-001; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        -- A seeded BAC user: every created_by defaults to the bound actor
        -- behind a composite FK, so an invented one would kill a plant and
        -- read as a fault in the trigger (lesson 2026-08-28).
        act  constant uuid := md5('controller1')::uuid;
        drv  constant uuid := md5('driver1')::uuid;
        vu   constant uuid := md5('t72b-unit')::uuid;  -- TRAILER: owes no fitment odometer (TY009)
        tb   constant uuid := md5('t72b-tyre-fit')::uuid;
        tc   constant uuid := md5('t72b-tyre-retread')::uuid;
        d_rt constant uuid := md5('t72b-retreader')::uuid;
        tp   constant uuid := md5('t72b-policy')::uuid;
        cf   constant uuid := md5('t72b-config')::uuid;
        sz1  constant uuid := md5('sz1')::uuid;
        pt1  constant uuid := md5('pt1')::uuid;
        tag_names constant text[] := ARRAY['T72B Tag'];
        cfg uuid; pos uuid; tz text; ta uuid; fit uuid; job uuid; usr uuid; vd uuid;
        tg uuid; tg_again uuid; a app.audit_log; n int; tcost uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  SELECT p.id INTO pos FROM app.position p WHERE p.configuration_id = cfg AND p.code = '1';
  IF tz IS NULL OR cfg IS NULL OR pos IS NULL THEN
    RAISE EXCEPTION 'FAIL 72b: BAC''s timezone or veh1''s configuration is not visible, so the plants below prove nothing';
  END IF;
  -- The seed fills every position on veh1, so the unit is planted on the
  -- same configuration to have an empty one (as section 43 does).
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (vu, bac, 'T72-B', 'T72B GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');

  -- tyre: app.receive_tyres inserts it, and app.set_tyre_cost updates one
  -- received before receipts existed, planted here with no receipt, since
  -- a received tyre is priced on its receipt (000059).
  SELECT r.tyre_id INTO ta FROM app.receive_tyres(jsonb_build_object(
    'size_id', sz1, 'pattern_id', pt1, 'new_tread_mm', '25.0',
    'received_date', '2026-08-25')) r;
  a := pg_temp.t72_one('tyre', ta, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'state' IS DISTINCT FROM 'IN_STOCK' THEN
    RAISE EXCEPTION 'FAIL 72b: the received tyre is filed with before % and state %', a.before, a.after->>'state';
  END IF;
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T72B-COST', sz1, md5('br1')::uuid, pt1, 'NEW', 0, 25.0, 'IN_STOCK', '2026-08-25')
  RETURNING id INTO tcost;
  PERFORM app.set_tyre_cost(tcost, 4319.91, 'INVOICE');
  a := pg_temp.t72_one('tyre', tcost, 'UPDATE', bac, act);
  IF a.before->>'purchase_price' IS NOT NULL
     OR a.after->>'purchase_price' IS DISTINCT FROM '4319.91' THEN
    RAISE EXCEPTION 'FAIL 72b: the costing is filed as % to %', a.before->>'purchase_price', a.after->>'purchase_price';
  END IF;

  -- fitment: app.fit_tyre inserts it, app.remove_tyre's closure updates it.
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, status, retread_count, state)
  VALUES (tb, bac, 'T72BFIT', sz1, 'NEW', 0, 'IN_STOCK');
  SELECT r.fitment_id INTO fit FROM app.fit_tyre(tb, vu, pos, 14.0, 'MARK_OUTBOARD') r;
  a := pg_temp.t72_one('fitment', fit, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'tyre_id' IS DISTINCT FROM tb::text
     OR a.after->>'removed_at' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 72b: the fit is filed with before %, tyre %, removed_at %',
      a.before, a.after->>'tyre_id', a.after->>'removed_at';
  END IF;
  PERFORM app.remove_tyre(fit, 'damage', 10.0);
  a := pg_temp.t72_one('fitment', fit, 'UPDATE', bac, act);
  IF a.before->>'removed_at' IS NOT NULL OR a.after->>'removed_at' IS NULL
     OR a.after->>'removal_reason' IS DISTINCT FROM 'damage' THEN
    RAISE EXCEPTION 'FAIL 72b: the closure is filed as removed_at % to %, reason %',
      a.before->>'removed_at', a.after->>'removed_at', a.after->>'removal_reason';
  END IF;

  -- retread_job: app.dispatch_tyre inserts it, app.log_retread_return
  -- updates it. Dated in the past, as section 42 dates them.
  INSERT INTO app.depot (id, tenant_id, name, type) VALUES (d_rt, bac, 'T72B Retreaders', 'RETREADER');
  INSERT INTO app.tyre (id, tenant_id, display_code, size_id, pattern_id, status, retread_count, state)
  VALUES (tc, bac, 'T72BRETREAD', sz1, pt1, 'NEW', 0, 'REMOVED');
  SELECT r.retread_job_id INTO job
    FROM app.dispatch_tyre(tc, 'AT_RETREADER', d_rt, app.tenant_today(tz) - 5) r;
  a := pg_temp.t72_one('retread_job', job, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'tyre_id' IS DISTINCT FROM tc::text
     OR a.after->>'returned_at' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 72b: the dispatch is filed with before %, tyre %, returned_at %',
      a.before, a.after->>'tyre_id', a.after->>'returned_at';
  END IF;
  PERFORM app.log_retread_return(job, app.tenant_today(tz) - 1, false, 'T72B-RPT');
  a := pg_temp.t72_one('retread_job', job, 'UPDATE', bac, act);
  IF a.before->>'returned_at' IS NOT NULL
     OR a.after->>'returned_at' IS DISTINCT FROM (app.tenant_today(tz) - 1)::text
     OR a.after->>'casing_accepted' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL 72b: the return is filed as returned_at % to %, accepted %',
      a.before->>'returned_at', a.after->>'returned_at', a.after->>'casing_accepted';
  END IF;

  -- app_user: createUser's INSERT, the runbook's deactivation, then
  -- createUser's rehire UPDATE (admin.go), each as issued with its
  -- parameters bound.
  INSERT INTO app.app_user (tenant_id, email, display_name, staff_number, role)
  VALUES (app.current_tenant_id(), 't72b@example.invalid', 'T72B Person', NULL, 'DRIVER'::app.user_role)
  RETURNING id INTO usr;
  a := pg_temp.t72_one('app_user', usr, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'email' IS DISTINCT FROM 't72b@example.invalid' THEN
    RAISE EXCEPTION 'FAIL 72b: the new user is filed with before % and email %', a.before, a.after->>'email';
  END IF;
  UPDATE app.app_user SET active = false WHERE id = usr;
  UPDATE app.app_user
     SET active = true, display_name = 'T72B Rehired',
         staff_number = CASE WHEN false THEN NULL
                             ELSE COALESCE(NULL::text, staff_number) END,
         role = 'DRIVER'::app.user_role
   WHERE lower(email) = lower('t72b@example.invalid') AND NOT active;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'app_user' AND al.entity_id = usr AND al.action = 'UPDATE';
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 72b: the deactivation and the rehire filed % UPDATE entries, not two', n;
  END IF;
  SELECT * INTO a FROM app.audit_log al
   WHERE al.entity_type = 'app_user' AND al.entity_id = usr AND al.action = 'UPDATE'
   ORDER BY al.id DESC LIMIT 1;
  IF a.before->>'active' IS DISTINCT FROM 'false' OR a.after->>'active' IS DISTINCT FROM 'true'
     OR a.after->>'display_name' IS DISTINCT FROM 'T72B Rehired'
     OR a.tenant_id IS DISTINCT FROM bac OR a.actor_id IS DISTINCT FROM act THEN
    RAISE EXCEPTION 'FAIL 72b: the rehire is filed as active % to %, name %, tenant %, actor %',
      a.before->>'active', a.after->>'active', a.after->>'display_name', a.tenant_id, a.actor_id;
  END IF;

  -- vehicle_driver: assignDriver's INSERT (admin.go).
  INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date)
  VALUES (app.current_tenant_id(), vu, drv,
          COALESCE(NULL::date,
                   app.tenant_today((SELECT timezone FROM app.tenant
                                      WHERE id = app.current_tenant_id()))))
  RETURNING id INTO vd;
  a := pg_temp.t72_one('vehicle_driver', vd, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'user_id' IS DISTINCT FROM drv::text
     OR a.after->>'vehicle_id' IS DISTINCT FROM vu::text THEN
    RAISE EXCEPTION 'FAIL 72b: the assignment is filed with before %, user %, unit %',
      a.before, a.after->>'user_id', a.after->>'vehicle_id';
  END IF;

  -- threshold_policy and configuration have no route; their writers are the
  -- seeds, migrations and the owning role, and app_rw holds the grants. The
  -- policy row is dated a day ahead so nothing above prices under it.
  INSERT INTO app.threshold_policy (id, tenant_id, axle_class, retread_threshold_mm,
                                    max_retreads, effective_from)
  VALUES (tp, bac, 'DRIVE', 4.0, 2, now() + interval '1 day');
  a := pg_temp.t72_one('threshold_policy', tp, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'retread_threshold_mm' IS DISTINCT FROM '4.0'
     OR a.after->>'axle_class' IS DISTINCT FROM 'DRIVE' THEN
    RAISE EXCEPTION 'FAIL 72b: the policy row is filed with before %, threshold %, class %',
      a.before, a.after->>'retread_threshold_mm', a.after->>'axle_class';
  END IF;
  INSERT INTO app.configuration (id, tenant_id, key, value) VALUES (cf, bac, 't72b_probe', '"one"');
  a := pg_temp.t72_one('configuration', cf, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->'value' IS DISTINCT FROM '"one"'::jsonb THEN
    RAISE EXCEPTION 'FAIL 72b: the configuration row is filed with before % and value %', a.before, a.after->'value';
  END IF;
  UPDATE app.configuration SET value = '"two"' WHERE id = cf;
  a := pg_temp.t72_one('configuration', cf, 'UPDATE', bac, act);
  IF a.before->'value' IS DISTINCT FROM '"one"'::jsonb
     OR a.after->'value' IS DISTINCT FROM '"two"'::jsonb THEN
    RAISE EXCEPTION 'FAIL 72b: the configuration edit is filed as % to %', a.before->'value', a.after->'value';
  END IF;

  -- vehicle_tag and the map: the unit edit's statements (units.go), with
  -- tag_names for its $1 and nm for its alias, since n is a variable here.
  INSERT INTO app.vehicle_tag (tenant_id, name)
  SELECT app.current_tenant_id(), nm FROM unnest(tag_names) nm ORDER BY nm
  ON CONFLICT (tenant_id, name) DO NOTHING;
  SELECT t.id INTO tg FROM app.vehicle_tag t WHERE t.name = ANY(tag_names);
  a := pg_temp.t72_one('vehicle_tag', tg, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'name' IS DISTINCT FROM 'T72B Tag' THEN
    RAISE EXCEPTION 'FAIL 72b: the new tag is filed with before % and name %', a.before, a.after->>'name';
  END IF;
  -- Reusing the name inserts nothing, so it files nothing, and the name
  -- still resolves to the same tag.
  INSERT INTO app.vehicle_tag (tenant_id, name)
  SELECT app.current_tenant_id(), nm FROM unnest(tag_names) nm ORDER BY nm
  ON CONFLICT (tenant_id, name) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 72b: reusing a tag name inserted % rows', n;
  END IF;
  SELECT t.id INTO tg_again FROM app.vehicle_tag t WHERE t.name = ANY(tag_names);
  IF tg_again IS DISTINCT FROM tg THEN
    RAISE EXCEPTION 'FAIL 72b: the reused name resolved % and the new one %', tg_again, tg;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle_tag' AND al.entity_id = tg;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72b: reusing a tag name left % entries for the tag, not its one INSERT', n;
  END IF;
  INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id)
  VALUES (app.current_tenant_id(), vu, tg);
  a := pg_temp.t72_one('vehicle_tag_map', vu, 'INSERT', bac, act);
  IF a.before IS NOT NULL OR a.after->>'tag_id' IS DISTINCT FROM tg::text
     OR a.after->>'vehicle_id' IS DISTINCT FROM vu::text THEN
    RAISE EXCEPTION 'FAIL 72b: the link is filed with before %, tag %, unit %',
      a.before, a.after->>'tag_id', a.after->>'vehicle_id';
  END IF;

  -- The seed loads as the owning role with no actor bound, so its rows are
  -- filed under their own tenant with a NULL actor (ADR-0014).
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'tyre' AND al.entity_id = md5('tyre1')::uuid AND al.action = 'INSERT'
     AND al.tenant_id = bac AND al.actor_id IS NULL AND al.before IS NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72b: the seeded tyre1 has % readable unactored INSERT entries, not one', n;
  END IF;
  RAISE NOTICE 'PASS  72b the nine tables file each write through its live path with the right action, entity, before and after; a reused tag name files nothing; a seeded row is filed with no actor';
END $$;
ROLLBACK;

\echo '== 72c. an INSERT naming another tenant is refused by the audited table''s own policy (FR-TEN-004, docs/lessons.md 2026-09-08; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac  constant uuid := '11111111-1111-1111-1111-111111111111';
        t2   constant uuid := '22222222-2222-2222-2222-222222222222';
        veh2 constant uuid := md5('t2veh1')::uuid;
        drv2 constant uuid := md5('driver2')::uuid;
        ty2  constant uuid := md5('t72c-tyre2')::uuid;
        tag2 constant uuid := md5('t72c-tag2')::uuid;
        pos2 uuid; r record; msg text;
BEGIN
  -- Second Fleet's own rows for every reference, planted under its own
  -- binding, so each forged row is valid in every way but its writer
  -- (lesson 2026-09-01). No actor is bound, so created_by defaults to NULL
  -- rather than to a BAC user behind a composite FK (lesson 2026-08-28).
  PERFORM set_config('app.actor_id', '', true);
  PERFORM set_config('app.tenant_id', t2::text, true);
  INSERT INTO app.tyre (id, tenant_id, display_code, state) VALUES (ty2, t2, 'T72CTYRE2', 'IN_STOCK');
  INSERT INTO app.vehicle_tag (id, tenant_id, name) VALUES (tag2, t2, 'T72C Tag');
  SELECT p.id INTO pos2 FROM app.position p
    JOIN app.vehicle v ON v.configuration_id = p.configuration_id
   WHERE v.id = veh2 AND p.code = '1';
  IF pos2 IS NULL THEN
    RAISE EXCEPTION 'FAIL 72c: Second Fleet''s unit has no position 1, so the fitment forge proves nothing';
  END IF;
  PERFORM set_config('app.tenant_id', bac::text, true);

  FOR r IN SELECT * FROM (VALUES
      ('tyre', format(
        'INSERT INTO app.tyre (tenant_id, display_code, state) VALUES (%L, %L, %L)',
        t2, 'T72CFORGE', 'IN_STOCK')),
      ('fitment', format(
        'INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer, fitted_tread_mm) VALUES (%L, %L, %L, %L, now(), 100000, 14.0)',
        t2, ty2, veh2, pos2)),
      ('retread_job', format(
        'INSERT INTO app.retread_job (tenant_id, tyre_id, sent_at) VALUES (%L, %L, current_date)',
        t2, ty2)),
      ('app_user', format(
        'INSERT INTO app.app_user (tenant_id, email, display_name, role) VALUES (%L, %L, %L, %L)',
        t2, 't72c@example.invalid', 'T72C Forged', 'DRIVER')),
      ('vehicle_driver', format(
        'INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date) VALUES (%L, %L, %L, current_date)',
        t2, veh2, drv2)),
      ('threshold_policy', format(
        'INSERT INTO app.threshold_policy (tenant_id, axle_class, retread_threshold_mm, max_retreads, effective_from) VALUES (%L, %L, 4.0, 2, now() + interval %L)',
        t2, 'DRIVE', '1 day')),
      ('configuration', format(
        'INSERT INTO app.configuration (tenant_id, key, value) VALUES (%L, %L, %L)',
        t2, 't72c_probe', '"forged"')),
      ('vehicle_tag', format(
        'INSERT INTO app.vehicle_tag (tenant_id, name) VALUES (%L, %L)',
        t2, 'T72C Forged')),
      ('vehicle_tag_map', format(
        'INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id) VALUES (%L, %L, %L)',
        t2, veh2, tag2))
    ) v(tbl, stmt)
  LOOP
    msg := NULL;
    BEGIN
      EXECUTE r.stmt;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    END;
    -- The table's own policy, by name: audit_log's policy would answer a row
    -- that got past it with the same 42501.
    IF msg IS NULL OR msg NOT LIKE format('%%row-level security policy for table "%s"%%', r.tbl) THEN
      RAISE EXCEPTION 'FAIL 72c: a % row aimed at Second Fleet was answered %',
        r.tbl, COALESCE(msg, 'by an accepted row');
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  72c a row aimed at another tenant is refused by each audited table''s own policy';
END $$;
ROLLBACK;

\echo '== 72d. a tag map DELETE is filed under the unit with the link it removed, a DELETE that unbinds or switches its tenant mid-statement is refused, a real UPDATE is filed under the unit too, and a no-op UPDATE not at all (FR-AUD-001, DR-014, ADR-0013 decision 7; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        act constant uuid := md5('controller1')::uuid;
        vd  constant uuid := md5('t72d-unit')::uuid;
        tg1 constant uuid := md5('t72d-tag1')::uuid;
        tg2 constant uuid := md5('t72d-tag2')::uuid;
        cfg uuid; a app.audit_log; n int; links int; switched text; msg text; ret text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  SELECT v.configuration_id INTO cfg FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  IF cfg IS NULL THEN
    RAISE EXCEPTION 'FAIL 72d: BAC''s veh1 is not visible, so the plant below proves nothing';
  END IF;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id,
                           unit_kind, home_depot_id, status)
  VALUES (vd, bac, 'T72-D', 'T72D GP', cfg, 'TRAILER', md5('depot1')::uuid, 'ACTIVE');
  INSERT INTO app.vehicle_tag (id, tenant_id, name) VALUES (tg1, bac, 'T72D One'), (tg2, bac, 'T72D Two');
  INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id) VALUES (bac, vd, tg1);

  UPDATE app.vehicle_tag_map SET tag_id = tg2 WHERE vehicle_id = vd;
  a := pg_temp.t72_one('vehicle_tag_map', vd, 'UPDATE', bac, act);
  IF a.before->>'tag_id' IS DISTINCT FROM tg1::text OR a.after->>'tag_id' IS DISTINCT FROM tg2::text THEN
    RAISE EXCEPTION 'FAIL 72d: the relabel is filed as % to %', a.before->>'tag_id', a.after->>'tag_id';
  END IF;
  -- app.stamp_updated moves updated_at on every UPDATE; the skip sets it aside.
  UPDATE app.vehicle_tag_map SET tag_id = tag_id WHERE vehicle_id = vd;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72d: the no-op update reached % rows, so its count below proves nothing', n;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type = 'vehicle_tag_map' AND al.entity_id = vd AND al.action = 'UPDATE';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 72d: a no-op update of a link left % UPDATE entries, not the one relabel', n;
  END IF;

  -- A second link, so the control below removes one and the probes after it
  -- still have one to aim at.
  INSERT INTO app.vehicle_tag_map (tenant_id, vehicle_id, tag_id) VALUES (bac, vd, tg1);
  DELETE FROM app.vehicle_tag_map WHERE vehicle_id = vd AND tag_id = tg2;
  a := pg_temp.t72_one('vehicle_tag_map', vd, 'DELETE', bac, act);
  IF a.after IS NOT NULL OR a.before->>'tag_id' IS DISTINCT FROM tg2::text
     OR a.before->>'vehicle_id' IS DISTINCT FROM vd::text THEN
    RAISE EXCEPTION 'FAIL 72d: the removal is filed with before tag %, unit %, after %',
      a.before->>'tag_id', a.before->>'vehicle_id', a.after;
  END IF;

  -- The trigger fires after RETURNING has run, so a DELETE can unbind or
  -- switch its tenant before its entry is filed. It is refused by audit_log's
  -- policy, never let through unfiled (DR-014, TYRE-98).
  FOREACH switched IN ARRAY ARRAY['', t2::text] LOOP
    msg := NULL;
    BEGIN
      DELETE FROM app.vehicle_tag_map WHERE vehicle_id = vd AND tag_id = tg1
      RETURNING set_config('app.tenant_id', switched, true) INTO ret;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    END;
    -- Rebound before counting: a DELETE that went through left the tenant
    -- switched, and an unbound count reads zero for the wrong reason.
    PERFORM set_config('app.tenant_id', bac::text, true);
    SELECT count(*) INTO links FROM app.vehicle_tag_map m WHERE m.vehicle_id = vd AND m.tag_id = tg1;
    SELECT count(*) INTO n FROM app.audit_log al
     WHERE al.entity_type = 'vehicle_tag_map' AND al.entity_id = vd AND al.action = 'DELETE'
       AND al.before->>'tag_id' = tg1::text;
    IF msg IS NULL OR msg NOT LIKE '%row-level security policy for table "audit_log"%'
       OR links <> 1 OR n <> 0 THEN
      RAISE EXCEPTION 'FAIL 72d: a DELETE that bound tenant ''%'' mid-statement was answered %, left % links and filed % DELETE entries for it',
        switched, COALESCE(msg, 'by a completed deletion'), links, n;
    END IF;
  END LOOP;
  PERFORM pg_temp.t72_one('vehicle_tag_map', vd, 'DELETE', bac, act);
  RAISE NOTICE 'PASS  72d a link''s removal is filed under its unit with the link it removed; a DELETE that unbinds or switches its tenant mid-statement is refused and files nothing; a relabel is filed, a no-op update is not';
END $$;
ROLLBACK;

\echo '== 72e. a trigger on a table with no tenant_id, or whose row has no value in the column it names, raises instead of filing an entry under NULL (ADR-0014; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        act constant uuid := md5('controller1')::uuid;
        u   constant uuid := md5('t72e-unit')::uuid;
        a app.audit_log; msg text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', act::text, true);
  -- app_login owns a temporary table and has no CREATE on app, so this is
  -- the one place it can attach the function; the rollback removes both.
  CREATE TEMP TABLE t72e (id uuid, tenant_id uuid, unit_id uuid);
  CREATE TEMP TABLE t72e_bare (id uuid);
  CREATE TRIGGER t72e_named AFTER INSERT ON t72e
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('unit_id');

  -- The control: a row with a value in the named column is filed under it.
  INSERT INTO t72e VALUES (gen_random_uuid(), bac, u);
  a := pg_temp.t72_one('t72e', u, 'INSERT', bac, act);

  msg := NULL;
  BEGIN
    INSERT INTO t72e VALUES (gen_random_uuid(), bac, NULL);
  EXCEPTION WHEN raise_exception THEN msg := SQLERRM;
  END;
  IF msg IS NULL OR msg NOT LIKE '%.t72e row has no value in unit_id,%' THEN
    RAISE EXCEPTION 'FAIL 72e: a NULL in the named column was answered %', COALESCE(msg, 'by a filed entry');
  END IF;

  DROP TRIGGER t72e_named ON t72e;
  CREATE TRIGGER t72e_wrong AFTER INSERT ON t72e
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('no_such_column');
  msg := NULL;
  BEGIN
    INSERT INTO t72e VALUES (gen_random_uuid(), bac, u);
  EXCEPTION WHEN raise_exception THEN msg := SQLERRM;
  END;
  IF msg IS NULL OR msg NOT LIKE '%.t72e row has no value in no_such_column,%' THEN
    RAISE EXCEPTION 'FAIL 72e: a column the table lacks was answered %', COALESCE(msg, 'by a filed entry');
  END IF;

  CREATE TRIGGER t72e_bare_audited AFTER INSERT ON t72e_bare
  FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();
  msg := NULL;
  BEGIN
    INSERT INTO t72e_bare VALUES (gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN msg := SQLERRM;
  END;
  IF msg IS NULL OR msg NOT LIKE '%.t72e_bare has no tenant_id column' THEN
    RAISE EXCEPTION 'FAIL 72e: a table with no tenant_id was answered %', COALESCE(msg, 'by a filed entry');
  END IF;

  SELECT count(*) INTO n FROM app.audit_log al
   WHERE al.entity_type IN ('t72e', 't72e_bare') AND al.entity_id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 72e: % entries were filed with a NULL entity_id', n;
  END IF;
  RAISE NOTICE 'PASS  72e a missing tenant_id, a missing column and a NULL in the named column each raise; a value is filed under the column named';
END $$;
ROLLBACK;

\echo '== 72f. nothing section 72 planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT (SELECT count(*) FROM app.vehicle WHERE fleet_number LIKE 'T72-%')
       + (SELECT count(*) FROM app.tyre WHERE display_code LIKE 'T72%')
       + (SELECT count(*) FROM app.app_user WHERE email LIKE 't72%')
       + (SELECT count(*) FROM app.configuration WHERE key LIKE 't72%')
       + (SELECT count(*) FROM app.vehicle_tag WHERE name LIKE 'T72%')
       + (SELECT count(*) FROM app.depot WHERE name LIKE 'T72%')
       + (SELECT count(*) FROM app.audit_log WHERE entity_type IN ('t72e', 't72e_bare'))
    INTO n;
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT n + (SELECT count(*) FROM app.tyre WHERE display_code LIKE 'T72%')
           + (SELECT count(*) FROM app.vehicle_tag WHERE name LIKE 'T72%')
    INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 72f: % rows planted by section 72 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  72f section 72 leaves no residue';
END $$;
DROP FUNCTION pg_temp.t72_one(text, uuid, text, uuid, uuid);

\echo '== 73. TYRE-175: orientation_known has no default and every writer states it, a future receive is TY011, and the axle side-divergence view is gone (CHG-011 as amended, FR-TYR-040, ADR-0010 rule 2, ADR-0012)'

\echo '== 73a. orientation_known is NOT NULL with no default; a measurement that leaves it out is refused 23502 on that column, and the same row stating it lands (CHG-011 as amended, ADR-0010 rule 2; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        posid uuid; st text; col text; n int;
BEGIN
  SELECT count(*) INTO n FROM pg_attribute a
   WHERE a.attrelid = 'app.reading_measurement'::regclass
     AND a.attname = 'orientation_known' AND a.attnotnull AND NOT a.atthasdef;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 73a: orientation_known carries a default or accepts NULL';
  END IF;

  PERFORM set_config('app.tenant_id', t2::text, true);
  SELECT p.id INTO posid FROM app.position p
   WHERE p.configuration_id = md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid
     AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  IF posid IS NULL THEN
    RAISE EXCEPTION 'FAIL 73a: Second Fleet''s HORSE_6X4 position is not visible, so the insert below proves nothing';
  END IF;
  -- The inspection is this transaction's, so reading_measurement_sealed
  -- (TY020) lets the row through and only the column can refuse it.
  INSERT INTO app.inspection (id,tenant_id,vehicle_id,user_id,client_uuid,started_at,submitted_at,odometer)
  VALUES (md5('t73insp')::uuid, t2, md5('t2veh1')::uuid, md5('driver2')::uuid,
          md5('t73cli')::uuid, now(), now(), 750);
  INSERT INTO app.reading (id,tenant_id,inspection_id,vehicle_id,position_id,tyre_id,pressure_kpa)
  VALUES (md5('t73rd')::uuid, t2, md5('t73insp')::uuid, md5('t2veh1')::uuid, posid, NULL, 750);
  BEGIN
    INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm)
    VALUES (t2, md5('t73rd')::uuid, 1, 'CENTRE', 9);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, col = COLUMN_NAME;
  END;
  IF st IS DISTINCT FROM '23502' OR col IS DISTINCT FROM 'orientation_known' THEN
    RAISE EXCEPTION 'FAIL 73a: a measurement that left orientation_known out was answered %',
      COALESCE(st || ' on ' || COALESCE(NULLIF(col, ''), 'no column'), 'by a stored row');
  END IF;
  -- The control: the same row stating the value lands, so the 23502 above
  -- came from the omission and from nothing else in the row.
  INSERT INTO app.reading_measurement (tenant_id, reading_id, ordinal, position, tread_mm, orientation_known)
  VALUES (t2, md5('t73rd')::uuid, 1, 'CENTRE', 9, true);
  SELECT count(*) INTO n FROM app.reading_measurement
   WHERE reading_id = md5('t73rd')::uuid AND orientation_known;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 73a: the same measurement stating orientation_known did not land (% rows)', n;
  END IF;
  RAISE NOTICE 'PASS  73a orientation_known has no default; leaving it out is a 23502 on that column, and stating it lands';
END $$;
ROLLBACK;

\echo '== 73b. a receive dated the tenant''s tomorrow is refused TY011 with its own message, and the same receive dated the tenant''s today lands (FR-TYR-040 as amended, ADR-0012, TYRE-175 Q3; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        tz text; base jsonb; st text; msg text; r record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'FAIL 73b: BAC''s timezone is not visible, so its tomorrow cannot be computed';
  END IF;
  -- A receive that names everything FR-TYR-031 requires, so only the date
  -- can refuse it. No fixture tyre carries the purchase date, so 73e can
  -- find the row.
  base := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                             'new_tread_mm', '25.0', 'purchase_date', '2001-07-03');
  BEGIN
    PERFORM app.receive_tyres(base || jsonb_build_object(
      'received_date', (app.tenant_today(tz) + 1)::text));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF st IS DISTINCT FROM 'TY011'
     OR msg IS DISTINCT FROM 'a tyre is received on or before today, never on a future date' THEN
    RAISE EXCEPTION 'FAIL 73b: a receive dated the tenant''s tomorrow was answered %',
      COALESCE(st || ' "' || msg || '"', 'by an accepted receive');
  END IF;
  SELECT * INTO r FROM app.receive_tyres(base || jsonb_build_object(
    'received_date', app.tenant_today(tz)::text));
  IF (SELECT t.received_date FROM app.tyre t WHERE t.id = r.tyre_id) IS DISTINCT FROM app.tenant_today(tz) THEN
    RAISE EXCEPTION 'FAIL 73b: the same receive dated the tenant''s today did not land on that day';
  END IF;
  RAISE NOTICE 'PASS  73b a receive dated tomorrow is TY011 with its own message, and dated today it lands';
END $$;
ROLLBACK;

\echo '== 73c. app.v_axle_side_divergence is gone (owner decision 6 on TYRE-143; FR-ANL-029 and FR-EXC-037 are deferred to Appendix H.2)'
DO $$
BEGIN
  IF to_regclass('app.v_axle_side_divergence') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 73c: app.v_axle_side_divergence still exists';
  END IF;
  RAISE NOTICE 'PASS  73c the axle side-divergence view is gone';
END $$;

\echo '== 73d. a submit states orientation_known itself, true on a running position and false on a spare, from a payload that carries no such key (FR-INS-029a, CHG-011 as amended; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        drv constant uuid := md5('driver2')::uuid;
        cfg constant uuid := md5('22222222-2222-2222-2222-222222222222HORSE_6X4')::uuid;
        -- A unit of its own, so FR-INS-038's window cannot refuse the submit.
        v   constant uuid := md5('t73d-unit')::uuid;
        p_run uuid; p_spare uuid; insp uuid; got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', drv::text, true);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (v, t2, 'T73-D', 'CAA737301', cfg, 'HORSE', 'ACTIVE');
  SELECT p.id INTO p_run FROM app.position p
   WHERE p.configuration_id = cfg AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  SELECT p.id INTO p_spare FROM app.position p
   WHERE p.configuration_id = cfg AND p.is_spare ORDER BY p.sequence LIMIT 1;
  IF p_run IS NULL OR p_spare IS NULL THEN
    RAISE EXCEPTION 'FAIL 73d: Second Fleet''s HORSE_6X4 has no visible running position or spare';
  END IF;

  SELECT s.inspection_id INTO insp FROM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v,
    'started_at', now() - interval '150 seconds', 'submitted_at', now(),
    'readings', jsonb_build_array(
      jsonb_build_object('vehicle_id', v, 'position_id', p_run,
                         'pressure_kpa', 800, 'treads', jsonb_build_array(12.0, 13.0, 14.0)),
      jsonb_build_object('vehicle_id', v, 'position_id', p_spare,
                         'pressure_kpa', 800, 'treads', jsonb_build_array(12.0, 13.0, 14.0))))) s;
  SELECT string_agg(CASE WHEN r.position_id = p_spare THEN 'spare' ELSE 'running' END
                    || ':' || m.ordinal || ':' || m.orientation_known,
                    ' ' ORDER BY r.position_id = p_spare, m.ordinal)
    INTO got
    FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
   WHERE r.inspection_id = insp;
  IF got IS DISTINCT FROM 'running:1:true running:2:true running:3:true spare:1:false spare:2:false spare:3:false' THEN
    RAISE EXCEPTION 'FAIL 73d: the submit stored %', COALESCE(got, 'no measurements');
  END IF;
  RAISE NOTICE 'PASS  73d a submit stores true on a running position and false on a spare, with no key in its payload';
END $$;
ROLLBACK;

\echo '== 73e. nothing section 73 planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n FROM app.tyre WHERE purchase_date = '2001-07-03';
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  n := n + (SELECT count(*) FROM app.inspection WHERE id = md5('t73insp')::uuid)
         + (SELECT count(*) FROM app.reading WHERE id = md5('t73rd')::uuid)
         + (SELECT count(*) FROM app.vehicle WHERE id = md5('t73d-unit')::uuid);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 73e: % rows planted by section 73 survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  73e section 73 leaves no residue';
END $$;

\echo '== 74. TYRE-369: a tenant is seeded from the platform catalogue by lineage, its own file loads insert-only and all or nothing, the price list keeps one row per size, brand and date, and a seeded size values a casing ESTIMATED (FR-CFG-005, FR-CFG-040, FR-CFG-042, FR-CFG-043, FR-TYR-008, DR-007)'

-- One provisioning call each, answered as the counts it returns or as
-- 'SQLSTATE message'. The handler is the subtransaction a refused call rolls
-- back to, so a refusal leaves the section's transaction as it was.
CREATE FUNCTION pg_temp.t74_seed() RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE st text; msg text;
BEGIN
  RETURN 'seeded ' || app.seed_tenant_catalogue();
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  RETURN st || ' ' || msg;
END $fn$;

CREATE FUNCTION pg_temp.t74_load(p_payload jsonb) RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE got text; st text; msg text;
BEGIN
  SELECT string_agg(s.section || '=' || s.inserted, ' ' ORDER BY s.n) INTO got
    FROM app.provision_catalogue(p_payload) WITH ORDINALITY AS s(section, inserted, n);
  RETURN got;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  RETURN st || ' ' || msg;
END $fn$;

-- The bound tenant's catalogue as five counts: sizes, brands, patterns,
-- casing estimates, price rows.
CREATE FUNCTION pg_temp.t74_counts() RETURNS text
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  SELECT (SELECT count(*) FROM app.tyre_size) || '/' || (SELECT count(*) FROM app.tyre_brand)
         || '/' || (SELECT count(*) FROM app.tyre_pattern)
         || '/' || (SELECT count(*) FROM app.casing_estimate_by_size)
         || '/' || (SELECT count(*) FROM app.tyre_price_list)
$fn$;

\echo '== 74a. a seed copies every platform entry once into a tenant with no catalogue, each with its lineage, and each starter pattern with no brand (FR-CFG-005, D2, D8; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        got text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  IF pg_temp.t74_counts() <> '0/0/0/0/0' THEN
    RAISE EXCEPTION 'FAIL 74a: Second Fleet holds catalogue rows % before its seed, so the counts below prove nothing',
      pg_temp.t74_counts();
  END IF;
  -- D8's starter list, read from the platform tables the seed copies.
  SELECT string_agg(p.name || ':' || p.construction, ' ' ORDER BY p.name) INTO got FROM app.platform_tyre_size p;
  IF got IS DISTINCT FROM '11R22.5:RADIAL 185/65R15:RADIAL 225/70R19.5:RADIAL 315/80R22.5:RADIAL' THEN
    RAISE EXCEPTION 'FAIL 74a: the platform sizes are %', got;
  END IF;
  SELECT string_agg(p.name, ' ' ORDER BY p.name) INTO got FROM app.platform_tyre_brand p;
  IF got IS DISTINCT FROM 'Dunlop Evergreen Roadshine' THEN
    RAISE EXCEPTION 'FAIL 74a: the platform brands are %', got;
  END IF;
  SELECT string_agg(p.name || ':' || p.applies_to || ':' || COALESCE(p.brand_id::text, '-'), ' ' ORDER BY p.name)
    INTO got FROM app.platform_tyre_pattern p;
  IF got IS DISTINCT FROM 'EGT88:NEW:- RS620:NEW:- SP431:NEW:-' THEN
    RAISE EXCEPTION 'FAIL 74a: the platform patterns are %', got;
  END IF;

  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 10' THEN
    RAISE EXCEPTION 'FAIL 74a: the first seed answered %', got;
  END IF;
  -- Every tenant row is a copy, and every copy matches its platform entry
  -- by lineage, field by field.
  SELECT count(*) INTO n FROM app.tyre_size s JOIN app.platform_tyre_size p ON p.id = s.platform_catalogue_id
   WHERE s.name = p.name AND s.construction IS NOT DISTINCT FROM p.construction AND s.active;
  IF n <> 4 OR pg_temp.t74_counts() <> '4/3/3/0/0' THEN
    RAISE EXCEPTION 'FAIL 74a: % of the sizes are faithful copies; the catalogue reads %', n, pg_temp.t74_counts();
  END IF;
  SELECT count(*) INTO n FROM app.tyre_brand b JOIN app.platform_tyre_brand p ON p.id = b.platform_catalogue_id
   WHERE b.name = p.name AND b.active;
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL 74a: % of the three brands are faithful copies', n;
  END IF;
  SELECT count(*) INTO n FROM app.tyre_pattern t JOIN app.platform_tyre_pattern p ON p.id = t.platform_catalogue_id
   WHERE t.name = p.name AND t.applies_to = p.applies_to AND t.brand_id IS NULL AND t.active;
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL 74a: % of the three patterns are faithful brandless copies', n;
  END IF;
  RAISE NOTICE 'PASS  74a a seed copies the ten starter entries once, each with its lineage, each pattern with no brand';
END $$;
ROLLBACK;

\echo '== 74b. a second seed inserts nothing, and a copy the tenant deactivated is neither duplicated nor restored (FR-CFG-005, D2; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 10' THEN
    RAISE EXCEPTION 'FAIL 74b: the first seed answered %', got;
  END IF;
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 0' OR pg_temp.t74_counts() <> '4/3/3/0/0' THEN
    RAISE EXCEPTION 'FAIL 74b: a second seed answered % and left %', got, pg_temp.t74_counts();
  END IF;
  -- The copy is found by lineage, whatever its state: a deactivated copy is
  -- the tenant's decision and a later seed leaves it as it is.
  UPDATE app.tyre_size SET active = false WHERE platform_catalogue_id = md5('platform_tyre_size:185/65R15')::uuid;
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 0' OR pg_temp.t74_counts() <> '4/3/3/0/0'
     OR (SELECT active FROM app.tyre_size WHERE name = '185/65R15') THEN
    RAISE EXCEPTION 'FAIL 74b: a seed after a deactivation answered % and left %', got, pg_temp.t74_counts();
  END IF;
  -- An entry the fleet holds a copy of is never a clash, even after the
  -- fleet renamed that copy and gave the name to a row of its own.
  UPDATE app.tyre_brand SET name = 'Dunlop (seeded)' WHERE platform_catalogue_id = md5('platform_tyre_brand:Dunlop')::uuid;
  INSERT INTO app.tyre_brand (tenant_id, name) VALUES (t2, 'Dunlop');
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 0' OR pg_temp.t74_counts() <> '4/4/3/0/0' THEN
    RAISE EXCEPTION 'FAIL 74b: a seed after the fleet renamed its Dunlop copy and added its own Dunlop answered % and left %',
      got, pg_temp.t74_counts();
  END IF;
  RAISE NOTICE 'PASS  74b a second seed inserts nothing, leaves a deactivated copy deactivated, and takes no copied entry for a clash';
END $$;
ROLLBACK;

\echo '== 74c. another tenant bound in the same session sees none of the rows seeded or loaded into Second Fleet, and its own load cannot name them (FR-TEN-003, NFR-SEC-004, TYRE-369 comment 13592; rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sbx constant uuid := '33333333-3333-3333-3333-333333333333';
        probe constant jsonb := '{"casing_estimates": [{"size": "T74 OWN SIZE", "estimated_value": "1.00", "effective_from": "2026-02-01"}]}';
        ids uuid[]; other uuid; got text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  got := pg_temp.t74_seed() || ' ' || pg_temp.t74_load(
    '{"sizes": [{"name": "T74 OWN SIZE"}],
      "casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1837.50", "effective_from": "2026-01-01"}],
      "price_list": [{"size": "T74 OWN SIZE", "typical_price": "4000.00", "effective_from": "2026-01-01"}]}');
  IF got IS DISTINCT FROM 'seeded 10 sizes=1 brands=0 patterns=0 casing_estimates=1 price_list=1' THEN
    RAISE EXCEPTION 'FAIL 74c: Second Fleet''s seed and load answered %', got;
  END IF;
  SELECT array_agg(x.id) INTO ids FROM (
    SELECT id FROM app.tyre_size UNION ALL SELECT id FROM app.tyre_brand
    UNION ALL SELECT id FROM app.tyre_pattern UNION ALL SELECT id FROM app.casing_estimate_by_size
    UNION ALL SELECT id FROM app.tyre_price_list) x;
  IF cardinality(ids) <> 13 THEN
    RAISE EXCEPTION 'FAIL 74c: Second Fleet reads % catalogue rows, not 13', cardinality(ids);
  END IF;

  FOREACH other IN ARRAY ARRAY[bac, sbx] LOOP
    PERFORM set_config('app.tenant_id', other::text, true);
    SELECT (SELECT count(*) FROM app.tyre_size WHERE id = ANY (ids))
         + (SELECT count(*) FROM app.tyre_brand WHERE id = ANY (ids))
         + (SELECT count(*) FROM app.tyre_pattern WHERE id = ANY (ids))
         + (SELECT count(*) FROM app.casing_estimate_by_size WHERE id = ANY (ids))
         + (SELECT count(*) FROM app.tyre_price_list WHERE id = ANY (ids))
         + (SELECT count(*) FROM app.tyre_size WHERE platform_catalogue_id IS NOT NULL)
         + (SELECT count(*) FROM app.tyre_brand WHERE platform_catalogue_id IS NOT NULL)
         + (SELECT count(*) FROM app.tyre_pattern WHERE platform_catalogue_id IS NOT NULL)
      INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAIL 74c: tenant % sees % of Second Fleet''s seeded or loaded rows', other, n;
    END IF;
  END LOOP;

  -- A load bound to BAC resolves names in BAC alone: Second Fleet's own
  -- size is not one it can name. The control is the same file in Second
  -- Fleet.
  PERFORM set_config('app.tenant_id', bac::text, true);
  got := pg_temp.t74_load(probe);
  IF got IS DISTINCT FROM 'TY024 casing_estimates row 1: this fleet has no size named ''T74 OWN SIZE''' THEN
    RAISE EXCEPTION 'FAIL 74c: BAC''s load naming Second Fleet''s size answered %', got;
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);
  got := pg_temp.t74_load(probe);
  IF got IS DISTINCT FROM 'sizes=0 brands=0 patterns=0 casing_estimates=1 price_list=0' THEN
    RAISE EXCEPTION 'FAIL 74c: the same load in Second Fleet answered %', got;
  END IF;
  RAISE NOTICE 'PASS  74c BAC and Sandbox see none of Second Fleet''s seeded or loaded rows, and a load in BAC cannot name them';
END $$;
ROLLBACK;

\echo '== 74d. a file loads sizes, brands, patterns, casing estimates and price rows with no lineage, resolving seeded and own names alike; every amount round-trips to the cent, every row names the bound actor or none, and every row is audited under Second Fleet (FR-CFG-001 to 003, FR-CFG-040, FR-CFG-042, FR-CFG-043, DR-007, FR-AUD-001, D4; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        got text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 10' THEN
    RAISE EXCEPTION 'FAIL 74d: the seed answered %', got;
  END IF;
  -- Every section optional, and an empty one loads nothing.
  got := pg_temp.t74_load('{}') || ' ' || pg_temp.t74_load('{"sizes": [], "price_list": null}');
  IF got IS DISTINCT FROM 'sizes=0 brands=0 patterns=0 casing_estimates=0 price_list=0 sizes=0 brands=0 patterns=0 casing_estimates=0 price_list=0'
     OR pg_temp.t74_counts() <> '4/3/3/0/0' THEN
    RAISE EXCEPTION 'FAIL 74d: an empty file answered % and left %', got, pg_temp.t74_counts();
  END IF;

  got := pg_temp.t74_load(
    '{"sizes": [{"name": "T74 OWN SIZE", "construction": "CROSS_PLY"}, {"name": "T74 BARE SIZE"}],
      "brands": [{"name": "T74 OWN BRAND"}],
      "patterns": [{"name": "T74 OWN PATTERN", "brand": "T74 OWN BRAND", "applies_to": "RETREAD"},
                   {"name": "T74 SEEDED BRAND", "brand": "Dunlop", "applies_to": "BOTH"}],
      "casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1837.50", "effective_from": "2026-01-01"},
                           {"size": "315/80R22.5", "estimated_value": "0.5", "effective_from": "2099-06-01"},
                           {"size": "T74 OWN SIZE", "estimated_value": "9999999999.99", "effective_from": "2026-01-01"}],
      "price_list": [{"size": "315/80R22.5", "brand": "Dunlop", "typical_price": "4319.91", "effective_from": "2026-01-01"},
                     {"size": "315/80R22.5", "typical_price": "4000.00", "effective_from": "2026-01-01"},
                     {"size": "315/80R22.5", "brand": "Dunlop", "typical_price": "4500.00", "effective_from": "2026-07-01"}]}');
  IF got IS DISTINCT FROM 'sizes=2 brands=1 patterns=2 casing_estimates=3 price_list=3' THEN
    RAISE EXCEPTION 'FAIL 74d: the file answered %', got;
  END IF;

  SELECT string_agg(s.name || ':' || COALESCE(s.construction, '-'), ' ' ORDER BY s.name) INTO got
    FROM app.tyre_size s WHERE s.platform_catalogue_id IS NULL AND s.created_by IS NULL;
  IF got IS DISTINCT FROM 'T74 BARE SIZE:- T74 OWN SIZE:CROSS_PLY' THEN
    RAISE EXCEPTION 'FAIL 74d: the file''s sizes read %', got;
  END IF;
  SELECT string_agg(b.name, ' ') INTO got
    FROM app.tyre_brand b WHERE b.platform_catalogue_id IS NULL AND b.created_by IS NULL;
  IF got IS DISTINCT FROM 'T74 OWN BRAND' THEN
    RAISE EXCEPTION 'FAIL 74d: the file''s brands read %', got;
  END IF;
  -- The second pattern names the seeded Dunlop and resolves to that copy.
  SELECT string_agg(p.name || ':' || p.applies_to || ':' || b.name || ':' || (b.platform_catalogue_id IS NOT NULL),
                    ' ' ORDER BY p.name) INTO got
    FROM app.tyre_pattern p JOIN app.tyre_brand b ON b.id = p.brand_id
   WHERE p.platform_catalogue_id IS NULL AND p.created_by IS NULL;
  IF got IS DISTINCT FROM 'T74 OWN PATTERN:RETREAD:T74 OWN BRAND:false T74 SEEDED BRAND:BOTH:Dunlop:true' THEN
    RAISE EXCEPTION 'FAIL 74d: the file''s patterns read %', got;
  END IF;
  -- Rule 2: the amounts as text, so a cent lost or a float's tail shows.
  SELECT string_agg(s.name || '@' || to_char(e.effective_from, 'YYYY-MM-DD') || '=' || e.estimated_value,
                    ' ' ORDER BY e.estimated_value) INTO got
    FROM app.casing_estimate_by_size e JOIN app.tyre_size s ON s.id = e.size_id
   WHERE e.created_by IS NULL;
  IF got IS DISTINCT FROM '315/80R22.5@2099-06-01=0.50 315/80R22.5@2026-01-01=1837.50 T74 OWN SIZE@2026-01-01=9999999999.99' THEN
    RAISE EXCEPTION 'FAIL 74d: the casing estimates read %', got;
  END IF;
  SELECT string_agg(s.name || '/' || COALESCE(b.name, '-') || '@' || to_char(l.effective_from, 'YYYY-MM-DD')
                    || '=' || l.typical_price, ' ' ORDER BY l.typical_price) INTO got
    FROM app.tyre_price_list l JOIN app.tyre_size s ON s.id = l.size_id
    LEFT JOIN app.tyre_brand b ON b.id = l.brand_id
   WHERE l.created_by IS NULL;
  IF got IS DISTINCT FROM '315/80R22.5/-@2026-01-01=4000.00 315/80R22.5/Dunlop@2026-01-01=4319.91 315/80R22.5/Dunlop@2026-07-01=4500.00' THEN
    RAISE EXCEPTION 'FAIL 74d: the price rows read %', got;
  END IF;
  -- ADR-0014, U12: the seed's ten rows and the file's eleven are each filed
  -- once under Second Fleet, with no actor bound.
  SELECT string_agg(x.entity_type || '=' || x.n, ' ' ORDER BY x.entity_type) INTO got
    FROM (SELECT a.entity_type, count(*) AS n
            FROM app.audit_log a
            JOIN (SELECT id FROM app.tyre_size UNION ALL SELECT id FROM app.tyre_brand
                  UNION ALL SELECT id FROM app.tyre_pattern UNION ALL SELECT id FROM app.casing_estimate_by_size
                  UNION ALL SELECT id FROM app.tyre_price_list) r ON r.id = a.entity_id
           WHERE a.action = 'INSERT' AND a.tenant_id = t2 AND a.actor_id IS NULL
           GROUP BY a.entity_type) x;
  IF got IS DISTINCT FROM 'casing_estimate_by_size=3 tyre_brand=4 tyre_pattern=5 tyre_price_list=3 tyre_size=6' THEN
    RAISE EXCEPTION 'FAIL 74d: the audit entries for the seeded and loaded rows read %', got;
  END IF;
  -- With an actor bound, the catalogue row and the estimate both name it, and
  -- so does each one's audit entry.
  PERFORM set_config('app.actor_id', md5('driver2')::uuid::text, true);
  got := pg_temp.t74_load(
    '{"sizes": [{"name": "T74 ACTOR SIZE"}],
      "casing_estimates": [{"size": "T74 ACTOR SIZE", "estimated_value": "1.00", "effective_from": "2026-01-01"}]}');
  IF got IS DISTINCT FROM 'sizes=1 brands=0 patterns=0 casing_estimates=1 price_list=0' THEN
    RAISE EXCEPTION 'FAIL 74d: the load with an actor bound answered %', got;
  END IF;
  SELECT count(*) INTO n
    FROM app.tyre_size s
    JOIN app.casing_estimate_by_size e ON e.size_id = s.id
    JOIN app.audit_log sa ON sa.entity_id = s.id AND sa.action = 'INSERT'
    JOIN app.audit_log ea ON ea.entity_id = e.id AND ea.action = 'INSERT'
   WHERE s.name = 'T74 ACTOR SIZE'
     AND s.created_by = md5('driver2')::uuid AND e.created_by = md5('driver2')::uuid
     AND sa.actor_id = md5('driver2')::uuid AND ea.actor_id = md5('driver2')::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 74d: with an actor bound, the size, the estimate and their audit entries do not all name it';
  END IF;
  RAISE NOTICE 'PASS  74d a file loads every section with no lineage, resolves seeded and own names, keeps every amount to the cent, names the bound actor or none, and is audited under Second Fleet';
END $$;
ROLLBACK;

\echo '== 74e. each refusal names its section, row and reason, under TY024 for a file and TY025 for a seed, and an estimate dated back is refused once it would re-price a valuation (DR-007, D3 to D5, FR-CFG-051, U135, TYRE-369 comment 13592; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        nofleet constant uuid := md5('t74-no-fleet')::uuid;
        c record; got text; bad text := '';
BEGIN
  PERFORM set_config('app.actor_id', '', true);
  -- Unbound, and bound to a tenant that does not exist.
  PERFORM set_config('app.tenant_id', '', true);
  got := pg_temp.t74_load('{}') || ' | ' || pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'TY024 a catalogue load needs app.tenant_id bound to the fleet it loads into | TY025 a seed needs app.tenant_id bound to the fleet it seeds' THEN
    RAISE EXCEPTION 'FAIL 74e: an unbound load and seed answered %', got;
  END IF;
  PERFORM set_config('app.tenant_id', nofleet::text, true);
  got := pg_temp.t74_load('{}') || ' | ' || pg_temp.t74_seed();
  IF got IS DISTINCT FROM format('TY024 app.tenant_id %s names no fleet | TY025 app.tenant_id %s names no fleet', nofleet, nofleet) THEN
    RAISE EXCEPTION 'FAIL 74e: a load and seed bound to no fleet answered %', got;
  END IF;

  -- The base the file refusals run against: the seed, one estimate and one
  -- brandless price, each dated 2026-01-01.
  PERFORM set_config('app.tenant_id', t2::text, true);
  got := pg_temp.t74_seed() || ' ' || pg_temp.t74_load(
    '{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.00", "effective_from": "2026-01-01"}],
      "price_list": [{"size": "315/80R22.5", "typical_price": "4000.00", "effective_from": "2026-01-01"}]}');
  IF got IS DISTINCT FROM 'seeded 10 sizes=0 brands=0 patterns=0 casing_estimates=1 price_list=1' THEN
    RAISE EXCEPTION 'FAIL 74e: the base answered %', got;
  END IF;

  -- Where a good row comes before the bad one, the refusal still names the
  -- bad row. Each call runs in t74_load's own subtransaction, so the count
  -- after the loop checks that handler, not the load's atomicity.
  FOR c IN SELECT * FROM (VALUES
    ('[]', 'TY024 a catalogue file is one JSON object of sections: sizes, brands, patterns, casing_estimates and price_list'),
    ('{"sizes": [{"name": "T74 E2"}], "size": []}', 'TY024 ''size'' is not a section; the sections are sizes, brands, patterns, casing_estimates and price_list'),
    ('{"sizes": {"name": "T74 E3"}}', 'TY024 sizes is not a list; each section is a JSON array of rows'),
    ('{"brands": ["T74 E4"]}', 'TY024 brands row 1 is not an object; each row is a JSON object of fields'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_valeu": "1800.00", "effective_from": "2026-02-01"}]}',
     'TY024 casing_estimates row 1: ''estimated_valeu'' is not a field; the fields are size, estimated_value, effective_from'),
    ('{"brands": [{}]}', 'TY024 brands row 1: name is required'),
    ('{"sizes": [{"name": 315}]}', 'TY024 sizes row 1: name is written as a JSON string'),
    ('{"sizes": [{"name": " T74 E8"}]}', 'TY024 sizes row 1: name '' T74 E8'' is empty or begins or ends with white space'),
    ('{"sizes": [{"name": "T74 E9", "construction": "BIAS"}]}', 'TY024 sizes row 1: construction is RADIAL or CROSS_PLY, not ''BIAS'''),
    ('{"patterns": [{"name": "T74 E10"}]}', 'TY024 patterns row 1: applies_to is required'),
    ('{"patterns": [{"name": "T74 E11", "applies_to": "USED"}]}', 'TY024 patterns row 1: applies_to is NEW, RETREAD or BOTH, not ''USED'''),
    ('{"sizes": [{"name": "T74 E12"}, {"name": "315/80R22.5"}]}',
     'TY024 sizes row 2: this fleet already has the size ''315/80R22.5''; a load adds rows and never changes one'),
    ('{"brands": [{"name": "T74 E13"}, {"name": "T74 E13"}]}',
     'TY024 brands row 2: the name ''T74 E13'' repeats brands row 1; a file names each entry once'),
    ('{"casing_estimates": [{"size": "999/99R99", "estimated_value": "1.00", "effective_from": "2026-02-01"}]}',
     'TY024 casing_estimates row 1: this fleet has no size named ''999/99R99'''),
    ('{"price_list": [{"size": "315/80R22.5", "brand": "T74 NO BRAND", "typical_price": "1.00", "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: this fleet has no brand named ''T74 NO BRAND'''),
    ('{"patterns": [{"name": "T74 E16", "brand": "T74 NO BRAND", "applies_to": "NEW"}]}',
     'TY024 patterns row 1: this fleet has no brand named ''T74 NO BRAND'''),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": 1800, "effective_from": "2026-02-01"}]}',
     'TY024 casing_estimates row 1: estimated_value is a JSON number; write the amount as a string, such as "1837.50", so nothing reads it as a float'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.005", "effective_from": "2026-02-01"}]}',
     'TY024 casing_estimates row 1: estimated_value ''1800.005'' has more than two decimal places; a load never rounds an amount'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": "-1.00", "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price ''-1.00'' is negative'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": "10000000000.00", "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price ''10000000000.00'' is above 9999999999.99, the most an amount can hold'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": "1,800.00", "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price ''1,800.00'' is not an amount in rand, such as "1837.50"'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": true, "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price is written as a JSON string, such as "1837.50"'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.00"}]}',
     'TY024 casing_estimates row 1: effective_from is required'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.00", "effective_from": 20260201}]}',
     'TY024 casing_estimates row 1: effective_from is written as a JSON string, such as "2026-11-01"'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.00", "effective_from": "2026-02-30"}]}',
     'TY024 casing_estimates row 1: effective_from ''2026-02-30'' is not a date written YYYY-MM-DD'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1800.00", "effective_from": "01/02/2026"}]}',
     'TY024 casing_estimates row 1: effective_from ''01/02/2026'' is not a date written YYYY-MM-DD'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1900.00", "effective_from": "2026-01-01"}]}',
     'TY024 casing_estimates row 1: the size ''315/80R22.5'' already has a casing estimate effective 2026-01-01; a change is a new row with a later effective_from'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1.00", "effective_from": "2099-03-01"},
                            {"size": "315/80R22.5", "estimated_value": "2.00", "effective_from": "2099-03-01"}]}',
     'TY024 casing_estimates row 2: the size ''315/80R22.5'' effective 2099-03-01 repeats casing_estimates row 1'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1900.00", "effective_from": "2026-03-01"}]}',
     'TY024 casing_estimates row 1: the size ''315/80R22.5'' already has a casing estimate, so a new one is dated today (UTC) or later; one effective 2026-03-01 would re-price valuations already computed'),
    ('{"casing_estimates": [{"size": "225/70R19.5", "estimated_value": "1.00", "effective_from": "2026-02-01"},
                            {"size": "225/70R19.5", "estimated_value": "2.00", "effective_from": "2026-03-01"}]}',
     'TY024 casing_estimates row 2: the size ''225/70R19.5'' already has a casing estimate, so a new one is dated today (UTC) or later; one effective 2026-03-01 would re-price valuations already computed'),
    (E'{"sizes": [{"name": "T74 E34\u00a0"}]}', 'TY024 sizes row 1: name ''T74 E34' || chr(160) || ''' is empty or begins or ends with white space'),
    (E'{"brands": [{"name": "\u200bT74 E35"}]}', 'TY024 brands row 1: name ''' || chr(8203) || 'T74 E35'' is empty or begins or ends with white space'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": "' || repeat('9', 140000) || '", "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price ''' || repeat('9', 140000) || ''' is above 9999999999.99, the most an amount can hold'),
    ('{"price_list": [{"size": "315/80R22.5", "typical_price": "4100.00", "effective_from": "2026-01-01"}]}',
     'TY024 price_list row 1: the size ''315/80R22.5'' already has a price with no brand effective 2026-01-01; a change is a new row with a later effective_from'),
    ('{"price_list": [{"size": "315/80R22.5", "brand": "Dunlop", "typical_price": "1.00", "effective_from": "2026-03-01"},
                      {"size": "315/80R22.5", "brand": "Dunlop", "typical_price": "2.00", "effective_from": "2026-03-01"}]}',
     'TY024 price_list row 2: the size ''315/80R22.5'' for the brand ''Dunlop'' effective 2026-03-01 repeats price_list row 1'),
    ('{"sizes": [{"name": "T74 E31"}],
       "price_list": [{"size": "T74 E31", "typical_price": 5, "effective_from": "2026-02-01"}]}',
     'TY024 price_list row 1: typical_price is a JSON number; write the amount as a string, such as "1837.50", so nothing reads it as a float')
  ) AS v(payload, expected) LOOP
    got := pg_temp.t74_load(c.payload::jsonb);
    IF got IS DISTINCT FROM c.expected THEN
      bad := bad || format(E'\n  file %s answered %s', c.payload, got);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FAIL 74e: %', bad;
  END IF;
  IF pg_temp.t74_counts() <> '4/3/3/1/1' THEN
    RAISE EXCEPTION 'FAIL 74e: the refused files left the catalogue at %, not the base 4/3/3/1/1', pg_temp.t74_counts();
  END IF;
  RAISE NOTICE 'PASS  74e every file refusal is TY024 naming its section, row and reason';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  -- Two rows of Second Fleet's own whose names are platform names. The seed
  -- lists both and adopts neither.
  INSERT INTO app.tyre_brand (tenant_id, name) VALUES (t2, 'Evergreen');
  INSERT INTO app.tyre_size (tenant_id, name) VALUES (t2, '11R22.5');
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'TY025 this fleet already has its own brand ''Evergreen'', size ''11R22.5''; a platform entry never adopts a row by name, so nothing was seeded'
     OR pg_temp.t74_counts() <> '1/1/0/0/0' THEN
    RAISE EXCEPTION 'FAIL 74e: a seed over the fleet''s own Evergreen and 11R22.5 answered % and left %', got, pg_temp.t74_counts();
  END IF;
  -- The control: renamed, the same two rows clash with nothing, and the
  -- seed lands in full beside them.
  UPDATE app.tyre_brand SET name = 'Evergreen (own)' WHERE name = 'Evergreen';
  UPDATE app.tyre_size SET name = '11R22.5 (own)' WHERE name = '11R22.5';
  got := pg_temp.t74_seed();
  IF got IS DISTINCT FROM 'seeded 10' OR pg_temp.t74_counts() <> '5/4/3/0/0' THEN
    RAISE EXCEPTION 'FAIL 74e: the seed after the rename answered % and left %', got, pg_temp.t74_counts();
  END IF;
  RAISE NOTICE 'PASS  74e a seed over a name the fleet holds as its own is TY025 listing every such name, and adopts none';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE t2    constant uuid := '22222222-2222-2222-2222-222222222222';
        today constant date := (now() AT TIME ZONE 'UTC')::date;
        got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  -- A tyre of 11R22.5, which has no estimate yet.
  got := pg_temp.t74_seed();
  PERFORM app.receive_tyres(jsonb_build_object(
    'display_code', 'T74E-1',
    'size_id', (SELECT s.id FROM app.tyre_size s WHERE s.name = '11R22.5'),
    'pattern_id', (SELECT p.id FROM app.tyre_pattern p WHERE p.name = 'SP431'),
    'new_tread_mm', '20.0',
    'received_date', to_char(today - 10, 'YYYY-MM-DD')));
  got := got || ' | ' || pg_temp.t74_load(
    '{"casing_estimates": [{"size": "11R22.5", "estimated_value": "1800.00", "effective_from": "2026-01-01"}]}');
  IF got IS DISTINCT FROM 'seeded 10 | TY024 casing_estimates row 1: this fleet already holds tyres of the size ''11R22.5'', so its first casing estimate is dated today (UTC) or later; one effective 2026-01-01 would re-price valuations already computed' THEN
    RAISE EXCEPTION 'FAIL 74e: a back-dated first estimate for a size the fleet holds a tyre of answered %', got;
  END IF;
  -- The controls: the same estimate dated today loads, and a back-dated
  -- first estimate for a size with no tyre loads.
  got := pg_temp.t74_load(jsonb_build_object('casing_estimates', jsonb_build_array(
           jsonb_build_object('size', '11R22.5', 'estimated_value', '1800.00',
                              'effective_from', to_char(today, 'YYYY-MM-DD')))))
         || ' | ' || pg_temp.t74_load(
           '{"casing_estimates": [{"size": "185/65R15", "estimated_value": "000000000001.00", "effective_from": "2026-01-01"}]}');
  IF got IS DISTINCT FROM 'sizes=0 brands=0 patterns=0 casing_estimates=1 price_list=0 | sizes=0 brands=0 patterns=0 casing_estimates=1 price_list=0'
     OR pg_temp.t74_counts() <> '4/3/3/2/0' THEN
    RAISE EXCEPTION 'FAIL 74e: an estimate dated today, and a first one for a size with no tyre, answered % and left %',
      got, pg_temp.t74_counts();
  END IF;
  -- FR-CFG-042, U135: an estimate or a price is never rewritten in place.
  IF has_any_column_privilege(current_user, 'app.casing_estimate_by_size', 'UPDATE')
     OR has_any_column_privilege(current_user, 'app.tyre_price_list', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 74e: the app role can UPDATE a casing estimate or a price row';
  END IF;
  RAISE NOTICE 'PASS  74e an estimate dated before today is TY024 once its size has an estimate or the fleet holds a tyre of it, and the app role cannot rewrite one (FR-CFG-051, U135)';
END $$;
ROLLBACK;

DO $$
DECLARE c record; got text; st text; msg text; bad text := '';
BEGIN
  -- A key repeated at any depth is refused before the cast (TYRE-369).
  FOR c IN SELECT * FROM (VALUES
    ('{"price_list": [{"size": "315/80R22.5"}], "price_list": []}',
     'TY024 a key repeats inside one object of the file, and only its last value would load; name each section and each field once'),
    ('{"casing_estimates": [{"size": "315/80R22.5", "estimated_value": "1837.50", "estimated_value": "183.75", "effective_from": "2026-01-01"}]}',
     'TY024 a key repeats inside one object of the file, and only its last value would load; name each section and each field once'),
    (chr(65279) || '{"sizes": [{"name": "T74 BOM"}]}', '{"sizes": [{"name": "T74 BOM"}]}'),
    ('not json', '22P02 invalid input syntax for type json')
  ) AS v(txt, expected) LOOP
    BEGIN
      got := app.catalogue_file_parse(c.txt)::text;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
      got := st || ' ' || msg;
    END;
    IF got IS DISTINCT FROM c.expected THEN
      bad := bad || format(E'\n  text %s answered %s', c.txt, got);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'FAIL 74e: %', bad;
  END IF;
  RAISE NOTICE 'PASS  74e a file whose text repeats a key, at any depth, is TY024 before it becomes jsonb, and a leading byte-order mark is dropped';
END $$;

\echo '== 74f. the price list keeps one row per size, brand and date, a missing brand counting as one value (FR-CFG-040; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        sz  constant uuid := md5('t74f-size')::uuid;
        br  constant uuid := md5('t74f-brand')::uuid;
        got text; st text; con text;
BEGIN
  SELECT string_agg(c.conname || ' ' || pg_get_constraintdef(c.oid), '; ') INTO got
    FROM pg_constraint c WHERE c.conrelid = 'app.tyre_price_list'::regclass AND c.contype = 'u';
  IF got IS DISTINCT FROM 'tyre_price_list_one_row_per_date UNIQUE NULLS NOT DISTINCT (tenant_id, size_id, brand_id, effective_from)' THEN
    RAISE EXCEPTION 'FAIL 74f: the price list''s unique keys are %', got;
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.tyre_size (id, tenant_id, name) VALUES (sz, t2, 'T74F SIZE');
  INSERT INTO app.tyre_brand (id, tenant_id, name) VALUES (br, t2, 'T74F BRAND');
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (t2, sz, NULL, 4000.00, '2026-01-01');
  BEGIN
    INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
    VALUES (t2, sz, NULL, 4100.00, '2026-01-01');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, con = CONSTRAINT_NAME;
  END;
  IF st IS DISTINCT FROM '23505' OR con IS DISTINCT FROM 'tyre_price_list_one_row_per_date' THEN
    RAISE EXCEPTION 'FAIL 74f: a second brandless price for one size and date was answered %',
      COALESCE(st || ' on ' || COALESCE(NULLIF(con, ''), 'no constraint'), 'by a stored row');
  END IF;
  -- The control: a branded row on that date and a brandless row on another
  -- both land, so the key refused the pair and nothing else.
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (t2, sz, br, 4200.00, '2026-01-01'), (t2, sz, NULL, 4300.00, '2026-02-01');
  IF (SELECT count(*) FROM app.tyre_price_list) <> 3 THEN
    RAISE EXCEPTION 'FAIL 74f: the control rows did not land';
  END IF;
  RAISE NOTICE 'PASS  74f two brandless prices for one size and date are refused by tyre_price_list_one_row_per_date';
END $$;
ROLLBACK;

\echo '== 74g. a seeded size''s tyre, received, fitted and inspected, values ESTIMATED at the per-size figure from the estimate''s date, and UNVALUED the day before (FR-CFG-043, FR-TYR-008, CR-012, FR-VAL-020; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        drv constant uuid := md5('driver2')::uuid;
        cfg constant uuid := md5('22222222-2222-2222-2222-222222222222TRAILER_2AXLE')::uuid;
        -- A unit of its own, so FR-INS-038's window cannot refuse the submit,
        -- and a trailer, which owes no fitment odometer (TY009).
        v   constant uuid := md5('t74g-unit')::uuid;
        today date := (now() AT TIME ZONE 'UTC')::date;
        ty uuid; pos uuid; got text; r record;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  -- The estimate is dated two days back, after the inspection six days
  -- back, so one tyre shows both sides of the date.
  got := pg_temp.t74_seed() || ' ' || pg_temp.t74_load(jsonb_build_object('casing_estimates', jsonb_build_array(
           jsonb_build_object('size', '315/80R22.5', 'estimated_value', '2150.00',
                              'effective_from', to_char(today - 2, 'YYYY-MM-DD')))));
  IF got IS DISTINCT FROM 'seeded 10 sizes=0 brands=0 patterns=0 casing_estimates=1 price_list=0' THEN
    RAISE EXCEPTION 'FAIL 74g: the seed and load answered %', got;
  END IF;

  -- Second Fleet is FREE, so the receive names its code. Every instant is
  -- in the past: received ten days back, fitted eight, inspected six.
  SELECT rt.tyre_id INTO ty FROM app.receive_tyres(jsonb_build_object(
    'display_code', 'T74G-1',
    'size_id', (SELECT s.id FROM app.tyre_size s WHERE s.name = '315/80R22.5'),
    'pattern_id', (SELECT p.id FROM app.tyre_pattern p WHERE p.name = 'SP431'),
    'new_tread_mm', '20.0',
    'received_date', to_char(today - 10, 'YYYY-MM-DD'))) rt;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (v, t2, 'T74-G', 'CAA747401', cfg, 'TRAILER', 'ACTIVE');
  SELECT p.id INTO pos FROM app.position p
   WHERE p.configuration_id = cfg AND NOT p.is_spare ORDER BY p.sequence LIMIT 1;
  PERFORM app.fit_tyre(ty, v, pos, 20.0, 'MARK_OUTBOARD', NULL, now() - interval '8 days',
                       'recorded late for suite section 74g');
  PERFORM set_config('app.actor_id', drv::text, true);
  PERFORM app.submit_inspection(jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', v,
    'started_at', now() - interval '6 days' - interval '150 seconds',
    'submitted_at', now() - interval '6 days',
    'readings', jsonb_build_array(jsonb_build_object(
      'vehicle_id', v, 'position_id', pos, 'tyre_id', ty, 'pressure_kpa', 800,
      'treads', jsonb_build_array(12.0, 13.0, 14.0)))));

  -- The day before the estimate's date: the reading prices the tread, and
  -- the casing has no figure of any kind.
  SELECT a.tread_source, a.current_tread_mm, a.casing_value, a.casing_basis INTO r
    FROM app.tyre_valuation_asof(today - 3) a WHERE a.tyre_id = ty;
  IF r.tread_source IS DISTINCT FROM 'READING' OR r.current_tread_mm IS DISTINCT FROM 12.0
     OR r.casing_value IS NOT NULL OR r.casing_basis IS DISTINCT FROM 'UNVALUED' THEN
    RAISE EXCEPTION 'FAIL 74g: the day before the estimate reads % / % / % / %',
      r.tread_source, r.current_tread_mm, r.casing_value, r.casing_basis;
  END IF;
  -- On the estimate's date and after, the per-size figure, labelled.
  SELECT string_agg(a.casing_value || ':' || a.casing_basis, ' ' ORDER BY d.n) INTO got
    FROM unnest(ARRAY[today - 2, today]) WITH ORDINALITY AS d(at, n)
    CROSS JOIN LATERAL app.tyre_valuation_asof(d.at) a
   WHERE a.tyre_id = ty;
  IF got IS DISTINCT FROM '2150.00:ESTIMATED 2150.00:ESTIMATED' THEN
    RAISE EXCEPTION 'FAIL 74g: on and after the estimate''s date the casing reads %', got;
  END IF;
  RAISE NOTICE 'PASS  74g a seeded size''s casing is UNVALUED the day before its estimate and ESTIMATED at 2150.00 from that date';
END $$;
ROLLBACK;

\echo '== 74h. nothing section 74 planted outlives its rollback'
DO $$
DECLARE n int;
BEGIN
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  IF pg_temp.t74_counts() <> '0/0/0/0/0' THEN
    RAISE EXCEPTION 'FAIL 74h: Second Fleet''s catalogue reads % after section 74', pg_temp.t74_counts();
  END IF;
  SELECT (SELECT count(*) FROM app.vehicle WHERE id = md5('t74g-unit')::uuid)
       + (SELECT count(*) FROM app.tyre WHERE display_code IN ('T74G-1', 'T74E-1')) INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL 74h: % rows planted by 74e or 74g survived their rollback', n;
  END IF;
  RAISE NOTICE 'PASS  74h section 74 leaves no residue';
END $$;
DROP FUNCTION pg_temp.t74_seed();
DROP FUNCTION pg_temp.t74_load(jsonb);
DROP FUNCTION pg_temp.t74_counts();

\echo '== 75. TYRE-283: consent has one writer and a current view, a fleet is metric, tread age counts the fleet''s days, the settings views show what is in force, a receive takes its estimate from the price list and makes a receipt, and a receipt is priced once (FR-TEN-021, FR-TEN-022, FR-CFG-012, FR-CFG-021, FR-CFG-040 to 042, FR-TYR-017, FR-TYR-040, FR-TYR-041)'

-- One statement, answered 'ok' or 'SQLSTATE message'. The handler is the
-- subtransaction a refused statement rolls back to, so a refusal leaves the
-- check's transaction as it was.
CREATE FUNCTION pg_temp.t75_try(p_sql text) RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE st text; msg text;
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  RETURN st || ' ' || msg;
END $fn$;

-- BAC's price rows for 315/80R22.5, planted in the caller's transaction: a
-- size-only row superseded on 2026-09-01, one dated past any test date, and
-- a Dunlop row in force from 2026-06-01. No fixture tenant has a price list.
CREATE FUNCTION pg_temp.t75_prices() RETURNS void
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from) VALUES
    ('11111111-1111-1111-1111-111111111111', md5('sz1')::uuid, NULL, 3000.00, '2026-01-01'),
    ('11111111-1111-1111-1111-111111111111', md5('sz1')::uuid, NULL, 3500.00, '2026-09-01'),
    ('11111111-1111-1111-1111-111111111111', md5('sz1')::uuid, NULL, 9999.00, '2099-01-01'),
    ('11111111-1111-1111-1111-111111111111', md5('sz1')::uuid, md5('br1')::uuid, 4319.91, '2026-06-01');
$fn$;

-- One receive, answered with its receipt's id. The receipt is read in a
-- statement after the receive's, whose snapshot predates its own inserts.
CREATE FUNCTION pg_temp.t75_receive(p_payload jsonb) RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE first_tyre uuid; rc uuid;
BEGIN
  SELECT q.tyre_id INTO first_tyre FROM app.receive_tyres(p_payload) q LIMIT 1;
  SELECT t.receipt_id INTO rc FROM app.tyre t WHERE t.id = first_tyre;
  RETURN rc;
END $fn$;

\echo '== 75a. app.record_consent writes one row for the bound fleet with no actor, refuses each bad input and a time not after the purpose''s latest record (U144) as TY027, and the app role can neither edit nor delete a row (FR-TEN-022, OR-LEG-005, ADR-0012; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2 constant uuid := '22222222-2222-2222-2222-222222222222';
        nofleet constant uuid := md5('t75a-no-fleet')::uuid;
        cid uuid; r record; got text; e record;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  cid := app.record_consent('SERVICE_DELIVERY', true, 'T75 MSA v1', '2026-10-01T08:00:00Z');
  SELECT c.* INTO r FROM app.tenant_consent c WHERE c.id = cid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL 75a: the writer returned % and no row of that id is visible', cid;
  END IF;
  IF (r.tenant_id, r.purpose_code, r.granted, r.notice_version, r.actor_id, r.occurred_at, r.created_at)
     IS DISTINCT FROM (t2, 'SERVICE_DELIVERY', true, 'T75 MSA v1', NULL::uuid,
                       '2026-10-01T08:00:00Z'::timestamptz, now()) THEN
    RAISE EXCEPTION 'FAIL 75a: the recorded row reads %', row_to_json(r);
  END IF;
  cid := app.record_consent('ANONYMISED_BENCHMARKING', false, 'T75 MSA v1');
  IF (SELECT c.occurred_at FROM app.tenant_consent c WHERE c.id = cid) IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'FAIL 75a: a record with no time given is dated %, not now()',
      (SELECT c.occurred_at FROM app.tenant_consent c WHERE c.id = cid);
  END IF;

  PERFORM set_config('app.tenant_id', '', true);
  got := pg_temp.t75_try($q$SELECT app.record_consent('SERVICE_DELIVERY', true, 'T75 MSA v1')$q$);
  IF got IS DISTINCT FROM 'TY027 a consent record needs app.tenant_id bound to the fleet it records for' THEN
    RAISE EXCEPTION 'FAIL 75a: a record with no tenant bound was answered %', got;
  END IF;
  PERFORM set_config('app.tenant_id', nofleet::text, true);
  got := pg_temp.t75_try($q$SELECT app.record_consent('SERVICE_DELIVERY', true, 'T75 MSA v1')$q$);
  IF got IS DISTINCT FROM format('TY027 app.tenant_id %s names no fleet', nofleet) THEN
    RAISE EXCEPTION 'FAIL 75a: a record bound to no fleet was answered %', got;
  END IF;
  PERFORM set_config('app.tenant_id', t2::text, true);

  FOR e IN SELECT * FROM (VALUES
    ('a purpose outside the vocabulary',
     $q$SELECT app.record_consent('MARKETING', true, 'T75 MSA v1')$q$,
     $q$TY027 'MARKETING' is not a consent purpose; the purposes are SERVICE_DELIVERY and ANONYMISED_BENCHMARKING$q$),
    ('no granted or withdrawn',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', NULL, 'T75 MSA v1')$q$,
     'TY027 a consent record states whether consent was granted or withdrawn'),
    ('an empty notice version',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', true, '')$q$,
     'TY027 a consent record names the notice version the client signed'),
    ('a blank notice version',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', true, '  ')$q$,
     'TY027 a consent record names the notice version the client signed'),
    ('no notice version',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', true, NULL)$q$,
     'TY027 a consent record names the notice version the client signed'),
    ('no time',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', true, 'T75 MSA v1', NULL)$q$,
     'TY027 a consent record states when consent was given'),
    ('a future time',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', true, 'T75 MSA v1', now() + interval '1 minute')$q$,
     'TY027 consent is recorded as given now or earlier, never at a future time'),
    -- U144: the purpose's latest row is cid's, at 2026-10-01T08:00Z.
    ('the time of the purpose''s latest record',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', false, 'T75 MSA v2', '2026-10-01T08:00:00Z')$q$,
     format('TY027 the latest SERVICE_DELIVERY consent record is dated %s; a new one is dated after it',
            '2026-10-01T08:00:00Z'::timestamptz)),
    ('a time before the purpose''s latest record',
     $q$SELECT app.record_consent('SERVICE_DELIVERY', false, 'T75 MSA v2', '2026-09-01T00:00:00Z')$q$,
     format('TY027 the latest SERVICE_DELIVERY consent record is dated %s; a new one is dated after it',
            '2026-10-01T08:00:00Z'::timestamptz))
  ) v(what, stmt, want) LOOP
    got := pg_temp.t75_try(e.stmt);
    IF got IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL 75a: % was answered %', e.what, got;
    END IF;
  END LOOP;

  got := pg_temp.t75_try($q$INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version)
                           VALUES ('22222222-2222-2222-2222-222222222222', 'MARKETING', true, 'T75 MSA v1')$q$);
  IF got NOT LIKE '23514 %"tenant_consent_purpose_code_check"%' THEN
    RAISE EXCEPTION 'FAIL 75a: a direct insert of an unknown purpose was answered %', got;
  END IF;
  got := pg_temp.t75_try(format('UPDATE app.tenant_consent SET granted = false WHERE id = %L', cid));
  IF got NOT LIKE '42501 %' THEN
    RAISE EXCEPTION 'FAIL 75a: the app role''s UPDATE of a consent row was answered %', got;
  END IF;
  got := pg_temp.t75_try(format('DELETE FROM app.tenant_consent WHERE id = %L', cid));
  IF got NOT LIKE '42501 %' THEN
    RAISE EXCEPTION 'FAIL 75a: the app role''s DELETE of a consent row was answered %', got;
  END IF;
  -- The grant refuses the app role first; P14 proves the trigger behind it.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                  WHERE tg.tgrelid = 'app.tenant_consent'::regclass
                    AND tg.tgname = 'tenant_consent_written_once'
                    AND tg.tgenabled = 'O'
                    AND tg.tgfoid = 'app.tenant_consent_is_written_once()'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL 75a: tenant_consent_written_once is missing, disabled or calls another function';
  END IF;
  RAISE NOTICE 'PASS  75a the writer records one row with no actor, refuses each bad input as TY027, and the app role cannot edit or delete it';
END $$;
ROLLBACK;

\echo '== 75b. the current-consent view gives the latest row per fleet and purpose by when consent was given, then when it was recorded, a recorded NULL last, for rows a direct insert can leave out of order; a purpose never recorded is absent, and another fleet sees none of it (FR-TEN-022; as Second Fleet, rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM app.record_consent('ANONYMISED_BENCHMARKING', true,  'T75 v1', '2026-09-01T00:00:00Z');
  PERFORM app.record_consent('ANONYMISED_BENCHMARKING', false, 'T75 v2', '2026-10-01T00:00:00Z');
  -- Recorded last, given first: when it was given decides, not when it
  -- was recorded. The writer refuses this (U144, 75a), so it is inserted
  -- directly, as app_rw's INSERT grant allows (000012).
  INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, occurred_at)
  VALUES (t2, 'ANONYMISED_BENCHMARKING', true, 'T75 v0', '2026-08-01T00:00:00Z');
  SELECT string_agg(v.purpose_code || ':' || v.granted || ':' || v.notice_version, ' ' ORDER BY v.purpose_code)
    INTO got FROM app.v_tenant_consent_current v WHERE v.tenant_id = t2;
  IF got IS DISTINCT FROM 'ANONYMISED_BENCHMARKING:false:T75 v2' THEN
    RAISE EXCEPTION 'FAIL 75b: after a grant, a withdrawal and a back-dated grant the view reads %', got;
  END IF;

  INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, occurred_at, created_at) VALUES
    (t2, 'ANONYMISED_BENCHMARKING', true,  'T75 tie later',   '2026-10-05T00:00:00Z', '2026-10-03T00:00:00Z'),
    (t2, 'ANONYMISED_BENCHMARKING', false, 'T75 tie earlier', '2026-10-05T00:00:00Z', '2026-10-02T00:00:00Z'),
    (t2, 'ANONYMISED_BENCHMARKING', false, 'T75 tie undated', '2026-10-05T00:00:00Z', NULL);
  SELECT string_agg(v.purpose_code || ':' || v.granted || ':' || v.notice_version, ' ' ORDER BY v.purpose_code)
    INTO got FROM app.v_tenant_consent_current v WHERE v.tenant_id = t2;
  IF got IS DISTINCT FROM 'ANONYMISED_BENCHMARKING:true:T75 tie later' THEN
    RAISE EXCEPTION 'FAIL 75b: three rows given at one instant resolve to %, not the latest recorded', got;
  END IF;

  PERFORM set_config('app.tenant_id', bac::text, true);
  IF EXISTS (SELECT 1 FROM app.v_tenant_consent_current)
     OR EXISTS (SELECT 1 FROM app.tenant_consent) THEN
    RAISE EXCEPTION 'FAIL 75b: bound to BAC, the view or the ledger shows a consent row';
  END IF;
  RAISE NOTICE 'PASS  75b the view gives the latest row by given then recorded time, omits an unrecorded purpose, and another fleet sees none of it';
END $$;
ROLLBACK;

\echo '== 75c. tenant_metric_units holds every fleet to KPA and KM, and every fixture fleet is metric (FR-CFG-021)'
DO $$
DECLARE got text := '';
        tid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = 'app.tenant'::regclass
                    AND c.conname = 'tenant_metric_units'
                    AND c.contype = 'c' AND c.convalidated) THEN
    RAISE EXCEPTION 'FAIL 75c: app.tenant carries no validated check named tenant_metric_units';
  END IF;
  FOREACH tid IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111',
                             '22222222-2222-2222-2222-222222222222',
                             '33333333-3333-3333-3333-333333333333']::uuid[] LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    got := got || COALESCE((SELECT t.pressure_unit || '/' || t.distance_unit FROM app.tenant t WHERE t.id = tid), 'none') || ' ';
  END LOOP;
  IF got IS DISTINCT FROM 'KPA/KM KPA/KM KPA/KM ' THEN
    RAISE EXCEPTION 'FAIL 75c: the fixture fleets'' units read %', got;
  END IF;
  RAISE NOTICE 'PASS  75c tenant_metric_units is validated and every fixture fleet is KPA and KM';
END $$;

\echo '== 75d. app.tenant_days_since counts days in the bound fleet''s calendar, and answers NULL for no instant or no fleet (FR-TYR-017, rule 6; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        tz text; midnight timestamptz;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  IF tz IS NULL THEN
    RAISE EXCEPTION 'FAIL 75d: BAC''s timezone is not visible';
  END IF;
  midnight := app.tenant_today(tz)::timestamp AT TIME ZONE tz;
  IF app.tenant_days_since(now()) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 75d: now is % days ago', app.tenant_days_since(now());
  END IF;
  IF app.tenant_days_since(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 75d: no instant gives %', app.tenant_days_since(NULL);
  END IF;
  IF app.tenant_days_since(((app.tenant_today(tz) - 3)::timestamp AT TIME ZONE tz) + interval '12 hours') IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'FAIL 75d: noon three fleet days back gives %',
      app.tenant_days_since(((app.tenant_today(tz) - 3)::timestamp AT TIME ZONE tz) + interval '12 hours');
  END IF;
  -- One second either side of the fleet's midnight, so a UTC calendar or a
  -- 24-hour count fails here.
  IF app.tenant_days_since(midnight - interval '1 second') IS DISTINCT FROM 1
     OR app.tenant_days_since(midnight + interval '1 second') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL 75d: either side of the fleet''s midnight gives % and %',
      app.tenant_days_since(midnight - interval '1 second'), app.tenant_days_since(midnight + interval '1 second');
  END IF;
  PERFORM set_config('app.tenant_id', '', true);
  IF app.tenant_days_since(now()) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 75d: with no fleet bound, now gives %', app.tenant_days_since(now());
  END IF;
  RAISE NOTICE 'PASS  75d tread age counts the bound fleet''s calendar days and is NULL with no instant or no fleet';
END $$;
ROLLBACK;

\echo '== 75e. the settings views show each policy scope''s row in force now and each price list row in force on the fleet''s today, while the table keeps what they supersede (FR-CFG-012, FR-CFG-042; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        got text; n_view int; n_scopes int;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.threshold_policy (tenant_id, retread_threshold_mm, warning_threshold_mm, max_retreads, effective_from)
  VALUES (bac, 5.0, 7.0, 1, now()), (bac, 6.0, 8.0, 1, now() + interval '1 day');
  SELECT v.retread_threshold_mm || '/' || v.warning_threshold_mm || '/' || v.max_retreads INTO got
    FROM app.v_threshold_policy_in_force v
   WHERE v.tenant_id = bac AND v.operating_group_id IS NULL AND v.axle_class IS NULL;
  IF got IS DISTINCT FROM '5.0/7.0/1' THEN
    RAISE EXCEPTION 'FAIL 75e: BAC''s fleet-wide row in force reads %', got;
  END IF;
  SELECT count(*) INTO n_view FROM app.v_threshold_policy_in_force v WHERE v.tenant_id = bac;
  SELECT count(DISTINCT (p.operating_group_id, p.axle_class)) INTO n_scopes
    FROM app.threshold_policy p WHERE p.tenant_id = bac AND p.effective_from <= now();
  IF n_view <> n_scopes OR n_scopes < 2 THEN
    RAISE EXCEPTION 'FAIL 75e: the view holds % rows for % scopes in force', n_view, n_scopes;
  END IF;

  PERFORM pg_temp.t75_prices();
  SELECT string_agg(v.size_name || ':' || COALESCE(v.brand_name, '-') || ':' || v.typical_price || ':' || v.effective_from,
                    ' ' ORDER BY v.brand_name NULLS FIRST)
    INTO got FROM app.v_tyre_price_list_in_force v WHERE v.tenant_id = bac;
  IF got IS DISTINCT FROM '315/80R22.5:-:3500.00:2026-09-01 315/80R22.5:Dunlop:4319.91:2026-06-01' THEN
    RAISE EXCEPTION 'FAIL 75e: BAC''s price list in force reads %', got;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tyre_price_list p
                  WHERE p.tenant_id = bac AND p.brand_id IS NULL AND p.typical_price = 3000.00) THEN
    RAISE EXCEPTION 'FAIL 75e: the superseded 3000.00 row is gone from the table';
  END IF;
  RAISE NOTICE 'PASS  75e the views show the rows in force per scope and per size and brand, and the table keeps the superseded row';
END $$;
ROLLBACK;

\echo '== 75f. app.price_list_estimate takes a brand row over a size-only row whatever their dates, the latest row on or before the date within each, the brand from the pattern when one is named, and the fleet''s today for no date (FR-CFG-040, FR-CFG-041; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        br1 constant uuid := md5('br1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        tz text; e record; got text; today_got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = bac;
  PERFORM pg_temp.t75_prices();
  FOR e IN SELECT * FROM (VALUES
    ('Dunlop on 2026-10-20, where a later size-only row exists', br1, '2026-10-20'::date, NULL::uuid, '4319.91:2026-06-01:' || br1),
    ('Dunlop on 2026-03-01, before its own row',                 br1, '2026-03-01'::date, NULL::uuid, '3000.00:2026-01-01:-'),
    ('any brand on 2026-10-20',                                  NULL, '2026-10-20'::date, NULL::uuid, '3500.00:2026-09-01:-'),
    ('Dunlop on 2025-12-31, before every row',                   br1, '2025-12-31'::date, NULL::uuid, NULL),
    ('no brand but SP431, on 2026-10-20',                        NULL, '2026-10-20'::date, pt1, '4319.91:2026-06-01:' || br1)
  ) v(what, brand, on_date, pattern, want) LOOP
    SELECT p.typical_price || ':' || p.effective_from || ':' || COALESCE(p.brand_id::text, '-') INTO got
      FROM app.price_list_estimate(sz1, e.brand, e.on_date, e.pattern) p;
    IF got IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL 75f: % gives %, not %', e.what, COALESCE(got, 'no row'), COALESCE(e.want, 'no row');
    END IF;
  END LOOP;
  SELECT p.typical_price || ':' || p.effective_from INTO got FROM app.price_list_estimate(sz1, br1, NULL) p;
  SELECT p.typical_price || ':' || p.effective_from INTO today_got
    FROM app.price_list_estimate(sz1, br1, app.tenant_today(tz)) p;
  IF got IS DISTINCT FROM today_got OR got IS NULL THEN
    RAISE EXCEPTION 'FAIL 75f: no date gives %, the fleet''s today gives %', got, today_got;
  END IF;
  SELECT p.typical_price::text INTO got FROM app.price_list_estimate(sz1, NULL, NULL) p;
  IF got IS DISTINCT FROM '3500.00' THEN
    RAISE EXCEPTION 'FAIL 75f: any brand today gives %, where the row dated 2099 must not be chosen', got;
  END IF;
  RAISE NOTICE 'PASS  75f the match takes a brand row first, the latest on or before the date, the pattern''s brand, and the fleet''s today for no date';
END $$;
ROLLBACK;

\echo '== 75g. a receive at a price list estimate stores the list''s figure and refuses any other, an invoice number comes only with an invoice price, and every receive makes one receipt holding what defined its set (FR-CFG-041, FR-TYR-040 as amended by TYRE-418; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz1 constant uuid := md5('sz1')::uuid;
        br1 constant uuid := md5('br1')::uuid;
        pt1 constant uuid := md5('pt1')::uuid;
        dp1 constant uuid := md5('depot1')::uuid;
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        r record; t app.tyre; rc app.tyre_receipt; got text; e record; n int; ids uuid[];
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();

  SELECT * INTO r FROM app.receive_tyres(base || jsonb_build_object(
    'purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE'));
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS DISTINCT FROM 4319.91 OR t.cost_source IS DISTINCT FROM 'PRICE_LIST_ESTIMATE'
     OR t.rand_per_mm IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, 4.0) THEN
    RAISE EXCEPTION 'FAIL 75g: a list-price receive stored price %, source %, rate %',
      t.purchase_price, t.cost_source, t.rand_per_mm;
  END IF;
  SELECT * INTO rc FROM app.tyre_receipt WHERE id = t.receipt_id;
  IF NOT FOUND OR rc.price_state IS DISTINCT FROM 'ESTIMATED' OR rc.invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 75g: the list-price receive''s receipt is % with invoice number %',
      COALESCE(rc.price_state::text, 'missing'), rc.invoice_number;
  END IF;

  FOR e IN SELECT * FROM (VALUES
    ('an estimate off the list',
     base || jsonb_build_object('purchase_price', '4319.90', 'cost_source', 'PRICE_LIST_ESTIMATE'),
     'TY011 the price list estimate for this size and brand on 2026-10-01 is 4319.91; a price list estimate is received at that figure, and any other figure is an invoice price'),
    ('an estimate with no row in force',
     base || jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE',
                                'received_date', '2025-12-31'),
     'TY011 this size and brand have no price list entry in force on 2025-12-31, so the tyres cannot be received at a price list estimate; enter the invoice price, or leave the price blank'),
    ('an invoice number with no price',
     base || jsonb_build_object('cost_source', 'UNKNOWN', 'invoice_number', 'INV-1'),
     'TY011 an invoice number is recorded with an invoice price; enter the price from the invoice, or leave the invoice number blank'),
    ('an invoice number with an estimate',
     base || jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE',
                                'invoice_number', 'INV-1'),
     'TY011 an invoice number is recorded with an invoice price; enter the price from the invoice, or leave the invoice number blank')
  ) v(what, payload, want) LOOP
    got := pg_temp.t75_try(format('SELECT app.receive_tyres(%L::jsonb)', e.payload));
    IF got IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL 75g: % was answered %', e.what, got;
    END IF;
  END LOOP;

  SELECT * INTO r FROM app.receive_tyres(base || jsonb_build_object(
    'purchase_price', '4100.00', 'cost_source', 'INVOICE', 'invoice_number', ' INV-0042 '));
  SELECT c.* INTO rc FROM app.tyre_receipt c JOIN app.tyre x ON x.receipt_id = c.id WHERE x.id = r.tyre_id;
  IF rc.price_state IS DISTINCT FROM 'INVOICED' OR rc.invoice_number IS DISTINCT FROM 'INV-0042' THEN
    RAISE EXCEPTION 'FAIL 75g: an invoice receive''s receipt is % holding %', rc.price_state, rc.invoice_number;
  END IF;

  -- Three unpriced tyres from one depot, the brand left to SP431's own.
  -- The ids are read first: a statement that joins the receive's result to
  -- app.tyre reads a snapshot taken before the receive's own inserts.
  SELECT array_agg(q.tyre_id) INTO ids
    FROM app.receive_tyres(base || jsonb_build_object('quantity', 3, 'depot_id', dp1)) q;
  SELECT count(DISTINCT x.receipt_id) || '/' || count(*) || '/' || count(x.receipt_id) INTO got
    FROM app.tyre x WHERE x.id = ANY (ids);
  IF got IS DISTINCT FROM '1/3/3' THEN
    RAISE EXCEPTION 'FAIL 75g: a receive of three reads receipts/tyres/linked %', got;
  END IF;
  SELECT c.* INTO rc FROM app.tyre_receipt c
   WHERE c.id = (SELECT x.receipt_id FROM app.tyre x WHERE x.id = ids[1]);
  IF (rc.price_state, rc.size_id, rc.brand_id, rc.pattern_id, rc.received_date, rc.depot_id, rc.tenant_id)
     IS DISTINCT FROM ('UNPRICED'::app.receipt_price_state, sz1, br1, pt1, '2026-10-01'::date, dp1, bac) THEN
    RAISE EXCEPTION 'FAIL 75g: the unpriced receipt holds %', row_to_json(rc);
  END IF;
  SELECT count(*) INTO n FROM app.tyre_receipt;
  IF n <> 3 THEN
    RAISE EXCEPTION 'FAIL 75g: three receives landed and % receipts exist', n;
  END IF;
  RAISE NOTICE 'PASS  75g an estimate is the list''s figure or refused, an invoice number needs an invoice price, and each receive makes one receipt of its set';
END $$;
ROLLBACK;

\echo '== 75h. a receipt moves only UNPRICED to ESTIMATED or INVOICED and ESTIMATED to INVOICED or ESTIMATE_KEPT, never from a final state, never ahead of its tyres'' prices, with its invoice number only on the invoice; a tyre''s receipt never changes; and the app role edits nothing else (FR-CFG-041, CR-012, rule 1; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        unpriced uuid; staged uuid; listed uuid; ty uuid; got text; e record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();
  -- Each receive's tyre is read in a statement of its own, after the one
  -- that inserted it (75g).
  SELECT q.tyre_id INTO ty FROM app.receive_tyres(base || jsonb_build_object('quantity', 2)) q LIMIT 1;
  SELECT x.receipt_id INTO unpriced FROM app.tyre x WHERE x.id = ty;
  SELECT q.tyre_id INTO staged FROM app.receive_tyres(base) q;
  SELECT x.receipt_id INTO staged FROM app.tyre x WHERE x.id = staged;
  SELECT q.tyre_id INTO listed
    FROM app.receive_tyres(base || jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE')) q;
  SELECT x.receipt_id INTO listed FROM app.tyre x WHERE x.id = listed;
  -- The staged receipt's tyre carries an estimate, so only the invoice
  -- number rule can refuse its move.
  UPDATE app.tyre SET purchase_price = 4319.91, cost_source = 'PRICE_LIST_ESTIMATE' WHERE receipt_id = staged;

  FOR e IN SELECT * FROM (VALUES
    ('a tyre''s receipt cleared',
     format('UPDATE app.tyre SET receipt_id = NULL WHERE id = %L', ty),
     'TY026 a tyre''s receipt is set when it is received and never changes'),
    ('a tyre moved to another receipt',
     format('UPDATE app.tyre SET receipt_id = %L WHERE id = %L', listed, ty),
     'TY026 a tyre''s receipt is set when it is received and never changes'),
    ('UNPRICED to ESTIMATE_KEPT',
     format('UPDATE app.tyre_receipt SET price_state = ''ESTIMATE_KEPT'' WHERE id = %L', unpriced),
     'TY026 a receipt moves from UNPRICED to ESTIMATE_KEPT only through its own moves'),
    ('UNPRICED to itself',
     format('UPDATE app.tyre_receipt SET price_state = ''UNPRICED'' WHERE id = %L', unpriced),
     'TY026 a receipt moves from UNPRICED to UNPRICED only through its own moves'),
    ('an invoice number on a move to ESTIMATED',
     format('UPDATE app.tyre_receipt SET price_state = ''ESTIMATED'', invoice_number = ''X'' WHERE id = %L', staged),
     'TY026 an invoice number is recorded with the receipt''s invoice'),
    ('INVOICED ahead of its tyres',
     format('UPDATE app.tyre_receipt SET price_state = ''INVOICED'' WHERE id = %L', unpriced),
     'TY026 a receipt is INVOICED only once every tyre on it still in the fleet carries that price; move it through its own function'),
    ('ESTIMATED ahead of its tyres',
     format('UPDATE app.tyre_receipt SET price_state = ''ESTIMATED'' WHERE id = %L', unpriced),
     'TY026 a receipt is ESTIMATED only once every tyre on it still in the fleet carries that price; move it through its own function')
  ) v(what, stmt, want) LOOP
    got := pg_temp.t75_try(e.stmt);
    IF got IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL 75h: % was answered %', e.what, got;
    END IF;
  END LOOP;
  IF (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = unpriced) <> 'UNPRICED'
     OR (SELECT x.receipt_id FROM app.tyre x WHERE x.id = ty) IS DISTINCT FROM unpriced THEN
    RAISE EXCEPTION 'FAIL 75h: a refused move left the receipt or its tyre changed';
  END IF;

  -- The trigger's control: an allowed move whose tyres carry its price.
  UPDATE app.tyre_receipt SET price_state = 'ESTIMATE_KEPT' WHERE id = listed;
  got := pg_temp.t75_try(format('UPDATE app.tyre_receipt SET price_state = ''INVOICED'' WHERE id = %L', listed));
  IF got IS DISTINCT FROM 'TY026 this receipt''s price is final and does not change' THEN
    RAISE EXCEPTION 'FAIL 75h: a move from ESTIMATE_KEPT was answered %', got;
  END IF;

  FOR e IN SELECT * FROM (VALUES
    ('its size',  format('UPDATE app.tyre_receipt SET size_id = size_id WHERE id = %L', unpriced)),
    ('its depot', format('UPDATE app.tyre_receipt SET depot_id = NULL WHERE id = %L', unpriced)),
    ('a delete',  format('DELETE FROM app.tyre_receipt WHERE id = %L', unpriced))
  ) v(what, stmt) LOOP
    got := pg_temp.t75_try(e.stmt);
    IF got NOT LIKE '42501 %' THEN
      RAISE EXCEPTION 'FAIL 75h: the app role''s write to % was answered %', e.what, got;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class c
                  WHERE c.oid = 'app.tyre_receipt'::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_policy p
                     WHERE p.polrelid = 'app.tyre_receipt'::regclass
                       AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 75h: app.tyre_receipt is not RLS forced with a USING and WITH CHECK policy';
  END IF;
  RAISE NOTICE 'PASS  75h each move outside the four, ahead of its tyres or from a final state is TY026, a tyre''s receipt is fixed, and the app role edits only the state and invoice number';
END $$;
ROLLBACK;

\echo '== 75i. set_tyre_cost sends a received tyre to its receipt as TY013, refuses a NaN cost, and still costs a tyre with no receipt (FR-CFG-041, FR-TYR-041; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        r record; t app.tyre; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  SELECT * INTO r FROM app.receive_tyres(jsonb_build_object(
    'size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid, 'new_tread_mm', '25.0',
    'received_date', '2026-10-01'));
  got := pg_temp.t75_try(format('SELECT app.set_tyre_cost(%L, 4319.91, ''INVOICE'')', r.tyre_id));
  IF got IS DISTINCT FROM 'TY013 this tyre was received on a receipt, so its price is recorded on the receipt for the whole set; open the receipt to record it' THEN
    RAISE EXCEPTION 'FAIL 75i: costing a received tyre was answered %', got;
  END IF;
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date)
  VALUES (app.current_tenant_id(), 'T75I-NO-RECEIPT', md5('sz1')::uuid, md5('br1')::uuid, md5('pt1')::uuid,
          'NEW', 0, 25.0, 'IN_STOCK', '2026-10-01')
  RETURNING id AS tyre_id INTO r;
  got := pg_temp.t75_try(format('SELECT app.set_tyre_cost(%L, ''NaN'', ''INVOICE'')', r.tyre_id));
  IF got IS DISTINCT FROM 'TY013 a cost is a non-negative amount' THEN
    RAISE EXCEPTION 'FAIL 75i: a NaN cost was answered %', got;
  END IF;
  PERFORM app.set_tyre_cost(r.tyre_id, 4319.91, 'INVOICE');
  SELECT * INTO t FROM app.tyre WHERE id = r.tyre_id;
  IF t.purchase_price IS DISTINCT FROM 4319.91 OR t.cost_source IS DISTINCT FROM 'INVOICE'
     OR t.rand_per_mm IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, 4.0) THEN
    RAISE EXCEPTION 'FAIL 75i: a tyre with no receipt was costed at %, %, rate %',
      t.purchase_price, t.cost_source, t.rand_per_mm;
  END IF;
  RAISE NOTICE 'PASS  75i a received tyre is sent to its receipt, a NaN cost is refused and a tyre with no receipt is costed';
END $$;
ROLLBACK;

\echo '== 75j. applying the list price prices every tyre on an unpriced receipt at the match for the receipt''s own size, brand and date, keeps a retreaded tyre''s rate, files each write in the audit log, and is refused with no row in force or a NaN entry (FR-CFG-041, FR-TYR-019, FR-AUD-001; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        br2 constant uuid := md5('t75j-br2')::uuid;
        pt2 constant uuid := md5('t75j-pt2')::uuid;
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        rc uuid; first_tyre uuid; got text; n int;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();

  rc := pg_temp.t75_receive(base || jsonb_build_object('quantity', 3));
  SELECT m.priced || '/' || m.left_fleet INTO got FROM app.apply_receipt_list_price(rc) m;
  IF got IS DISTINCT FROM '3/0' THEN
    RAISE EXCEPTION 'FAIL 75j: the list price on three unpriced tyres answered %', got;
  END IF;
  SELECT string_agg(t.purchase_price || ':' || t.cost_source || ':'
                    || (t.rand_per_mm = app.rand_per_mm(4319.91, 25.0, 4.0)), ' ' ORDER BY t.display_code)
    INTO got FROM app.tyre t WHERE t.receipt_id = rc;
  IF got IS DISTINCT FROM '4319.91:PRICE_LIST_ESTIMATE:true 4319.91:PRICE_LIST_ESTIMATE:true 4319.91:PRICE_LIST_ESTIMATE:true'
     OR (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc) IS DISTINCT FROM 'ESTIMATED' THEN
    RAISE EXCEPTION 'FAIL 75j: after the list price the tyres read % and the receipt %',
      got, (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc);
  END IF;
  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.entity_type = 'tyre_receipt' AND a.entity_id = rc AND a.action = 'UPDATE' AND a.actor_id = md5('controller1')::uuid;
  SELECT n || '/' || count(*) || '/' || count(DISTINCT a.entity_id) INTO got
    FROM app.audit_log a JOIN app.tyre t ON t.id = a.entity_id
   WHERE a.entity_type = 'tyre' AND a.action = 'UPDATE' AND t.receipt_id = rc;
  IF got IS DISTINCT FROM '1/3/3' THEN
    RAISE EXCEPTION 'FAIL 75j: the move filed receipt/tyre/distinct tyre UPDATE entries %', got;
  END IF;

  rc := pg_temp.t75_receive(base || jsonb_build_object('received_date', '2025-12-31'));
  got := pg_temp.t75_try(format('SELECT app.apply_receipt_list_price(%L)', rc));
  IF got IS DISTINCT FROM 'TY026 no price list entry for this size and brand was in force on 2025-12-31, the day these tyres were received; record the invoice price instead' THEN
    RAISE EXCEPTION 'FAIL 75j: the list price with no row in force was answered %', got;
  END IF;
  IF (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc) IS DISTINCT FROM 'UNPRICED'
     OR EXISTS (SELECT 1 FROM app.tyre t WHERE t.receipt_id = rc AND t.purchase_price IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL 75j: a refused list price moved the receipt or priced a tyre';
  END IF;

  -- The receipt decides the match, not a tyre: the tyre a move reading
  -- tyres would read first is re-patterned onto another brand with a far
  -- higher price, and the set is still priced at Dunlop's.
  INSERT INTO app.tyre_brand (id, tenant_id, name) VALUES (br2, bac, 'T75J OTHER');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, brand_id, applies_to) VALUES (pt2, bac, 'T75J RETREAD', br2, 'RETREAD');
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (bac, md5('sz1')::uuid, br2, 9000.00, '2026-01-01');
  rc := pg_temp.t75_receive(base || jsonb_build_object('quantity', 3));
  SELECT t.id INTO first_tyre FROM app.tyre t WHERE t.receipt_id = rc ORDER BY t.display_code LIMIT 1;
  UPDATE app.tyre SET status = 'RETREAD', retread_count = 1, pattern_id = pt2, brand_id = br2, rand_per_mm = 150.0000
   WHERE id = first_tyre;
  SELECT m.priced || '/' || m.left_fleet INTO got FROM app.apply_receipt_list_price(rc) m;
  IF got IS DISTINCT FROM '3/0' THEN
    RAISE EXCEPTION 'FAIL 75j: the list price on a set with a retreaded tyre answered %', got;
  END IF;
  SELECT string_agg(t.purchase_price || ':' || t.rand_per_mm, ' ' ORDER BY t.display_code) INTO got
    FROM app.tyre t WHERE t.receipt_id = rc;
  IF got IS DISTINCT FROM format('4319.91:150.0000 4319.91:%1$s 4319.91:%1$s',
                                 app.rand_per_mm(4319.91, 25.0, 4.0)::numeric(12,4)) THEN
    RAISE EXCEPTION 'FAIL 75j: a set whose first tyre was re-patterned reads %', got;
  END IF;

  -- The list's CHECK (>= 0) passes NaN, and only hand-written SQL plants
  -- one; the move refuses it rather than store it on a retreaded tyre.
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (bac, md5('sz1')::uuid, md5('br1')::uuid, 'NaN', '2026-10-02');
  rc := pg_temp.t75_receive(base || jsonb_build_object('received_date', '2026-10-02'));
  got := pg_temp.t75_try(format('SELECT app.apply_receipt_list_price(%L)', rc));
  IF got IS DISTINCT FROM 'TY026 the price list entry in force for this size and brand on 2026-10-02 is not an amount; correct the price list, or record the invoice price instead' THEN
    RAISE EXCEPTION 'FAIL 75j: the list price at a NaN list entry was answered %', got;
  END IF;
  RAISE NOTICE 'PASS  75j the list price follows the receipt''s own match, keeps a retread''s rate, is audited per row, and is refused with no row in force or a NaN entry';
END $$;
ROLLBACK;

\echo '== 75k. recording the invoice prices every tyre still in the fleet at the rounded price as INVOICE, re-rates the unretreaded, dates them by the invoice, leaves a tyre that has left the fleet as it was, and changes nothing when one tyre cannot be rated (FR-CFG-041, FR-TYR-019, FR-VAL-006, CR-012; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        listed constant jsonb := jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE');
        rc uuid; ids uuid[]; got text; want text; code2 text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();

  rc := pg_temp.t75_receive(base || listed || jsonb_build_object('quantity', 3));
  SELECT m.priced || '/' || m.left_fleet INTO got FROM app.record_receipt_invoice(rc, 4500.005, 'INV-7', '2026-10-02') m;
  IF got IS DISTINCT FROM '3/0' THEN
    RAISE EXCEPTION 'FAIL 75k: the invoice on three estimated tyres answered %', got;
  END IF;
  SELECT string_agg(t.purchase_price || ':' || t.cost_source || ':'
                    || (t.rand_per_mm = app.rand_per_mm(4500.01, 25.0, 4.0)) || ':' || t.purchase_date,
                    ' ' ORDER BY t.display_code)
    INTO got FROM app.tyre t WHERE t.receipt_id = rc;
  IF got IS DISTINCT FROM '4500.01:INVOICE:true:2026-10-02 4500.01:INVOICE:true:2026-10-02 4500.01:INVOICE:true:2026-10-02' THEN
    RAISE EXCEPTION 'FAIL 75k: after the invoice the tyres read %', got;
  END IF;
  SELECT c.price_state || ':' || c.invoice_number INTO got FROM app.tyre_receipt c WHERE c.id = rc;
  IF got IS DISTINCT FROM 'INVOICED:INV-7' THEN
    RAISE EXCEPTION 'FAIL 75k: the invoiced receipt reads %', got;
  END IF;

  -- Tyre 2 retreaded, tyre 3 scrapped, all bought on 2026-09-30.
  rc := pg_temp.t75_receive(base || listed || jsonb_build_object('quantity', 3, 'purchase_date', '2026-09-30'));
  SELECT array_agg(t.id ORDER BY t.display_code) INTO ids FROM app.tyre t WHERE t.receipt_id = rc;
  UPDATE app.tyre SET status = 'RETREAD', retread_count = 1, rand_per_mm = 150.0000 WHERE id = ids[2];
  PERFORM app.dispose_tyre(ids[3], 'SCRAPPED', 'T75K', NULL, now());
  SELECT m.priced || '/' || m.left_fleet INTO got FROM app.record_receipt_invoice(rc, 5000.00, NULL, '2026-10-03') m;
  IF got IS DISTINCT FROM '2/1' THEN
    RAISE EXCEPTION 'FAIL 75k: the invoice on a set with a scrapped tyre answered %', got;
  END IF;
  SELECT string_agg(t.purchase_price || ':' || t.cost_source || ':' || t.rand_per_mm || ':' || t.purchase_date,
                    ' ' ORDER BY t.display_code)
    INTO got FROM app.tyre t WHERE t.receipt_id = rc;
  want := format('5000.00:INVOICE:%s:2026-10-03 5000.00:INVOICE:150.0000:2026-10-03 4319.91:PRICE_LIST_ESTIMATE:%s:2026-09-30',
                 app.rand_per_mm(5000.00, 25.0, 4.0)::numeric(12,4), app.rand_per_mm(4319.91, 25.0, 4.0)::numeric(12,4));
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 75k: re-rated, retreaded and scrapped tyres read %, not %', got, want;
  END IF;

  -- All or nothing: the second tyre cannot be rated, so the first, written
  -- before it, is rolled back with it.
  rc := pg_temp.t75_receive(base || listed || jsonb_build_object('quantity', 2));
  SELECT array_agg(t.id ORDER BY t.display_code) INTO ids FROM app.tyre t WHERE t.receipt_id = rc;
  UPDATE app.tyre SET new_tread_mm = 3.0 WHERE id = ids[2];
  SELECT t.display_code INTO code2 FROM app.tyre t WHERE t.id = ids[2];
  got := pg_temp.t75_try(format('SELECT app.record_receipt_invoice(%L, 4500.00)', rc));
  IF got IS DISTINCT FROM format('TY013 tyre %s''s new tread of 3.0 mm does not exceed the removal threshold of 4.0 mm, so its cost cannot be rated; check the removal threshold configured', code2) THEN
    RAISE EXCEPTION 'FAIL 75k: an invoice one tyre cannot be rated at was answered %', got;
  END IF;
  SELECT string_agg(t.purchase_price || ':' || t.cost_source, ' ' ORDER BY t.display_code) || ' '
         || (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc)
    INTO got FROM app.tyre t WHERE t.receipt_id = rc;
  IF got IS DISTINCT FROM '4319.91:PRICE_LIST_ESTIMATE 4319.91:PRICE_LIST_ESTIMATE ESTIMATED' THEN
    RAISE EXCEPTION 'FAIL 75k: a refused invoice left the set and receipt reading %', got;
  END IF;

  -- A receipt whose tyres have all left the fleet still takes its invoice.
  rc := pg_temp.t75_receive(base || listed || jsonb_build_object('quantity', 2));
  SELECT array_agg(t.id ORDER BY t.display_code) INTO ids FROM app.tyre t WHERE t.receipt_id = rc;
  PERFORM app.dispose_tyre(ids[1], 'SCRAPPED', 'T75K', NULL, now());
  PERFORM app.dispose_tyre(ids[2], 'SCRAPPED', 'T75K', NULL, now());
  SELECT m.priced || '/' || m.left_fleet INTO got FROM app.record_receipt_invoice(rc, 4500.00) m;
  IF got IS DISTINCT FROM '0/2' OR (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc) IS DISTINCT FROM 'INVOICED' THEN
    RAISE EXCEPTION 'FAIL 75k: an invoice on a set wholly gone answered % and left the receipt %',
      got, (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = rc);
  END IF;

  rc := pg_temp.t75_receive(base);
  PERFORM app.record_receipt_invoice(rc, '1234567.89');
  SELECT string_agg(t.purchase_price::text, ' ') INTO got FROM app.tyre t WHERE t.receipt_id = rc;
  IF got IS DISTINCT FROM '1234567.89' THEN
    RAISE EXCEPTION 'FAIL 75k: 1234567.89 was stored as %', got;
  END IF;
  RAISE NOTICE 'PASS  75k the invoice prices and re-rates the set still in the fleet, keeps a retread''s rate and a scrapped tyre''s estimate, is all or nothing, and round-trips to the cent';
END $$;
ROLLBACK;

\echo '== 75l. keeping the estimate writes no tyre, and each move is refused from a state it does not start from, for a bad price or a future invoice date, and for a receipt not in this fleet (FR-CFG-041, ADR-0012; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        listed constant jsonb := jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE');
        nowhere constant uuid := md5('t75l-no-receipt')::uuid;
        r_un uuid; r_est uuid; r_inv uuid; r_inv2 uuid; r_kept uuid;
        before_j jsonb; after_j jsonb; got text; e record; n int;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();

  r_kept := pg_temp.t75_receive(base || listed || jsonb_build_object('quantity', 2));
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO before_j FROM app.tyre t WHERE t.receipt_id = r_kept;
  PERFORM app.keep_receipt_estimate(r_kept);
  SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) INTO after_j FROM app.tyre t WHERE t.receipt_id = r_kept;
  SELECT count(*) INTO n FROM app.audit_log a JOIN app.tyre t ON t.id = a.entity_id
   WHERE a.entity_type = 'tyre' AND a.action = 'UPDATE' AND t.receipt_id = r_kept;
  IF before_j IS DISTINCT FROM after_j OR n <> 0
     OR (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = r_kept) IS DISTINCT FROM 'ESTIMATE_KEPT' THEN
    RAISE EXCEPTION 'FAIL 75l: keeping the estimate rewrote a tyre (% audit entries) or left the receipt %',
      n, (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = r_kept);
  END IF;

  r_un  := pg_temp.t75_receive(base);
  r_est := pg_temp.t75_receive(base || listed);
  r_inv := pg_temp.t75_receive(base || jsonb_build_object('purchase_price', '4100.00', 'cost_source', 'INVOICE'));
  -- The invoice's control: an unpriced receipt takes one directly.
  r_inv2 := pg_temp.t75_receive(base);
  PERFORM app.record_receipt_invoice(r_inv2, 4100.00);
  IF (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = r_inv2) IS DISTINCT FROM 'INVOICED' THEN
    RAISE EXCEPTION 'FAIL 75l: an unpriced receipt did not take its invoice';
  END IF;

  FOR e IN SELECT * FROM (VALUES
    ('the list price on ESTIMATED',     format('SELECT app.apply_receipt_list_price(%L)', r_est),  'TY026 only an unpriced receipt takes the list price'),
    ('the list price on INVOICED',      format('SELECT app.apply_receipt_list_price(%L)', r_inv),  'TY026 only an unpriced receipt takes the list price'),
    ('the list price on ESTIMATE_KEPT', format('SELECT app.apply_receipt_list_price(%L)', r_kept), 'TY026 only an unpriced receipt takes the list price'),
    ('a keep on UNPRICED',              format('SELECT app.keep_receipt_estimate(%L)', r_un),      'TY026 only a receipt priced from the price list can keep its estimate'),
    ('a keep on INVOICED',              format('SELECT app.keep_receipt_estimate(%L)', r_inv),     'TY026 only a receipt priced from the price list can keep its estimate'),
    ('a keep on ESTIMATE_KEPT',         format('SELECT app.keep_receipt_estimate(%L)', r_kept),    'TY026 only a receipt priced from the price list can keep its estimate'),
    ('an invoice on a receipt received with one', format('SELECT app.record_receipt_invoice(%L, 4200.00)', r_inv),  'TY026 this receipt''s price is final and does not change'),
    ('a second invoice',                format('SELECT app.record_receipt_invoice(%L, 4200.00)', r_inv2), 'TY026 this receipt''s price is final and does not change'),
    ('an invoice on ESTIMATE_KEPT',     format('SELECT app.record_receipt_invoice(%L, 4200.00)', r_kept), 'TY026 this receipt''s price is final and does not change'),
    ('no invoice price',                format('SELECT app.record_receipt_invoice(%L, NULL)', r_est),     'TY026 an invoice price is a non-negative amount'),
    ('a negative invoice price',        format('SELECT app.record_receipt_invoice(%L, -1.00)', r_est),    'TY026 an invoice price is a non-negative amount'),
    ('a NaN invoice price',             format('SELECT app.record_receipt_invoice(%L, ''NaN'')', r_est),  'TY026 an invoice price is a non-negative amount'),
    ('an invoice dated 2099-01-01',     format('SELECT app.record_receipt_invoice(%L, 4200.00, NULL, ''2099-01-01'')', r_est),
                                        'TY026 an invoice is dated today or earlier, never in the future'),
    ('the list price on no receipt',    format('SELECT app.apply_receipt_list_price(%L)', nowhere),        'TY012 no such receipt in this fleet'),
    ('a keep on no receipt',            format('SELECT app.keep_receipt_estimate(%L)', nowhere),           'TY012 no such receipt in this fleet'),
    ('an invoice on no receipt',        format('SELECT app.record_receipt_invoice(%L, 4200.00)', nowhere), 'TY012 no such receipt in this fleet')
  ) v(what, stmt, want) LOOP
    got := pg_temp.t75_try(e.stmt);
    IF got IS DISTINCT FROM e.want THEN
      RAISE EXCEPTION 'FAIL 75l: % was answered %', e.what, got;
    END IF;
  END LOOP;
  IF (SELECT c.price_state FROM app.tyre_receipt c WHERE c.id = r_est) IS DISTINCT FROM 'ESTIMATED' THEN
    RAISE EXCEPTION 'FAIL 75l: a refused invoice moved the estimated receipt';
  END IF;
  RAISE NOTICE 'PASS  75l keeping the estimate writes no tyre, and every move outside its starting state, with a bad price or date, or on no receipt is refused';
END $$;
ROLLBACK;

\echo '== 75m. another fleet''s receipt is no receipt here: an invoice and a keep that would succeed if seen are TY012, its rows stay as they were, and the open list shows none of it (FR-TEN-003, NFR-SEC-004, docs/lessons.md 2026-09-01; rolled back)'
BEGIN;
DO $$
DECLARE t2  constant uuid := '22222222-2222-2222-2222-222222222222';
        bac constant uuid := '11111111-1111-1111-1111-111111111111';
        sz2 constant uuid := md5('t75m-sz')::uuid;
        pt2 constant uuid := md5('t75m-pt')::uuid;
        rc_un uuid; rc_est uuid; before_j jsonb; after_j jsonb; got text;
BEGIN
  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  INSERT INTO app.tyre_size (id, tenant_id, name) VALUES (sz2, t2, 'T75M SIZE');
  INSERT INTO app.tyre_pattern (id, tenant_id, name, applies_to) VALUES (pt2, t2, 'T75M NEW', 'NEW');
  INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from)
  VALUES (t2, sz2, NULL, 1000.00, '2026-01-01');
  rc_un := pg_temp.t75_receive(jsonb_build_object('size_id', sz2, 'pattern_id', pt2, 'new_tread_mm', '25.0',
                                                  'received_date', '2026-10-01', 'display_code', 'T75M-1'));
  rc_est := pg_temp.t75_receive(jsonb_build_object('size_id', sz2, 'pattern_id', pt2, 'new_tread_mm', '25.0',
                                                   'received_date', '2026-10-01', 'display_code', 'T75M-2',
                                                   'purchase_price', '1000.00', 'cost_source', 'PRICE_LIST_ESTIMATE'));
  SELECT jsonb_build_object(
           'receipts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.tyre_receipt c WHERE c.id IN (rc_un, rc_est)),
           'tyres', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM app.tyre t WHERE t.receipt_id IN (rc_un, rc_est)))
    INTO before_j;
  IF rc_un IS NULL OR rc_est IS NULL OR jsonb_array_length(before_j->'tyres') <> 2 THEN
    RAISE EXCEPTION 'FAIL 75m: Second Fleet''s two receipts were not planted, so the probes prove nothing';
  END IF;

  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  got := pg_temp.t75_try(format('SELECT app.record_receipt_invoice(%L, 1100.00)', rc_un));
  IF got IS DISTINCT FROM 'TY012 no such receipt in this fleet' THEN
    RAISE EXCEPTION 'FAIL 75m: BAC''s invoice on Second Fleet''s receipt was answered %', got;
  END IF;
  got := pg_temp.t75_try(format('SELECT app.keep_receipt_estimate(%L)', rc_est));
  IF got IS DISTINCT FROM 'TY012 no such receipt in this fleet' THEN
    RAISE EXCEPTION 'FAIL 75m: BAC''s keep on Second Fleet''s receipt was answered %', got;
  END IF;
  IF EXISTS (SELECT 1 FROM app.v_open_tyre_receipt v WHERE v.receipt_id IN (rc_un, rc_est) OR v.tenant_id = t2) THEN
    RAISE EXCEPTION 'FAIL 75m: bound to BAC, the open list shows Second Fleet''s receipts';
  END IF;

  PERFORM set_config('app.tenant_id', t2::text, true);
  PERFORM set_config('app.actor_id', '', true);
  SELECT jsonb_build_object(
           'receipts', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.tyre_receipt c WHERE c.id IN (rc_un, rc_est)),
           'tyres', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM app.tyre t WHERE t.receipt_id IN (rc_un, rc_est)))
    INTO after_j;
  IF before_j IS DISTINCT FROM after_j THEN
    RAISE EXCEPTION 'FAIL 75m: Second Fleet''s receipts or tyres changed under BAC''s probes';
  END IF;
  RAISE NOTICE 'PASS  75m another fleet''s receipt is TY012 to an invoice and a keep, stays as it was, and is absent from the open list';
END $$;
ROLLBACK;

\echo '== 75n. the open list shows each UNPRICED and ESTIMATED receipt once, from its own columns, with its tyres counted, its codes in natural order and its unit price (FR-CFG-041; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE bac constant uuid := '11111111-1111-1111-1111-111111111111';
        planted constant uuid := md5('t75n-receipt')::uuid;
        base constant jsonb := jsonb_build_object('size_id', md5('sz1')::uuid, 'pattern_id', md5('pt1')::uuid,
                                                  'new_tread_mm', '25.0', 'received_date', '2026-10-01');
        listed constant jsonb := jsonb_build_object('purchase_price', '4319.91', 'cost_source', 'PRICE_LIST_ESTIMATE');
        r_est uuid; r_kept uuid; ids uuid[]; codes text; got text; want text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', md5('controller1')::text, true);
  PERFORM pg_temp.t75_prices();

  -- The receipt names Dunlop and its tyres name none, so the brand shown
  -- is the receipt's.
  INSERT INTO app.tyre_receipt (id, tenant_id, size_id, brand_id, pattern_id, received_date, price_state)
  VALUES (planted, bac, md5('sz1')::uuid, md5('br1')::uuid, md5('pt1')::uuid, '2026-09-15', 'UNPRICED');
  INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
                        new_tread_mm, state, received_date, receipt_id) VALUES
    (bac, 'T75-10', md5('sz1')::uuid, NULL, md5('pt1')::uuid, 'NEW', 0, 25.0, 'IN_STOCK', '2026-09-15', planted),
    (bac, 'T75-9',  md5('sz1')::uuid, NULL, md5('pt1')::uuid, 'NEW', 0, 25.0, 'IN_STOCK', '2026-09-15', planted);

  -- One tyre scrapped before the list price, so it stays unpriced.
  r_est := pg_temp.t75_receive(base || jsonb_build_object('quantity', 2));
  SELECT array_agg(t.id ORDER BY t.display_code), string_agg(t.display_code, ',' ORDER BY length(t.display_code), t.display_code)
    INTO ids, codes FROM app.tyre t WHERE t.receipt_id = r_est;
  PERFORM app.dispose_tyre(ids[1], 'SCRAPPED', 'T75N', NULL, now());
  PERFORM app.apply_receipt_list_price(r_est);

  PERFORM pg_temp.t75_receive(base || jsonb_build_object('purchase_price', '4100.00', 'cost_source', 'INVOICE'));
  r_kept := pg_temp.t75_receive(base || listed);
  PERFORM app.keep_receipt_estimate(r_kept);

  SELECT string_agg(v.price_state || ':' || v.received_date || ':' || v.size_name || ':' || COALESCE(v.brand_name, '-')
                    || ':' || v.pattern_name || ':' || v.quantity || ':' || v.in_fleet
                    || ':' || array_to_string(v.display_codes, ',') || ':' || COALESCE(v.unit_price::text, '-'),
                    ' ' ORDER BY v.price_state::text)
    INTO got FROM app.v_open_tyre_receipt v WHERE v.tenant_id = bac;
  want := 'ESTIMATED:2026-10-01:315/80R22.5:Dunlop:SP431:2:1:' || codes || ':4319.91'
          || ' UNPRICED:2026-09-15:315/80R22.5:Dunlop:SP431:2:2:T75-9,T75-10:-';
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL 75n: the open list reads %, not %', got, want;
  END IF;
  RAISE NOTICE 'PASS  75n the open list shows UNPRICED and ESTIMATED receipts once each, from their own columns, codes in natural order, with the unit price';
END $$;
ROLLBACK;

\echo '== 75o. nothing section 75 planted outlives its rollback'
DO $$
DECLARE got text := '';
        tid uuid;
BEGIN
  FOREACH tid IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111',
                             '22222222-2222-2222-2222-222222222222',
                             '33333333-3333-3333-3333-333333333333']::uuid[] LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    got := got || (SELECT count(*) FROM app.tenant_consent) || '/'
               || (SELECT count(*) FROM app.tyre_price_list) || '/'
               || (SELECT count(*) FROM app.tyre_receipt) || '/'
               || (SELECT count(*) FROM app.tyre WHERE receipt_id IS NOT NULL) || ' ';
  END LOOP;
  IF got IS DISTINCT FROM '0/0/0/0 0/0/0/0 0/0/0/0 ' THEN
    RAISE EXCEPTION 'FAIL 75o: consent, price, receipt and receipted tyre rows per fixture fleet read %', got;
  END IF;
  RAISE NOTICE 'PASS  75o section 75 leaves no residue';
END $$;
DROP FUNCTION pg_temp.t75_prices();
DROP FUNCTION pg_temp.t75_receive(jsonb);
DROP FUNCTION pg_temp.t75_try(text);

\echo '== 76. TYRE-326: trips, nominations, the responsible driver and the capture window (FR-VEH-007, FR-INS-050 to 053, FR-AUT-005, FR-OFF-015)'

-- BAC's T76 units and users, planted in the caller's transaction so each
-- check's rows roll back with it: eight active horses, a retired and a
-- parked one, a rigid, seven trailers and a disposed one, four drivers, an
-- inactive driver and a controller. Every unit is on HORSE's configuration.
-- Users go first: a check that binds the controller as actor before
-- planting stamps every row's created_by with it.
CREATE FUNCTION pg_temp.t76_units() RETURNS void
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role, active)
  SELECT md5(u.k)::uuid, '11111111-1111-1111-1111-111111111111', u.k || '@example.invalid', u.n,
         u.r::app.user_role, u.a
    FROM (VALUES
      ('t76d1', 'T76 Driver One', 'DRIVER', true), ('t76d2', 'T76 Driver Two', 'DRIVER', true),
      ('t76d3', 'T76 Driver Three', 'DRIVER', true), ('t76d4', 'T76 Driver Four', 'DRIVER', true),
      ('t76di', 'T76 Driver Inactive', 'DRIVER', false), ('t76c', 'T76 Controller', 'CONTROLLER', true)
    ) u(k, n, r, a);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  SELECT md5(v.k)::uuid, '11111111-1111-1111-1111-111111111111', v.f, replace(v.f, '-', '') || ' GP',
         (SELECT x.configuration_id FROM app.vehicle x WHERE x.id = md5('veh1')::uuid),
         v.kind::app.unit_kind, v.st::app.vehicle_status
    FROM (VALUES
      ('t76h1', 'T76-H1', 'HORSE', 'ACTIVE'), ('t76h2', 'T76-H2', 'HORSE', 'ACTIVE'),
      ('t76h3', 'T76-H3', 'HORSE', 'ACTIVE'), ('t76h4', 'T76-H4', 'HORSE', 'ACTIVE'),
      ('t76h5', 'T76-H5', 'HORSE', 'ACTIVE'), ('t76h6', 'T76-H6', 'HORSE', 'ACTIVE'),
      ('t76h7', 'T76-H7', 'HORSE', 'ACTIVE'), ('t76h8', 'T76-H8', 'HORSE', 'ACTIVE'),
      ('t76hd', 'T76-HD', 'HORSE', 'DISPOSED'), ('t76hi', 'T76-HI', 'HORSE', 'INACTIVE'),
      ('t76hp', 'T76-HP', 'HORSE', 'PARKED'), ('t76r1', 'T76-R1', 'RIGID', 'ACTIVE'),
      ('t76t1', 'T76-T1', 'TRAILER', 'ACTIVE'), ('t76t2', 'T76-T2', 'TRAILER', 'ACTIVE'),
      ('t76t3', 'T76-T3', 'TRAILER', 'ACTIVE'), ('t76t4', 'T76-T4', 'TRAILER', 'ACTIVE'),
      ('t76t5', 'T76-T5', 'TRAILER', 'ACTIVE'), ('t76t6', 'T76-T6', 'TRAILER', 'ACTIVE'),
      ('t76t7', 'T76-T7', 'TRAILER', 'ACTIVE'), ('t76td', 'T76-TD', 'TRAILER', 'DISPOSED')
    ) v(k, f, kind, st);
$fn$;

-- Who a task goes to at an instant, as 'display name/via', or 'nobody/-'
-- when no rule answers. task_driver_at and task_responsibility_at are read
-- separately, so the two names disagreeing fails here.
CREATE FUNCTION pg_temp.t76_who(p_task uuid, p_at timestamptz) RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE n int; u uuid; via text; d uuid;
BEGIN
  SELECT count(*) INTO n FROM app.task_responsibility_at(p_task, p_at);
  IF n > 1 THEN
    RAISE EXCEPTION 'FAIL 76: task_responsibility_at(%, %) returned % rows, not at most one', p_task, p_at, n;
  END IF;
  SELECT r.user_id, r.via INTO u, via FROM app.task_responsibility_at(p_task, p_at) r;
  d := app.task_driver_at(p_task, p_at);
  IF d IS DISTINCT FROM u THEN
    RAISE EXCEPTION 'FAIL 76: task_driver_at(%, %) is % but task_responsibility_at names %', p_task, p_at, d, u;
  END IF;
  IF u IS NULL THEN
    RETURN 'nobody/-';
  END IF;
  RETURN (SELECT au.display_name FROM app.app_user au WHERE au.id = u) || '/' || via;
END $fn$;

CREATE FUNCTION pg_temp.t76_expect(p_check text, p_task uuid, p_at timestamptz, p_want text) RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE got text := pg_temp.t76_who(p_task, p_at);
BEGIN
  IF got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL %: the task on % at % goes to %, not %', p_check,
      (SELECT v.fleet_number FROM app.inspection_task k JOIN app.vehicle v ON v.id = k.vehicle_id
        WHERE k.id = p_task), p_at, got, p_want;
  END IF;
END $fn$;

-- A capture payload with one reading at the first running position of each
-- unit named, the first being the payload's own unit (every T76 unit is on
-- HORSE's configuration), and a fresh client_uuid each call.
CREATE FUNCTION pg_temp.t76_capture(p_units uuid[], p_started timestamptz, p_submitted timestamptz)
RETURNS jsonb
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'client_uuid', gen_random_uuid(), 'vehicle_id', p_units[1],
    'started_at', p_started, 'submitted_at', p_submitted,
    'readings', (SELECT jsonb_agg(jsonb_build_object(
                          'vehicle_id', x.u, 'position_id', pos.id, 'pressure_kpa', 800,
                          'treads', jsonb_build_array(8.0, 8.0, 8.0)) ORDER BY x.o)
                   FROM unnest(p_units) WITH ORDINALITY x(u, o)
                   CROSS JOIN LATERAL (
                     SELECT p.id FROM app.position p
                       JOIN app.vehicle v ON v.configuration_id = p.configuration_id
                      WHERE v.id = x.u AND NOT p.is_spare
                      ORDER BY p.sequence LIMIT 1) pos));
$fn$;

-- The own-units answer for a payload, asked as the actor named.
CREATE FUNCTION pg_temp.t76_could(p_payload jsonb, p_actor uuid) RETURNS boolean
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
BEGIN
  PERFORM set_config('app.actor_id', p_actor::text, true);
  RETURN app.actor_could_capture(p_payload);
END $fn$;

\echo '== 76a. a trip and a nomination are tenant rows under forced RLS; the app role inserts both, ends a trip by its two end columns alone, and edits or deletes neither otherwise (rule 1, rule 3; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  t2  constant uuid := '22222222-2222-2222-2222-222222222222';
  xh  constant uuid := md5('t76xh')::uuid;
  xd  constant uuid := md5('t76xd')::uuid;
  xtr uuid; xk uuid; xn uuid;
  n int; got text;
BEGIN
  PERFORM set_config('app.actor_id', '', true);
  SELECT count(*) INTO n FROM pg_class c
   WHERE c.oid IN ('app.trip'::regclass, 'app.inspection_task_nomination'::regclass)
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 2 THEN
    RAISE EXCEPTION 'FAIL 76a: % of the two new tables have RLS enabled and forced', n;
  END IF;
  IF NOT has_table_privilege(current_user, 'app.trip', 'INSERT')
     OR has_table_privilege(current_user, 'app.trip', 'DELETE')
     OR NOT has_column_privilege(current_user, 'app.trip', 'ended_at', 'UPDATE')
     OR NOT has_column_privilege(current_user, 'app.trip', 'ended_by', 'UPDATE')
     OR has_column_privilege(current_user, 'app.trip', 'started_at', 'UPDATE')
     OR has_column_privilege(current_user, 'app.trip', 'vehicle_id', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL 76a: the app role''s trip grants are not INSERT and UPDATE (ended_at, ended_by) alone';
  END IF;
  IF NOT has_table_privilege(current_user, 'app.inspection_task_nomination', 'INSERT')
     OR has_any_column_privilege(current_user, 'app.inspection_task_nomination', 'UPDATE')
     OR has_table_privilege(current_user, 'app.inspection_task_nomination', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL 76a: the app role''s nomination grants are not INSERT alone';
  END IF;

  -- Thabo holds Second Fleet's open trip, so a driver of its own is planted:
  -- trip_driver_no_overlap would refuse him a second one.
  PERFORM set_config('app.tenant_id', t2::text, true);
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (xh, t2, 'T76-XH', 'T76XH GP',
          (SELECT configuration_id FROM app.vehicle WHERE id = md5('t2veh1')::uuid), 'HORSE', 'ACTIVE');
  INSERT INTO app.app_user (id, tenant_id, email, display_name, role)
  VALUES (xd, t2, 't76xd@example.invalid', 'T76 Foreign Driver', 'DRIVER');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (t2, xh, xd, now() - interval '1 hour') RETURNING id INTO xtr;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (t2, xh, now() + interval '1 day') RETURNING id INTO xk;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
  VALUES (t2, xk, xd) RETURNING id INTO xn;

  PERFORM set_config('app.tenant_id', bac::text, true);
  IF EXISTS (SELECT 1 FROM app.trip WHERE id = xtr)
     OR EXISTS (SELECT 1 FROM app.inspection_task_nomination WHERE id = xn) THEN
    RAISE EXCEPTION 'FAIL 76a: BAC reads Second Fleet''s trip or nomination';
  END IF;
  got := NULL;
  BEGIN
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
    VALUES (t2, xh, xd, now());
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "trip"%' THEN
    RAISE EXCEPTION 'FAIL 76a: a trip naming Second Fleet was answered %, not by trip''s own policy',
      COALESCE(got, 'by an accepted row');
  END IF;
  got := NULL;
  BEGIN
    INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
    VALUES (t2, xk, xd);
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS got = MESSAGE_TEXT;
  END;
  IF got IS NULL OR got NOT LIKE '%row-level security policy for table "inspection_task_nomination"%' THEN
    RAISE EXCEPTION 'FAIL 76a: a nomination naming Second Fleet was answered %, not by the nomination table''s own policy',
      COALESCE(got, 'by an accepted row');
  END IF;
  RAISE NOTICE 'PASS  76a trips and nominations are isolated per tenant under forced RLS; INSERT for both, UPDATE (ended_at, ended_by) on a trip, nothing else';
END $$;
ROLLBACK;

\echo '== 76c. a trip ends once, by its end columns, never in the future and never before it started, and an ended trip never changes; a nomination is never updated or deleted (FR-VEH-007, rule 3, TY028; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  ctl constant uuid := md5('t76c')::uuid;
  tr1 uuid; tr2 uuid; k uuid; nm uuid;
  row_ app.trip;
  n int; st text; msg text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', ctl::text, true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, md5('t76h1')::uuid, md5('t76d1')::uuid, now() - interval '1 hour') RETURNING id INTO tr1;
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, md5('t76h2')::uuid, md5('t76d2')::uuid, now() - interval '1 hour') RETURNING id INTO tr2;

  UPDATE app.trip SET ended_at = now(), ended_by = ctl WHERE id = tr1;
  SELECT * INTO row_ FROM app.trip WHERE id = tr1;
  IF row_.ended_at IS DISTINCT FROM now() OR row_.ended_by IS DISTINCT FROM ctl
     OR row_.updated_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL 76c: the end read back ended_at %, ended_by %, updated_by %',
      row_.ended_at, row_.ended_by, row_.updated_by;
  END IF;
  SELECT count(*) INTO n FROM app.audit_log
   WHERE entity_type = 'trip' AND entity_id = tr1 AND action = 'UPDATE' AND actor_id = ctl;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL 76c: the end filed % UPDATE audit entries under the controller, not one', n;
  END IF;

  FOR st, msg IN
    SELECT * FROM (VALUES
      (format('UPDATE app.trip SET ended_at = now() WHERE id = %L', tr1),
       'TY028 an ended trip is never changed'),
      (format('UPDATE app.trip SET ended_by = %L WHERE id = %L', ctl, tr2),
       'TY028 an open trip can only be ended, never edited'),
      (format('UPDATE app.trip SET ended_at = now() + interval ''1 minute'' WHERE id = %L', tr2),
       'TY028 a trip is ended now or earlier, never in the future'),
      (format('UPDATE app.trip SET started_at = now() WHERE id = %L', tr2),
       '42501 permission denied for table trip'),
      (format('UPDATE app.trip SET ended_at = started_at - interval ''1 minute'' WHERE id = %L', tr2),
       '23514 trip_ends_after_start')
    ) v(s, m)
  LOOP
    DECLARE got_st text; got_msg text; got_con text;
    BEGIN
      BEGIN
        EXECUTE st;
        RAISE EXCEPTION 'FAIL 76c: % was accepted', st;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS got_st = RETURNED_SQLSTATE, got_msg = MESSAGE_TEXT, got_con = CONSTRAINT_NAME;
      END;
      IF got_msg LIKE 'FAIL 76c:%' THEN
        RAISE EXCEPTION '%', got_msg;
      END IF;
      IF (got_st || ' ' || CASE WHEN got_st = '23514' THEN got_con ELSE got_msg END) IS DISTINCT FROM msg THEN
        RAISE EXCEPTION 'FAIL 76c: % answered % %, not %', st, got_st, got_msg, msg;
      END IF;
    END;
  END LOOP;
  SELECT * INTO row_ FROM app.trip WHERE id = tr2;
  IF row_.ended_at IS NOT NULL OR row_.ended_by IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 76c: a refused edit left the open trip ended at % by %', row_.ended_at, row_.ended_by;
  END IF;

  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, md5('t76h3')::uuid, now() + interval '1 day') RETURNING id INTO k;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
  VALUES (bac, k, md5('t76d3')::uuid) RETURNING id INTO nm;
  FOR st IN SELECT * FROM (VALUES
      (format('UPDATE app.inspection_task_nomination SET user_id = %L WHERE id = %L', md5('t76d4')::uuid, nm)),
      (format('DELETE FROM app.inspection_task_nomination WHERE id = %L', nm))) v(s)
  LOOP
    msg := NULL;
    BEGIN
      EXECUTE st;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    END;
    IF msg IS DISTINCT FROM 'permission denied for table inspection_task_nomination' THEN
      RAISE EXCEPTION 'FAIL 76c: % was answered %, not the revoked grant', st, COALESCE(msg, 'by success');
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS  76c a trip ends once by its end columns, now or earlier and not before its start, an ended trip is frozen, and a nomination is insert-only';
END $$;
ROLLBACK;

\echo '== 76d. a task carries the instant it closed: none while open, now when it leaves OPEN, a planted past instant kept, and a closed task never changes state (FR-INS-052, rule 3, TY018; as BAC, rolled back)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1  constant uuid := md5('t76h1')::uuid;
  d1  constant uuid := md5('t76d1')::uuid;
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; k5 uuid; insp uuid;
  st text; msg text; c timestamptz; s text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, h1, now() + interval '1 day') RETURNING id INTO k1;
  SELECT closed_at INTO c FROM app.inspection_task WHERE id = k1;
  IF c IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 76d: an open task carries closed_at %', c;
  END IF;
  UPDATE app.inspection_task SET closed_at = now() - interval '1 day' WHERE id = k1;
  SELECT closed_at INTO c FROM app.inspection_task WHERE id = k1;
  IF c IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 76d: an UPDATE gave an open task closed_at %', c;
  END IF;
  UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = '76d' WHERE id = k1;
  SELECT closed_at INTO c FROM app.inspection_task WHERE id = k1;
  IF c IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'FAIL 76d: a cancelled task closed at %, not now', c;
  END IF;

  INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at, odometer)
  VALUES (bac, h1, d1, gen_random_uuid(), now() - interval '1 hour', now() - interval '30 minutes', 1000)
  RETURNING id INTO insp;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, h1, now() + interval '1 day') RETURNING id INTO k2;
  UPDATE app.inspection_task SET state = 'COMPLETED', completed_inspection_id = insp WHERE id = k2;

  FOR st, msg IN SELECT * FROM (VALUES
      (format('UPDATE app.inspection_task SET state = ''OPEN'' WHERE id = %L', k1),
       'TY018 this inspection task is cancelled; a closed task never changes state'),
      (format('UPDATE app.inspection_task SET state = ''CANCELLED'', cancelled_reason = ''76d'' WHERE id = %L', k2),
       'TY018 this inspection task is completed; a closed task never changes state')) v(a, b)
  LOOP
    s := NULL;
    BEGIN
      EXECUTE st;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS s = RETURNED_SQLSTATE;
      s := s || ' ' || SQLERRM;
    END;
    IF s IS DISTINCT FROM msg THEN
      RAISE EXCEPTION 'FAIL 76d: % was answered %, not %', st, COALESCE(s, 'by success'), msg;
    END IF;
  END LOOP;
  SELECT string_agg(state::text, ',' ORDER BY state::text) INTO s
    FROM app.inspection_task WHERE id IN (k1, k2);
  IF s IS DISTINCT FROM 'CANCELLED,COMPLETED' THEN
    RAISE EXCEPTION 'FAIL 76d: the refused moves left the tasks %', s;
  END IF;

  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, state, cancelled_reason, closed_at)
  VALUES (bac, h1, now(), 'CANCELLED', '76d', now() - interval '1 day') RETURNING id INTO k3;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, state, cancelled_reason)
  VALUES (bac, h1, now(), 'CANCELLED', '76d') RETURNING id INTO k4;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, closed_at)
  VALUES (bac, h1, now(), now() - interval '1 day') RETURNING id INTO k5;
  UPDATE app.inspection_task SET due_at = due_at + interval '1 day' WHERE id = k3;
  SELECT string_agg(CASE WHEN closed_at IS NULL THEN 'null'
                         WHEN closed_at = now() THEN 'now'
                         WHEN closed_at = now() - interval '1 day' THEN 'yesterday'
                         ELSE closed_at::text END, ',' ORDER BY ord) INTO s
    FROM app.inspection_task k
    JOIN (VALUES (k3, 1), (k4, 2), (k5, 3)) o(id, ord) ON o.id = k.id;
  IF s IS DISTINCT FROM 'yesterday,now,null' THEN
    RAISE EXCEPTION 'FAIL 76d: a cancelled task planted at a past close, one planted with none and an open one planted with one read %, not yesterday,now,null (the past close kept through a due_at edit)', s;
  END IF;
  RAISE NOTICE 'PASS  76d a task closes at now when it leaves OPEN, a planted close is kept, an open task has none, and a closed task never changes state';
END $$;
ROLLBACK;

\echo '== 76e. the responsible driver: the trip that covers the unit, else the task''s live nominee, else the motive''s for a coupled trailer, else nobody; a nomination lapses at the first covered instant after it and stays lapsed; only while the task is outstanding (FR-INS-053 as amended; as BAC, rolled back)'
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
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();

  -- Rule 1: H1 tows T1 from ten hours ago, and D1's trip on H1 opened five
  -- hours ago.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '10 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h1, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h1;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, t1, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_t1;
  PERFORM pg_temp.t76_expect('76e rule 1', k_h1, now(), one || '/TRIP');
  PERFORM pg_temp.t76_expect('76e rule 1', k_t1, now(), one || '/TRIP');
  PERFORM pg_temp.t76_expect('76e rule 1', k_h1, now() - interval '6 hours', 'nobody/-');
  PERFORM pg_temp.t76_expect('76e rule 1', k_t1, now() - interval '6 hours', 'nobody/-');

  -- Rule 2, and a re-nomination: the newest nomination made by then.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h2;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h2, d2, now() - interval '2 hours'), (bac, k_h2, d3, now() - interval '1 hour');
  PERFORM pg_temp.t76_expect('76e rule 2', k_h2, now() - interval '3 hours', 'nobody/-');
  PERFORM pg_temp.t76_expect('76e rule 2', k_h2, now() - interval '90 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('76e rule 2', k_h2, now(), three || '/NOMINATION');

  -- A trip that starts after a nomination takes it over, and the nomination
  -- does not come back when the trip ends (decision 6).
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h3, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h3;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h3, d2, now() - interval '4 hours');
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h3, d3, now() - interval '3 hours', now() - interval '2 hours');
  PERFORM pg_temp.t76_expect('76e lapse by a trip', k_h3, now() - interval '210 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('76e lapse by a trip', k_h3, now() - interval '150 minutes', three || '/TRIP');
  PERFORM pg_temp.t76_expect('76e lapse by a trip', k_h3, now(), 'nobody/-');

  -- Coupling to a motive on a trip is the same takeover seen from the
  -- trailer: T2 joins H1's rig for an hour and leaves it again. Each rig is
  -- planted open, given its members, then ended, since an ended rig takes
  -- none (000037).
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, t2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_t2;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_t2, d2, now() - interval '4 hours');
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
  PERFORM pg_temp.t76_expect('76e lapse by a coupling', k_t2, now() - interval '210 minutes', two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('76e lapse by a coupling', k_t2, now() - interval '150 minutes', one || '/TRIP');
  PERFORM pg_temp.t76_expect('76e lapse by a coupling', k_t2, now(), 'nobody/-');
  PERFORM pg_temp.t76_expect('76e lapse by a coupling', k_t1, now(), one || '/TRIP');

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
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h4, d2, now() - interval '1 hour');
  PERFORM pg_temp.t76_expect('76e rule 3', k_t3, now(), two || '/MOTIVE_NOMINATION');
  -- The active flag keeps no history, so reading it would rewrite past
  -- attribution (spec, Nominations).
  UPDATE app.app_user SET active = false WHERE id = d2;
  PERFORM pg_temp.t76_expect('76e rule 3 ignores the active flag', k_t3, now(), two || '/MOTIVE_NOMINATION');
  UPDATE app.app_user SET active = true WHERE id = d2;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h4, now() + interval '2 days', now() - interval '12 hours') RETURNING id INTO k_h4b;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h4b, d3, now() - interval '30 minutes');
  PERFORM pg_temp.t76_expect('76e rule 3 takes the newest across the motive''s tasks', k_t3, now(), three || '/MOTIVE_NOMINATION');

  -- Rule 2 before rule 3: the trailer's own nominee wins.
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_t3, d1, now() - interval '20 minutes');
  PERFORM pg_temp.t76_expect('76e rule 2 before rule 3', k_t3, now(), one || '/NOMINATION');

  -- At the due instant, which the amended criterion 4 reads.
  due := now() - interval '1 hour';
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h5, due, now() - interval '12 hours') RETURNING id INTO k_h5;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h5, d2, now() - interval '11 hours');
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h1, due, now() - interval '12 hours') RETURNING id INTO k_h1d;
  PERFORM pg_temp.t76_expect('76e at the due instant', k_h5, due, two || '/NOMINATION');
  PERFORM pg_temp.t76_expect('76e at the due instant', k_h1d, due, one || '/TRIP');

  -- Nobody.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h6, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k_h6;
  PERFORM pg_temp.t76_expect('76e nobody', k_h6, now(), 'nobody/-');

  -- Not outstanding: each would answer a driver but for the bound, as the
  -- control instants show.
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '3 days', now() - interval '12 hours') RETURNING id INTO k_h2c;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k_h2c, d4, now() - interval '2 hours');
  UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = '76e' WHERE id = k_h2c;
  PERFORM pg_temp.t76_expect('76e a cancelled task', k_h2c, now(), 'nobody/-');
  PERFORM pg_temp.t76_expect('76e a cancelled task, before its close', k_h2c, now() - interval '1 hour', four || '/NOMINATION');
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES (bac, h1, now() + interval '3 days') RETURNING id INTO k_now;
  PERFORM pg_temp.t76_expect('76e a task created now', k_now, now() - interval '1 minute', 'nobody/-');
  PERFORM pg_temp.t76_expect('76e a task created now, at now', k_now, now(), one || '/TRIP');
  RAISE NOTICE 'PASS  76e each rule answers in order, a nomination lapses at the first covered instant after it by a trip or a coupling and stays lapsed, rule 3 ignores the active flag, and nothing answers outside the task''s outstanding span';
END $$;
ROLLBACK;

\echo '== 76h. a submit is judged by who could capture each unit it names at some instant of the capture, not at its arrival: a trip or task closed mid-capture still passes, a unit never held does not, a nominee reaches the motive''s rig, every unit the payload attributes is checked, and a replay is a replay (FR-OFF-015 as amended, FR-AUT-005; as BAC, each case rolled back)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '2 hours', now() - interval '30 minutes');
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '40 minutes', now() - interval '10 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: a trip closed between start and submit refused the capture';
  END IF;
  IF app.user_could_capture(d1, h1, now() - interval '20 minutes', now() - interval '10 minutes') THEN
    RAISE EXCEPTION 'FAIL 76h: the control window after the trip ended passed';
  END IF;
  RAISE NOTICE 'PASS  76h a trip closed between start and submit passes; a window wholly after it does not';
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
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h2, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k, d2, now() - interval '2 hours');
  UPDATE app.inspection_task SET state = 'CANCELLED', cancelled_reason = '76h' WHERE id = k;
  p := pg_temp.t76_capture(ARRAY[h2], now() - interval '40 minutes', now()) || jsonb_build_object('task_id', k);
  IF NOT pg_temp.t76_could(p, d2) THEN
    RAISE EXCEPTION 'FAIL 76h: a task cancelled between start and submit refused its nominee';
  END IF;
  IF app.user_could_capture(d2, h2, now(), now()) THEN
    RAISE EXCEPTION 'FAIL 76h: the nominee of a cancelled task can capture after the cancel';
  END IF;
  -- Never held: D3 had no trip and no nomination on H2.
  IF app.user_could_capture(d3, h2, now() - interval '1 hour', now()) OR pg_temp.t76_could(p, d3) THEN
    RAISE EXCEPTION 'FAIL 76h: a driver who never held the unit passes';
  END IF;
  PERFORM set_config('app.actor_id', d2::text, true);
  SELECT * INTO r FROM app.submit_inspection(p);
  IF NOT r.created THEN RAISE EXCEPTION 'FAIL 76h: the nominee''s submit did not land'; END IF;
  SELECT t.state::text AS state, t.completed_inspection_id INTO r FROM app.inspection_task t WHERE t.id = k;
  IF r.state <> 'CANCELLED' OR r.completed_inspection_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 76h: the cancelled task reads % citing % after the submit', r.state, r.completed_inspection_id;
  END IF;
  RAISE NOTICE 'PASS  76h a task cancelled mid-capture passes its nominee and stays cancelled; a driver who never held the unit does not pass';
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
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h4, now() - interval '10 hours') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h4, 1), (bac, rig, t3, 2);
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES (bac, h4, now() + interval '1 day', now() - interval '12 hours') RETURNING id INTO k;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at)
  VALUES (bac, k, d2, now() - interval '1 hour');
  IF NOT app.user_could_capture(d2, h4, now(), now()) OR NOT app.user_could_capture(d2, t3, now(), now())
     OR app.user_could_capture(d2, h1, now(), now()) THEN
    RAISE EXCEPTION 'FAIL 76h: a motive''s nominee does not reach exactly the motive and its coupled trailer';
  END IF;
  -- A trip then takes the nomination over (decision 6).
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h4, d3, now() - interval '30 minutes');
  IF app.user_could_capture(d2, h4, now() - interval '20 minutes', now()) THEN
    RAISE EXCEPTION 'FAIL 76h: the nominee passes a window wholly after a trip took the task over';
  END IF;
  IF NOT app.user_could_capture(d2, h4, now() - interval '50 minutes', now()) THEN
    RAISE EXCEPTION 'FAIL 76h: the nominee fails a window that began before the trip took over';
  END IF;
  RAISE NOTICE 'PASS  76h a motive''s nominee captures it and its coupled trailers until a trip takes the task over';
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
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  -- A partial window across an uncouple: T2 was towed from three hours ago
  -- to two hours ago.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '3 hours') RETURNING id INTO old_rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, old_rig, h1, 1), (bac, old_rig, t2, 2);
  UPDATE app.combination SET effective_to = now() - interval '2 hours' WHERE id = old_rig;
  IF NOT app.user_could_capture(d1, t2, now() - interval '150 minutes', now() - interval '60 minutes') THEN
    RAISE EXCEPTION 'FAIL 76h: a window spanning the uncouple refused the trailer held for part of it';
  END IF;
  IF app.user_could_capture(d1, t2, now() - interval '90 minutes', now() - interval '60 minutes') THEN
    RAISE EXCEPTION 'FAIL 76h: a window wholly after the uncouple passed the trailer';
  END IF;

  -- Every unit the payload attributes is checked (Decision 25).
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '90 minutes') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  p := pg_temp.t76_capture(ARRAY[h1, t1], now() - interval '30 minutes', now());
  IF NOT pg_temp.t76_could(p, d1) THEN
    RAISE EXCEPTION 'FAIL 76h: a capture of the trip''s motive and its trailer was refused';
  END IF;
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1, t1, h2], now() - interval '30 minutes', now()), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: a reading on a unit the driver never held passed';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('absent_spares', jsonb_build_array(
         jsonb_build_object('vehicle_id', h2, 'position_id', gen_random_uuid()))), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: an absent spare on a unit the driver never held passed';
  END IF;

  -- combination_id names a rig of the payload's unit, at any time: a tab's
  -- cached context can name a rig a trip start has since re-formed.
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h4, now() - interval '10 hours') RETURNING id INTO h4_rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, h4_rig, h4, 1), (bac, h4_rig, t3, 2);
  IF NOT pg_temp.t76_could(p || jsonb_build_object('combination_id', rig), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: the payload unit''s open rig was refused';
  END IF;
  IF NOT pg_temp.t76_could(p || jsonb_build_object('combination_id', old_rig), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: the payload unit''s rig ended before the capture was refused';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('combination_id', h4_rig), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: a rig headed by another unit passed';
  END IF;
  IF pg_temp.t76_could(p || jsonb_build_object('combination_id', gen_random_uuid()), d1) THEN
    RAISE EXCEPTION 'FAIL 76h: an unknown rig passed';
  END IF;
  IF NOT pg_temp.t76_could(p || '{"combination_id": null}'::jsonb, d1) THEN
    RAISE EXCEPTION 'FAIL 76h: an explicit null combination_id, which every solo capture sends, was refused';
  END IF;
  RAISE NOTICE 'PASS  76h a window across an uncouple passes the trailer, every attributed unit is checked, and combination_id names a rig of the payload''s unit';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h5 constant uuid := md5('t76h5')::uuid;
  d2 constant uuid := md5('t76d2')::uuid; d3 constant uuid := md5('t76d3')::uuid;
  cu uuid := gen_random_uuid(); p jsonb;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.inspection (tenant_id, vehicle_id, user_id, client_uuid, started_at, submitted_at)
  VALUES (bac, h5, d2, cu, now() - interval '3 hours', now() - interval '170 minutes');
  p := pg_temp.t76_capture(ARRAY[h5], now() - interval '3 hours', now() - interval '170 minutes')
       || jsonb_build_object('client_uuid', cu);
  IF NOT pg_temp.t76_could(p, d2) THEN
    RAISE EXCEPTION 'FAIL 76h: a replay of the actor''s own stored capture was refused';
  END IF;
  IF pg_temp.t76_could(p, d3) THEN
    RAISE EXCEPTION 'FAIL 76h: another driver''s client_uuid passed as a replay';
  END IF;
  RAISE NOTICE 'PASS  76h a replay of the actor''s own stored capture is answered as a replay, and no one else''s is';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; t1 constant uuid := md5('t76t1')::uuid;
  d1 constant uuid := md5('t76d1')::uuid;
  rig uuid; got text; bad text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '1 hour');
  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from)
  VALUES (bac, h1, now() - interval '1 hour') RETURNING id INTO rig;
  INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence)
  VALUES (bac, rig, h1, 1), (bac, rig, t1, 2);
  PERFORM set_config('app.actor_id', d1::text, true);
  SELECT string_agg(v.fleet_number, ',' ORDER BY v.fleet_number) INTO got
    FROM app.v_capture_vehicle cv JOIN app.vehicle v ON v.id = cv.vehicle_id
   WHERE v.fleet_number LIKE 'T76-%';
  IF got IS DISTINCT FROM 'T76-H1,T76-T1' THEN
    RAISE EXCEPTION 'FAIL 76h: the capture read at now reads %, not T76-H1,T76-T1', got;
  END IF;
  SELECT string_agg(v.fleet_number, ',' ORDER BY v.fleet_number) INTO bad
    FROM app.vehicle v
   WHERE v.fleet_number LIKE 'T76-%'
     AND app.user_could_capture(d1, v.id, now(), now()) <> (v.fleet_number IN ('T76-H1', 'T76-T1'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 76h: the predicate at now disagrees with T76-H1,T76-T1 on %', bad;
  END IF;
  RAISE NOTICE 'PASS  76h the capture read at now and the predicate both answer exactly the trip''s motive and its trailer';
END $$;
ROLLBACK;

\echo '== 76i. the window judged runs to submitted_at from started_at or the tenant''s setting before it, whichever is later, and from submitted_at when started_at is after it; no capture is refused for its length, and an absent started_at is a named refusal (U148, rule 5, FR-OFF-013; as BAC, each case rolled back)'
BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid;
  p jsonb; w tstzrange; st text; msg text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  p := pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now());
  w := app.capture_window(p);
  IF w IS DISTINCT FROM tstzrange(now() - interval '12 hours', now(), '[]') THEN
    RAISE EXCEPTION 'FAIL 76i: a 14 hour capture is judged over %, not its last 12 hours', w;
  END IF;
  w := app.capture_window(pg_temp.t76_capture(ARRAY[h1], now() - interval '1 hour', now()));
  IF w IS DISTINCT FROM tstzrange(now() - interval '1 hour', now(), '[]') THEN
    RAISE EXCEPTION 'FAIL 76i: a one hour capture is judged over %', w;
  END IF;
  w := app.capture_window(pg_temp.t76_capture(ARRAY[h1], now() + interval '2 minutes', now()));
  IF w IS DISTINCT FROM tstzrange(now(), now(), '[]') THEN
    RAISE EXCEPTION 'FAIL 76i: a started_at after submitted_at is judged over %, not at submitted_at', w;
  END IF;
  IF app.capture_window_between(now() - interval '14 hours', now()) IS DISTINCT FROM tstzrange(now() - interval '12 hours', now(), '[]')
     OR app.capture_window_between(now(), now() - interval '1 hour') IS DISTINCT FROM tstzrange(now() - interval '1 hour', now() - interval '1 hour', '[]') THEN
    RAISE EXCEPTION 'FAIL 76i: capture_window_between disagrees with the payload window';
  END IF;
  -- Dated a second back: config_for reads rows strictly before its instant
  -- (lesson 2026-09-11).
  INSERT INTO app.configuration (tenant_id, key, value, effective_from)
  VALUES (bac, 'inspection_max_duration_hours', '2'::jsonb, now() - interval '1 second');
  w := app.capture_window(p);
  IF w IS DISTINCT FROM tstzrange(now() - interval '2 hours', now(), '[]') THEN
    RAISE EXCEPTION 'FAIL 76i: the tenant setting of 2 hours judged the capture over %', w;
  END IF;
  BEGIN
    PERFORM app.capture_window(p - 'started_at');
    RAISE EXCEPTION 'FAIL 76i: a payload with no started_at was given a window';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF st IS DISTINCT FROM 'TY005' OR msg IS DISTINCT FROM 'the payload carries no started_at' THEN
    RAISE EXCEPTION 'FAIL 76i: a payload with no started_at answered % %', st, msg;
  END IF;
  RAISE NOTICE 'PASS  76i the window is the capture''s last setting-hours, from submitted_at when started_at is after it, and an absent started_at is TY005';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  -- The trip covers the capture's last five hours only.
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '5 hours');
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now()), d1) THEN
    RAISE EXCEPTION 'FAIL 76i: a capture longer than the setting was refused though the driver held the unit at its end';
  END IF;
  RAISE NOTICE 'PASS  76i a capture longer than the setting is accepted on its last part';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '14 hours', now() - interval '13 hours');
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now()), d1) THEN
    RAISE EXCEPTION 'FAIL 76i: a driver who held the unit only before the judged window passed';
  END IF;
  RAISE NOTICE 'PASS  76i a driver who held the unit only before the judged window is refused';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, ended_at)
  VALUES (bac, h1, d1, now() - interval '1 hour', now() - interval '10 minutes');
  IF pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '2 minutes', now() - interval '5 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL 76i: a started_at after submitted_at was judged at started_at, not at submitted_at';
  END IF;
  RAISE NOTICE 'PASS  76i a started_at after submitted_at is judged at submitted_at, after the trip ended';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at)
  VALUES (bac, h1, d1, now() - interval '1 hour');
  IF NOT pg_temp.t76_could(pg_temp.t76_capture(ARRAY[h1], now() - interval '2 minutes', now() - interval '5 minutes'), d1) THEN
    RAISE EXCEPTION 'FAIL 76i: the control, the same capture with the trip open, was refused';
  END IF;
  RAISE NOTICE 'PASS  76i the control: the same capture passes with the trip open at submitted_at';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
  p jsonb; r record; st timestamptz; n int; got text;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  PERFORM set_config('app.actor_id', d1::text, true);
  p := pg_temp.t76_capture(ARRAY[h1], now() - interval '14 hours', now());
  SELECT * INTO r FROM app.submit_inspection(p);
  SELECT i.started_at INTO st FROM app.inspection i WHERE i.id = r.inspection_id;
  IF NOT r.created OR st IS DISTINCT FROM now() - interval '14 hours' THEN
    RAISE EXCEPTION 'FAIL 76i: a 14 hour capture landed % with started_at %, not the phone''s', r.created, st;
  END IF;
  SELECT * INTO r FROM app.submit_inspection(p);
  IF r.created THEN RAISE EXCEPTION 'FAIL 76i: a resubmitted client_uuid was stored twice'; END IF;
  BEGIN
    PERFORM app.submit_inspection(pg_temp.t76_capture(ARRAY[h1], NULL, now()) - 'started_at');
    RAISE EXCEPTION 'FAIL 76i: a submit with no started_at landed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE;
    got := got || ' ' || SQLERRM;
  END;
  IF got IS DISTINCT FROM 'TY005 the payload carries no started_at' THEN
    RAISE EXCEPTION 'FAIL 76i: a submit with no started_at answered %', got;
  END IF;
  SELECT count(*) INTO n FROM app.inspection WHERE vehicle_id = h1;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL 76i: H1 holds % inspections, not the one stored', n; END IF;
  RAISE NOTICE 'PASS  76i a raw submit stores a long capture''s own started_at, answers a replay as one, and refuses an absent started_at by name';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  bac constant uuid := '11111111-1111-1111-1111-111111111111';
  h1 constant uuid := md5('t76h1')::uuid; d1 constant uuid := md5('t76d1')::uuid;
  r record;
BEGIN
  PERFORM set_config('app.tenant_id', bac::text, true);
  PERFORM set_config('app.actor_id', '', true);
  PERFORM pg_temp.t76_units();
  PERFORM set_config('app.actor_id', d1::text, true);
  SELECT * INTO r FROM app.submit_inspection(
    pg_temp.t76_capture(ARRAY[h1], now() - interval '2 minutes', now() - interval '5 minutes'));
  IF NOT r.created THEN RAISE EXCEPTION 'FAIL 76i: a capture whose started_at follows its submitted_at did not land'; END IF;
  RAISE NOTICE 'PASS  76i a raw submit whose started_at follows its submitted_at lands';
END $$;
ROLLBACK;

\echo '== 76z. nothing section 76 planted outlives its rollback'
DROP FUNCTION pg_temp.t76_could(jsonb, uuid);
DROP FUNCTION pg_temp.t76_capture(uuid[], timestamptz, timestamptz);
DROP FUNCTION pg_temp.t76_expect(text, uuid, timestamptz, text);
DROP FUNCTION pg_temp.t76_who(uuid, timestamptz);
DROP FUNCTION pg_temp.t76_units();
DO $$
DECLARE got text := '';
        tid uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  IF EXISTS (SELECT 1 FROM app.vehicle WHERE fleet_number LIKE 'T76-%')
     OR EXISTS (SELECT 1 FROM app.app_user WHERE display_name LIKE 'T76 %') THEN
    RAISE EXCEPTION 'FAIL 76z: a T76 unit or user outlived its check';
  END IF;
  FOREACH tid IN ARRAY ARRAY['11111111-1111-1111-1111-111111111111',
                             '22222222-2222-2222-2222-222222222222',
                             '33333333-3333-3333-3333-333333333333']::uuid[] LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    got := got || (SELECT count(*) FROM app.trip) || '/'
               || (SELECT count(*) FROM app.inspection_task_nomination) || ' ';
  END LOOP;
  IF got IS DISTINCT FROM '2/0 1/0 1/0 ' THEN
    RAISE EXCEPTION 'FAIL 76z: trip and nomination rows per fixture fleet read %, not the fixture''s 2/0 1/0 1/0', got;
  END IF;
  RAISE NOTICE 'PASS  76z section 76 leaves no residue';
END $$;

\echo ''
\echo '================  ALL CHECKS PASSED  ================'
