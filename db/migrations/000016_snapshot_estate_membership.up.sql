-- ============================================================================
--  Month-end snapshots assert estate membership as of their date (TYRE-52)
--  Implements: BR-VAL-008 (errata E1), FR-VAL-022/024
-- ============================================================================

-- A persisted snapshot for a disposed tyre asserts the fleet held that value
-- at month end, which is false, and FR-VAL-024's interpolated trend then
-- carries it. Membership must be judged AS OF the snapshot date via the event
-- history, not from tyre.state: reconcile is a repair duty that re-runs for
-- old dates, and judging by current state would delete the valid August
-- snapshot of a tyre scrapped in September.
--
-- BR-VAL-008 (errata E1) defines membership by exclusion — any state is in
-- the estate unless it is a disposal — so this tests the disposal set, never
-- a whitelist. A tyre with no state-transition events falls back to the
-- current state, which for such a tyre is the only assertion on record.
--
-- Fail-OPEN by design (COALESCE ... true), which is only safe because every
-- caller tenant-filters its tyre set before asking: an unknown or foreign
-- uuid answers true, so this function must never be the thing that decides
-- whether a tyre exists or belongs to the caller.
CREATE FUNCTION app.tyre_in_estate_asof(p_tyre uuid, p_as_at date)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = app, pg_temp AS $$
  SELECT COALESCE(
           (SELECT e.to_state NOT IN ('SCRAPPED', 'LOST', 'SOLD')
              FROM app.tyre_event e
             WHERE e.tyre_id = p_tyre
               AND e.to_state IS NOT NULL
               AND e.occurred_at < ((p_as_at + 1)::timestamp AT TIME ZONE 'UTC')
             ORDER BY e.occurred_at DESC, e.recorded_at DESC
             LIMIT 1),
           (SELECT t.state NOT IN ('SCRAPPED', 'LOST', 'SOLD')
              FROM app.tyre t
             WHERE t.id = p_tyre
               AND NOT EXISTS (SELECT 1 FROM app.tyre_event e2
                                WHERE e2.tyre_id = p_tyre
                                  AND e2.to_state IS NOT NULL)),
           true)
$$;

-- 000008's reconcile with estate membership applied symmetrically: the repair
-- DELETE removes a snapshot whose tyre was outside the estate at that date,
-- and the INSERT refuses to write one. Everything else is unchanged from
-- 000008, which remains the reference for the cache semantics.
CREATE OR REPLACE FUNCTION app.reconcile_valuation_snapshots(
    p_tenant uuid,
    p_as_at  date,
    p_tyre   uuid DEFAULT NULL,
    p_mode   text DEFAULT 'ALWAYS')
RETURNS int
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE touched int := 0; k int; row_tenant uuid;
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'reconcile_valuation_snapshots requires an explicit tenant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(p_mode, '') NOT IN ('ALWAYS', 'ON_CHANGE', 'NEVER') THEN
    RAISE EXCEPTION 'unknown snapshot creation mode %', p_mode;
  END IF;
  IF p_tyre IS NOT NULL THEN
    SELECT t.tenant_id INTO row_tenant FROM app.tyre t WHERE t.id = p_tyre;
    IF row_tenant IS DISTINCT FROM p_tenant THEN
      RAISE EXCEPTION 'tyre % is not tenant %''s to reconcile', p_tyre, p_tenant
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- A tyre the register does not value at this date has no figure worth
  -- holding, and tread_value is NOT NULL, so the row goes rather than emptying.
  -- Not a DR-014 breach: DR-011 names reading, reading_measurement and
  -- tyre_event as the INSERT-only set and leaves this table out of it, which
  -- is why app_rw holds DELETE here and nowhere near a record of fact.
  DELETE FROM app.valuation_snapshot s
   WHERE s.tenant_id = p_tenant
     AND s.as_at = p_as_at
     AND (p_tyre IS NULL OR s.tyre_id = p_tyre)
     AND NOT EXISTS (SELECT 1 FROM app.tyre_valuation_asof(p_as_at) tv
                      WHERE tv.tyre_id = s.tyre_id
                        AND tv.tenant_id = p_tenant
                        AND tv.tread_value IS NOT NULL
                        AND app.tyre_in_estate_asof(tv.tyre_id, p_as_at));
  GET DIAGNOSTICS k = ROW_COUNT; touched := touched + k;

  INSERT INTO app.valuation_snapshot (tenant_id, tyre_id, as_at, tread_mm, tread_value, casing_value)
  SELECT p_tenant, tv.tyre_id, p_as_at, tv.current_tread_mm, tv.tread_value, tv.casing_value
    FROM app.tyre_valuation_asof(p_as_at) tv
   WHERE tv.tenant_id = p_tenant
     AND (p_tyre IS NULL OR tv.tyre_id = p_tyre)
     AND tv.tread_value IS NOT NULL
     AND app.tyre_in_estate_asof(tv.tyre_id, p_as_at)
     AND (p_mode = 'ALWAYS'
          -- a row that already exists is repaired whatever the mode: repair is
          -- the duty every caller shares
          OR EXISTS (SELECT 1 FROM app.valuation_snapshot s
                      WHERE s.tenant_id = p_tenant
                        AND s.tyre_id = tv.tyre_id
                        AND s.as_at = p_as_at)
          -- the tyre's most recent snapshot, not the one preceding this date:
          -- a late-synced older inspection restating a value already on record
          -- is not a change either (000006's rule, kept deliberately)
          OR (p_mode = 'ON_CHANGE'
              AND (SELECT s.tread_mm FROM app.valuation_snapshot s
                    WHERE s.tenant_id = p_tenant AND s.tyre_id = tv.tyre_id
                    ORDER BY s.as_at DESC LIMIT 1) IS DISTINCT FROM tv.current_tread_mm))
  ON CONFLICT (tyre_id, as_at) DO UPDATE
    SET tread_mm     = EXCLUDED.tread_mm,
        tread_value  = EXCLUDED.tread_value,
        casing_value = EXCLUDED.casing_value;
  GET DIAGNOSTICS k = ROW_COUNT; touched := touched + k;

  RETURN touched;
END $$;
