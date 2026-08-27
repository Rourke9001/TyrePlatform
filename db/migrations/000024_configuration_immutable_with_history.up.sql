-- ============================================================================
--  A unit's axle configuration is immutable once it has history (TYRE-82)
--  Implements: D11(ii) of 27 Aug 2026; FR-VEH-016, INV-4
-- ============================================================================

-- Positions belong to a configuration version, not to a vehicle (FR-VEH-016).
-- Repointing vehicle.configuration_id leaves every existing fitment and
-- reading referencing position rows of the superseded version — a tyre fitted
-- to a position the vehicle does not have. Nothing downstream can detect that
-- afterwards, which is why this is a constraint and not a review item.
--
-- History means fitment OR inspection OR reading, and the third is not
-- redundant. app.inspection.vehicle_id is the MOTIVE unit, so a trailer
-- inspected as part of a rig has no inspection row of its own; what it has is
-- reading rows carrying its own vehicle_id, which FR-INS-061 defines as the
-- owning unit. Testing only fitment and inspection would let precisely the
-- trailer case through.
--
-- Invoker rights, deliberately: the counts run under the caller's RLS, so a
-- caller who cannot see a tenant's history cannot be the one editing its
-- vehicles either.
CREATE FUNCTION app.reject_configuration_change_with_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NEW.configuration_id IS NOT DISTINCT FROM OLD.configuration_id THEN
    RETURN NEW;
  END IF;

  SELECT (EXISTS (SELECT 1 FROM app.fitment    f WHERE f.vehicle_id = OLD.id)
       OR EXISTS (SELECT 1 FROM app.inspection i WHERE i.vehicle_id = OLD.id)
       OR EXISTS (SELECT 1 FROM app.reading    r WHERE r.vehicle_id = OLD.id))::int
    INTO n;

  IF n = 1 THEN
    RAISE EXCEPTION USING
      ERRCODE  = 'TY008',
      MESSAGE  = 'axle configuration cannot change once the unit has history',
      HINT     = 'correct a wrong configuration by retiring the unit and re-adding it, or by a dated migration that moves the history with it — never by an edit';
  END IF;

  RETURN NEW;
END $$;

-- BEFORE, so a refused edit costs no write work. Ordering against 000017's
-- vehicle_stamps_updated is not load-bearing: both are BEFORE UPDATE row
-- triggers, Postgres fires them in trigger-name order, and the RAISE aborts
-- the statement whichever one ran first.
CREATE TRIGGER vehicle_configuration_is_immutable
  BEFORE UPDATE ON app.vehicle
  FOR EACH ROW EXECUTE FUNCTION app.reject_configuration_change_with_history();

-- TY008 has no entry in api/internal/httpapi/httpapi.go's submitStatus map.
-- That is deliberate: no HTTP path updates app.vehicle yet, and an unreachable
-- map entry is dead code. Whoever builds the vehicle write surface maps it to
-- 422 and disables the field in the UI once history exists — TYRE-82 asks for
-- that citation, and this comment is it.
