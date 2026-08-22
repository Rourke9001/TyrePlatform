-- ============================================================================
--  Sponsor-answer new tables, RLS and grants (TYRE-42)
--  Implements: CHG-013/014, CHG-016..020, CHG-024, CHG-026, CHG-028 (skip
--  logic), CHG-032..034, CHG-036 (price list + awaiting-cost), CHG-038 seed
--  posture, CHG-040/041 — manifest v1.1 §4.2.
--
--  Every FK between tenant-scoped tables is composite (tenant_id, id), the
--  000004 convention: FK checks run below RLS, so an id-only FK would let a
--  session reference a row it cannot see. Check 16 sweeps for regressions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fleet grouping (Q2, CHG-013 / CHG-014)
--
-- One company = one tenant = one fleet. Sub-division is offered, never
-- enforced, and no taxonomy is shipped. A vehicle has AT MOST ONE parent group
-- so cost roll-ups always sum to the fleet total; tags are many-to-many and
-- must never feed a financial roll-up, or a truck tagged both "cross-border"
-- and "refrigerated" is counted twice.
-- ---------------------------------------------------------------------------
CREATE TABLE app.operating_group (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

ALTER TABLE app.vehicle ADD COLUMN operating_group_id uuid;
ALTER TABLE app.vehicle ADD CONSTRAINT vehicle_operating_group_id_fkey
  FOREIGN KEY (tenant_id, operating_group_id) REFERENCES app.operating_group (tenant_id, id);

CREATE TABLE app.vehicle_tag (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  name      text NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, id)
);

