-- 000032: a fitment is written once and closed once (rule 3, FR-FIT-014).
--
-- app.fitment is not in the append-only grant set: closing a fitment IS an
-- UPDATE of its removed_* columns, so UPDATE stays granted (000001) and only
-- DELETE is revoked (000018). Nothing else bounds the shape of that UPDATE.
-- This trigger permits exactly one shape — an open row gaining its closure —
-- and refuses the rest with TY014. Corrections are compensating events
-- (FR-FIT-015, CR-004).
--
-- The trigger's NAME is load-bearing: BEFORE triggers on one table fire in
-- name order, and fitment_odometer_matches_unit_kind (TY009) must keep
-- firing first so suite section 36 keeps its SQLSTATEs; fitment_stamps_updated
-- writes updated_at/updated_by on every UPDATE, which is why those two
-- columns are excluded from the comparison rather than relying on order.
CREATE FUNCTION app.fitment_is_written_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY014',
      MESSAGE = 'a closed fitment cannot be changed',
      HINT    = 'record a compensating event instead (FR-FIT-015)';
  END IF;
  IF NEW.id                IS DISTINCT FROM OLD.id
  OR NEW.tyre_id           IS DISTINCT FROM OLD.tyre_id
  OR NEW.vehicle_id        IS DISTINCT FROM OLD.vehicle_id
  OR NEW.position_id       IS DISTINCT FROM OLD.position_id
  OR NEW.fitted_at         IS DISTINCT FROM OLD.fitted_at
  OR NEW.fitted_odometer   IS DISTINCT FROM OLD.fitted_odometer
  OR NEW.fitted_tread_mm   IS DISTINCT FROM OLD.fitted_tread_mm
  OR NEW.mount_orientation IS DISTINCT FROM OLD.mount_orientation
  OR NEW.tenant_id         IS DISTINCT FROM OLD.tenant_id
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  OR NEW.created_by        IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY014',
      MESSAGE = 'an open fitment can only be closed, never edited',
      HINT    = 'close it with a reason and fit again; a flip is a remove-and-fit (D13)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fitment_written_once
BEFORE UPDATE ON app.fitment
FOR EACH ROW EXECUTE FUNCTION app.fitment_is_written_once();

-- dispose_tyre writes the target state's name as the event type, so every
-- dispatch destination needs a value (FR-FIT-013). RETURNED serves every
-- return.
ALTER TABLE app.tyre_event DROP CONSTRAINT tyre_event_type_in_vocabulary;
ALTER TABLE app.tyre_event ADD CONSTRAINT tyre_event_type_in_vocabulary CHECK (type IN
  ('RECEIVED','BRANDED','FITTED','ROTATED','REMOVED','SENT_FOR_RETREAD',
   'SENT_TO_BREAKDOWN_SUPPLIER','RETURNED','REFITTED','INSPECTED','SCRAPPED','SOLD','LOST'));
