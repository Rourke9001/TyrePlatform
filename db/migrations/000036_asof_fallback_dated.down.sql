-- Reverses 000036: the register's tread fallback answers for every date again,
-- and the columns carry the 000020 contract.
--
-- Reversal limit, stated: a database that has run the fitment surface holds
-- last_tread_mm values written by fit, removal, rotation and retread return.
-- This migration restores the undated read of that column, so as-at valuations
-- before those events price at the latest measurement again. It does not undo
-- the writes themselves — they are event-driven facts on app.tyre (rule 3).
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

-- app.fit_tyre, app.remove_tyre, app.rotate_tyres and an accepted retread
-- return (000033/000034) write this pair regardless of whether 000036's own
-- objects exist, so the comment below has to hold with only those four
-- writers in place and no as-at register reading it by date.
COMMENT ON COLUMN app.tyre.last_tread_mm IS
  'Onboarding-audit fallback (FR-TYR-016 errata E1), maintained thereafter by the fitment and retread writers (U10). Not a cache of the latest reading — current tread always derives from reading. Read undated: without this migration''s as-at register, every consumer sees only the current value, whatever date it was measured at.';
COMMENT ON COLUMN app.tyre.last_tread_at IS
  'Measurement date accompanying last_tread_mm, maintained by the same writers. Drives the AUDIT tread_source label and staleness display (FR-TYR-017), never a substitute for reading.submitted_at. Read undated without this migration''s as-at register, same as last_tread_mm.';