CREATE TABLE app.vehicle_tag_map (
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL,
  tag_id     uuid NOT NULL,
  -- tenant_id leads the key: a unique index is checked before the composite
  -- FK's trigger, so a key without it answers "does this pair exist in
  -- another tenant" through the distinguishable error alone
  PRIMARY KEY (tenant_id, vehicle_id, tag_id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES app.vehicle (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tag_id)     REFERENCES app.vehicle_tag (tenant_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2. Thresholds (Q4, CHG-019 / CHG-020 / CHG-038)
--
-- FOUR DISTINCT CONCEPTS, one of which drives alerts (CHG-061). The 4mm figure
-- in the 2021 survey is the MANUFACTURER'S RECOMMENDATION. It is NOT the legal
-- minimum: Regulation 212 of the National Road Traffic Act 93 of 1996 requires
-- a clearly visible pattern with at least ONE millimetre of tread. The system
-- must never assert 4mm as a legal figure (CFL-012).
-- ---------------------------------------------------------------------------

-- Platform-level reference data: public law, identical for every tenant, so it
-- carries no tenant_id. RLS is still ENABLED and FORCED — the structural sweep
-- (check 12) holds for every table — with a read-everyone policy and no write
-- policy: informational only, never an alert source, never legal advice.
CREATE TABLE app.jurisdiction_tread_minimum (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction   text NOT NULL,
  minimum_mm     numeric(4,1) NOT NULL CHECK (minimum_mm > 0),
  citation       text NOT NULL,
  source_url     text,
  effective_from date NOT NULL,
  verified_on    date NOT NULL,
  UNIQUE (jurisdiction, effective_from)
);
ALTER TABLE app.jurisdiction_tread_minimum ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.jurisdiction_tread_minimum FORCE ROW LEVEL SECURITY;
CREATE POLICY jurisdiction_public_read ON app.jurisdiction_tread_minimum
  FOR SELECT USING (true);

INSERT INTO app.jurisdiction_tread_minimum
  (jurisdiction, minimum_mm, citation, effective_from, verified_on)
VALUES
  ('ZA', 1.0, 'Regulation 212, National Road Traffic Act 93 of 1996', '1996-01-01', '2026-08-22');

-- The number the system actually acts on (CHG-111 makes this table the ONE
-- threshold source; 000013 rewires the resolvers). Settable per tenant, and
-- optionally narrowed by operating group (cross-border runs face other
-- jurisdictions) and by axle class (steer tyres are commonly pulled earlier).
--
-- TWO pull thresholds, not one: the depth at which a tyre is pulled to RETREAD
-- sits at or above the depth at which it would be pulled to scrap, because
-- pulling earlier protects the casing — which is where half the value is (Q3).
-- warning_threshold_mm is the dashboard warning band; CHG-111 folds both
-- threshold config keys into this table, so both live here.
CREATE TABLE app.threshold_policy (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  operating_group_id    uuid,
  axle_class            app.axle_class,
  retread_threshold_mm  numeric(4,1) NOT NULL DEFAULT 4.0 CHECK (retread_threshold_mm > 0),
  scrap_threshold_mm    numeric(4,1) NOT NULL DEFAULT 4.0 CHECK (scrap_threshold_mm > 0),
  warning_threshold_mm  numeric(4,1) CHECK (warning_threshold_mm > 0),
  insurance_minimum_mm  numeric(4,1) CHECK (insurance_minimum_mm > 0),
  insurance_note        text,
  max_retreads          int NOT NULL DEFAULT 2 CHECK (max_retreads >= 0),
  retreads_permitted    boolean NOT NULL DEFAULT true,
  effective_from        timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, operating_group_id) REFERENCES app.operating_group (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)         REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT retread_at_or_above_scrap CHECK (retread_threshold_mm >= scrap_threshold_mm)
);
CREATE INDEX threshold_policy_lookup
  ON app.threshold_policy (tenant_id, operating_group_id, axle_class, effective_from DESC);

COMMENT ON COLUMN app.threshold_policy.retreads_permitted IS
  'Per axle class. Seeded FALSE for STEER by fleet convention, not by regulation — no SA rule was found (CHG-038, CHG-107).';

-- ---------------------------------------------------------------------------
-- 3. Odometer as a vehicle timeline (Q6/Q8, CHG-024 / CHG-026)
--
-- The odometer belongs to the VEHICLE, not the inspection. Any source counts:
-- BAC's come from fuel records, which are weekly-or-better, kept for
-- accounting, and go back years — a better foundation than the monthly paper
-- trail suggested. Tyre distance is DERIVED: for each period a tyre was fitted
-- at a position, it accrues that vehicle's kilometres over that period.
-- ---------------------------------------------------------------------------
CREATE TABLE app.vehicle_odometer_reading (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  vehicle_id    uuid NOT NULL,
  reading_date  date NOT NULL,
  odometer_km   bigint NOT NULL CHECK (odometer_km >= 0),
  source        app.reading_source NOT NULL,
  inspection_id uuid,
  imported      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- tenant_id leads the key (see vehicle_tag_map's note): without it the
  -- duplicate-key error is a cross-tenant existence oracle
  UNIQUE (tenant_id, vehicle_id, reading_date, source),
  FOREIGN KEY (tenant_id, vehicle_id)    REFERENCES app.vehicle (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, inspection_id) REFERENCES app.inspection (tenant_id, id)
);
CREATE INDEX odometer_by_vehicle
  ON app.vehicle_odometer_reading (tenant_id, vehicle_id, reading_date DESC);

-- Validation: a transposed digit produces a 100,000 km day and poisons every
-- rate calculation on that vehicle thereafter. Monotonicity and a plausible
-- daily ceiling are both required (Q6).
CREATE FUNCTION app.check_odometer_plausible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev record; nxt record; max_daily_km constant int := 1600;
BEGIN
  SELECT reading_date, odometer_km INTO prev
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date < NEW.reading_date
   ORDER BY reading_date DESC LIMIT 1;

  IF FOUND THEN
    IF NEW.odometer_km < prev.odometer_km THEN
      RAISE EXCEPTION 'odometer went backwards for vehicle % (% km on %, % km on %)',
        NEW.vehicle_id, prev.odometer_km, prev.reading_date, NEW.odometer_km, NEW.reading_date;
    END IF;
    IF (NEW.odometer_km - prev.odometer_km)
       > max_daily_km * GREATEST(1, (NEW.reading_date - prev.reading_date)) THEN
      RAISE EXCEPTION 'implausible distance for vehicle %: % km in % day(s)',
        NEW.vehicle_id, NEW.odometer_km - prev.odometer_km, NEW.reading_date - prev.reading_date;
    END IF;
  END IF;

  SELECT reading_date, odometer_km INTO nxt
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date > NEW.reading_date
   ORDER BY reading_date ASC LIMIT 1;

  IF FOUND AND nxt.odometer_km < NEW.odometer_km THEN
    RAISE EXCEPTION 'odometer reading % km on % exceeds later reading % km on %',
      NEW.odometer_km, NEW.reading_date, nxt.odometer_km, nxt.reading_date;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER odometer_plausibility
BEFORE INSERT OR UPDATE ON app.vehicle_odometer_reading
FOR EACH ROW EXECUTE FUNCTION app.check_odometer_plausible();

-- CHG-026: the boundary between imported history and live capture, so
-- reporting can distinguish them (ADR-0010).
ALTER TABLE app.tenant ADD COLUMN history_horizon date;

-- ---------------------------------------------------------------------------
-- 4. Casing valuation and retread jobs (Q3, CHG-016 / CHG-017 / CHG-018)
--
-- Casing value is event-sourced, not a static attribute. It is set by an
-- external retreader, on a report, at the point of retread. Current value is
-- the latest valuation; history is retained with provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE app.retread_job (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  tyre_id            uuid NOT NULL,
  retreader_depot_id uuid,
  sent_at            date NOT NULL,
  returned_at        date,
  report_reference   text,
  casing_accepted    boolean,
  casing_value       numeric(12,2) CHECK (casing_value >= 0),
  retread_cost       numeric(12,2) CHECK (retread_cost >= 0),
  post_tread_mm      numeric(4,1)  CHECK (post_tread_mm > 0),
  new_pattern_id     uuid,
  -- Feeds spare-pool sizing (CHG-050): the casing is away for this long, so
  -- the fleet must hold enough spares to cover the forecast during it.
  turnaround_days    int GENERATED ALWAYS AS (returned_at - sent_at) STORED,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, tyre_id)            REFERENCES app.tyre (tenant_id, id),
  FOREIGN KEY (tenant_id, retreader_depot_id) REFERENCES app.depot (tenant_id, id),
  FOREIGN KEY (tenant_id, new_pattern_id)     REFERENCES app.tyre_pattern (tenant_id, id),
  CONSTRAINT return_is_complete CHECK (
    returned_at IS NULL OR casing_accepted IS NOT NULL),
  -- A rejected casing is the ONLY legitimate source of a zero casing value.
  CONSTRAINT rejected_casing_has_no_value CHECK (
    casing_accepted IS DISTINCT FROM false OR COALESCE(casing_value, 0) = 0),
  CONSTRAINT returned_after_sent CHECK (returned_at IS NULL OR returned_at >= sent_at)
);
CREATE INDEX retread_job_by_tyre ON app.retread_job (tenant_id, tyre_id, sent_at DESC);

CREATE TABLE app.casing_valuation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  tyre_id         uuid NOT NULL,
  value           numeric(12,2) NOT NULL CHECK (value >= 0),
  source          app.valuation_source NOT NULL,
  retread_job_id  uuid,
  effective_from  date NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid,
  FOREIGN KEY (tenant_id, tyre_id)        REFERENCES app.tyre (tenant_id, id),
  FOREIGN KEY (tenant_id, retread_job_id) REFERENCES app.retread_job (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_id)       REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT retreader_valuation_cites_a_job CHECK (
    source <> 'RETREADER' OR retread_job_id IS NOT NULL)
);
CREATE INDEX casing_valuation_current
  ON app.casing_valuation (tenant_id, tyre_id, effective_from DESC);

COMMENT ON TABLE app.casing_valuation IS
  'CHG-016. Append-only. Current casing value is the latest RETREADER row; an admin estimate is a different kind of number and is never blended with it.';

-- The day-one gap: if value only exists after a retread, a newly onboarded
-- fleet has no value on any never-retreaded casing — roughly half its tyre
-- asset value. An admin may set an estimate per size. It is ALWAYS labelled as
-- an estimate and never blended with a retreader's figure (ADR-0010).
CREATE TABLE app.casing_estimate_by_size (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  size_id         uuid NOT NULL,
  estimated_value numeric(12,2) NOT NULL CHECK (estimated_value >= 0),
  effective_from  date NOT NULL DEFAULT current_date,
  created_by      uuid,
  UNIQUE (tenant_id, size_id, effective_from),
  FOREIGN KEY (tenant_id, size_id)    REFERENCES app.tyre_size (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);

-- CHG-036: a tenant price list gives an estimated purchase cost for tyres that
-- predate the system. Ten to twenty rows covers most fleets — realistic, unlike
-- reconstructing five years of invoices (Q15).
CREATE TABLE app.tyre_price_list (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  size_id        uuid NOT NULL,
  brand_id       uuid,
  typical_price  numeric(12,2) NOT NULL CHECK (typical_price >= 0),
  effective_from date NOT NULL DEFAULT current_date,
  created_by     uuid,
  UNIQUE (tenant_id, size_id, brand_id, effective_from),
  FOREIGN KEY (tenant_id, size_id)    REFERENCES app.tyre_size (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, brand_id)   REFERENCES app.tyre_brand (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- 5. Target pressures (Q12, CHG-034 / CHG-035)
--
-- ADMIN-SET ONLY. A driver who can lower the target can erase the alert, and
-- the control becomes worthless — the same reason the person being measured
-- does not set the pass mark. Drivers record measured values and may raise a
-- query against a target; they cannot change it. (Role enforcement is the
-- API's; the schema keeps the audit trail via created_by.)
--
-- The warn/critical tolerances run in BOTH directions so the five FR-CFG-016
-- bands derive from this one row (CHG-112 retires the inflation_bands key):
-- at the 10/20 defaults the edges sit at 80/90/110/120% of target.
-- ---------------------------------------------------------------------------
CREATE TABLE app.target_pressure (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  size_id             uuid,
  axle_class          app.axle_class,
  target_kpa          int NOT NULL CHECK (target_kpa BETWEEN 100 AND 1200),
  warn_under_pct      numeric(4,1) NOT NULL DEFAULT 10.0 CHECK (warn_under_pct > 0),
  critical_under_pct  numeric(4,1) NOT NULL DEFAULT 20.0 CHECK (critical_under_pct > 0),
  warn_over_pct       numeric(4,1) NOT NULL DEFAULT 10.0 CHECK (warn_over_pct > 0),
  critical_over_pct   numeric(4,1) NOT NULL DEFAULT 20.0 CHECK (critical_over_pct > 0),
  source_note         text,
  effective_from      timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  FOREIGN KEY (tenant_id, size_id)    REFERENCES app.tyre_size (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT critical_is_worse_than_warn CHECK (
    critical_under_pct > warn_under_pct AND critical_over_pct > warn_over_pct)
);
CREATE INDEX target_pressure_lookup
  ON app.target_pressure (tenant_id, size_id, axle_class, effective_from DESC);

ALTER TABLE app.reading
  ADD COLUMN pressure_temperature app.temperature_state NOT NULL DEFAULT 'UNKNOWN';

-- ---------------------------------------------------------------------------
-- 6. Assigned inspections (Q9, CHG-028 / CHG-032 / CHG-033)
--
-- An inspection is ASSIGNED, not merely recorded. A fleet controller sets a
-- recurring interval or issues an ad-hoc instruction; both produce a task.
--
-- OVERDUE therefore means "an issued task was not completed by its due date" —
-- not a rule the software invented. That distinction is what prevents the
-- permanently-red dashboard that trains people to ignore alerts.
-- ---------------------------------------------------------------------------
CREATE TABLE app.inspection_schedule (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  vehicle_id         uuid,
  operating_group_id uuid,
  interval_days      int NOT NULL DEFAULT 7 CHECK (interval_days > 0),
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id)         REFERENCES app.vehicle (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, operating_group_id) REFERENCES app.operating_group (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by)         REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT schedule_targets_exactly_one CHECK (
    (vehicle_id IS NOT NULL) <> (operating_group_id IS NOT NULL))
);

CREATE TABLE app.inspection_task (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  schedule_id             uuid,
  vehicle_id              uuid NOT NULL,
  due_at                  timestamptz NOT NULL,
  assigned_user_id        uuid,
  requested_by            uuid,
  state                   app.task_state NOT NULL DEFAULT 'OPEN',
  completed_inspection_id uuid,
  escalated_at            timestamptz,
  cancelled_reason        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, schedule_id)             REFERENCES app.inspection_schedule (tenant_id, id) ON DELETE SET NULL (schedule_id),
  FOREIGN KEY (tenant_id, vehicle_id)              REFERENCES app.vehicle (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, assigned_user_id)        REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by)            REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_inspection_id) REFERENCES app.inspection (tenant_id, id),
  CONSTRAINT completion_cites_an_inspection CHECK (
    state <> 'COMPLETED' OR completed_inspection_id IS NOT NULL),
  CONSTRAINT cancellation_is_explained CHECK (
    state <> 'CANCELLED' OR cancelled_reason IS NOT NULL)
);
CREATE INDEX task_open_by_due ON app.inspection_task (tenant_id, due_at)
  WHERE state = 'OPEN';

COMMENT ON TABLE app.inspection_task IS
  'CHG-033. Overdue = an issued task past its due date. Never a software-invented rule.';

-- CHG-028 as logic, CHG-033's escalation as logic. Invoker rights: RLS scopes
-- it to the calling tenant, and the scheduler invokes it per tenant exactly as
-- take_valuation_snapshots is invoked. A unit that is not ACTIVE is skipped —
-- PARKED and OUT_OF_SERVICE units are not wearing (Q21) — and a task that
-- resolves no assignee is created ESCALATED, never silently dropped. The
-- resolution here is the trivial link only (the vehicle's own current
-- driver); the coupled-trailer chain is blocked on OI-32 (who owns an
-- uncoupled trailer / fixed-vs-pooled driver assignment).
CREATE FUNCTION app.generate_inspection_tasks(p_as_of date) RETURNS int
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
              AND (t.state IN ('OPEN', 'ESCALATED')
                   OR t.due_at > (p_as_of::timestamp AT TIME ZONE 'UTC') - make_interval(days => s.interval_days)))),
  ins AS (
    INSERT INTO app.inspection_task
      (tenant_id, schedule_id, vehicle_id, due_at, assigned_user_id, state, escalated_at)
    SELECT d.tenant_id, d.schedule_id, d.vehicle_id,
           (p_as_of::timestamp AT TIME ZONE 'UTC') + make_interval(days => d.interval_days),
           drv.user_id,
           CASE WHEN drv.user_id IS NULL THEN 'ESCALATED'::app.task_state ELSE 'OPEN'::app.task_state END,
           CASE WHEN drv.user_id IS NULL THEN now() END
      FROM due d
      LEFT JOIN LATERAL (
           SELECT ca.user_id FROM app.v_current_assignment ca
            WHERE ca.vehicle_id = d.vehicle_id
            ORDER BY ca.from_date DESC, ca.user_id
            LIMIT 1) drv ON true
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;

-- ---------------------------------------------------------------------------
-- 7. ADR-0003 carry-over (CHG-040 / CHG-041)
--
-- Cheap now, impossible or expensive later. Consent cannot be granted
-- retroactively, and reference-data lineage cannot be reconstructed after
-- three years of divergent tenant edits. ADR-0003 itself stays Proposed;
-- these are its named no-regret P1/P2 items (manifest §7.1).
-- ---------------------------------------------------------------------------
CREATE TABLE app.tenant_consent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  purpose_code   text NOT NULL,
  granted        boolean NOT NULL,
  notice_version text NOT NULL,
  actor_id       uuid,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_id) REFERENCES app.app_user (tenant_id, id)
);
CREATE INDEX tenant_consent_current
  ON app.tenant_consent (tenant_id, purpose_code, occurred_at DESC);

