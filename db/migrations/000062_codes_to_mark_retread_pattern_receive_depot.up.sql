-- ============================================================================
--  Codes to mark, the retread return's pattern, the depot at Receive and
--  PR #139's set-aside bugs (TYRE-99, TYRE-102, TYRE-450)
--  Implements: FR-TYR-035, FR-TYR-040 and FR-FIT-021 as amended; FR-TEN-022;
--  rule 1, rule 3, rule 6; ADR-0024. Design:
--  docs/superpowers/specs/2026-11-17-codes-to-mark-retread-pattern-receive-depot-design.md
-- ============================================================================
-- Written for a migrating role that is not a superuser, as tyreadmin is on
-- Azure. scripts/provision-tenant.test.sh step 17 runs it as one.

-- A consent row dated in the future becomes the purpose's current consent,
-- and app.record_consent then refuses every later record for it, a
-- withdrawal included (R10a, X7). A trigger, not a revoke, so it binds every
-- role, as tenant_consent_written_once does (000059; spec, Lead's call 10).
CREATE FUNCTION app.tenant_consent_is_not_future_dated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.occurred_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'consent is recorded as given now or earlier, never at a future time';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_consent_not_future_dated
BEFORE INSERT ON app.tenant_consent
FOR EACH ROW EXECUTE FUNCTION app.tenant_consent_is_not_future_dated();
