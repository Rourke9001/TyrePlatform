-- What 000061 changes in the catalogue, one sorted line per fact, read as
-- postgres with -At after db/tests/helpers.sql (TYRE-472,
-- scripts/provision-tenant.test.sh step 17). Read at 60 before the up and
-- again after the down, the two must match: a green suite after a round trip
-- is not the proof (docs/lessons.md 2026-10-01). A fact with no row prints
-- absent or nothing, so a dropped object or grant shows in the diff.
WITH writer AS (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'app_writer'),
roles AS (SELECT r.oid FROM pg_roles r WHERE r.rolname IN ('app_rw', 'app_writer')),
tbls AS (SELECT c.oid, c.relname FROM pg_class c
          WHERE c.oid IN ('app.trip'::regclass, 'app.inspection_task_nomination'::regclass))
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
    FROM (VALUES ('app.start_trip(uuid,uuid,uuid[])'), ('app.end_trip(uuid)'),
                 ('app.nominate_for_task(uuid,uuid)'), ('app.trip_is_well_formed()'),
                 ('app.nomination_is_well_formed()')) f(sig)
  UNION ALL
  SELECT format('table %s %s %s', t.relname, a.grantee::regrole, a.privilege_type)
    FROM tbls t JOIN pg_class c ON c.oid = t.oid, aclexplode(c.relacl) a
   WHERE a.grantee IN (SELECT oid FROM roles)
  UNION ALL
  SELECT format('column %s.%s %s %s', t.relname, x.attname, a.grantee::regrole, a.privilege_type)
    FROM tbls t JOIN pg_attribute x ON x.attrelid = t.oid, aclexplode(x.attacl) a
   WHERE a.grantee IN (SELECT oid FROM roles)
  UNION ALL
  SELECT format('trigger %s %s %s %s', t.relname, g.tgname, g.tgenabled, pg_get_triggerdef(g.oid))
    FROM tbls t JOIN pg_trigger g ON g.tgrelid = t.oid
   WHERE NOT g.tgisinternal
  UNION ALL
  SELECT format('migration version=%s dirty=%s', m.version, m.dirty) FROM public.schema_migrations m
  UNION ALL
  SELECT format('comment %s %s', t.relname, obj_description(t.oid, 'pg_class')) FROM tbls t
  UNION ALL
  SELECT format('app_writer holds %s', h) FROM pg_temp.role_held('app_writer') h
  UNION ALL
  SELECT 'app_writer holds nothing in app' WHERE NOT EXISTS (SELECT 1 FROM pg_temp.role_held('app_writer'))
) facts
ORDER BY line;
