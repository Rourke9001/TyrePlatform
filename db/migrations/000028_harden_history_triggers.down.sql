-- Restores the pre-TYRE-88 function bodies verbatim (000024, 000025). The
-- trigger and function objects themselves were created there, not here, so
-- this migration only reverts what it changed: the function bodies.
CREATE OR REPLACE FUNCTION app.reject_configuration_change_with_history()
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

CREATE OR REPLACE FUNCTION app.require_odometer_where_unit_has_one()
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
