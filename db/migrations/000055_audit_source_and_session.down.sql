-- 000055 down. Restores the state the up found (docs/lessons.md,
-- 2026-09-15): both writers get back the definitions 000035 and 000052 gave
-- them, which no later migration altered. The helper goes last: a plpgsql
-- body holds no dependency on what it calls, so dropping it first would
-- succeed and leave both writers broken. Proved by catalogue, not by the
-- suite.
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
                             before, after)
  VALUES (NEW.tenant_id, app.current_actor_id(), TG_OP, TG_TABLE_NAME, NEW.id,
          -- ADR-0014's literal shape. to_jsonb is strict, so to_jsonb(OLD)
          -- on an AFTER INSERT row trigger already yields SQL NULL and the
          -- CASE changes nothing today; it is written out because it stops
          -- being decorative the moment a DELETE arm or a BEFORE variant is
          -- added, where the two records are populated differently.
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          to_jsonb(NEW));
  RETURN NULL;
END $$;

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
          bound_session, nullif(current_setting('app.source_ip', true), '')::inet)
  ON CONFLICT (tenant_id, session_id) WHERE action = 'SESSION_START' DO NOTHING;
END $$;

DROP FUNCTION app.current_source_ip();
