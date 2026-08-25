-- ============================================================================
--  inspection_warning — the record FR-INS-040 demands
--  Implements: DR-021 (errata E2), FR-INS-040
-- ============================================================================

-- Who raised it. A client warning is one the driver saw and answered; a
-- server one is a refusal reached after the device was gone, which is why
-- response is nullable below.
CREATE TYPE app.warning_source AS ENUM ('CLIENT','SERVER');

CREATE TABLE app.inspection_warning (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  inspection_id uuid NOT NULL,
  reading_id    uuid,                    -- NULL for an inspection-level warning
  warning_code  text NOT NULL,           -- the requirement ID that raised it
  entered_value text,                    -- what the driver typed, where a value was refused
  -- DR-020's refusal is reached when a queued submit finally lands, days after
  -- the driver put the phone away. FR-INS-040's "the user's response" cannot
  -- exist for it, so this is nullable rather than defaulted to a fiction.
  response      text,
  source        app.warning_source NOT NULL,
  raised_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz DEFAULT now(),
  created_by    uuid DEFAULT app.current_actor_id(),
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES app.inspection (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reading_id)    REFERENCES app.reading (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by)    REFERENCES app.app_user (tenant_id, id)
);

CREATE INDEX warning_by_inspection ON app.inspection_warning (tenant_id, inspection_id);

CALL app.enable_tenant_rls('app.inspection_warning'::regclass);
GRANT SELECT, INSERT ON app.inspection_warning TO app_rw;

-- DR-021, and DR-014a's rule for every record of fact: the grant is the
-- enforcement, not a convention a later endpoint can talk its way past.
REVOKE UPDATE, DELETE ON app.inspection_warning FROM app_rw;

-- NFR-OBS-007: the measurement that settles whether three readings per
-- position cost NFR-USE-001 its budget. Nullable: an imported or
-- back-dated reading has no capture time, and a zero would be a claim
-- (NFR-PRO-002).
ALTER TABLE app.reading ADD COLUMN capture_seconds int CHECK (capture_seconds >= 0);

-- FR-AUT-005 with FR-INS-053: what a driver may read IN ORDER TO CAPTURE.
-- Deliberately not v_driver_vehicle, which is assignment alone and is what
-- /api/my/vehicles answers — widening that would change every caller. The
-- coupling chain is the justification: a driver responsible for the horse is
-- responsible for what it is pulling, and cannot inspect a rig they cannot
-- read.
CREATE VIEW app.v_capture_vehicle WITH (security_invoker = true) AS
SELECT dv.tenant_id, dv.vehicle_id
  FROM app.v_driver_vehicle dv
UNION
SELECT cm.tenant_id, cm.vehicle_id
  FROM app.v_driver_vehicle dv
  JOIN app.combination c
    ON c.motive_vehicle_id = dv.vehicle_id AND c.effective_to IS NULL
  JOIN app.combination_member cm ON cm.combination_id = c.id;
