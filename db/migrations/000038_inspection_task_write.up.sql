-- ============================================================================
--  The inspection task: a controller schedules one for a driver who can
--  capture the unit (TYRE-90)
--  Implements: FR-INS-051 (the ad-hoc instruction), FR-INS-052 (a task with a
--  due date), FR-INS-053 (the trailer's task goes to the horse's driver),
--  FR-INS-048 (the driver reads it), FR-AUT-005 as amended by D3;
--  spec U4 (the assignee can capture the unit), U11 (TY018), U12 (audited).
-- ============================================================================
-- SQLSTATEs (ours; the TY class forwards verbatim, ADR-0012):
--   TY012 — a row this tenant cannot see (one message per object)
--   TY018 — an inspection task refused
--
-- Nothing new is stored. app.inspection_task (000012) has held a task's shape
-- since the sponsor answers, app.v_my_inspection_task (000014) reads it for
-- the driver and app.submit_inspection (000023) closes it. What no migration
-- has said is what may CREATE one, and that is the whole of this one.
--
-- Invoker rights, like every routine in app except app.refresh_governing_tread:
-- RLS binds them inside the caller's tenant-bound transaction (suite 8c).

-- U4, FR-AUT-005/D3, FR-INS-053: who may capture which unit, as one relation
-- any consumer can ask about any user. 000022 wrote this predicate inside
-- app.v_capture_vehicle, filtered to the acting driver; a controller
-- scheduling a task has to ask it about someone else, and the drivers read
-- has to list everyone it holds for one unit. Factored here rather than
-- written a second time, and v_capture_vehicle is re-created on it below so
-- the capture read keeps its name, its columns and its answer.
--
-- The rig leg excludes the motive: the horse's driver reaches the horse by
-- their own assignment, and a second row for the same pair would list them
-- twice on the drivers read. Inactive users are excluded here, once: an
-- actor withActor refuses (ADR-0011) is not one a task may name.
CREATE VIEW app.v_user_capture_vehicle WITH (security_invoker = true) AS
SELECT ca.tenant_id, ca.user_id, ca.vehicle_id, ca.vehicle_id AS via_vehicle_id
  FROM app.v_current_assignment ca
  JOIN app.app_user u ON u.id = ca.user_id AND u.active
UNION
SELECT cm.tenant_id, ca.user_id, cm.vehicle_id, ca.vehicle_id AS via_vehicle_id
  FROM app.v_current_assignment ca
  JOIN app.app_user u ON u.id = ca.user_id AND u.active
  JOIN app.combination c
    ON c.motive_vehicle_id = ca.vehicle_id AND c.effective_to IS NULL
  JOIN app.combination_member cm
    ON cm.combination_id = c.id AND cm.vehicle_id <> c.motive_vehicle_id;

-- The capture read, re-created whole on the base above: the same two columns
-- and the same rows 000022 answered, so capture.go and suite 45a read it
-- unchanged. CREATE OR REPLACE keeps its grants; security_invoker is restated
-- because reloptions are not carried over (suite 8b would catch an omission).
CREATE OR REPLACE VIEW app.v_capture_vehicle WITH (security_invoker = true) AS
SELECT DISTINCT ucv.tenant_id, ucv.vehicle_id
  FROM app.v_user_capture_vehicle ucv
 WHERE ucv.user_id = app.current_actor_id();

CREATE FUNCTION app.user_can_capture(p_user uuid, p_vehicle uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = app, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.v_user_capture_vehicle ucv
     WHERE ucv.user_id = p_user AND ucv.vehicle_id = p_vehicle)
$$;

-- FR-DSH-012's overdue rule, factored the same way: an OPEN task past its
-- due date, computed once. 000014 wrote it inside the driver's own view; the
-- unit's task list (tasks.go) needs the same answer for every assignee, and a
-- second expression in a Go query string would be a second place for the
-- rule to be wrong. v_my_inspection_task is dropped and re-created rather
-- than replaced: its it.* predates 000017's audit columns, so its column
-- order cannot be preserved by CREATE OR REPLACE.
CREATE VIEW app.v_inspection_task WITH (security_invoker = true) AS
SELECT it.*,
       (it.state = 'OPEN' AND it.due_at < now()) AS overdue
  FROM app.inspection_task it;

DROP VIEW app.v_my_inspection_task;
CREATE VIEW app.v_my_inspection_task WITH (security_invoker = true) AS
SELECT t.*
  FROM app.v_inspection_task t
 WHERE t.assigned_user_id = app.current_actor_id()
   AND t.state IN ('OPEN','ESCALATED');

-- U12, ADR-0014: the table this slice gives a write path to. The submit's
-- close (000023) is an UPDATE on this table and is audited from here on
-- under the driver; app.generate_inspection_tasks' inserts are audited with a
-- NULL actor where no actor is bound, which audit_row_change permits.
CREATE TRIGGER inspection_task_audited
AFTER INSERT OR UPDATE ON app.inspection_task
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- The one way an ad-hoc task comes to exist (FR-INS-051). What is checked
-- here is what a task must be true of: a unit this tenant can see and has
-- not retired, a user this tenant can see who is active and can capture the
-- unit, and a due day not already past. The predicate is the view's;
-- this function only names the refusal.
--
-- Due instant (rule 6): the tenant-local last microsecond of the due day.
-- app.tenant_day_instant (000037) resolves a PAST-facing "as-at" instant and
-- answers NULL for a later day, so it does not apply; the end of the day is
-- what makes a task due today not overdue at creation under
-- v_inspection_task's due_at < now(), overdue the moment the tenant's day
-- ends, and rendered by formatTenantDate as the day it is due. Never a bare
-- date cast (lessons 2026-09-01). app.generate_inspection_tasks (000012)
-- stamps UTC midnight and predates this rule; the schedule surface that owns
-- it is a separate ticket (spec, out of scope).
CREATE FUNCTION app.create_inspection_task(p_vehicle uuid, p_assignee uuid,
                                           p_due_on date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  veh    app.vehicle;
  usr    app.app_user;
  tz     text;
  today  date;
  due_on date;
  due_at timestamptz;
  task   uuid;
BEGIN
  SELECT * INTO veh FROM app.vehicle v WHERE v.id = p_vehicle;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  -- FR-VEH-006 pauses a non-ACTIVE unit's schedule; an ad-hoc instruction is
  -- a controller's own call, so only the retired states are refused (U9's
  -- reading of FR-VEH-005, applied here).
  IF veh.status IN ('DISPOSED', 'INACTIVE') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('%s is %s; a retired unit is not inspected', veh.fleet_number, lower(veh.status::text));
  END IF;
  SELECT * INTO usr FROM app.app_user u WHERE u.id = p_assignee;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such user in this fleet';
  END IF;
  IF NOT usr.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('%s is no longer active', usr.display_name);
  END IF;
  IF NOT app.user_can_capture(p_assignee, p_vehicle) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('%s is not assigned to %s or to the horse pulling it', usr.display_name, veh.fleet_number);
  END IF;

  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  today  := app.tenant_today(tz);
  due_on := COALESCE(p_due_on, today);
  IF due_on < today THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = 'a task is due today or later, never in the past';
  END IF;
  due_at := ((due_on + 1)::timestamp AT TIME ZONE tz) - interval '1 microsecond';

  INSERT INTO app.inspection_task
    (tenant_id, vehicle_id, due_at, assigned_user_id, requested_by, state, created_by)
  VALUES (app.current_tenant_id(), p_vehicle, due_at, p_assignee, app.current_actor_id(),
          'OPEN', app.current_actor_id())
  RETURNING id INTO task;
  RETURN task;
END $$;
