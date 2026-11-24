-- ============================================================================
--  A warning and an absent spare are sealed with their inspection (TYRE-325)
--  Implements: DR-021, FR-INS-040, FR-INS-066 v1.4, rule 3; U251.
--  Design: docs/superpowers/specs/2026-11-24-manager-inspection-view-and-void-design.md
-- ============================================================================
-- The manager's inspection page shows each warning as one the driver saw
-- and answered, and each absent spare as the capture's own observation
-- (spec section 4). The revoked UPDATE and DELETE (000022, 000041) hold the
-- rows that exist but not the set, so a row offered after the submit
-- committed would read as the driver's. The seal that holds a reading
-- (000040, TY020) now holds both: app.submit_inspection writes them in the
-- transaction that creates the inspection, and every later INSERT refuses.
-- Suite section 50a probes each table.
--
-- SQLSTATEs (ours; the TY class forwards verbatim, ADR-0012):
--   TY020: a reading, measurement, warning or absent spare offered to an
--           inspection submitted in an earlier transaction (000040)

-- 000040's seal, with the inspection read off the row for every table but
-- reading_measurement, which reaches it through its reading. The message
-- names each table's row in the driver's words.
CREATE OR REPLACE FUNCTION app.inspection_is_sealed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE v_insp uuid; v_created timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'reading_measurement' THEN
    SELECT r.inspection_id INTO v_insp FROM app.reading r WHERE r.id = NEW.reading_id;
  ELSE
    v_insp := NEW.inspection_id;
  END IF;
  SELECT i.created_at INTO v_created FROM app.inspection i WHERE i.id = v_insp;
  -- An unseen or absent parent is the FK's, RLS's or NOT NULL's refusal,
  -- and any instant but this transaction's is refused (000040 says why).
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF v_created IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY020',
      MESSAGE = format('inspection %s was submitted at %s and is sealed; %s cannot be added to it',
                       v_insp, v_created,
                       CASE TG_TABLE_NAME
                         WHEN 'inspection_warning' THEN 'a warning'
                         WHEN 'inspection_absent_spare' THEN 'a spare reported absent'
                         ELSE 'a ' || replace(TG_TABLE_NAME, '_', ' ')
                       END),
      HINT    = 'void the inspection and capture the unit again (FR-INS-012)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inspection_warning_sealed
BEFORE INSERT ON app.inspection_warning
FOR EACH ROW EXECUTE FUNCTION app.inspection_is_sealed();

CREATE TRIGGER inspection_absent_spare_sealed
BEFORE INSERT ON app.inspection_absent_spare
FOR EACH ROW EXECUTE FUNCTION app.inspection_is_sealed();
