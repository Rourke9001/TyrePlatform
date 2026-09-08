-- ============================================================================
--  Reconciling a reported composition into a dated rig change (TYRE-75)
--  Implements: spec 2026-09-03-b6-rig-setup-design.md §B6.4; FR-INS-063 as
--  corrected by errata D5 (the driver unticks, never adds); BR-FIT-008 (an
--  inference from a capture raises a reconciliation a person resolves).
-- ============================================================================
-- SQLSTATEs (ours; the TY class forwards verbatim, ADR-0012):
--   TY012 — a row this tenant cannot see (one message per object)
--   TY017 — a rig write refused (000037's own code, raised by the cores)
--   TY022 — a composition observation refused (part B, below)
--
-- Part A. The rig write rules live in 000037 and are not restated here: what
-- may head a rig, what may be towed, INV-4 and its history, the day-to-instant
-- rule and the written-once triggers are all that migration's, and the two
-- cores below carry its two function bodies forward unchanged except for where
-- the instant comes from. A resolution has to end the offered rig and open the
-- next one at the instant the capture observed — an instant, not a day — and
-- 000037 exposes only a date. Rather than amend a merged migration or add a
-- timestamptz overload (ambiguous: section 45 calls end_combination(rig) and
-- passes untyped literals), the instant-taking form gets its own name and the
-- date-taking form becomes a thin wrapper over it.
--
-- The wrapper passes app.tenant_day_instant's answer through even when it is
-- NULL, and the core raises the future refusal in the same position 000037
-- raised it. Raising it in the wrapper would move it ahead of end_combination's
-- TY012, and an invisible rig named with tomorrow's date would stop answering
-- "no such rig in this fleet".
--
-- Invoker rights, like every routine in app except app.refresh_governing_tread;
-- a pinned search_path on each (suite checks 8c and 8d, 000043).

DROP FUNCTION app.end_combination(uuid, date);
DROP FUNCTION app.create_combination(uuid, jsonb, date);

-- 000037's end_combination body, with the instant given rather than derived.
-- Ending a rig touches nothing else: the tyres stay on their units (INV-1),
-- which is the reason a rig is not a configuration (ADR-0007).
CREATE FUNCTION app.end_combination_at(p_combination uuid, p_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE c app.combination;
BEGIN
  SELECT * INTO c FROM app.combination x WHERE x.id = p_combination FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such rig in this fleet';
  END IF;
  IF c.effective_to IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = format('this rig ended on %s', c.effective_to);
  END IF;
  -- NULL is app.tenant_day_instant's answer for a later day, forwarded by the
  -- wrapper below; a caller holding a real instant reaches the same refusal
  -- through the second half.
  IF p_at IS NULL OR p_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig is ended as at today or earlier, never in the future';
  END IF;
  IF p_at < c.effective_from THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = format('this rig started on %s; it cannot end before that', c.effective_from);
  END IF;
  UPDATE app.combination SET effective_to = p_at WHERE id = p_combination;
END $$;

REVOKE ALL ON FUNCTION app.end_combination_at(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_combination_at(uuid, timestamptz) TO app_rw;

-- 000037's create_combination body, with the instant given rather than derived.
-- The motive unit is member 1 (U7); FR-VEH-034's 1..n projection is computed
-- from exactly this sequence and never stored (ADR-0007).
CREATE FUNCTION app.create_combination_at(p_motive uuid, p_towed jsonb,
                                          p_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  veh      app.vehicle;
  rig      uuid;
  m        record;
  ids      uuid[];
  other    text;
BEGIN
  IF p_towed IS NULL OR jsonb_typeof(p_towed) <> 'array' OR jsonb_array_length(p_towed) = 0 THEN
    -- U10: FR-VEH-030 permits zero towed units; a one-member rig changes
    -- nothing the capture or the register reads, so it is declined here.
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig has at least one towed unit; a unit on its own needs no rig';
  END IF;
  IF p_at IS NULL OR p_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig is set as at today or earlier, never in the future';
  END IF;

  -- Every unit in the rig, motive first, in walk order. What is checked in
  -- the walk-order loop below is the shape of the inputs — kind, state,
  -- length — never a rule the trigger already holds.
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

  -- Every named unit is locked once here, in ascending id order, before any
  -- row is read: Postgres grants FOR UPDATE locks in a query's output
  -- order, so two concurrent creates whose member sets overlap in opposite
  -- walk orders (A: motive X, towed [Y]; B: motive Y, towed [X]) always
  -- acquire X and Y in the same sequence and cannot deadlock behind one
  -- another (40P01). A fit on the same unit takes FOR SHARE (000033) and
  -- waits the milliseconds this holds the lock. Lock order is canonical
  -- (by id); member sequence is walk order, set by the loop below.
  PERFORM 1 FROM app.vehicle v WHERE v.id = ANY(ids) ORDER BY v.id FOR UPDATE;

  -- WITH ORDINALITY yields bigint and jsonb has no -> bigint operator, hence
  -- the ::int on the subscript in both loops.
  FOR m IN
    SELECT u.id, u.ord, (u.ord = 1) AS is_motive,
           CASE WHEN u.ord = 1 THEN NULL
                ELSE (p_towed -> (u.ord - 2)::int ->> 'descriptor') END AS descriptor
      FROM unnest(ids) WITH ORDINALITY AS u(id, ord)
     ORDER BY u.ord
  LOOP
    -- No FOR UPDATE here: every row named in ids is already locked above,
    -- in canonical order.
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
    -- U9: retired units are refused; PARKED, WORKSHOP and OUT_OF_SERVICE are
    -- not — FR-VEH-006 pauses a unit's schedule, not the yard's coupling.
    IF veh.status IN ('DISPOSED', 'INACTIVE') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY017',
        MESSAGE = format('%s is %s; a retired unit is not coupled', veh.fleet_number, lower(veh.status::text));
    END IF;
    IF length(btrim(m.descriptor)) > 200 THEN
      -- TYRE-128 decision 5: every new text input is bounded here, never by
      -- adding 22001 to the wire map. Bounded on the trimmed value so the
      -- descriptor refused here is the one the insert loop below stores.
      RAISE EXCEPTION USING ERRCODE = 'TY017', MESSAGE = 'a descriptor is at most 200 characters';
    END IF;
  END LOOP;

  INSERT INTO app.combination (tenant_id, motive_vehicle_id, effective_from, created_by)
  VALUES (app.current_tenant_id(), p_motive, p_at, app.current_actor_id())
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

REVOKE ALL ON FUNCTION app.create_combination_at(uuid, jsonb, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_combination_at(uuid, jsonb, timestamptz) TO app_rw;

-- The date-taking forms the API and the suite call (000037's signatures,
-- unchanged including the DEFAULT, so app.end_combination(rig) still resolves).
-- U8's day-to-instant rule stays app.tenant_day_instant's; the NULL it answers
-- for a later day is forwarded rather than refused here, so the core keeps the
-- refusal in the position 000037 put it. No REVOKE/GRANT pair: 000037 left
-- these on the PUBLIC default and this migration does not change who may call
-- what a caller could already call.
CREATE FUNCTION app.end_combination(p_combination uuid, p_ended_on date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  PERFORM app.end_combination_at(p_combination, app.tenant_day_instant(p_ended_on));
END $$;

CREATE FUNCTION app.create_combination(p_motive uuid, p_towed jsonb,
                                       p_effective_on date DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  RETURN app.create_combination_at(p_motive, p_towed, app.tenant_day_instant(p_effective_on));
END $$;
