-- ============================================================================
--  Tyre register and estate valuation views (TYRE-32)
--  Implements: FR-VAL-001..005, 010..012; FR-TYR-030..034 fallback; the data
--  layer for FR-RPT-020 (survey report R1). FR-VAL-006 (cent-exact
--  reproduction) is pinned by the verification suite, not re-derived here:
--  the views call app.tread_value(), the single implementation of BR-VAL-001.
-- ============================================================================

-- FR-CFG-010 / CR-005: the removal threshold is tenant policy with effective
-- dating, resolved at read time — the literal 4 exists only in test fixtures.
-- Invoker rights on purpose: RLS scopes the lookup to the session tenant
-- (an unset context sees no configuration and no tyres — fails closed,
-- FR-TEN-004). NULL — a tenant with no currently-effective policy row — must
-- be guarded wherever this feeds app.tread_value(): GREATEST(0, NULL) is 0,
-- so an unguarded call silently prices the whole estate at R0.00 tread.
CREATE FUNCTION app.current_removal_threshold_mm() RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (c.value #>> '{}')::numeric
    FROM app.configuration c
   WHERE c.tenant_id = app.current_tenant_id()
     AND c.key = 'removal_threshold_mm'
     AND c.effective_from <= now()
   ORDER BY c.effective_from DESC
   LIMIT 1
$$;

-- The register: every tyre with its location and money. Current tread is
-- DERIVED — the governing value of the most recent non-voided reading — not
-- read from tyre.last_tread_mm, which nothing maintains. last_tread_mm serves
-- only as the onboarding-audit value for stock never yet inspected
-- (FR-TYR-030..034); a tyre with neither is surfaced unvalued rather than
-- silently priced (FR-TYR-032 keeps incomplete records out of totals).
CREATE VIEW app.v_tyre_valuation WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id                AS tyre_id,
       t.branded_number,
       sz.name             AS size_name,
       b.name              AS brand_name,
       pt.name             AS pattern_name,
       t.status,
       t.retread_count,
       t.state,
       f.vehicle_id,
       v.fleet_number,
       pos.code            AS position_code,
       -- fitted tyres sit at the vehicle's home depot; loose stock at its own
       COALESCE(v.home_depot_id, t.current_depot_id) AS depot_id,
       d.name              AS depot_name,
       COALESCE(lr.governing_tread_mm, t.last_tread_mm) AS current_tread_mm,
       CASE WHEN lr.governing_tread_mm IS NOT NULL THEN 'READING'
            WHEN t.last_tread_mm       IS NOT NULL THEN 'AUDIT' END AS tread_source,
       lr.submitted_at     AS read_at,
       t.rand_per_mm,
       thr.removal_threshold_mm,
       t.valuation_complete,
       -- the threshold guard: no configured policy means unvalued, never a
       -- silently zero-priced estate (see the resolver's note above)
       CASE WHEN t.valuation_complete
             AND thr.removal_threshold_mm IS NOT NULL
             AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
            THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                 thr.removal_threshold_mm,
                                 t.rand_per_mm) END AS tread_value,
       t.casing_value,
       -- BR-VAL-003: NULL, not casing alone, when the tread side is unknown —
       -- a per-tyre total that is really half a total misleads
       CASE WHEN t.valuation_complete
             AND thr.removal_threshold_mm IS NOT NULL
             AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
            THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                 thr.removal_threshold_mm,
                                 t.rand_per_mm) + t.casing_value END AS total_value
  FROM app.tyre t
  CROSS JOIN LATERAL (SELECT app.current_removal_threshold_mm() AS removal_threshold_mm) thr
  LEFT JOIN app.tyre_size    sz ON sz.id = t.size_id
  LEFT JOIN app.tyre_brand   b  ON b.id  = t.brand_id
  LEFT JOIN app.tyre_pattern pt ON pt.id = t.pattern_id
  LEFT JOIN app.fitment f  ON f.tyre_id = t.id AND f.removed_at IS NULL
  LEFT JOIN app.vehicle v  ON v.id  = f.vehicle_id
  LEFT JOIN app.position pos ON pos.id = f.position_id
  LEFT JOIN app.depot d ON d.id = COALESCE(v.home_depot_id, t.current_depot_id)
  LEFT JOIN LATERAL (
       SELECT r.governing_tread_mm, i.submitted_at
         FROM app.reading r
         JOIN app.inspection i ON i.id = r.inspection_id
        WHERE r.tyre_id = t.id
          AND i.state <> 'VOIDED'
          AND r.governing_tread_mm IS NOT NULL
        ORDER BY i.submitted_at DESC
        LIMIT 1) lr ON true;

-- Estate aggregation (FR-VAL-010), tread and casing as separate columns at
-- every level (FR-VAL-011). location_class keeps stock, retreader and
-- breakdown tyres in the estate but identified apart from fitted
-- (FR-VAL-012); 'ALL' rows are the rollup. Scrapped and lost tyres are not
-- estate. Names are safe grouping keys: each is UNIQUE per tenant.
-- Total semantics: tread over valued tyres plus casing over ALL estate tyres
-- — casing is a stored fact even where the tread side is unknown — so the
-- total exceeds the sum of per-tyre totals (NULL for unvalued rows) by
-- exactly the unvalued casing; unvalued_count is the flag that says so.
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
