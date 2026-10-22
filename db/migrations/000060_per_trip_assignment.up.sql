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
-- app.inspection_task_nomination; D the task's close instant; G coverage
-- and responsibility.

-- ---------------------------------------------------------------------------
-- A. Keys and indexes
-- ---------------------------------------------------------------------------
-- The composite keys a nomination's task and a migrated trip's assignment
-- reference, so neither FK can name another tenant's row (check 16).
ALTER TABLE app.inspection_task ADD CONSTRAINT inspection_task_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app.vehicle_driver ADD CONSTRAINT vehicle_driver_tenant_id_id_key UNIQUE (tenant_id, id);

-- Every coverage read finds a unit's rigs by the unit, and a motive's rigs by
-- the motive; neither table had an index that leads with either.
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
  -- tenant_id leads each key because an exclusion check bypasses RLS, as
  -- 000026 says of vehicle_driver_no_overlap.
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
-- trip_stamps_updated writes them on every UPDATE (000037's reasoning).
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
  -- Trips end at the server's now; a future end would close coverage
  -- nobody has yet given up (spec, Starting and ending a trip).
  IF NEW.ended_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY028',
      MESSAGE = 'a trip is ended now or earlier, never in the future';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trip_ended_once BEFORE UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.trip_is_ended_once();

CREATE TRIGGER trip_stamps_updated BEFORE UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

CREATE TRIGGER trip_audited
AFTER INSERT OR UPDATE ON app.trip
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

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

-- ---------------------------------------------------------------------------
-- D. The task's close instant (FR-INS-052; spec, Capture)
-- ---------------------------------------------------------------------------
-- "Outstanding at an instant" needs the instant each task left OPEN, and the
-- audit log is not a read path (spec). A closed task's last write is its
-- close, so its updated_at, or its created_at when it was planted closed, is
-- that instant. The backfill fires inspection_task_stamps_updated and the
-- audit trigger, so those rows' updated_at reads the migration's instant.
ALTER TABLE app.inspection_task ADD COLUMN closed_at timestamptz;
UPDATE app.inspection_task SET closed_at = COALESCE(updated_at, created_at) WHERE state <> 'OPEN';
ALTER TABLE app.inspection_task
  ADD CONSTRAINT task_closed_when_not_open CHECK ((state = 'OPEN') = (closed_at IS NULL));

-- A close is final (rule 3): the responsibility and capture reads judge a
-- past instant by closed_at, so a reopened task would rewrite who held it
-- then. An INSERT may plant a past close; an UPDATE stamps the close itself.
CREATE FUNCTION app.inspection_task_closes_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state IN ('COMPLETED', 'CANCELLED')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION USING ERRCODE = 'TY018',
      MESSAGE = format('this inspection task is %s; a closed task never changes state', lower(OLD.state::text));
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.closed_at := CASE WHEN NEW.state = 'OPEN' THEN NULL ELSE COALESCE(NEW.closed_at, now()) END;
  ELSE
    NEW.closed_at := CASE WHEN NEW.state = 'OPEN' THEN NULL
                          WHEN OLD.state = 'OPEN' THEN now()
                          ELSE OLD.closed_at END;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inspection_task_closes_once BEFORE INSERT OR UPDATE ON app.inspection_task
FOR EACH ROW EXECUTE FUNCTION app.inspection_task_closes_once();

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
-- (decision 6, and the same takeover through a coupling), and the task's
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
