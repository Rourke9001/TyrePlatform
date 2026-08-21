-- ============================================================================
--  Snapshot / register precedence (TYRE-37)
--  Implements: FR-VAL-022, NFR-CST-003, BR-VAL-007.
--  A valuation_snapshot row is a CACHE of app.tyre_valuation_asof(), never an
--  independent record of fact. Wherever the two disagree the register wins,
--  and every write path derives its row from the register rather than from
--  whatever the caller happened to be holding. 000006 states the principle
--  ("a derivable cache of the readings, never the record of fact"); a cache
--  with no refresh path is not one, so the refresh path is here.
--
--  Two divergences this closes, both reproduced against the fixture:
--    * two inspections of one tyre on one day syncing out of order — the day
--      belongs to the greatest submitted_at (BR-VAL-007), not to whichever
--      reading reached the server last;
--    * an inspection VOIDed after its reading snapshotted — voiding leaves
--      governing_tread_mm untouched, so no reading-driven trigger can notice
--      it at all.
--
--  Accepted consequence of cache semantics: tyre_valuation_asof() reads
--  rand_per_mm and casing_value off the CURRENT tyre row, so correcting a
--  rate recomputes that tyre's history on the next reconcile of each date.
--  Reproducible historical pricing would need rate history on the tyre
--  (cf. FR-CFG-042 for price lists); TYRE-37 records why that is not this
--  ticket.
-- ============================================================================

-- The one place a valuation_snapshot row is written, so the arithmetic cannot
-- drift between the write paths — the drift class TYRE-32's audit caught,
-- held closed for the register by 000006 and for the cache here.
--
-- p_tenant is load-bearing, not decoration. This runs both under RLS (the
-- month-end pass, as app_rw) and inside refresh_governing_tread()'s SECURITY
-- DEFINER chain, where RLS never binds — 000004 states that reasoning at the
-- function itself. Every statement below therefore carries the tenant in its
-- own predicate rather than trusting a policy that is only sometimes there.
--
-- p_mode exists because the three callers have three different rights to
-- CREATE a row, while all three have the same duty to repair one:
--   ALWAYS    month-end. FR-VAL-022 wants a row per valued tyre, changed or not.
--   ON_CHANGE the reading trigger. NFR-CST-003 forbids restating a value the
--             tyre's most recent snapshot already carries.
--   NEVER     the void trigger. Voiding retracts a reading; it must not mint
--             snapshots that were never taken.
CREATE FUNCTION app.reconcile_valuation_snapshots(
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
                        AND tv.tread_value IS NOT NULL);
  GET DIAGNOSTICS k = ROW_COUNT; touched := touched + k;

  INSERT INTO app.valuation_snapshot (tenant_id, tyre_id, as_at, tread_mm, tread_value, casing_value)
  SELECT p_tenant, tv.tyre_id, p_as_at, tv.current_tread_mm, tv.tread_value, tv.casing_value
    FROM app.tyre_valuation_asof(p_as_at) tv
   WHERE tv.tenant_id = p_tenant
     AND (p_tyre IS NULL OR tv.tyre_id = p_tyre)
     AND tv.tread_value IS NOT NULL
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

-- FR-VAL-022, change-driven half. Derives from the register rather than from
-- NEW, so which reading governs the day is decided by submitted_at and the
-- order the phones happened to sync in stops mattering — out-of-order sync is
-- the normal operating mode of an offline-first capture app, not an anomaly.
-- Still runs inside refresh_governing_tread()'s definer chain, so it hands the
-- row's own tenant down rather than reading the session GUC, and prices at the
-- snapshot's own date rather than at sync time (FR-CFG-010).
CREATE OR REPLACE FUNCTION app.snapshot_on_governing_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE snap_date date;
BEGIN
  IF NEW.tyre_id IS NULL OR NEW.governing_tread_mm IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT (i.submitted_at AT TIME ZONE 'UTC')::date INTO snap_date
    FROM app.inspection i WHERE i.id = NEW.inspection_id;
  PERFORM app.reconcile_valuation_snapshots(NEW.tenant_id, snap_date, NEW.tyre_id, 'ON_CHANGE');
  RETURN NULL;
END $$;

-- Voiding excludes a reading from analytics without altering it (SRS glossary),
-- so nothing on the reading changes and no reading-driven trigger can fire.
-- The repair has to hang off the state transition itself, in both directions:
-- un-voiding is the same divergence mirrored.
--
-- Every snapshot at or after the inspection's date, not just the one on it: a
-- month-end row taken later inherited the value of the reading being retracted.
-- Invoker rights, unlike its sibling on reading_measurement — the row being
-- updated is the caller's own tenant's, so RLS binds and is welcome to.
CREATE FUNCTION app.repair_snapshots_on_inspection_state() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE rec record;
BEGIN
  FOR rec IN
    SELECT DISTINCT s.tyre_id, s.as_at
      FROM app.reading r
      JOIN app.valuation_snapshot s
        ON s.tyre_id = r.tyre_id AND s.tenant_id = r.tenant_id
     WHERE r.inspection_id = NEW.id
       AND r.tenant_id = NEW.tenant_id
       AND s.as_at >= (NEW.submitted_at AT TIME ZONE 'UTC')::date
  LOOP
    PERFORM app.reconcile_valuation_snapshots(NEW.tenant_id, rec.as_at, rec.tyre_id, 'NEVER');
  END LOOP;
  RETURN NULL;
END $$;

CREATE TRIGGER inspection_state_repairs_snapshots
AFTER UPDATE OF state ON app.inspection
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state
                   AND (OLD.state = 'VOIDED' OR NEW.state = 'VOIDED'))
EXECUTE FUNCTION app.repair_snapshots_on_inspection_state();

-- FR-VAL-022, month-end half: a reconcile pass, not a first-write-wins one.
-- Re-running it for a date brings every row standing there back to the
-- register, which is what makes a written snapshot correctable at all.
-- Returns rows created or repaired. Scheduling stays the platform's job.
CREATE OR REPLACE FUNCTION app.take_valuation_snapshots(p_as_at date) RETURNS int
LANGUAGE sql AS $$
  SELECT app.reconcile_valuation_snapshots(app.current_tenant_id(), p_as_at, NULL, 'ALWAYS')
$$;
