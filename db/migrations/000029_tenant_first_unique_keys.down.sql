-- Restores the pre-000029 constraint shapes and, for
-- app.reconcile_valuation_snapshots, its 000016 body -- its inline
-- rationale comments live there, not repeated here -- with ON CONFLICT
-- back on (tyre_id, as_at). The mirror image of the up migration, nothing
-- more.

ALTER TABLE app.position
  DROP CONSTRAINT position_tenant_id_configuration_id_code_key,
  ADD  CONSTRAINT position_configuration_id_code_key
       UNIQUE (configuration_id, code);

ALTER TABLE app.combination_member
  DROP CONSTRAINT combination_member_tenant_id_combination_id_sequence_key,
  ADD  CONSTRAINT combination_member_combination_id_sequence_key
       UNIQUE (combination_id, sequence);

ALTER TABLE app.reading_measurement
  DROP CONSTRAINT reading_measurement_tenant_id_reading_id_ordinal_key,
  ADD  CONSTRAINT reading_measurement_reading_id_ordinal_key
       UNIQUE (reading_id, ordinal);

DROP INDEX app.one_open_exception_per_subject;
CREATE UNIQUE INDEX one_open_exception_per_subject
  ON app.exception (rule_id, subject_type, subject_id)
  WHERE state IN ('RAISED','ACKNOWLEDGED','ACTIONED');

ALTER TABLE app.valuation_snapshot
  DROP CONSTRAINT valuation_snapshot_tenant_id_tyre_id_as_at_key,
  ADD  CONSTRAINT valuation_snapshot_tyre_id_as_at_key
       UNIQUE (tyre_id, as_at);

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
          OR EXISTS (SELECT 1 FROM app.valuation_snapshot s
                      WHERE s.tenant_id = p_tenant
                        AND s.tyre_id = tv.tyre_id
                        AND s.as_at = p_as_at)
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
