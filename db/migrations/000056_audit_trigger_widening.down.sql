-- 000056 down. Restores the state the up found (docs/lessons.md,
-- 2026-09-15): the nine triggers go, and app.audit_row_change() gets back
-- 000055's definition, which no later migration altered, cut from that file.
-- Proved by catalogue, not by the suite.
DROP TRIGGER vehicle_tag_map_audited ON app.vehicle_tag_map;
DROP TRIGGER vehicle_tag_audited ON app.vehicle_tag;
DROP TRIGGER configuration_audited ON app.configuration;
DROP TRIGGER threshold_policy_audited ON app.threshold_policy;
DROP TRIGGER vehicle_driver_audited ON app.vehicle_driver;
DROP TRIGGER app_user_audited ON app.app_user;
DROP TRIGGER retread_job_audited ON app.retread_job;
DROP TRIGGER fitment_audited ON app.fitment;
DROP TRIGGER tyre_audited ON app.tyre;

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
