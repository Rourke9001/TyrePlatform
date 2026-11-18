-- pg_temp helpers shared by db/tests/004_tests.sql and
-- db/tests/005_privileged.sql (TYRE-472). Every object here lives in
-- pg_temp, so nothing outlives the session and the database under test
-- stays exactly what the migrations produce.
--
-- It loads first, in the same session as the suite file: make db-test and
-- make db-test-privileged send it ahead of theirs, and CI names it as the
-- first -f of each step. A run of a section cut from 004 or 005 loads it
-- too.

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

-- One statement, answered 'ok' or 'SQLSTATE message' (t75_try's shape).
CREATE FUNCTION pg_temp.t76_try(p_sql text) RETURNS text
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

-- One OPEN task on p_unit due at p_due, created twelve hours back.
CREATE FUNCTION pg_temp.t76_due(p_unit uuid, p_due timestamptz) RETURNS uuid
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, created_at)
  VALUES ('11111111-1111-1111-1111-111111111111', p_unit, p_due, now() - interval '12 hours')
  RETURNING id;
$fn$;

-- A receive payload at the bound fleet's first active depot or store, unless
-- it names a depot already: a fleet with one refuses a receive without it
-- (B39, 000062). It names the tenant because 005 calls it as postgres, which
-- bypasses RLS. A fleet with none gets a JSON null, which app.receive_tyres
-- reads as no depot. Section 79 calls app.receive_tyres without it.
CREATE FUNCTION pg_temp.at_depot(p_payload jsonb) RETURNS jsonb
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  SELECT CASE WHEN p_payload ? 'depot_id' THEN p_payload
              ELSE p_payload || jsonb_build_object('depot_id',
                     (SELECT d.id FROM app.depot d
                       WHERE d.tenant_id = app.current_tenant_id() AND d.active
                         AND d.type IN ('DEPOT', 'STORE')
                       ORDER BY d.name LIMIT 1)) END
$fn$;

-- The bound fleet's suite retread pattern, planted the first time it is
-- asked for: an accepted retread return leaves the casing on an active
-- retread pattern (U225, 000062). It holds no cache and looks again on every
-- call, since a refused return's EXCEPTION block (section 42f) rolls back a
-- row planted inside it. It names the tenant because 005 calls it as
-- postgres, which bypasses RLS.
CREATE FUNCTION pg_temp.retread_pattern() RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE found_id uuid;
BEGIN
  SELECT p.id INTO found_id FROM app.tyre_pattern p
   WHERE p.tenant_id = app.current_tenant_id() AND p.name = 'SUITE RETREAD';
  IF NOT FOUND THEN
    INSERT INTO app.tyre_pattern (tenant_id, name, applies_to)
    VALUES (app.current_tenant_id(), 'SUITE RETREAD', 'RETREAD')
    RETURNING tyre_pattern.id INTO found_id;
  END IF;
  RETURN found_id;
END $fn$;

-- Every privilege granted to p_role itself in schema app, as 'kind object
-- privilege', functions it owns aside, with ' WITH GRANT OPTION' after one
-- p_role may grant on, since a role that may re-grant passes its rights on
-- (U239). app_writer_faults and app_job_grant_faults compare it with their
-- lists, and db/tests/migration/000061_catalogue.sql prints app_writer's.
CREATE FUNCTION pg_temp.role_held(p_role name) RETURNS SETOF text
LANGUAGE sql
SET search_path = app, pg_temp AS $fn$
  WITH w AS (SELECT r.oid FROM pg_roles r WHERE r.rolname = p_role),
  g (held, is_grantable) AS (
    SELECT format('schema %s %s', n.nspname, a.privilege_type), a.is_grantable
      FROM w, pg_namespace n, aclexplode(n.nspacl) a
     WHERE n.nspname = 'app' AND a.grantee = w.oid
    UNION ALL
    SELECT format('%s app.%s %s', CASE c.relkind WHEN 'v' THEN 'view' WHEN 'S' THEN 'sequence' ELSE 'table' END,
                  c.relname, a.privilege_type), a.is_grantable
      FROM w, pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'app'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'S') AND a.grantee = w.oid
    UNION ALL
    SELECT format('column app.%s.%s %s', c.relname, t.attname, a.privilege_type), a.is_grantable
      FROM w, pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a
     WHERE c.relnamespace = 'app'::regnamespace AND NOT t.attisdropped AND a.grantee = w.oid
    UNION ALL
    SELECT format('function app.%s(%s) %s', p.proname, replace(oidvectortypes(p.proargtypes), ', ', ','),
                  a.privilege_type), a.is_grantable
      FROM w, pg_proc p, aclexplode(p.proacl) a
     WHERE p.pronamespace = 'app'::regnamespace AND p.proowner <> w.oid AND a.grantee = w.oid)
  SELECT DISTINCT g.held || CASE WHEN g.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END FROM g
   ORDER BY 1
