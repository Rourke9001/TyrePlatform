-- 000059 down. Drops what the up created, in the reverse of its order,
-- proved by catalogue against a baseline taken before the up ran
-- (docs/lessons.md, 2026-09-15 and 2026-10-01).

DROP VIEW app.v_tyre_price_list_in_force;
DROP VIEW app.v_threshold_policy_in_force;
DROP FUNCTION app.tenant_days_since(timestamptz);
ALTER TABLE app.tenant DROP CONSTRAINT tenant_metric_units;
DROP VIEW app.v_tenant_consent_current;
DROP FUNCTION app.record_consent(text, boolean, text, timestamptz);
DROP TRIGGER tenant_consent_written_once ON app.tenant_consent;
DROP FUNCTION app.tenant_consent_is_written_once();
ALTER TABLE app.tenant_consent DROP CONSTRAINT tenant_consent_purpose_code_check;
