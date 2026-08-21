GRANT DELETE ON app.app_user TO app_rw;

DROP POLICY tenant_isolation ON app.user_depot;
ALTER TABLE app.user_depot NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.user_depot DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_depot DROP COLUMN created_at;
ALTER TABLE app.user_depot DROP COLUMN tenant_id;
