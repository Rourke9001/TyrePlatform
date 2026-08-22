-- ============================================================================
--  Sponsor-answer column surgery + valuation-core rebuild (TYRE-42)
--  Implements: CFL-001..008, CFL-010, CHG-010..012, CHG-015, CHG-021/022,
--  CHG-025, CHG-027, CHG-029..031, CHG-036/037, CHG-042/044/045, and the
--  CHG-110/CHG-115 rebuild of app.tyre_valuation_asof() and every view over
--  it — manifest v1.1 §3, §4.2, §7.2.
--
--  One migration on purpose: the register function, the views over it and the
--  renamed/dropped columns are interdependent, and PostgreSQL does not protect
--  SQL function bodies from a rename — applied separately, the first reading
--  INSERT after the rename dies inside the snapshot trigger chain. Acceptance
--  for this file: a reading can be recorded and a valuation computed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A. Drop everything the surgery invalidates. Views resolve their columns at
--    creation, so each is recreated in section C against the new shapes; the
--    register function's return type changes, which CREATE OR REPLACE cannot do.
-- ---------------------------------------------------------------------------
DROP FUNCTION app.removal_forecast_within(date, int);
DROP VIEW app.v_removal_forecast;
DROP VIEW app.v_tyre_wear_rate;
DROP VIEW app.v_irregular_wear_ranking;
DROP VIEW app.v_tread_distribution;
DROP VIEW app.v_tread_summary;
DROP VIEW app.v_fitted_tread;
DROP VIEW app.v_estate_valuation;
DROP VIEW app.v_tyre_valuation;
DROP FUNCTION app.tyre_valuation_asof(date);
DROP VIEW app.v_combination_reading;

-- ---------------------------------------------------------------------------
-- B1. Tyre identity (CFL-001 / CHG-021 / CHG-022, ADR-0008)
--
-- BAC brands "licence number + tyre position". When a tyre is scrapped and its
-- replacement is fitted to the same position on the same unit, the code
-- REPEATS. DR-002's global unique constraint rejects that valid insert, and
-- working around it by reusing the row merges two tyres' lifetimes — silently
-- corrupting every cost-per-km figure derived from it. This is not an edge
-- case; it recurs on a schedule set by tyre life.
-- ---------------------------------------------------------------------------
ALTER TABLE app.tyre RENAME COLUMN branded_number TO display_code;
ALTER TABLE app.tyre DROP CONSTRAINT tyre_tenant_id_branded_number_key;
DROP INDEX app.tyre_branded_search;

-- Uniqueness holds only among currently ACTIVE tyres; historical reuse is
-- expected and valid. Enum-literal comparison is immutable, so the negative
-- predicate is index-safe, and SOLD committed in 000010.
CREATE UNIQUE INDEX one_active_display_code_per_tenant
  ON app.tyre (tenant_id, display_code)
  WHERE state NOT IN ('SCRAPPED','LOST','SOLD');

CREATE INDEX tyre_display_code_search
  ON app.tyre (tenant_id, display_code text_pattern_ops);

-- CHG-022: manufacturers should brand tyres and do not (Q5). Tyres found
-- unbranded during onboarding are issued a code and flagged until someone
-- physically burns it on. That is workshop work, not driver work.
ALTER TABLE app.tyre ADD COLUMN brand_pending boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- B2. Casing value is absent, not zero (CFL-002 / CHG-015)
--
-- `NOT NULL DEFAULT 0` asserts that every never-retreaded casing is worth
-- nothing. Roughly half the value of a tyre is its casing, so this silently
-- depresses fleet asset value with no evidence behind it. A true zero may only
-- originate from a retreader REJECTING a casing — a documented scrap event (Q3).
-- ---------------------------------------------------------------------------
ALTER TABLE app.tyre ALTER COLUMN casing_value DROP NOT NULL;
ALTER TABLE app.tyre ALTER COLUMN casing_value DROP DEFAULT;
UPDATE app.tyre SET casing_value = NULL WHERE casing_value = 0;

-- The snapshot cache follows: a snapshot of a tyre whose casing side is
-- unknown must record that, not invent a zero (CHG-115). The generated
-- total_value already yields NULL when either side is NULL.
ALTER TABLE app.valuation_snapshot ALTER COLUMN casing_value DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- B3. Trailer fitments (CFL-003 / CFL-004 / CHG-042 / CHG-044, ADR-0010)
--
-- Trailers have no odometer, and they carry roughly two-thirds of the tyres on
-- a superlink. `fitted_odometer NOT NULL` makes it impossible to record a
-- trailer fitment at all; the generated `distance_run` then yields NULL for
-- every trailer tyre, so cost-per-km silently omits most of the fleet instead
-- of reporting it as unavailable (Q7).
-- ---------------------------------------------------------------------------
ALTER TABLE app.fitment DROP CONSTRAINT odometer_does_not_decrease;
ALTER TABLE app.fitment DROP COLUMN distance_run;
ALTER TABLE app.fitment ALTER COLUMN fitted_odometer DROP NOT NULL;

