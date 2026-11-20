-- ============================================================================
--  A scoped submit cites an inspection task it covers (TYRE-319)
--  Implements: FR-AUT-005 as amended, FR-INS-052, FR-OFF-011, FR-OFF-015;
--  U143, U147 B16. Design:
--  docs/superpowers/specs/2026-11-20-task-only-capture-start-and-resume-design.md
-- ============================================================================
-- Since U143 a driver inspects a unit only when a task asks for it. The
-- submit route asks this for an actor who is not tenant-wide, after
-- app.actor_could_capture, so a unit never held answers TY007 first. The
-- Scope table lives in auth, so the exemption stays in Go, as the own-units
-- check's does. Written as db/CLAUDE.md, Adding a function, says.

-- The task's state is never read: a task closed or cancelled after the
-- capture began still passes, since the server refuses only a driver who
-- never held the unit then (TYRE-440 comment 13871).
CREATE FUNCTION app.submit_cites_task(p_payload jsonb) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_actor  uuid := app.current_actor_id();
  v_unit   uuid;
  v_fleet  text;
  w        tstzrange;
BEGIN
  -- A replay writes nothing, so it answers as its first delivery did
  -- (FR-OFF-011), by the lookup app.actor_could_capture makes.
  IF EXISTS (SELECT 1 FROM app.inspection i
              WHERE i.tenant_id = v_tenant
                AND i.client_uuid = (p_payload ->> 'client_uuid')::uuid
                AND i.user_id = v_actor) THEN
    RETURN;
  END IF;

  IF (p_payload ->> 'task_id') IS NULL THEN
    RAISE EXCEPTION 'this inspection names no inspection task' USING ERRCODE = 'TY029';
  END IF;

  -- The app role deletes no task, so an id this fleet cannot see was never
  -- issued to it (spec, Lead's call 7).
  SELECT k.vehicle_id INTO v_unit FROM app.inspection_task k
   WHERE k.tenant_id = v_tenant AND k.id = (p_payload ->> 'task_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this inspection names a task that is not in this fleet' USING ERRCODE = 'TY029';
  END IF;

  -- FR-INS-052 as amended (U150): a rig inspection covers its motive, the
  -- towed units confirmed at its start, and any unit it attributes a reading
  -- or an absent spare to. A reading on the task's unit is not needed, since
  -- a driver may submit a partial walk-around. The arrays are read through
  -- actor_could_capture's guard, so an older client's absent or JSON null
  -- list is no error.
  --
  -- app.submit_inspection records the confirmed list unchecked, so the
  -- task's unit must also be one the actor could capture during the capture
  -- (U147 B16). Both failures share one message, so the answer does not say
  -- which.
  w := app.capture_window(p_payload);
  IF NOT EXISTS (
       SELECT 1
         FROM (SELECT (p_payload ->> 'vehicle_id')::uuid AS vehicle_id
               UNION ALL
               SELECT e::uuid
                 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_payload -> 'observed_member_vehicle_ids') = 'array'
                                                     THEN p_payload -> 'observed_member_vehicle_ids' ELSE '[]'::jsonb END) e
               UNION ALL
               SELECT (e ->> 'vehicle_id')::uuid
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'readings') = 'array'
                                                THEN p_payload -> 'readings' ELSE '[]'::jsonb END) e
               UNION ALL
               SELECT (e ->> 'vehicle_id')::uuid
                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'absent_spares') = 'array'
                                                THEN p_payload -> 'absent_spares' ELSE '[]'::jsonb END) e) u
        WHERE u.vehicle_id = v_unit)
     OR NOT app.user_could_capture(v_actor, v_unit, lower(w), upper(w)) THEN
    SELECT v.fleet_number INTO v_fleet FROM app.vehicle v
     WHERE v.tenant_id = v_tenant AND v.id = v_unit;
    RAISE EXCEPTION 'this inspection names a task on %, which it does not cover', v_fleet
      USING ERRCODE = 'TY029';
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.submit_cites_task(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_cites_task(jsonb) TO app_rw;
