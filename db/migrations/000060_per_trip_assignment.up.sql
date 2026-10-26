-- ============================================================================
--  Per-trip driver assignment and nominated drivers for idle units (TYRE-326)
--  Implements: FR-VEH-007, FR-INS-050 to FR-INS-053, FR-AUT-005, FR-OFF-015,
--  each as amended by the SRS Part 3 errata tagged TYRE-440, TYRE-284 and
--  TYRE-326; ADR-0012, ADR-0013, ADR-0014. Design:
--  docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md
-- ============================================================================
-- New SQLSTATE TY028 (a trip write refused)
-- (api/internal/httpapi/refusal_codes.json). Every write function here runs
-- with invoker rights and names its tenant in every read and write
-- (db/CLAUDE.md, Adding a function).
--
-- Parts, in order: A keys and indexes; B app.trip; C
-- app.inspection_task_nomination; D the task's close instant; E today's
-- data into the new model; F the old readers retired; G coverage and
-- responsibility; H capture; I writes; J vehicle_driver becomes history.

-- ---------------------------------------------------------------------------
-- A. Keys and indexes
-- ---------------------------------------------------------------------------
-- The composite keys a nomination's task and a migrated trip's assignment
-- reference, so neither FK can name another tenant's row (check 16).
ALTER TABLE app.inspection_task ADD CONSTRAINT inspection_task_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app.vehicle_driver ADD CONSTRAINT vehicle_driver_tenant_id_id_key UNIQUE (tenant_id, id);

-- Every coverage read finds a unit's rigs by the unit, and a motive's rigs by
-- the motive; no other index on either table leads with either.
CREATE INDEX combination_member_by_vehicle ON app.combination_member (tenant_id, vehicle_id);
CREATE INDEX combination_by_motive ON app.combination (tenant_id, motive_vehicle_id);

-- ---------------------------------------------------------------------------
-- B. app.trip (FR-VEH-007 as amended, SRS 5.1 trip)
-- ---------------------------------------------------------------------------
-- combination_id is the motive's open rig just after the start, a snapshot
-- only: a rig ended and reopened mid-trip is read at the instant in
-- question, never through this column (spec, The trip).
-- migrated_from_assignment_id marks a trip the migration made from a
-- vehicle_driver row (spec, vehicle_driver becomes history).
CREATE TABLE app.trip (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES app.tenant (id) ON DELETE CASCADE,
  vehicle_id                  uuid NOT NULL,
  user_id                     uuid NOT NULL,
  started_at                  timestamptz NOT NULL DEFAULT now(),
  ended_at                    timestamptz,
  started_by                  uuid DEFAULT app.current_actor_id(),
  ended_by                    uuid,
  combination_id              uuid,
  migrated_from_assignment_id uuid,
  updated_at                  timestamptz,
  updated_by                  uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id)                  REFERENCES app.vehicle (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)                     REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, started_by)                  REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by)                    REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, combination_id)              REFERENCES app.combination (tenant_id, id),
  FOREIGN KEY (tenant_id, migrated_from_assignment_id) REFERENCES app.vehicle_driver (tenant_id, id),
  CONSTRAINT trip_ends_after_start CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- One driver per motive and one motive per driver at an instant (U143).
  -- '[)' so a start may end one trip and open the next at the same instant.
  -- tenant_id leads each key because an exclusion check bypasses RLS, so a
  -- key without it would tell a caller whether another tenant's unit was on
  -- a trip at an instant (section 37).
  CONSTRAINT trip_vehicle_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, vehicle_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&),
  CONSTRAINT trip_driver_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, user_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
);
CALL app.enable_tenant_rls('app.trip'::regclass);
-- Ending a trip is the one edit, and trip_is_ended_once holds its shape
-- (check 4, section 76c).
GRANT INSERT ON app.trip TO app_rw;
GRANT UPDATE (ended_at, ended_by) ON app.trip TO app_rw;
COMMENT ON TABLE app.trip IS
  'A driver on a motive unit from one instant to another (FR-VEH-007 as amended, TYRE-326). A trip ends once and is never edited; docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';

-- updated_at and updated_by are excluded from the comparison, because
-- trip_stamps_updated writes them on every UPDATE.
CREATE FUNCTION app.trip_is_ended_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'an ended trip is never changed',
      HINT    = 'start a new trip; trip history is never rewritten (FR-VEH-007)';
  END IF;
  IF NEW.ended_at IS NULL
  OR NEW.id                          IS DISTINCT FROM OLD.id
  OR NEW.tenant_id                   IS DISTINCT FROM OLD.tenant_id
  OR NEW.vehicle_id                  IS DISTINCT FROM OLD.vehicle_id
  OR NEW.user_id                     IS DISTINCT FROM OLD.user_id
  OR NEW.started_at                  IS DISTINCT FROM OLD.started_at
  OR NEW.started_by                  IS DISTINCT FROM OLD.started_by
  OR NEW.combination_id              IS DISTINCT FROM OLD.combination_id
  OR NEW.migrated_from_assignment_id IS DISTINCT FROM OLD.migrated_from_assignment_id THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'an open trip can only be ended, never edited';
  END IF;
  -- Trips end at the server's now (spec, Starting and ending a trip): an
  -- earlier end would rewrite who held a task and which captures were
  -- admitted after the fact, and a later one would close coverage nobody has
  -- yet given up.
  IF NEW.ended_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'a trip ends at the server''s now, never earlier or later';
  END IF;
  -- The ender is the bound actor, as updated_by is, never the caller's claim
  -- (ADR-0011).
  NEW.ended_by := app.current_actor_id();
  RETURN NEW;
END $$;

CREATE TRIGGER trip_ended_once BEFORE UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.trip_is_ended_once();

CREATE TRIGGER trip_stamps_updated BEFORE UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

CREATE TRIGGER trip_audited
AFTER INSERT OR UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- app_rw holds INSERT, so a raw trip meets app.start_trip's shape rules
-- here, in its words and its order. Its bounds at now are this trigger's,
-- in words of its own (FR-VEH-007 as amended). A past start is ADR-0013's
-- accepted gap (U152).
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

-- ---------------------------------------------------------------------------
-- C. app.inspection_task_nomination (FR-INS-051, FR-INS-053 as amended)
-- ---------------------------------------------------------------------------
-- nominated_by is nullable: a generated task's requested_by is NULL, and the
-- migration copies it as the nominator.
CREATE TABLE app.inspection_task_nomination (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant (id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,
  user_id      uuid NOT NULL,
  nominated_at timestamptz NOT NULL DEFAULT now(),
  nominated_by uuid DEFAULT app.current_actor_id(),
  UNIQUE (tenant_id, id),
  -- Who was nominated at an instant has one answer (spec, Who is
  -- responsible for a task).
  CONSTRAINT nomination_one_per_instant UNIQUE (tenant_id, task_id, nominated_at),
  FOREIGN KEY (tenant_id, task_id)      REFERENCES app.inspection_task (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id)      REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, nominated_by) REFERENCES app.app_user (tenant_id, id)
);
CALL app.enable_tenant_rls('app.inspection_task_nomination'::regclass);
-- A replaced nominee is a newer row, and the capture window and the
-- due-instant attribution both read who was nominated at a past instant, so
-- the history is the point (rule 3).
GRANT INSERT ON app.inspection_task_nomination TO app_rw;
REVOKE UPDATE, DELETE ON app.inspection_task_nomination FROM app_rw;
CREATE INDEX nomination_by_user ON app.inspection_task_nomination (tenant_id, user_id);
COMMENT ON TABLE app.inspection_task_nomination IS
  'A driver named for one inspection task (FR-INS-051, FR-INS-053 as amended, TYRE-326). Insert-only history: a new nominee is a newer row; docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';

CREATE TRIGGER inspection_task_nomination_audited
AFTER INSERT OR UPDATE ON app.inspection_task_nomination
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- app_rw holds INSERT, so a raw nomination meets app.nominate_for_task's
-- task and nominee rules here, an open task and an active nominee, in its
-- words and its order. Its bound at now is this trigger's, in words of its
-- own. A unit a trip covers stays the function's to refuse, because part E
-- copies each assignee at its task's creation, which a migrated trip may
-- cover (FR-INS-051 as amended). A past instant is ADR-0013's accepted gap
-- (U152).
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

-- ---------------------------------------------------------------------------
-- D. The task's close instant (FR-INS-052; spec, Capture)
-- ---------------------------------------------------------------------------
-- "Outstanding at an instant" needs the instant each task left OPEN, and the
-- audit log is not a read path (spec). A closed task's last write is its
-- close, so its updated_at, or its created_at when it was planted closed, is
-- that instant. Each UPDATE here fires inspection_task_stamps_updated and the
-- audit trigger, so those rows' updated_at reads the migration's instant.
ALTER TABLE app.inspection_task ADD COLUMN closed_at timestamptz;
UPDATE app.inspection_task SET closed_at = COALESCE(updated_at, created_at)
 WHERE state IN ('COMPLETED', 'CANCELLED');
-- Escalated is worked out, never stored: a task nobody holds reads escalated
-- through app.task_driver_at. The enum value stays, because dropping one is a
-- type rebuild for no gain (spec, Escalation, overdue and the task states).
UPDATE app.inspection_task SET state = 'OPEN' WHERE state = 'ESCALATED';
ALTER TABLE app.inspection_task
  ADD CONSTRAINT task_never_escalated CHECK (state <> 'ESCALATED');
ALTER TABLE app.inspection_task
  ADD CONSTRAINT task_closed_when_not_open CHECK ((state = 'OPEN') = (closed_at IS NULL));

-- The one test of what may complete a unit's task (FR-INS-052): an
-- inspection of the unit, or one carrying a reading of it, as a rig capture
-- addressed to its motive reads each towed unit.
CREATE FUNCTION app.inspection_read_unit(p_tenant uuid, p_inspection uuid, p_vehicle uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app.inspection i
                  WHERE i.tenant_id = p_tenant AND i.id = p_inspection AND i.vehicle_id = p_vehicle)
      OR EXISTS (SELECT 1 FROM app.reading r
                  WHERE r.tenant_id = p_tenant AND r.vehicle_id = p_vehicle AND r.inspection_id = p_inspection)
$$;

