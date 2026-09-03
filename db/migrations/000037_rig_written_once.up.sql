-- ============================================================================
--  The rig surface: a combination is created once and ended once (TYRE-72)
--  Implements: FR-VEH-019, FR-VEH-030, FR-VEH-031, FR-INS-062 (the composition
--  the driver is offered), BR-FIT-006's ordering discipline applied to rigs;
--  spec U5 (INV-4), U6 (written once), U7 (motive is member 1), U8 (dates),
--  U9 (kinds and states), U10 (at least one towed unit), U12 (audited).
-- ============================================================================
-- SQLSTATEs (ours; the TY class forwards verbatim, ADR-0012):
--   TY012 — a row this tenant cannot see (one message per object)
--   TY017 — a rig write refused
--
-- Nothing new is stored. app.combination and app.combination_member have held
-- a rig's shape since 000001 and the capture read (000022's v_capture_vehicle)
-- and the driver's confirm screen already read them. What no migration has
-- said is what may WRITE them, and that is the whole of this one.
--
-- Invoker rights, like every routine in app except app.refresh_governing_tread:
-- RLS binds them inside the caller's tenant-bound transaction (suite 8c).

-- TYRE-124. 000025's closing comment says TY009 has no submitStatus entry and
-- that no HTTP path writes app.fitment. Both were true when it was written and
-- false since PR #41 (TYRE-92, 3 Sep 2026): submitStatus maps TY009 to 422
-- (api/internal/httpapi/httpapi.go) and fit, remove and rotate all write the
-- table. 000025 is merged and cannot be edited, so the catalog carries the
-- current claim here, where a reader of the function will find it.
COMMENT ON FUNCTION app.require_odometer_where_unit_has_one() IS
  'FR-FIT-002 by unit kind (000025). TY009 maps to 422 in submitStatus (ADR-0012); app.fit_tyre, app.remove_tyre and app.rotate_tyres (000033) write app.fitment. 000025''s trailing comment is superseded by this one.';

-- U6. Closing a rig IS an UPDATE of effective_to, so UPDATE stays granted
-- (000001) and only DELETE was revoked (000018); this bounds that UPDATE to
-- one shape. updated_at/updated_by are excluded from the comparison rather
-- than relying on trigger order, because combination_stamps_updated (000017)
-- writes them on every UPDATE — 000032's reasoning, applied here.
CREATE FUNCTION app.combination_is_written_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY017',
      MESSAGE = 'an ended rig cannot be changed',
      HINT    = 'set a new rig; composition history is never rewritten (FR-VEH-031)';
  END IF;
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.tenant_id         IS DISTINCT FROM OLD.tenant_id
  OR NEW.motive_vehicle_id IS DISTINCT FROM OLD.motive_vehicle_id
  OR NEW.effective_from    IS DISTINCT FROM OLD.effective_from
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  OR NEW.created_by        IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY017',
      MESSAGE = 'an open rig can only be ended, never edited',
      HINT    = 'end it and set a new one with the members you meant';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER combination_written_once
BEFORE UPDATE ON app.combination
FOR EACH ROW EXECUTE FUNCTION app.combination_is_written_once();

-- A member row is the record of who was in the rig; it changes only by the
-- rig ending and another starting. DELETE was revoked by 000018. This leaves
-- combination_member_stamps_updated (000017) and combination_member_audited's
-- UPDATE arm unreachable for app_rw; both stay, so no path is left unaudited
-- if the grant is ever restored.
REVOKE UPDATE ON app.combination_member FROM app_rw;

