-- ============================================================================
--  Analytics reconciliation (TYRE-42)
--  Implements: CHG-111 (one threshold model), CHG-112 (one pressure model),
--  CHG-113 (one forecast implementation), and the CHG-016 casing chain in the
--  register — manifest v1.1 §7.2. One implementation per concept: after this
--  file no config-key threshold, no config-key pressure target and no point-
--  date forecast exists anywhere.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Threshold consolidation (CHG-111)
--
-- threshold_policy becomes authoritative. Existing tenants' config-key values
-- migrate across so behaviour is continuous, then the keys are removed — a
-- retired key that stays resolvable is a second source of truth.
-- ---------------------------------------------------------------------------
INSERT INTO app.threshold_policy
  (tenant_id, retread_threshold_mm, scrap_threshold_mm, warning_threshold_mm, effective_from)
SELECT c.tenant_id,
       (c.value #>> '{}')::numeric,
       (c.value #>> '{}')::numeric,
       (SELECT (w.value #>> '{}')::numeric
          FROM app.configuration w
         WHERE w.tenant_id = c.tenant_id AND w.key = 'warning_threshold_mm'
         ORDER BY w.effective_from DESC LIMIT 1),
       c.effective_from
  FROM app.configuration c
 WHERE c.key = 'removal_threshold_mm';

DELETE FROM app.configuration WHERE key IN ('removal_threshold_mm', 'warning_threshold_mm');

-- Same signature, new source: every consumer — the register, the snapshots,
-- the forecast — moves to the policy table in this one statement. The removal
-- point is the RETREAD threshold: a tyre is pulled when retreading protects
-- the casing, and BR-VAL-001's tread value floors at the depth the fleet
-- would actually pull it. Resolution is the tenant-wide default row
-- (no operating group, no axle class); narrower rows serve surfaces that can
-- state which cohort they are pricing.
CREATE OR REPLACE FUNCTION app.removal_threshold_mm_for(p_tenant uuid, p_before timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT p.retread_threshold_mm
    FROM app.threshold_policy p
   WHERE p.tenant_id = p_tenant
     AND p.operating_group_id IS NULL
     AND p.axle_class IS NULL
     AND p.effective_from < p_before
   ORDER BY p.effective_from DESC
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- 2. Pressure consolidation (CHG-112 / CHG-034 / CHG-035)
-- ---------------------------------------------------------------------------
INSERT INTO app.target_pressure (tenant_id, axle_class, target_kpa, effective_from)
SELECT c.tenant_id, e.key::app.axle_class, e.value::int, c.effective_from
  FROM app.configuration c
  CROSS JOIN LATERAL jsonb_each_text(c.value) e
 WHERE c.key = 'target_pressure_kpa';

-- The retired inflation_bands edges (80 / 90 / 110 / 120% of target) are
-- reproduced exactly by the table's default 10/20% warn/critical tolerances,
-- so no derivation from the old jsonb is needed for continuity.
DELETE FROM app.configuration
 WHERE key IN ('target_pressure_kpa', 'inflation_bands', 'pressure_deviation_margin_pct');

DROP FUNCTION app.inflation_compliance(date, date);

-- FR-ANL-025/026 over a half-open [p_from, p_to) window, resolved from
-- target_pressure. BR-RPT-004 fixes the denominator as READINGS, never tyres.
-- A reading whose position has no applicable target is unclassifiable, never
-- compliant (the FR-TYR-032 pattern of reporting what was excluded).
--
-- Hot/cold per CHG-035: manufacturer targets are COLD figures, so a HOT or
-- UNKNOWN reading in the correct band is not proof of correct inflation. The
-- per-band cold/hot/unknown split is that label, riding on every row rather
-- than being a separate call a caller can forget to make.
--
-- The five FR-CFG-016 bands derive from each reading's own resolved target
-- row (half-open by lower bound, matching the tread bands): at the seeded
-- tolerances the edges sit at 80/90/110/120% of target.
CREATE FUNCTION app.inflation_compliance(p_from date, p_to date)
RETURNS TABLE (tenant_id uuid, band_ordinal int, band_key text,
               reading_count bigint, tyre_count bigint, pct_of_classified numeric,
               cold_count bigint, hot_count bigint, unknown_count bigint,
               total_readings bigint, total_tyres bigint, unclassified_count bigint)
LANGUAGE sql STABLE AS $$
  WITH bound AS (SELECT (p_from::timestamp AT TIME ZONE 'UTC') AS fs,
                        (p_to::timestamp   AT TIME ZONE 'UTC') AS ts,
                        app.current_tenant_id() AS tid),
  readings AS (
    SELECT r.tyre_id,
           r.pressure_temperature,
           CASE WHEN tgt.target_kpa > 0 AND r.pressure_kpa IS NOT NULL
                THEN r.pressure_kpa * 100.0 / tgt.target_kpa END AS pct,
           tgt.warn_under_pct, tgt.critical_under_pct,
           tgt.warn_over_pct, tgt.critical_over_pct
      FROM app.reading r
      JOIN app.inspection i ON i.id = r.inspection_id
      JOIN app.position pos ON pos.id = r.position_id
      LEFT JOIN app.tyre t ON t.id = r.tyre_id
      CROSS JOIN bound b
      -- most specific applicable target wins: size+class over class over size
      -- over tenant-wide, latest effective row within each
      LEFT JOIN LATERAL (
           SELECT tp.target_kpa, tp.warn_under_pct, tp.critical_under_pct,
                  tp.warn_over_pct, tp.critical_over_pct
             FROM app.target_pressure tp
            WHERE tp.tenant_id = r.tenant_id
              AND (tp.axle_class IS NULL OR tp.axle_class = pos.axle_class)
              AND (tp.size_id IS NULL OR tp.size_id = t.size_id)
              AND tp.effective_from < b.ts
            ORDER BY (tp.size_id IS NOT NULL) DESC,
                     (tp.axle_class IS NOT NULL) DESC,
                     tp.effective_from DESC
            LIMIT 1) tgt ON true
     WHERE i.state <> 'VOIDED'
       -- the returned tenant_id is current_tenant_id(), so select by it too:
       -- under RLS the predicate is redundant, but it makes the label true by
       -- construction rather than by the caller happening to be bound
       AND r.tenant_id = b.tid
       AND i.submitted_at >= b.fs
       AND i.submitted_at <  b.ts),
  banded AS (
    SELECT *,
           CASE WHEN pct IS NULL THEN NULL
                WHEN pct < 100 - critical_under_pct THEN 1
                WHEN pct < 100 - warn_under_pct     THEN 2
                WHEN pct < 100 + warn_over_pct      THEN 3
                WHEN pct < 100 + critical_over_pct  THEN 4
                ELSE 5 END AS ordinal
      FROM readings),
  totals AS (
    SELECT count(*) FILTER (WHERE pct IS NOT NULL)                AS total_readings,
           count(DISTINCT tyre_id) FILTER (WHERE pct IS NOT NULL) AS total_tyres,
           count(*) FILTER (WHERE pct IS NULL)                    AS unclassified
      FROM banded)
  SELECT b.tid,
         bands.ordinal,
         bands.key,
         count(bd.ordinal),
         count(DISTINCT bd.tyre_id),
         CASE WHEN t.total_readings > 0
              THEN round(count(bd.ordinal) * 100.0 / t.total_readings, 2) END,
         count(*) FILTER (WHERE bd.pressure_temperature = 'COLD'),
         count(*) FILTER (WHERE bd.pressure_temperature = 'HOT'),
         count(*) FILTER (WHERE bd.pressure_temperature = 'UNKNOWN'),
         t.total_readings,
         t.total_tyres,
         t.unclassified
    FROM bound b
    CROSS JOIN (VALUES (1,'dangerously_under'),(2,'under'),(3,'correct'),
                       (4,'over'),(5,'dangerously_over')) AS bands(ordinal, key)
    CROSS JOIN totals t
    LEFT JOIN banded bd ON bd.ordinal = bands.ordinal
   GROUP BY b.tid, bands.ordinal, bands.key,
            t.total_readings, t.total_tyres, t.unclassified
$$;

-- ---------------------------------------------------------------------------
-- 3. Forecast consolidation (CHG-113 / CHG-043 / CFL-009)
-- ---------------------------------------------------------------------------

-- A two-point difference is dominated by rounding error at whole-millimetre
-- precision: a tyre wearing 0.8mm in a month reads as no wear at all, then as
-- 1mm the following month. Regression across ALL of a tyre's readings is far
-- more robust, because the rounding errors are independent and partly cancel
-- as readings accumulate (Q18). Needs no odometer, so it covers trailers.
CREATE FUNCTION app.wear_rate_mm_per_month(p_tyre_id uuid)
RETURNS TABLE (rate_mm_per_month numeric, reading_count int, span_days int,
               last_read_at timestamptz)
LANGUAGE sql STABLE AS $$
  WITH pts AS (
    SELECT extract(epoch FROM i.submitted_at) / 86400.0 AS day,
           i.submitted_at,
           r.governing_tread_mm AS mm
      FROM app.reading r
      JOIN app.inspection i ON i.id = r.inspection_id
     WHERE r.tyre_id = p_tyre_id
       AND r.governing_tread_mm IS NOT NULL
       AND i.state <> 'VOIDED'
  )
  SELECT CASE WHEN count(*) >= 2 AND var_samp(day) > 0
              -- negative slope is wear; report it as a positive rate
              THEN round((-regr_slope(mm, day))::numeric * 30.44, 4)
              ELSE NULL END,
         count(*)::int,
         (max(day) - min(day))::int,
         max(submitted_at)
    FROM pts
$$;

-- Predictions are RANGES, never point dates. With +/-0.5mm rounding on each
-- reading the rate carries real uncertainty, and "week 40" is a false
-- precision that will eventually be caught out and cost trust. The reading
-- count travels with the answer so the consumer can see how much to believe
-- (ADR-0010). The slack multiplier is an honesty band scaled by how little
-- underpins the estimate — a heuristic, not a statistical interval, which is
-- why the basis says REGRESSION_MM_PER_MONTH and not "95% CI".
--
-- Anchored to the tyre's own latest reading, not to when someone looks: a
-- projection that shifts because the suite ran on a different day is not
-- reproducible (the 000009 principle, kept).
CREATE FUNCTION app.predicted_threshold_range(
  p_tyre_id uuid, p_current_mm numeric, p_threshold_mm numeric)
RETURNS TABLE (earliest date, latest date, reading_count int, basis text)
LANGUAGE plpgsql STABLE AS $$
DECLARE w record; anchor date; remaining numeric; months numeric; slack numeric;
BEGIN
  SELECT * INTO w FROM app.wear_rate_mm_per_month(p_tyre_id);

  IF w.rate_mm_per_month IS NULL THEN
    RETURN QUERY SELECT NULL::date, NULL::date, COALESCE(w.reading_count, 0), 'INSUFFICIENT_DATA';
    RETURN;
  END IF;
  IF w.rate_mm_per_month <= 0 THEN
    RETURN QUERY SELECT NULL::date, NULL::date, w.reading_count, 'NO_MEASURABLE_WEAR';
    RETURN;
  END IF;

  anchor    := (w.last_read_at AT TIME ZONE 'UTC')::date;
  remaining := GREATEST(0, p_current_mm - p_threshold_mm);
  months    := remaining / w.rate_mm_per_month;
  -- Widen the band when few readings underpin the estimate.
  slack     := months * CASE WHEN w.reading_count >= 6 THEN 0.15
                             WHEN w.reading_count >= 4 THEN 0.30
                             ELSE 0.50 END;

  RETURN QUERY SELECT
    (anchor + ((months - slack) * 30.44)::int)::date,
    (anchor + ((months + slack) * 30.44)::int)::date,
    w.reading_count,
    'REGRESSION_MM_PER_MONTH';
END $$;

DROP FUNCTION app.removal_forecast_within(date, int);
DROP VIEW app.v_removal_forecast;

-- FR-ANL-004/005 over CHG-043: the ONE forecast surface. mm/month regression
-- is the primary rate; the odometer sibling rides along per CFL-009 for the
-- vehicles that have distance. Point-date columns are retired — the range and
-- its reading count are the projection. A tyre already at or below the
-- threshold reached it no later than its last reading: both range ends land
-- on that date whatever the rate says, because being past the threshold
-- answers "when does this need replacing" without needing a rate at all.
CREATE VIEW app.v_removal_forecast WITH (security_invoker = true) AS
SELECT ft.tenant_id,
       ft.tyre_id,
       ft.display_code,
       ft.vehicle_id,
       ft.fleet_number,
       ft.depot_name,
       ft.position_code,
       ft.is_spare,
       ft.current_tread_mm,
       ft.read_at AS later_read_at,
       thr.mm AS removal_threshold_mm,
       w.rate_mm_per_month AS wear_rate_mm_per_month,
       osib.wear_rate_mm_per_1000km,
       w.reading_count,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN (ft.read_at AT TIME ZONE 'UTC')::date
            ELSE pred.earliest END AS earliest_removal_date,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN (ft.read_at AT TIME ZONE 'UTC')::date
            ELSE pred.latest END AS latest_removal_date,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN 'AT_OR_BELOW_THRESHOLD' ELSE pred.basis END AS basis,
       CASE WHEN thr.mm IS NULL                    THEN 'NO_THRESHOLD_POLICY'
            WHEN ft.current_tread_mm IS NULL       THEN 'INSUFFICIENT_DATA'
            WHEN ft.current_tread_mm <= thr.mm     THEN 'AT_OR_BELOW_THRESHOLD'
            WHEN w.rate_mm_per_month IS NULL       THEN 'INSUFFICIENT_DATA'
            WHEN w.rate_mm_per_month <= 0          THEN 'NO_MEASURABLE_WEAR'
            ELSE 'FORECAST' END AS forecast_status
  FROM app.v_fitted_tread ft
  CROSS JOIN LATERAL (SELECT app.removal_threshold_mm_for(ft.tenant_id, now()) AS mm) thr
  CROSS JOIN LATERAL app.wear_rate_mm_per_month(ft.tyre_id) w
  CROSS JOIN LATERAL app.predicted_threshold_range(
       ft.tyre_id, ft.current_tread_mm, thr.mm) pred
  LEFT JOIN LATERAL (
       SELECT wr.wear_rate_mm_per_1000km
         FROM app.v_tyre_wear_rate wr
        WHERE wr.tyre_id = ft.tyre_id
        LIMIT 1) osib ON true;

-- FR-ANL-007, the data layer for FR-RPT-028. The horizon filters on the
-- EARLIEST end of the range: a replacement report that waits for the latest
-- end plans for the optimistic case, and a forecast that runs late is worth
-- less than one that runs early.
CREATE FUNCTION app.removal_forecast_within(p_from date, p_horizon_days int)
RETURNS SETOF app.v_removal_forecast
LANGUAGE sql STABLE AS $$
  SELECT * FROM app.v_removal_forecast
   WHERE earliest_removal_date IS NOT NULL
     AND earliest_removal_date <= p_from + p_horizon_days
$$;

-- ---------------------------------------------------------------------------
-- 4. The register's casing side moves onto the CHG-016 event chain, now that
--    the tables exist: latest casing_valuation row (labelled by its source),
--    else the admin size estimate, else the onboarding audit figure. Same
--    signature, so v_tyre_valuation, v_estate_valuation and the snapshot
--    writers follow without change.
-- ---------------------------------------------------------------------------
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
         cas.value,
         cas.basis,
         tv.val + cas.value,
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
    -- current casing value = the latest valuation event as at the date
    -- (CHG-016), labelled by its source; the size estimate and the onboarding
    -- audit figure are fallbacks, each under its own label — never blended
    LEFT JOIN LATERAL (
         SELECT c.value, c.source
           FROM app.casing_valuation c
          WHERE c.tenant_id = t.tenant_id
            AND c.tyre_id = t.id
            AND c.effective_from <= p_as_at
          ORDER BY c.effective_from DESC, c.recorded_at DESC
          LIMIT 1) cv ON true
    LEFT JOIN LATERAL (
         SELECT e.estimated_value
           FROM app.casing_estimate_by_size e
          WHERE e.tenant_id = t.tenant_id
            AND e.size_id = t.size_id
            AND e.effective_from <= p_as_at
          ORDER BY e.effective_from DESC
          LIMIT 1) est ON true
    CROSS JOIN LATERAL (
         SELECT COALESCE(cv.value, est.estimated_value, t.casing_value) AS value,
                CASE WHEN cv.value IS NOT NULL THEN
                       CASE WHEN cv.source = 'RETREADER' THEN 'ACTUAL' ELSE 'ESTIMATED' END
                     WHEN est.estimated_value IS NOT NULL THEN 'ESTIMATED'
                     WHEN t.casing_value IS NOT NULL THEN 'AUDIT'
                     ELSE 'UNVALUED' END AS basis) cas
$$;