-- A close is final (rule 3): the responsibility and capture reads judge a
-- past instant by closed_at, so a reopened task would rewrite who held it
-- then. An INSERT may plant a past close; an UPDATE stamps the close itself.
CREATE FUNCTION app.inspection_task_closes_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  unit text;
BEGIN
  -- A completed task cites an inspection of its unit or one that read it.
  -- Otherwise the task reads done for a unit nobody inspected, its schedule
  -- stands the next task down and the unit leaves the controller's
  -- outstanding work (FR-INS-052). It is judged as the task leaves OPEN or
  -- is planted completed.
  IF NEW.state = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD.state = 'OPEN') THEN
    -- A unit or inspection the bound fleet cannot see is refused with its
    -- FK's code and name, as app.trip_is_well_formed refuses one (check 16).
    -- A NULL citation is completion_cites_an_inspection's to refuse.
    SELECT v.fleet_number INTO unit FROM app.vehicle v
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.vehicle_id;
    IF NOT FOUND AND NEW.vehicle_id IS NOT NULL AND NEW.tenant_id = app.current_tenant_id() THEN
      RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation',
        CONSTRAINT = 'inspection_task_tenant_id_vehicle_id_fkey',
        MESSAGE = 'an inspection task names a unit this statement cannot see';
    END IF;
    IF FOUND AND NEW.completed_inspection_id IS NOT NULL THEN
      PERFORM 1 FROM app.inspection i
       WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.completed_inspection_id;
      IF NOT FOUND AND NEW.tenant_id = app.current_tenant_id() THEN
        RAISE EXCEPTION USING ERRCODE = 'foreign_key_violation',
          CONSTRAINT = 'inspection_task_tenant_id_completed_inspection_id_fkey',
          MESSAGE = 'an inspection task cites an inspection this statement cannot see';
      END IF;
      IF FOUND AND NOT app.inspection_read_unit(NEW.tenant_id, NEW.completed_inspection_id, NEW.vehicle_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'TY018',
          MESSAGE = format('this inspection task is on %s; an inspection that never read that unit cannot complete it', unit);
      END IF;
    END IF;
  END IF;
  -- A task nobody completed names no completing inspection, or the close
  -- would freeze a citation of a completion that never happened (rule 3).
  -- It is judged as a row is planted or an open one changes its state or
  -- citation, so an UPDATE of anything else never re-judges an old row.
  IF NEW.state <> 'COMPLETED' AND NEW.completed_inspection_id IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (OLD.state = 'OPEN'
              AND (NEW.state IS DISTINCT FROM OLD.state
                   OR NEW.completed_inspection_id IS DISTINCT FROM OLD.completed_inspection_id))) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection task is %s; only a completed task cites a completing inspection', lower(NEW.state::text));
  END IF;
  -- A task nobody cancelled carries no reason, for the same freeze. Only a
  -- change to the reason is judged, never a change of state, so a capture
  -- still closes an open task a raw write left a reason on (FR-INS-052).
  IF NEW.state <> 'CANCELLED' AND NEW.cancelled_reason IS NOT NULL
     AND (TG_OP = 'INSERT'
          OR (OLD.state = 'OPEN' AND NEW.cancelled_reason IS DISTINCT FROM OLD.cancelled_reason)) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection task is %s; only a cancelled task carries a cancellation reason', lower(NEW.state::text));
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state IN ('COMPLETED', 'CANCELLED')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection task is %s; a closed task never changes state', lower(OLD.state::text));
  END IF;
  -- A completed task counts for the driver whose inspection completed it
  -- (spec, Decisions 2), so the citation and the reason are as final as the
  -- state. Named, not the whole row: schedule_id's ON DELETE SET NULL still
  -- reaches a closed task (db/tests/005_privileged.sql, P16).
  IF TG_OP = 'UPDATE' AND OLD.state IN ('COMPLETED', 'CANCELLED')
     AND (NEW.completed_inspection_id IS DISTINCT FROM OLD.completed_inspection_id
          OR NEW.cancelled_reason IS DISTINCT FROM OLD.cancelled_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection task is %s; a closed task keeps its completing inspection and its reason', lower(OLD.state::text));
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.closed_at := CASE WHEN NEW.state = 'OPEN' THEN NULL ELSE COALESCE(NEW.closed_at, now()) END;
    -- A planted close is never ahead of now: until it arrived, the
    -- responsibility read would name a driver for a task the outstanding
    -- read already counts closed (FR-INS-052). An OPEN row's close is
    -- discarded above, so only a closed row can meet this.
    IF NEW.closed_at > now() THEN
      RAISE EXCEPTION USING ERRCODE = 'TY018',
        MESSAGE = 'an inspection task is closed now or earlier, never in the future';
    END IF;
  ELSE
    NEW.closed_at := CASE WHEN NEW.state = 'OPEN' THEN NULL
                          WHEN OLD.state = 'OPEN' THEN now()
                          ELSE OLD.closed_at END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inspection_task_closes_once BEFORE INSERT OR UPDATE ON app.inspection_task
FOR EACH ROW EXECUTE FUNCTION app.inspection_task_closes_once();

-- The responsibility and capture reads judge a past instant by a task's
-- vehicle_id, created_at and due_at as well as its closed_at, so the one
-- edit is the close with its citation or reason (rule 3; check 4, section
-- 76d). A column grant checks only the SET list, so the triggers still
-- write closed_at and the stamps (000040).
REVOKE UPDATE ON app.inspection_task FROM app_rw;
GRANT UPDATE (state, cancelled_reason, completed_inspection_id) ON app.inspection_task TO app_rw;

-- ---------------------------------------------------------------------------
-- E. Today's data into the new model (spec, vehicle_driver becomes history;
-- Nominations)
-- ---------------------------------------------------------------------------
-- Each assignment open on its tenant's today, on a motive, becomes an open
-- trip from the tenant-local start of its from_date (rule 6), so a capture
-- already in an outbox still passes the window. A trailer row is dropped:
-- the trailer reaches its driver through the motive's rig. Where rows
-- conflict, two drivers on one motive or one driver on two, the newest
-- from_date wins, then the lowest id, and the rest stay history only. A
-- future row is not converted, and nor is one app.start_trip would refuse,
-- on a retired motive or for a deactivated driver, so it never wins a
-- conflict. migrated_from_assignment_id marks the trip.
-- This runs as the migration role, which bypasses RLS, so every predicate
-- names the tenant.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT vd.id, vd.tenant_id, vd.vehicle_id, vd.user_id, vd.created_by,
           (vd.from_date::timestamp AT TIME ZONE t.timezone) AS started_at
      FROM app.vehicle_driver vd
      JOIN app.tenant t ON t.id = vd.tenant_id
      JOIN app.vehicle v ON v.tenant_id = vd.tenant_id AND v.id = vd.vehicle_id
      JOIN app.app_user u ON u.tenant_id = vd.tenant_id AND u.id = vd.user_id
     WHERE v.unit_kind <> 'TRAILER'
       AND v.status NOT IN ('DISPOSED', 'INACTIVE')
       AND u.active
       AND vd.from_date <= app.tenant_today(t.timezone)
       AND (vd.to_date IS NULL OR vd.to_date >= app.tenant_today(t.timezone))
     ORDER BY vd.from_date DESC, vd.id
  LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM app.trip tr
                           WHERE tr.tenant_id = r.tenant_id AND tr.ended_at IS NULL
                             AND (tr.vehicle_id = r.vehicle_id OR tr.user_id = r.user_id));
    INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, started_by, combination_id,
                          migrated_from_assignment_id)
    VALUES (r.tenant_id, r.vehicle_id, r.user_id, r.started_at, r.created_by,
            (SELECT c.id FROM app.combination c
              WHERE c.tenant_id = r.tenant_id AND c.motive_vehicle_id = r.vehicle_id
                AND tstzrange(c.effective_from, c.effective_to, '[)') @> r.started_at),
            r.id);
  END LOOP;
END $$;

-- Each outstanding task's assignee becomes a nomination at the task's
-- creation by whoever asked for it, so no outstanding task changes hands
-- through an active assignee. A deactivated one is not copied, since
-- app.nominate_for_task would refuse them. Part D has already made ESCALATED
-- rows OPEN.
-- A creation ahead of now, which a raw UPDATE could leave while app_rw held
-- the table's UPDATE, dates its copy at now: nomination_well_formed refuses
-- a later instant, and v_nomination_span starts no span before the task's
-- creation in any case.
INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at, nominated_by)
SELECT k.tenant_id, k.id, k.assigned_user_id, least(k.created_at, now()), k.requested_by
  FROM app.inspection_task k
  JOIN app.app_user u ON u.tenant_id = k.tenant_id AND u.id = k.assigned_user_id
 WHERE k.state = 'OPEN' AND u.active;

-- A nomination lapses at the first coverage after it (v_nomination_span), so
-- a task whose unit migrated trips towed and let go would be held by nobody
-- after each tow. Its assignee gains a nomination at each instant a coverage
-- ended with no other holding the unit, from the task's creation to now, and
-- the copy keeps who held the task before the first. An end that meets
-- another span, or coverage still open, needs none, since a trip holds the
-- task. The two branches are app.v_unit_coverage's, read here because part F
-- drops assigned_user_id before part G creates the view.
WITH cover AS (
  SELECT t.tenant_id, t.vehicle_id, tstzrange(t.started_at, t.ended_at, '[)') AS span
    FROM app.trip t
  UNION ALL
  SELECT cm.tenant_id, cm.vehicle_id,
         tstzrange(t.started_at, t.ended_at, '[)') * tstzrange(c.effective_from, c.effective_to, '[)')
    FROM app.combination_member cm
    JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
     AND cm.vehicle_id <> c.motive_vehicle_id
    JOIN app.trip t ON t.tenant_id = c.tenant_id AND t.vehicle_id = c.motive_vehicle_id)
INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id, nominated_at, nominated_by)
SELECT k.tenant_id, k.id, k.assigned_user_id, g.ended_at, k.requested_by
  FROM app.inspection_task k
  JOIN app.app_user u ON u.tenant_id = k.tenant_id AND u.id = k.assigned_user_id
  -- A coverage span is '[)', so its upper bound is the first instant it no
  -- longer holds, and a nomination dated there is not lapsed by it.
 CROSS JOIN LATERAL (SELECT DISTINCT upper(c.span) AS ended_at
                       FROM cover c
                      WHERE c.tenant_id = k.tenant_id AND c.vehicle_id = k.vehicle_id
                        AND NOT isempty(c.span) AND NOT upper_inf(c.span)) g
 WHERE k.state = 'OPEN' AND u.active
   AND g.ended_at > least(k.created_at, now()) AND g.ended_at <= now()
   AND NOT EXISTS (SELECT 1 FROM cover c
                    WHERE c.tenant_id = k.tenant_id AND c.vehicle_id = k.vehicle_id
                      AND c.span @> g.ended_at);

-- ---------------------------------------------------------------------------
-- F. Retire the old readers
-- ---------------------------------------------------------------------------
-- The capture views are rebuilt in part H on trips and nominations, and
-- v_driver_vehicle's columns change with them (spec, Capture), so each is
-- dropped rather than replaced.
DROP VIEW app.v_driver_vehicle;
DROP VIEW app.v_capture_vehicle;
DROP VIEW app.v_user_capture_vehicle;