$fn$;

-- What suite check 8e holds of app_writer, the owner of the four write-list
-- definers (ADR-0024, 000062): NULL when every property holds, else each fault,
-- '; '-joined. P26 in 005 shows each fault can fire. p_login is the app
-- login whose membership is checked. Catalogues only: information_schema
-- hides another role's grants from app_login.
CREATE FUNCTION pg_temp.app_writer_faults(p_login name) RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE
  w      oid := (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'app_writer');
  sigs   text[] := ARRAY['app.start_trip(uuid,uuid,uuid[])', 'app.end_trip(uuid)',
                         'app.nominate_for_task(uuid,uuid)',
                         'app.mark_code_on_sidewall(uuid,uuid,date)'];
  writes oid[];
  -- The four call trees' needs, each read from the statement that needs
  -- it (000061, 000062). A lock-only table holds UPDATE on updated_at alone.
  want   text[] := ARRAY[
    'schema app USAGE',
    'table app.trip SELECT',
    'table app.trip INSERT',
    'column app.trip.ended_at UPDATE',
    'column app.trip.ended_by UPDATE',
    'table app.inspection_task_nomination SELECT',
    'table app.inspection_task_nomination INSERT',
    'table app.inspection_task SELECT',
    'column app.inspection_task.updated_at UPDATE',
    'table app.app_user SELECT',
    'column app.app_user.updated_at UPDATE',
    'table app.vehicle SELECT',
    'column app.vehicle.updated_at UPDATE',
    'table app.combination SELECT',
    'table app.combination INSERT',
    'column app.combination.effective_to UPDATE',
    'table app.combination_member SELECT',
    'table app.combination_member INSERT',
    'table app.tenant SELECT',
    'table app.configuration SELECT',
    'table app.audit_log INSERT',
    'sequence app.audit_log_id_seq USAGE',
    'view app.v_unit_coverage SELECT',
    'function app.end_combination_at(uuid,timestamp with time zone) EXECUTE',
    'function app.create_combination_at(uuid,jsonb,timestamp with time zone) EXECUTE',
    'table app.tyre SELECT',
    'column app.tyre.brand_pending UPDATE',
    'table app.tyre_event SELECT',
    'table app.tyre_event INSERT',
    'table app.tyre_receipt SELECT'];
  held   text[];
  faults text[] := '{}';
