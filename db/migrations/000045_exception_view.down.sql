-- 000045 down. Restores the state the up migration found (000039's down says
-- why the duplication is the point). Parts run in reverse of the up file:
-- F, E, D, C, B, then A, so every dependent goes before what it depends on.

-- Part C and B restore. Both column comments were absent before 000045
-- (col_description returned NULL on each), so IS NULL is the state restored,
-- not a comment discarded.
DROP VIEW app.v_exception;
COMMENT ON COLUMN app.exception.subject_type IS NULL;
COMMENT ON COLUMN app.exception_rule.threshold IS NULL;
DROP VIEW app.v_latest_reading;
DROP VIEW app.v_latest_unit_inspection;

-- Part A restore: the two wrappers come back over their own reads before the
-- resolvers go, so no wrapper is ever left pointing at a function that is
-- gone. The catalog will not enforce that order, because a LANGUAGE sql body
-- stored as text records no dependency on what it calls; the DROPs below
-- would succeed either way and the breakage would surface at the first call
-- instead. Both bodies are the catalog's own rendering of what 000013 left,
-- taken from pg_get_functiondef rather than retyped, so a down-then-up cycle
-- returns prosrc byte for byte.
CREATE OR REPLACE FUNCTION app.removal_threshold_mm_for(p_tenant uuid, p_before timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  SELECT p.retread_threshold_mm
    FROM app.threshold_policy p
   WHERE p.tenant_id = p_tenant
     AND p.operating_group_id IS NULL
     AND p.axle_class IS NULL
     AND p.effective_from < p_before
   ORDER BY p.effective_from DESC
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION app.inflation_compliance(p_from date, p_to date)
 RETURNS TABLE(tenant_id uuid, band_ordinal integer, band_key text, reading_count bigint, tyre_count bigint, pct_of_classified numeric, cold_count bigint, hot_count bigint, unknown_count bigint, total_readings bigint, total_tyres bigint, unclassified_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
$function$;

DROP FUNCTION app.target_pressure_for(uuid, uuid, app.axle_class, timestamptz);
DROP FUNCTION app.threshold_policy_for(uuid, uuid, app.axle_class, timestamptz);
