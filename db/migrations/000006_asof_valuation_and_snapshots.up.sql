-- ============================================================================
--  As-at valuation and snapshot persistence (TYRE-33)
--  Implements: FR-VAL-020..022 (UC-04), FR-VAL-021 staleness indication.
--  app.tyre_valuation_asof() becomes the ONE implementation of the register
--  row shape — v_tyre_valuation is redefined as its today-slice — so the
--  "when is a tyre valued" guards cannot drift between current and
--  historical valuation (the drift class TYRE-32's audit caught once).
-- ============================================================================

-- Threshold for an explicit tenant at an explicit moment. The trigger below
-- runs in a definer chain where the session GUC may not name the row's
-- tenant, and as-at valuation needs the policy effective at the REQUESTED
-- date (FR-CFG-010; a 2024 valuation under a 2026 policy would be revisionism).
-- Strict '<' with an exclusive upper bound: callers pass the first instant
-- beyond the period they are valuing.
CREATE FUNCTION app.removal_threshold_mm_for(p_tenant uuid, p_before timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (c.value #>> '{}')::numeric
    FROM app.configuration c
   WHERE c.tenant_id = p_tenant
     AND c.key = 'removal_threshold_mm'
     AND c.effective_from < p_before
   ORDER BY c.effective_from DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.current_removal_threshold_mm() RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT app.removal_threshold_mm_for(app.current_tenant_id(), now())
$$;

-- The register as at any date (FR-VAL-020): reading, fitment, policy and
-- staleness all resolved at p_as_at. Invoker rights — RLS scopes every
-- underlying table to the session tenant. The audit fallback
-- (tyre.last_tread_mm) is date-blind: an onboarding value carries no
-- timestamp, so it stands in at any date (FR-TYR-030..034).
CREATE FUNCTION app.tyre_valuation_asof(p_as_at date)
RETURNS TABLE (tenant_id uuid, tyre_id uuid, branded_number text, size_name text,
               brand_name text, pattern_name text, status app.tyre_status,
               retread_count int, state app.tyre_state, vehicle_id uuid,
               fleet_number text, position_code text, depot_id uuid, depot_name text,
               current_tread_mm numeric, tread_source text, read_at timestamptz,
               rand_per_mm numeric, removal_threshold_mm numeric,
               valuation_complete boolean, tread_value numeric,
               casing_value numeric, total_value numeric, stale boolean)
LANGUAGE sql STABLE AS $$
  SELECT t.tenant_id,
         t.id,
         t.branded_number,
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
         t.valuation_complete,
         -- no configured policy means unvalued, never a silently zero-priced
         -- estate: GREATEST(0, NULL) is 0 (see 000005's resolver note)
         CASE WHEN t.valuation_complete AND thr.mm IS NOT NULL
               AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
              THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                   thr.mm, t.rand_per_mm) END,
         t.casing_value,
         CASE WHEN t.valuation_complete AND thr.mm IS NOT NULL
               AND COALESCE(lr.governing_tread_mm, t.last_tread_mm) IS NOT NULL
              THEN app.tread_value(COALESCE(lr.governing_tread_mm, t.last_tread_mm),
                                   thr.mm, t.rand_per_mm) + t.casing_value END,
         -- FR-VAL-021: value from an old reading, but say so. NULL when no
         -- reading or no configured staleness policy — unknown, not fresh.
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
$$;

-- The live register is the today-slice of the same implementation. Casts
-- restate the column types 000005 declared: CREATE OR REPLACE VIEW demands
-- exact types, and a function result column carries no typmod.
CREATE OR REPLACE VIEW app.v_tyre_valuation WITH (security_invoker = true) AS
SELECT tenant_id, tyre_id, branded_number, size_name, brand_name, pattern_name,
       status, retread_count, state, vehicle_id, fleet_number, position_code,
       depot_id, depot_name,
       current_tread_mm::numeric(4,1) AS current_tread_mm,
       tread_source, read_at,
       rand_per_mm::numeric(12,4) AS rand_per_mm,
       removal_threshold_mm, valuation_complete, tread_value,
       casing_value::numeric(12,2) AS casing_value,
       total_value
  FROM app.tyre_valuation_asof((now() AT TIME ZONE 'UTC')::date);

-- FR-VAL-022, change-driven half: a snapshot lands when a reading's
-- governing value lands, dated to its inspection. Skips when the value
-- equals the tyre's most recent snapshot (no unchanged snapshots); a
-- late-synced older inspection that would only restate that value is
-- likewise skipped — snapshots are a derivable cache of the readings,
-- never the record of fact. Executes inside refresh_governing_tread()'s
-- definer chain, so the threshold resolves by the row's own tenant_id,
-- not the session GUC — and at the snapshot's own date, not sync time:
-- offline capture routinely lands an inspection after a policy change, and
-- pricing it at now() would backdate the later policy onto a day it did not
-- govern (FR-CFG-010).
CREATE FUNCTION app.snapshot_on_governing_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE thr numeric; rate numeric; casing numeric; complete boolean;
        last_mm numeric; snap_date date;
BEGIN
  IF NEW.tyre_id IS NULL OR NEW.governing_tread_mm IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT (i.submitted_at AT TIME ZONE 'UTC')::date INTO snap_date
    FROM app.inspection i WHERE i.id = NEW.inspection_id;
  thr := app.removal_threshold_mm_for(NEW.tenant_id,
                                      ((snap_date + 1)::timestamp AT TIME ZONE 'UTC'));
  -- tyre lookup last of the three: FOUND below must report on it, and a
  -- SELECT INTO in between would rebind FOUND to the wrong statement
  SELECT t.rand_per_mm, t.casing_value, t.valuation_complete
    INTO rate, casing, complete FROM app.tyre t WHERE t.id = NEW.tyre_id;
  IF NOT FOUND OR NOT complete OR thr IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT s.tread_mm INTO last_mm FROM app.valuation_snapshot s
   WHERE s.tyre_id = NEW.tyre_id ORDER BY s.as_at DESC LIMIT 1;
  IF last_mm IS NOT DISTINCT FROM NEW.governing_tread_mm THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.valuation_snapshot (tenant_id, tyre_id, as_at, tread_mm, tread_value, casing_value)
  VALUES (NEW.tenant_id, NEW.tyre_id, snap_date, NEW.governing_tread_mm,
          app.tread_value(NEW.governing_tread_mm, thr, rate), casing)
  ON CONFLICT (tyre_id, as_at) DO UPDATE
    SET tread_mm = EXCLUDED.tread_mm,
        tread_value = EXCLUDED.tread_value,
        casing_value = EXCLUDED.casing_value;
  RETURN NULL;
END $$;

CREATE TRIGGER reading_snapshots_governing_change
AFTER UPDATE OF governing_tread_mm ON app.reading
FOR EACH ROW WHEN (OLD.governing_tread_mm IS DISTINCT FROM NEW.governing_tread_mm)
EXECUTE FUNCTION app.snapshot_on_governing_change();

-- FR-VAL-022, month-end half: one snapshot per VALUED tyre — the table's
-- NOT NULL tread_value forces that; an unvalued tyre has no figure worth
-- freezing. Scheduling is the platform's job (FR-VAL-022 names the cadence);
-- this is only the idempotent pass it invokes. Invoker rights: it writes
-- the calling tenant's rows under RLS.
CREATE FUNCTION app.take_valuation_snapshots(p_as_at date) RETURNS int
LANGUAGE sql AS $$
  WITH ins AS (
    INSERT INTO app.valuation_snapshot (tenant_id, tyre_id, as_at, tread_mm, tread_value, casing_value)
    SELECT tv.tenant_id, tv.tyre_id, p_as_at, tv.current_tread_mm, tv.tread_value, tv.casing_value
      FROM app.tyre_valuation_asof(p_as_at) tv
     WHERE tv.tread_value IS NOT NULL
    ON CONFLICT (tyre_id, as_at) DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;
