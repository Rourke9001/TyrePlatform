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