-- The task views expand it.*, so they go before the columns do.
-- create_inspection_task(uuid, uuid, date) names an assignee, and it and
-- the generator are the only readers of user_can_capture and
-- v_current_assignment; part I replaces both.
DROP VIEW app.v_my_inspection_task;
DROP VIEW app.v_inspection_task;
DROP FUNCTION app.create_inspection_task(uuid, uuid, date);
DROP FUNCTION app.user_can_capture(uuid, uuid);
DROP VIEW app.v_current_assignment;
-- Dropped rather than left unread, so no reader can trust either (spec,
-- Nominations).
ALTER TABLE app.inspection_task DROP COLUMN assigned_user_id, DROP COLUMN escalated_at;

-- ---------------------------------------------------------------------------
-- G. Coverage and responsibility (FR-INS-053 as amended)
-- ---------------------------------------------------------------------------
-- The span during which each trip covers each unit: a motive's own trip, and
-- for a towed unit its rig's span intersected with the trip of the rig's
-- motive. Responsibility, capture and a nomination's lapse all read this, so
-- a rig ended and reopened mid-trip is read at the instant in question and
-- trip.combination_id is never read for a decision (spec, The trip). && is
-- false on an empty range, so a zero-length trip or rig covers nothing.
CREATE VIEW app.v_unit_coverage WITH (security_invoker = true) AS
SELECT t.tenant_id, t.vehicle_id, t.id AS trip_id, t.user_id, t.vehicle_id AS motive_id,
       tstzrange(t.started_at, t.ended_at, '[)') AS span
  FROM app.trip t
 WHERE NOT isempty(tstzrange(t.started_at, t.ended_at, '[)'))
UNION ALL
SELECT cm.tenant_id, cm.vehicle_id, t.id, t.user_id, c.motive_vehicle_id,
       tstzrange(t.started_at, t.ended_at, '[)') * tstzrange(c.effective_from, c.effective_to, '[)')
  FROM app.combination_member cm
  JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
   AND cm.vehicle_id <> c.motive_vehicle_id
  JOIN app.trip t ON t.tenant_id = c.tenant_id AND t.vehicle_id = c.motive_vehicle_id
   AND tstzrange(t.started_at, t.ended_at, '[)') && tstzrange(c.effective_from, c.effective_to, '[)');

-- Each nomination's live span: from its instant to the first of the task's
-- next nomination, the first instant a trip covers the task's unit after it
-- (spec, decision 6, and the same takeover through a coupling), and the task's
-- close, within the task's own life. greatest keeps a nomination dated after
-- that bound an empty range rather than an error. By construction the span
-- is disjoint from the unit's coverage, so no reader subtracts it again.
CREATE VIEW app.v_nomination_span WITH (security_invoker = true) AS
SELECT n.tenant_id, n.id AS nomination_id, n.task_id, k.vehicle_id, n.user_id, n.nominated_at,
       tstzrange(n.nominated_at,
                 CASE WHEN least(nx.next_at, lp.lapse_at, k.closed_at) IS NULL THEN NULL
                      ELSE greatest(n.nominated_at, least(nx.next_at, lp.lapse_at, k.closed_at)) END,
                 '[)')
       * tstzrange(k.created_at, NULL, '[)') AS span
  FROM app.inspection_task_nomination n
  JOIN app.inspection_task k ON k.tenant_id = n.tenant_id AND k.id = n.task_id
  LEFT JOIN LATERAL (
    SELECT min(n2.nominated_at) AS next_at
      FROM app.inspection_task_nomination n2
     WHERE n2.tenant_id = n.tenant_id AND n2.task_id = n.task_id AND n2.nominated_at > n.nominated_at
  ) nx ON true
  LEFT JOIN LATERAL (
    SELECT min(greatest(lower(c.span), n.nominated_at)) AS lapse_at
      FROM app.v_unit_coverage c
     WHERE c.tenant_id = k.tenant_id AND c.vehicle_id = k.vehicle_id
       AND (upper_inf(c.span) OR upper(c.span) > n.nominated_at)
  ) lp ON true;

-- The one decision of who is responsible for a task at an instant, and how
-- (FR-INS-053 as amended; spec, Who is responsible for a task): the trip
-- that covers its unit, else its own live nominee, else, for a towed unit,
-- the newest live nomination across its rig motive's outstanding tasks,
-- else no row. It answers only while the task is outstanding at p_at, and
-- never reads app_user.active, which keeps no history (spec, Nominations).
-- Ties within a rule go to the newest nomination, then the lowest id.
CREATE FUNCTION app.task_responsibility_at(p_task uuid, p_at timestamptz)
RETURNS TABLE (user_id uuid, via text)
LANGUAGE sql STABLE AS $$
  SELECT r.user_id, r.via
    FROM app.inspection_task k
   CROSS JOIN LATERAL (
     SELECT c.user_id, 'TRIP'::text AS via, 1 AS rank,
            NULL::timestamptz AS nominated_at, NULL::uuid AS nomination_id
       FROM app.v_unit_coverage c
      WHERE c.tenant_id = k.tenant_id AND c.vehicle_id = k.vehicle_id AND c.span @> p_at
     UNION ALL
     SELECT ns.user_id, 'NOMINATION', 2, ns.nominated_at, ns.nomination_id
       FROM app.v_nomination_span ns
      WHERE ns.tenant_id = k.tenant_id AND ns.task_id = k.id AND ns.span @> p_at
     UNION ALL
     SELECT ns.user_id, 'MOTIVE_NOMINATION', 3, ns.nominated_at, ns.nomination_id
       FROM app.combination_member cm
       JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
        AND cm.vehicle_id <> c.motive_vehicle_id
        AND tstzrange(c.effective_from, c.effective_to, '[)') @> p_at
       JOIN app.v_nomination_span ns ON ns.tenant_id = c.tenant_id
        AND ns.vehicle_id = c.motive_vehicle_id AND ns.span @> p_at
      WHERE cm.tenant_id = k.tenant_id AND cm.vehicle_id = k.vehicle_id
   ) r
   WHERE k.id = p_task
     AND k.created_at <= p_at AND (k.closed_at IS NULL OR k.closed_at > p_at)
   ORDER BY r.rank, r.nominated_at DESC NULLS LAST, r.nomination_id
   LIMIT 1
$$;

-- The name the SRS errata and TYRE-284 cite for the decision above.
CREATE FUNCTION app.task_driver_at(p_task uuid, p_at timestamptz) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT r.user_id FROM app.task_responsibility_at(p_task, p_at) r
$$;

-- The task view: outstanding is OPEN, and overdue an outstanding task past
-- its due instant. It names no driver,
-- so a count of overdue tasks (dashboard.go) never asks who holds one.
CREATE VIEW app.v_inspection_task WITH (security_invoker = true) AS
SELECT it.*,
       (it.state = 'OPEN' AND it.due_at < now()) AS overdue,
       (it.state = 'OPEN')                       AS outstanding
  FROM app.inspection_task it;

-- The responsible driver beside each task, at now, and escalated: an
-- outstanding task nobody holds (spec, Escalation). OFFSET 0 fences the
-- function so it runs once per row, not once per reference (lesson
-- 2026-09-11).
CREATE VIEW app.v_inspection_task_driver WITH (security_invoker = true) AS
SELECT t.*,
       r.user_id                          AS responsible_user_id,
       r.via                              AS responsible_via,
       (t.outstanding AND r.user_id IS NULL) AS escalated
  FROM app.v_inspection_task t
  LEFT JOIN LATERAL (SELECT * FROM app.task_responsibility_at(t.id, now()) OFFSET 0) r ON true;

-- ---------------------------------------------------------------------------
-- H. Capture (FR-AUT-005, FR-OFF-015 as amended)
-- ---------------------------------------------------------------------------
-- Who may capture which unit over which span (spec, Capture): the driver of
-- the trip that covers it; the live nominee of a task on it; and a motive's
-- live nominee for the units its rig tows while both hold. Each nomination
-- span already ends where a trip takes it over. via_vehicle_id is the unit
-- the right comes through.
CREATE VIEW app.v_capture_span WITH (security_invoker = true) AS
SELECT c.tenant_id, c.user_id, c.vehicle_id, c.motive_id AS via_vehicle_id, c.span
  FROM app.v_unit_coverage c
UNION ALL
SELECT ns.tenant_id, ns.user_id, ns.vehicle_id, ns.vehicle_id, ns.span
  FROM app.v_nomination_span ns
 WHERE NOT isempty(ns.span)
UNION ALL
SELECT ns.tenant_id, ns.user_id, cm.vehicle_id, ns.vehicle_id,
       ns.span * tstzrange(c.effective_from, c.effective_to, '[)')
  FROM app.v_nomination_span ns
  JOIN app.combination c ON c.tenant_id = ns.tenant_id AND c.motive_vehicle_id = ns.vehicle_id
   AND tstzrange(c.effective_from, c.effective_to, '[)') && ns.span
  JOIN app.combination_member cm ON cm.tenant_id = c.tenant_id AND cm.combination_id = c.id
   AND cm.vehicle_id <> c.motive_vehicle_id;

-- The one capture predicate (spec, Capture): whether the user could capture
-- the unit at some instant from p_from to p_to, both ends included. A NULL
-- instant answers false, since an open bound would read as for ever.
CREATE FUNCTION app.user_could_capture(p_user uuid, p_vehicle uuid, p_from timestamptz, p_to timestamptz)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT p_from IS NOT NULL AND p_to IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.v_capture_span s
     WHERE s.tenant_id = app.current_tenant_id()
       AND s.user_id = p_user AND s.vehicle_id = p_vehicle
       AND s.span && tstzrange(p_from, p_to, '[]'))
$$;

-- The capture set at now. Capture never reads app_user.active, which keeps
-- no history; withActor refuses an inactive actor before any query runs
-- (ADR-0011).
CREATE VIEW app.v_user_capture_vehicle WITH (security_invoker = true) AS
SELECT DISTINCT s.tenant_id, s.user_id, s.vehicle_id, s.via_vehicle_id
  FROM app.v_capture_span s
 WHERE s.span @> now();

-- The actor's capture set at now, the relation a handler composes for an
-- actor who is not tenant-wide (ADR-0006).
CREATE VIEW app.v_capture_vehicle WITH (security_invoker = true) AS
SELECT DISTINCT ucv.tenant_id, ucv.vehicle_id
  FROM app.v_user_capture_vehicle ucv
 WHERE ucv.user_id = app.current_actor_id();

