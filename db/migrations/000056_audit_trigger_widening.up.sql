-- ============================================================================
--  The audit trigger reaches the remaining write paths (TYRE-98)
--  Implements: FR-AUD-001; ADR-0014, ADR-0013 decision 7
-- ============================================================================
-- The design: docs/superpowers/specs/2026-10-14-audit-trigger-widening-design.md.
-- Which tables stay unaudited, and why, is ADR-0014's Consequences. The
-- entity argument below supersedes 000035's precondition that an audited
-- table has an id column (TYRE-191).

-- ADR-0014's audit trigger. CREATE OR REPLACE keeps the owner, the grants and
-- the six triggers already attached, but resets every property it does not
-- name, so the invoker rights and the search_path pin are restated
-- (db/CLAUDE.md, Adding a function).
CREATE OR REPLACE FUNCTION app.audit_row_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp AS $$
DECLARE
  -- to_jsonb is strict, so each is NULL where its record is not populated:
  -- OLD on an INSERT, NEW on a DELETE. They are ADR-0014's before and after.
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
  audited jsonb := COALESCE(new_row, old_row);
  -- A table whose rows have no id of their own names the column its entries
  -- are filed under, as the tag map files under its unit (TYRE-98).
  entity_column text := COALESCE(TG_ARGV[0], 'id');
  row_tenant uuid := (audited ->> 'tenant_id')::uuid;
  entity uuid := (audited ->> entity_column)::uuid;
BEGIN
  -- FR-AUD-001 logs mutations, and an UPDATE that leaves the row identical is
  -- not one (ADR-0014). updated_at/updated_by are set aside because
  -- app.stamp_updated (000017), a BEFORE UPDATE trigger, has already written
  -- them into NEW. jsonb keeps the comparison attachable to any table, since
  -- '-' on a key the row does not have is a no-op.
  IF TG_OP = 'UPDATE'
     AND (old_row - 'updated_at' - 'updated_by')
         IS NOT DISTINCT FROM (new_row - 'updated_at' - 'updated_by') THEN
    RETURN NULL;
  END IF;
  -- DR-014: tenant closure is the one physical deletion, and its cascade
  -- removes the tenant's audit rows with the rest, so an entry written here
  -- would fail audit_log_tenant_id_fkey and the closure with it. A NULL
  -- tenant passes that key, so a platform row's deletion is still filed.
  IF TG_OP = 'DELETE' AND row_tenant IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.tenant t WHERE t.id = row_tenant) THEN
    RETURN NULL;
  END IF;
  -- A trigger attached to a table without these, or naming the wrong column,
  -- fails its first write instead of filing an entry no reader can find.
  IF NOT (audited ? 'tenant_id') THEN
    RAISE EXCEPTION 'app.audit_row_change: %.% has no tenant_id column',
      TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  IF entity IS NULL THEN
    RAISE EXCEPTION 'app.audit_row_change: %.% row has no value in %, the column its entries are filed under',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, entity_column;
  END IF;
  INSERT INTO app.audit_log (tenant_id, actor_id, action, entity_type, entity_id,
                             before, after, source_ip, session_id)
  VALUES (row_tenant, app.current_actor_id(), TG_OP, TG_TABLE_NAME, entity,
          old_row, new_row,
          -- FR-AUD-002, read as app.record_session_start() reads them. Unbound
          -- is NULL: a seed or suite write binds neither, and a dev header
          -- request carries no session (ADR-0016).
          app.current_source_ip(), nullif(current_setting('app.session_id', true), ''));
  RETURN NULL;
END $$;

-- FR-AUD-001, ADR-0014: every table the app role writes in place.
CREATE TRIGGER tyre_audited
AFTER INSERT OR UPDATE ON app.tyre
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER fitment_audited
AFTER INSERT OR UPDATE ON app.fitment
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER retread_job_audited
AFTER INSERT OR UPDATE ON app.retread_job
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- A PLATFORM_ADMIN row has no tenant, so its entry carries none and only the
-- owning role reads it (FR-TEN-002, FR-AUT-003a).
CREATE TRIGGER app_user_audited
AFTER INSERT OR UPDATE ON app.app_user
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER vehicle_driver_audited
AFTER INSERT OR UPDATE ON app.vehicle_driver
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- 000054 refuses every UPDATE here; the event is attached so every audited
-- table carries the same ones.
CREATE TRIGGER threshold_policy_audited
AFTER INSERT OR UPDATE ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER configuration_audited
AFTER INSERT OR UPDATE ON app.configuration
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER vehicle_tag_audited
AFTER INSERT OR UPDATE ON app.vehicle_tag
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- The map's rows have no id, so its entries are filed under the unit. It is
-- the one audited table app_rw may delete from (ADR-0013 decision 7).
CREATE TRIGGER vehicle_tag_map_audited
AFTER INSERT OR UPDATE OR DELETE ON app.vehicle_tag_map
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change('vehicle_id');
