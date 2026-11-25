-- ============================================================================
--  A movement recorded for the day it happened, and removal reason words
--  (TYRE-240)
--  Implements: FR-FIT-016 and BR-FIT-006 as amended (U253), BR-FIT-002,
--  FR-FIT-008, FR-FIT-018. Design:
--  docs/superpowers/specs/2026-11-25-behaviour-fixes-and-back-dated-movements-design.md
-- ============================================================================
-- The office records a job card's day, not its time (U147, B41). The day
-- rule has two halves, placement and the reason test, and each is one
-- function below, so Go never turns a day into an instant (CLAUDE.md, Where
-- logic belongs). Written as db/CLAUDE.md, Adding a function, says.

-- The latest instant a new movement of these tyres, or into these
-- (vehicle, position) pairs, has to follow, with the words to refuse in.
-- A tyre's open fitment and its closed ones count beside its events: a
-- fitment opened or closed outside the movement functions has no event
-- (000039:348-360, BR-FIT-001). A fitment opened and closed at one instant
-- occupies none (BR-FIT-002). The tenant is named in every query because
-- app.log_retread_return calls this under a role that may bypass RLS (P29).
CREATE FUNCTION app.last_movement(p_tyres uuid[], p_vehicles uuid[], p_positions uuid[])
RETURNS TABLE (at timestamptz, words text)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  RETURN QUERY
  SELECT m.stamp, m.said
    FROM (SELECT e.occurred_at AS stamp,
                 format('this tyre''s last recorded movement is %s; this one cannot predate it',
                        e.occurred_at) AS said
            FROM app.tyre_event e
           WHERE e.tenant_id = v_tenant AND e.tyre_id = ANY (p_tyres)
             AND e.to_state IS NOT NULL
          UNION ALL
          SELECT f.fitted_at,
                 format('this tyre''s last recorded movement is %s; this one cannot predate it',
                        f.fitted_at)
            FROM app.fitment f
           WHERE f.tenant_id = v_tenant AND f.tyre_id = ANY (p_tyres)
             AND f.removed_at IS NULL
          UNION ALL
          SELECT f.removed_at,
                 format('this tyre''s last recorded movement is %s; this one cannot predate it',
                        f.removed_at)
            FROM app.fitment f
           WHERE f.tenant_id = v_tenant AND f.tyre_id = ANY (p_tyres)
             AND f.fitted_at < f.removed_at
          UNION ALL
          SELECT f.removed_at,
                 format('position %s on %s was vacated at %s; this one cannot predate it',
                        p.code, v.fleet_number, f.removed_at)
            FROM unnest(p_vehicles, p_positions) AS pair(vehicle_id, position_id)
            JOIN app.fitment  f ON f.vehicle_id = pair.vehicle_id
                               AND f.position_id = pair.position_id
            JOIN app.position p ON p.id = f.position_id
            JOIN app.vehicle  v ON v.id = f.vehicle_id
           WHERE f.tenant_id = v_tenant AND p.tenant_id = v_tenant
             AND v.tenant_id = v_tenant
             AND f.fitted_at < f.removed_at) m
   ORDER BY m.stamp DESC
   LIMIT 1;
END $$;

-- Placement: the instant a movement for day p_on is stamped at (FR-FIT-016
-- as amended, U253). An earlier day lands at the tenant's start of it
-- (app.tenant_day_instant), or one microsecond after a movement already
-- recorded that day, so the two never tie (000039:784-790). No day, or
-- today, is now() and still reads the last movement, so the instant path's
-- guard holds here too (red team I-5). Volatile, so a caller that waited on
-- a row lock reads what the other transaction committed.
CREATE FUNCTION app.place_movement(p_on date, p_tyres uuid[],
                                   p_vehicles uuid[] DEFAULT ARRAY[]::uuid[],
                                   p_positions uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS timestamptz
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tz         text;
  today      date;
  last_at    timestamptz;
  last_words text;
  last_day   date;
BEGIN
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  today := app.tenant_today(tz);
  IF p_on > today THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement is recorded on or before today, never on a future date';
  END IF;
  SELECT m.at, m.words INTO last_at, last_words
    FROM app.last_movement(p_tyres, p_vehicles, p_positions) m;
  IF p_on IS NULL OR p_on = today THEN
    IF last_at > now() THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = last_words;
    END IF;
    RETURN now();
  END IF;
  IF last_at IS NULL THEN
    RETURN app.tenant_day_instant(p_on);
  END IF;
  last_day := app.tenant_today(tz, last_at);
  IF last_day > p_on THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = last_words;
  ELSIF last_day = p_on THEN
    RETURN last_at + interval '1 microsecond';
  END IF;
  RETURN app.tenant_day_instant(p_on);
END $$;

-- The reason test: any day before the tenant's today carries why, since
-- the same-day stamp can fall inside 24 hours and the user cannot tell
-- which days the clock test of app.fitment_instant_ok would let through
-- (FR-FIT-016 as amended, U253).
CREATE FUNCTION app.backdate_reason_ok(p_on date, p_reason text)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE tz text;
BEGIN
  IF p_on IS NULL THEN
    RETURN;
  END IF;
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  IF p_on < app.tenant_today(tz)
     AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement recorded for an earlier day records why',
      HINT    = 'give the reason the workshop recorded it late (FR-FIT-016)';
  END IF;
END $$;

-- BR-FIT-002 at every instant: one_open_fitment_per_position (000001)
-- holds only open fitments, so a fit stamped before a position's last
-- closure would overlap the tyre that came off it.
CREATE FUNCTION app.positions_free_at(p_at timestamptz, p_vehicles uuid[], p_positions uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  last_at    timestamptz;
  last_words text;
BEGIN
  SELECT m.at, m.words INTO last_at, last_words
    FROM app.last_movement(ARRAY[]::uuid[], p_vehicles, p_positions) m;
  IF last_at > p_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = last_words;
  END IF;
END $$;

REVOKE ALL ON FUNCTION app.last_movement(uuid[], uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.last_movement(uuid[], uuid[], uuid[]) TO app_rw;
REVOKE ALL ON FUNCTION app.place_movement(date, uuid[], uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.place_movement(date, uuid[], uuid[], uuid[]) TO app_rw;
REVOKE ALL ON FUNCTION app.backdate_reason_ok(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.backdate_reason_ok(date, text) TO app_rw;
REVOKE ALL ON FUNCTION app.positions_free_at(timestamptz, uuid[], uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.positions_free_at(timestamptz, uuid[], uuid[]) TO app_rw;
