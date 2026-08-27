-- ============================================================================
--  Fitment odometer is required where the unit kind has one (TYRE-85)
--  Implements: FR-FIT-002 as corrected in SRS v1.4; CHG-027
-- ============================================================================

-- fitted_odometer is nullable (000011) because a trailer has none to give, and
-- trailers carry roughly two-thirds of the tyres on a superlink. That is half
-- of the corrected requirement; this trigger is the other half — required
-- where the unit HAS one. Without it a horse fitment with no odometer is
-- accepted and its distance degrades to UNAVAILABLE, understating cost-per-km
-- coverage for exactly the units where MEASURED was available.
--
-- A CHECK cannot see app.vehicle, so this is a trigger.
--
-- NULL unit_kind passes. CHG-027's backfill left underivable rows NULL, and a
-- unit whose kind we do not know is a unit whose odometer we cannot reason
-- about; refusing it would block legitimate work to enforce a rule we cannot
-- show applies.
CREATE FUNCTION app.require_odometer_where_unit_has_one()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE k app.unit_kind;
BEGIN
  -- Tenant-qualified like refresh_governing_tread (000004), deliberately: the
  -- composite FK also enforces this pairing, but the rule must not depend on a
  -- constraint declared in another migration staying composite.
  SELECT v.unit_kind INTO k FROM app.vehicle v
   WHERE v.id = NEW.vehicle_id AND v.tenant_id = NEW.tenant_id;

  IF k IS NULL OR k = 'TRAILER' THEN
    RETURN NEW;
  END IF;

  IF NEW.fitted_odometer IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at fitment; only a trailer, or a unit of unknown kind, may omit it';
  END IF;

  -- The removal half of FR-FIT-002, checked when the removal is recorded
  -- rather than at insert, because a fitment is open for most of its life.
  IF NEW.removed_at IS NOT NULL AND NEW.removed_odometer IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at removal; without it the distance this tyre ran is unrecoverable';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fitment_odometer_matches_unit_kind
  BEFORE INSERT OR UPDATE ON app.fitment
  FOR EACH ROW EXECUTE FUNCTION app.require_odometer_where_unit_has_one();

-- TY009 has no entry in submitStatus for the same reason TY008 has none: no
-- HTTP path writes app.fitment yet. It is a permanent client-side refusal and
-- wants 422 when the fitment write surface arrives.
