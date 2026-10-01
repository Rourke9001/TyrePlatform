-- Sign-in (TYRE-317, ADR-0016): a person's Entra oid links them to their
-- app_user row, and each bearer session's first use is recorded.

-- Nullable: a user exists before first sign-in, and PLATFORM_ADMIN rows
-- never get one (ADR-0011). Unique per tenant, like email, so the index never
-- checks across tenants; one Entra account per tenant is enforced in Entra,
-- where the tenant claim is single-valued (ADR-0016 decision 6).
ALTER TABLE app.app_user ADD COLUMN subject uuid;
CREATE UNIQUE INDEX app_user_tenant_subject_key
  ON app.app_user (tenant_id, subject) WHERE subject IS NOT NULL;

-- Only the owning role writes subject, through the provisioning runbook. A
-- column REVOKE does not narrow a table-level grant, so the table grant goes
-- and every other column comes back. A column grant is checked against the
-- statement's own SET list, so the stamp trigger still writes updated_at and
-- updated_by. Suite 68a holds this shape (TYRE-317).
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

-- FR-AUD-004's session start (ADR-0016 decision 9), the one writer of
-- app.audit_log besides app.audit_row_change(). Invoker rights and a pinned
-- search_path (db/CLAUDE.md, Adding a function). It raises P0001 rather than
-- write a row with no session, actor or tenant; withActor answers that 500,
-- since it is a caller's bug. The tenant check matters for the owning role,
-- which RLS may not bind: a NULL-tenant row is one no tenant can read
-- (ADR-0014). source_ip stays NULL until TYRE-201 binds it.
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
