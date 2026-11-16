-- 000061's own state, read as postgres at version 61 (TYRE-472,
-- scripts/provision-tenant.test.sh step 17), so what the leg proves does not
-- move when a later migration lands.
DO $$
DECLARE got text;
BEGIN
  SELECT format('%s/%s', m.version, m.dirty) INTO got FROM public.schema_migrations m;
  IF got IS DISTINCT FROM '61/f' THEN
    RAISE EXCEPTION 'FAIL S1: schema_migrations reads %, not 61 clean', got;
  END IF;

  SELECT string_agg(format('%s owner %s definer %s config %s acl %s', f.sig, p.proowner::regrole, p.prosecdef,
                           p.proconfig, x.acl), '; ' ORDER BY f.sig) INTO got
    FROM (VALUES ('app.start_trip(uuid,uuid,uuid[])'), ('app.end_trip(uuid)'),
                 ('app.nominate_for_task(uuid,uuid)')) f(sig)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
    LEFT JOIN LATERAL (
      SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ':' || a.privilege_type,
                        ',' ORDER BY CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                        a.privilege_type) AS acl
        FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) x ON true
   WHERE p.oid IS NULL OR NOT p.prosecdef
      OR p.proowner IS DISTINCT FROM (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'app_writer')
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=app, pg_temp']
      OR x.acl IS DISTINCT FROM 'app_rw:EXECUTE,app_writer:EXECUTE';
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL S2: a write-list function is not a pinned definer owned by app_writer that app_rw alone executes: %', got;
  END IF;

  SELECT string_agg(a.attr, ', ' ORDER BY a.attr) INTO got
    FROM pg_roles r,
         LATERAL (VALUES ('rolsuper', r.rolsuper), ('rolbypassrls', r.rolbypassrls),
                         ('rolcanlogin', r.rolcanlogin), ('rolcreaterole', r.rolcreaterole),
                         ('rolcreatedb', r.rolcreatedb), ('rolreplication', r.rolreplication)) a(attr, is_on)
   WHERE r.rolname = 'app_writer' AND a.is_on;
  IF got IS NOT NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    RAISE EXCEPTION 'FAIL S3: app_writer is absent or holds %', COALESCE(got, 'nothing true');
  END IF;

  IF has_any_column_privilege('app_login', 'app.trip', 'INSERT')
     OR has_any_column_privilege('app_login', 'app.trip', 'UPDATE')
     OR has_any_column_privilege('app_login', 'app.inspection_task_nomination', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL S4: app_login still writes a trip or a nomination raw';
  END IF;

  SELECT string_agg(s, ', ') INTO got
    FROM unnest(ARRAY['app.trip_is_well_formed()', 'app.nomination_is_well_formed()']) s
   WHERE to_regprocedure(s) IS NOT NULL;
  IF got IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL S5: % still exist', got;
  END IF;
  RAISE NOTICE 'PASS  000061 at 61: the three are pinned definers owned by app_writer, which RLS binds, app_login writes neither table raw, and the two triggers are gone';
END $$;