ALTER TABLE app.fitment
  ADD COLUMN distance_km     bigint CHECK (distance_km >= 0),
  ADD COLUMN distance_source app.distance_provenance NOT NULL DEFAULT 'UNAVAILABLE';

-- Odometer-carried distance is MEASURED; anything else stays UNAVAILABLE until
-- a provenance-aware deriver (hubodometer — OI-31 — or coupling inference,
-- which is INFERRED with unbounded error) writes it.
UPDATE app.fitment
   SET distance_km = removed_odometer - fitted_odometer,
       distance_source = 'MEASURED'
 WHERE removed_odometer IS NOT NULL AND fitted_odometer IS NOT NULL;

-- Retained, but only meaningful where both odometer values exist.
ALTER TABLE app.fitment ADD CONSTRAINT odometer_does_not_decrease
  CHECK (removed_odometer IS NULL OR fitted_odometer IS NULL
         OR removed_odometer >= fitted_odometer);

-- Removal completeness cannot require an odometer — a trailer has none.
ALTER TABLE app.fitment DROP CONSTRAINT removal_is_complete;
ALTER TABLE app.fitment ADD CONSTRAINT removal_is_complete CHECK (
  (removed_at IS NULL AND removal_reason IS NULL)
  OR (removed_at IS NOT NULL AND removal_reason IS NOT NULL));

-- ---------------------------------------------------------------------------
-- B4. Inspection odometer (CFL-005 / CHG-025 / CHG-045)
--
-- The odometer is optional per inspection and belongs to the vehicle timeline
-- (CHG-024, table in 000012). A trailer-only inspection has no odometer to
-- give, and BAC captures readings monthly from fuel records rather than at
-- inspection (Q6/Q8).
-- ---------------------------------------------------------------------------
ALTER TABLE app.inspection ALTER COLUMN odometer DROP NOT NULL;

-- CHG-045: OI-22 (how long onboarding a vehicle takes) is answered by
-- MEASUREMENT rather than assumption. `duration_seconds` already exists and is
-- the instrument; this records whether the walk-around created tyre records,
-- which is what makes it an onboarding pass (Q14, CHG-058).
ALTER TABLE app.inspection ADD COLUMN tyres_created int NOT NULL DEFAULT 0
  CHECK (tyres_created >= 0);

-- ---------------------------------------------------------------------------
-- B5. Combination numbering is computed, never stored (CFL-006 / CFL-008 /
--     CHG-029, ADR-0007)
--
-- The 1..26 numbering is a display projection of the composition on the day;
-- storing it freezes a mapping that is only correct for one composition, and
-- trailers move between horses. Configurations describe UNITS, so a
-- combination has no axle configuration of its own — its shape is derived
-- from its members.
-- ---------------------------------------------------------------------------
DROP TABLE app.combination_position_map;
ALTER TABLE app.combination DROP COLUMN configuration_id;

-- ---------------------------------------------------------------------------
-- B6. Canonical tread positions (CFL-007 / CHG-010 / CHG-011 / CHG-012)
-- ---------------------------------------------------------------------------
ALTER TABLE app.reading_measurement
  ADD COLUMN position          app.tread_position,
  ADD COLUMN orientation_known boolean NOT NULL DEFAULT true,
  ADD COLUMN granularity_mm    numeric(3,2) NOT NULL DEFAULT 1.0
    CHECK (granularity_mm IN (1.0, 0.5, 0.1));

-- Existing rows predate the canonical convention (OI-28 was open when they
-- were captured), so their orientation is unrecoverable: they keep counting
-- toward minimum and average tread but are excluded from directional
-- wear-pattern diagnosis, because a diagnosis from unknown orientation is
-- invented (Q1, ADR-0010).
UPDATE app.reading_measurement
   SET position = CASE WHEN ordinal = 1 THEN 'OUTER'::app.tread_position
                       WHEN ordinal = 2 THEN 'CENTRE'::app.tread_position
                       ELSE 'INNER'::app.tread_position END,
       orientation_known = false
 WHERE position IS NULL;

-- The backfill queued the deferred ordinal-contiguity trigger; a pending
-- trigger event blocks every ALTER TABLE below, so flush it first.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE app.reading_measurement ALTER COLUMN position SET NOT NULL;
ALTER TABLE app.reading_measurement DROP COLUMN label;

