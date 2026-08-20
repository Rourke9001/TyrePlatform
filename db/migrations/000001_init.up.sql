-- ============================================================================
--  Fleet Tyre Management Platform — core schema
--  Target: PostgreSQL 16
--  Implements: SRS v1.3 §5 (data requirements), CR-001..CR-011, DR-001..DR-017
--
--  Design rules that are not negotiable (SRS §2.5):
--    CR-001  tenant isolation lives in the database, not the application
--    CR-002  money is DECIMAL, never float
--    CR-003  timestamps are timestamptz, stored UTC
--    CR-004  readings and lifecycle events are append-only
--    CR-008  canonical units: tread mm, pressure kPa, distance km
--    CR-011  tread is an ordered set of width-wise readings, never a scalar
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- This is a golang-migrate migration: it runs exactly once against a database
-- and is recorded in schema_migrations. It must therefore never DROP anything
-- it did not create in this same file — `make db-reset` owns destruction.
CREATE SCHEMA app;

-- ---------------------------------------------------------------------------
-- Tenant context. Every policy resolves through this one function.
-- It returns NULL when unset, and every policy compares with '=', so an
-- unset context matches no rows: the system fails closed (FR-TEN-004).
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_actor_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Enumerated domains
-- ---------------------------------------------------------------------------
CREATE TYPE app.tenant_state    AS ENUM ('PROVISIONING','ACTIVE','SUSPENDED','CLOSED');
CREATE TYPE app.depot_type      AS ENUM ('DEPOT','STORE','RETREADER','BREAKDOWN_SUPPLIER');
CREATE TYPE app.user_role       AS ENUM ('DRIVER','TECHNICIAN','CONTROLLER','DEPOT_MANAGER','ORG_ADMIN','PLATFORM_ADMIN');
CREATE TYPE app.axle_class      AS ENUM ('STEER','DRIVE','TRAILER','TAG','SPARE');
CREATE TYPE app.side            AS ENUM ('LEFT','RIGHT');
CREATE TYPE app.fitment_slot    AS ENUM ('SINGLE','OUTER','INNER');
CREATE TYPE app.vehicle_status  AS ENUM ('ACTIVE','WORKSHOP','INACTIVE','DISPOSED');
CREATE TYPE app.tyre_status     AS ENUM ('NEW','RETREAD');
CREATE TYPE app.tyre_state      AS ENUM ('IN_STOCK','FITTED','REMOVED','AT_RETREADER','AT_BREAKDOWN_SUPPLIER','SCRAPPED','LOST');
CREATE TYPE app.inspection_state AS ENUM ('QUEUED','SYNCED','VOIDED');
CREATE TYPE app.exception_state AS ENUM ('RAISED','ACKNOWLEDGED','ACTIONED','CLOSED','SUPPRESSED');
CREATE TYPE app.severity        AS ENUM ('INFO','WARNING','CRITICAL');
CREATE TYPE app.evidential_status AS ENUM ('CONFIRMED','PROPOSED','VARIANT');
CREATE TYPE app.reading_source  AS ENUM ('MANUAL','TPMS','IMPORT');

-- ---------------------------------------------------------------------------
-- tenant — the isolation root. Not itself tenant-scoped.
-- ---------------------------------------------------------------------------
CREATE TABLE app.tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  subdomain       text NOT NULL UNIQUE,
  timezone        text NOT NULL DEFAULT 'Africa/Johannesburg',
  locale          text NOT NULL DEFAULT 'en-ZA',
  currency        char(3) NOT NULL DEFAULT 'ZAR',
  pressure_unit   text NOT NULL DEFAULT 'KPA' CHECK (pressure_unit IN ('KPA','PSI','BAR')),
  distance_unit   text NOT NULL DEFAULT 'KM'  CHECK (distance_unit IN ('KM','MI')),
  state           app.tenant_state NOT NULL DEFAULT 'PROVISIONING',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- configuration — every threshold, band and rate (CR-005).
