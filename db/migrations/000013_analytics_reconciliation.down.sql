-- Reverses 000013: config keys return as the threshold/pressure source, the
-- point-date forecast returns, and the register's casing side returns to the
-- onboarding audit column. Reversal limits, stated: the config keys are
-- rebuilt from the CURRENT policy/target rows (per-key history collapsed to
-- the latest value — the up migration folded that history into the tables),
-- and the reconstructed inflation_bands is the FR-CFG-016 default.

-- 4. register casing back to the 000011 (audit-column) body
CREATE OR REPLACE FUNCTION app.tyre_valuation_asof(p_as_at date)
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
    CROSS JOIN LATERAL (
         SELECT CASE WHEN t.rand_per_mm IS NOT NULL AND thr.mm IS NOT NULL
                      AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
                     THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                          thr.mm, t.rand_per_mm) END AS val) tv
$$;

-- 3. forecast back to the 000011 point surface
DROP FUNCTION app.removal_forecast_within(date, int);
DROP VIEW app.v_removal_forecast;
DROP FUNCTION app.predicted_threshold_range(uuid, numeric, numeric);
DROP FUNCTION app.wear_rate_mm_per_month(uuid);

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

CREATE FUNCTION app.removal_forecast_within(p_from date, p_horizon_days int)
RETURNS SETOF app.v_removal_forecast
LANGUAGE sql STABLE AS $$
  SELECT * FROM app.v_removal_forecast
   WHERE projected_removal_date IS NOT NULL
     AND projected_removal_date <= p_from + p_horizon_days
$$;

-- 2. pressure back to config keys
DROP FUNCTION app.inflation_compliance(date, date);

INSERT INTO app.configuration (tenant_id, key, value, effective_from)
SELECT tenant_id, 'target_pressure_kpa',
       jsonb_object_agg(axle_class::text, target_kpa), min(effective_from)
  FROM app.target_pressure
 WHERE axle_class IS NOT NULL AND size_id IS NULL
 GROUP BY tenant_id;
INSERT INTO app.configuration (tenant_id, key, value, effective_from)
SELECT DISTINCT tenant_id, 'inflation_bands',
       '{"dangerously_under":[0,80],"under":[80,90],"correct":[90,110],"over":[110,120],"dangerously_over":[120,null]}'::jsonb,
       '2024-01-01T00:00:00Z'::timestamptz
  FROM app.target_pressure;
INSERT INTO app.configuration (tenant_id, key, value, effective_from)
SELECT DISTINCT tenant_id, 'pressure_deviation_margin_pct', '25'::jsonb,
       '2024-01-01T00:00:00Z'::timestamptz
  FROM app.target_pressure;
DELETE FROM app.target_pressure WHERE axle_class IS NOT NULL AND size_id IS NULL;

CREATE FUNCTION app.inflation_compliance(p_from date, p_to date)
RETURNS TABLE (tenant_id uuid, band_key text, lower_pct numeric, upper_pct numeric,
               reading_count bigint, tyre_count bigint, pct_of_classified numeric,
               total_readings bigint, total_tyres bigint, unclassified_count bigint)
LANGUAGE sql STABLE AS $$
  WITH bound AS (SELECT (p_to::timestamp AT TIME ZONE 'UTC') AS ts,
                        app.current_tenant_id() AS tid),
  bands AS (
    SELECT b.tid,
           e.key AS band_key,
           (e.value->>0)::numeric AS lower_pct,
           lead((e.value->>0)::numeric)
             OVER (ORDER BY (e.value->>0)::numeric) AS upper_exclusive_pct
      FROM bound b
      CROSS JOIN LATERAL jsonb_each(app.config_for(b.tid, 'inflation_bands', b.ts)) e),
  readings AS (
    SELECT r.tenant_id, r.tyre_id,
           CASE WHEN tgt.kpa IS NOT NULL AND tgt.kpa > 0 AND r.pressure_kpa IS NOT NULL
                THEN r.pressure_kpa * 100.0 / tgt.kpa END AS pct_of_target
      FROM app.reading r
      JOIN app.inspection i ON i.id = r.inspection_id
      JOIN app.position pos ON pos.id = r.position_id
      CROSS JOIN bound b
      CROSS JOIN LATERAL (
           SELECT (app.config_for(r.tenant_id, 'target_pressure_kpa', b.ts)
                     ->> pos.axle_class::text)::numeric AS kpa) tgt
     WHERE i.state <> 'VOIDED'
       AND r.tenant_id = b.tid
       AND i.submitted_at >= (p_from::timestamp AT TIME ZONE 'UTC')
       AND i.submitted_at <  b.ts),
  totals AS (
    SELECT count(*) FILTER (WHERE pct_of_target IS NOT NULL)                   AS total_readings,
           count(DISTINCT tyre_id) FILTER (WHERE pct_of_target IS NOT NULL)    AS total_tyres,
           count(*) FILTER (WHERE pct_of_target IS NULL)                       AS unclassified
      FROM readings)
  SELECT bands.tid,
         bands.band_key,
         bands.lower_pct,
         bands.upper_exclusive_pct,
         count(rd.tyre_id),
         count(DISTINCT rd.tyre_id),
         CASE WHEN t.total_readings > 0
              THEN round(count(rd.tyre_id) * 100.0 / t.total_readings, 2) END,
         t.total_readings,
         t.total_tyres,
         t.unclassified
    FROM bands
    CROSS JOIN totals t
    LEFT JOIN readings rd
           ON rd.pct_of_target >= bands.lower_pct
          AND (bands.upper_exclusive_pct IS NULL OR rd.pct_of_target < bands.upper_exclusive_pct)
   GROUP BY bands.tid, bands.band_key, bands.lower_pct, bands.upper_exclusive_pct,
            t.total_readings, t.total_tyres, t.unclassified
$$;

-- 1. threshold back to config keys
INSERT INTO app.configuration (tenant_id, key, value, effective_from)
SELECT tenant_id, 'removal_threshold_mm', to_jsonb(retread_threshold_mm), effective_from
  FROM app.threshold_policy
 WHERE operating_group_id IS NULL AND axle_class IS NULL;
INSERT INTO app.configuration (tenant_id, key, value, effective_from)
SELECT tenant_id, 'warning_threshold_mm', to_jsonb(warning_threshold_mm), effective_from
  FROM app.threshold_policy
 WHERE operating_group_id IS NULL AND axle_class IS NULL
   AND warning_threshold_mm IS NOT NULL;
DELETE FROM app.threshold_policy WHERE operating_group_id IS NULL AND axle_class IS NULL;

CREATE OR REPLACE FUNCTION app.removal_threshold_mm_for(p_tenant uuid, p_before timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (c.value #>> '{}')::numeric
    FROM app.configuration c
   WHERE c.tenant_id = p_tenant
     AND c.key = 'removal_threshold_mm'
     AND c.effective_from < p_before
   ORDER BY c.effective_from DESC
   LIMIT 1
$$;
