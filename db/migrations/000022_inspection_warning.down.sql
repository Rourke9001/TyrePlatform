DROP VIEW IF EXISTS app.v_capture_vehicle;
ALTER TABLE app.reading DROP COLUMN IF EXISTS capture_seconds;
DROP TABLE IF EXISTS app.inspection_warning;
DROP TYPE IF EXISTS app.warning_source;
