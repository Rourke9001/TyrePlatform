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

-- ---------------------------------------------------------------------------
-- Part B. What a controller decided about a reported difference.
--
-- app.inspection_warning is append-only (DR-021, 000022), so a resolution
-- cannot be a column on the warning; it is its own record. One row per
-- warning, ever: composition_observation_once is what makes a second apply a
-- refusal rather than a second rig change, and it is the backstop under the
-- FOR UPDATE the two functions take on the offered rig.
--
-- resulting_combination_id is NULL for a DISMISSED row and for an APPLIED row
-- whose observed set is the motive alone: under D5 the driver can only untick,
-- so "everything was uncoupled" ends the rig and opens nothing (U10 declines a
-- one-member rig).

-- The composite target every tenant-scoped FK in this schema points at
-- (000004's shape); 000022 did not add it because nothing referenced a warning
-- until now.
ALTER TABLE app.inspection_warning
  ADD CONSTRAINT inspection_warning_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TYPE app.composition_action AS ENUM ('APPLIED', 'DISMISSED');

CREATE TABLE app.composition_observation (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  warning_id                uuid NOT NULL,
  combination_id            uuid NOT NULL,
  action                    app.composition_action NOT NULL,
  resulting_combination_id  uuid,
  note                      text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- A decision without its decider is not a record, and app_rw holds INSERT,
  -- so an explicit NULL would pass the default by (TYRE-75).
  created_by                uuid NOT NULL DEFAULT app.current_actor_id(),
  CONSTRAINT composition_observation_warning_fkey
    FOREIGN KEY (tenant_id, warning_id)
      REFERENCES app.inspection_warning (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT composition_observation_offered_fkey
    FOREIGN KEY (tenant_id, combination_id) REFERENCES app.combination (tenant_id, id),
  CONSTRAINT composition_observation_resulting_fkey
    FOREIGN KEY (tenant_id, resulting_combination_id) REFERENCES app.combination (tenant_id, id),
  CONSTRAINT composition_observation_created_by_fkey
    FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT composition_observation_once UNIQUE (tenant_id, warning_id),
  -- A dismissal is a person overruling the driver's eyes, so it says why
  -- (owner, 7 Sep 2026). An apply's note is optional: the rig change itself
  -- is the record.
  CONSTRAINT dismissal_has_note
    CHECK (action <> 'DISMISSED' OR (note IS NOT NULL AND btrim(note) <> '')),
  CONSTRAINT dismissal_opens_no_rig
    CHECK (action <> 'DISMISSED' OR resulting_combination_id IS NULL)
);

-- composition_observation_once already indexes (tenant_id, warning_id), which
-- is the resolution lookup. This one is the other question the surface asks:
-- what has been decided about this rig.
CREATE INDEX composition_observation_by_rig
  ON app.composition_observation (tenant_id, combination_id);

CALL app.enable_tenant_rls('app.composition_observation'::regclass);
GRANT SELECT, INSERT ON app.composition_observation TO app_rw;
-- Rule 3: a record of a decision is enforced by grant, not convention. A wrong
-- resolution is compensated by a rig set by hand, never rewritten.
REVOKE UPDATE, DELETE ON app.composition_observation FROM app_rw;

-- ADR-0014: a table with a write path is audited.
CREATE TRIGGER composition_observation_audited
AFTER INSERT OR UPDATE ON app.composition_observation
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

COMMENT ON TABLE app.composition_observation IS
  'What a controller decided about one FR-INS-063 report: applied into a dated rig change, or dismissed with a reason (spec B6.4, TYRE-75). One row per warning; append-only.';

-- The reconciliation BR-FIT-008 asks for: a difference a capture inferred is
-- resolved by a person, and the resolution is a dated composition change, not
-- an edit to anything already written. The instant is the phone's started_at
-- bounded by the record's own server-stamped facts (owner, 8 Sep 2026; the SRS
-- names no instant, so this is a ruling rather than a conflict) — the bound is
-- computed below, where its reasoning sits beside it.
--
-- Returns the new rig's id, or NULL when the observed set is the motive alone.
--
-- Nothing here re-implements a rig rule: what may be coupled, INV-4 and its
-- history, and the written-once triggers are 000037's, met through the cores
-- 000044 part A created. What this function holds is what a trigger cannot —
-- the lock, the order of two writes, and a message that names the report.
CREATE FUNCTION app.apply_composition_observation(p_warning uuid, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  w_code      text;
  w_source    app.warning_source;
  w_value     text;
  i_state     app.inspection_state;
  i_started   timestamptz;
  i_received  timestamptz;
  observed_at timestamptz;
  rig         app.combination;
  resolved    app.composition_observation;
  observed    uuid[];
  outside     text;
  motive_fn   text;
  towed       jsonb;
  new_rig     uuid;
BEGIN
  -- RLS-scoped, so this answers "visible to this tenant", never "exists".
  -- One SELECT for the warning and its inspection: a warning is only ever
  -- read through the capture that raised it.
  SELECT w.warning_code, w.source, w.entered_value, i.state, i.started_at, i.received_at
    INTO w_code, w_source, w_value, i_state, i_started, i_received
    FROM app.inspection_warning w
    JOIN app.inspection i ON i.id = w.inspection_id
   WHERE w.id = p_warning;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such observation in this fleet';
  END IF;
  -- The source is half the kind. app.submit_inspection writes every warning
  -- the payload carries with the code the payload names and source = 'CLIENT'
  -- (000041), and no whitelist stands between the two, so a capture can carry
  -- an FR-INS-063 row of its own — and a row a client wrote is a claim, never
  -- the mismatch the server itself detected against the offered rig. One
  -- message, one home: a client's FR-INS-063 is not a composition report for
  -- the same reason a fitment warning is not.
  IF w_code IS DISTINCT FROM 'FR-INS-063' OR w_source IS DISTINCT FROM 'SERVER' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'this warning is not a composition report';
  END IF;
  IF i_state = 'VOIDED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the inspection was voided; nothing to apply',
      HINT    = 'a voided capture is not evidence of a coupling (FR-INS-012)';
  END IF;

  -- The rig the driver was offered, locked before the resolved check so two
  -- controllers acting on one report serialise here; composition_observation_once
  -- is the backstop, not the mechanism. Lock first, then read: 000037's
  -- end_combination takes its FOR UPDATE in the same statement that reads the
  -- row, for the same reason.
  SELECT c.* INTO rig
    FROM app.combination c
    JOIN app.inspection i ON i.combination_id = c.id
   WHERE i.id = (SELECT w.inspection_id FROM app.inspection_warning w WHERE w.id = p_warning)
     FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the report names no rig; set the rig by hand';
  END IF;

  SELECT o.* INTO resolved FROM app.composition_observation o
   WHERE o.warning_id = p_warning;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = format('this report was already %s on %s',
                       lower(resolved.action::text), resolved.created_at);
  END IF;
  IF rig.effective_to IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = format('stale: the rig ended on %s', rig.effective_to),
      HINT    = 'dismiss the report; the coupling it describes is history';
  END IF;

  -- 000041 stores the observed set as the raw JSON array text the payload
  -- carried, motive included (its box is disabled and checked). A value that
  -- is not an array reaches the ::jsonb cast as 22P02, which
  -- refusalForPgError maps to invalid_submission — honest, and unreachable
  -- from the submit path that writes these rows.
  IF w_value IS NULL OR jsonb_typeof(w_value::jsonb) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the report carries no observed set; set the rig by hand';
  END IF;
  SELECT array_agg(e::uuid) INTO observed
    FROM jsonb_array_elements_text(w_value::jsonb) e;
  -- A JSON null survives the ::uuid cast as a NULL id, invisible to every
  -- check below: `= ANY(observed)` answers NULL for it, and the outside
  -- check's COALESCE renders it as a member that is simply absent — so a
  -- report of nothing usable would end a rig and open the motive alone. One
  -- message, one home: the same TY022 an absent value answers with.
  IF observed IS NULL OR cardinality(observed) = 0
     OR array_position(observed, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the report carries no observed set; set the rig by hand';
  END IF;

  -- D5 permits removals only, so anything the report names that the offered
  -- rig did not hold is a report this function cannot turn into a composition
  -- — the FULL JOIN in 000041 raises the warning in either direction, so the
  -- shape is reachable on the wire even though the client cannot produce it.
  --
  -- LEFT JOIN, and the id itself when no unit answers to it: an observed id
  -- this tenant cannot see is not in the offered rig either, and an inner join
  -- would drop it from this check and let the resolution proceed as though the
  -- driver had never named it.
  SELECT COALESCE(v.fleet_number, o.id::text) INTO outside
    FROM unnest(observed) o(id)
    LEFT JOIN app.vehicle v ON v.id = o.id
   WHERE NOT EXISTS (SELECT 1 FROM app.combination_member cm
                      WHERE cm.combination_id = rig.id AND cm.vehicle_id = o.id)
   LIMIT 1;
  IF outside IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = format('the report names %s, which is not in the offered rig; set the rig by hand', outside);
  END IF;
  IF NOT (rig.motive_vehicle_id = ANY(observed)) THEN
    SELECT v.fleet_number INTO motive_fn FROM app.vehicle v WHERE v.id = rig.motive_vehicle_id;
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = format('the report does not name %s, the rig''s motive unit; set the rig by hand', motive_fn);
  END IF;

  -- The observed instant (owner, 8 Sep 2026): the phone's started_at, bounded
  -- by the server's own facts about this very record. The server's time of
  -- hearing is not the time of seeing — ADR-0009's outbox can hold a submit
  -- for days, so received_at or the controller's apply instant would date the
  -- coupling change days after the driver saw the trailer gone — and the
  -- phone's clock is untrusted, so it is used only inside the window the
  -- record can defend. A slow phone lands on the rig's own instant, which is
  -- an honest zero-length rig: set, then immediately reported different. A
  -- fast phone lands on the instant the server received the submit.
  --
  -- This is not the clamp lesson 2026-09-03 forbids: that one clamps a
  -- user-supplied date onto ANOTHER event's instant, which ties two events
  -- together and leaves an as-of read unable to order them. Both bounds here
  -- are this record's own server-stamped facts, and combination_member_in_order
  -- (000037) compares strictly, so an end and a start at one instant stay
  -- ordered.
  observed_at := greatest(rig.effective_from, least(i_started, i_received));

  PERFORM app.end_combination_at(rig.id, observed_at);

  -- The observed members in the offered rig's own walk order, descriptors
  -- carried: the driver reported which units were absent, not a new order.
  -- combination_member_in_order compares c.effective_to > starts strictly, so
  -- a member leaving at this instant may join the rig starting at it.
  SELECT jsonb_agg(jsonb_build_object('vehicle_id', cm.vehicle_id, 'descriptor', cm.descriptor)
                   ORDER BY cm.sequence)
    INTO towed
    FROM app.combination_member cm
   WHERE cm.combination_id = rig.id
     AND cm.vehicle_id = ANY(observed)
     AND cm.vehicle_id <> rig.motive_vehicle_id;
  IF towed IS NOT NULL THEN
    new_rig := app.create_combination_at(rig.motive_vehicle_id, towed, observed_at);
  END IF;

  INSERT INTO app.composition_observation
    (tenant_id, warning_id, combination_id, action, resulting_combination_id, note)
  VALUES (app.current_tenant_id(), p_warning, rig.id, 'APPLIED', new_rig, NULLIF(btrim(p_note), ''));
  RETURN new_rig;
END $$;

REVOKE ALL ON FUNCTION app.apply_composition_observation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.apply_composition_observation(uuid, text) TO app_rw;

-- The other half of BR-FIT-008's resolution: the controller looked and the
-- rig is right, or the report is too old to act on. It writes the record and
-- touches no rig — which is what makes "a dismissed report changed nothing"
-- an assertion section 58 can make about the register, not about a flag.
--
-- The visibility, kind and resolved checks are apply's, in apply's order and
-- for apply's reasons; a stale rig is deliberately NOT refused here, because
-- dismissing is exactly what a stale report is for.
CREATE FUNCTION app.dismiss_composition_observation(p_warning uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  w_code   text;
  w_source app.warning_source;
  i_state  app.inspection_state;
  rig      app.combination;
  resolved app.composition_observation;
BEGIN
  -- Required by the owner's 7 Sep 2026 ruling (TYRE-75 comment 12216).
  IF p_note IS NULL OR btrim(p_note) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'a dismissal carries a reason',
      HINT    = 'say why the driver''s report is not being applied';
  END IF;
  SELECT w.warning_code, w.source, i.state INTO w_code, w_source, i_state
    FROM app.inspection_warning w
    JOIN app.inspection i ON i.id = w.inspection_id
   WHERE w.id = p_warning;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such observation in this fleet';
  END IF;
  IF w_code IS DISTINCT FROM 'FR-INS-063' OR w_source IS DISTINCT FROM 'SERVER' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'this warning is not a composition report';
  END IF;
  IF i_state = 'VOIDED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the inspection was voided; nothing to apply',
      HINT    = 'a voided capture is not evidence of a coupling (FR-INS-012)';
  END IF;

  SELECT c.* INTO rig
    FROM app.combination c
    JOIN app.inspection i ON i.combination_id = c.id
   WHERE i.id = (SELECT w.inspection_id FROM app.inspection_warning w WHERE w.id = p_warning)
     FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = 'the report names no rig; set the rig by hand';
  END IF;

  SELECT o.* INTO resolved FROM app.composition_observation o
   WHERE o.warning_id = p_warning;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY022',
      MESSAGE = format('this report was already %s on %s',
                       lower(resolved.action::text), resolved.created_at);
  END IF;

  INSERT INTO app.composition_observation
    (tenant_id, warning_id, combination_id, action, note)
  VALUES (app.current_tenant_id(), p_warning, rig.id, 'DISMISSED', btrim(p_note));
END $$;

REVOKE ALL ON FUNCTION app.dismiss_composition_observation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dismiss_composition_observation(uuid, text) TO app_rw;
