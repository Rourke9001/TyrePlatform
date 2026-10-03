-- ============================================================================
--  The governing-tread definer chain names its tenant (TYRE-259)
--  Implements: FR-VAL-006, CR-011, DR-017; rule 1
-- ============================================================================
-- Everything refresh_governing_tread reaches runs with RLS off, so its
-- lookups name their tenant in the text (db/CLAUDE.md, Adding a function;
-- TYRE-259 carries the measurements). Each predicate is one a composite FK
-- (000004) already holds, so no row moves. tyre_in_estate_asof and a fitment
-- index are still open (TYRE-347).
--
-- The latest-reading lookup also takes v_exception's tiebreaker, the one
-- change in meaning here: a submitted_at tie resolves as 000045 resolves it
-- instead of by plan (TYRE-348). The fixture holds no such tie.

-- CREATE OR REPLACE resets every property the command omits, so SECURITY
-- DEFINER and the pinned search_path are restated (docs/lessons.md,
-- 2026-09-15).
CREATE OR REPLACE FUNCTION app.refresh_governing_tread() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE target uuid; row_tenant uuid; target_tenant uuid;
BEGIN
  target     := COALESCE(NEW.reading_id, OLD.reading_id);
  row_tenant := COALESCE(NEW.tenant_id,  OLD.tenant_id);
  SELECT r.tenant_id INTO target_tenant FROM app.reading r WHERE r.id = target;
  -- No reading left means this measurement is being cascade-deleted with its
  -- reading: nothing to guard, nothing to refresh.
  IF target_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  IF target_tenant <> row_tenant THEN
    RAISE EXCEPTION 'reading_measurement tenant does not match reading tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- row_tenant gives the MIN() the unique key's leading column; RLS does not
  -- bind a definer (TYRE-259).
  UPDATE app.reading r
     SET governing_tread_mm = (SELECT min(m.tread_mm)
                                 FROM app.reading_measurement m
                                WHERE m.tenant_id = row_tenant
                                  AND m.reading_id = target)
   WHERE r.id = target;
  RETURN NULL;
END $$;

-- LANGUAGE sql, invoker and no SET clause, so the views still inline it
-- (db/CLAUDE.md, Adding a function).
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
         COALESCE(lr.governing_tread_mm, fb.mm),
         CASE WHEN lr.governing_tread_mm IS NOT NULL THEN 'READING'
              WHEN fb.mm                 IS NOT NULL THEN 'AUDIT' END,
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
    -- FR-VAL-020, U10. The fallback is a dated measurement, so it answers
    -- only from the UTC day its instant falls in onward; before that the tyre
    -- is UNVALUED rather than priced at a tread nobody had measured yet. UTC
    -- day, not tenant date. See the header on the one-day over-reach that
    -- costs a backdated event east of UTC (TYRE-123).
    -- Strict '<' against bound.ts, matching the reading join below: bound.ts
    -- is the exclusive upper edge of p_as_at, so '<' is how this function
    -- already spells 'on or before p_as_at'. A NULL last_tread_at is an
    -- undated measurement and is honoured at every date, as the header says.
    CROSS JOIN LATERAL (
         SELECT CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < bound.ts
                     THEN t.last_tread_mm END AS mm) fb
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
    -- f and lr name t's tenant because the definer chain runs this with RLS
    -- off (TYRE-259). f has no index to use it until TYRE-347.
    LEFT JOIN app.fitment f ON f.tenant_id = t.tenant_id AND f.tyre_id = t.id AND f.fitted_at < bound.ts
                           AND (f.removed_at IS NULL OR f.removed_at >= bound.ts)
    LEFT JOIN app.vehicle  v   ON v.id   = f.vehicle_id
    LEFT JOIN app.position pos ON pos.id = f.position_id
    LEFT JOIN app.depot    d   ON d.id   = COALESCE(v.home_depot_id, t.current_depot_id)
    LEFT JOIN LATERAL (
         SELECT r.governing_tread_mm, i.submitted_at
           FROM app.reading r
           JOIN app.inspection i ON i.id = r.inspection_id
          WHERE r.tenant_id = t.tenant_id
            AND r.tyre_id = t.id
            AND i.state <> 'VOIDED'
            AND r.governing_tread_mm IS NOT NULL
            AND i.submitted_at < bound.ts
          -- v_latest_unit_inspection's order (000045), so a tyre is valued
          -- on the reading v_exception judges (TYRE-348).
          ORDER BY i.submitted_at DESC, i.received_at DESC, i.id
          LIMIT 1) lr ON true
    CROSS JOIN LATERAL (
         SELECT CASE WHEN t.rand_per_mm IS NOT NULL AND thr.mm IS NOT NULL
                      AND COALESCE(lr.governing_tread_mm, fb.mm) IS NOT NULL
                     THEN app.tread_value(COALESCE(lr.governing_tread_mm, fb.mm),
                                          thr.mm, t.rand_per_mm) END AS val) tv
    -- current casing value = the latest valuation event as at the date
    -- (CHG-016), labelled by its source; the size estimate and the onboarding
    -- audit figure are fallbacks, each under its own label, never blended
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
