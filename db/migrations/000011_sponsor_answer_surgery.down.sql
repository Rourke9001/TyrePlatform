-- Reverses 000011: restores the 000009-era shapes and the pre-recut view and
-- function bodies verbatim. Data limits of the reversal, stated rather than
-- hidden: casing values NULLed from zero return to 0.00 (the old NOT NULL
-- demands a value and zero was the old encoding of "unknown");
-- combination_position_map and combination.configuration_id come back as
-- structures only — `make db-reset` owns re-seeding their rows.

DROP FUNCTION app.removal_forecast_within(date, int);
DROP VIEW app.v_removal_forecast;
DROP VIEW app.v_combination_reading;
DROP VIEW app.v_tyre_wear_rate;
DROP VIEW app.v_irregular_wear_ranking;
DROP VIEW app.v_tread_distribution;
DROP VIEW app.v_tread_summary;
DROP VIEW app.v_fitted_tread;
DROP VIEW app.v_estate_valuation;
DROP VIEW app.v_tyre_valuation;
DROP FUNCTION app.tyre_valuation_asof(date);
DROP VIEW app.v_dual_mate_ranking;
DROP VIEW app.v_axle_side_divergence;
DROP VIEW app.v_dual_mate_difference;
DROP VIEW app.v_reading_detail;

-- B9 reversal
ALTER TABLE app.tyre_event DROP COLUMN proceeds;
ALTER TABLE app.tyre DROP COLUMN received_date;
ALTER TABLE app.tyre DROP COLUMN cost_source;
ALTER TABLE app.tyre ADD COLUMN valuation_complete boolean GENERATED ALWAYS AS
  (purchase_price IS NOT NULL AND new_tread_mm IS NOT NULL AND rand_per_mm IS NOT NULL) STORED;

-- B8 reversal
ALTER TABLE app.axle_configuration DROP COLUMN default_spare_count;
ALTER TABLE app.position DROP COLUMN spare_ordinal;
ALTER TABLE app.position DROP COLUMN axle_type;
ALTER TABLE app.vehicle DROP COLUMN unit_kind;

-- B7 reversal
CREATE TYPE app.evidential_status_v1 AS ENUM ('CONFIRMED','PROPOSED','VARIANT');
ALTER TABLE app.axle_configuration
  ALTER COLUMN evidential_status DROP DEFAULT,
  ALTER COLUMN evidential_status TYPE app.evidential_status_v1
    -- UNVERIFIED folds back to the old default; the PROPOSED/VARIANT split
    -- cannot be reconstructed from the collapsed vocabulary
    USING (CASE WHEN evidential_status::text = 'CONFIRMED' THEN 'CONFIRMED'
                ELSE 'PROPOSED' END)::app.evidential_status_v1,
  ALTER COLUMN evidential_status SET DEFAULT 'PROPOSED';
DROP TYPE app.evidential_status;
ALTER TYPE app.evidential_status_v1 RENAME TO evidential_status;

-- B6 reversal: the free-text label returns, rebuilt from the canonical enum.
ALTER TABLE app.reading_measurement ADD COLUMN label text;
UPDATE app.reading_measurement SET label = position::text;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE app.reading_measurement DROP COLUMN granularity_mm;
ALTER TABLE app.reading_measurement DROP COLUMN orientation_known;
ALTER TABLE app.reading_measurement DROP COLUMN position;

-- B5 reversal (structures only; seeds repopulate)
ALTER TABLE app.combination ADD COLUMN configuration_id uuid;
ALTER TABLE app.combination
  ADD CONSTRAINT combination_configuration_id_fkey
  FOREIGN KEY (tenant_id, configuration_id) REFERENCES app.axle_configuration (tenant_id, id);
CREATE TABLE app.combination_position_map (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  configuration_id      uuid NOT NULL,
  combination_code      text NOT NULL,
  member_sequence       int  NOT NULL,
  member_position_code  text NOT NULL,
  UNIQUE (configuration_id, combination_code),
  CONSTRAINT combination_position_map_configuration_id_fkey
    FOREIGN KEY (tenant_id, configuration_id) REFERENCES app.axle_configuration (tenant_id, id) ON DELETE CASCADE
);
CALL app.enable_tenant_rls('app.combination_position_map'::regclass);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.combination_position_map TO app_rw;