-- Stored as key/value with effective dating so FR-CFG-051 (prospective only)
-- is a query concern rather than an overwrite.
-- ---------------------------------------------------------------------------
CREATE TABLE app.configuration (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  key            text NOT NULL,
  value          jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX configuration_lookup ON app.configuration (tenant_id, key, effective_from DESC);

CREATE TABLE app.depot (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  type       app.depot_type NOT NULL DEFAULT 'DEPOT',
  address    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE app.app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES app.tenant(id) ON DELETE CASCADE, -- NULL for PLATFORM_ADMIN
  email         text NOT NULL,
  display_name  text NOT NULL,
  -- FR-AUT-022: durable identifier independent of display name. R13 identifies
  -- its driver as "Melusi" and nothing else.
  staff_number  text,
  role          app.user_role NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  CONSTRAINT platform_admin_has_no_tenant
    CHECK ((role = 'PLATFORM_ADMIN' AND tenant_id IS NULL)
        OR (role <> 'PLATFORM_ADMIN' AND tenant_id IS NOT NULL))
);

CREATE TABLE app.user_depot (
  user_id  uuid NOT NULL REFERENCES app.app_user(id) ON DELETE CASCADE,
  depot_id uuid NOT NULL REFERENCES app.depot(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, depot_id)
);

-- ---------------------------------------------------------------------------
-- Axle configurations and positions (FR-VEH-010..017, Appendix I)
-- Versioned: amending a configuration creates a new version so historical
-- inspections keep their position meaning (FR-VEH-016).
-- ---------------------------------------------------------------------------
CREATE TABLE app.axle_configuration (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  code              text NOT NULL,
  name              text NOT NULL,
  version           int  NOT NULL DEFAULT 1,
  axle_count        int  NOT NULL CHECK (axle_count > 0),
  evidential_status app.evidential_status NOT NULL DEFAULT 'PROPOSED',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

CREATE TABLE app.position (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  configuration_id uuid NOT NULL REFERENCES app.axle_configuration(id) ON DELETE CASCADE,
  code             text NOT NULL,          -- unit-own code per BR-VEH-003
  sequence         int  NOT NULL,          -- capture order within the configuration
  axle_number      int,                    -- NULL for spare
  axle_class       app.axle_class NOT NULL,
  side             app.side,               -- NULL for spare
  slot             app.fitment_slot,       -- NULL for spare
  is_spare         boolean NOT NULL DEFAULT false,
  unit_label       text,                   -- 'Horse', '6m link' — FR-VEH-023
  UNIQUE (configuration_id, code),
  CONSTRAINT spare_has_no_geometry CHECK (
    (is_spare AND axle_number IS NULL AND side IS NULL AND slot IS NULL AND axle_class = 'SPARE')
    OR (NOT is_spare AND axle_number IS NOT NULL AND side IS NOT NULL AND slot IS NOT NULL AND axle_class <> 'SPARE')
  )
);
CREATE INDEX position_by_config ON app.position (configuration_id, sequence);

CREATE TABLE app.vehicle (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  fleet_number     text NOT NULL,                     -- DR-003, alphanumeric (FR-VEH-003)
  registration     text,                              -- drivers search by this (FR-VEH-022)
  description      text,
  configuration_id uuid NOT NULL REFERENCES app.axle_configuration(id),
  body_type        text,                              -- FR-VEH-024, BR-VEH-004
  unit_descriptor  text,                              -- '6m link' (FR-VEH-023)
  home_depot_id    uuid REFERENCES app.depot(id),
  current_odometer bigint CHECK (current_odometer >= 0),  -- DR-009
  status           app.vehicle_status NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, fleet_number)                    -- DR-003
);
CREATE INDEX vehicle_by_registration ON app.vehicle (tenant_id, upper(registration));

CREATE TABLE app.vehicle_driver (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES app.vehicle(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app.app_user(id),
  from_date  date NOT NULL,
  to_date    date,
  CHECK (to_date IS NULL OR to_date >= from_date)
);

-- Combination = motive unit + towed units, effective-dated (FR-VEH-030..032)
CREATE TABLE app.combination (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  motive_vehicle_id uuid NOT NULL REFERENCES app.vehicle(id),
  configuration_id  uuid NOT NULL REFERENCES app.axle_configuration(id),
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz
);

CREATE TABLE app.combination_member (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  combination_id uuid NOT NULL REFERENCES app.combination(id) ON DELETE CASCADE,
  vehicle_id     uuid NOT NULL REFERENCES app.vehicle(id),
  sequence       int  NOT NULL,
  descriptor     text,
  UNIQUE (combination_id, sequence)
);

-- FR-VEH-032: combination-level position -> constituent vehicle + own position
CREATE TABLE app.combination_position_map (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  configuration_id      uuid NOT NULL REFERENCES app.axle_configuration(id) ON DELETE CASCADE,
  combination_code      text NOT NULL,     -- what the driver sees: '11'
  member_sequence       int  NOT NULL,     -- which constituent unit
  member_position_code  text NOT NULL,     -- that unit's own code: '1'
  UNIQUE (configuration_id, combination_code)
);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
CREATE TABLE app.tyre_size (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name         text NOT NULL,
  construction text CHECK (construction IN ('RADIAL','CROSS_PLY')),
  active       boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);
CREATE TABLE app.tyre_brand (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name      text NOT NULL,
  active    boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);
CREATE TABLE app.tyre_pattern (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  brand_id   uuid REFERENCES app.tyre_brand(id),
  applies_to text NOT NULL DEFAULT 'NEW' CHECK (applies_to IN ('NEW','RETREAD','BOTH')),
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- tyre — the central asset.
-- rand_per_mm is stored on the tyre, never derived from pattern at read time
-- (FR-TYR-007). Proven by SP431 at R205.71/mm in one batch and R284.38/mm in
-- another (SRS Appendix E).
-- ---------------------------------------------------------------------------
CREATE TABLE app.tyre (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  branded_number  text NOT NULL,
  size_id         uuid REFERENCES app.tyre_size(id),
  brand_id        uuid REFERENCES app.tyre_brand(id),
  pattern_id      uuid REFERENCES app.tyre_pattern(id),
  status          app.tyre_status NOT NULL DEFAULT 'NEW',
  retread_count   int NOT NULL DEFAULT 0 CHECK (retread_count >= 0),
  purchase_date   date,
  purchase_price  numeric(12,2) CHECK (purchase_price >= 0),   -- DR-006
  new_tread_mm    numeric(4,1)  CHECK (new_tread_mm > 0),      -- DR-007
  rand_per_mm     numeric(12,4) CHECK (rand_per_mm >= 0),
  casing_value    numeric(12,2) NOT NULL DEFAULT 0 CHECK (casing_value >= 0),
  state           app.tyre_state NOT NULL DEFAULT 'IN_STOCK',
  current_depot_id uuid REFERENCES app.depot(id),
  last_tread_mm   numeric(4,1),
  last_tread_at   timestamptz,
  -- FR-TYR-032: incomplete records are excluded from valuation totals
  valuation_complete boolean GENERATED ALWAYS AS
    (purchase_price IS NOT NULL AND new_tread_mm IS NOT NULL AND rand_per_mm IS NOT NULL) STORED,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branded_number),                          -- DR-002
  CONSTRAINT retread_count_matches_status
    CHECK ((status = 'NEW' AND retread_count = 0) OR (status = 'RETREAD' AND retread_count >= 1))
);
CREATE INDEX tyre_by_state ON app.tyre (tenant_id, state);
CREATE INDEX tyre_branded_search ON app.tyre (tenant_id, branded_number text_pattern_ops);

-- ---------------------------------------------------------------------------
-- fitment — the spine of cost-per-kilometre.
-- Partial unique indexes enforce BR-FIT-001 and BR-FIT-002 in the database
-- rather than in application code (DR-004, DR-005).
-- ---------------------------------------------------------------------------
CREATE TABLE app.fitment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  tyre_id          uuid NOT NULL REFERENCES app.tyre(id),
  vehicle_id       uuid NOT NULL REFERENCES app.vehicle(id),
  position_id      uuid NOT NULL REFERENCES app.position(id),
  fitted_at        timestamptz NOT NULL,
  fitted_odometer  bigint NOT NULL CHECK (fitted_odometer >= 0),   -- BR-FIT-004
  fitted_tread_mm  numeric(4,1),
  removed_at       timestamptz,
  removed_odometer bigint CHECK (removed_odometer >= 0),
  removed_tread_mm numeric(4,1),
  removal_reason   text,
  distance_run     bigint GENERATED ALWAYS AS (removed_odometer - fitted_odometer) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT removal_is_complete CHECK (
    (removed_at IS NULL AND removed_odometer IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_odometer IS NOT NULL AND removal_reason IS NOT NULL)),
  CONSTRAINT odometer_does_not_decrease CHECK (removed_odometer IS NULL OR removed_odometer >= fitted_odometer)
);
CREATE UNIQUE INDEX one_open_fitment_per_position ON app.fitment (position_id, vehicle_id) WHERE removed_at IS NULL;  -- DR-004
CREATE UNIQUE INDEX one_open_fitment_per_tyre     ON app.fitment (tyre_id)                 WHERE removed_at IS NULL;  -- DR-005
CREATE INDEX fitment_by_vehicle ON app.fitment (tenant_id, vehicle_id, fitted_at DESC);

-- ---------------------------------------------------------------------------
-- inspection / reading / reading_measurement
--
-- CR-011 and DR-016/017: tread is captured as an ordered set of width-wise
-- readings. `governing_tread_mm` on the reading is a materialised MIN() of the
-- measurements, kept honest by a trigger. It exists because every valuation,
-- band and exception query reads it and none of them needs the individual
-- values; the measurements remain the record of fact (BR-INS-005).
-- ---------------------------------------------------------------------------
CREATE TABLE app.inspection (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  vehicle_id       uuid NOT NULL REFERENCES app.vehicle(id),      -- the motive unit
  combination_id   uuid REFERENCES app.combination(id),
  user_id          uuid NOT NULL REFERENCES app.app_user(id),
  client_uuid      uuid NOT NULL,                                  -- DR-015, idempotency key
  started_at       timestamptz NOT NULL,
  submitted_at     timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),             -- FR-OFF-015
  odometer         bigint NOT NULL CHECK (odometer >= 0),          -- FR-INS-020
  latitude         numeric(9,6),
  longitude        numeric(9,6),
  device_id        text,
  app_version      text,
  completeness_pct numeric(5,2) NOT NULL DEFAULT 100 CHECK (completeness_pct BETWEEN 0 AND 100),
  duration_seconds int CHECK (duration_seconds >= 0),
  comment          text,                                           -- FR-INS-030a
  defect_report    text,                                           -- FR-INS-030b (v1.3)
  state            app.inspection_state NOT NULL DEFAULT 'SYNCED',
  void_reason      text,
  UNIQUE (tenant_id, client_uuid),                                 -- FR-OFF-011 idempotency
  CONSTRAINT void_has_reason CHECK (state <> 'VOIDED' OR void_reason IS NOT NULL)
);
CREATE INDEX inspection_by_vehicle ON app.inspection (tenant_id, vehicle_id, submitted_at DESC);

