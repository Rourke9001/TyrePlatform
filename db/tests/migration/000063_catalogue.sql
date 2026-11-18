-- What 000063 changes in the catalogue, one sorted line per fact, read as
-- postgres with -At (TYRE-371, scripts/provision-tenant.test.sh step 17).
-- Read at 62 before the up and again after the down, the two must match. A
-- fact with no row prints absent, so a dropped object shows in the diff.
-- Memberships are read DISTINCT and without their grantor: the stand-in's
-- up grants app_rw to app_job again, and the down keeps that row.
SELECT line FROM (
  SELECT format('function app.active_tenant_ids() %s', COALESCE((
           SELECT format('owner=%s definer=%s config=%s src=%s acl=%s', p.proowner::regrole, p.prosecdef,
                         p.proconfig, md5(p.prosrc),
                         (SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                                            || ':' || a.privilege_type, ','
                                            ORDER BY CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                                                     a.privilege_type)
                            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a))
             FROM pg_proc p WHERE p.oid = to_regprocedure('app.active_tenant_ids()')), 'absent')) AS line
  UNION ALL
  SELECT format('role app_job %s', COALESCE((
           SELECT format('super=%s bypassrls=%s login=%s createrole=%s createdb=%s replication=%s',
                         r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolcreaterole, r.rolcreatedb, r.rolreplication)
             FROM pg_roles r WHERE r.rolname = 'app_job'), 'absent'))
  UNION ALL
  SELECT DISTINCT format('app_job member of %s', m.roleid::regrole)
    FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
   WHERE r.rolname = 'app_job'
  UNION ALL
  SELECT format('migration version=%s dirty=%s', m.version, m.dirty) FROM public.schema_migrations m
) facts
ORDER BY line;
