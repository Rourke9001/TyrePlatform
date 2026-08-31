-- Restore both email uniqueness rules exactly as 000001 and 000026 left them.
-- The constraint keeps its original generated name so up/down round-trips.
DROP INDEX app.app_user_tenant_email_key;
ALTER TABLE app.app_user
  ADD CONSTRAINT app_user_tenant_id_email_key UNIQUE (tenant_id, email);

DROP INDEX app.app_user_platform_admin_email_key;
CREATE UNIQUE INDEX app_user_platform_admin_email_key
  ON app.app_user (email) WHERE tenant_id IS NULL;
