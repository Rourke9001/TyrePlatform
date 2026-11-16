-- ============================================================================
--  Trips and nominations are written only through their functions (TYRE-472)
--  Implements: FR-TEN-004, FR-VEH-007 and FR-INS-051 as amended; rule 1,
--  rule 3; ADR-0024. Design:
--  docs/superpowers/specs/2026-11-16-trip-writes-through-definer-design.md
-- ============================================================================
-- app_rw loses its raw INSERT on both tables and its UPDATE of a trip's end,
-- so app.start_trip, app.end_trip and app.nominate_for_task are the only
-- writers. They run as app_writer, a NOLOGIN role row security binds, so the
-- caller's tenant still bounds every read and write inside them.
--
-- Written for a migrating role that is not a superuser, as tyreadmin is on
-- Azure, since a run as postgres skips every ownership rule below (spec
-- section 4). scripts/provision-tenant.test.sh step 17 runs it as one.

-- A role found in another shape is refused, never altered: a role that is
-- not a superuser may not name SUPERUSER in ALTER ROLE (spec, Lead's call 3).
DO $$
DECLARE bad text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  SELECT string_agg(a.attr, ', ' ORDER BY a.attr) INTO bad
    FROM pg_roles r,
         LATERAL (VALUES ('rolsuper', r.rolsuper), ('rolbypassrls', r.rolbypassrls),
                         ('rolcanlogin', r.rolcanlogin), ('rolcreaterole', r.rolcreaterole),
                         ('rolcreatedb', r.rolcreatedb), ('rolreplication', r.rolreplication)) a(attr, is_on)
   WHERE r.rolname = 'app_writer' AND a.is_on;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'app_writer exists with % true; it owns definers the app calls, so row security must bind it and it must not log in (ADR-0024)', bad;
  END IF;
END $$;

-- Permanent: OWNER TO below needs SET on app_writer, and a later CREATE OR
-- REPLACE of one of the three needs membership in its owner. A creator
-- holds ADMIN alone until it grants itself both (spec, Lead's call 5).
GRANT app_writer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;

-- What the three call trees need, and nothing more: inside a definer every
-- nested function, trigger and policy runs as its owner (spec section 2). A
-- row lock needs UPDATE on one column, so a table locked and never updated
-- gets updated_at, which app.stamp_updated overwrites on every UPDATE (spec,
-- Lead's call 6). Suite check 8e pins this list.
-- Every name the three resolve.
GRANT USAGE ON SCHEMA app TO app_writer;
-- start_trip's open-trip reads and its INSERT; end_trip's read.
GRANT SELECT, INSERT ON app.trip TO app_writer;
-- start_trip's end of the motive's and the driver's trips; end_trip's end.
GRANT UPDATE (ended_at, ended_by) ON app.trip TO app_writer;
-- nominate_for_task's race read and its INSERT.
GRANT SELECT, INSERT ON app.inspection_task_nomination TO app_writer;
-- nominate_for_task's task read and trip_start_blockers' due tasks.
GRANT SELECT ON app.inspection_task TO app_writer;
-- nominate_for_task's FOR UPDATE of the task.
GRANT UPDATE (updated_at) ON app.inspection_task TO app_writer;
-- The driver and nominee reads, and v_unit_coverage's holder.
GRANT SELECT ON app.app_user TO app_writer;
-- start_trip's FOR NO KEY UPDATE of the driver.
GRANT UPDATE (updated_at) ON app.app_user TO app_writer;
-- The unit reads of start_trip, create_combination_at and the rig trigger.
GRANT SELECT ON app.vehicle TO app_writer;
-- The FOR UPDATE of every unit start_trip and create_combination_at touch.
GRANT UPDATE (updated_at) ON app.vehicle TO app_writer;
-- The rig reads, and create_combination_at's INSERT of the new rig.
GRANT SELECT, INSERT ON app.combination TO app_writer;
-- end_combination_at's end of the motive's open rig.
GRANT UPDATE (effective_to) ON app.combination TO app_writer;
-- The member reads, and create_combination_at's INSERT of each member.
GRANT SELECT, INSERT ON app.combination_member TO app_writer;
-- trip_start_blockers' tenant time zone.
GRANT SELECT ON app.tenant TO app_writer;
-- config_for's due_inspection_blocks_trip read.
GRANT SELECT ON app.configuration TO app_writer;
-- audit_row_change's entry for each write.
GRANT INSERT ON app.audit_log TO app_writer;
-- audit_log.id is a bigserial (000001).
GRANT USAGE ON SEQUENCE app.audit_log_id_seq TO app_writer;
-- nominate_for_task's covered-unit read.
GRANT SELECT ON app.v_unit_coverage TO app_writer;
-- start_trip's rig re-form; PUBLIC is revoked on both (000044).
GRANT EXECUTE ON FUNCTION app.end_combination_at(uuid, timestamptz) TO app_writer;
GRANT EXECUTE ON FUNCTION app.create_combination_at(uuid, jsonb, timestamptz) TO app_writer;

-- OWNER TO needs the new owner to hold CREATE on the function's schema, at
-- that moment only (spec, Lead's call 4). Each ACL is set before the owner
-- changes, and the file runs as one transaction, so no definer is ever
-- executable by PUBLIC.
GRANT CREATE ON SCHEMA app TO app_writer;
ALTER FUNCTION app.start_trip(uuid, uuid, uuid[]) SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.start_trip(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.start_trip(uuid, uuid, uuid[]) TO app_rw;
ALTER FUNCTION app.start_trip(uuid, uuid, uuid[]) OWNER TO app_writer;
ALTER FUNCTION app.end_trip(uuid) SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.end_trip(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.end_trip(uuid) TO app_rw;
ALTER FUNCTION app.end_trip(uuid) OWNER TO app_writer;
ALTER FUNCTION app.nominate_for_task(uuid, uuid) SECURITY DEFINER;
REVOKE ALL ON FUNCTION app.nominate_for_task(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nominate_for_task(uuid, uuid) TO app_rw;
ALTER FUNCTION app.nominate_for_task(uuid, uuid) OWNER TO app_writer;
REVOKE CREATE ON SCHEMA app FROM app_writer;

REVOKE INSERT ON app.trip FROM app_rw;
REVOKE UPDATE (ended_at, ended_by) ON app.trip FROM app_rw;
REVOKE INSERT ON app.inspection_task_nomination FROM app_rw;

-- Each trigger repeated its function for a raw INSERT the app role can no
-- longer make, and U202 orders their retirement (db/CLAUDE.md, Schema
-- changes are migrations). trip_ended_once stays: it holds an end's shape
-- for every role, the owner included.
DROP TRIGGER trip_well_formed ON app.trip;
DROP FUNCTION app.trip_is_well_formed();
DROP TRIGGER nomination_well_formed ON app.inspection_task_nomination;
DROP FUNCTION app.nomination_is_well_formed();

COMMENT ON TABLE app.trip IS
  'A driver on a motive unit from one instant to another (FR-VEH-007 as amended, TYRE-326). A trip ends once and is never edited. Written only by app.start_trip and app.end_trip, which run as app_writer (000061, ADR-0024); docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';
COMMENT ON TABLE app.inspection_task_nomination IS
  'A driver named for one inspection task (FR-INS-051, FR-INS-053 as amended, TYRE-326). Insert-only history: a new nominee is a newer row. Written only by app.nominate_for_task, which runs as app_writer (000061, ADR-0024); docs/superpowers/specs/2026-10-22-per-trip-assignment-design.md.';