CREATE TABLE app.reading (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  inspection_id       uuid NOT NULL REFERENCES app.inspection(id) ON DELETE CASCADE,
  vehicle_id          uuid NOT NULL REFERENCES app.vehicle(id),    -- FR-INS-061: the OWNING unit
  position_id         uuid NOT NULL REFERENCES app.position(id),
  tyre_id             uuid REFERENCES app.tyre(id),                -- NULL if position empty / unknown
  governing_tread_mm  numeric(4,1),                                -- BR-INS-003, maintained by trigger
  pressure_kpa        int CHECK (pressure_kpa BETWEEN 0 AND 1200), -- FR-INS-031, DR-008
  damage_flag         boolean NOT NULL DEFAULT false,
  damage_type         text,
  wear_pattern        text,
  note                text,
  source              app.reading_source NOT NULL DEFAULT 'MANUAL',
  UNIQUE (inspection_id, position_id, vehicle_id)
);
CREATE INDEX reading_by_tyre ON app.reading (tenant_id, tyre_id);

CREATE TABLE app.reading_measurement (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  reading_id uuid NOT NULL REFERENCES app.reading(id) ON DELETE CASCADE,
  ordinal    int  NOT NULL CHECK (ordinal >= 1),
  label      text,                                                  -- 'OUTER' / 'CENTRE' / 'INNER' (FR-CFG-024)
  tread_mm   numeric(4,1) NOT NULL CHECK (tread_mm BETWEEN 0 AND 35),  -- FR-INS-030, DR-007
  UNIQUE (reading_id, ordinal)
);

