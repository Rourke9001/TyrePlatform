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
-- No SET clause, schema-qualified bodies (000013's shape).
--
-- How a caller must read one of these, because getting it wrong costs an
-- order of magnitude and nothing in the result gives it away. A composite
-- body with a FROM and a LIMIT cannot be inlined, so one call runs the body
-- once. What sets the number of CALLS is the caller: the planner pulls up a
-- LATERAL subquery that has no FROM clause of its own and substitutes its
-- target list at every site that references the result, so reading six fields
-- off one (tgt.p) is six evaluations per row, multiplied again by every CTE
-- the planner inlines. OFFSET 0 in that subquery is the fence. It keeps the
-- subquery a node of its own, evaluated once per row, which the planner can
-- then memoize across the rows that resolve the same configuration. Measured
-- over the 53 readings of the fixture tenant: 878 evaluations and 35 ms
-- without the fence, 4 evaluations behind 49 memoize hits and 6 ms with it
-- (TYRE-41). Any part that reads more than one field off a resolved row
-- carries the fence too.
--
-- app.removal_threshold_mm_for keeps its signature and becomes a projection
-- off threshold_policy_for. A body with no FROM clause is inlinable, so the
-- planner substitutes it into its callers; those callers (000009, 000011,
-- 000036) are themselves no-FROM laterals reading a single scalar, so what
-- they evaluate per row is what they already evaluated and the register does
-- not move. Sections 17, 18, 20 and 44 are the proof of that.

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
      -- OFFSET 0 is the pullup fence the header describes. Without it the six
      -- (tgt.p) reads above are substituted back into the plan and the
      -- resolver runs per reference rather than per reading.
      CROSS JOIN LATERAL (
           SELECT app.target_pressure_for(r.tenant_id, t.size_id, pos.axle_class, b.ts) AS p
            OFFSET 0) tgt
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

-- Part B. The latest non-voided inspection per UNIT (spec D2). Resolved through
-- reading.vehicle_id, the owning unit (FR-INS-061), never inspection.vehicle_id,
-- which is the rig's motive unit: a trailer inspected solo after its rig was
-- inspected resolves to its own later capture and the rig's other members
-- keep theirs. Ties on submitted_at break on received_at then id, so the
-- answer is the same whatever order the phones synced in. FR-EXC-001 judges
-- rules against the submitted inspection; "the exceptions of the most recent
-- capture" is what TYRE-41 asks for and what the fixture, with two captures
-- per unit since TYRE-35, would otherwise double count.
CREATE VIEW app.v_latest_unit_inspection WITH (security_invoker = true) AS
SELECT DISTINCT ON (r.tenant_id, r.vehicle_id)
       r.tenant_id, r.vehicle_id, i.id AS inspection_id, i.submitted_at, i.received_at
  FROM app.reading r
  JOIN app.inspection i ON i.id = r.inspection_id
 WHERE i.state <> 'VOIDED'
 ORDER BY r.tenant_id, r.vehicle_id, i.submitted_at DESC, i.received_at DESC, i.id;

-- The one population every position rule reads. v_reading_detail predates
-- pressure_temperature (000012) and never carried the tyre's size, so both
-- are joined here rather than by widening a view five others read.
CREATE VIEW app.v_latest_reading WITH (security_invoker = true) AS
SELECT d.*, r.pressure_temperature, t.size_id, v.home_depot_id AS depot_id
  FROM app.v_reading_detail d
  JOIN app.v_latest_unit_inspection l
    ON l.tenant_id = d.tenant_id AND l.vehicle_id = d.vehicle_id AND l.inspection_id = d.inspection_id
  JOIN app.reading r ON r.id = d.reading_id
  JOIN app.vehicle v ON v.id = d.vehicle_id
  LEFT JOIN app.tyre t ON t.id = d.tyre_id;

-- Part C. The rule catalogue and the view (spec D3).
COMMENT ON COLUMN app.exception_rule.threshold IS
  'Unused, kept NULL: every threshold lives in app.threshold_policy, app.target_pressure or app.configuration, resolved through app.threshold_policy_for, app.target_pressure_for and app.config_for. A number here would be a second source for the same rule (B7 spec U6). severity and enabled are what this table decides (FR-EXC-004).';
COMMENT ON COLUMN app.exception.subject_type IS
  'TYRE (subject_id is the tyre observed at the position), POSITION_PAIR (the outer tyre of a dual end) or VEHICLE (the unit an inspection-level rule names). The vocabulary app.v_exception emits, so rows raised from it carry the same tags (B7 spec U20); AXLE is reserved for FR-EXC-037 when Appendix H.2 stops deferring it.';

-- One implementation of the exception rules, read by every consumer: the
-- suite pins it (sections 8 and 59), the API relays it (B7.2) and the
-- dashboard renders it (B7.3). "Three tiers agree" means three readers of
-- this view, never three copies of these predicates (CLAUDE.md, testing).
--
-- Every rule is judged at the inspection's own instant, bound = submitted_at
-- (U18): FR-EXC-001 evaluates rules against the submitted inspection and
-- FR-CFG-051 applies a policy change prospectively, the same reason the
-- snapshot trigger prices at the snapshot's date (000006). The register and
-- v_tyre_at_risk judge at today, and three things separate the two: a policy
-- change, a tyre moving, and a fitted tyre the register prices off its
-- onboarding figure (tread_source AUDIT) because no reading covers it, which
-- this view cannot judge at all. The first two shift a row between the views;
-- the third is a row only the register ever had. Every row here carries the
-- threshold it was judged against so the difference explains itself.
--
-- Rule readings (spec U1 to U4, each an Appendix J.2 reading of an SRS
-- sentence that reads two ways, errata rows prepared):
--   FR-EXC-020 and 038 fire AT OR BELOW the retread threshold, the removal
--     point the register floors at (FR-VAL-004, BR-RPT-006; positions 11, 12,
--     13 and 16 sit exactly on 4.0 and J.2 counts them).
--   FR-EXC-021 is the band strictly between the retread threshold and the
--     warning threshold; read as "< threshold + 2" it would also fire on the
--     nine below it. A NULL warning_threshold_mm disables the rule.
--   FR-EXC-035 is orientation-agnostic (000011's v_irregular_wear_ranking
--     says why) and includes the spare, as J.2 does.
--   FR-EXC-038 is CRITICAL (U1).
-- A reading with no tyre on record raises no TYRE row (U20): nothing is
-- there to remove, and the register shows the unknown position (FR-INS-026).
-- FR-EXC-032 is not a row: it is the casing figure on the 020 and 038 rows,
-- v_tyre_at_risk (U19). FR-EXC-037 is deferred by Appendix H.2 (U13).
CREATE VIEW app.v_exception WITH (security_invoker = true) AS
WITH lr AS (
  SELECT d.*,
         (thr.p).retread_threshold_mm,
         (thr.p).warning_threshold_mm,
         (tgt.p).target_kpa,
         (tgt.p).warn_under_pct,
         (tgt.p).critical_under_pct,
         CASE WHEN (tgt.p).target_kpa > 0 AND d.pressure_kpa IS NOT NULL
              THEN d.pressure_kpa * 100.0 / (tgt.p).target_kpa END AS pct,
         (app.config_for(d.tenant_id, 'width_spread_warn_mm', d.submitted_at) #>> '{}')::numeric AS spread_warn_mm
    FROM app.v_latest_reading d
    -- OFFSET 0 is the pullup fence the file header describes: two fields are
    -- read off (thr.p) and five off (tgt.p).
    CROSS JOIN LATERAL (
         SELECT app.threshold_policy_for(d.tenant_id, NULL, NULL, d.submitted_at) AS p
          OFFSET 0) thr
    CROSS JOIN LATERAL (
         SELECT app.target_pressure_for(d.tenant_id, d.size_id, d.axle_class, d.submitted_at) AS p
          OFFSET 0) tgt
),
found AS (
  -- FR-EXC-020
  SELECT l.tenant_id, 'FR-EXC-020' AS rule_code, 'TYRE' AS subject_type, l.tyre_id AS subject_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL::text AS position_code_2, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at AS observed_at,
         l.governing_tread_mm AS measure_mm, NULL::numeric AS measure_pct,
         l.retread_threshold_mm AS threshold_mm, NULL::numeric AS threshold_pct,
         jsonb_build_object('measurements', l.measurements, 'pressure_kpa', l.pressure_kpa,
                            'target_kpa', l.target_kpa, 'pressure_temperature', l.pressure_temperature) AS detail
    FROM lr l
   WHERE NOT l.is_spare AND l.tyre_id IS NOT NULL
     AND l.governing_tread_mm <= l.retread_threshold_mm
  UNION ALL
  -- FR-EXC-038
  SELECT l.tenant_id, 'FR-EXC-038', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         l.governing_tread_mm, NULL, l.retread_threshold_mm, NULL,
         jsonb_build_object('measurements', l.measurements, 'pressure_kpa', l.pressure_kpa,
                            'target_kpa', l.target_kpa, 'pressure_temperature', l.pressure_temperature)
    FROM lr l
   WHERE l.is_spare AND l.tyre_id IS NOT NULL
     AND l.governing_tread_mm <= l.retread_threshold_mm
  UNION ALL
  -- FR-EXC-021
  SELECT l.tenant_id, 'FR-EXC-021', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         l.governing_tread_mm, NULL, l.warning_threshold_mm, NULL,
         jsonb_build_object('measurements', l.measurements, 'removal_threshold_mm', l.retread_threshold_mm)
    FROM lr l
   WHERE NOT l.is_spare AND l.tyre_id IS NOT NULL
     AND l.governing_tread_mm > l.retread_threshold_mm
     AND l.governing_tread_mm < l.warning_threshold_mm
  UNION ALL
  -- FR-EXC-022
  SELECT l.tenant_id, 'FR-EXC-022', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         NULL, l.pct, NULL, 100 - l.critical_under_pct,
         jsonb_build_object('pressure_kpa', l.pressure_kpa, 'target_kpa', l.target_kpa,
                            'pressure_temperature', l.pressure_temperature)
    FROM lr l
   WHERE l.tyre_id IS NOT NULL AND l.pct < 100 - l.critical_under_pct
  UNION ALL
  -- FR-EXC-023
  SELECT l.tenant_id, 'FR-EXC-023', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         NULL, l.pct, NULL, 100 - l.warn_under_pct,
         jsonb_build_object('pressure_kpa', l.pressure_kpa, 'target_kpa', l.target_kpa,
                            'pressure_temperature', l.pressure_temperature)
    FROM lr l
   WHERE l.tyre_id IS NOT NULL
     AND l.pct >= 100 - l.critical_under_pct AND l.pct < 100 - l.warn_under_pct
  UNION ALL
  -- FR-EXC-035
  SELECT l.tenant_id, 'FR-EXC-035', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         l.width_spread_mm, NULL, l.spread_warn_mm, NULL,
         jsonb_build_object('measurements', l.measurements, 'orientation_known', l.orientation_known)
    FROM lr l
   WHERE l.tyre_id IS NOT NULL AND l.width_spread_mm >= l.spread_warn_mm
  UNION ALL
  -- FR-EXC-028
  SELECT l.tenant_id, 'FR-EXC-028', 'TYRE', l.tyre_id,
         l.vehicle_id, l.fleet_number, l.unit_label, l.depot_id, l.axle_class,
         l.position_code, NULL, l.is_spare, l.tyre_id,
         l.inspection_id, l.submitted_at,
         NULL, NULL, NULL, NULL,
         jsonb_build_object('note', l.note)
    FROM lr l
   WHERE l.tyre_id IS NOT NULL AND l.damage_flag
  UNION ALL
  -- FR-EXC-036: both tyres of one axle end from ONE inspection, which
  -- v_dual_mate_difference guarantees by joining on inspection_id; lr scopes
  -- it to the latest one
  SELECT o.tenant_id, 'FR-EXC-036', 'POSITION_PAIR', o.tyre_id,
         o.vehicle_id, o.fleet_number, o.unit_label, o.depot_id, o.axle_class,
         o.position_code, i2.position_code, false, o.tyre_id,
         o.inspection_id, o.submitted_at,
         dm.difference_mm, NULL, cfg.warn_mm, NULL,
         jsonb_build_object('outer_mm', dm.outer_mm, 'inner_mm', dm.inner_mm, 'tyre_id_2', i2.tyre_id)
    FROM app.v_dual_mate_difference dm
    JOIN lr o  ON o.inspection_id = dm.inspection_id AND o.vehicle_id = dm.vehicle_id AND o.position_code = dm.outer_position
    JOIN lr i2 ON i2.inspection_id = dm.inspection_id AND i2.vehicle_id = dm.vehicle_id AND i2.position_code = dm.inner_position
    -- fenced for the same reason as lr's resolvers: the margin is read twice
    CROSS JOIN LATERAL (
         SELECT (app.config_for(o.tenant_id, 'dual_mate_warn_mm', o.submitted_at) #>> '{}')::numeric AS warn_mm
          OFFSET 0) cfg
   WHERE o.tyre_id IS NOT NULL
     AND dm.difference_mm >= cfg.warn_mm
  UNION ALL
  -- FR-EXC-039: an inspection-level rule, subject the MOTIVE unit, joined once
  -- per inspection (a rig inspection resolves three units in
  -- v_latest_unit_inspection and must not raise three times)
  SELECT i.tenant_id, 'FR-EXC-039', 'VEHICLE', i.vehicle_id,
         i.vehicle_id, v.fleet_number, NULL, v.home_depot_id, NULL,
         NULL, NULL, false, NULL,
         i.id, i.submitted_at,
         NULL, NULL, NULL, NULL,
         jsonb_build_object('readings_with_pressure', a.readings_with_pressure, 'distinct_values', a.distinct_values)
    FROM app.v_pressure_uniformity_anomaly a
    JOIN app.inspection i ON i.id = a.inspection_id
    JOIN app.v_latest_unit_inspection l
      ON l.tenant_id = i.tenant_id AND l.vehicle_id = i.vehicle_id AND l.inspection_id = i.id
    JOIN app.vehicle v ON v.id = i.vehicle_id
   WHERE a.suspected_transcription
)
SELECT f.tenant_id,
       f.rule_code,
       er.name AS rule_name,
       er.severity,
       (er.severity = 'CRITICAL') AS urgent,
       f.subject_type, f.subject_id,
       f.vehicle_id, f.fleet_number, f.unit_label, f.depot_id, f.axle_class,
       f.position_code, f.position_code_2, f.is_spare,
       f.tyre_id, t.display_code,
       f.inspection_id,
       -- FR-EXC-015 last seen: the sheet's submitted_at, not the clock, so a
       -- row is exactly as old as the inspection it was judged on (U18).
       f.observed_at,
       f.measure_mm, f.measure_pct, f.threshold_mm, f.threshold_pct,
       f.detail,
       -- FR-EXC-010 computed (U14): true when no open fitment holds the row's
       -- tyre at that position, so a replacement stops the row shouting
       -- without any write path
       (f.tyre_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM app.fitment ft
          JOIN app.position p ON p.id = ft.position_id
         WHERE ft.tyre_id = f.tyre_id AND ft.vehicle_id = f.vehicle_id
           AND ft.removed_at IS NULL AND p.code = f.position_code)) AS resolved_by_fitment
  FROM found f
  JOIN app.exception_rule er ON er.tenant_id = f.tenant_id AND er.code = f.rule_code AND er.enabled
  LEFT JOIN app.tyre t ON t.id = f.tyre_id;

-- Part D. Value at risk (spec D4; FR-VAL-031, FR-RPT-040, FR-DSH-017; TYRE-193).
-- The rand figure the POC is sold on (Appendix H.3 criterion 6): the casing
-- value of tyres currently at or below the removal threshold, the money lost
-- if they run to destruction. Read from the live register, so judged at
-- TODAY (U18): "currently below" is the register's word, and this is where
-- the at-risk count and the FR-EXC-020 count can differ. Three things
-- separate them: a policy change, a removal, and a fitted tyre whose tread
-- the register takes from the onboarding figure (tread_source AUDIT) because
-- no reading covers it. That third one is money here and no exception row
-- there, because this view is register-driven and v_exception is
-- reading-driven; it is not a disagreement to reconcile but two populations,
-- and B7.3 must label the two figures as such. Each row of the other view
-- says which threshold it was judged against.
-- Fitted tyres only: an at-risk casing on a shelf is a stock question, not a
-- value-at-risk one.
-- The open fitment is re-joined because the register carries the position
-- code but not the position row, and is_spare is what U8 splits on.
-- one_open_fitment_per_tyre (000001, DR-005) makes that join at most one row.
CREATE VIEW app.v_tyre_at_risk WITH (security_invoker = true) AS
SELECT v.tenant_id, v.tyre_id, v.display_code, v.vehicle_id, v.fleet_number,
       v.depot_id, v.position_code, p.is_spare, v.current_tread_mm,
       v.removal_threshold_mm, v.tread_source, v.read_at,
       v.casing_value, v.casing_basis
  FROM app.v_tyre_valuation v
  JOIN app.fitment f  ON f.tyre_id = v.tyre_id AND f.removed_at IS NULL
  JOIN app.position p ON p.id = f.position_id
 WHERE v.state = 'FITTED'
   AND v.current_tread_mm IS NOT NULL
   AND v.removal_threshold_mm IS NOT NULL
   AND v.current_tread_mm <= v.removal_threshold_mm;

-- Aggregated in v_estate_valuation's shape so a depot actor composes DEPOT
-- rows and a tenant actor reads the TENANT row (ADR-0006). Running positions
-- and spares are two rows, never one figure (U8): BR-RPT-001 excludes spares
-- from tread reporting by default and FR-RPT-005 makes the report say so.
-- The sum is over valued casings only; unvalued ones are counted and named,
-- never zero-filled (FR-VAL-013, NFR-PRO-002/003). AUDIT (the onboarding
-- figure, 000011) is estimated for FR-VAL-013's three labels and disclosed
-- inside that count so a manager can see how much of the figure rests on the
-- first stock-take rather than on a retreader.
CREATE VIEW app.v_casing_value_at_risk WITH (security_invoker = true) AS
SELECT r.tenant_id,
       CASE WHEN GROUPING(r.depot_id) = 0 THEN 'DEPOT' ELSE 'TENANT' END AS level,
       r.depot_id,
       d.name AS key_name,
       CASE WHEN r.is_spare THEN 'SPARE' ELSE 'RUNNING' END AS position_class,
       count(*)                                                        AS tyre_count,
       count(*) FILTER (WHERE r.casing_basis = 'ACTUAL')                AS actual_count,
       count(*) FILTER (WHERE r.casing_basis IN ('ESTIMATED', 'AUDIT')) AS estimated_count,
       count(*) FILTER (WHERE r.casing_basis = 'AUDIT')                 AS audit_count,
       count(*) FILTER (WHERE r.casing_value IS NULL)                   AS unvalued_count,
       sum(r.casing_value)                                             AS casing_value_at_risk
  FROM app.v_tyre_at_risk r
  LEFT JOIN app.depot d ON d.id = r.depot_id
 GROUP BY r.tenant_id, r.is_spare, GROUPING SETS ((r.depot_id, d.name), ());

-- v_estate_valuation restated whole with the casing side's provenance split
-- (FR-DSH-002 asks for it on both sides; FR-VAL-013). Every existing column
-- keeps its name, order and semantics; sections 17 to 20 pin them.
-- The three counts are disjoint here, AUDIT beside ESTIMATED rather than
-- inside it, because this view reports the estate's composition while
-- v_casing_value_at_risk reports one figure's exposure (TYRE-193).
DROP VIEW app.v_estate_valuation;
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
       COALESCE(sum(tread_value), 0) + COALESCE(sum(casing_value), 0) AS total_value,
       count(*) FILTER (WHERE casing_basis = 'ACTUAL')       AS casing_actual_count,
       count(*) FILTER (WHERE casing_basis = 'ESTIMATED')    AS casing_estimated_count,
       count(*) FILTER (WHERE casing_basis = 'AUDIT')        AS casing_audit_count
  FROM app.v_tyre_valuation
 WHERE state NOT IN ('SCRAPPED', 'LOST', 'SOLD')
 GROUP BY tenant_id,
          GROUPING SETS ((fleet_number), (depot_name), (size_name),
                         (brand_name), (pattern_name), ()),
          ROLLUP(state);

-- Part E. The snapshot trigger's same-tenant backstop (TYRE-38).
-- 000008's body with one check ahead of everything else. The trigger runs
-- inside refresh_governing_tread's SECURITY DEFINER chain, so RLS never
-- binds its lookups; the composite FK on (tenant_id, inspection_id) is what
-- keeps a cross-tenant reference unconstructable, and this check is the
-- second layer 000004 gives its sibling in the same chain, in 000004's own
-- words ("any future FK regression would otherwise reopen the silent
-- cross-tenant write"). Ahead of the NULL-tyre guard on purpose: a reading
-- with no tyre still names an inspection. db/tests/005_privileged.sql is
-- where it is seen firing; the app role cannot reach it.
CREATE OR REPLACE FUNCTION app.snapshot_on_governing_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE snap_date date; insp_tenant uuid;
BEGIN
  SELECT i.tenant_id, (i.submitted_at AT TIME ZONE 'UTC')::date
    INTO insp_tenant, snap_date
    FROM app.inspection i WHERE i.id = NEW.inspection_id;
  IF insp_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'reading % names an inspection outside its tenant', NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tyre_id IS NULL OR NEW.governing_tread_mm IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM app.reconcile_valuation_snapshots(NEW.tenant_id, snap_date, NEW.tyre_id, 'ON_CHANGE');
  RETURN NULL;
END $$;

-- Part F. Two dashboard substrates and one correction (spec D7).

-- v_spare_tyre_age restated whole (U9). 000012's version used current_date,
-- the server's day and not the tenant's (rule 6, CLAUDE.md), and
-- last_tread_at, the audit column, where the spare's own latest reading is
-- the measurement a manager means by "last measured". A spare is judged on
-- age, not wear (Q21, FR-RPT-041), so the depth rides along for display and
-- never ranks.
DROP VIEW app.v_spare_tyre_age;
CREATE VIEW app.v_spare_tyre_age WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.display_code,
       f.vehicle_id,
       v.fleet_number,
       p.code AS position_code,
       t.received_date,
       (app.tenant_today(tn.timezone) - t.received_date)::int AS age_days,
       COALESCE(lr.measured_at, t.last_tread_at) AS last_measured_at,
       CASE WHEN lr.measured_at IS NOT NULL THEN 'READING'
            WHEN t.last_tread_at IS NOT NULL THEN 'AUDIT' END AS measured_source,
       (app.tenant_today(tn.timezone)
        - app.tenant_today(tn.timezone, COALESCE(lr.measured_at, t.last_tread_at)))::int AS days_since_measured,
       COALESCE(lr.governing_tread_mm, t.last_tread_mm) AS current_tread_mm
  FROM app.tyre t
  JOIN app.tenant tn ON tn.id = t.tenant_id
  JOIN app.fitment f  ON f.tyre_id = t.id AND f.removed_at IS NULL
  JOIN app.position p ON p.id = f.position_id
  JOIN app.vehicle v  ON v.id = f.vehicle_id
  LEFT JOIN LATERAL (
       SELECT i.submitted_at AS measured_at, r.governing_tread_mm
         FROM app.reading r
         JOIN app.inspection i ON i.id = r.inspection_id
        WHERE r.tyre_id = t.id
          AND i.state <> 'VOIDED'
          AND r.governing_tread_mm IS NOT NULL
        ORDER BY i.submitted_at DESC
        LIMIT 1) lr ON true
 WHERE p.is_spare;

-- FR-DSH-005 coverage and FR-DSH-006 / FR-EXC-027 staleness, one row per
-- active unit. Two different questions on two different keys: coverage is
-- against the unit's own schedule interval (inspection_schedule, FR-INS-049)
-- and is NULL where no schedule exists, so an unscheduled fleet reads as
-- unscheduled and never as covered; stale is against reading_staleness_days,
-- the FR-VAL-021 key. A unit never inspected is stale wherever a threshold is
-- configured. A LANGUAGE sql table function with no SET clause, because the
-- view below is built over it and must inline (000036, section 8d).
CREATE FUNCTION app.unit_inspection_status(p_as_at date)
RETURNS TABLE (tenant_id uuid, vehicle_id uuid, fleet_number text, depot_id uuid,
               last_inspected_at timestamptz, days_since int, interval_days int,
               scheduled boolean, covered boolean, stale boolean)
LANGUAGE sql STABLE AS $$
  SELECT v.tenant_id,
         v.id,
         v.fleet_number,
         v.home_depot_id,
         li.submitted_at,
         CASE WHEN li.submitted_at IS NOT NULL
              THEN (p_as_at - (li.submitted_at AT TIME ZONE 'UTC')::date) END,
         sch.interval_days,
         sch.interval_days IS NOT NULL,
         CASE WHEN sch.interval_days IS NULL THEN NULL
              ELSE li.submitted_at IS NOT NULL
                   AND (p_as_at - (li.submitted_at AT TIME ZONE 'UTC')::date) <= sch.interval_days END,
         CASE WHEN st.days IS NULL THEN NULL
              ELSE li.submitted_at IS NULL
                   OR (p_as_at - (li.submitted_at AT TIME ZONE 'UTC')::date) > st.days END
    FROM app.vehicle v
    CROSS JOIN LATERAL (SELECT ((p_as_at + 1)::timestamp AT TIME ZONE 'UTC') AS ts) bound
    LEFT JOIN LATERAL (
         SELECT i.submitted_at
           FROM app.reading r
           JOIN app.inspection i ON i.id = r.inspection_id
          WHERE r.vehicle_id = v.id
            AND i.state <> 'VOIDED'
            AND i.submitted_at < bound.ts
          ORDER BY i.submitted_at DESC
          LIMIT 1) li ON true
    LEFT JOIN LATERAL (
         SELECT s.interval_days
           FROM app.inspection_schedule s
          WHERE s.tenant_id = v.tenant_id
            AND s.active
            AND (s.vehicle_id = v.id
                 OR (s.vehicle_id IS NULL AND s.operating_group_id = v.operating_group_id))
          ORDER BY (s.vehicle_id IS NOT NULL) DESC, s.created_at DESC
          LIMIT 1) sch ON true
    -- OFFSET 0 is the pullup fence the file header describes: the staleness
    -- threshold is read twice in the stale expression above, so without it
    -- config_for runs twice per unit.
    LEFT JOIN LATERAL (
         SELECT (app.config_for(v.tenant_id, 'reading_staleness_days', bound.ts) #>> '{}')::int AS days
          OFFSET 0) st ON true
   WHERE v.status = 'ACTIVE'
$$;

CREATE VIEW app.v_unit_inspection_status WITH (security_invoker = true) AS
SELECT s.*
  FROM app.tenant tn
  CROSS JOIN LATERAL app.unit_inspection_status(app.tenant_today(tn.timezone)) s
 WHERE s.tenant_id = tn.id;
