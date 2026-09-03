-- Reverses 000032: drops the trigger/function pair, then narrows the
-- vocabulary CHECK back to 000030's list. The narrowed CHECK cannot be
-- re-added once a real SENT_TO_BREAKDOWN_SUPPLIER event has been written —
-- the ALTER TABLE ... ADD CONSTRAINT below would fail against any row this
-- migration's value made possible, same as any other CHECK narrowing.
DROP TRIGGER fitment_written_once ON app.fitment;
DROP FUNCTION app.fitment_is_written_once();

ALTER TABLE app.fitment DROP CONSTRAINT removal_does_not_predate_fitment;

ALTER TABLE app.tyre_event DROP CONSTRAINT tyre_event_type_in_vocabulary;
ALTER TABLE app.tyre_event
  ADD CONSTRAINT tyre_event_type_in_vocabulary CHECK (type IN
    ('RECEIVED','BRANDED','FITTED','ROTATED','REMOVED','SENT_FOR_RETREAD',
     'RETURNED','REFITTED','INSPECTED','SCRAPPED','SOLD','LOST'));
