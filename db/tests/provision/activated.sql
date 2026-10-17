-- Activation as docs/runbooks/provision-a-tenant.md step 5 runs it
-- (TYRE-387 option A), on tyre_provision (TYRE-374). Each block raises
-- FAIL A<n>.
--
-- Variables: tenant (the id to activate), role (who runs the runbook's
-- transaction), ahead (empty, or a tenant whose fleet is a day ahead and so
-- must hold the later horizon).
\set ON_ERROR_STOP on
SET ROLE :"role";

BEGIN;
SELECT set_config('app.tenant_id', :'tenant', true) AS tenant \g /dev/null
-- The statement provision-a-tenant.md step 5 prints, ended with \gset so a
-- run that touches no row, or more than one, stops here.
UPDATE app.tenant
   SET state = 'ACTIVE',
       history_horizon = app.tenant_today(timezone)
 WHERE id = app.current_tenant_id() AND state = 'PROVISIONING'
RETURNING id, name, state, history_horizon \gset activated_
SELECT set_config('provision.returned', :'activated_id' || ' ' || :'activated_state' || ' ' || :'activated_history_horizon', true) \g /dev/null
-- 1. The returned row is the bound tenant, ACTIVE, with its horizon today
-- where the fleet is (rule 6, FR-TEN-021).
DO $$
DECLARE
  want text;
BEGIN
  SELECT format('%s ACTIVE %s', t.id, app.tenant_today(t.timezone)) INTO want
    FROM app.tenant t WHERE t.id = app.current_tenant_id();
  IF current_setting('provision.returned') IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL A1: activation returned %, expected %', current_setting('provision.returned'), want;
  END IF;
END $$;
COMMIT;

-- 2. Run again, the statement touches nothing, because it acts only on a
-- tenant in PROVISIONING.
BEGIN;
SELECT set_config('app.tenant_id', :'tenant', true) AS tenant \g /dev/null
DO $$
DECLARE
  n int;
BEGIN
  WITH again AS (
    UPDATE app.tenant
       SET state = 'ACTIVE',
           history_horizon = app.tenant_today(timezone)
     WHERE id = app.current_tenant_id() AND state = 'PROVISIONING'
    RETURNING id)
  SELECT count(*) INTO n FROM again;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL A2: a second activation touched % rows', n;
  END IF;
END $$;
ROLLBACK;
RESET ROLE;

-- 3. Kiritimati is a day ahead of Pago Pago at every instant, so a horizon
-- taken in UTC or in one fixed zone cannot hold the later date for it.
\o /dev/null
SELECT set_config('provision.tenant', :'tenant', false), set_config('provision.ahead', :'ahead', false);
\o
DO $$
DECLARE
  this date;
  later date;
BEGIN
  IF current_setting('provision.ahead') = '' THEN
    RETURN;
  END IF;
  SELECT history_horizon INTO this FROM app.tenant WHERE id = current_setting('provision.tenant')::uuid;
  SELECT history_horizon INTO later FROM app.tenant WHERE id = current_setting('provision.ahead')::uuid;
  IF later IS NULL OR this IS NULL OR later <= this THEN
    RAISE EXCEPTION 'FAIL A3: horizon % is not later than %', later, this;
  END IF;
END $$;

\echo 'activated: all checks passed'
