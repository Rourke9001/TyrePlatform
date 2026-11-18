-- ============================================================================
--  The daily job's role and its tenant listing (TYRE-371)
--  Implements: FR-INS-052, FR-INS-054, FR-TEN-004; rule 1; ADR-0025. Design:
--  docs/superpowers/specs/2026-11-18-scheduled-job-runner-design.md
-- ============================================================================
-- app_job is the login the daily job connects as: a member of app_rw, which
-- row security binds as it binds app_login. app.active_tenant_ids() is the
-- one thing it may do that app_login may not, list the ACTIVE tenants it
-- then visits one bound transaction at a time.
--
-- Written for a migrating role that is not a superuser, as tyreadmin is on
-- Azure (ADR-0024, Context). scripts/provision-tenant.test.sh step 17 runs
-- it as one. No password is set here; the runbook sets one per environment.

-- A role found in another shape is refused, never altered: a role that is
-- not a superuser may not name SUPERUSER in ALTER ROLE.
DO $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_job') THEN
    CREATE ROLE app_job LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  SELECT string_agg(a.attr, ', ' ORDER BY a.attr) INTO bad
    FROM pg_roles r,
         LATERAL (VALUES ('rolsuper', r.rolsuper), ('rolbypassrls', r.rolbypassrls),
                         ('not rolcanlogin', NOT r.rolcanlogin), ('rolcreaterole', r.rolcreaterole),
                         ('rolcreatedb', r.rolcreatedb), ('rolreplication', r.rolreplication)) a(attr, wrong)
   WHERE r.rolname = 'app_job' AND a.wrong;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'app_job exists with %; the daily job connects as it, so it must log in and row security must bind it (ADR-0025)', bad;
  END IF;
END $$;
GRANT app_rw TO app_job;

-- A definer the migrating role owns: with no tenant bound, row security
-- hides every tenant from app_job (ADR-0025). Check 8c pins the body, so the
-- body carries no comment.
CREATE FUNCTION app.active_tenant_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = app, pg_temp AS $$
  SELECT t.id FROM app.tenant t WHERE t.state = 'ACTIVE'
$$;
REVOKE ALL ON FUNCTION app.active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_tenant_ids() TO app_job;
COMMENT ON FUNCTION app.active_tenant_ids() IS
  'The ids of ACTIVE tenants, the only state whose users may sign in (FR-TEN-009, TYRE-376), for the daily job alone (app_job). Runs with row security off, so its body is its only tenant boundary; check 8c pins it (ADR-0025, TYRE-371).';