-- B4 reversal
ALTER TABLE app.inspection DROP COLUMN tyres_created;
UPDATE app.inspection SET odometer = 0 WHERE odometer IS NULL;
ALTER TABLE app.inspection ALTER COLUMN odometer SET NOT NULL;

-- B3 reversal
ALTER TABLE app.fitment DROP CONSTRAINT removal_is_complete;
ALTER TABLE app.fitment DROP CONSTRAINT odometer_does_not_decrease;
ALTER TABLE app.fitment DROP COLUMN distance_source;
ALTER TABLE app.fitment DROP COLUMN distance_km;
UPDATE app.fitment SET fitted_odometer = 0 WHERE fitted_odometer IS NULL;
ALTER TABLE app.fitment ALTER COLUMN fitted_odometer SET NOT NULL;
ALTER TABLE app.fitment ADD COLUMN distance_run bigint
  GENERATED ALWAYS AS (removed_odometer - fitted_odometer) STORED;
ALTER TABLE app.fitment ADD CONSTRAINT removal_is_complete CHECK (
  (removed_at IS NULL AND removed_odometer IS NULL AND removal_reason IS NULL)
  OR (removed_at IS NOT NULL AND removed_odometer IS NOT NULL AND removal_reason IS NOT NULL));
ALTER TABLE app.fitment ADD CONSTRAINT odometer_does_not_decrease
  CHECK (removed_odometer IS NULL OR removed_odometer >= fitted_odometer);

-- B2 reversal
UPDATE app.valuation_snapshot SET casing_value = 0 WHERE casing_value IS NULL;
ALTER TABLE app.valuation_snapshot ALTER COLUMN casing_value SET NOT NULL;
UPDATE app.tyre SET casing_value = 0 WHERE casing_value IS NULL;
ALTER TABLE app.tyre ALTER COLUMN casing_value SET DEFAULT 0;
ALTER TABLE app.tyre ALTER COLUMN casing_value SET NOT NULL;

-- B1 reversal
ALTER TABLE app.tyre DROP COLUMN brand_pending;
DROP INDEX app.tyre_display_code_search;
DROP INDEX app.one_active_display_code_per_tenant;
ALTER TABLE app.tyre RENAME COLUMN display_code TO branded_number;
ALTER TABLE app.tyre ADD CONSTRAINT tyre_tenant_id_branded_number_key UNIQUE (tenant_id, branded_number);
CREATE INDEX tyre_branded_search ON app.tyre (tenant_id, branded_number text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Restore the pre-recut bodies (000001 / 000005 / 000006 / 000007 / 000009).
-- ---------------------------------------------------------------------------
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

CREATE FUNCTION app.tyre_valuation_asof(p_as_at date)
RETURNS TABLE (tenant_id uuid, tyre_id uuid, branded_number text, size_name text,
               brand_name text, pattern_name text, status app.tyre_status,
               retread_count int, state app.tyre_state, vehicle_id uuid,
               fleet_number text, position_code text, depot_id uuid, depot_name text,
               current_tread_mm numeric, tread_source text, read_at timestamptz,
               rand_per_mm numeric, removal_threshold_mm numeric,
               valuation_complete boolean, tread_value numeric,
               casing_value numeric, total_value numeric, stale boolean)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id,
         t.id,
         t.branded_number,
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
         t.valuation_complete,
         CASE WHEN t.valuation_complete AND thr.mm IS NOT NULL
               AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
              THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                   thr.mm, t.rand_per_mm) END,
         t.casing_value,
         CASE WHEN t.valuation_complete AND thr.mm IS NOT NULL
               AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
              THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                   thr.mm, t.rand_per_mm) + t.casing_value END,
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
$$;

