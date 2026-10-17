-- One line per table and fixture tenant, for every app table with a
-- tenant_id, so scripts/provision-tenant.test.sh can show provisioning
-- touched none of the fixture's rows (TYRE-374). Runs as postgres.
\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
SELECT string_agg(
         format('SELECT %L, tenant_id::text, count(*) FROM app.%I WHERE tenant_id IN (%L, %L, %L) GROUP BY tenant_id',
                c.relname, c.relname,
                '11111111-1111-1111-1111-111111111111',
                '22222222-2222-2222-2222-222222222222',
                '33333333-3333-3333-3333-333333333333'),
         ' UNION ALL ' ORDER BY c.relname)
       || ' ORDER BY 1, 2'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app'
   AND c.relkind IN ('r', 'p')
   AND NOT c.relispartition
   AND EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
\gexec
