-- ============================================================================
--  An estate group with no valued member totals NULL, not 0 (TYRE-269)
--  Implements: FR-VAL-010, FR-VAL-011, NFR-PRO-002 (B7 spec U36)
-- ============================================================================
-- total_value adds each side's known sum and is NULL only when neither side
-- has a known member: a 0 there renders as a figure where the answer is
-- "not known" (U36, FR-VAL-010).
-- CREATE OR REPLACE keeps the view's oid and grants; security_invoker is
-- restated because the command resets every option it does not carry.
CREATE OR REPLACE VIEW app.v_estate_valuation WITH (security_invoker = true) AS
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
       CASE WHEN sum(tread_value) IS NULL AND sum(casing_value) IS NULL THEN NULL
            ELSE COALESCE(sum(tread_value), 0) + COALESCE(sum(casing_value), 0)
       END                                                 AS total_value,
       count(*) FILTER (WHERE casing_basis = 'ACTUAL')       AS casing_actual_count,
       count(*) FILTER (WHERE casing_basis = 'ESTIMATED')    AS casing_estimated_count,
       count(*) FILTER (WHERE casing_basis = 'AUDIT')        AS casing_audit_count
  FROM app.v_tyre_valuation
 WHERE state NOT IN ('SCRAPPED', 'LOST', 'SOLD')
 GROUP BY tenant_id,
          GROUPING SETS ((fleet_number), (depot_name), (size_name),
                         (brand_name), (pattern_name), ()),
          ROLLUP(state);
