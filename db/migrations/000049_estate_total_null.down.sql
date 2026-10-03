-- 000049 down. Restores the state the up migration found: the view as 000045
-- left it. No later migration altered, commented or granted on it; its ACL
-- {app_rw=r} comes from 000001's default privileges and CREATE OR REPLACE
-- keeps it. The body is the catalogue's
-- rendering taken before 000049 ran, so down then up returns the same
-- definition byte for byte (docs/lessons.md, 2026-09-15).
CREATE OR REPLACE VIEW app.v_estate_valuation WITH (security_invoker = true) AS
 SELECT tenant_id,
        CASE
            WHEN GROUPING(fleet_number) = 0 THEN 'VEHICLE'::text
            WHEN GROUPING(depot_name) = 0 THEN 'DEPOT'::text
            WHEN GROUPING(size_name) = 0 THEN 'SIZE'::text
            WHEN GROUPING(brand_name) = 0 THEN 'BRAND'::text
            WHEN GROUPING(pattern_name) = 0 THEN 'PATTERN'::text
            ELSE 'TENANT'::text
        END AS level,
    COALESCE(fleet_number, depot_name, size_name, brand_name, pattern_name) AS key_name,
        CASE
            WHEN GROUPING(state) = 1 THEN 'ALL'::text
            ELSE state::text
        END AS location_class,
    count(*) AS tyre_count,
    count(*) FILTER (WHERE valuation_basis = 'ACTUAL'::text) AS actual_count,
    count(*) FILTER (WHERE valuation_basis = 'ESTIMATED'::text) AS estimated_count,
    count(*) FILTER (WHERE tread_value IS NULL) AS unvalued_count,
    count(*) FILTER (WHERE casing_value IS NULL) AS casing_unvalued_count,
    sum(tread_value) AS tread_value,
    sum(casing_value) AS casing_value,
    COALESCE(sum(tread_value), 0::numeric) + COALESCE(sum(casing_value), 0::numeric) AS total_value,
    count(*) FILTER (WHERE casing_basis = 'ACTUAL'::text) AS casing_actual_count,
    count(*) FILTER (WHERE casing_basis = 'ESTIMATED'::text) AS casing_estimated_count,
    count(*) FILTER (WHERE casing_basis = 'AUDIT'::text) AS casing_audit_count
   FROM app.v_tyre_valuation
  WHERE state <> ALL (ARRAY['SCRAPPED'::app.tyre_state, 'LOST'::app.tyre_state, 'SOLD'::app.tyre_state])
  GROUP BY tenant_id, GROUPING SETS ((fleet_number), (depot_name), (size_name), (brand_name), (pattern_name), ()), ROLLUP(state);
