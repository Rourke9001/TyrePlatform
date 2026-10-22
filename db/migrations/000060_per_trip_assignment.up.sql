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
-- app.inspection_task_nomination.

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
