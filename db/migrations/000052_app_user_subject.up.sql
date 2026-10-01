-- Sign-in (TYRE-317, ADR-0016): a person's Entra oid links them to their
-- app_user row, and each bearer session's first use is recorded.

-- Nullable: a user exists before first sign-in, and the runbook links no
-- subject to a PLATFORM_ADMIN row (ADR-0011).
ALTER TABLE app.app_user ADD COLUMN subject uuid;

-- Unique per tenant, like email, so the index never checks across tenants;
-- one Entra account per tenant is enforced in Entra (ADR-0016 Option 1).
CREATE UNIQUE INDEX app_user_tenant_subject_key
  ON app.app_user (tenant_id, subject) WHERE subject IS NOT NULL;

-- Only the owning role writes subject, so no handler can re-link a login
-- (ADR-0016 decision 6). A column REVOKE does not narrow a table-level grant,
-- so the table grant goes and every other column comes back. Suite 68a.
REVOKE INSERT, UPDATE ON app.app_user FROM app_rw;
GRANT INSERT (id, tenant_id, email, display_name, staff_number, role, active,
              created_at, created_by, updated_at, updated_by)
  ON app.app_user TO app_rw;
GRANT UPDATE (id, tenant_id, email, display_name, staff_number, role, active,
              created_at, created_by, updated_at, updated_by)
  ON app.app_user TO app_rw;

-- One SESSION_START row per session per tenant. A replica or a restart that
-- has forgotten a session it recorded makes the repeat a no-op.
CREATE UNIQUE INDEX audit_log_session_start_key
  ON app.audit_log (tenant_id, session_id) WHERE action = 'SESSION_START';

-- Refuses rather than write an unattributed session start (FR-AUD-004,
-- ADR-0016 decision 9).
CREATE FUNCTION app.record_session_start() RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp AS $$
DECLARE
  bound_session text := nullif(current_setting('app.session_id', true), '');
  bound_actor   uuid := app.current_actor_id();
BEGIN
  IF bound_session IS NULL OR bound_actor IS NULL OR app.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'app.record_session_start needs app.tenant_id, app.session_id and app.actor_id bound';
  END IF;
  INSERT INTO app.audit_log (tenant_id, actor_id, action, entity_type, entity_id,
                             session_id, source_ip)
  VALUES (app.current_tenant_id(), bound_actor, 'SESSION_START', 'app_user', bound_actor,
          bound_session, nullif(current_setting('app.source_ip', true), '')::inet)
  ON CONFLICT (tenant_id, session_id) WHERE action = 'SESSION_START' DO NOTHING;
END $$;