-- U5, INV-4 and its history, in the one place a raw INSERT meets them: a
-- unit is in at most one open rig, and never joins a rig that starts before
-- its last one ended. app.create_combination does not repeat either check
-- (000033's occupancy comment: a pre-check in the function is a second
-- implementation); it locks the member rows so two concurrent creates
-- serialise here rather than both passing. The message names the rig the
-- unit is in so the controller knows which one to end.
--
-- U6: this trigger is also the only place that refuses growing an ENDED
-- rig's membership by raw INSERT. An INSERT into an OPEN rig is left alone —
-- it is indistinguishable from app.create_combination's own inserts, which
-- run through this same trigger, so the function stays the only place that
-- decides whether a fresh member belongs.
CREATE FUNCTION app.combination_member_in_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE unit text; other text; starts timestamptz; ended timestamptz; left_at timestamptz;
BEGIN
  SELECT c.effective_from, c.effective_to INTO starts, ended FROM app.combination c WHERE c.id = NEW.combination_id;
  IF ended IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY017',
      MESSAGE = 'an ended rig''s members are never changed';
  END IF;
  SELECT v.fleet_number, mv.fleet_number, c.effective_to INTO unit, other, left_at
    FROM app.combination_member cm
    JOIN app.combination c  ON c.id = cm.combination_id
    JOIN app.vehicle v      ON v.id = cm.vehicle_id
    JOIN app.vehicle mv     ON mv.id = c.motive_vehicle_id
   WHERE cm.vehicle_id = NEW.vehicle_id
     AND c.id <> NEW.combination_id
     AND (c.effective_to IS NULL OR c.effective_to > starts)
   ORDER BY c.effective_to IS NULL DESC, c.effective_to DESC
   LIMIT 1;
  IF FOUND AND left_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY017',
      MESSAGE = format('%s is in the rig headed by %s; end that rig first', unit, other);
  ELSIF FOUND THEN
    -- Refused, not clamped (U8): a start before the last membership ended
    -- is a claim about the past that the record contradicts.
    RAISE EXCEPTION USING
      ERRCODE = 'TY017',
      MESSAGE = format('%s left the rig headed by %s on %s; this rig cannot start before that',
                       unit, other, left_at);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER combination_member_in_order
BEFORE INSERT ON app.combination_member
FOR EACH ROW EXECUTE FUNCTION app.combination_member_in_order();

-- U12, ADR-0014: the two tables this batch gives a write path to.
CREATE TRIGGER combination_audited
AFTER INSERT OR UPDATE ON app.combination
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER combination_member_audited
AFTER INSERT OR UPDATE ON app.combination_member
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- U8, the one day-to-instant rule. Today is now() — midnight would lose to
-- the same day's earlier events (000033:644-654's reasoning); an earlier
-- day is that day's midnight in the TENANT's zone, never the session's
-- (rule 6, lesson 2026-09-01); a later day answers NULL so the caller
-- refuses in its own code and words. app.dispatch_tyre (000033) and
-- app.log_retread_return (000034) carry this rule inline today; B6.3
-- replaces both functions and points them here, so this is the copy that
-- survives, not a third.
CREATE FUNCTION app.tenant_day_instant(p_on date)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = app, pg_temp AS $$
DECLARE tz text; today date;
BEGIN
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  today := app.tenant_today(tz);
  IF p_on IS NULL OR p_on = today THEN
    RETURN now();
  END IF;
  IF p_on > today THEN
    RETURN NULL;
  END IF;
  RETURN p_on::timestamp AT TIME ZONE tz;
END $$;

-- The one way a rig comes to exist. p_towed is the walk order, and the
-- motive unit is member 1 (U7) because the fixture and capture.go already
-- read it that way; FR-VEH-034's 1..n projection is computed from exactly
-- this sequence and never stored (ADR-0007).
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
    -- U10: FR-VEH-030 permits zero towed units; a one-member rig changes
    -- nothing the capture or the register reads, so it is declined here.
    RAISE EXCEPTION USING ERRCODE = 'TY017',
      MESSAGE = 'a rig has at least one towed unit; a unit on its own needs no rig';
  END IF;
  start_at := app.tenant_day_instant(p_effective_on);
  IF start_at IS NULL THEN
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

-- Ending a rig touches nothing else: the tyres stay on their units (INV-1),
-- which is the reason a rig is not a configuration (ADR-0007). An open task
-- or an in-progress capture is unaffected — the driver's next capture start
-- simply offers no rig.
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
