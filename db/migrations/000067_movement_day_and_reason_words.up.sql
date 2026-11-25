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

-- The four movements take the day. Each is dropped and created again: a
-- defaulted argument added beside the old overload would make a call that
-- binds both ambiguous (db/CLAUDE.md, Schema changes are migrations).
DROP FUNCTION app.fit_tyre(uuid, uuid, uuid, numeric, app.mount_orientation, bigint, timestamptz, text);
DROP FUNCTION app.remove_tyre(uuid, text, numeric, bigint, timestamptz, text);
DROP FUNCTION app.rotate_tyres(uuid, jsonb, jsonb, timestamptz);
DROP FUNCTION app.return_tyre_to_stock(uuid, uuid, timestamptz);

CREATE FUNCTION app.fit_tyre(p_tyre uuid, p_vehicle uuid, p_position uuid,
                             p_tread_mm numeric,
                             p_mount_orientation app.mount_orientation,
                             p_odometer bigint DEFAULT NULL,
                             p_occurred_at timestamptz DEFAULT NULL,
                             p_reason text DEFAULT NULL,
                             p_occurred_on date DEFAULT NULL)
RETURNS TABLE (fitment_id uuid, warnings jsonb)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  stamp     timestamptz;
  ty        app.tyre;
  veh       app.vehicle;
  pos       app.position;
  warn      jsonb := '[]'::jsonb;
  permitted boolean;
  band      numeric;
  mate      numeric;
  prior     boolean;
  new_fit   uuid;
  at_unit   text;
  at_pos    text;
