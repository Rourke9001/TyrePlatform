-- Restores the state 000052 found: table-level INSERT and UPDATE for app_rw
-- and no column ACLs (a table-level REVOKE also clears column grants), no
-- function, neither index, no column. Proved by catalogue, not by the suite
-- (docs/lessons.md, 2026-09-15).
DROP FUNCTION app.record_session_start();
DROP INDEX app.audit_log_session_start_key;
REVOKE INSERT, UPDATE ON app.app_user FROM app_rw;
GRANT INSERT, UPDATE ON app.app_user TO app_rw;
DROP INDEX app.app_user_tenant_subject_key;
ALTER TABLE app.app_user DROP COLUMN subject;
