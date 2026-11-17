-- Reverses 000062 to 000061's state. Each function it restores is its source
-- migration's text, byte for byte: scripts/provision-tenant.test.sh step 17
-- compares md5(prosrc) with version 61's.

DROP TRIGGER tenant_consent_not_future_dated ON app.tenant_consent;
DROP FUNCTION app.tenant_consent_is_not_future_dated();