-- ---------------------------------------------------------------------------
-- B7. Evidential status (CFL-008 / CHG-039)
--
-- "Proposed" implied someone had proposed a configuration. Nobody had — they
-- were assumed from what is common on South African roads. BAC confirmed it
-- runs only what its own sheets show (Q23). Zero schema dependents, so the
-- type swap is clean.
-- ---------------------------------------------------------------------------
CREATE TYPE app.evidential_status_v2 AS ENUM ('CONFIRMED','UNVERIFIED');
ALTER TABLE app.axle_configuration
  ALTER COLUMN evidential_status DROP DEFAULT,
  ALTER COLUMN evidential_status TYPE app.evidential_status_v2
    USING (CASE WHEN evidential_status = 'CONFIRMED' THEN 'CONFIRMED'
                ELSE 'UNVERIFIED' END)::app.evidential_status_v2,
  ALTER COLUMN evidential_status SET DEFAULT 'UNVERIFIED';
DROP TYPE app.evidential_status;
ALTER TYPE app.evidential_status_v2 RENAME TO evidential_status;

-- ---------------------------------------------------------------------------
-- B8. Unit model columns (CHG-027 / CHG-030 / CHG-031, ADR-0007)
-- ---------------------------------------------------------------------------
ALTER TABLE app.vehicle  ADD COLUMN unit_kind app.unit_kind;
ALTER TABLE app.position ADD COLUMN axle_type app.axle_type NOT NULL DEFAULT 'FIXED';

-- CHG-027 backfill (§7.2 erratum: NOT left NULL). Derived from the
-- configuration-code convention, then the fleet-number convention; a vehicle
-- neither resolves is left NULL and reported by the migration log below.
UPDATE app.vehicle v
   SET unit_kind = COALESCE(
       (SELECT CASE WHEN c.code LIKE 'HORSE%' OR c.code = 'BAC_TRUCKS' THEN 'HORSE'
                    WHEN c.code LIKE 'TRAILER%' OR c.code LIKE 'DRAWBAR%' THEN 'TRAILER'
                    WHEN c.code LIKE 'RIGID%' THEN 'RIGID'
                    WHEN c.code LIKE 'LIGHT%' THEN 'LIGHT' END::app.unit_kind
          FROM app.axle_configuration c WHERE c.id = v.configuration_id),
       CASE WHEN v.fleet_number ILIKE 'HORSE%' THEN 'HORSE'
            WHEN v.fleet_number ILIKE 'LINK%'  THEN 'TRAILER' END::app.unit_kind)
 WHERE v.unit_kind IS NULL;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM app.vehicle WHERE unit_kind IS NULL;
  IF n > 0 THEN
    RAISE WARNING 'CHG-027: % vehicle(s) with underivable unit_kind left NULL', n;
  END IF;
END $$;

-- Spares are per unit and VARIABLE in number. The sponsor could not say how
-- many a rig carries, only that "it's never just one" — and there is no South
-- African legal requirement to carry a spare at all, so the count is pure
-- operational practice. The configuration supplies a default; the real number
-- is whatever inspections find. A unit presenting two spares records two (Q23).
ALTER TABLE app.position ADD COLUMN spare_ordinal int CHECK (spare_ordinal >= 1);
ALTER TABLE app.axle_configuration ADD COLUMN default_spare_count int NOT NULL DEFAULT 1
  CHECK (default_spare_count >= 0);

-- ---------------------------------------------------------------------------
-- B9. Cost provenance replaces silent exclusion (CFL-010 / CHG-036 / CHG-037,
--     ADR-0010)
--
-- Purchase prices do not exist for any tyre already in the fleet. As written,
-- `valuation_complete` marks essentially the whole pilot fleet incomplete and
-- excludes it from every total with no explanation (Q15). The register (below)
-- computes the row's valuation basis; no generated column, so there is exactly
-- one implementation of "how is this tyre valued".
-- ---------------------------------------------------------------------------
ALTER TABLE app.tyre DROP COLUMN valuation_complete;
ALTER TABLE app.tyre ADD COLUMN cost_source app.cost_source NOT NULL DEFAULT 'UNKNOWN';
UPDATE app.tyre SET cost_source = 'INVOICE' WHERE purchase_price IS NOT NULL;

-- CHG-023 (partial): receipt is the point a tyre becomes trackable and where
-- purchase cost enters (Q5, Q15). The dated branding-event workflow rides on
-- tyre_event and is ticketed separately.
ALTER TABLE app.tyre ADD COLUMN received_date date;
UPDATE app.tyre SET received_date = purchase_date WHERE received_date IS NULL;

-- CHG-037: SOLD is a disposal carrying proceeds — a real market valuation of
-- a used casing (Q19). Money is a typed column, never a jsonb payload number.
ALTER TABLE app.tyre_event ADD COLUMN proceeds numeric(12,2) CHECK (proceeds >= 0);

-- ---------------------------------------------------------------------------
-- C. Rebuild the valuation core (CHG-110 / CHG-115) and the views over it.
-- ---------------------------------------------------------------------------

