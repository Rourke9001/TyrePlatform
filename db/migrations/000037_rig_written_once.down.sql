-- Reverses 000037: drops the two functions that write a rig, the shared
-- day-to-instant helper, the four triggers and their two trigger functions,
-- restores UPDATE on app.combination_member (000001), and clears the
-- TYRE-124 comment correction. The audit rows the triggers wrote stay — a
-- migration that deleted them would be destroying facts, not changing a
-- schema (rule 3, CR-004), the same reasoning 000035's down migration
-- carries for app.vehicle's audit trail.
DROP FUNCTION app.end_combination(uuid, date);
DROP FUNCTION app.create_combination(uuid, jsonb, date);
DROP FUNCTION app.tenant_day_instant(date);

DROP TRIGGER combination_member_audited ON app.combination_member;
DROP TRIGGER combination_audited ON app.combination;
DROP TRIGGER combination_member_in_order ON app.combination_member;
DROP TRIGGER combination_written_once ON app.combination;

DROP FUNCTION app.combination_member_in_order();
DROP FUNCTION app.combination_is_written_once();

GRANT UPDATE ON app.combination_member TO app_rw;

COMMENT ON FUNCTION app.require_odometer_where_unit_has_one() IS NULL;
