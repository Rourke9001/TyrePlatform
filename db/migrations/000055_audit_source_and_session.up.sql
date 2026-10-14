-- ============================================================================
--  Audit rows carry the client address and the session (TYRE-201, TYRE-383)
--  Implements: FR-AUD-002, FR-AUD-004; ADR-0014, ADR-0016
-- ============================================================================
-- store.InActorTx binds app.source_ip and app.session_id, each only when the
-- request carries one, and both writers of app.audit_log read them here. The
-- design: docs/superpowers/specs/2026-10-14-audit-source-and-session-design.md.

-- FR-AUD-002, TYRE-383. The one reading of app.source_ip, for both writers. A
-- value that is not an address is NULL, never a refusal: an audit detail
-- never fails the write it records. pg_input_is_valid tests the cast without
-- an exception block per row. One SELECT with no FROM and no SET clause, the
-- shape of app.current_actor_id(), so the planner inlines it into every
-- audited INSERT; it calls only pg_catalog functions and runs as its caller.
CREATE FUNCTION app.current_source_ip() RETURNS inet
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN pg_input_is_valid(current_setting('app.source_ip', true), 'inet')
              THEN current_setting('app.source_ip', true)::inet END
$$;

-- The EXECUTE app.current_actor_id() holds: PUBLIC's default and app_rw by
-- name. 000001's schema-wide grant reached only the functions it found.
GRANT EXECUTE ON FUNCTION app.current_source_ip() TO app_rw;

-- ADR-0014's audit trigger, header at 000035. CREATE OR REPLACE keeps the
-- owner and the grants but resets every property it does not name, so the
-- invoker rights and the search_path pin are restated (db/CLAUDE.md, Adding a
-- function).
CREATE OR REPLACE FUNCTION app.audit_row_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp AS $$
BEGIN
  -- FR-AUD-001 logs mutations, and an UPDATE that leaves the row identical is
  -- not one. app.set_vehicle_status refuses a no-op transition outright
  -- (TY016) for that reason; the unit PATCH is a COALESCE UPDATE, so a client
  -- resending an unchanged field would otherwise write an entry whose before
  -- and after are the same row, a log that claims a change nobody made.
  --
  -- updated_at/updated_by are out of the comparison because app.stamp_updated
  -- (000017) is a BEFORE UPDATE trigger and has already written them into NEW
  -- by the time this AFTER trigger sees it; comparing whole records would
  -- find every UPDATE distinct. The comparison is on jsonb rather than a
  -- column list so the function stays attachable to any table by one CREATE
  -- TRIGGER: '-' on a key the row does not have is a no-op.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(OLD) - 'updated_at' - 'updated_by')
         IS NOT DISTINCT FROM (to_jsonb(NEW) - 'updated_at' - 'updated_by') THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.audit_log (tenant_id, actor_id, action, entity_type, entity_id,
                             before, after, source_ip, session_id)
  VALUES (NEW.tenant_id, app.current_actor_id(), TG_OP, TG_TABLE_NAME, NEW.id,
          -- ADR-0014's literal shape. to_jsonb is strict, so to_jsonb(OLD)
          -- on an AFTER INSERT row trigger already yields SQL NULL and the
          -- CASE changes nothing today; it is written out because it stops
          -- being decorative the moment a DELETE arm or a BEFORE variant is
          -- added, where the two records are populated differently.
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          to_jsonb(NEW),
          -- FR-AUD-002, read as app.record_session_start() reads them. Unbound
          -- is NULL: a seed or suite write binds neither, and a dev header
          -- request carries no session (ADR-0016).
          app.current_source_ip(), nullif(current_setting('app.session_id', true), ''));
  RETURN NULL;
END $$;

-- FR-AUD-004, ADR-0016 decision 9, header at 000052. An unbound session,
-- actor or tenant is refused; an address that is not one is stored as NULL,
-- because losing one address beats failing the request it arrived on
-- (TYRE-383). Invoker rights and the pin restated, as above.
CREATE OR REPLACE FUNCTION app.record_session_start() RETURNS void
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
          bound_session, app.current_source_ip())
  ON CONFLICT (tenant_id, session_id) WHERE action = 'SESSION_START' DO NOTHING;
END $$;
