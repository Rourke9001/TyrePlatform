-- 000032: a fitment is written once and closed once (rule 3, FR-FIT-014).
--
-- app.fitment is not in the append-only grant set: closing a fitment IS an
-- UPDATE of its removed_* columns, so UPDATE stays granted (000001) and only
-- DELETE is revoked (000018). Nothing else bounds the shape of that UPDATE.
-- This trigger bounds it to one shape: on an open row, the statement that
-- sets removed_at is the only one that may write a removal tread, odometer,
-- reason or distance, and no column of the fitting may move at all. A closed
-- row is frozen entire. Everything else is TY014, and a correction is a
-- compensating event (FR-FIT-015, CR-004).
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
  -- The other half of "closed once": removal_is_complete (000001, narrowed by
  -- 000011) ties removed_at to removal_reason and says nothing about the four
  -- columns beside them, so a distance or a removal tread can be written onto
  -- a row that is still open — a closure figure on a fitment that was never
  -- closed, which the register and the wear rate then read as fact. A closure
  -- column moves only in the statement that sets removed_at.
  IF NEW.removed_at IS NULL
  AND (NEW.removed_odometer IS DISTINCT FROM OLD.removed_odometer
    OR NEW.removed_tread_mm IS DISTINCT FROM OLD.removed_tread_mm
    OR NEW.removal_reason   IS DISTINCT FROM OLD.removal_reason
    OR NEW.distance_km      IS DISTINCT FROM OLD.distance_km
    OR NEW.distance_source  IS DISTINCT FROM OLD.distance_source) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY014',
      MESSAGE = 'an open fitment can only be closed, never edited',
      HINT    = 'a removal tread, distance or reason is part of the closure; set removed_at in the same statement (FR-FIT-014)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fitment_written_once
BEFORE UPDATE ON app.fitment
FOR EACH ROW EXECUTE FUNCTION app.fitment_is_written_once();

-- FR-FIT-016, enforced form. app.remove_tyre and app.rotate_tyres (000033)
-- both refuse a removal instant earlier than the fitment's own fitted_at,
-- but fitment_written_once above still permits the closing UPDATE from any
-- caller, so that refusal is a second implementation the trigger does not
-- itself hold. A closed fitment running backwards makes the as-at register's
-- location join (000036: fitted_at < bound.ts AND (removed_at IS NULL OR
-- removed_at >= bound.ts)) unsatisfiable at any date. No existing closed
-- fitment violates this, so it needs no data migration.
ALTER TABLE app.fitment ADD CONSTRAINT removal_does_not_predate_fitment
  CHECK (removed_at IS NULL OR removed_at >= fitted_at);

-- The dispatch surface (000033) names its own event type per destination
-- rather than the state it moves to, so SENT_TO_BREAKDOWN_SUPPLIER is a value
-- this vocabulary must carry beside SENT_FOR_RETREAD (FR-FIT-013). RETURNED
-- serves every return.
ALTER TABLE app.tyre_event DROP CONSTRAINT tyre_event_type_in_vocabulary;
ALTER TABLE app.tyre_event ADD CONSTRAINT tyre_event_type_in_vocabulary CHECK (type IN
  ('RECEIVED','BRANDED','FITTED','ROTATED','REMOVED','SENT_FOR_RETREAD',
   'SENT_TO_BREAKDOWN_SUPPLIER','RETURNED','REFITTED','INSPECTED','SCRAPPED','SOLD','LOST'));