-- v_reading_detail gains the orientation provenance flag so wear-pattern
-- consumers can distinguish convention-known captures (CHG-011). Appended,
-- so existing consumers are untouched.
CREATE OR REPLACE VIEW app.v_reading_detail WITH (security_invoker = true) AS
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
       r.note,
       (SELECT bool_and(m.orientation_known)
          FROM app.reading_measurement m WHERE m.reading_id = r.id) AS orientation_known
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
  JOIN app.vehicle    v ON v.id = r.vehicle_id
  JOIN app.position   p ON p.id = r.position_id
 WHERE i.state <> 'VOIDED';

-- The register as at any date (FR-VAL-020), re-shaped per CHG-115: every tyre
-- is INCLUDED and LABELLED — valuation_basis ACTUAL / ESTIMATED / UNVALUED
-- from cost provenance, never a silent exclusion, never a zero fill. The
-- audit fallback (tyre.last_tread_mm) is date-blind: an onboarding value
-- carries no timestamp, so it stands in at any date (FR-TYR-030..034).
-- Casing basis here is AUDIT (the onboarding figure) or UNVALUED; 000013
-- upgrades the resolution to the event-sourced casing_valuation chain once
-- those tables exist. total_value is tread + casing with SQL NULL semantics:
-- a half-known total is presented as unknown, with each side and its basis
-- alongside — the CHG-062 rule that a blended figure is never unlabelled.
CREATE FUNCTION app.tyre_valuation_asof(p_as_at date)
RETURNS TABLE (tenant_id uuid, tyre_id uuid, display_code text, size_name text,
               brand_name text, pattern_name text, status app.tyre_status,
               retread_count int, state app.tyre_state, vehicle_id uuid,
               fleet_number text, position_code text, depot_id uuid, depot_name text,
               current_tread_mm numeric, tread_source text, read_at timestamptz,
               rand_per_mm numeric, removal_threshold_mm numeric,
               cost_source app.cost_source, valuation_basis text,
               tread_value numeric, casing_value numeric, casing_basis text,
               total_value numeric, stale boolean)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id,
         t.id,
         t.display_code,
         sz.name,
         b.name,
         pt.name,
         t.status,
         t.retread_count,
         t.state,
         f.vehicle_id,
         v.fleet_number,
         pos.code,
         COALESCE(v.home_depot_id, t.current_depot_id),
         d.name,
         COALESCE(lr.governing_tread_mm, t.last_tread_mm),
         CASE WHEN lr.governing_tread_mm IS NOT NULL THEN 'READING'
              WHEN t.last_tread_mm       IS NOT NULL THEN 'AUDIT' END,
         lr.submitted_at,
         t.rand_per_mm,
         thr.mm,
         t.cost_source,
         CASE WHEN tv.val IS NULL THEN 'UNVALUED'
              WHEN t.cost_source = 'INVOICE' THEN 'ACTUAL'
              ELSE 'ESTIMATED' END,
         tv.val,
         t.casing_value,
         CASE WHEN t.casing_value IS NOT NULL THEN 'AUDIT' ELSE 'UNVALUED' END,
         tv.val + t.casing_value,
         -- FR-VAL-021: value from an old reading, but say so. NULL when no
         -- reading or no configured staleness policy — unknown, not fresh.
         CASE WHEN lr.submitted_at IS NOT NULL AND st.days IS NOT NULL
              THEN (p_as_at - (lr.submitted_at AT TIME ZONE 'UTC')::date) > st.days END
    FROM app.tyre t
    CROSS JOIN LATERAL (SELECT ((p_as_at + 1)::timestamp AT TIME ZONE 'UTC') AS ts) bound
    CROSS JOIN LATERAL (SELECT app.removal_threshold_mm_for(t.tenant_id, bound.ts) AS mm) thr
    LEFT JOIN LATERAL (
         SELECT (c.value #>> '{}')::int AS days
           FROM app.configuration c
          WHERE c.tenant_id = t.tenant_id
            AND c.key = 'reading_staleness_days'
            AND c.effective_from < bound.ts
          ORDER BY c.effective_from DESC
          LIMIT 1) st ON true
    LEFT JOIN app.tyre_size    sz ON sz.id = t.size_id
    LEFT JOIN app.tyre_brand   b  ON b.id  = t.brand_id
    LEFT JOIN app.tyre_pattern pt ON pt.id = t.pattern_id
    LEFT JOIN app.fitment f ON f.tyre_id = t.id AND f.fitted_at < bound.ts
                           AND (f.removed_at IS NULL OR f.removed_at >= bound.ts)
    LEFT JOIN app.vehicle  v   ON v.id   = f.vehicle_id
    LEFT JOIN app.position pos ON pos.id = f.position_id
    LEFT JOIN app.depot    d   ON d.id   = COALESCE(v.home_depot_id, t.current_depot_id)
    LEFT JOIN LATERAL (
         SELECT r.governing_tread_mm, i.submitted_at
           FROM app.reading r
           JOIN app.inspection i ON i.id = r.inspection_id
          WHERE r.tyre_id = t.id
            AND i.state <> 'VOIDED'
            AND r.governing_tread_mm IS NOT NULL
            AND i.submitted_at < bound.ts
          ORDER BY i.submitted_at DESC
          LIMIT 1) lr ON true
    -- one place computes the tread side: rate, policy and a depth must all
    -- exist, whatever the cost provenance — no configured policy means
    -- unvalued, never a silently zero-priced estate (GREATEST(0, NULL) is 0)
    CROSS JOIN LATERAL (
         SELECT CASE WHEN t.rand_per_mm IS NOT NULL AND thr.mm IS NOT NULL
                      AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
                     THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                          thr.mm, t.rand_per_mm) END AS val) tv
