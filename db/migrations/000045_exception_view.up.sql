-- ============================================================================
--  The exception view, the resolvers and value at risk (TYRE-41, TYRE-211,
--  TYRE-183, TYRE-193, TYRE-38)
--  Implements: spec 2026-09-10-b7-analytics-dashboard-design.md §B7.1 (D1 to
--  D7, decisions U1 to U6, U9 to U14, U18 to U20); FR-EXC-001 as the instant
--  a rule is judged at; FR-EXC-015; FR-EXC-020, 021, 022, 023, 028, 035, 036,
--  038, 039 as Appendix J.2 reads them; FR-VAL-013 and FR-VAL-031; FR-DSH-005
--  and FR-DSH-006 substrate; FR-CFG-013 (errata E1).
-- ============================================================================
-- No new SQLSTATE the app role can meet. The one RAISE (part E) is reachable
-- only with a composite FK removed, and db/tests/005_privileged.sql is the
-- place that removes one.
--
-- Part A. Two resolvers, one per typed configuration store (TYRE-211).
-- app.configuration has had app.config_for since 000007; threshold_policy and
-- target_pressure were read by hand at every site, with four different
-- predicates. These two functions are the one place each store is resolved.
-- Scalar composite results with a LIMIT: the planner calls them per row rather
-- than inlining them, which is what removal_threshold_mm_for has always been.
-- No SET clause, schema-qualified bodies (000013's shape).

-- Precedence, narrowest first: an operating-group row over a tenant-wide one,
-- an axle-class row over a class-blind one, latest effective within each.
-- The axle tier is the shape app.fit_tyre already implements (000039); the
-- group tier is new, because no site reads a group row yet (TYRE-211).
-- p_before is the exclusive upper edge of an as-at day, the register's
-- convention (000036's header), so a row effective exactly at p_before is not
-- yet in force. fit_tyre's inline read uses <= now(); that difference is
-- TYRE-142's to settle when the write sites move onto this function.
CREATE FUNCTION app.threshold_policy_for(p_tenant uuid, p_operating_group uuid,
                                         p_axle_class app.axle_class, p_before timestamptz)
RETURNS app.threshold_policy
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM app.threshold_policy p
   WHERE p.tenant_id = p_tenant
     AND (p.operating_group_id IS NULL OR p.operating_group_id = p_operating_group)
     AND (p.axle_class IS NULL OR p.axle_class = p_axle_class)
     AND p.effective_from < p_before
   ORDER BY (p.operating_group_id IS NULL), (p.axle_class IS NULL), p.effective_from DESC
   LIMIT 1
$$;

-- Same signature, same answer, one source: the tenant-wide row's retread
-- threshold (000013's rationale for the retread column stands). Sections 17,
-- 18, 20 and 44 price through this function and pin Appendix E to the cent.
CREATE OR REPLACE FUNCTION app.removal_threshold_mm_for(p_tenant uuid, p_before timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (app.threshold_policy_for(p_tenant, NULL, NULL, p_before)).retread_threshold_mm
$$;

-- Precedence is the ORDER BY app.inflation_compliance carried since 000013:
-- a size-and-class row, then size-only, then class-only, then tenant-wide,
-- latest effective within each. 000013's prose above that ORDER BY says
-- class over size; the code has always said size over class, and the code is
-- what capture.go copied (its LATERAL matches). This function supersedes that
-- sentence. A spare resolves to NULL unconditionally: a spare's pressure is
-- unclassifiable and never silently compliant (FR-CFG-013, errata E1), and
-- until now only capture.go carried that guard, so a tenant-wide target row
-- would have classified spares in the compliance figures and not at capture.
CREATE FUNCTION app.target_pressure_for(p_tenant uuid, p_size uuid,
                                        p_axle_class app.axle_class, p_before timestamptz)
RETURNS app.target_pressure
LANGUAGE sql STABLE AS $$
  SELECT tp.* FROM app.target_pressure tp
   WHERE p_axle_class IS DISTINCT FROM 'SPARE'::app.axle_class
     AND tp.tenant_id = p_tenant
     AND (tp.axle_class IS NULL OR tp.axle_class = p_axle_class)
     AND (tp.size_id IS NULL OR tp.size_id = p_size)
     AND tp.effective_from < p_before
   ORDER BY (tp.size_id IS NOT NULL) DESC, (tp.axle_class IS NOT NULL) DESC, tp.effective_from DESC
   LIMIT 1
$$;

-- 000013's body with its LATERAL replaced by the resolver. Rows are identical
-- for every seeded tenant (class rows only); the suite's inflation sections
-- prove it. Restated whole rather than patched (000036's rule).
CREATE OR REPLACE FUNCTION app.inflation_compliance(p_from date, p_to date)
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
           CASE WHEN (tgt.p).target_kpa > 0 AND r.pressure_kpa IS NOT NULL
                THEN r.pressure_kpa * 100.0 / (tgt.p).target_kpa END AS pct,
           (tgt.p).warn_under_pct, (tgt.p).critical_under_pct,
           (tgt.p).warn_over_pct, (tgt.p).critical_over_pct
      FROM app.reading r
      JOIN app.inspection i ON i.id = r.inspection_id
      JOIN app.position pos ON pos.id = r.position_id
      LEFT JOIN app.tyre t ON t.id = r.tyre_id
      CROSS JOIN bound b
      CROSS JOIN LATERAL (
           SELECT app.target_pressure_for(r.tenant_id, t.size_id, pos.axle_class, b.ts) AS p) tgt
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
