-- The head state a role shaped like tyreadmin leaves, run after
-- db/tests/helpers.sql as postgres (TYRE-472, scripts/provision-tenant.test.sh
-- step 17): app_writer passes suite check 8e's predicate, and the three
-- functions write as app_login, each filing its audit entry under the actor.
DO $$
DECLARE f text := pg_temp.app_writer_faults('app_login');
BEGIN
  IF f IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL S6: app_writer in the stand-in''s database: %', f;
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE
  ctl constant uuid := md5('controller1')::uuid;
  tr uuid; k uuid; nm uuid; h uuid := gen_random_uuid(); row_ app.trip; n int;
BEGIN
  IF current_user <> 'app_login' THEN
    RAISE EXCEPTION 'FAIL S7: the probe runs as %, so RLS is not on trial', current_user;
  END IF;
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  PERFORM set_config('app.actor_id', ctl::text, true);

  tr := app.start_trip(md5('veh1')::uuid, md5('driver3')::uuid);
  SELECT * INTO row_ FROM app.trip WHERE id = tr;
  IF row_.started_at IS DISTINCT FROM now() OR row_.ended_at IS NOT NULL OR row_.started_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL S7: the new trip reads started % ended % by %', row_.started_at, row_.ended_at, row_.started_by;
  END IF;
  SELECT * INTO row_ FROM app.trip WHERE id = md5('trip1')::uuid;
  IF row_.ended_at IS DISTINCT FROM now() OR row_.ended_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL S7: trip1 reads ended % by %, not now by the controller', row_.ended_at, row_.ended_by;
  END IF;

  PERFORM app.end_trip(tr);
  SELECT * INTO row_ FROM app.trip WHERE id = tr;
  IF row_.ended_at IS DISTINCT FROM now() OR row_.ended_by IS DISTINCT FROM ctl THEN
    RAISE EXCEPTION 'FAIL S7: the ended trip reads ended % by %', row_.ended_at, row_.ended_by;
  END IF;

  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  SELECT h, v.tenant_id, 'S7-H', 'S7H GP', v.configuration_id, 'HORSE', 'ACTIVE'
    FROM app.vehicle v WHERE v.id = md5('veh1')::uuid;
  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at)
  VALUES ('11111111-1111-1111-1111-111111111111', h, now() + interval '2 days') RETURNING id INTO k;
  nm := app.nominate_for_task(k, md5('driver3')::uuid);

  SELECT count(*) INTO n FROM app.audit_log a
   WHERE a.actor_id = ctl AND (a.entity_type, a.entity_id, a.action) IN
         (('trip', tr, 'INSERT'), ('trip', tr, 'UPDATE'), ('trip', md5('trip1')::uuid, 'UPDATE'),
          ('inspection_task_nomination', nm, 'INSERT'));
  IF n <> 4 THEN
    RAISE EXCEPTION 'FAIL S7: the start, both ends and the nomination filed % of their 4 audit entries under the controller', n;
  END IF;
  RAISE NOTICE 'PASS  the stand-in''s database: app_writer is in shape, and a start, an end and a nomination as app_login each write and file their audit entry';
END $$;
ROLLBACK;
