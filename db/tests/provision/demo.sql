-- The demonstration tenant as db/seeds/demo_tenant.sql loads it on
-- tyre_demo (OR-TRN-003, U92, U116; TYRE-374). Runs as postgres; the
-- figures are read under app_login so RLS binds them. Each block raises
-- FAIL D<n>.
\set ON_ERROR_STOP on

-- 1. One tenant, under the fixture's id and the demonstration names, loaded
-- ACTIVE with its horizon at the load date where the fleet is.
DO $$
DECLARE
  r record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM app.tenant;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FAIL D1: % tenants, expected 1', n;
  END IF;
  SELECT * INTO r FROM app.tenant;
  IF (r.id, r.name, r.subdomain, r.state::text)
     IS DISTINCT FROM ('11111111-1111-1111-1111-111111111111'::uuid, 'Demonstration Fleet', 'demo', 'ACTIVE')
     OR r.history_horizon IS DISTINCT FROM app.tenant_today(r.timezone) THEN
    RAISE EXCEPTION 'FAIL D1: tenant is %', row_to_json(r);
  END IF;
END $$;

-- 2. Nothing that names the client or lets anyone sign in: no branding row,
-- no consent record (U138), no user with a subject, and the demonstration
-- counter prefix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.configuration WHERE key = 'branding') THEN
    RAISE EXCEPTION 'FAIL D2: a branding row survived';
  END IF;
  IF EXISTS (SELECT 1 FROM app.tenant_consent) THEN
    RAISE EXCEPTION 'FAIL D2: a consent record exists, and no client agreed to anything';
  END IF;
  IF EXISTS (SELECT 1 FROM app.app_user WHERE subject IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL D2: % users carry a sign-in subject', (SELECT count(*) FROM app.app_user WHERE subject IS NOT NULL);
  END IF;
  IF (SELECT array_agg(prefix) FROM app.display_code_counter) IS DISTINCT FROM ARRAY['DEMO'] THEN
    RAISE EXCEPTION 'FAIL D2: the counter is not one DEMO row';
  END IF;
END $$;

-- 3 and 4. Every number kept: the same exceptions and value at risk the
-- suite pins on the local fixture (004_tests.sql 59b and 59d).
BEGIN;
SET LOCAL ROLE app_login;
DO $$
DECLARE
  total int;
  urgent int;
  below int;
  running numeric;
  spare numeric;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*), count(*) FILTER (WHERE e.urgent), count(*) FILTER (WHERE e.rule_code = 'FR-EXC-020')
    INTO total, urgent, below
    FROM app.v_exception e;
  IF (total, urgent, below) IS DISTINCT FROM (19, 11, 9) THEN
    RAISE EXCEPTION 'FAIL D3: exceptions %/%/%, expected 19/11/9', total, urgent, below;
  END IF;
  SELECT casing_value_at_risk INTO STRICT running FROM app.v_casing_value_at_risk
   WHERE level = 'TENANT' AND position_class = 'RUNNING';
  SELECT casing_value_at_risk INTO STRICT spare FROM app.v_casing_value_at_risk
   WHERE level = 'TENANT' AND position_class = 'SPARE';
  IF (running, spare) IS DISTINCT FROM (16537.50::numeric, 1837.50::numeric) THEN
    RAISE EXCEPTION 'FAIL D4: value at risk R% running, R% spare, expected R16537.50 and R1837.50', running, spare;
  END IF;
END $$;
ROLLBACK;

\echo 'demo: all checks passed'