BEGIN
  IF w IS NULL THEN
    RETURN 'no role app_writer';
  END IF;
  -- A write-list function that does not resolve is a fault by name, and is
  -- left out of every comparison below: a NULL in an ALL list never matches.
  faults := faults || ARRAY(SELECT format('%s does not exist', s) FROM unnest(sigs) s
                             WHERE to_regprocedure(s) IS NULL);
  writes := ARRAY(SELECT to_regprocedure(s)::oid FROM unnest(sigs) s WHERE to_regprocedure(s) IS NOT NULL);

  faults := faults || ARRAY(
    SELECT format('app_writer has %s', a.attr)
      FROM pg_roles r,
           LATERAL (VALUES ('rolsuper', r.rolsuper), ('rolbypassrls', r.rolbypassrls),
                           ('rolcanlogin', r.rolcanlogin), ('rolcreaterole', r.rolcreaterole),
                           ('rolcreatedb', r.rolcreatedb), ('rolreplication', r.rolreplication)) a(attr, is_on)
     WHERE r.oid = w AND a.is_on
     ORDER BY a.attr);

  faults := faults || ARRAY(
    SELECT format('app_writer owns %s', o.name)
      FROM (SELECT format('relation %s.%s', n.nspname, c.relname) AS name
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relowner = w
            UNION ALL
            SELECT format('schema %s', n.nspname) FROM pg_namespace n WHERE n.nspowner = w
            UNION ALL
            SELECT format('function %s.%s(%s)', n.nspname, p.proname, replace(oidvectortypes(p.proargtypes), ', ', ','))
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE p.proowner = w AND p.oid <> ALL (writes)) o
     ORDER BY o.name);
  faults := faults || ARRAY(
    SELECT format('app_writer does not own %s', s) FROM unnest(sigs) s
     WHERE to_regprocedure(s) IS NOT NULL
       AND (SELECT p.proowner FROM pg_proc p WHERE p.oid = to_regprocedure(s)) <> w);

  faults := faults || ARRAY(
    SELECT format('app_writer is a member of %s', m.roleid::regrole) FROM pg_auth_members m
     WHERE m.member = w ORDER BY 1);
  IF pg_has_role(p_login, w, 'MEMBER') THEN
    faults := faults || format('%s is a member of app_writer', p_login);
  END IF;
  -- Membership gives nobody a power they lacked only while every member
  -- already bypasses row security (spec section 6).
  faults := faults || ARRAY(
    SELECT format('%s is a member of app_writer and bypasses no row security', r.rolname)
      FROM pg_roles r
     WHERE r.oid <> w AND pg_has_role(r.oid, w, 'MEMBER') AND NOT r.rolsuper AND NOT r.rolbypassrls
     ORDER BY 1);
  faults := faults || ARRAY(
    SELECT format('a default privilege grants app_writer %s on new objects of type %s', a.privilege_type, d.defaclobjtype)
      FROM pg_default_acl d, aclexplode(d.defaclacl) a
     WHERE a.grantee = w ORDER BY 1);

  held := ARRAY(SELECT pg_temp.role_held('app_writer'));
  faults := faults
    || ARRAY(SELECT 'extra: ' || h FROM unnest(held) h WHERE h <> ALL (want) ORDER BY 1)
    || ARRAY(SELECT 'missing: ' || x FROM unnest(want) x WHERE x <> ALL (held) ORDER BY 1);
  RETURN NULLIF(array_to_string(faults, '; '), '');
END $fn$;

-- What suite section 80 holds of the grants made to app_job itself: NULL
-- when they are EXECUTE on the tenant listing and nothing else in schema app,
-- with no default privilege, role setting or parameter privilege naming
-- app_job, else each fault, '; '-joined. app_job's other rights come through
-- app_rw, which check 4 sweeps as the app login, so a grant here is the rule
-- 3 route check 4 cannot see (TYRE-371). P31 in 005 shows each fault can fire.
CREATE FUNCTION pg_temp.app_job_grant_faults() RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $fn$
DECLARE
  j    oid := (SELECT r.oid FROM pg_roles r WHERE r.rolname = 'app_job');
  want text[] := ARRAY['function app.active_tenant_ids() EXECUTE'];
  held text[];
BEGIN
  IF j IS NULL THEN
    RETURN 'no role app_job';
  END IF;
  held := ARRAY(SELECT pg_temp.role_held('app_job'));
  RETURN NULLIF(array_to_string(
       ARRAY(SELECT 'extra: ' || h FROM unnest(held) h WHERE h <> ALL (want) ORDER BY 1)
    || ARRAY(SELECT 'missing: ' || x FROM unnest(want) x WHERE x <> ALL (held) ORDER BY 1)
    || ARRAY(SELECT format('a default privilege grants app_job %s on new objects of type %s',
                           a.privilege_type, d.defaclobjtype)
               FROM pg_default_acl d, aclexplode(d.defaclacl) a
              WHERE a.grantee = j ORDER BY 1)
    -- Any setting, since a role setting applies at login and no suite file
    -- logs in as app_job; session_replication_role = replica switches off
    -- the triggers that hold history (U237).
    || ARRAY(SELECT format('a role setting gives app_job %s in %s', c.cfg,
                           COALESCE('database ' || db.datname, 'every database'))
               FROM pg_db_role_setting s
               LEFT JOIN pg_database db ON db.oid = s.setdatabase
               CROSS JOIN LATERAL unnest(s.setconfig) c(cfg)
              WHERE s.setrole = j ORDER BY 1)
    || ARRAY(SELECT format('a parameter privilege grants app_job %s on %s', a.privilege_type, p.parname)
               FROM pg_parameter_acl p, aclexplode(p.paracl) a
              WHERE a.grantee = j ORDER BY 1),
    '; '), '');
END $fn$;
