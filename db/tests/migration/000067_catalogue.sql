-- What 000067 changes in the catalogue, one sorted line per fact, read as
-- postgres with -At (TYRE-240, scripts/provision-tenant.test.sh step 17).
-- Read at 66 before the up and again after the down, the two must match. A
-- fact with no row prints absent, so a dropped object shows in the diff.
-- args is read beside src because prosrc holds no defaults, and the up
-- moves p_occurred_at's default from now() to NULL.
SELECT line FROM (
  SELECT format('function %s %s', f.sig, COALESCE((
           SELECT format('owner=%s definer=%s config=%s src=%s args=%s result=%s acl=%s',
                         p.proowner::regrole, p.prosecdef, p.proconfig, md5(p.prosrc),
                         pg_get_function_arguments(p.oid), pg_get_function_result(p.oid),
                         (SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                                            || ':' || a.privilege_type, ','
                                            ORDER BY CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
                                                     a.privilege_type)
                            FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a))
             FROM pg_proc p WHERE p.oid = to_regprocedure(f.sig)), 'absent')) AS line
    FROM (VALUES ('app.fit_tyre(uuid,uuid,uuid,numeric,app.mount_orientation,bigint,timestamp with time zone,text)'),
                 ('app.fit_tyre(uuid,uuid,uuid,numeric,app.mount_orientation,bigint,timestamp with time zone,text,date)'),
                 ('app.remove_tyre(uuid,text,numeric,bigint,timestamp with time zone,text)'),
                 ('app.remove_tyre(uuid,text,numeric,bigint,timestamp with time zone,text,date)'),
                 ('app.rotate_tyres(uuid,jsonb,jsonb,timestamp with time zone)'),
                 ('app.rotate_tyres(uuid,jsonb,jsonb,timestamp with time zone,text,date)'),
                 ('app.return_tyre_to_stock(uuid,uuid,timestamp with time zone)'),
                 ('app.return_tyre_to_stock(uuid,uuid,timestamp with time zone,text,date)'),
                 ('app.dispatch_tyre(uuid,app.tyre_state,uuid,date)'),
                 ('app.log_retread_return(uuid,date,boolean,text,numeric,numeric,numeric,uuid)'),
                 ('app.last_movement(uuid[],uuid[],uuid[])'),
                 ('app.place_movement(date,uuid[],uuid[],uuid[])'),
                 ('app.backdate_reason_ok(date,text)'),
                 ('app.positions_free_at(timestamp with time zone,uuid[],uuid[])'),
                 ('app.lock_position_pairs(uuid[],uuid[])')) f(sig)
  UNION ALL
  SELECT format('config removal_reason_labels %s', count(*))
    FROM app.configuration c WHERE c.key = 'removal_reason_labels'
) facts
ORDER BY line;
