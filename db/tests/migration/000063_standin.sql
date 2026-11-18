-- The tenant listing under an owner shaped like tyreadmin, run after
-- db/tests/helpers.sql as postgres (TYRE-371, scripts/provision-tenant.test.sh
-- step 17): app_job lists every ACTIVE tenant through it, and a NOBYPASSRLS
-- owner lists none, which is why every release reads the owner's attribute
-- (ADR-0021, ADR-0025). One transaction, rolled back.
BEGIN;
DO $$
DECLARE
  want int  := (SELECT count(*) FROM app.tenant t WHERE t.state = 'ACTIVE');
  own  text := (SELECT p.proowner::regrole::text FROM pg_proc p WHERE p.oid = 'app.active_tenant_ids()'::regprocedure);
  n int;
BEGIN
  IF want = 0 THEN
    RAISE EXCEPTION 'FAIL S8: the stand-in''s database holds no ACTIVE tenant, so the count below proves nothing';
  END IF;
  SET LOCAL ROLE app_job;
  IF current_user <> 'app_job' THEN RAISE EXCEPTION 'FAIL S8: the probe runs as %', current_user; END IF;
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO n FROM app.active_tenant_ids();
  IF n <> want THEN
    RAISE EXCEPTION 'FAIL S8: owned by %, app.active_tenant_ids() lists % of % ACTIVE tenants', own, n, want;
  END IF;
  -- The control, ADR-0021's warning: an owner that stops bypassing row
  -- security lists nobody, because app.tenant is under FORCE.
  RESET ROLE;
  EXECUTE format('ALTER ROLE %I NOBYPASSRLS', own);
  SET LOCAL ROLE app_job;
  SELECT count(*) INTO n FROM app.active_tenant_ids();
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL S8: with % not bypassing row security the listing still read % tenants', own, n;
  END IF;
  RAISE NOTICE 'PASS  S8 owned by %, the listing reads every ACTIVE tenant for app_job, and none once its owner stops bypassing row security', own;
END $$;
ROLLBACK;
