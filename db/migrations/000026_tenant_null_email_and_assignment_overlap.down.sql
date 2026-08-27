ALTER TABLE app.vehicle_driver DROP CONSTRAINT IF EXISTS vehicle_driver_no_overlap;
DROP INDEX IF EXISTS app.app_user_platform_admin_email_key;

-- btree_gist is deliberately left installed. db/CLAUDE.md: migrations never
-- DROP what they did not create, and the up says CREATE EXTENSION IF NOT
-- EXISTS — so it may have predated this migration.