BEGIN
  -- FOR UPDATE: the fitment row, the tyre's state and the event must move
  -- together, and a concurrent fit of the same casing has to see this one's
  -- state rather than race it.
  SELECT * INTO ty FROM app.tyre t WHERE t.id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  -- A day or an instant, never both: the two rules would disagree on which
  -- one the movement is stamped by (TYRE-240).
  IF p_occurred_at IS NOT NULL AND p_occurred_on IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement names a day or an instant, not both';
  END IF;
  IF ty.state = 'FITTED' THEN
    -- D14: the refusal names where the casing already is, so the workshop
    -- knows which unit to go to rather than only that the fit failed.
    SELECT v.fleet_number, p.code INTO at_unit, at_pos
      FROM app.fitment f
      JOIN app.vehicle v  ON v.id = f.vehicle_id
      JOIN app.position p ON p.id = f.position_id
     WHERE f.tyre_id = p_tyre AND f.removed_at IS NULL;
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is FITTED on %s position %s; remove it before fitting it again',
                       at_unit, at_pos);
  END IF;
  IF ty.state <> 'IN_STOCK' THEN
    -- U1: a REMOVED casing is returned to stock as its own recorded action,
    -- so the fitment history shows where it was in between (FR-FIT-003).
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; a tyre is fitted from IN_STOCK only', ty.state),
      HINT    = 'return it to stock first (Appendix C, FR-FIT-003)';
  END IF;

  SELECT * INTO veh FROM app.vehicle v WHERE v.id = p_vehicle FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  -- INV-2's converse. app.set_vehicle_status (000035) refuses a disposal
  -- while the unit has an open fitment, which holds the invariant only at the
  -- instant that call runs; this is what holds it afterwards. FOR SHARE on
  -- the row is what makes the pair race-free in both directions: the
  -- disposal's FOR UPDATE waits for an in-flight fit, and a fit that starts
  -- after one sees the committed status, while two fits on the same unit
  -- still do not queue behind each other, which FOR UPDATE here would force.
  --
  -- DISPOSED alone is refused. A PARKED, WORKSHOP, INACTIVE or OUT_OF_SERVICE
  -- unit still has tyres changed: FR-VEH-006 pauses a unit's inspection
  -- schedule, not the workshop's work on it.
  IF veh.status = 'DISPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'this unit is disposed; nothing is fitted to it';
  END IF;
  -- The composite FK proves the position belongs to this tenant, not that it
  -- belongs to THIS unit: position ids are shared by every unit of one axle
  -- configuration, so a wrong pairing passes the FK untouched and only an
  -- explicit configuration match catches it.
  SELECT * INTO pos FROM app.position p
   WHERE p.id = p_position AND p.configuration_id = veh.configuration_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such position on this unit';
  END IF;

  -- FR-FIT-001: a fitment records the tread it went on at. The ceiling is
  -- app.max_tread_mm's, for the reason stated there, and reaches the refusal
  -- through the same call rather than as a second copy of the figure.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > app.max_tread_mm() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('a fitment records its tread in millimetres, above 0 and at most %s',
                       app.max_tread_mm());
  END IF;
  -- Waits out an in-flight closure of the target so placement reads it.
  -- It refuses nothing: occupancy stays the index's rule (header of 000033).
  PERFORM 1 FROM app.fitment f
   WHERE f.vehicle_id = p_vehicle AND f.position_id = p_position AND f.removed_at IS NULL
     FOR UPDATE;
  IF p_occurred_on IS NULL THEN
    stamp := COALESCE(p_occurred_at, now());
    PERFORM app.fitment_instant_ok(p_tyre, stamp, p_reason);
  ELSE
    PERFORM app.backdate_reason_ok(p_occurred_on, p_reason);
    stamp := app.place_movement(p_occurred_on, ARRAY[p_tyre], ARRAY[p_vehicle], ARRAY[p_position]);
  END IF;
  PERFORM app.positions_free_at(stamp, ARRAY[p_vehicle], ARRAY[p_position]);

  -- Warnings are advice, never a refusal: the driver is at the vehicle and
  -- the platform reports the tenant's configured policy, it does not decide
  -- what may be fitted. Computed before the INSERT so each rule sees the
  -- axle as it stands, without having to exclude the row being written.
  --
  -- FR-FIT-005. Silent when either size is unknown: an absent size is
  -- absence, not a mismatch (CR-012).
  IF ty.size_id IS NOT NULL AND pos.axle_number IS NOT NULL
     AND EXISTS (SELECT 1
                   FROM app.fitment f
                   JOIN app.position p ON p.id = f.position_id
                   JOIN app.tyre o     ON o.id = f.tyre_id
                  WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL
                    AND p.axle_number = pos.axle_number
                    AND o.size_id IS NOT NULL AND o.size_id <> ty.size_id) THEN
    warn := warn || jsonb_build_object(
      'code', 'SIZE_DIFFERS_ON_AXLE',
      'message', format('another tyre on axle %s is a different size', pos.axle_number));
  END IF;

  -- FR-FIT-006, FR-CFG-044, U11: warn without blocking. The class row wins
  -- over the tenant-wide one where it exists, which is how the seeded STEER
  -- rule reaches a fit at all (CHG-038: fleet practice, never a legal claim).
  IF ty.status = 'RETREAD' THEN
    permitted := (app.threshold_policy_in_force(app.current_tenant_id(), NULL,
                                                pos.axle_class)).retreads_permitted;
    IF permitted IS FALSE THEN
      warn := warn || jsonb_build_object(
        'code', 'RETREAD_ON_NON_PERMITTED_AXLE',
        'message', format('this fleet does not run retreads on %s axles', pos.axle_class));
    END IF;
  END IF;

  -- FR-FIT-020: mismatched duals scrub the shallower tyre, so the gap is
  -- worth flagging at the moment it is created. The threshold is tenant
  -- configuration (rule 5); when the key is absent the rule is silent, since
  -- absence of a configured tolerance is not a tolerance of zero.
  IF pos.slot IN ('INNER', 'OUTER') THEN
    SELECT (c.value #>> '{}')::numeric INTO band
      FROM app.configuration c
     WHERE c.tenant_id = app.current_tenant_id()
       AND c.key = 'dual_mate_warn_mm'
       AND c.effective_from <= now()
     ORDER BY c.effective_from DESC
     LIMIT 1;
    IF band IS NOT NULL THEN
      -- FR-FIT-020, TYRE-126: the register ranks an inspection reading above
      -- app.tyre.last_tread_mm wherever one exists (000036), so the warning
      -- reads the same precedence. A gap measured against a depth the
      -- dashboard does not show is a gap nobody can check. The reading arm is
      -- as at this fitment's own instant, not the latest overall: a reading
      -- taken after the fitter put the casing on did not inform the fitter.
      -- The last_tread_mm fallback carries no such cut-off. It is the
      -- column's current value, which a backdated fit can leave later than
      -- the fit's stamp.
      SELECT COALESCE(lr.governing_tread_mm, o.last_tread_mm) INTO mate
        FROM app.fitment f
        JOIN app.position p ON p.id = f.position_id
        JOIN app.tyre o     ON o.id = f.tyre_id
        LEFT JOIN LATERAL (
             SELECT r.governing_tread_mm
               FROM app.reading r
               JOIN app.inspection i ON i.id = r.inspection_id
              WHERE r.tyre_id = o.id
                AND i.state <> 'VOIDED'
                AND r.governing_tread_mm IS NOT NULL
                AND i.submitted_at <= stamp
              ORDER BY i.submitted_at DESC
              LIMIT 1) lr ON true
       WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL
         AND p.axle_number = pos.axle_number AND p.side = pos.side
         AND p.slot <> pos.slot AND p.slot IN ('INNER', 'OUTER');
      IF mate IS NOT NULL AND abs(mate - p_tread_mm) > band THEN
        warn := warn || jsonb_build_object(
          'code', 'DUAL_MATE_TREAD_GAP',
          'message', format('its dual mate reads %smm against this %smm, over the %smm this fleet allows',
                            mate, p_tread_mm, band));
      END IF;
    END IF;
  END IF;

  -- U8, resolved before the row exists: after the INSERT every tyre has a
  -- fitment and the predicate would answer REFITTED for a first fit.
  prior := EXISTS (SELECT 1 FROM app.fitment f WHERE f.tyre_id = p_tyre);

  -- The fitment first: the unit-kind odometer rule (TY009, 000025) and the
  -- two occupancy indexes both fire here, before the tyre's state has moved,
  -- so a refusal cannot leave a FITTED tyre with no fitment behind it.
  INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                           fitted_odometer, fitted_tread_mm, mount_orientation)
  VALUES (app.current_tenant_id(), p_tyre, p_vehicle, p_position, stamp,
          p_odometer, p_tread_mm, p_mount_orientation)
  RETURNING id INTO new_fit;

  -- current_depot_id goes to NULL: a fitted casing is on a unit, and leaving
  -- the depot set would keep it in that depot's stock counts.
  -- U10: the tread moves forward in time only, so a backdated fit cannot
  -- overwrite a newer inspection's reading.
  UPDATE app.tyre t
     SET state            = 'FITTED',
         current_depot_id = NULL,
         last_tread_mm    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                 THEN p_tread_mm ELSE t.last_tread_mm END,
         last_tread_at    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                 THEN stamp ELSE t.last_tread_at END
   WHERE t.id = p_tyre;

  -- The backdate justification is carried onto the event rather than
  -- discarded: requiring it and then dropping it would leave FR-FIT-016's
  -- rule with nothing to show for itself.
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, payload)
  VALUES (app.current_tenant_id(), p_tyre,
          CASE WHEN prior THEN 'REFITTED' ELSE 'FITTED' END,
          stamp, ty.state, 'FITTED',
          NULLIF(btrim(COALESCE(p_reason, '')), ''),
          jsonb_build_object('fitment_id', new_fit,
                             'position_code', pos.code,
                             'vehicle_id', p_vehicle));

  fitment_id := new_fit;
  warnings   := warn;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.remove_tyre(p_fitment uuid, p_reason text, p_tread_mm numeric,
                                p_odometer bigint DEFAULT NULL,
                                p_occurred_at timestamptz DEFAULT NULL,
                                p_backdate_reason text DEFAULT NULL,
                                p_occurred_on date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  stamp   timestamptz;
  fit     app.fitment;
  ty      app.tyre;
  home    uuid;
  reasons jsonb;
  km      bigint;
  src     app.distance_provenance;
BEGIN
  SELECT * INTO fit FROM app.fitment f WHERE f.id = p_fitment;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such fitment in this fleet';
  END IF;
  -- A day or an instant, never both, as app.fit_tyre says.
  IF p_occurred_at IS NOT NULL AND p_occurred_on IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement names a day or an instant, not both';
  END IF;
  -- Casing first, then fitment. That is the order app.fit_tyre and
  -- app.rotate_tyres take their locks in, and reversing it here would let a
  -- rotation and a removal of one casing deadlock against each other.
  -- Re-reading the fitment under the casing's lock is what makes a
  -- concurrent second removal answer 'already closed' below, instead of
  -- falling through to the trigger's TY014 (000032).
  SELECT * INTO ty  FROM app.tyre t    WHERE t.id = fit.tyre_id FOR UPDATE;
  SELECT * INTO fit FROM app.fitment f WHERE f.id = p_fitment   FOR UPDATE;
  -- A second removal is a state error, not a bad input: the row is already
  -- what the caller is asking it to become. Corrections are compensating
  -- events (rule 3, FR-FIT-015).
  IF fit.removed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'this fitment is already closed',
      HINT    = 'record a compensating event instead (FR-FIT-015)';
  END IF;

  -- D1, rule 5: the reason vocabulary is tenant configuration, so the set is
  -- read from the tenant's latest dated row rather than hard-coded here.
  SELECT c.value INTO reasons
    FROM app.configuration c
   WHERE c.tenant_id = app.current_tenant_id()
     AND c.key = 'removal_reasons'
     AND c.effective_from <= now()
   ORDER BY c.effective_from DESC
   LIMIT 1;
  -- A refusal, not a fault: the gap is in the tenant's own configuration and
  -- is theirs to close, and a bare P0001 would reach the client as a 500 the
  -- outbox retries for ever (ADR-0012, rule 5).
  IF reasons IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'no removal reasons are configured for this fleet',
      HINT    = 'configure removal_reasons before recording a removal (FR-FIT-008)';
  END IF;
  IF p_reason IS NULL OR NOT (reasons ? p_reason) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('%L is not one of this fleet''s removal reasons', COALESCE(p_reason, '')),
      HINT    = 'the list is tenant configuration (FR-FIT-008)';
  END IF;
  -- FR-FIT-007: the removal tread is what the valuation and the wear rate
  -- are computed from, so it is required on the same terms as the fitment's,
  -- against the ceiling app.max_tread_mm states and holds.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > app.max_tread_mm() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('a removal records its tread in millimetres, above 0 and at most %s',
                       app.max_tread_mm());
  END IF;
  -- FR-FIT-016, against the fitment row itself, which fitment_instant_ok has
  -- no way to see: that helper bounds an instant against the tyre's latest
  -- to_state EVENT, which a fitment opened outside app.fit_tyre never has.
  -- Every one of the pilot tenant's 27 open fitments is in that shape. A
  -- closure stamped before its own fitment orders the casing's history
  -- against itself, the removal standing ahead of the fit that caused it,
  -- and gives the fitment a negative elapsed time, a span a distance and a
  -- cost-per-kilometre would then be computed over (FR-VAL-022, CR-012).
  -- Placement reads the open fitment for the same reason.
  IF p_occurred_on IS NULL THEN
    stamp := COALESCE(p_occurred_at, now());
    IF stamp < fit.fitted_at THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('this tyre was fitted at %s; a removal cannot predate its own fitment',
                         fit.fitted_at);
    END IF;
    PERFORM app.fitment_instant_ok(fit.tyre_id, stamp, p_backdate_reason);
  ELSE
    PERFORM app.backdate_reason_ok(p_occurred_on, p_backdate_reason);
    stamp := app.place_movement(p_occurred_on, ARRAY[fit.tyre_id]);
  END IF;

  -- FR-FIT-009, CR-012: provenance is written, never left to the column
  -- default to stand in for. A NULL distance beside a MEASURED label would
  -- read downstream as a measured zero, which is the one thing a
  -- cost-per-kilometre figure must never quietly become. INFERRED belongs to
  -- coupling records and is written by nothing until OI-31 lands.
  IF p_odometer IS NOT NULL AND fit.fitted_odometer IS NOT NULL THEN
    IF p_odometer < fit.fitted_odometer THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('this unit read %s at fitment and %s at removal; a distance cannot run backwards',
                         fit.fitted_odometer, p_odometer);
    END IF;
    km  := p_odometer - fit.fitted_odometer;
    src := 'MEASURED';
  ELSE
    km  := NULL;
    src := 'UNAVAILABLE';
  END IF;

  -- The closure is the one UPDATE app.fitment permits (000032); the removal
  -- leg of the unit-kind odometer rule (TY009) fires on it too.
  UPDATE app.fitment f
     SET removed_at       = stamp,
         removed_odometer = p_odometer,
         removed_tread_mm = p_tread_mm,
         removal_reason   = p_reason,
         distance_km      = km,
         distance_source  = src
   WHERE f.id = p_fitment;

  -- A removed casing comes to rest at the unit's home depot: that is where
  -- the workshop physically has it, and stock reports read current_depot_id
  -- (TYRE-92).
  SELECT v.home_depot_id INTO home FROM app.vehicle v WHERE v.id = fit.vehicle_id;
  UPDATE app.tyre t
     SET state            = 'REMOVED',
         current_depot_id = home,
         last_tread_mm    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                 THEN p_tread_mm ELSE t.last_tread_mm END,
         last_tread_at    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                 THEN stamp ELSE t.last_tread_at END
   WHERE t.id = fit.tyre_id;

  -- The event's reason is the removal's own, so the back-date reason rides
  -- in the payload (000048's principle for app.fit_tyre, FR-FIT-016).
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, payload)
  VALUES (app.current_tenant_id(), fit.tyre_id, 'REMOVED', stamp,
          ty.state, 'REMOVED', p_reason,
          jsonb_build_object('fitment_id', p_fitment,
                             'distance_km', km,
                             'distance_source', src,
                             'backdate_reason', NULLIF(btrim(COALESCE(p_backdate_reason, '')), '')));
END $$;

CREATE FUNCTION app.rotate_tyres(p_vehicle uuid, p_moves jsonb,
                                 p_odometers jsonb DEFAULT NULL,
                                 p_occurred_at timestamptz DEFAULT NULL,
                                 p_backdate_reason text DEFAULT NULL,
                                 p_occurred_on date DEFAULT NULL)
RETURNS TABLE (tyre_id uuid, fitment_id uuid)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  stamp      timestamptz;
  to_vids    uuid[];
  to_pids    uuid[];
  veh        app.vehicle;
  dest       app.vehicle;
  m          jsonb;
  mv         record;
  un         record;
  kv         record;
  befores    jsonb;
  moved      uuid[];
  rig_units  uuid[];
  allowed    uuid[];
  named      uuid[];
  touched    uuid[];
  to_vehicle uuid;
  to_cfg     uuid;
  src_unit   uuid;
  odo        bigint;
  n_moves    int;
  n_uniq     int;
  n_closed   int;
  new_fit    uuid;
  to_code    text;
  to_fleet   text;
  bad        text;
  fit_at     timestamptz;
BEGIN
  SELECT * INTO veh FROM app.vehicle v WHERE v.id = p_vehicle FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  -- INV-2's converse, on the other writer that opens a fitment; the lock and
  -- the DISPOSED-only scope are app.fit_tyre's, for its reasons. This is the
  -- anchor unit, answered ahead of every input check so the refusal names the
  -- unit rather than the payload (suite 43k).
  IF veh.status = 'DISPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'this unit is disposed; nothing is fitted to it';
  END IF;
  -- A day or an instant, never both, as app.fit_tyre says.
  IF p_occurred_at IS NOT NULL AND p_occurred_on IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement names a day or an instant, not both';
  END IF;
  -- The shape is checked before it is walked: jsonb_array_elements on a
  -- scalar raises a bare 22023 the client cannot map to anything (D6).
  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' OR jsonb_array_length(p_moves) < 2 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a rotation is two or more moves',
      HINT    = 'one tyre changing position is a remove and a fit (FR-FIT-010)';
  END IF;

  SELECT array_agg((e.value->>'tyre_id')::uuid) INTO moved
    FROM jsonb_array_elements(p_moves) e;

  -- D2: every writer here locks the casing before it reads what it is going
  -- to act on, so a concurrent removal cannot close one of these fitments
  -- between the validation below and the closure UPDATE. ORDER BY id is what
  -- keeps two rotations sharing a casing from deadlocking: both take the
  -- rows in the same order and the second one queues.
  PERFORM 1 FROM app.tyre t WHERE t.id = ANY (moved) ORDER BY t.id FOR UPDATE;

  -- The positions the moves fill, in move order, as (unit, position) pairs
  -- (U18). Placement runs here, under the casings' locks and before the rig
  -- is read, so the rig is the one coupled at the stamp.
  to_vids := ARRAY(SELECT COALESCE((e.value->>'to_vehicle_id')::uuid, p_vehicle)
                     FROM jsonb_array_elements(p_moves) WITH ORDINALITY e(value, n) ORDER BY e.n);
  to_pids := ARRAY(SELECT (e.value->>'to_position_id')::uuid
                     FROM jsonb_array_elements(p_moves) WITH ORDINALITY e(value, n) ORDER BY e.n);
  IF p_occurred_on IS NULL THEN
    stamp := COALESCE(p_occurred_at, now());
  ELSE
    PERFORM app.backdate_reason_ok(p_occurred_on, p_backdate_reason);
    stamp := app.place_movement(p_occurred_on, moved, to_vids, to_pids);
  END IF;

  -- U16: the scope is one open rig, resolved AT stamp rather than at
  -- now(). A yard move recorded after the rig was uncoupled is still a move
  -- that happened while it was coupled, and FR-VEH-031 attributes over time.
  -- INV-4 (000037) makes memberships non-overlapping, so this is at most one
  -- rig; the lock is what makes a concurrent app.end_combination serialise
  -- against the answer rather than race it.
  PERFORM 1
     FROM app.combination c
     JOIN app.combination_member cm ON cm.combination_id = c.id
    WHERE cm.vehicle_id = p_vehicle
      AND c.effective_from <= stamp
      AND (c.effective_to IS NULL OR stamp < c.effective_to)
      FOR SHARE OF c;

  SELECT COALESCE(array_agg(DISTINCT cm2.vehicle_id), ARRAY[]::uuid[])
    INTO rig_units
    FROM app.combination c
    JOIN app.combination_member cm  ON cm.combination_id = c.id
                                   AND cm.vehicle_id = p_vehicle
    JOIN app.combination_member cm2 ON cm2.combination_id = c.id
   WHERE c.effective_from <= stamp
     AND (c.effective_to IS NULL OR stamp < c.effective_to);

  -- U17: the anchor is in scope whether or not a move touches it, because it
  -- is the unit the request was addressed to and not a unit every move has
  -- to name.
  allowed := ARRAY(SELECT DISTINCT u FROM unnest(rig_units || p_vehicle) u);
  named   := ARRAY(SELECT DISTINCT COALESCE((e.value->>'to_vehicle_id')::uuid, p_vehicle)
                     FROM jsonb_array_elements(p_moves) e);

  -- Every in-scope unit a move names is locked before any of them is read,
  -- in id order, for the deadlock reason the casings above carry. Units the
  -- moves name that are NOT in scope are deliberately left to the per-move
  -- pass: refusing one here would answer a membership question about a unit
  -- whose visibility has not been established yet.
  PERFORM 1 FROM app.vehicle v
   WHERE v.id = ANY (named) AND v.id = ANY (allowed)
   ORDER BY v.id FOR SHARE;
  -- INV-2's converse for every other unit of the rig, not only the anchor:
  -- a rotation opens a fitment on the destination, so a disposed destination
  -- would break the same invariant a disposed anchor does.
  SELECT v.fleet_number INTO bad FROM app.vehicle v
   WHERE v.id = ANY (named) AND v.id = ANY (allowed) AND v.status = 'DISPOSED'
   ORDER BY v.id LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('%s is disposed; nothing is fitted to it', bad);
  END IF;

  -- Everything is validated before anything is written: the RAISE rolls this
  -- function's own transaction back, but a caller holding a savepoint around
  -- it must not be able to keep half a rotation (FR-FIT-010, FR-FIT-014).
  -- The checks run as ordered passes rather than per move: a later pass's
  -- rule cannot pre-empt an earlier pass's, so an occupancy or tread answer
  -- never arrives ahead of a visibility one (suite 41n).
  FOR m IN SELECT e.value FROM jsonb_array_elements(p_moves) e LOOP
    -- U15: a move names where the casing is going. Where it is coming from is
    -- derived from its open fitment, which is already the one answer to where
    -- a casing is; a caller-asserted source would be a second truth to
    -- reconcile against the register.
    to_vehicle := COALESCE((m->>'to_vehicle_id')::uuid, p_vehicle);

    -- U11's rule (ADR-0012): a row this tenant cannot see is TY012 with a
    -- message per object, never a rule refusal that admits the row exists.
    -- Asked BEFORE membership, because "not in this rig" about another
    -- tenant's unit would confirm that unit to a caller who cannot see it.
    SELECT * INTO dest FROM app.vehicle v WHERE v.id = to_vehicle FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
    END IF;
    -- Now that the unit is one this fleet can see, naming it is safe, and
    -- naming it is what tells a controller which unit to couple (U16).
    IF to_vehicle <> ALL (allowed) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('%s is not in this unit''s rig at that time', dest.fleet_number),
        HINT    = 'a rotation moves casings within one rig (FR-VEH-031, BR-FIT-005)';
    END IF;

    -- The source, on the same two branches and in the same order: a casing
    -- with no open fitment visible here is what another fleet's casing looks
    -- like under RLS, so that is the visibility answer; a casing sitting on a
    -- unit outside the rig is a rule refusal naming that unit.
    SELECT f.vehicle_id INTO src_unit FROM app.fitment f
     WHERE f.tyre_id = (m->>'tyre_id')::uuid AND f.removed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('tyre %s is not on this unit or its rig', m->>'tyre_id');
    END IF;
    IF src_unit <> ALL (allowed) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('tyre %s is on %s, which is not in this unit''s rig at that time',
                         m->>'tyre_id',
                         (SELECT v.fleet_number FROM app.vehicle v WHERE v.id = src_unit));
    END IF;
  END LOOP;

  FOR m IN SELECT e.value FROM jsonb_array_elements(p_moves) e LOOP
    to_vehicle := COALESCE((m->>'to_vehicle_id')::uuid, p_vehicle);
    -- U18: position rows belong to an axle configuration, not to a unit, so
    -- two units of one configuration share them. Every target check below is
    -- on the (unit, position) pair; checking against p_vehicle's
    -- configuration would pass a trailer's position on a horse.
    SELECT v.configuration_id INTO to_cfg FROM app.vehicle v WHERE v.id = to_vehicle;
    IF NOT EXISTS (SELECT 1 FROM app.position p
                    WHERE p.id = (m->>'to_position_id')::uuid
                      AND p.configuration_id = to_cfg) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such position on this unit';
    END IF;
    -- The ceiling is app.max_tread_mm's, for the reason stated there.
    IF (m->>'tread_mm')::numeric IS NULL
       OR (m->>'tread_mm')::numeric <= 0
       OR (m->>'tread_mm')::numeric > app.max_tread_mm() THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('every move records its tread in millimetres, above 0 and at most %s',
                         app.max_tread_mm());
    END IF;
    -- A rotation never displaces a tyre it was not told about: a target is
    -- either empty or vacated by this same set of moves (FR-FIT-010).
    IF EXISTS (SELECT 1 FROM app.fitment f
                WHERE f.vehicle_id = to_vehicle AND f.removed_at IS NULL
                  AND f.position_id = (m->>'to_position_id')::uuid
                  AND NOT (f.tyre_id = ANY (moved))) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('position %s carries a tyre this rotation does not move',
                         (SELECT p.code FROM app.position p WHERE p.id = (m->>'to_position_id')::uuid));
    END IF;
    -- FR-FIT-016, the same hole app.remove_tyre closes and for the harm
    -- stated there: the pass above proved this casing has an open fitment
    -- inside the rig, so the row is read again here, under its lock, for its
    -- own fitted_at rather than the event history fitment_instant_ok reads.
    -- Per moved casing, not once for the set: a rotation can carry casings
    -- opened years apart.
    SELECT f.fitted_at INTO fit_at FROM app.fitment f
     WHERE f.tyre_id = (m->>'tyre_id')::uuid AND f.removed_at IS NULL;
    IF stamp < fit_at THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('tyre %s was fitted at %s; a rotation cannot predate its own fitment',
                         m->>'tyre_id', fit_at);
    END IF;
    IF p_occurred_on IS NULL THEN
      PERFORM app.fitment_instant_ok((m->>'tyre_id')::uuid, stamp, p_backdate_reason);
    END IF;
  END LOOP;

  -- U18 again, at set level: the pair is the target, so one position id used
  -- on two units of a rig is two targets and not a clash.
  SELECT count(DISTINCT (COALESCE((e.value->>'to_vehicle_id')::uuid, p_vehicle),
                         (e.value->>'to_position_id')::uuid)),
         count(*)
    INTO n_uniq, n_moves
    FROM jsonb_array_elements(p_moves) e;
  IF n_uniq <> n_moves THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'two moves cannot target the same position';
  END IF;
  IF array_length(ARRAY(SELECT DISTINCT unnest(moved)), 1) <> n_moves THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'a tyre appears twice in this rotation';
  END IF;
  -- BR-FIT-002 on both paths, after every refusal above keeps its order.
  PERFORM app.positions_free_at(stamp, to_vids, to_pids);

  -- U20: a horse records an odometer and a trailer has none, so the reading
  -- is per unit rather than per rotation (FR-FIT-002). Every unit this
  -- rotation touches is either a destination or the unit a moved casing is
  -- coming off; a reading for anything else is a reading the caller has
  -- misfiled, and silently ignoring it would lose a distance nobody notices
  -- is missing.
  IF p_odometers IS NOT NULL THEN
    IF jsonb_typeof(p_odometers) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'odometer readings are given per unit, as an object of unit id to reading';
    END IF;
    touched := ARRAY(SELECT DISTINCT s.u FROM (
                       SELECT COALESCE((e.value->>'to_vehicle_id')::uuid, p_vehicle) AS u
                         FROM jsonb_array_elements(p_moves) e
                       UNION ALL
                       SELECT f.vehicle_id
                         FROM app.fitment f
                        WHERE f.removed_at IS NULL AND f.tyre_id = ANY (moved)
                          AND f.vehicle_id = ANY (allowed)) s);
    FOR kv IN SELECT j.key AS k, j.value AS v FROM jsonb_each(p_odometers) j LOOP
      -- Compared as text, never cast to uuid: a key that is not a uuid at all
      -- would raise a bare 22P02 before this refusal could answer (ADR-0012).
      IF kv.k <> ALL (SELECT u::text FROM unnest(touched) u) THEN
        RAISE EXCEPTION USING ERRCODE = 'TY014',
          MESSAGE = format('%s is not a unit this rotation touches', kv.k);
      END IF;
      -- Matched on the number's own text, not on its value: a reading written
      -- with a scale is numerically whole and still not a bigint, so a value
      -- test would pass it through to the casts below and answer a bare 22P02
      -- the form has nothing to show for (ADR-0012). Refused rather than
      -- rounded. An odometer the caller did not enter is a distance nobody
      -- can check afterwards (FR-FIT-009).
      --
      -- No sign, and this is the only rule that refuses one: the bound below
      -- is answered per unit against the fitments that unit has being rotated
      -- OUT, so a unit this rotation only opens a row on meets no bound at
      -- all and its reading goes straight into fitted_odometer, where
      -- 000001's CHECK (fitted_odometer >= 0) answers 23514, a constraint's
      -- own text, naming no unit and outside the TY class an outbox stops
      -- retrying on (ADR-0012, suite 47p).
      IF jsonb_typeof(kv.v) <> 'number' OR (kv.v #>> '{}') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING ERRCODE = 'TY014',
          MESSAGE = format('%s reads %s; an odometer is a whole number of kilometres',
                           kv.k, kv.v #>> '{}');
      END IF;
    END LOOP;
  END IF;

  -- The same bound remove_tyre applies, answered against each unit's own
  -- fitments and its own reading: a rig's units run the same road and read
  -- different numbers, so one figure compared against every closure would
  -- refuse a sound trailer reading on the horse's account (FR-FIT-009).
  -- Checked here so the whole set is refused before any row is closed. In id
  -- order, so that when two units of one rig both read low the unit the
  -- refusal names is fixed by construction rather than by the plan.
  FOR un IN SELECT DISTINCT f.vehicle_id AS vid
              FROM app.fitment f
             WHERE f.removed_at IS NULL AND f.tyre_id = ANY (moved)
               AND f.vehicle_id = ANY (allowed)
             ORDER BY f.vehicle_id LOOP
    odo := (p_odometers ->> un.vid::text)::bigint;
    IF odo IS NOT NULL AND EXISTS (
         SELECT 1 FROM app.fitment f
          WHERE f.vehicle_id = un.vid AND f.removed_at IS NULL
            AND f.tyre_id = ANY (moved)
            AND f.fitted_odometer IS NOT NULL AND f.fitted_odometer > odo) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('%s reads %s, below the odometer of a fitment being rotated out',
                         (SELECT v.fleet_number FROM app.vehicle v WHERE v.id = un.vid), odo);
    END IF;
  END LOOP;

  -- Where each casing is coming from, read while the rows are still open. The
  -- unit is carried beside the position because a move can cross units, and
  -- the event below has to be able to say which one it left (U19).
  SELECT jsonb_object_agg(f.tyre_id::text,
                          jsonb_build_object('code', p.code,
                                             'orientation', f.mount_orientation::text,
                                             'vehicle_id', f.vehicle_id,
                                             'fleet_number', v.fleet_number))
    INTO befores
    FROM app.fitment f
    JOIN app.position p ON p.id = f.position_id
    JOIN app.vehicle v  ON v.id = f.vehicle_id
   WHERE f.removed_at IS NULL AND f.tyre_id = ANY (moved) AND f.vehicle_id = ANY (allowed);

  -- Every fitment closes before any opens: a swap passes through a moment
  -- where two casings would claim one position, and the partial unique
  -- indexes are checked per statement. One reading per tyre serves both ends
  -- of the move: the casing is measured once, on the ground, during the
  -- rotation.
  UPDATE app.fitment f
     SET removed_at       = stamp,
         removed_odometer = (p_odometers ->> f.vehicle_id::text)::bigint,
         removed_tread_mm = (SELECT (e.value->>'tread_mm')::numeric
                               FROM jsonb_array_elements(p_moves) e
                              WHERE (e.value->>'tyre_id')::uuid = f.tyre_id),
         -- 'rotation' is written by the platform, not chosen from the
         -- tenant's removal_reasons vocabulary (D1) that app.remove_tyre
         -- validates a caller-supplied reason against. Suite 40f pins the
         -- seeded vocabulary, 'rotation' included, so the two agree for
         -- every seeded tenant; a tenant who later deletes 'rotation' from
         -- their list still does not break the rotation the platform
         -- records on its own account.
         removal_reason   = 'rotation',
         distance_km      = CASE WHEN (p_odometers ->> f.vehicle_id::text) IS NOT NULL
                                  AND f.fitted_odometer IS NOT NULL
                                 THEN (p_odometers ->> f.vehicle_id::text)::bigint
                                      - f.fitted_odometer END,
         distance_source  = CASE WHEN (p_odometers ->> f.vehicle_id::text) IS NOT NULL
                                  AND f.fitted_odometer IS NOT NULL
                                 THEN 'MEASURED'::app.distance_provenance
                                 ELSE 'UNAVAILABLE'::app.distance_provenance END
   WHERE f.removed_at IS NULL AND f.tyre_id = ANY (moved)
     AND f.vehicle_id = ANY (allowed);

  -- Under READ COMMITTED this UPDATE re-evaluates its predicate, so a fitment
  -- closed and committed between the validation and here is simply not
  -- matched. Opening a new fitment for a casing whose old row never closed
  -- would leave the tyre REMOVED with an open fitment and a ROTATED event;
  -- counting the closures is what turns that into a refusal the caller can
  -- retry (FR-FIT-014).
  GET DIAGNOSTICS n_closed = ROW_COUNT;
  IF n_closed <> n_moves THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a fitment in this rotation was changed by another action; reload the unit and try again';
  END IF;

  FOR mv IN SELECT (e.value->>'tyre_id')::uuid                            AS tid,
                   (e.value->>'to_position_id')::uuid                     AS pid,
                   (e.value->>'tread_mm')::numeric                        AS tread,
                   COALESCE((e.value->>'to_vehicle_id')::uuid, p_vehicle) AS vid
              FROM jsonb_array_elements(p_moves) e LOOP
    -- D13: a rotation does not turn the casing round, so the orientation
    -- comes off the closed row. A flip is a remove and a fit.
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                             fitted_odometer, fitted_tread_mm, mount_orientation)
    VALUES (app.current_tenant_id(), mv.tid, mv.vid, mv.pid, stamp,
            (p_odometers ->> mv.vid::text)::bigint, mv.tread,
            (befores->(mv.tid::text)->>'orientation')::app.mount_orientation)
    RETURNING id INTO new_fit;

    UPDATE app.tyre t
       SET last_tread_mm = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                THEN mv.tread ELSE t.last_tread_mm END,
           last_tread_at = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                THEN stamp ELSE t.last_tread_at END
     WHERE t.id = mv.tid;

    SELECT p.code INTO to_code FROM app.position p WHERE p.id = mv.pid;
    SELECT v.fleet_number INTO to_fleet FROM app.vehicle v WHERE v.id = mv.vid;
    -- One event per casing, and its states repeat FITTED: the casing did not
    -- leave the estate, it changed position, possibly onto another unit of
    -- the same rig. Two to_state events sharing one instant would leave
    -- app.tyre_in_estate_asof unable to say which is later, which is the
    -- ambiguity app.dispatch_tyre's own instant guard exists to prevent; the
    -- move is recorded in the fitment rows, which is where "which unit" has
    -- always lived (FR-VAL-022, 000030's state_change_carries_to_state).
    -- Its reason is 'rotation', so the back-date reason rides in the payload,
    -- as app.remove_tyre's does.
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                                from_state, to_state, reason, payload)
    VALUES (app.current_tenant_id(), mv.tid, 'ROTATED', stamp,
            'FITTED', 'FITTED', 'rotation',
            jsonb_build_object('from_position_code', befores->(mv.tid::text)->>'code',
                               'to_position_code', to_code,
                               'from_vehicle_id', befores->(mv.tid::text)->>'vehicle_id',
                               'to_vehicle_id', mv.vid,
                               'from_fleet_number', befores->(mv.tid::text)->>'fleet_number',
                               'to_fleet_number', to_fleet,
                               'fitment_id', new_fit,
                               'backdate_reason',
                               NULLIF(btrim(COALESCE(p_backdate_reason, '')), '')));

    tyre_id    := mv.tid;
    fitment_id := new_fit;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION app.return_tyre_to_stock(p_tyre uuid, p_depot uuid DEFAULT NULL,
                                         p_occurred_at timestamptz DEFAULT NULL,
                                         p_backdate_reason text DEFAULT NULL,
                                         p_occurred_on date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  stamp timestamptz;
  ty    app.tyre;
  dep   app.depot;
BEGIN
  SELECT * INTO ty FROM app.tyre t WHERE t.id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  -- A day or an instant, never both, as app.fit_tyre says.
  IF p_occurred_at IS NOT NULL AND p_occurred_on IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement names a day or an instant, not both';
  END IF;
  -- FR-FIT-013's receipt back covers the casing the workshop has in hand. A
  -- casing at the retreader leaves that state only through Log Retread (D3),
  -- which is what records the new tread, the cost and the casing decision;
  -- restocking it here would lose all three.
  IF ty.state NOT IN ('REMOVED', 'AT_BREAKDOWN_SUPPLIER') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; only a removed or returned casing is restocked here', ty.state),
      HINT    = 'a casing at the retreader comes back through Log Retread (TYRE-93)';
  END IF;
  IF p_depot IS NOT NULL THEN
    SELECT * INTO dep FROM app.depot d WHERE d.id = p_depot;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such depot in this fleet';
    END IF;
    IF dep.type NOT IN ('DEPOT', 'STORE') OR NOT dep.active THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('%s is not an active depot or store', dep.name);
    END IF;
  END IF;
  IF p_occurred_on IS NULL THEN
    stamp := COALESCE(p_occurred_at, now());
    PERFORM app.fitment_instant_ok(p_tyre, stamp, p_backdate_reason);
  ELSE
    PERFORM app.backdate_reason_ok(p_occurred_on, p_backdate_reason);
    stamp := app.place_movement(p_occurred_on, ARRAY[p_tyre]);
  END IF;

  -- A NULL depot leaves the casing where it already is rather than clearing
  -- it: the return says the fleet has it back, not that it moved.
  UPDATE app.tyre t
     SET state = 'IN_STOCK', current_depot_id = COALESCE(p_depot, t.current_depot_id)
   WHERE t.id = p_tyre;
  -- A return has no reason of its own, so the back-date reason is the
  -- event's reason, as app.fit_tyre's is (FR-FIT-016).
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, payload)
  VALUES (app.current_tenant_id(), p_tyre, 'RETURNED', stamp,
          ty.state, 'IN_STOCK', NULLIF(btrim(COALESCE(p_backdate_reason, '')), ''),
          jsonb_build_object('depot_id', COALESCE(p_depot, ty.current_depot_id)));
END $$;