-- DR-017: governing depth is always MIN of that reading's measurements.
CREATE FUNCTION app.refresh_governing_tread() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  target := COALESCE(NEW.reading_id, OLD.reading_id);
  UPDATE app.reading r
     SET governing_tread_mm = (SELECT min(m.tread_mm)
                                 FROM app.reading_measurement m
                                WHERE m.reading_id = target)
   WHERE r.id = target;
  RETURN NULL;
END $$;

CREATE TRIGGER reading_measurement_governs
AFTER INSERT OR UPDATE OR DELETE ON app.reading_measurement
FOR EACH ROW EXECUTE FUNCTION app.refresh_governing_tread();

-- DR-016: contiguous ordinals from 1, checked at statement end so a
-- multi-row INSERT of a whole position is not rejected mid-way.
CREATE FUNCTION app.check_measurement_ordinals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  FOR bad IN
    SELECT r.id, count(m.*) AS n, min(m.ordinal) AS lo, max(m.ordinal) AS hi
      FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
     GROUP BY r.id
    HAVING min(m.ordinal) <> 1 OR max(m.ordinal) <> count(m.*)
  LOOP
    RAISE EXCEPTION 'reading % has non-contiguous measurement ordinals (n=%, lo=%, hi=%)',
      bad.id, bad.n, bad.lo, bad.hi;
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER reading_measurement_ordinals_contiguous
AFTER INSERT OR UPDATE OR DELETE ON app.reading_measurement
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.check_measurement_ordinals();