-- GET /api/my/vehicles: the actor's capture set at now, so a trip's trailers
-- and a nominee's units are listed beside the motive (FR-AUT-005 as
-- amended). An unset actor matches no rows (FR-TEN-004).
CREATE VIEW app.v_driver_vehicle WITH (security_invoker = true) AS
SELECT DISTINCT ucv.tenant_id, ucv.user_id, ucv.vehicle_id, v.fleet_number, v.registration
  FROM app.v_user_capture_vehicle ucv
  JOIN app.vehicle v ON v.tenant_id = ucv.tenant_id AND v.id = ucv.vehicle_id
 WHERE ucv.user_id = app.current_actor_id();

-- The driver's own work (FR-DSH-012 as amended): every outstanding task the
-- actor is responsible for now, with v_inspection_task_driver's columns. The
-- unit filter is fenced below the responsibility read (OFFSET 0), so the
-- function runs on the actor's units alone; the planner otherwise ran it on
-- every outstanding task in the tenant first. The filter changes no answer:
-- each rule's holder can capture the task's unit at that instant (spec,
-- Capture).
CREATE VIEW app.v_my_inspection_task WITH (security_invoker = true) AS
SELECT t.*,
       r.user_id                             AS responsible_user_id,
       r.via                                 AS responsible_via,
       (t.outstanding AND r.user_id IS NULL) AS escalated,
       -- Where the task is captured: the unit's open rig's motive when the
       -- actor can capture it, since a rig is entered through its motive
       -- (capture.go), else the unit itself.
       COALESCE((SELECT c.motive_vehicle_id
                   FROM app.combination_member cm
                   JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
                  WHERE cm.tenant_id = t.tenant_id AND cm.vehicle_id = t.vehicle_id
                    AND c.motive_vehicle_id <> t.vehicle_id
                    AND tstzrange(c.effective_from, c.effective_to, '[)') @> now()
                    AND c.motive_vehicle_id IN (SELECT cv.vehicle_id FROM app.v_capture_vehicle cv)),
                t.vehicle_id)                AS capture_vehicle_id
  FROM (SELECT it.*
          FROM app.v_inspection_task it
         WHERE it.outstanding
           AND it.vehicle_id IN (SELECT cv.vehicle_id FROM app.v_capture_vehicle cv)
        OFFSET 0) t
  JOIN LATERAL (SELECT * FROM app.task_responsibility_at(t.id, now()) OFFSET 0) r ON true
 WHERE r.user_id = app.current_actor_id();

-- The one computation of the span a capture is judged over (U148; spec,
-- Capture): to p_until, from p_started or the tenant's
-- inspection_max_duration_hours before p_until, whichever is later, and at
-- p_until when p_started is after it, as a phone clock corrected backwards
-- leaves it. It never refuses: no capture is lost for its length. The 12 is
-- only the fallback for a tenant with no row (rule 5).
CREATE FUNCTION app.capture_window_between(p_started timestamptz, p_until timestamptz)
RETURNS tstzrange
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT tstzrange(least(greatest(p_started, p_until - make_interval(hours => h.hours)), p_until),
                   p_until, '[]')
    FROM (SELECT COALESCE((app.config_for(app.current_tenant_id(), 'inspection_max_duration_hours', now())
                           #>> '{}')::int, 12) AS hours) h
$$;

-- A payload's window. An absent started_at is refused by name, because
-- inspection.started_at is NOT NULL and the column's own 23502 would reach
-- the driver as a canned failure (FR-OFF-013).
CREATE FUNCTION app.capture_window(p_payload jsonb) RETURNS tstzrange
LANGUAGE plpgsql STABLE
SET search_path = app, pg_temp AS $$
BEGIN
  IF (p_payload ->> 'started_at') IS NULL THEN
    RAISE EXCEPTION 'the payload carries no started_at' USING ERRCODE = 'TY005';
  END IF;
  IF (p_payload ->> 'submitted_at') IS NULL THEN
    RAISE EXCEPTION 'the payload carries no submitted_at' USING ERRCODE = 'TY005';
  END IF;
  RETURN app.capture_window_between((p_payload ->> 'started_at')::timestamptz,
                                    (p_payload ->> 'submitted_at')::timestamptz);
END $$;

-- The submit route's own-units check for a role that is not tenant-wide
-- (FR-AUT-005, FR-OFF-015 as amended): every unit the payload attributes,
-- its own, each reading's and each absent spare's, held by the actor at
-- some instant of the capture window, and its combination_id a rig of its
-- own unit. The Scope table lives in auth, so the exemption stays in Go
-- (spec, Capture). A readings or absent_spares key that is not an array is
-- left to app.submit_inspection, which refuses it by name.
CREATE FUNCTION app.actor_could_capture(p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_actor  uuid := app.current_actor_id();
  w        tstzrange;
BEGIN
  -- A replay writes nothing, so the actor's own stored capture is answered
  -- as one whoever holds the unit now (FR-OFF-011).
  IF EXISTS (SELECT 1 FROM app.inspection i
              WHERE i.tenant_id = v_tenant
                AND i.client_uuid = (p_payload ->> 'client_uuid')::uuid
                AND i.user_id = v_actor) THEN
    RETURN true;
  END IF;
  w := app.capture_window(p_payload);
  IF EXISTS (
    SELECT 1
      FROM (SELECT (p_payload ->> 'vehicle_id')::uuid AS vehicle_id
            UNION
            SELECT (e ->> 'vehicle_id')::uuid
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'readings') = 'array'
                                             THEN p_payload -> 'readings' ELSE '[]'::jsonb END) e
            UNION
            SELECT (e ->> 'vehicle_id')::uuid
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'absent_spares') = 'array'
                                             THEN p_payload -> 'absent_spares' ELSE '[]'::jsonb END) e) u
     WHERE u.vehicle_id IS NOT NULL
       AND NOT app.user_could_capture(v_actor, u.vehicle_id, lower(w), upper(w))) THEN
    RETURN false;
  END IF;
  -- No time test: a tab's capture context is cached for its life, so a
  -- capture may name a rig a trip start has since re-formed, and a report
  -- against an ended rig is refused where it would apply (TY022, 000044).
  IF (p_payload ->> 'combination_id') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.combination c
                      WHERE c.tenant_id = v_tenant
                        AND c.id = (p_payload ->> 'combination_id')::uuid
                        AND c.motive_vehicle_id = (p_payload ->> 'vehicle_id')::uuid) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- I. Writes
