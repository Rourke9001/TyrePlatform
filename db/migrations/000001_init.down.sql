-- Everything 000001 creates lives inside the app schema, so one CASCADE
-- undoes it. The roles (app_rw, app_login) are deliberately left in place:
-- they are cluster-level, other databases may share them, and the up
-- migration creates them idempotently.
DROP SCHEMA IF EXISTS app CASCADE;