CREATE TABLE app.photo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  reading_id   uuid NOT NULL REFERENCES app.reading(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  captured_at  timestamptz NOT NULL,
  size_bytes   int CHECK (size_bytes > 0),
  upload_state text NOT NULL DEFAULT 'PENDING' CHECK (upload_state IN ('PENDING','UPLOADED','FAILED'))
);

-- ---------------------------------------------------------------------------
-- tyre_event — append-only lifecycle log (FR-FIT-014, BR-FIT-007)
-- ---------------------------------------------------------------------------
CREATE TABLE app.tyre_event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  tyre_id              uuid NOT NULL REFERENCES app.tyre(id),
  type                 text NOT NULL,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  actor_id             uuid REFERENCES app.app_user(id),
  from_state           app.tyre_state,
  to_state             app.tyre_state,
  payload              jsonb,
  reason               text,
  compensates_event_id uuid REFERENCES app.tyre_event(id)
);
CREATE INDEX tyre_event_by_tyre ON app.tyre_event (tenant_id, tyre_id, occurred_at);

CREATE TABLE app.valuation_snapshot (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  tyre_id      uuid NOT NULL REFERENCES app.tyre(id),
  as_at        date NOT NULL,
  tread_mm     numeric(4,1),
  tread_value  numeric(12,2) NOT NULL,
  casing_value numeric(12,2) NOT NULL,
  total_value  numeric(12,2) GENERATED ALWAYS AS (tread_value + casing_value) STORED,
  UNIQUE (tyre_id, as_at)                                          -- FR-VAL-022 / NFR-CST-003
);