-- ---------------------------------------------------------------------------
-- app.submit_inspection. app.capture_window runs right after the FR-OFF-011
-- replay lookup, so a payload with no started_at is refused by name rather
-- than by the column's own 23502 (FR-OFF-013). The close takes only an OPEN
-- task, admits a named task on any unit the inspection read, and completes
-- each read unit's due tasks (U150).
CREATE OR REPLACE FUNCTION app.submit_inspection(p_payload jsonb)
RETURNS TABLE (inspection_id uuid, created boolean)
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant     uuid := app.current_tenant_id();
  v_actor      uuid := app.current_actor_id();
  v_cu         uuid := (p_payload ->> 'client_uuid')::uuid;
  v_vehicle    uuid := (p_payload ->> 'vehicle_id')::uuid;
  v_task       uuid := (p_payload ->> 'task_id')::uuid;
  -- D5 / FR-INS-063: the composition the driver was offered. Recorded
  -- against the observed set, never used to create a combination itself.
  v_combination uuid := (p_payload ->> 'combination_id')::uuid;
  v_insp       uuid;
  v_found      uuid;
  v_reading    uuid;
  v_hours      int;
  v_skew       int;
  v_want       int;
  v_side       app.side;
  v_spare      boolean;
  v_fitted     uuid;
  v_odo        bigint;
  v_ord        int;
  v_n          int;
  v_gran       numeric;
  v_rg         numeric;
  v_press      int;
  v_constraint text;
  v_tz         text;
  a            jsonb;
  r            jsonb;
  w            jsonb;
  t            jsonb;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'submit_inspection called with no tenant or actor bound'
      USING ERRCODE = 'TY010';
  END IF;

  -- Preconditions, refused by name before anything reads them. Each of the
  -- three is a body that can only ever fail, and ADR-0009's outbox retries a
  -- 5xx to a 30-minute ceiling and never gives up, so a shape that reached
  -- its column's own not-null violation instead would be retried forever
  -- (FR-OFF-013 needs a permanent refusal it can surface to the driver).
  -- Both keys are also load-bearing for the guards immediately below: the
  -- FR-OFF-011 replay lookup keys on client_uuid and the FR-INS-038 window
  -- compares against submitted_at, so an absent key does not fail there, it
  -- silently stands the guard down.
  IF v_cu IS NULL THEN
    RAISE EXCEPTION 'the payload carries no client_uuid' USING ERRCODE = 'TY005';
  END IF;
  IF (p_payload ->> 'submitted_at') IS NULL THEN
    RAISE EXCEPTION 'the payload carries no submitted_at' USING ERRCODE = 'TY005';
  END IF;

  -- TYRE-166 (owner, 6 Sep 2026). The past side stays open: ADR-0009's outbox
  -- delivers a capture hours or days after the device stamped it. The future
  -- side is bounded, because submitted_at is BR-VAL-007's ordering key and
  -- the as-at register's cut-off (000036): a reading a wrong device clock
  -- stamps a year ahead is invisible to every register until that day, an
  -- older reading prices the tyre meanwhile, and DR-011 means nothing can
  -- retract it. A phone a few minutes fast is not a wrong clock, so the
  -- bound carries an allowance that is tenant configuration (rule 5); the
  -- five-minute fallback is the value the owner seeded and applies only to a
  -- tenant with no row, as the four hours below do for FR-INS-038.
  v_skew := COALESCE(
    (app.config_for(v_tenant, 'submitted_at_future_skew_minutes', now()) #>> '{}')::int, 5);
  IF (p_payload ->> 'submitted_at')::timestamptz > now() + make_interval(mins => v_skew) THEN
    -- TYRE-215: its own SQLSTATE, because this is the one refusal in the
    -- system that time cures: the identical payload lands once the server
    -- clock passes the stamped instant, and the outbox must retry it rather
    -- than hand it to the office (TY005 is permanent by contract, ADR-0012).
    RAISE EXCEPTION 'submitted_at % is more than % minutes ahead of the server clock; check the device time and resubmit',
      p_payload ->> 'submitted_at', v_skew USING ERRCODE = 'TY021';
  END IF;

  -- FR-INS-020: an inspection is its readings. jsonb_array_elements over an
  -- absent key yields the empty set rather than an error, so without this an
  -- empty submit lands a SYNCED inspection at the default 100% completeness
  -- (see completeness_pct below) recording nothing, closes the driver's task,
  -- and never arms FR-INS-038, whose window keys on readings[].vehicle_id,
  -- not on the header. jsonb_typeof screens the missing key, the JSON null
  -- and the non-array in one: only the last two would otherwise reach
  -- jsonb_array_elements, and they reach it as "cannot extract elements from
  -- a scalar" rather than as anything a client could act on.
  IF jsonb_typeof(p_payload -> 'readings') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'the payload carries no readings array' USING ERRCODE = 'TY005';
  END IF;
  IF jsonb_array_length(p_payload -> 'readings') = 0 THEN
    RAISE EXCEPTION 'the payload carries an empty readings array' USING ERRCODE = 'TY005';
  END IF;

  -- FR-OFF-011. A lookup, never an upsert: readings are append-only, so a
  -- replay that "corrected" the first submit would be an edit by another name.
  SELECT i.id INTO v_found FROM app.inspection i
   WHERE i.tenant_id = v_tenant AND i.client_uuid = v_cu;
  IF FOUND THEN
    inspection_id := v_found; created := false; RETURN NEXT; RETURN;
  END IF;

  -- FR-OFF-015 as amended (U148): past the replay lookup, so a replay still
  -- answers as one. The window itself is judged by app.actor_could_capture,
  -- which the route asks first; this refuses an absent started_at by name.
  PERFORM app.capture_window(p_payload);

  -- FR-INS-038, per UNIT rather than per rig, so a superlink's member units
  -- are each protected. Reached only past the replay check above: resubmitting
  -- one capture is not a second inspection and must never trip this.
  -- FR-INS-038 states the default in the requirement itself: "a
  -- configurable minimum interval, defaulting to four hours". So a tenant
  -- with no configured row still gets the window. Failing open here would
  -- stand a Must down silently, which is not the same trade DR-020's
  -- configurable ceiling makes (migration 000021: there, no configured
  -- policy means no claim to test).
  v_hours := COALESCE(
    (app.config_for(v_tenant, 'duplicate_inspection_min_hours', now()) #>> '{}')::int, 4);
  -- The window compares capture-clock against capture-clock, not
  -- capture-clock against the server's now(). ADR-0009's outbox means a
  -- capture can queue offline for hours before it syncs: a driver who
  -- genuinely double-captures unit X at 08:00 and 09:00, both draining from
  -- the outbox at 18:00, must still be caught at submit time regardless of
  -- when the sync happened to land. Anchoring on real now() would silently
  -- stand the window down for every queued submit, exactly the case
  -- FR-INS-038 exists to catch, because the device-claimed submitted_at
  -- drifts further from the server clock the longer the outbox held it. The
  -- rest of this function trusts the device's own clock for everything else
  -- it stores (duration_seconds, the odometer's reading_date, NFR-OBS-007's
  -- capture_seconds); the one bound on that clock is the future-side check
  -- above, and it does not touch this window, which compares capture-clock
  -- against capture-clock.
  --
  -- Bounded on BOTH sides, and for the same reason: FR-INS-038 asks whether
  -- two captures of one unit are within v_hours OF EACH OTHER, which is a
  -- symmetric question, and the outbox is exactly what makes the payload
  -- arrive out of order. A capture held offline on Monday and drained on
  -- Friday meets a Wednesday capture that is already stored. One bound alone
  -- refuses that Monday walk-around no matter how far apart the two are, and
  -- the outbox reads TY003's 409 as permanent, so a completed inspection
  -- would be discarded rather than retried (FR-OFF-014). Both bounds are
  -- strict, so two captures exactly v_hours apart are accepted in either
  -- order: the requirement sets a MINIMUM interval, and an interval that
  -- meets the minimum has not breached it.
  IF EXISTS (
    SELECT 1 FROM app.reading rd
      JOIN app.inspection i ON i.id = rd.inspection_id
     WHERE rd.tenant_id = v_tenant
       AND i.state <> 'VOIDED'
       AND i.submitted_at > (p_payload ->> 'submitted_at')::timestamptz - make_interval(hours => v_hours)
       AND i.submitted_at < (p_payload ->> 'submitted_at')::timestamptz + make_interval(hours => v_hours)
       AND rd.vehicle_id IN (
             SELECT DISTINCT (e ->> 'vehicle_id')::uuid
               FROM jsonb_array_elements(p_payload -> 'readings') e))
  THEN
    RAISE EXCEPTION 'a unit in this submit was already inspected within % hours', v_hours
      USING ERRCODE = 'TY003';
  END IF;

  -- TY007 exists because the alternative is a 500. Without it an unknown or
  -- cross-tenant vehicle_id reaches the composite FK
  -- inspection_vehicle_id_fkey (tenant_id, vehicle_id) and arrives as
  -- SQLSTATE 23503, which is not in submitStatus and therefore surfaces as a
  -- server fault, telling the outbox to retry forever something that will
  -- never succeed.
  --
  -- RLS-scoped, so this answers "visible to this tenant" and not "exists".
  -- FR-AUT-005's own-units narrowing is the HTTP handler's, because the Scope
  -- table lives in auth and role names do not belong in SQL.
  PERFORM 1 FROM app.vehicle WHERE id = v_vehicle;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vehicle not visible' USING ERRCODE = 'TY007';
  END IF;

  -- FR-OFF-011 under concurrency. Two drains of the same outbox entry can
  -- both pass the lookup above before either commits; the loser then blocks
  -- on inspection_tenant_id_client_uuid_key and surfaces as a 23505. That is
  -- still a replay, not a conflict, so it must answer the replay contract.
  -- Reporting it as an error would have the outbox raise FR-OFF-013 over an
  -- inspection that is already safely stored. The re-read is correct because
  -- the transaction is READ COMMITTED: this statement takes a fresh snapshot
  -- and therefore sees the winner's now-committed row.
  BEGIN
    INSERT INTO app.inspection (
      tenant_id, vehicle_id, combination_id, user_id, client_uuid,
      started_at, submitted_at, odometer, duration_seconds,
      comment, defect_report, device_id, app_version, completeness_pct, state)
    VALUES (
      v_tenant, v_vehicle, v_combination, v_actor, v_cu,
      (p_payload ->> 'started_at')::timestamptz, (p_payload ->> 'submitted_at')::timestamptz,
      (p_payload ->> 'odometer_km')::bigint, (p_payload ->> 'duration_seconds')::int,
      p_payload ->> 'comment', p_payload ->> 'defect_report',
      p_payload ->> 'device_id', p_payload ->> 'app_version',
      COALESCE((p_payload ->> 'completeness_pct')::numeric, 100), 'SYNCED')
    RETURNING id INTO v_insp;
  EXCEPTION WHEN unique_violation THEN
    -- Narrowed to the one index that means "already submitted". Any other
    -- unique violation is a different fault and must not be dressed up as a
    -- successful replay.
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'inspection_tenant_id_client_uuid_key' THEN
      RAISE;
    END IF;
    SELECT i.id INTO v_found FROM app.inspection i
     WHERE i.tenant_id = v_tenant AND i.client_uuid = v_cu;
    IF NOT FOUND THEN
      RAISE;
    END IF;
    inspection_id := v_found; created := false; RETURN NEXT; RETURN;
  END;

  -- FR-INS-063: the composition the driver confirmed, against the one they
  -- were offered. Recorded, never enforced and never used to create a
  -- combination: a queued submit can arrive days late, and writing fleet
  -- state from stale evidence would rewrite coupling history. The
  -- reconciliation surface is TYRE-55's.
  IF v_combination IS NOT NULL AND jsonb_array_length(
       COALESCE(p_payload -> 'observed_member_vehicle_ids', '[]'::jsonb)) > 0 THEN
    -- The members of THIS combination, narrowed before the join. Joining the
    -- whole table and filtering afterwards makes every other combination's
    -- rows look like unmatched members, so a tenant with two rigs would get a
    -- spurious FR-INS-063 warning on every submit, and the fixture, which
    -- has exactly one combination, could never reveal it.
    IF EXISTS (
      SELECT 1
        FROM (SELECT jsonb_array_elements_text(p_payload -> 'observed_member_vehicle_ids')::uuid AS id) obs
        FULL JOIN (SELECT vehicle_id FROM app.combination_member
                    WHERE combination_id = v_combination) cm
               ON cm.vehicle_id = obs.id
       WHERE obs.id IS NULL OR cm.vehicle_id IS NULL)
    THEN
      INSERT INTO app.inspection_warning (
        tenant_id, inspection_id, warning_code, entered_value, response, source)
      VALUES (v_tenant, v_insp, 'FR-INS-063',
              (p_payload ->> 'observed_member_vehicle_ids'), NULL, 'SERVER');
    END IF;
  END IF;

  -- Rule 5, read once for the whole submit: both the width of a capture and
  -- the gauge precision it claims are tenant configuration, never a literal.
  v_want := (app.config_for(v_tenant, 'tread_reading_count', now()) #>> '{}')::int;
  v_gran := (app.config_for(v_tenant, 'tread_capture_granularity_mm', now()) #>> '{}')::numeric;

  -- CR-011's screen-order-to-anatomy map below is total only for 1 or 3
  -- readings, and neither app.configuration nor anything above constrains the
  -- key. 4 subscripts past the end of the width array and lands a NOT NULL
  -- violation on position, so every submit that tenant makes fails with no
  -- client bug involved; 2 raises nothing at all and records the far edge of
  -- the tread as the CENTRE, permanently, because DR-014a revokes UPDATE, so
  -- it is compensable but never correctable. Refusing the configuration is
  -- smaller and safer than inventing a width convention the SRS has not
  -- settled. The IS NULL half is load-bearing: NULL NOT IN (1,3) is NULL, not
  -- true, so a guard without it would still admit an unconfigured tenant and
  -- land readings carrying no tread at all, which is rule 4 inverted. No
  -- configured width means no capture. Unlike the FR-INS-038 window above,
  -- whose default the requirement itself states, nothing states this one.
  IF v_want IS NULL OR v_want NOT IN (1, 3) THEN
    RAISE EXCEPTION 'the tenant configures tread_reading_count = %, which is neither 1 nor 3',
      COALESCE(v_want::text, 'nothing') USING ERRCODE = 'TY005';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_payload -> 'readings') LOOP
    IF r ? 'governing_tread_mm' THEN
      -- CR-011/DR-017: the MIN is derived. Refusing rather than ignoring the
      -- field is what stops a client believing it was honoured.
      RAISE EXCEPTION 'governing_tread_mm is derived and must not be submitted'
        USING ERRCODE = 'TY006';
    END IF;

    -- FR-VEH-016 versions configurations so amending one does not alter the
    -- position meaning of historical inspections. A completed capture can wait
    -- days in the outbox, so validate against the whole lineage: refusing it
    -- because an admin revised the configuration meanwhile would throw away a
    -- finished walk-around, which is the adoption wound ADR-0009 exists to
    -- prevent.
    SELECT p.side, p.is_spare INTO v_side, v_spare
      FROM app.position p
      JOIN app.axle_configuration ac ON ac.id = p.configuration_id
     WHERE p.id = (r ->> 'position_id')::uuid
       AND p.tenant_id = v_tenant
       AND (ac.tenant_id, ac.code) = (
             SELECT a2.tenant_id, a2.code
               FROM app.vehicle v JOIN app.axle_configuration a2 ON a2.id = v.configuration_id
              WHERE v.id = (r ->> 'vehicle_id')::uuid AND v.tenant_id = v_tenant);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'position % is not on any version of vehicle %''s configuration',
        r ->> 'position_id', r ->> 'vehicle_id' USING ERRCODE = 'TY004';
    END IF;

    -- jsonb_array_length(NULL) is NULL, not an error, so an absent treads key
    -- or an explicit JSON null would otherwise slide past "v_n <> v_want"
    -- (NULL <> 3 is NULL, not true) and land a reading with zero measurements
    -- and a NULL governing_tread_mm. jsonb_typeof catches both: it returns
    -- NULL for a missing key and 'null' for a JSON null, neither of which is
    -- 'array'.
    IF jsonb_typeof(r -> 'treads') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'position % is missing its tread readings', r ->> 'position_id'
        USING ERRCODE = 'TY005';
    END IF;

    SELECT jsonb_array_length(r -> 'treads') INTO v_n;
    IF v_n <> v_want THEN
      RAISE EXCEPTION 'position % carried % tread readings, the tenant configures %',
        r ->> 'position_id', v_n, v_want USING ERRCODE = 'TY005';
    END IF;
    -- Belt to the configuration guard's braces. The width map subscripts its
    -- array with v_ord, so a count of zero would make CR-011's "ordered set
    -- of width-wise readings" an empty one and leave governing_tread_mm null.
    IF v_n < 1 THEN
      RAISE EXCEPTION 'position % carried no tread readings', r ->> 'position_id'
        USING ERRCODE = 'TY005';
    END IF;

    -- FR-INS-031's hard range. reading_pressure_kpa_check (000001) stays the
    -- authority for the numbers; echoing it here is what turns a generic
    -- 23514 into a refusal naming the position, which is what FR-OFF-013
    -- gives the driver to act on. NULL stays legal on purpose: an unclassified
    -- spare pressure is recorded as absent, never as a zero (BR-RPT-001,
    -- NFR-PRO-003).
    v_press := (r ->> 'pressure_kpa')::int;
    IF v_press IS NOT NULL AND (v_press < 0 OR v_press > 1200) THEN
      RAISE EXCEPTION 'position %''s pressure of % kPa is outside the accepted range',
        r ->> 'position_id', v_press USING ERRCODE = 'TY005';
    END IF;

    -- ADR-0010 provenance: granularity_mm is a claim about the gauge that
    -- produced the reading, on an append-only table, so a wrong one is
    -- permanent and silently degrades every later analysis that trusts it.
    -- The payload's value if it sent one, else the tenant's configured
    -- capture granularity. A literal fallback here would stamp 1.0 mm
    -- precision on a tenant capturing at 0.1 the moment a client omitted the
    -- field, which is easy to omit because it is session reference data
    -- rather than per-reading input. reading_measurement_granularity_mm_check
    -- (000011) is the authority for the accepted set; refusing here names the
    -- value and also catches a tenant whose configured granularity is not in
    -- it, which is otherwise the same unmapped-500 hole as the width count.
    v_rg := COALESCE((r ->> 'granularity_mm')::numeric, v_gran);
    IF v_rg IS NULL OR v_rg NOT IN (1.0, 0.5, 0.1) THEN
      RAISE EXCEPTION 'position % claims a gauge granularity of %, which is not 1.0, 0.5 or 0.1',
        r ->> 'position_id', COALESCE(v_rg::text, 'nothing') USING ERRCODE = 'TY005';
    END IF;

    INSERT INTO app.reading (
      tenant_id, inspection_id, vehicle_id, position_id, tyre_id,
      pressure_kpa, pressure_temperature, damage_flag, damage_type,
      wear_pattern, note, source, capture_seconds)
    VALUES (
      v_tenant, v_insp, (r ->> 'vehicle_id')::uuid, (r ->> 'position_id')::uuid,
      (r ->> 'tyre_id')::uuid, (r ->> 'pressure_kpa')::int,
      COALESCE((r ->> 'pressure_temperature')::app.temperature_state, 'UNKNOWN'),
      COALESCE((r ->> 'damage_flag')::boolean, false),
      r ->> 'damage_type', r ->> 'wear_pattern', r ->> 'note', 'MANUAL',
      -- NFR-OBS-007. Nullable, so an absent value is absent rather than a
      -- zero that would drag the median down (NFR-PRO-002).
      (r ->> 'seconds')::int)
    RETURNING id INTO v_reading;

    -- FR-OFF-016: fitment can move between capture and submit. The driver's
    -- eyes are the record of what was on the vehicle, so accept and flag.
    -- Rejecting the inspection is the one response the requirement forbids.
    IF (r ->> 'tyre_id') IS NOT NULL THEN
      SELECT f.tyre_id INTO v_fitted FROM app.fitment f
       WHERE f.tenant_id = v_tenant
         AND f.vehicle_id = (r ->> 'vehicle_id')::uuid
         AND f.position_id = (r ->> 'position_id')::uuid
         AND f.removed_at IS NULL
       LIMIT 1;
      IF FOUND AND v_fitted IS DISTINCT FROM (r ->> 'tyre_id')::uuid THEN
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, v_reading, 'FR-OFF-016', (r ->> 'tyre_id'), NULL, 'SERVER');
      END IF;
    END IF;

    -- FR-INS-029a. The driver enters left to right in the plan view, which is
    -- the frame BR-VEH-001 numbers positions in, and never sees these words;
    -- OUTER is away from the centreline (CHG-010), so the order reverses
    -- between sides. A spare has no vehicle-relative geometry,
    -- so its orientation is recorded as unknown rather than invented. Such
    -- rows still count toward MIN but are excluded from directional diagnosis.
    v_ord := 0;
    FOR t IN SELECT * FROM jsonb_array_elements(r -> 'treads') LOOP
      v_ord := v_ord + 1;
      -- FR-INS-030's hard range, plus the null element the count check cannot
      -- see: jsonb_array_length counts a JSON null as an entry, so
      -- [7.0, null, 7.0] is three readings by that measure and reaches
      -- tread_mm NOT NULL instead. reading_measurement_tread_mm_check (000001,
      -- re-declared in 000040 against app.max_tread_mm()) stays the authority
      -- for the numbers, as for pressure above.
      IF jsonb_typeof(t) <> 'number' THEN
        RAISE EXCEPTION 'position %, tread reading %, is not a number',
          r ->> 'position_id', v_ord USING ERRCODE = 'TY005';
      END IF;
      IF (t #>> '{}')::numeric < 0 OR (t #>> '{}')::numeric > app.max_tread_mm() THEN
        RAISE EXCEPTION 'position %, tread reading % of % mm, is outside the accepted range of 0 to % mm',
          r ->> 'position_id', v_ord, (t #>> '{}')::numeric, trunc(app.max_tread_mm()) USING ERRCODE = 'TY005';
      END IF;
      INSERT INTO app.reading_measurement (
        tenant_id, reading_id, ordinal, tread_mm, position, orientation_known, granularity_mm)
      VALUES (
        v_tenant, v_reading, v_ord, (t #>> '{}')::numeric,
        CASE
          WHEN v_n = 1 THEN 'CENTRE'::app.tread_position
          WHEN v_side = 'RIGHT' THEN (ARRAY['INNER','CENTRE','OUTER']::app.tread_position[])[v_ord]
          ELSE (ARRAY['OUTER','CENTRE','INNER']::app.tread_position[])[v_ord]
        END,
        NOT v_spare,
        v_rg);
    END LOOP;

    FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(r -> 'warnings', '[]'::jsonb)) LOOP
      INSERT INTO app.inspection_warning (
        tenant_id, inspection_id, reading_id, warning_code, entered_value, response, source)
      VALUES (v_tenant, v_insp, v_reading, w ->> 'code', w ->> 'entered_value',
              w ->> 'response', 'CLIENT');
    END LOOP;
  END LOOP;

  -- TYRE-155 / FR-INS-066: spares the driver said the unit does not carry.
  -- Validated against the configuration lineage the same way a reading is,
  -- and only a spare may be reported so. A running position with no tyre
  -- is a fitment fact for the register, not an observation for this table.
  FOR a IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload -> 'absent_spares', '[]'::jsonb)) LOOP
    SELECT p.is_spare INTO v_spare
      FROM app.position p
      JOIN app.axle_configuration ac ON ac.id = p.configuration_id
     WHERE p.id = (a ->> 'position_id')::uuid
       AND p.tenant_id = v_tenant
       AND (ac.tenant_id, ac.code) = (
             SELECT a2.tenant_id, a2.code
               FROM app.vehicle v JOIN app.axle_configuration a2 ON a2.id = v.configuration_id
              WHERE v.id = (a ->> 'vehicle_id')::uuid AND v.tenant_id = v_tenant);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'position % is not on any version of vehicle %''s configuration',
        a ->> 'position_id', a ->> 'vehicle_id' USING ERRCODE = 'TY004';
    END IF;
    IF NOT v_spare THEN
      RAISE EXCEPTION 'position % is not a spare; only a spare can be reported absent',
        a ->> 'position_id' USING ERRCODE = 'TY005';
    END IF;
    IF EXISTS (SELECT 1 FROM app.reading r
                WHERE r.inspection_id = v_insp
                  AND r.vehicle_id = (a ->> 'vehicle_id')::uuid
                  AND r.position_id = (a ->> 'position_id')::uuid) THEN
      RAISE EXCEPTION 'position % carries a reading and cannot also be absent',
        a ->> 'position_id' USING ERRCODE = 'TY005';
    END IF;
    INSERT INTO app.inspection_absent_spare (tenant_id, inspection_id, vehicle_id, position_id)
    VALUES (v_tenant, v_insp, (a ->> 'vehicle_id')::uuid, (a ->> 'position_id')::uuid);
  END LOOP;

  -- DR-016's contiguity guard is DEFERRABLE INITIALLY DEFERRED, so left alone
  -- it fires at COMMIT, after the handler has returned, where the API can
  -- only call it a 500. Forcing it here makes a malformed position a refusal
  -- the client can act on.
  SET CONSTRAINTS ALL IMMEDIATE;

  FOR w IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload -> 'warnings', '[]'::jsonb)) LOOP
    INSERT INTO app.inspection_warning (
      tenant_id, inspection_id, warning_code, entered_value, response, source)
    VALUES (v_tenant, v_insp, w ->> 'code', w ->> 'entered_value', w ->> 'response', 'CLIENT');
  END LOOP;

  -- FR-INS-020: the odometer never blocks the inspection, and FR-INS-064 puts
  -- only the motive unit's reading on a timeline. DR-020 still refuses a value
  -- that would corrupt the vehicle's rates, and DR-018 makes that refusal the
  -- only safe answer. The timeline is append-only, so an accepted implausible
  -- reading is permanent. Containing it here is what lets both hold at once.
  --
  -- Only the timeline's own SQLSTATEs are trapped. A generic WHEN OTHERS would
  -- turn an FK violation or a serialisation failure into a quiet "warning".
  v_odo := (p_payload ->> 'odometer_km')::bigint;
  IF v_odo IS NOT NULL THEN
    BEGIN
      INSERT INTO app.vehicle_odometer_reading (
        tenant_id, vehicle_id, reading_date, odometer_km, source, inspection_id)
      VALUES (
        v_tenant, v_vehicle,
        ((p_payload ->> 'submitted_at')::timestamptz AT TIME ZONE 'UTC')::date,
        v_odo, 'INSPECTION', v_insp);
    EXCEPTION
      WHEN SQLSTATE 'TY001' OR SQLSTATE 'TY002' OR unique_violation THEN
        -- FR-OFF-014's standard: the number is not discarded. A controller who
        -- checks it against the fuel records can re-enter it (FR-IMP-015).
        INSERT INTO app.inspection_warning (
          tenant_id, inspection_id, warning_code, entered_value, response, source)
        VALUES (v_tenant, v_insp, 'DR-020', v_odo::text, NULL, 'SERVER');
    END;
  END IF;

  -- FR-INS-052: a completed task cites the inspection that completed it. The
  -- driver launched from a specific task (FR-INS-048 shows them) and a unit can
  -- carry several at once (FR-INS-051), so the payload names which.
  --
  -- A named task closes only where app.inspection_read_unit holds, so a rig
  -- capture closes a trailer's task named through its motive. One the submit
  -- did not read closes nothing, silently, since inspection_task_closes_once
  -- would refuse its close and the capture with it. CANCELLED and COMPLETED
  -- stay as they are (inspection_task_closes_once).
  IF v_task IS NOT NULL THEN
    UPDATE app.inspection_task k
       SET state = 'COMPLETED', completed_inspection_id = v_insp
     WHERE k.tenant_id = v_tenant AND k.id = v_task AND k.state = 'OPEN'
       AND app.inspection_read_unit(v_tenant, v_insp, k.vehicle_id);
  END IF;

  -- U150: an inspection covers the configuration as a whole, so each unit
  -- that carries a reading here has every OPEN task due by the tenant day of
  -- submitted_at completed by it, whether or not one was named. A task
  -- created after the capture was taken asks for a new look, so a capture
  -- the outbox delivers late does not answer it. A task due on a later day
  -- stays open, and so does an unread unit's.
  SELECT t.timezone INTO v_tz FROM app.tenant t WHERE t.id = v_tenant;
  UPDATE app.inspection_task k
     SET state = 'COMPLETED', completed_inspection_id = v_insp
   WHERE k.tenant_id = v_tenant AND k.state = 'OPEN'
     AND k.vehicle_id IN (SELECT r.vehicle_id FROM app.reading r
                           WHERE r.tenant_id = v_tenant AND r.inspection_id = v_insp)
     AND k.created_at <= (p_payload ->> 'submitted_at')::timestamptz
     AND (k.due_at AT TIME ZONE v_tz)::date
         <= ((p_payload ->> 'submitted_at')::timestamptz AT TIME ZONE v_tz)::date;

  inspection_id := v_insp; created := true; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION app.submit_inspection(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.submit_inspection(jsonb) TO app_rw;

-- The task generator (spec, Escalation): every task is written OPEN, and
-- one nobody holds reads escalated, never
-- dropped. Who holds a task is app.task_driver_at's; which units fall due
-- and when is still TYRE-133's.
CREATE OR REPLACE FUNCTION app.generate_inspection_tasks(p_as_of date) RETURNS int
LANGUAGE sql AS $$
  WITH due AS (
    SELECT s.tenant_id, s.id AS schedule_id, v.id AS vehicle_id,
           s.interval_days
      FROM app.inspection_schedule s
      JOIN app.vehicle v
        ON (s.vehicle_id = v.id
            OR (s.operating_group_id IS NOT NULL
                AND v.operating_group_id = s.operating_group_id))
     WHERE s.active
       AND v.status = 'ACTIVE'
       AND NOT EXISTS (
           SELECT 1 FROM app.inspection_task t
            WHERE t.schedule_id = s.id AND t.vehicle_id = v.id
              AND (t.state = 'OPEN'
                   OR t.due_at > (p_as_of::timestamp AT TIME ZONE 'UTC') - make_interval(days => s.interval_days)))),
  ins AS (
    INSERT INTO app.inspection_task (tenant_id, schedule_id, vehicle_id, due_at, state)
    SELECT d.tenant_id, d.schedule_id, d.vehicle_id,
           (p_as_of::timestamp AT TIME ZONE 'UTC') + make_interval(days => d.interval_days),
           'OPEN'::app.task_state
      FROM due d
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;

-- FR-INS-051 as amended: name a driver for an outstanding task on a unit no
-- trip covers (spec, Nominations). The task's row lock serialises two
-- nominations of it; the one that waited then meets a nomination dated after
-- its own now and is refused by name, since its row would be superseded the
-- moment it landed. The covered refusal names the trip, because the task
-- already goes to its driver. Go checks the nominee's capability
-- (refuseNonCapturer); this checks the user is in the fleet and active.
CREATE FUNCTION app.nominate_for_task(p_task uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  k        app.inspection_task;
  usr      app.app_user;
  unit     text;
  holder   text;
  nom      uuid;
BEGIN
  SELECT * INTO k FROM app.inspection_task t
   WHERE t.tenant_id = v_tenant AND t.id = p_task
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such inspection task in this fleet';
  END IF;
  IF k.state <> 'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection is %s; only an open one takes a driver', lower(k.state::text));
  END IF;
  IF EXISTS (SELECT 1 FROM app.inspection_task_nomination n
              WHERE n.tenant_id = v_tenant AND n.task_id = p_task AND n.nominated_at > now()) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = 'this inspection was given another driver while this request was being made; refresh and try again';
  END IF;
  SELECT * INTO usr FROM app.app_user u WHERE u.tenant_id = v_tenant AND u.id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such user in this fleet';
  END IF;
  IF NOT usr.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018', MESSAGE = format('%s is no longer active', usr.display_name);
  END IF;
  SELECT v.fleet_number, u.display_name INTO unit, holder
    FROM app.v_unit_coverage c
    JOIN app.vehicle v ON v.tenant_id = c.tenant_id AND v.id = c.vehicle_id
    JOIN app.app_user u ON u.tenant_id = c.tenant_id AND u.id = c.user_id
   WHERE c.tenant_id = v_tenant AND c.vehicle_id = k.vehicle_id AND c.span @> now();
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('%s is on %s''s trip; the inspection already goes to them', unit, holder);
  END IF;
  INSERT INTO app.inspection_task_nomination (tenant_id, task_id, user_id)
  VALUES (v_tenant, p_task, p_user)
  RETURNING id INTO nom;
  RETURN nom;
END $$;

-- The one way an ad-hoc task comes to exist (FR-INS-051 as amended). An
-- optional nominee is named through app.nominate_for_task, so a nomination
-- has one set of rules. What is checked
-- here is what a task must be true of: a unit this tenant can see and has not
-- retired, and a due day not already past. Shape is refused in Go before the
-- transaction opens (ADR-0013 decision 5). The due instant is the
-- tenant-local last microsecond of the due day (rule 6).
CREATE FUNCTION app.create_inspection_task(p_vehicle uuid, p_due_on date DEFAULT NULL,
                                           p_nominee uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  veh      app.vehicle;
  tz       text;
  today    date;
  due_on   date;
  due_at   timestamptz;
  task     uuid;
BEGIN
  SELECT * INTO veh FROM app.vehicle v WHERE v.tenant_id = v_tenant AND v.id = p_vehicle;
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

  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = v_tenant;
  today  := app.tenant_today(tz);
  due_on := COALESCE(p_due_on, today);
  IF due_on < today THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = 'a task is due today or later, never in the past';
  END IF;
  due_at := ((due_on + 1)::timestamp AT TIME ZONE tz) - interval '1 microsecond';

  INSERT INTO app.inspection_task (tenant_id, vehicle_id, due_at, requested_by, state, created_by)
  VALUES (v_tenant, p_vehicle, due_at, app.current_actor_id(), 'OPEN', app.current_actor_id())
  RETURNING id INTO task;
  IF p_nominee IS NOT NULL THEN
    PERFORM app.nominate_for_task(task, p_nominee);
  END IF;
  RETURN task;
END $$;

-- The tasks that hold a trip start (U148; spec, Starting and ending a
-- trip): every OPEN task on a unit the trip would cover, the motive, the
-- members of its open rig and the added trailers, whose due day in the
-- tenant's calendar is today or earlier, in walk order, then by due instant
-- and task id, so every read lists them alike. Nothing when the
-- tenant's due_inspection_blocks_trip is off; on is only the fallback for a
-- tenant with no row, BAC the evidence (rule 5). app.start_trip refuses on
-- it, and the start form reads it before Start.
--
-- An added id is read only when it is a free trailer, the one unit a start
-- couples and judges through its motive (spec, Depot scope); reading any
-- other would show a depot manager tasks outside their depots (FR-AUT-008).
CREATE FUNCTION app.trip_start_blockers(p_motive uuid, p_add_trailers uuid[] DEFAULT '{}')
RETURNS TABLE (task_id uuid, vehicle_id uuid, fleet_number text, due_at timestamptz, due_on date, walk_order int)
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  WITH zone AS (
    SELECT t.timezone AS tz FROM app.tenant t WHERE t.id = app.current_tenant_id()),
  rig AS (
    SELECT cm.vehicle_id, cm.sequence
      FROM app.combination c
      JOIN app.combination_member cm ON cm.tenant_id = c.tenant_id AND cm.combination_id = c.id
     WHERE c.tenant_id = app.current_tenant_id() AND c.motive_vehicle_id = p_motive
       AND c.effective_to IS NULL AND cm.vehicle_id <> p_motive),
  -- Each unit once, at its first place in the walk, however often a caller
  -- names it: the motive or a rig member may also come as an added trailer.
  units AS (
    SELECT DISTINCT ON (x.vehicle_id) x.vehicle_id, x.walk_order
      FROM (SELECT p_motive AS vehicle_id, 1 AS walk_order
            UNION ALL
            SELECT r.vehicle_id, r.sequence FROM rig r
            UNION ALL
            SELECT a.id, (SELECT COALESCE(max(r.sequence), 1) FROM rig r) + a.ord::int
              FROM unnest(COALESCE(p_add_trailers, '{}'::uuid[])) WITH ORDINALITY a(id, ord)
              JOIN app.vehicle av ON av.tenant_id = app.current_tenant_id() AND av.id = a.id
             WHERE av.unit_kind = 'TRAILER'
               AND NOT EXISTS (SELECT 1
                                 FROM app.combination_member cm
                                 JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
                                WHERE cm.tenant_id = app.current_tenant_id() AND cm.vehicle_id = a.id
                                  AND cm.vehicle_id <> c.motive_vehicle_id AND c.effective_to IS NULL)) x
     ORDER BY x.vehicle_id, x.walk_order)
  SELECT k.id, k.vehicle_id, v.fleet_number, k.due_at, (k.due_at AT TIME ZONE z.tz)::date, u.walk_order
    FROM units u
    CROSS JOIN zone z
    JOIN app.inspection_task k ON k.tenant_id = app.current_tenant_id()
     AND k.vehicle_id = u.vehicle_id AND k.state = 'OPEN'
    JOIN app.vehicle v ON v.tenant_id = k.tenant_id AND v.id = k.vehicle_id
   WHERE COALESCE((app.config_for(app.current_tenant_id(), 'due_inspection_blocks_trip', now()) #>> '{}')::boolean,
                  true)
     AND (k.due_at AT TIME ZONE z.tz)::date <= app.tenant_today(z.tz)
   ORDER BY u.walk_order, k.due_at, k.id
$$;

-- FR-VEH-007 as amended: a controller puts a driver on a motive at now,
-- adding free trailers (spec, Starting and ending a trip). Nothing is
-- written until every check has passed, so each refusal changes nothing.
-- Go checks the driver's capability (refuseNonCapturer).
CREATE FUNCTION app.start_trip(p_motive uuid, p_driver uuid, p_add_trailers uuid[] DEFAULT '{}')
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant     uuid := app.current_tenant_id();
  adds         uuid[] := COALESCE(p_add_trailers, '{}'::uuid[]);
  usr          app.app_user;
  veh          app.vehicle;
  prior_motive uuid;
  rig          uuid;
  trailer      uuid;
  unit         text;
  kind         app.unit_kind;
  holder       uuid;
  holder_fleet text;
  blocked      text;
  towed        jsonb;
  trip         uuid;
BEGIN
  -- The driver's row first, FOR NO KEY UPDATE so the FK checks other writes
  -- make against it do not wait.
  SELECT * INTO usr FROM app.app_user u
   WHERE u.tenant_id = v_tenant AND u.id = p_driver
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such user in this fleet';
  END IF;
  IF NOT usr.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028', MESSAGE = format('%s is no longer active', usr.display_name);
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(adds) a WHERE a IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028', MESSAGE = 'every added trailer names a unit';
  END IF;

  -- Then every unit the start touches, in id order, the order
  -- create_combination_at takes (000044). The prior motive is among them,
  -- since this start ends its trip and Go checks its depot afterwards. Two
  -- starts for one driver or one motive serialise here, and the loser meets
  -- an open trip that started after its own now. The EXCLUDEs are the backstop.
  SELECT t.vehicle_id INTO prior_motive FROM app.trip t
   WHERE t.tenant_id = v_tenant AND t.user_id = p_driver AND t.ended_at IS NULL;
  PERFORM 1 FROM app.vehicle v
   WHERE v.tenant_id = v_tenant
     AND v.id IN (SELECT p_motive
                  UNION ALL
                  SELECT cm.vehicle_id
                    FROM app.combination c
                    JOIN app.combination_member cm ON cm.tenant_id = c.tenant_id AND cm.combination_id = c.id
                   WHERE c.tenant_id = v_tenant AND c.motive_vehicle_id = p_motive AND c.effective_to IS NULL
                  UNION ALL
                  SELECT a FROM unnest(adds) a
                  UNION ALL
                  SELECT prior_motive)
   ORDER BY v.id
     FOR UPDATE;

  SELECT * INTO veh FROM app.vehicle v WHERE v.tenant_id = v_tenant AND v.id = p_motive;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  IF veh.unit_kind = 'TRAILER' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = format('a trip is driven on a horse, rigid or light vehicle; %s is a trailer', veh.fleet_number);
  END IF;
  -- U9's reading of FR-VEH-005, as for a rig: PARKED, WORKSHOP and
  -- OUT_OF_SERVICE may go on a trip.
  IF veh.status IN ('DISPOSED', 'INACTIVE') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = format('%s is %s; a retired unit does not go on a trip', veh.fleet_number, lower(veh.status::text));
  END IF;
  SELECT c.id INTO rig FROM app.combination c
   WHERE c.tenant_id = v_tenant AND c.motive_vehicle_id = p_motive AND c.effective_to IS NULL;

  -- Only a free trailer is coupled (spec, decision 3), refused here before
  -- INV-4 (000037) would, in words that name its truck. A towed unit's
  -- retirement and a missing kind are create_combination_at's (TY017).
  FOREACH trailer IN ARRAY adds LOOP
    SELECT v.fleet_number, v.unit_kind INTO unit, kind
      FROM app.vehicle v WHERE v.tenant_id = v_tenant AND v.id = trailer;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
    END IF;
    -- Before the blocker read, so the refusal names this unit alone and
    -- never a task of a unit outside the caller's depots (FR-AUT-008).
    IF kind <> 'TRAILER' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY028',
        MESSAGE = format('only a trailer is added to a trip; %s is a %s', unit, lower(kind::text));
    END IF;
    SELECT c.motive_vehicle_id, mv.fleet_number INTO holder, holder_fleet
      FROM app.combination_member cm
      JOIN app.combination c ON c.tenant_id = cm.tenant_id AND c.id = cm.combination_id
      JOIN app.vehicle mv ON mv.tenant_id = c.tenant_id AND mv.id = c.motive_vehicle_id
     WHERE cm.tenant_id = v_tenant AND cm.vehicle_id = trailer
       AND cm.vehicle_id <> c.motive_vehicle_id AND c.effective_to IS NULL;
    IF FOUND AND holder = p_motive THEN
      RAISE EXCEPTION USING ERRCODE = 'TY028',
        MESSAGE = format('%s is already coupled to %s', unit, holder_fleet);
    ELSIF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY028',
        MESSAGE = format('%s is coupled to %s; free it before adding it to this trip', unit, holder_fleet);
    END IF;
  END LOOP;

  -- U148: after the shape checks, so a malformed request answers its own
  -- refusal, and before any write. One entry per unit, its earliest day.
  SELECT string_agg(format('%s due %s', b.fleet_number, to_char(b.due_on, 'YYYY-MM-DD')), ', '
                    ORDER BY b.walk_order) INTO blocked
    FROM (SELECT x.fleet_number, min(x.due_on) AS due_on, min(x.walk_order) AS walk_order
            FROM app.trip_start_blockers(p_motive, adds) x
           GROUP BY x.vehicle_id, x.fleet_number) b;
  IF blocked IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'a trip cannot start before its due inspections are done: ' || blocked;
  END IF;

  IF EXISTS (SELECT 1 FROM app.trip t
              WHERE t.tenant_id = v_tenant AND t.ended_at IS NULL
                AND (t.vehicle_id = p_motive OR t.user_id = p_driver) AND t.started_at > now()) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'this unit or driver went on another trip while this one was being started; refresh and try again';
  END IF;

  -- Reassigning the truck or the driver closes the old trip (FR-VEH-007 as
  -- amended).
  UPDATE app.trip t SET ended_at = now(), ended_by = app.current_actor_id()
   WHERE t.tenant_id = v_tenant AND t.ended_at IS NULL
     AND (t.vehicle_id = p_motive OR t.user_id = p_driver);

  -- The start never removes a trailer from the motive's rig: the new rig
  -- holds the old one's members, then the added trailers in the order picked.
  IF cardinality(adds) > 0 THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('vehicle_id', cm.vehicle_id, 'descriptor', cm.descriptor)
                              ORDER BY cm.sequence), '[]'::jsonb)
      INTO towed
      FROM app.combination_member cm
     WHERE cm.tenant_id = v_tenant AND cm.combination_id = rig AND cm.vehicle_id <> p_motive;
    towed := towed || (SELECT jsonb_agg(jsonb_build_object('vehicle_id', a.id) ORDER BY a.ord)
                         FROM unnest(adds) WITH ORDINALITY a(id, ord));
    IF rig IS NOT NULL THEN
      PERFORM app.end_combination_at(rig, now());
    END IF;
    PERFORM app.create_combination_at(p_motive, towed, now());
  END IF;

  INSERT INTO app.trip (tenant_id, vehicle_id, user_id, started_at, started_by, combination_id)
  VALUES (v_tenant, p_motive, p_driver, now(), app.current_actor_id(),
          (SELECT c.id FROM app.combination c
            WHERE c.tenant_id = v_tenant AND c.motive_vehicle_id = p_motive AND c.effective_to IS NULL))
  RETURNING id INTO trip;
  RETURN trip;
END $$;

-- FR-VEH-007 as amended: the end of a trip, at now. It leaves the rig
-- coupled (spec, Calls made here); releasing a trailer is TYRE-455's.
CREATE FUNCTION app.end_trip(p_trip uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  tr       app.trip;
BEGIN
  SELECT * INTO tr FROM app.trip t WHERE t.tenant_id = v_tenant AND t.id = p_trip FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such trip in this fleet';
  END IF;
  -- No instant in the words: they reach the panel verbatim, and an instant
  -- there would be UTC (rule 6).
  IF tr.ended_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'this trip has already ended; refresh to see who is on the truck now';
  END IF;
  IF tr.started_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'this trip started after this request began; refresh and try again';
  END IF;
  UPDATE app.trip t SET ended_at = now(), ended_by = app.current_actor_id()
   WHERE t.tenant_id = v_tenant AND t.id = p_trip;
END $$;

-- ---------------------------------------------------------------------------
-- J. vehicle_driver becomes history (spec)
-- ---------------------------------------------------------------------------
-- The table stays as the record of assignments before trips, and no path
-- writes rows that nothing reads (check 4). DELETE has been revoked since
-- 000018 (DR-014a).
REVOKE INSERT, UPDATE ON app.vehicle_driver FROM app_rw;
COMMENT ON TABLE app.vehicle_driver IS
  'Driver-to-unit assignments before trips (FR-VEH-007 as amended, TYRE-326). History only: no writer, and nothing reads it for a decision; app.trip replaced it in 000060.';