ALTER TABLE app.tyre_size    ADD COLUMN platform_catalogue_id uuid;
ALTER TABLE app.tyre_brand   ADD COLUMN platform_catalogue_id uuid;
ALTER TABLE app.tyre_pattern ADD COLUMN platform_catalogue_id uuid;

-- ---------------------------------------------------------------------------
-- 8. Views over the new tables
-- ---------------------------------------------------------------------------

-- CHG-064. A spare has full tread and never wears, so it looks permanently
-- healthy and rises to the top of no tread-ranked report. It needs its own
-- list, and it is judged on AGE, not wear — an old spare that has never been
-- measured is the one that fails when it is finally needed (Q21).
CREATE VIEW app.v_spare_tyre_age WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.display_code,
       f.vehicle_id,
       t.received_date,
       (current_date - t.received_date)                  AS age_days,
       t.last_tread_at,
       (current_date - t.last_tread_at::date)            AS days_since_measured
  FROM app.tyre t
  JOIN app.fitment f ON f.tyre_id = t.id AND f.removed_at IS NULL
  JOIN app.position p ON p.id = f.position_id
 WHERE p.is_spare;

-- CHG-062 / ADR-0010. Cost-per-km coverage is DISCLOSED, never a silent
-- average over whatever vehicles happen to have odometer readings.
CREATE VIEW app.v_distance_coverage WITH (security_invoker = true) AS
SELECT v.tenant_id,
       count(*)                                                        AS vehicles_total,
       count(*) FILTER (WHERE o.readings > 1)                          AS vehicles_with_distance,
       count(*) FILTER (WHERE o.readings IS NULL OR o.readings <= 1)   AS vehicles_without_distance,
       round(100.0 * count(*) FILTER (WHERE o.readings > 1) / NULLIF(count(*), 0), 1)
                                                                       AS coverage_pct
  FROM app.vehicle v
  LEFT JOIN LATERAL (
        SELECT count(*) AS readings FROM app.vehicle_odometer_reading r
         WHERE r.vehicle_id = v.id) o ON true
 WHERE v.status = 'ACTIVE'
 GROUP BY v.tenant_id;

