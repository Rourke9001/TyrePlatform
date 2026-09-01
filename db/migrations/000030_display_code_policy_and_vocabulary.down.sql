-- Reverses 000030. A type can only be dropped once every column using it is
-- gone, so this is not simply the up.sql groups in reverse order — it
-- interleaves: the vocabulary CHECKs first (no dependency), then each column
-- before its own type.
ALTER TABLE app.tyre_event
  DROP CONSTRAINT sold_carries_proceeds,
  DROP CONSTRAINT state_change_carries_to_state,
  DROP CONSTRAINT tyre_event_type_in_vocabulary;

ALTER TABLE app.fitment DROP COLUMN mount_orientation;
DROP TYPE app.mount_orientation;

-- The RLS policy and grant fall with the table.
DROP TABLE app.display_code_counter;

ALTER TABLE app.tenant DROP COLUMN display_code_policy;
DROP TYPE app.display_code_policy;
