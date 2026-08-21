-- ============================================================================
--  Reverse TYRE-37: restore the 000006 write paths verbatim.
--  Snapshot rows this migration repaired stay repaired — they hold values the
--  register agrees with, and reversing a schema change is not a licence to
--  reintroduce arithmetic nobody wants back.
-- ============================================================================

DROP TRIGGER inspection_state_repairs_snapshots ON app.inspection;
DROP FUNCTION app.repair_snapshots_on_inspection_state();

CREATE OR REPLACE FUNCTION app.snapshot_on_governing_change() RETURNS trigger
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

CREATE OR REPLACE FUNCTION app.take_valuation_snapshots(p_as_at date) RETURNS int
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

DROP FUNCTION app.reconcile_valuation_snapshots(uuid, date, uuid, text);
