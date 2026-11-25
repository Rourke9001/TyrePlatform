-- Two tenants planted as postgres at version 66, for 000067_after.sql to
-- read once the migration has run (TYRE-240, scripts/provision-tenant.test.sh
-- step 17): one with removal reasons in force, whose words the up gives, and
-- one with none, which it leaves alone.
INSERT INTO app.tenant (id, name, subdomain, timezone, state) VALUES
  (md5('m67')::uuid, 'Labels Backfill', 'labels-backfill', 'Africa/Johannesburg', 'ACTIVE'),
  (md5('m67-none')::uuid, 'Labels None', 'labels-none', 'Africa/Johannesburg', 'ACTIVE');
INSERT INTO app.configuration (tenant_id, key, value, effective_from)
VALUES (md5('m67')::uuid, 'removal_reasons', '["damage", "puncture"]'::jsonb, '2024-01-01T00:00:00Z');