-- CHG-063. Pressure readings exactly equal to target on every wheel indicate
-- the standard is being TRANSCRIBED rather than measured — real gauge readings
-- scatter. Near-zero cost, and it doubles as a check on whether the
-- walk-around is genuinely happening (Q12).
CREATE VIEW app.v_pressure_uniformity_anomaly WITH (security_invoker = true) AS
SELECT r.tenant_id,
       r.inspection_id,
       count(*)                              AS readings_with_pressure,
       count(DISTINCT r.pressure_kpa)        AS distinct_values,
       (count(*) >= 6 AND count(DISTINCT r.pressure_kpa) = 1) AS suspected_transcription
  FROM app.reading r
 WHERE r.pressure_kpa IS NOT NULL
 GROUP BY r.tenant_id, r.inspection_id;

-- CHG-036: a tyre may be received without a price — the brander is not the
-- person who saw the invoice — and waits in an admin queue rather than being
-- silently unpriced forever.
CREATE VIEW app.v_tyre_awaiting_cost WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.display_code,
       t.received_date,
       t.state,
       t.cost_source,
       sz.name AS size_name,
       b.name  AS brand_name
  FROM app.tyre t
  LEFT JOIN app.tyre_size  sz ON sz.id = t.size_id
  LEFT JOIN app.tyre_brand b  ON b.id  = t.brand_id
 WHERE t.purchase_price IS NULL
   AND t.state NOT IN ('SCRAPPED','LOST','SOLD');

-- ---------------------------------------------------------------------------
-- 9. RLS and grants
--
-- Per-table grants on purpose: a blanket GRANT ON ALL TABLES would silently
-- restore UPDATE/DELETE on every append-only table 000001/000002 revoked.
-- SELECT arrives via 000001's default privileges; the rest is explicit.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app.operating_group','app.vehicle_tag','app.vehicle_tag_map',
    'app.threshold_policy','app.vehicle_odometer_reading','app.retread_job',
    'app.casing_valuation','app.casing_estimate_by_size','app.tyre_price_list',
    'app.target_pressure','app.inspection_schedule','app.inspection_task',
    'app.tenant_consent'
  ] LOOP
    CALL app.enable_tenant_rls(t::regclass);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_rw', t);
  END LOOP;
END $$;

-- CR-004 / DR-011: valuations, consents and odometer readings are records of
-- fact. The application cannot rewrite them through its own connection.
REVOKE UPDATE, DELETE ON app.casing_valuation         FROM app_rw;
REVOKE UPDATE, DELETE ON app.tenant_consent           FROM app_rw;
REVOKE UPDATE, DELETE ON app.vehicle_odometer_reading FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON app.jurisdiction_tread_minimum FROM app_rw;
