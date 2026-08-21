-- Reverses 000006 to the schema exactly as 000005 left it. Snapshot rows the
-- trigger wrote are data, not schema — they stay; make db-reset owns
-- destruction. Order matters: the view must be restored to its 000005 body
-- before tyre_valuation_asof() can be dropped, and the delegating threshold
-- resolver before removal_threshold_mm_for().

DROP TRIGGER reading_snapshots_governing_change ON app.reading;
DROP FUNCTION app.snapshot_on_governing_change();
DROP FUNCTION app.take_valuation_snapshots(date);

-- 000005's view definition, verbatim.
CREATE OR REPLACE VIEW app.v_tyre_valuation WITH (security_invoker = true) AS
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
       COALESCE(v.home_depot_id, t.current_depot_id) AS depot_id,
       d.name              AS depot_name,
       COALESCE(lr.governing_tread_mm, t.last_tread_mm) AS current_tread_mm,
       CASE WHEN lr.governing_tread_mm IS NOT NULL THEN 'READING'
            WHEN t.last_tread_mm       IS NOT NULL THEN 'AUDIT' END AS tread_source,
       lr.submitted_at     AS read_at,
       t.rand_per_mm,
       thr.removal_threshold_mm,
       t.valuation_complete,
       CASE WHEN t.valuation_complete
             AND thr.removal_threshold_mm IS NOT NULL
             AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
            THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                 thr.removal_threshold_mm,
                                 t.rand_per_mm) END AS tread_value,
       t.casing_value,
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

DROP FUNCTION app.tyre_valuation_asof(date);

-- 000005's resolver, verbatim.
CREATE OR REPLACE FUNCTION app.current_removal_threshold_mm() RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (c.value #>> '{}')::numeric
    FROM app.configuration c
   WHERE c.tenant_id = app.current_tenant_id()
     AND c.key = 'removal_threshold_mm'
     AND c.effective_from <= now()
   ORDER BY c.effective_from DESC
   LIMIT 1
$$;

DROP FUNCTION app.removal_threshold_mm_for(uuid, timestamptz);