$$;

-- The live register is the today-slice of the same implementation. Casts
-- restate the column types 000005 declared: CREATE OR REPLACE VIEW demands
-- exact types, and a function result column carries no typmod.
CREATE VIEW app.v_tyre_valuation WITH (security_invoker = true) AS
SELECT tenant_id, tyre_id, display_code, size_name, brand_name, pattern_name,
       status, retread_count, state, vehicle_id, fleet_number, position_code,
       depot_id, depot_name,
       current_tread_mm::numeric(4,1) AS current_tread_mm,
       tread_source, read_at,
       rand_per_mm::numeric(12,4) AS rand_per_mm,
       removal_threshold_mm, cost_source, valuation_basis, tread_value,
       casing_value::numeric(12,2) AS casing_value,
       casing_basis, total_value
  FROM app.tyre_valuation_asof((now() AT TIME ZONE 'UTC')::date);

-- Estate aggregation (FR-VAL-010/011/012), coverage disclosed on every
-- aggregate per CHG-115: how many rows are ACTUAL, ESTIMATED, tread-unvalued
-- and casing-unvalued rides with every total, so no silent blend exists.
-- SOLD joins SCRAPPED and LOST outside the estate: a sold tyre's value has
-- left the fleet, with proceeds recorded on its disposal event (CHG-037).
-- Total semantics: tread over valued tyres plus casing over casing-valued
-- tyres — each side sums what is known and the counts say what is not.
CREATE VIEW app.v_estate_valuation WITH (security_invoker = true) AS
SELECT tenant_id,
       CASE WHEN GROUPING(fleet_number) = 0 THEN 'VEHICLE'
            WHEN GROUPING(depot_name)   = 0 THEN 'DEPOT'
            WHEN GROUPING(size_name)    = 0 THEN 'SIZE'
            WHEN GROUPING(brand_name)   = 0 THEN 'BRAND'
            WHEN GROUPING(pattern_name) = 0 THEN 'PATTERN'
            ELSE 'TENANT' END AS level,
       COALESCE(fleet_number, depot_name, size_name, brand_name, pattern_name) AS key_name,
       CASE WHEN GROUPING(state) = 1 THEN 'ALL' ELSE state::text END AS location_class,
       count(*)                                            AS tyre_count,
       count(*) FILTER (WHERE valuation_basis = 'ACTUAL')    AS actual_count,
       count(*) FILTER (WHERE valuation_basis = 'ESTIMATED') AS estimated_count,
       count(*) FILTER (WHERE tread_value IS NULL)           AS unvalued_count,
       count(*) FILTER (WHERE casing_value IS NULL)          AS casing_unvalued_count,
       sum(tread_value)                                    AS tread_value,
       sum(casing_value)                                   AS casing_value,
       COALESCE(sum(tread_value), 0) + COALESCE(sum(casing_value), 0) AS total_value
  FROM app.v_tyre_valuation
 WHERE state NOT IN ('SCRAPPED', 'LOST', 'SOLD')
 GROUP BY tenant_id,
          GROUPING SETS ((fleet_number), (depot_name), (size_name),
                         (brand_name), (pattern_name), ()),
          ROLLUP(state);

-- The fitted estate with each tyre's current governing depth (000007's
-- definition). The emitted column is display_code: no view may present a
-- column named branded_number (CHG-110).
CREATE VIEW app.v_fitted_tread WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.display_code,
       t.status,
       v.id   AS vehicle_id,
       v.fleet_number,
       d.id   AS depot_id,
       d.name AS depot_name,
       pos.code AS position_code,
       pos.is_spare,
       lr.governing_tread_mm AS current_tread_mm,
       lr.submitted_at       AS read_at
  FROM app.tyre t
  JOIN app.fitment f   ON f.tyre_id = t.id AND f.removed_at IS NULL
  JOIN app.vehicle v   ON v.id = f.vehicle_id
  JOIN app.position pos ON pos.id = f.position_id
  LEFT JOIN app.depot d ON d.id = v.home_depot_id
  LEFT JOIN LATERAL (
       SELECT r.governing_tread_mm, i.submitted_at
         FROM app.reading r
         JOIN app.inspection i ON i.id = r.inspection_id
        WHERE r.tyre_id = t.id
          AND i.state <> 'VOIDED'
          AND r.governing_tread_mm IS NOT NULL
        ORDER BY i.submitted_at DESC
        LIMIT 1) lr ON true;

