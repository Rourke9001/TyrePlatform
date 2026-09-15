-- 000046: the measurement-ordinal check runs once per statement, over the
-- readings the statement touched (TYRE-252, DR-016).
--
-- 000001 declared reading_measurement_ordinals_contiguous as a DEFERRABLE
-- INITIALLY DEFERRED constraint trigger FOR EACH ROW whose body joined every
-- reading to every measurement the caller could see. Queued once per row
-- and fired at commit, a superlink submit (108 measurements) ran 108 full
-- scans of the tenant's reading history, and a bulk load was quadratic.
-- Its own comment promised "checked at statement end"; this is that check.
--
-- Transition tables are not allowed on constraint triggers, so the deferral
-- goes. Nothing needs it. app.submit_inspection (000041) generates the
-- ordinal as a loop counter rather than reading it from the payload, so its
-- measurements arrive one per statement as 1, 2, 3 and every statement
-- leaves the reading contiguous from 1. The message and SQLSTATE (P0001) do
-- not change: reaching this trigger is a server invariant, never a client
-- refusal (ADR-0012), so nothing maps it in submitStatus.
--
-- One case does change, in the stricter direction, and it is the reason to
-- read this paragraph before adding a writer. 000001 accepted ordinal 2 and
-- then ordinal 1 as two separate statements, because a check deferred to
-- commit saw only the finished set. Each statement now stands on its own, so
-- that order is refused. Nothing writes that way: submit_inspection counts
-- upward, and the seed fixture emits one statement per reading carrying
-- 1, 2, 3. A writer that cannot order its ordinals must build the set in a
-- single statement.
--
-- This was the only deferrable object in the schema, so the SET CONSTRAINTS
-- ALL IMMEDIATE in app.submit_inspection is now a no-op. That statement and
-- the comment above it explaining the deferral are frozen in 000041; this
-- header is where they are answered, and suite check 60c is what holds the
-- catalogue to it.
DROP TRIGGER reading_measurement_ordinals_contiguous ON app.reading_measurement;

-- The pinned search_path is 000043's, restated because CREATE OR REPLACE
-- assigns every property the command does not carry and would otherwise
-- drop it, which suite check 8d would fail.
CREATE OR REPLACE FUNCTION app.check_measurement_ordinals() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_temp AS $$
DECLARE bad record;
BEGIN
  -- Each branch names only the transition tables its own trigger declares.
  -- plpgsql parses a statement on first execution, so a branch that does not
  -- run never resolves a table its trigger did not declare.
  IF TG_OP = 'INSERT' THEN
    FOR bad IN
      SELECT r.id, count(m.*) AS n, min(m.ordinal) AS lo, max(m.ordinal) AS hi
        FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
       WHERE r.id IN (SELECT DISTINCT reading_id FROM new_rows)
       GROUP BY r.id
      HAVING min(m.ordinal) <> 1 OR max(m.ordinal) <> count(m.*)
    LOOP
      RAISE EXCEPTION 'reading % has non-contiguous measurement ordinals (n=%, lo=%, hi=%)',
        bad.id, bad.n, bad.lo, bad.hi;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR bad IN
      SELECT r.id, count(m.*) AS n, min(m.ordinal) AS lo, max(m.ordinal) AS hi
        FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
       WHERE r.id IN (SELECT DISTINCT reading_id FROM old_rows)
       GROUP BY r.id
      HAVING min(m.ordinal) <> 1 OR max(m.ordinal) <> count(m.*)
    LOOP
      RAISE EXCEPTION 'reading % has non-contiguous measurement ordinals (n=%, lo=%, hi=%)',
        bad.id, bad.n, bad.lo, bad.hi;
    END LOOP;
  ELSE
    -- UPDATE: a row moved between readings must leave both contiguous, so
    -- the source (old_rows) and the target (new_rows) are both checked.
    FOR bad IN
      SELECT r.id, count(m.*) AS n, min(m.ordinal) AS lo, max(m.ordinal) AS hi
        FROM app.reading r JOIN app.reading_measurement m ON m.reading_id = r.id
       WHERE r.id IN (SELECT DISTINCT reading_id FROM new_rows
                      UNION SELECT DISTINCT reading_id FROM old_rows)
       GROUP BY r.id
      HAVING min(m.ordinal) <> 1 OR max(m.ordinal) <> count(m.*)
    LOOP
      RAISE EXCEPTION 'reading % has non-contiguous measurement ordinals (n=%, lo=%, hi=%)',
        bad.id, bad.n, bad.lo, bad.hi;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER reading_measurement_ordinals_insert
AFTER INSERT ON app.reading_measurement
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION app.check_measurement_ordinals();

CREATE TRIGGER reading_measurement_ordinals_delete
AFTER DELETE ON app.reading_measurement
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION app.check_measurement_ordinals();

-- An UPDATE that moves a row between readings must leave both contiguous;
-- new_rows carries the target reading, old_rows the source. The app role
-- cannot UPDATE or DELETE this table (append-only, 000001 check 4), so these
-- two are parity with 000001 for the superuser path, not a production route.
CREATE TRIGGER reading_measurement_ordinals_update
AFTER UPDATE ON app.reading_measurement
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION app.check_measurement_ordinals();