CREATE VIEW app.v_tyre_valuation WITH (security_invoker = true) AS
SELECT tenant_id, tyre_id, branded_number, size_name, brand_name, pattern_name,
       status, retread_count, state, vehicle_id, fleet_number, position_code,
       depot_id, depot_name,
       current_tread_mm::numeric(4,1) AS current_tread_mm,
       tread_source, read_at,
       rand_per_mm::numeric(12,4) AS rand_per_mm,
       removal_threshold_mm, valuation_complete, tread_value,
       casing_value::numeric(12,2) AS casing_value,
       total_value
  FROM app.tyre_valuation_asof((now() AT TIME ZONE 'UTC')::date);

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
       count(*)                                        AS tyre_count,
       count(*) FILTER (WHERE tread_value IS NULL)     AS unvalued_count,
       sum(tread_value)                                AS tread_value,
       sum(casing_value)                               AS casing_value,
       COALESCE(sum(tread_value), 0) + sum(casing_value) AS total_value
  FROM app.v_tyre_valuation
 WHERE state NOT IN ('SCRAPPED', 'LOST')
 GROUP BY tenant_id,
          GROUPING SETS ((fleet_number), (depot_name), (size_name),
                         (brand_name), (pattern_name), ()),
          ROLLUP(state);

CREATE VIEW app.v_fitted_tread WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.branded_number,
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

CREATE VIEW app.v_irregular_wear_ranking WITH (security_invoker = true) AS
SELECT f.tenant_id,
       f.tyre_id,
       f.branded_number,
       f.vehicle_id,
       f.fleet_number,
       f.position_code,
       f.is_spare,
       lr.inspection_id,
       lr.submitted_at,
       lr.width_spread_mm,
       lr.measurements,
       rank() OVER (PARTITION BY f.tenant_id ORDER BY lr.width_spread_mm DESC)::int AS rank
  FROM app.v_fitted_tread f
  JOIN LATERAL (
       SELECT rd.inspection_id, rd.submitted_at, rd.width_spread_mm, rd.measurements
         FROM app.v_reading_detail rd
        WHERE rd.tyre_id = f.tyre_id
        ORDER BY rd.submitted_at DESC
        LIMIT 1) lr ON true
 WHERE lr.width_spread_mm IS NOT NULL;

CREATE VIEW app.v_dual_mate_ranking WITH (security_invoker = true) AS
SELECT dm.tenant_id,
       dm.vehicle_id,
       v.fleet_number,
       dm.inspection_id,
       dm.axle_number,
       dm.side,
       dm.outer_position,
       dm.inner_position,
       dm.outer_mm,
       dm.inner_mm,
       dm.difference_mm,
       rank() OVER (PARTITION BY dm.tenant_id ORDER BY dm.difference_mm DESC)::int AS rank
  FROM app.v_dual_mate_difference dm
  JOIN app.vehicle v ON v.id = dm.vehicle_id
 WHERE dm.inspection_id = (
       SELECT rd.inspection_id FROM app.v_reading_detail rd
        WHERE rd.vehicle_id = dm.vehicle_id
        ORDER BY rd.submitted_at DESC LIMIT 1);

CREATE VIEW app.v_tyre_wear_rate WITH (security_invoker = true) AS
SELECT ft.tenant_id,
       ft.tyre_id,
       ft.branded_number,
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
  CROSS JOIN LATERAL (
       SELECT EXISTS (SELECT 1 FROM app.fitment f
                       WHERE f.tyre_id = ft.tyre_id
                         AND ((f.fitted_at  > er.submitted_at AND f.fitted_at  <= lr.submitted_at)
                           OR (f.removed_at > er.submitted_at AND f.removed_at <= lr.submitted_at)))
         AS moved) fit;

CREATE VIEW app.v_removal_forecast WITH (security_invoker = true) AS
SELECT wr.tenant_id,
       wr.tyre_id,
       wr.branded_number,
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

CREATE FUNCTION app.removal_forecast_within(p_from date, p_horizon_days int)
RETURNS SETOF app.v_removal_forecast
LANGUAGE sql STABLE AS $$
  SELECT * FROM app.v_removal_forecast
   WHERE projected_removal_date IS NOT NULL
     AND projected_removal_date <= p_from + p_horizon_days
$$;