-- FR-ANL-023: average governing depth by tenant, depot and vehicle.
-- position_class is the FR-RPT-005 disclosure, not a filter — 'ALL' is the
-- rollup BR-RPT-001 makes the default for composition reporting.
CREATE VIEW app.v_tread_summary WITH (security_invoker = true) AS
SELECT tenant_id,
       CASE WHEN GROUPING(fleet_number) = 0 THEN 'VEHICLE'
            WHEN GROUPING(depot_name)   = 0 THEN 'DEPOT'
            ELSE 'TENANT' END AS level,
       COALESCE(fleet_number, depot_name) AS key_name,
       CASE WHEN GROUPING(is_spare) = 1 THEN 'ALL'
            WHEN is_spare THEN 'SPARE' ELSE 'RUNNING' END AS position_class,
       count(*)::int                  AS tyre_count,
       sum(current_tread_mm)          AS total_tread_mm,
       round(avg(current_tread_mm), 2) AS avg_tread_mm
  FROM app.v_fitted_tread
 WHERE current_tread_mm IS NOT NULL
 GROUP BY tenant_id,
          GROUPING SETS ((fleet_number), (depot_name), ()),
          ROLLUP(is_spare);

-- FR-ANL-024. Built on the summary so the denominator of every percentage is
-- the same population the averages describe, and left-joined off the band
-- list so an empty band still reports as zero rather than disappearing —
-- a missing row and a zero row read identically on a chart and only one of
-- them is true (FR-CFG-031, BR-RPT-002).
CREATE VIEW app.v_tread_distribution WITH (security_invoker = true) AS
WITH counted AS (
  SELECT f.tenant_id,
         CASE WHEN GROUPING(f.fleet_number) = 0 THEN 'VEHICLE'
              WHEN GROUPING(f.depot_name)   = 0 THEN 'DEPOT'
              ELSE 'TENANT' END AS level,
         COALESCE(f.fleet_number, f.depot_name) AS key_name,
         CASE WHEN GROUPING(f.is_spare) = 1 THEN 'ALL'
              WHEN f.is_spare THEN 'SPARE' ELSE 'RUNNING' END AS position_class,
         bnd.ordinal AS band_ordinal,
         count(*)::int AS tyre_count
    FROM app.v_fitted_tread f
    CROSS JOIN LATERAL app.tread_band_list(
         app.config_for(f.tenant_id, 'tread_bands',
                        ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')) bnd
   WHERE f.current_tread_mm IS NOT NULL
     AND f.current_tread_mm >= bnd.lower_mm
     AND (bnd.upper_exclusive_mm IS NULL OR f.current_tread_mm < bnd.upper_exclusive_mm)
   GROUP BY f.tenant_id,
            GROUPING SETS ((f.fleet_number), (f.depot_name), ()),
            ROLLUP(f.is_spare),
            bnd.ordinal)
SELECT s.tenant_id,
       s.level,
       s.key_name,
       s.position_class,
       bnd.ordinal AS band_ordinal,
       bnd.label   AS band_label,
       bnd.lower_mm,
       bnd.upper_exclusive_mm,
       COALESCE(c.tyre_count, 0) AS tyre_count,
       round(COALESCE(c.tyre_count, 0) * 100.0 / s.tyre_count, 2) AS pct_of_group
  FROM app.v_tread_summary s
  CROSS JOIN LATERAL app.tread_band_list(
       app.config_for(s.tenant_id, 'tread_bands',
                      ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC')) bnd
  LEFT JOIN counted c
         ON c.tenant_id = s.tenant_id
        AND c.level = s.level
        AND c.key_name IS NOT DISTINCT FROM s.key_name
        AND c.position_class = s.position_class
        AND c.band_ordinal = bnd.ordinal;

-- FR-ANL-027 / BR-ANL-007. The spread is a property of one inspection, not of
-- the tyre's average condition, so each tyre contributes its most recent
-- reading only. rank() leaves genuine ties sharing a rank; callers wanting a
-- stable print order add display_code, unique among active tyres.
--
-- Width spread is orientation-AGNOSTIC — max minus min over the grooves is
-- the same set whichever groove is outer — so rows with orientation_known =
-- false stay ranked (CHG-011 excludes them only from DIRECTIONAL diagnosis).
-- The flag rides along so a consumer attributing the spread to a shoulder
-- knows when it may not.
CREATE VIEW app.v_irregular_wear_ranking WITH (security_invoker = true) AS
SELECT f.tenant_id,
       f.tyre_id,
       f.display_code,
       f.vehicle_id,
       f.fleet_number,
       f.position_code,
       f.is_spare,
       lr.inspection_id,
       lr.submitted_at,
       lr.width_spread_mm,
       lr.measurements,
       lr.orientation_known,
       rank() OVER (PARTITION BY f.tenant_id ORDER BY lr.width_spread_mm DESC)::int AS rank
  FROM app.v_fitted_tread f
  JOIN LATERAL (
       SELECT rd.inspection_id, rd.submitted_at, rd.width_spread_mm,
              rd.measurements, rd.orientation_known
         FROM app.v_reading_detail rd
        WHERE rd.tyre_id = f.tyre_id
        ORDER BY rd.submitted_at DESC
        LIMIT 1) lr ON true
 WHERE lr.width_spread_mm IS NOT NULL;

-- FR-ANL-001/002/003 over BR-ANL-001: the odometer-based rate (000009's
-- definition, display_code shape). Retained per CFL-009 as the sibling of the
-- regression rate 000013 folds into the forecast surface.
CREATE VIEW app.v_tyre_wear_rate WITH (security_invoker = true) AS
SELECT ft.tenant_id,
       ft.tyre_id,
       ft.display_code,
       ft.vehicle_id,
       ft.fleet_number,
       ft.depot_name,
       ft.position_code,
       ft.is_spare,
       lr.submitted_at        AS later_read_at,
       lr.odometer            AS later_odometer,
       lr.governing_tread_mm  AS later_tread_mm,
       er.submitted_at        AS earlier_read_at,
       er.odometer            AS earlier_odometer,
       er.governing_tread_mm  AS earlier_tread_mm,
       (lr.odometer - er.odometer) AS distance_km,
       ((lr.submitted_at AT TIME ZONE 'UTC')::date
        - (er.submitted_at AT TIME ZONE 'UTC')::date) AS days_between,
       cfg.min_km AS min_distance_km,
       CASE WHEN er.odometer IS NOT NULL AND NOT fit.moved
            THEN app.wear_rate_mm_per_1000km(er.governing_tread_mm, lr.governing_tread_mm,
                                             er.odometer, lr.odometer) END
         AS wear_rate_mm_per_1000km,
       CASE WHEN cfg.min_km IS NULL          THEN 'NO_MIN_DISTANCE_POLICY'
            WHEN prev.odometer IS NULL       THEN 'INSUFFICIENT_READINGS'
            WHEN er.odometer IS NULL         THEN 'BELOW_MIN_DISTANCE'
            WHEN fit.moved                   THEN 'FITMENT_BETWEEN'
            ELSE 'MEASURED' END AS wear_rate_status
  FROM app.v_fitted_tread ft
  LEFT JOIN LATERAL (
       SELECT ro.governing_tread_mm, ro.submitted_at, ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
        ORDER BY ro.submitted_at DESC
        LIMIT 1) lr ON true
  LEFT JOIN LATERAL (
       SELECT (c.value #>> '{}')::bigint AS min_km
         FROM app.configuration c
        WHERE c.tenant_id = ft.tenant_id
          AND c.key = 'wear_rate_min_distance_km'
          AND c.effective_from < ((now() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'
        ORDER BY c.effective_from DESC
        LIMIT 1) cfg ON true
  -- any earlier reading at all: what separates "inspect again" from "drive
  -- further", which is the difference between the first two BR-ANL-004 cases
  LEFT JOIN LATERAL (
       SELECT ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
          AND ro.submitted_at < lr.submitted_at
        ORDER BY ro.submitted_at DESC
        LIMIT 1) prev ON true
  LEFT JOIN LATERAL (
       SELECT ro.governing_tread_mm, ro.submitted_at, ro.odometer
         FROM app.v_tyre_reading_odometer ro
        WHERE ro.tyre_id = ft.tyre_id
          AND ro.submitted_at < lr.submitted_at
          AND ro.odometer <= lr.odometer - cfg.min_km
        ORDER BY ro.submitted_at DESC
        LIMIT 1) er ON true
  -- BR-ANL-004: a tyre fitted or removed inside the window was on a different
  -- position for part of it, so the two depths are not one wear history.
  CROSS JOIN LATERAL (
       SELECT EXISTS (SELECT 1 FROM app.fitment f
                       WHERE f.tyre_id = ft.tyre_id
                         AND ((f.fitted_at  > er.submitted_at AND f.fitted_at  <= lr.submitted_at)
                           OR (f.removed_at > er.submitted_at AND f.removed_at <= lr.submitted_at)))
         AS moved) fit;

-- CFL-006 replacement. The combination projection is COMPUTED, not stored:
-- position number = the running count across member units in sequence order,
-- correct for whatever the composition is on the day it is rendered.
CREATE VIEW app.v_combination_reading WITH (security_invoker = true) AS
SELECT d.tenant_id,
       d.inspection_id,
       cm.sequence AS member_sequence,
       row_number() OVER (PARTITION BY d.inspection_id
                          ORDER BY cm.sequence, d.sequence) AS combination_position,
       d.vehicle_id,
       d.fleet_number,
       d.unit_label,
       d.position_code AS unit_own_code,
       d.axle_number, d.axle_class, d.side, d.slot, d.is_spare,
       d.governing_tread_mm, d.width_spread_mm, d.measurements, d.pressure_kpa
  FROM app.v_reading_detail d
  JOIN app.inspection i          ON i.id = d.inspection_id
  JOIN app.combination cb        ON cb.id = i.combination_id
  JOIN app.combination_member cm ON cm.combination_id = cb.id AND cm.vehicle_id = d.vehicle_id
 WHERE NOT d.is_spare;

-- FR-ANL-004/005 point-projection surface, carried over from 000009 in
-- display_code shape; 000013 replaces it with the consolidated range forecast
-- (CHG-113) in the same migration that adds the regression rate — the two
-- forecast families never coexist past that file.
CREATE VIEW app.v_removal_forecast WITH (security_invoker = true) AS
SELECT wr.tenant_id,
       wr.tyre_id,
       wr.display_code,
       wr.vehicle_id,
       wr.fleet_number,
       wr.depot_name,
       wr.position_code,
       wr.is_spare,
       wr.later_tread_mm AS current_tread_mm,
       wr.later_read_at,
       thr.mm AS removal_threshold_mm,
       wr.wear_rate_mm_per_1000km,
       wr.wear_rate_status,
       dd.mean_daily_km,
       proj.remaining_km AS projected_remaining_km,
       CASE WHEN proj.remaining_km = 0 THEN 0
            ELSE floor(proj.remaining_km / NULLIF(dd.mean_daily_km, 0))::int
       END AS projected_remaining_days,
       ((wr.later_read_at AT TIME ZONE 'UTC')::date
        + CASE WHEN proj.remaining_km = 0 THEN 0
               ELSE floor(proj.remaining_km / NULLIF(dd.mean_daily_km, 0))::int
          END) AS projected_removal_date,
       (wr.later_odometer + proj.remaining_km)::bigint AS projected_removal_odometer,
       CASE WHEN thr.mm IS NULL                     THEN 'NO_THRESHOLD_POLICY'
            WHEN wr.later_tread_mm IS NULL          THEN wr.wear_rate_status
            WHEN wr.later_tread_mm <= thr.mm        THEN 'AT_OR_BELOW_THRESHOLD'
            WHEN wr.wear_rate_mm_per_1000km IS NULL THEN wr.wear_rate_status
            WHEN wr.wear_rate_mm_per_1000km <= 0    THEN 'NO_MEASURABLE_WEAR'
            ELSE 'FORECAST' END AS forecast_status
  FROM app.v_tyre_wear_rate wr
  CROSS JOIN LATERAL (SELECT app.removal_threshold_mm_for(wr.tenant_id, now()) AS mm) thr
  LEFT JOIN LATERAL (
       SELECT round((max(x.odometer) - min(x.odometer))::numeric
                  / NULLIF((max(x.submitted_at) AT TIME ZONE 'UTC')::date
                         - (min(x.submitted_at) AT TIME ZONE 'UTC')::date, 0), 2)
                AS mean_daily_km
         FROM (SELECT DISTINCT i.id, i.odometer, i.submitted_at
                 FROM app.reading r
                 JOIN app.inspection i ON i.id = r.inspection_id
                WHERE r.vehicle_id = wr.vehicle_id
                  AND i.state <> 'VOIDED'
                  AND i.submitted_at <= wr.later_read_at
                  AND i.submitted_at > wr.later_read_at - interval '90 days') x) dd ON true
  CROSS JOIN LATERAL (
       SELECT CASE WHEN thr.mm IS NULL OR wr.later_tread_mm IS NULL THEN NULL
                   WHEN wr.later_tread_mm <= thr.mm THEN 0::numeric
                   WHEN wr.wear_rate_mm_per_1000km > 0
                   THEN floor((wr.later_tread_mm - thr.mm) / wr.wear_rate_mm_per_1000km * 1000)
              END AS remaining_km) proj;

-- FR-ANL-007, the data layer for FR-RPT-028 (000009 definition, unchanged).
CREATE FUNCTION app.removal_forecast_within(p_from date, p_horizon_days int)
RETURNS SETOF app.v_removal_forecast
LANGUAGE sql STABLE AS $$
  SELECT * FROM app.v_removal_forecast
   WHERE projected_removal_date IS NOT NULL
     AND projected_removal_date <= p_from + p_horizon_days
$$;

COMMENT ON COLUMN app.tyre.display_code IS
  'CHG-021 / ADR-0008. Tenant-branded, no format imposed. NOT an identity: unique only among active tyres, because position-derived codes are reused when a position is re-tyred.';
COMMENT ON COLUMN app.reading_measurement.orientation_known IS
  'CHG-011. FALSE for captures that predate the canonical outer/centre/inner convention. Such rows count toward min/average tread but are excluded from directional wear-pattern diagnosis.';
