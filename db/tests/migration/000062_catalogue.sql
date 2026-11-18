-- What 000062 changes in the catalogue, one sorted line per fact, read as
-- postgres with -At after db/tests/helpers.sql (TYRE-99,
-- scripts/provision-tenant.test.sh step 17). Read at 61 before the up and
-- again after the down, the two must match: a green suite after a round trip
-- is not the proof (docs/lessons.md 2026-10-01). A fact with no row prints
-- absent or nothing, so a dropped object or grant shows in the diff.
WITH roles AS (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('app_rw', 'app_writer')),
tbls AS (SELECT c.oid, c.relname FROM pg_class c
          WHERE c.oid IN ('app.tyre'::regclass, 'app.tyre_event'::regclass, 'app.tyre_receipt'::regclass))
SELECT line FROM (
  SELECT format('function %s %s', f.sig, COALESCE((
           SELECT format('owner=%s definer=%s config=%s src=%s acl=%s', p.proowner::regrole, p.prosecdef,
                         p.proconfig, md5(p.prosrc),
                         (SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                                            || ':' || a.privilege_type, ','
                                            ORDER BY CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                                                     a.privilege_type)
                            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a))
             FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)), 'absent')) AS line
    FROM (VALUES ('app.receive_tyres(jsonb)'),
                 ('app.log_retread_return(uuid,date,boolean,text,numeric,numeric,numeric,uuid)'),
                 ('app.record_consent(text,boolean,text,timestamp with time zone)'),
                 ('app.costed_rand_per_mm(integer,numeric,numeric,numeric,text)'),
                 ('app.mark_code_on_sidewall(uuid,uuid,date)'),
                 ('app.tenant_consent_is_not_future_dated()')) f(sig)
  UNION ALL
  SELECT format('table %s %s %s', t.relname, a.grantee::regrole, a.privilege_type)
    FROM tbls t JOIN pg_class c ON c.oid = t.oid, aclexplode(c.relacl) a
   WHERE a.grantee IN (SELECT oid FROM roles)
  UNION ALL
  SELECT format('column %s.%s %s %s', t.relname, x.attname, a.grantee::regrole, a.privilege_type)
    FROM tbls t JOIN pg_attribute x ON x.attrelid = t.oid, aclexplode(x.attacl) a
   WHERE a.grantee IN (SELECT oid FROM roles)
  UNION ALL
  SELECT format('trigger tenant_consent %s %s %s', g.tgname, g.tgenabled, pg_get_triggerdef(g.oid))
    FROM pg_trigger g
   WHERE g.tgrelid = 'app.tenant_consent'::regclass AND NOT g.tgisinternal
  UNION ALL
  SELECT format('view v_tyre_code_to_mark %s', COALESCE((
           SELECT COALESCE(c.reloptions::text, 'no options') FROM pg_class c
            WHERE c.oid = to_regclass('app.v_tyre_code_to_mark')), 'absent'))
  UNION ALL
  SELECT format('comment tyre.brand_pending %s', COALESCE(col_description('app.tyre'::regclass, x.attnum), 'none'))
    FROM pg_attribute x WHERE x.attrelid = 'app.tyre'::regclass AND x.attname = 'brand_pending'
  UNION ALL
  SELECT format('migration version=%s dirty=%s', m.version, m.dirty) FROM public.schema_migrations m
  UNION ALL
  SELECT format('app_writer holds %s', h) FROM pg_temp.role_held('app_writer') h
  UNION ALL
  SELECT 'app_writer holds nothing in app' WHERE NOT EXISTS (SELECT 1 FROM pg_temp.role_held('app_writer'))
) facts
ORDER BY line;
