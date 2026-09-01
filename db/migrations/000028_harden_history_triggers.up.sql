-- TY009, second cut (TYRE-88 defect 1). The fitted-odometer leg must not
-- re-fire on the UPDATE of a fitment that was legitimately created without
-- one — a NULL-kind unit later backfilled to HORSE (CHG-027), or any
-- pre-000025 legacy row — or such fitments can never be closed. The gate is
-- exactly the ticket's: TG_OP = 'UPDATE' AND OLD.fitted_odometer IS NULL AND
-- NEW.vehicle_id = OLD.vehicle_id. Not a bare INSERT gate (it would re-break
-- the backfill), and not a bare OLD-is-NULL pass (a repoint must not escape).
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

  IF NEW.fitted_odometer IS NULL
     AND NOT (TG_OP = 'UPDATE'
              AND OLD.fitted_odometer IS NULL
              AND NEW.vehicle_id = OLD.vehicle_id) THEN
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

-- TY008 widens to unit_kind (TYRE-88 defect 2): editing the kind of a unit
-- with history retroactively changes what recorded MEASURED distances meant
-- and what TY009 enforces. A NULL kind may be backfilled once — that is
-- CHG-027's legitimate path and the very one that makes defect 1's rows —
-- but any change FROM a known kind is refused, including to NULL: allowing
-- known→NULL would let two legal steps launder the edit the rule refuses.
-- That last clause exceeds TYRE-88's literal wording (which names only
-- known→known). The EXISTS fold is the ticket's cosmetic rider.
CREATE OR REPLACE FUNCTION app.reject_configuration_change_with_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.configuration_id IS NOT DISTINCT FROM OLD.configuration_id
     AND (OLD.unit_kind IS NULL OR NEW.unit_kind IS NOT DISTINCT FROM OLD.unit_kind) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM app.fitment    f WHERE f.vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM app.inspection i WHERE i.vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM app.reading    r WHERE r.vehicle_id = OLD.id) THEN
    IF NEW.configuration_id IS DISTINCT FROM OLD.configuration_id THEN
      RAISE EXCEPTION USING
        ERRCODE  = 'TY008',
        MESSAGE  = 'axle configuration cannot change once the unit has history',
        HINT     = 'correct a wrong configuration by retiring the unit and re-adding it, or by a dated migration that moves the history with it — never by an edit';
    END IF;
    RAISE EXCEPTION USING
      ERRCODE  = 'TY008',
      MESSAGE  = 'unit kind cannot change once the unit has history',
      HINT     = 'a NULL kind may be backfilled once; correcting a known kind is a retire-and-re-add (D11(ii))';
  END IF;

  RETURN NEW;
END $$;

-- TYRE-88 defect 3: name the legacy rows the new gate grandfathers, in the
-- 000011 RAISE WARNING idiom — visibility, not enforcement.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT f.id, v.fleet_number, v.unit_kind
      FROM app.fitment f
      JOIN app.vehicle v ON v.id = f.vehicle_id AND v.tenant_id = f.tenant_id
     WHERE v.unit_kind IN ('HORSE','RIGID','LIGHT') AND f.fitted_odometer IS NULL
  LOOP
    RAISE WARNING 'fitment % on unit % (%) has no fitted_odometer; its distance will be UNAVAILABLE (TYRE-88)',
      r.id, r.fleet_number, r.unit_kind;
  END LOOP;
END $$;
