-- ============================================================================
--  Single-inspection analytics (TYRE-34)
--  Implements: FR-ANL-023..028, data layer for FR-RPT-022/023/037.
--  Everything here is computable from the latest inspection alone — no
--  history, no odometer — which is why it ships before wear rate (TYRE-35).
-- ============================================================================

-- Generic resolver for a jsonb-valued setting at an explicit moment, the
-- jsonb counterpart of removal_threshold_mm_for (000006). Same contract:
-- strict '<' against an exclusive upper bound, so a caller passes the first
-- instant beyond the period it is reporting on and gets the policy that
-- governed that period, not today's (FR-CFG-051).
CREATE FUNCTION app.config_for(p_tenant uuid, p_key text, p_before timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT c.value
    FROM app.configuration c
   WHERE c.tenant_id = p_tenant
     AND c.key = p_key
     AND c.effective_from < p_before
   ORDER BY c.effective_from DESC
   LIMIT 1
$$;

-- Tread bands as half-open intervals (FR-CFG-030 requires them continuous and
-- exhaustive). The configured pairs are read for their LOWER bounds only:
-- each band runs to the next band's lower bound, the last is unbounded. The
-- stated upper bound survives as the display label, which is what FR-CFG-032
-- is really specifying — its default reads "0-4, 5-7, ..." and taken
-- literally as closed intervals it leaves 4.5mm in no band at all, while
-- FR-INS-021 accepts tread to one decimal place. Lower-bound classification
-- agrees with the default on every whole millimetre and closes the gap.
CREATE FUNCTION app.tread_band_list(p_bands jsonb)
RETURNS TABLE (ordinal int, lower_mm numeric, upper_exclusive_mm numeric, label text)
LANGUAGE sql IMMUTABLE AS $$
  SELECT row_number() OVER (ORDER BY x.lo)::int,
         x.lo,
         lead(x.lo) OVER (ORDER BY x.lo),
         CASE WHEN x.hi IS NULL THEN x.lo::text || 'mm+'
              ELSE x.lo::text || '-' || x.hi::text || 'mm' END
    FROM (SELECT (e->>0)::numeric AS lo, (e->>1)::numeric AS hi
            FROM jsonb_array_elements(p_bands) e) x
$$;

-- The fitted estate with each tyre's current governing depth: the one
-- definition of "which tyres these analytics are about" (FR-ANL-023/024 say
-- fitted, so stock and retreader tyres are out, unlike estate valuation).
-- Spares are fitted to spare positions and are carried here with the flag,
-- never filtered: BR-RPT-001 includes them in composition reporting by
-- default and FR-RPT-005 requires the choice to be stated either way.
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

-- FR-ANL-025/026 over a half-open [p_from, p_to) window. A function, not a
-- view, for the same reason tyre_valuation_asof is: the period is an argument.
-- BR-RPT-004 fixes the denominator as READINGS, never tyres, and requires the
-- reading and distinct-tyre counts alongside every figure — so they ride on
-- every row rather than being a separate call a caller can forget to make.
-- A reading whose axle class has no configured target cannot be expressed as
-- a percentage at all; it is counted as unclassified, never as compliant
-- (the FR-TYR-032 pattern of reporting what was excluded).
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
       -- the returned tenant_id is current_tenant_id(), so select by it too:
       -- under RLS the predicate is redundant, but it makes the label true by
       -- construction rather than by the caller happening to be bound, which
       -- is the property the five views above get from grouping on tenant_id
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

-- FR-ANL-027 / BR-ANL-007. The spread is a property of one inspection, not of
-- the tyre's average condition, so each tyre contributes its most recent
-- reading only. rank() leaves genuine ties sharing a rank; callers wanting a
-- stable print order add branded_number, which is unique per tenant.
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

-- FR-ANL-028 / BR-ANL-008, restricted to each vehicle's most recent
-- inspection so the ranking describes the fleet's current state rather than
-- every pair ever measured. "Most recent" is resolved from the readings, not
-- from inspection.vehicle_id: a combination inspection carries the motive
-- unit there while its readings belong to the constituent vehicles
-- (FR-INS-061), so matching on inspection.vehicle_id would drop every
-- trailer pair.
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