-- ---------------------------------------------------------------------------
-- Exceptions
-- ---------------------------------------------------------------------------
CREATE TABLE app.exception_rule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  code               text NOT NULL,
  name               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  severity           app.severity NOT NULL,
  threshold          jsonb,
  escalation_minutes int,
  UNIQUE (tenant_id, code)
);

CREATE TABLE app.exception (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  rule_id             uuid NOT NULL REFERENCES app.exception_rule(id),
  subject_type        text NOT NULL,           -- 'TYRE' | 'VEHICLE' | 'POSITION_PAIR' | 'AXLE'
  subject_id          uuid NOT NULL,
  detail              jsonb,
  severity            app.severity NOT NULL,
  raised_at           timestamptz NOT NULL DEFAULT now(),
  state               app.exception_state NOT NULL DEFAULT 'RAISED',
  assignee_id         uuid REFERENCES app.app_user(id),
  acknowledged_at     timestamptz,
  closed_at           timestamptz,
  resolution_note     text,
  resolving_event_id  uuid REFERENCES app.tyre_event(id),
  CONSTRAINT closure_is_explained CHECK (
    state <> 'CLOSED' OR resolution_note IS NOT NULL OR resolving_event_id IS NOT NULL)  -- FR-EXC-009
);
-- FR-EXC-006: exactly one OPEN exception per rule per subject
CREATE UNIQUE INDEX one_open_exception_per_subject
  ON app.exception (rule_id, subject_type, subject_id)
  WHERE state IN ('RAISED','ACKNOWLEDGED','ACTIONED');

CREATE TABLE app.notification (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES app.app_user(id),
  channel        text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH')),
  exception_id   uuid REFERENCES app.exception(id),
  sent_at        timestamptz,
  delivery_state text NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE app.audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES app.tenant(id) ON DELETE CASCADE,
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  source_ip   inet,
  session_id  text
);
CREATE INDEX audit_by_entity ON app.audit_log (tenant_id, entity_type, entity_id, at DESC);

-- ============================================================================
--  ROW-LEVEL SECURITY  (CR-001, NFR-SEC-004)
--
--  Every tenant-scoped table gets the same policy shape. FORCE is essential:
--  without it the table owner bypasses RLS entirely, which is exactly the
--  account an ORM connects as. The isolation test in 003 proves this.
-- ============================================================================

CREATE PROCEDURE app.enable_tenant_rls(tbl regclass)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = app.current_tenant_id())
      WITH CHECK (tenant_id = app.current_tenant_id())
  $f$, tbl);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app.configuration','app.depot','app.app_user','app.axle_configuration','app.position',
    'app.vehicle','app.vehicle_driver','app.combination','app.combination_member',
    'app.combination_position_map','app.tyre_size','app.tyre_brand','app.tyre_pattern',
    'app.tyre','app.fitment','app.inspection','app.reading','app.reading_measurement',
    'app.photo','app.tyre_event','app.valuation_snapshot','app.exception_rule',
    'app.exception','app.notification','app.audit_log'
  ] LOOP
    CALL app.enable_tenant_rls(t::regclass);
  END LOOP;
END $$;

-- app_user carries NULL tenant_id for PLATFORM_ADMIN, which the standard
-- policy would hide from everyone. That is the intended behaviour for tenant
-- sessions: platform staff are not visible inside a tenant context.

-- The tenant table itself: a session may see only its own tenant row.
ALTER TABLE app.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON app.tenant
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Roles.
--  app_rw   — what the application connects as. Subject to RLS.
--  app_migrator — owns the schema, used only by migrations.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_rw;

