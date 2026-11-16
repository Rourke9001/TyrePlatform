-- Reverses 000061 to 000060's grants, triggers and function attributes. The
-- role and the membership stay: DROP ROLE fails while any database in the
-- cluster refers to the role (https://www.postgresql.org/docs/16/sql-droprole.html;
-- 000001_init.down.sql:2).

COMMENT ON TABLE app.trip IS
  'A driver on a motive unit from one instant to another (FR-VEH-007 as amended, TYRE-326). A trip ends once and is never edited; docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';
COMMENT ON TABLE app.inspection_task_nomination IS
  'A driver named for one inspection task (FR-INS-051, FR-INS-053 as amended, TYRE-326). Insert-only history: a new nominee is a newer row; docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';

-- 000060's two trigger functions, byte for byte: the round trip in
-- scripts/provision-tenant.test.sh step 17 compares md5(prosrc) with version
-- 60's (TYRE-472).
CREATE FUNCTION app.trip_is_well_formed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  usr app.app_user;
  veh app.vehicle;
BEGIN
  -- A user or unit the bound fleet cannot see is refused with its FK's code
  -- and name: another fleet's row, or one an unreferenced data-modifying CTE
  -- plants in this statement, which the FK would pass at the statement's end
  -- (sections 34e, 76c). A NULL key is NOT NULL's to refuse, and a row
  -- naming another fleet the policy's, whose WITH CHECK refuses it for the
  -- app role (section 72c).
  SELECT * INTO usr FROM app.app_user u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id;
  IF NOT FOUND AND NEW.user_id IS NOT NULL AND NEW.tenant_id = app.current_tenant_id() THEN
    RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'trip_tenant_id_user_id_fkey',
      MESSAGE = 'a trip names a user this statement cannot see';
  END IF;
  IF FOUND AND NOT usr.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028', MESSAGE = format('%s is no longer active', usr.display_name);
  END IF;
  SELECT * INTO veh FROM app.vehicle v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.vehicle_id;
  IF NOT FOUND AND NEW.vehicle_id IS NOT NULL AND NEW.tenant_id = app.current_tenant_id() THEN
    RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'trip_tenant_id_vehicle_id_fkey',
      MESSAGE = 'a trip names a unit this statement cannot see';
  END IF;
  IF FOUND THEN
    IF veh.unit_kind = 'TRAILER' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY028',
        MESSAGE = format('a trip is driven on a horse, rigid or light vehicle; %s is a trailer', veh.fleet_number);
    END IF;
    IF veh.status IN ('DISPOSED', 'INACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY028',
        MESSAGE = format('%s is %s; a retired unit does not go on a trip', veh.fleet_number, lower(veh.status::text));
    END IF;
  END IF;
  -- A start ahead of now would open coverage at an instant no caller has
  -- reached, and app.start_trip and app.end_trip read it as a race lost.
  IF NEW.started_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028', MESSAGE = 'a trip starts now or earlier, never in the future';
  END IF;
  -- An end ahead of now would close coverage nobody has yet given up (spec,
  -- Starting and ending a trip).
  IF NEW.ended_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028', MESSAGE = 'a trip ends now or earlier, never in the future';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trip_well_formed BEFORE INSERT ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.trip_is_well_formed();

CREATE FUNCTION app.nomination_is_well_formed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  k   app.inspection_task;
  usr app.app_user;
BEGIN
  -- A task or user the bound fleet cannot see is refused with its FK's code
  -- and name, as app.trip_is_well_formed refuses one (check 16).
  SELECT * INTO k FROM app.inspection_task t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.task_id;
  IF NOT FOUND AND NEW.task_id IS NOT NULL AND NEW.tenant_id = app.current_tenant_id() THEN
    RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation',
      CONSTRAINT = 'inspection_task_nomination_tenant_id_task_id_fkey',
      MESSAGE = 'a nomination names a task this statement cannot see';
  END IF;
  IF FOUND AND k.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection is %s; only an open one takes a driver', lower(k.state::text));
  END IF;
  SELECT * INTO usr FROM app.app_user u WHERE u.tenant_id = NEW.tenant_id AND u.id = NEW.user_id;
  IF NOT FOUND AND NEW.user_id IS NOT NULL AND NEW.tenant_id = app.current_tenant_id() THEN
    RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation',
      CONSTRAINT = 'inspection_task_nomination_tenant_id_user_id_fkey',
      MESSAGE = 'a nomination names a user this statement cannot see';
  END IF;
  IF FOUND AND NOT usr.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018', MESSAGE = format('%s is no longer active', usr.display_name);
  END IF;
  -- A nomination ahead of now would hand the task over at an instant no
  -- caller has reached, and app.nominate_for_task reads it as a race lost.
  IF NEW.nominated_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018', MESSAGE = 'a nomination is dated now or earlier, never in the future';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nomination_well_formed BEFORE INSERT ON app.inspection_task_nomination
FOR EACH ROW EXECUTE FUNCTION app.nomination_is_well_formed();

GRANT INSERT ON app.trip TO app_rw;
GRANT UPDATE (ended_at, ended_by) ON app.trip TO app_rw;
GRANT INSERT ON app.inspection_task_nomination TO app_rw;

-- Back to the migrating role as invoker functions PUBLIC may execute, as
-- 000060 left them.
ALTER FUNCTION app.start_trip(uuid, uuid, uuid[]) OWNER TO CURRENT_USER;
ALTER FUNCTION app.start_trip(uuid, uuid, uuid[]) SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION app.start_trip(uuid, uuid, uuid[]) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION app.start_trip(uuid, uuid, uuid[]) FROM app_rw;
ALTER FUNCTION app.end_trip(uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION app.end_trip(uuid) SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION app.end_trip(uuid) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION app.end_trip(uuid) FROM app_rw;
ALTER FUNCTION app.nominate_for_task(uuid, uuid) OWNER TO CURRENT_USER;
ALTER FUNCTION app.nominate_for_task(uuid, uuid) SECURITY INVOKER;
GRANT EXECUTE ON FUNCTION app.nominate_for_task(uuid, uuid) TO PUBLIC;
REVOKE EXECUTE ON FUNCTION app.nominate_for_task(uuid, uuid) FROM app_rw;

REVOKE EXECUTE ON FUNCTION app.create_combination_at(uuid, jsonb, timestamptz) FROM app_writer;
REVOKE EXECUTE ON FUNCTION app.end_combination_at(uuid, timestamptz) FROM app_writer;
REVOKE SELECT ON app.v_unit_coverage FROM app_writer;
REVOKE USAGE ON SEQUENCE app.audit_log_id_seq FROM app_writer;
REVOKE INSERT ON app.audit_log FROM app_writer;
REVOKE SELECT ON app.configuration FROM app_writer;
REVOKE SELECT ON app.tenant FROM app_writer;
REVOKE SELECT, INSERT ON app.combination_member FROM app_writer;
REVOKE UPDATE (effective_to) ON app.combination FROM app_writer;
REVOKE SELECT, INSERT ON app.combination FROM app_writer;
REVOKE UPDATE (updated_at) ON app.vehicle FROM app_writer;
REVOKE SELECT ON app.vehicle FROM app_writer;
REVOKE UPDATE (updated_at) ON app.app_user FROM app_writer;
REVOKE SELECT ON app.app_user FROM app_writer;
REVOKE UPDATE (updated_at) ON app.inspection_task FROM app_writer;
REVOKE SELECT ON app.inspection_task FROM app_writer;
REVOKE SELECT, INSERT ON app.inspection_task_nomination FROM app_writer;
REVOKE UPDATE (ended_at, ended_by) ON app.trip FROM app_writer;
REVOKE SELECT, INSERT ON app.trip FROM app_writer;
REVOKE USAGE ON SCHEMA app FROM app_writer;
