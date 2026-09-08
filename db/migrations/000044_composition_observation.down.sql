-- 000044 down, part B: the two functions depend on the cores part A's half
-- restores, so they go first; the table's audit rows stay, because a
-- migration that deleted them would be destroying facts rather than changing
-- a schema (rule 3, CR-004 — 000035's and 000037's down files say the same).
DROP FUNCTION app.dismiss_composition_observation(uuid, text);
DROP FUNCTION app.apply_composition_observation(uuid, text);
DROP TABLE app.composition_observation;
DROP TYPE app.composition_action;
ALTER TABLE app.inspection_warning DROP CONSTRAINT inspection_warning_tenant_id_id_key;

-- 000044 down, part A: the two cores and the two wrappers go, and 000037's
-- functions come back verbatim. The duplication is the point — a down
-- migration restores the state its up migration found (000039's down says
-- why), and 000037 is below the edit floor.
DROP FUNCTION app.end_combination(uuid, date);
DROP FUNCTION app.create_combination(uuid, jsonb, date);
DROP FUNCTION app.end_combination_at(uuid, timestamptz);
DROP FUNCTION app.create_combination_at(uuid, jsonb, timestamptz);

CREATE FUNCTION app.create_combination(p_motive uuid, p_towed jsonb,
                                       p_effective_on date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  veh      app.vehicle;
  start_at timestamptz;
  rig      uuid;
  m        record;
  ids      uuid[];
  other    text;
BEGIN
  IF p_towed IS NULL OR jsonb_typeof(p_towed) <> 'array' OR jsonb_array_length(p_towed) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig has at least one towed unit; a unit on its own needs no rig';
  END IF;
  start_at := app.tenant_day_instant(p_effective_on);
  IF start_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig is set as at today or earlier, never in the future';
  END IF;

  ids := ARRAY[p_motive] || ARRAY(SELECT (e ->> 'vehicle_id')::uuid FROM jsonb_array_elements(p_towed) e);
  IF p_motive IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017', MESSAGE = 'a rig names its motive unit';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ids) u WHERE u IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'every towed unit names a vehicle';
  END IF;
  IF (SELECT count(*) FROM unnest(ids) u) <> (SELECT count(DISTINCT u) FROM unnest(ids) u) THEN
    SELECT v.fleet_number INTO other FROM app.vehicle v
     WHERE v.id = (SELECT u FROM unnest(ids) u GROUP BY u HAVING count(*) > 1 LIMIT 1);
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = format('%s is named twice in this rig', COALESCE(other, 'a unit'));
  END IF;

  PERFORM 1 FROM app.vehicle v WHERE v.id = ANY(ids) ORDER BY v.id FOR UPDATE;

  FOR m IN
    SELECT u.id, u.ord, (u.ord = 1) AS is_motive,
           CASE WHEN u.ord = 1 THEN NULL
                ELSE (p_towed -> (u.ord - 2)::int ->> 'descriptor') END AS descriptor
      FROM unnest(ids) WITH ORDINALITY AS u(id, ord)
     ORDER BY u.ord
  LOOP
    SELECT * INTO veh FROM app.vehicle v WHERE v.id = m.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
    END IF;
    IF veh.unit_kind IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017',
        MESSAGE = format('%s has no unit kind recorded; set it before it joins a rig', veh.fleet_number);
    END IF;
    IF m.is_motive AND veh.unit_kind = 'TRAILER' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017',
        MESSAGE = format('a rig is headed by a horse, rigid or light vehicle; %s is a trailer', veh.fleet_number);
    END IF;
    IF NOT m.is_motive AND veh.unit_kind <> 'TRAILER' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017',
        MESSAGE = format('only a trailer is towed; %s is a %s', veh.fleet_number, lower(veh.unit_kind::text));
    END IF;
    IF veh.status IN ('DISPOSED', 'INACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017',
        MESSAGE = format('%s is %s; a retired unit is not coupled', veh.fleet_number, lower(veh.status::text));
    END IF;
    IF length(btrim(m.descriptor)) > 200 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017', MESSAGE = 'a descriptor is at most 200 characters';
    END IF;
  END LOOP;

  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from, created_by)
  VALUES (app.current_tenant_id(), p_motive, start_at, app.current_actor_id())
  RETURNING id INTO rig;

  FOR m IN
    SELECT u.id, u.ord,
           CASE WHEN u.ord = 1 THEN NULL
                ELSE NULLIF(btrim(p_towed -> (u.ord - 2)::int ->> 'descriptor'), '') END AS descriptor
      FROM unnest(ids) WITH ORDINALITY AS u(id, ord)
     ORDER BY u.ord
  LOOP
    INSERT INTO app.combination_member (tenant_id, combination_id, vehicle_id, sequence, descriptor, created_by)
    VALUES (app.current_tenant_id(), rig, m.id, m.ord, m.descriptor, app.current_actor_id());
  END LOOP;
  RETURN rig;
END $$;

CREATE FUNCTION app.end_combination(p_combination uuid, p_ended_on date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE c app.combination; end_at timestamptz;
BEGIN
  SELECT * INTO c FROM app.combination x WHERE x.id = p_combination FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such rig in this fleet';
  END IF;
  IF c.effective_to IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = format('this rig ended on %s', c.effective_to);
  END IF;
  end_at := app.tenant_day_instant(p_ended_on);
  IF end_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig is ended as at today or earlier, never in the future';
  END IF;
  IF end_at < c.effective_from THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = format('this rig started on %s; it cannot end before that', c.effective_from);
  END IF;
  UPDATE app.combination SET effective_to = end_at WHERE id = p_combination;
END $$;