-- CR-004 / DR-011: readings, measurements, events and audit are append-only.
-- Revoking here is the enforcement; the application literally cannot rewrite
-- history through its own connection.
REVOKE UPDATE, DELETE ON app.reading             FROM app_rw;
REVOKE UPDATE, DELETE ON app.reading_measurement FROM app_rw;
REVOKE UPDATE, DELETE ON app.tyre_event          FROM app_rw;
REVOKE UPDATE, DELETE ON app.audit_log           FROM app_rw;

-- The governing-tread trigger updates app.reading, so it must run with the
-- definer's rights rather than app_rw's (which has no UPDATE on that table).
ALTER FUNCTION app.refresh_governing_tread() SECURITY DEFINER;

-- ============================================================================
--  BUSINESS RULE FUNCTIONS  (SRS §6)
-- ============================================================================

-- BR-VAL-001
CREATE FUNCTION app.tread_value(governing_mm numeric, removal_threshold_mm numeric, rand_per_mm numeric)
RETURNS numeric(12,2) LANGUAGE sql IMMUTABLE AS $$
  SELECT round(GREATEST(0, (COALESCE(governing_mm,0) - removal_threshold_mm) * COALESCE(rand_per_mm,0)), 2)
$$;

-- BR-VAL-002
CREATE FUNCTION app.rand_per_mm(purchase_price numeric, new_tread_mm numeric, removal_threshold_mm numeric)
RETURNS numeric(12,4) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN new_tread_mm > removal_threshold_mm
              THEN round(purchase_price / (new_tread_mm - removal_threshold_mm), 4)
              ELSE NULL END
$$;

-- BR-ANL-001
CREATE FUNCTION app.wear_rate_mm_per_1000km(
  tread_earlier numeric, tread_later numeric, odo_earlier bigint, odo_later bigint)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN odo_later > odo_earlier
              THEN round(((tread_earlier - tread_later) / (odo_later - odo_earlier)) * 1000, 4)
              ELSE NULL END
$$;

