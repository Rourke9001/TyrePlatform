ALTER TABLE app.vehicle ALTER COLUMN unit_kind DROP NOT NULL;

-- 000042 down. DELETE on app.tenant stays revoked: 000018 took it.
GRANT INSERT, UPDATE ON app.tenant TO app_rw;
