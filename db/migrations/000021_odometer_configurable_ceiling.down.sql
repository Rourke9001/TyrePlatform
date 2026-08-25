CREATE OR REPLACE FUNCTION app.check_odometer_plausible() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev record; nxt record; max_daily_km constant int := 1600;
BEGIN
  SELECT reading_date, odometer_km INTO prev
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date < NEW.reading_date
   ORDER BY reading_date DESC LIMIT 1;

  IF FOUND THEN
    IF NEW.odometer_km < prev.odometer_km THEN
      RAISE EXCEPTION 'odometer went backwards for vehicle % (% km on %, % km on %)',
        NEW.vehicle_id, prev.odometer_km, prev.reading_date, NEW.odometer_km, NEW.reading_date;
    END IF;
    IF (NEW.odometer_km - prev.odometer_km)
       > max_daily_km * GREATEST(1, (NEW.reading_date - prev.reading_date)) THEN
      RAISE EXCEPTION 'implausible distance for vehicle %: % km in % day(s)',
        NEW.vehicle_id, NEW.odometer_km - prev.odometer_km, NEW.reading_date - prev.reading_date;
    END IF;
  END IF;

  SELECT reading_date, odometer_km INTO nxt
    FROM app.vehicle_odometer_reading
   WHERE vehicle_id = NEW.vehicle_id AND reading_date > NEW.reading_date
   ORDER BY reading_date ASC LIMIT 1;

  IF FOUND AND nxt.odometer_km < NEW.odometer_km THEN
    RAISE EXCEPTION 'odometer reading % km on % exceeds later reading % km on %',
      NEW.odometer_km, NEW.reading_date, nxt.odometer_km, nxt.reading_date;
  END IF;

  RETURN NEW;
END $$;