-- BR-ANL-007: width-wise spread for one reading
CREATE FUNCTION app.width_spread_mm(p_reading_id uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT max(tread_mm) - min(tread_mm) FROM app.reading_measurement WHERE reading_id = p_reading_id
$$;

-- ============================================================================
--  ANALYTICAL VIEWS
-- ============================================================================

-- Every reading with its position geometry and derived wear indicators.
CREATE VIEW app.v_reading_detail WITH (security_invoker = true) AS
SELECT r.id            AS reading_id,
       r.tenant_id,
       i.id            AS inspection_id,
       i.submitted_at,
       i.odometer,
       r.vehicle_id,
       v.fleet_number,
       v.registration,
       p.code          AS position_code,
       p.sequence,
       p.axle_number,
       p.axle_class,
       p.side,
       p.slot,
       p.is_spare,
       p.unit_label,
       r.tyre_id,
       r.governing_tread_mm,
       (SELECT max(m.tread_mm) - min(m.tread_mm)
          FROM app.reading_measurement m WHERE m.reading_id = r.id) AS width_spread_mm,
       (SELECT array_agg(m.tread_mm ORDER BY m.ordinal)
          FROM app.reading_measurement m WHERE m.reading_id = r.id) AS measurements,
       r.pressure_kpa,
       r.damage_flag,
       r.note
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
  JOIN app.vehicle    v ON v.id = r.vehicle_id
  JOIN app.position   p ON p.id = r.position_id
 WHERE i.state <> 'VOIDED';

-- FR-ANL-028 / FR-EXC-036: dual-mate mismatch, computed per axle end.
CREATE VIEW app.v_dual_mate_difference WITH (security_invoker = true) AS
SELECT a.tenant_id,
       a.inspection_id,
       a.vehicle_id,
       a.axle_number,
       a.side,
       a.position_code  AS outer_position,
       b.position_code  AS inner_position,
       a.governing_tread_mm AS outer_mm,
       b.governing_tread_mm AS inner_mm,
       abs(a.governing_tread_mm - b.governing_tread_mm) AS difference_mm
  FROM app.v_reading_detail a
  JOIN app.v_reading_detail b
    ON b.inspection_id = a.inspection_id
   AND b.vehicle_id    = a.vehicle_id
   AND b.axle_number   = a.axle_number
   AND b.side          = a.side
   AND a.slot = 'OUTER' AND b.slot = 'INNER'
 WHERE a.governing_tread_mm IS NOT NULL AND b.governing_tread_mm IS NOT NULL;

-- FR-ANL-029 / FR-EXC-037: axle side-to-side divergence.
CREATE VIEW app.v_axle_side_divergence WITH (security_invoker = true) AS
SELECT tenant_id, inspection_id, vehicle_id, axle_number,
       avg(governing_tread_mm) FILTER (WHERE side = 'LEFT')  AS left_mean_mm,
       avg(governing_tread_mm) FILTER (WHERE side = 'RIGHT') AS right_mean_mm,
       abs(  avg(governing_tread_mm) FILTER (WHERE side = 'LEFT')
           - avg(governing_tread_mm) FILTER (WHERE side = 'RIGHT')) AS divergence_mm
  FROM app.v_reading_detail
 WHERE NOT is_spare AND governing_tread_mm IS NOT NULL
 GROUP BY tenant_id, inspection_id, vehicle_id, axle_number
HAVING count(*) FILTER (WHERE side = 'LEFT') > 0
   AND count(*) FILTER (WHERE side = 'RIGHT') > 0;

-- ---------------------------------------------------------------------------
-- DEPLOYMENT NOTE — the one way to defeat all of the above.
--
-- FORCE ROW LEVEL SECURITY binds the table owner. It does NOT bind a
-- superuser, and it does not bind a role with the BYPASSRLS attribute.
-- If the application connects as `postgres`, every policy in this file is
-- inert and cross-tenant reads succeed silently.
--
-- The application role must therefore be:
--     NOSUPERUSER  NOBYPASSRLS  NOCREATEDB  NOCREATEROLE
-- and must not own these tables. 003_isolation_test.sql proves both the
-- policies and this property, and is intended to run in CI on every build
-- (NFR-SEC-005).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_login') THEN
    CREATE ROLE app_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT app_rw TO app_login;

-- Re-presents an inspection in the combination numbering the driver saw
-- (FR-VEH-032). Readings are STORED against each constituent unit's own
-- position codes per BR-VEH-003; this view is the inverse of that resolution
-- and is what the capture screen and the printed report should render.
CREATE VIEW app.v_combination_reading WITH (security_invoker = true) AS
SELECT d.tenant_id,
       d.inspection_id,
       m.combination_code,
       (m.combination_code)::int AS combination_position,
       d.vehicle_id,
       d.fleet_number,
       d.unit_label,
       d.position_code AS unit_own_code,
       d.axle_number,
       d.axle_class,
       d.side,
       d.slot,
       d.is_spare,
       d.governing_tread_mm,
       d.width_spread_mm,
       d.measurements,
       d.pressure_kpa
  FROM app.v_reading_detail d
  JOIN app.inspection i          ON i.id = d.inspection_id
  JOIN app.combination cb        ON cb.id = i.combination_id
  JOIN app.combination_member cm ON cm.combination_id = cb.id AND cm.vehicle_id = d.vehicle_id
  JOIN app.combination_position_map m
    ON m.configuration_id = cb.configuration_id
   AND m.member_sequence  = cm.sequence
   AND m.member_position_code = d.position_code
 WHERE NOT d.is_spare;

-- ---------------------------------------------------------------------------
-- SECURITY NOTE — views and RLS.
--
-- A PostgreSQL view executes with the privileges of its OWNER unless
-- security_invoker is set. Because these views are owned by the migration
-- role, a view without security_invoker would evaluate the underlying tables'
-- RLS policies as that owner — and return every tenant's rows to any caller.
-- Every view above therefore sets `WITH (security_invoker = true)`.
-- 004_tests.sql asserts this for each view; adding a view without it will
-- fail the build.
-- ---------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO app_rw;
