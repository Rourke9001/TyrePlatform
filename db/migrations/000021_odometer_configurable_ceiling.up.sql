-- ============================================================================
--  Odometer plausibility: a tenant-configured ceiling, and trappable refusals
--  Implements: DR-020, FR-INS-033, BR-INS-002
-- ============================================================================

-- The ceiling is configuration because DR-020 says "configurable" and because
-- a linehaul tenant legitimately covers more ground in a day than a municipal
-- fleet; a constant refuses one of them its own drivers' work.
--
-- Absent configuration the plausibility check stands down while monotonicity
-- still holds: BR-INS-002 is unconditional, but refusing every reading a
-- tenant has not yet configured a ceiling for would block capture on an
-- unmade decision. Seeded for every tenant, so the fail-open path is a
-- backstop rather than the normal case.
--
-- The refusals carry their own SQLSTATEs so app.submit_inspection can contain
-- a timeline refusal (FR-INS-020: it never blocks the inspection) without
-- swallowing an FK violation or a serialisation failure on the same INSERT.
--   TY001 — monotonicity: this reading contradicts one already on the timeline
--   TY002 — plausibility: the implied daily distance exceeds the tenant ceiling
CREATE OR REPLACE FUNCTION app.check_odometer_plausible() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE
  prev       record;
  nxt        record;
  ceiling_km int;
BEGIN
  ceiling_km := (app.config_for(NEW.tenant_id, 'odometer_max_daily_km',
                                (NEW.reading_date + 1)::timestamp AT TIME ZONE 'UTC') #>> '{}')::int;

  SELECT reading_date, odometer_km INTO prev
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date < NEW.reading_date
   ORDER BY reading_date DESC LIMIT 1;

  IF FOUND THEN
    IF NEW.odometer_km < prev.odometer_km THEN
      RAISE EXCEPTION 'odometer went backwards for vehicle % (% km on %, % km on %)',
        NEW.vehicle_id, prev.odometer_km, prev.reading_date, NEW.odometer_km, NEW.reading_date
        USING ERRCODE = 'TY001';
    END IF;
    IF ceiling_km IS NOT NULL
       AND (NEW.odometer_km - prev.odometer_km)
           > ceiling_km * GREATEST(1, (NEW.reading_date - prev.reading_date)) THEN
      RAISE EXCEPTION 'implausible distance for vehicle %: % km in % day(s)',
        NEW.vehicle_id, NEW.odometer_km - prev.odometer_km, NEW.reading_date - prev.reading_date
        USING ERRCODE = 'TY002';
    END IF;
  END IF;

  SELECT reading_date, odometer_km INTO nxt
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date > NEW.reading_date
   ORDER BY reading_date ASC LIMIT 1;

  IF FOUND AND nxt.odometer_km < NEW.odometer_km THEN
    RAISE EXCEPTION 'odometer reading % km on % exceeds later reading % km on %',
      NEW.odometer_km, NEW.reading_date, nxt.odometer_km, nxt.reading_date
      USING ERRCODE = 'TY001';
  END IF;

  RETURN NEW;
END $$;
