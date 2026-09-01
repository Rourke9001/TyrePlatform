-- ============================================================================
--  Tenant-first unique keys (TYRE-87)
--  Implements: the D9 disposition of the tenant-key sweep (004_tests.sql
--  section 37).
-- ============================================================================

-- Each of these unique/exclusion keys omitted tenant_id, so its
-- duplicate-key check fires during index insertion -- before RLS and before
-- the composite FK's AFTER ROW trigger -- letting a caller who supplies the
-- non-tenant columns learn whether another tenant already holds that
-- combination (23505) rather than merely an invalid cross-tenant reference
-- (23503). Each key pairs one or more opaque uuids with a caller-chosen
-- natural value (a capture code, a sequence ordinal, a valuation date, a
-- four-tag discriminator), the same shape as vehicle_driver_no_overlap
-- (000026) -- the closed oracle this generalises. The four table
-- constraints (position, combination_member, reading_measurement,
-- valuation_snapshot) keep the table-prefix convention 000004 already uses
-- for its composite keys (axle_configuration_tenant_id_id_key);
-- exception's standalone partial index keeps its own descriptive name
-- instead, called out at its own site below.
ALTER TABLE app.position
  DROP CONSTRAINT position_configuration_id_code_key,
  ADD  CONSTRAINT position_tenant_id_configuration_id_code_key
       UNIQUE (tenant_id, configuration_id, code);

ALTER TABLE app.combination_member
  DROP CONSTRAINT combination_member_combination_id_sequence_key,
  ADD  CONSTRAINT combination_member_tenant_id_combination_id_sequence_key
       UNIQUE (tenant_id, combination_id, sequence);

ALTER TABLE app.reading_measurement
  DROP CONSTRAINT reading_measurement_reading_id_ordinal_key,
  ADD  CONSTRAINT reading_measurement_tenant_id_reading_id_ordinal_key
       UNIQUE (tenant_id, reading_id, ordinal);

-- one_open_exception_per_subject (000001) pairs two opaque uuids (rule_id,
-- subject_id) with a caller-chosen natural value (subject_type, a four-tag
-- text discriminator) -- vehicle_driver_no_overlap's shape (000026), which
-- 000026 already re-keyed despite its own two uuids. subject_id is
-- polymorphic (no REFERENCES, no CHECK tying it to subject_type), so
-- nothing in the schema makes subject_type redundant. Kept its descriptive
-- name and exact partial WHERE clause from 000001: the business rule it
-- enforces is unchanged, only the leading column.
DROP INDEX app.one_open_exception_per_subject;
CREATE UNIQUE INDEX one_open_exception_per_subject
  ON app.exception (tenant_id, rule_id, subject_type, subject_id)
  WHERE state IN ('RAISED','ACKNOWLEDGED','ACTIONED');

-- valuation_snapshot (tyre_id, as_at) is TYRE-87's named case, empirically
-- confirmed rather than assumed: a tenant-2 session inserting a tenant-1
-- tyre_id/as_at pair read off that tenant's own row got back 23505
-- (duplicate key on this constraint) -- the composite FK on
-- (tenant_id, tyre_id) never got a chance to fire its own 23503.
ALTER TABLE app.valuation_snapshot
  DROP CONSTRAINT valuation_snapshot_tyre_id_as_at_key,
  ADD  CONSTRAINT valuation_snapshot_tenant_id_tyre_id_as_at_key
       UNIQUE (tenant_id, tyre_id, as_at);

-- app.reconcile_valuation_snapshots (live version: 000016) is the only
-- writer of this table and the only place ON CONFLICT names the
-- constraint's column list by value -- PostgreSQL infers the arbiter index
-- from the exact column set, so the old (tyre_id, as_at) target now matches
-- no constraint and every call would fail with "no unique or exclusion
-- constraint matching the ON CONFLICT specification" instead of upserting.
-- Restated from 000016 -- its inline rationale comments live there, not
-- repeated here -- with one functional change: the ON CONFLICT target.
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
  ON CONFLICT (tenant_id, tyre_id, as_at) DO UPDATE
    SET tread_mm     = EXCLUDED.tread_mm,
        tread_value  = EXCLUDED.tread_value,
        casing_value = EXCLUDED.casing_value;
  GET DIAGNOSTICS k = ROW_COUNT; touched := touched + k;

  RETURN touched;
END $$;
