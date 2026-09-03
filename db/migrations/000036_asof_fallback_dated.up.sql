-- ============================================================================
--  The as-at register's tread fallback is dated (TYRE-92)
--  Implements: FR-VAL-020, FR-VAL-021, CR-012;
--  U10 (the fitment writers maintain last_tread_mm/last_tread_at)
-- ============================================================================
-- app.fit_tyre, app.remove_tyre, app.rotate_tyres (000033) and an accepted
-- retread return (000034) each write app.tyre.last_tread_mm and stamp
-- last_tread_at with the event's own instant (U10). The column therefore
-- carries a measurement AND when it was taken, and a measurement cannot price
-- a date it precedes: unguarded, one removal logged today puts today's tread
-- on every historical as-at valuation of that casing, including dates years
-- before anyone measured it (FR-VAL-020).
--
-- What the guard compares, stated precisely because the two clocks differ:
-- the stored event INSTANT against bound.ts, the UTC day edge this function
-- already slices every one of its other joins at. It is not a comparison of
-- tenant calendar dates. Any event whose instant falls in a different UTC day
-- from its tenant date is priced from that UTC day: east of UTC that is every
-- instant in the tenant's first offset hours — a return logged at 01:30 SAST
-- stamps in the previous UTC day — and the guaranteed case is a backdated
-- dispatch or return, which 000033/000034 stamp at tenant-zone midnight. A
-- fit, removal or rotation carries the client's own instant (p_occurred_at)
-- and is exposed the same way whenever that instant lands there. One day, in
-- one direction. The over-reach is inherited, not
-- introduced here: bound.ts, the reading join and the fitment join's
-- fitted_at all carry it from 000013, and closing it means giving the
-- function the tenant's calendar rather than a new predicate on this column.
-- Ticketed as TYRE-123.
--
-- The rule is on the date, not on where the figure came from. A row whose
-- last_tread_at is NULL keeps answering for every date, because NULL here is
-- "no date to be before" and not "a date that fails the test" (CR-012:
-- absence is absence, never a value) — which is every row app.receive_tyres
-- writes, and every row of the BAC fixture, none of which carries the pair at
-- all. An onboarding audit that DID record when it was measured is honoured
-- on the same rule and prices from its own date forward, which is the answer
-- a dated measurement has always owed.
--
-- The accepted consequence, stated rather than left to be discovered: for a
-- casing the fitment writers have touched, dates before that write are
-- UNVALUED by this fallback. One column holds one measurement, so the
-- onboarding figure does not survive a later event writing over it — and
-- UNVALUED is a true answer where carrying today's tread into 2021 is a false
-- one. The dated history is on app.fitment already (fitted_tread_mm/fitted_at,
-- removed_tread_mm/removed_at), for an as-at register that resolves tread from
-- events rather than from this column: a follow-up ticket, not this migration.
--
-- tread_source stays 'AUDIT' on this branch. The label says where a figure
-- came from; a fallback that declines to answer yields no figure and no label,
-- not a different label.
--
-- SECURITY INVOKER with no pinned search_path: a LANGUAGE sql table function
-- is inlined into the calling query, and a SET clause blocks that inlining
-- and changes the plan of every view built over it (000006, 000008, 000011).
-- CREATE OR REPLACE keeps the ACL and requires the return shape to be
-- identical, so v_tyre_valuation, v_estate_valuation and the snapshot writers
-- follow without change.
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
    -- day, not tenant date — see the header on the one-day over-reach that
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
                      AND COALESCE(lr.governing_tread_mm, fb.mm) IS NOT NULL
                     THEN app.tread_value(COALESCE(lr.governing_tread_mm, fb.mm),
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

-- The columns say what maintains them, so the contract is discoverable from
-- the database alone. The guard changes nothing for the live register
-- (app.v_tyre_valuation is this function at today's date, where every writer's
-- stamp precedes bound.ts); only a past p_as_at can exclude a measurement.
COMMENT ON COLUMN app.tyre.last_tread_mm IS
  'The casing''s tread as a dated measurement (FR-TYR-016 errata E1, U10): set at onboarding where a tread is known, and maintained thereafter by app.fit_tyre, app.remove_tyre, app.rotate_tyres and an accepted retread return, each writing the event''s own instant to last_tread_at. Ranked below reading: the register (app.tyre_valuation_asof) reads this column only where no reading exists as at the date, whatever the two dates are. The as-at register reads it only from the UTC day last_tread_at falls in onward (FR-VAL-020, TYRE-123 on the one-day over-reach a backdated event east of UTC still costs); the live register (app.v_tyre_valuation) reads it as current tread.';
COMMENT ON COLUMN app.tyre.last_tread_at IS
  'The instant last_tread_mm was measured, stamped by the same writers (U10) and monotonic: a backdated event leaves a newer measurement in place. Drives the AUDIT tread_source label and staleness display (FR-TYR-017), and gates the as-at register''s fallback to the UTC day it falls in and later (FR-VAL-020, TYRE-123). Never a substitute for reading.submitted_at — a reading outranks this pair wherever one exists.';
