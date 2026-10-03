-- 000046 down. Restores the state the up migration found: 000001's function
-- body under 000043's pinned search_path, and 000001's deferrable per-row
-- constraint trigger (000039's down says why the duplication is the point).
-- The cost this reintroduces is TYRE-252's finding, not a defect of the down
-- file.
--
-- The pin is restated rather than inherited: CREATE OR REPLACE assigns every
-- property the command does not carry, so a body copied from 000001, which
-- predates the pin, would silently undo 000043 and fail suite check 8d.
DROP TRIGGER reading_measurement_ordinals_update ON app.reading_measurement;
DROP TRIGGER reading_measurement_ordinals_delete ON app.reading_measurement;
DROP TRIGGER reading_measurement_ordinals_insert ON app.reading_measurement;

CREATE OR REPLACE FUNCTION app.check_measurement_ordinals() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE bad record;
BEGIN
  FOR bad IN
    SELECT r.id, count(m.*) AS n, min(m.ordinal) AS lo, max(m.ordinal) AS hi
      FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
     GROUP BY r.id
    HAVING min(m.ordinal) <> 1 OR max(m.ordinal) <> count(m.*)
  LOOP
    RAISE EXCEPTION 'reading % has non-contiguous measurement ordinals (n=%, lo=%, hi=%)',
      bad.id, bad.n, bad.lo, bad.hi;
  END LOOP;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER reading_measurement_ordinals_contiguous
AFTER INSERT OR UPDATE OR DELETE ON app.reading_measurement
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.check_measurement_ordinals();
