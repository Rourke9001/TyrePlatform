-- ============================================================================
--  Unit status transitions, and the audit mechanism they are the first
--  writer of (TYRE-94)
--  Implements: FR-VEH-005, FR-VEH-006, FR-VEH-041, FR-INS-054, FR-AUD-001,
--  CR-004; INV-2 (a unit leaves the fleet empty), U4 (the trigger attaches to
--  app.vehicle in this slice), U6 (a tag edit replaces the set)
-- ============================================================================
-- SQLSTATEs (the TY class forwards verbatim, ADR-0012):
--   TY012 — a unit this tenant cannot see
--   TY016 — a status transition the rules do not allow
--
-- A missing unit and another fleet's unit are indistinguishable under RLS and
-- share one message, so a cross-tenant probe can pin which branch refused it
-- and prove that isolation did the refusing (suite 43g). The five TY016
-- branches each name their own rule for the same reason (suite 43a, 43c, 43e,
-- 43j).

-- FR-VEH-005. Status is a function rather than a column the PATCH writes,
-- because rules govern the move and a bare UPDATE walks past every one of
-- them.
--
-- TY008 (000024, widened by 000028) gets no entry in
-- api/internal/httpapi/httpapi.go's submitStatus map, and this function does
-- not make it reachable: it writes neither configuration_id nor unit_kind.
-- The reasoning is docs/implementation-order.md §B5, which supersedes
-- 000024:57-61's instruction to map TY008 when the vehicle write surface
-- arrives — the unit PATCH refuses both fields at the decoder instead (D5).
--
-- Invoker rights, like every routine in app except
-- app.refresh_governing_tread: it runs as app_rw inside the caller's
-- tenant-bound transaction, so RLS binds it (suite check 8c).
CREATE FUNCTION app.set_vehicle_status(p_vehicle uuid,
                                       p_status app.vehicle_status,
                                       p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v app.vehicle;
  n int;
BEGIN
  -- FOR UPDATE serialises this call against another status change on the
  -- same unit: two concurrent parks resolve to one PARKED and one TY016
  -- rather than to two audit rows claiming the same transition. It does not
  -- by itself keep a casing off a disposed unit — a removal committing
  -- between the count and the write only lowers the count. That direction is
  -- closed from the other side: app.fit_tyre and app.rotate_tyres take the
  -- unit row FOR SHARE (000033), so a disposal waits for an in-flight fit and
  -- a fit sees a committed disposal.
  SELECT * INTO v FROM app.vehicle veh WHERE veh.id = p_vehicle FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  -- A NULL target would make every comparison against p_status NULL and then
  -- fail the column's NOT NULL as a bare 23502, which reaches the wire as a
  -- 500 the outbox retries for ever (ADR-0012).
  IF p_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY016',
      MESSAGE = 'a status change names the status to move the unit to';
  END IF;

  -- Checked before the no-op below so that DISPOSED to DISPOSED answers with
  -- the rule that actually governs it. FR-VEH-005: all six values are legal
  -- targets from any other state; DISPOSED is the one that is not a state the
  -- unit comes back from, and a unit that returns to service is a new unit
  -- with its own record, not this one revived.
  IF v.status = 'DISPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY016',
      MESSAGE = 'this unit is DISPOSED; that is where a unit''s record ends',
      HINT    = 'receive it as a new unit if it comes back into the fleet (FR-VEH-005)';
  END IF;
  -- FR-AUD-001: an audit row is written for every mutation, so a transition
  -- that changes nothing would put a row in the log claiming a change that
  -- did not happen.
  IF v.status = p_status THEN
    RAISE EXCEPTION USING ERRCODE = 'TY016',
      MESSAGE = format('this unit is already %s', p_status);
  END IF;

  IF p_status = 'DISPOSED' THEN
    -- INV-2: the unit is empty at the moment it is disposed. A casing left on
    -- it would have no removal path — a fitment closes only against the unit
    -- it is open on — and the register would carry it as fleet value on a
    -- unit that is gone. Keeping it empty afterwards is app.fit_tyre's and
    -- app.rotate_tyres' guard (000033), not this count.
    SELECT count(*) INTO n FROM app.fitment f
     WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL;
    IF n > 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY016',
        MESSAGE = format('this unit still has fitted tyres (%s); they come off before it is disposed', n),
        HINT    = 'remove each fitment first (INV-2, FR-FIT-007)';
    END IF;
    -- A disposal is the one transition that ends the unit's record, so the
    -- justification is required rather than optional. It is a required input
    -- only: nothing on app.vehicle stores it, and to_jsonb(NEW) in the audit
    -- row therefore does not carry it either.
    IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY016',
        MESSAGE = 'a disposal records the reason the unit left the fleet',
        HINT    = 'give the reason (sold, written off, returned to lessor) — FR-VEH-005';
    END IF;
  END IF;

  -- FR-VEH-006, FR-INS-054: nothing here pauses the schedule. Generation
  -- already filters on v.status = 'ACTIVE' (000012's
  -- app.generate_inspection_tasks), so a parked unit stops being issued tasks
  -- by this write alone, and the suite asserts that behaviour rather than
  -- trusting the filter (43d).
  UPDATE app.vehicle veh SET status = p_status WHERE veh.id = p_vehicle;
END $$;

-- ADR-0014. One generic trigger function, attached per table: it reads TG_OP,
-- TG_TABLE_NAME, NEW and OLD, so coverage for another table is one CREATE
-- TRIGGER statement and not new logic, and it captures a mutation whether the
-- row came from a Go insert, a SQL function or a seed script (FR-AUD-001).
--
-- SECURITY INVOKER is the decision, not a default left alone: the trigger runs
-- as the writer, so tenant_isolation on app.audit_log evaluates against the
-- writer's own session-bound tenant. tenant_id comes from NEW rather than
-- app.current_tenant_id() — the departure from ADR-0013 decision 2 that ADR-
-- 0014 records: app.audit_log.tenant_id is nullable, and a session-derived
-- source would stamp NULL on every superuser-written row, an audit entry that
-- tenant_isolation's USING clause then hides from every tenant session.
--
-- app.current_actor_id() returns NULL when no actor is bound (000001:32), so a
-- seed-loaded or suite-planted row is audited as "loaded, not acted" instead
-- of failing its insert (suite 43i).
--
-- The precondition it carries: an audited table needs both an id and a
-- tenant_id column, because NEW.id and NEW.tenant_id are resolved by name at
-- runtime. app.vehicle_tag_map has no id column, so attaching this trigger
-- there would succeed at CREATE TRIGGER and fail on the first insert.
CREATE FUNCTION app.audit_row_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = app, pg_temp AS $$
BEGIN
  -- FR-AUD-001 logs mutations, and an UPDATE that leaves the row identical is
  -- not one. app.set_vehicle_status refuses a no-op transition outright
  -- (TY016) for that reason; the unit PATCH is a COALESCE UPDATE, so a client
  -- resending an unchanged field would otherwise write an entry whose before
  -- and after are the same row — a log that claims a change nobody made.
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

-- U4: app.vehicle is the one table this slice gives an update endpoint to, so
-- it is the one table the trigger attaches to here. app.tyre and app.app_user
-- carry unaudited update paths of their own — widening to them is the
-- follow-up ticket ADR-0014's Consequences names, not a gap in this migration.
CREATE TRIGGER vehicle_audited
AFTER INSERT OR UPDATE ON app.vehicle
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- FR-VEH-041, U6. A tag map row is a current label used for filtering, not
-- history: the unit edit replaces a unit's whole tag set in one transaction,
-- which is a delete of its map rows followed by an insert of the new set.
-- 000018 revoked DELETE across the 000012 tables as a block; this restores it
-- for the map alone. app.vehicle_tag stays undeletable there — a tag name is
-- shared across units, and one unit's edit must not remove it from the others.
GRANT DELETE ON app.vehicle_tag_map TO app_rw;
