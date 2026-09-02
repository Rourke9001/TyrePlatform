-- ============================================================================
--  The fitment surface: fit, remove, rotate, dispatch, return (TYRE-92)
--  Implements: FR-FIT-001..010, FR-FIT-012, FR-FIT-013, FR-FIT-016,
--  FR-FIT-020, FR-CFG-044, BR-FIT-009, CR-012, D13, D14;
--  U1 (fit is from IN_STOCK), U2 (dispatch is from REMOVED), U3 (a rotation
--  is within one unit), U5 (the cap is the tenant-wide policy row),
--  U8 (REFITTED once a casing has a fitment history), U10 (tread readings
--  move last_tread_mm forward in time only), U11 (a retread on a
--  non-permitted axle warns; only the cap refuses)
-- ============================================================================
-- SQLSTATEs (all ours; the TY class forwards verbatim, ADR-0012):
--   TY012 — an invalid lifecycle transition, or a row this tenant cannot see
--   TY014 — an input this surface does not accept
--   TY015 — the casing is at its retread cap (BR-FIT-009)
--
-- A missing row and another tenant's row are indistinguishable under RLS, so
-- each object gets its own message rather than a shared one: a cross-tenant
-- probe can then pin which branch refused it and prove that isolation, not
-- some second rule, is what did the refusing (suite 41r).
--
-- Invoker rights on all six, like every routine in app except
-- app.refresh_governing_tread: they run as app_rw inside the caller's
-- tenant-bound transaction, so RLS binds them (suite check 8c).
--
-- Occupancy is deliberately absent from these functions. One tyre per open
-- position and one open fitment per tyre are the two partial unique indexes
-- from 000001; a pre-check here would be a second implementation that a raw
-- INSERT walks past (FR-FIT-004, suite 41d).

-- FR-FIT-016, one rule for every writer below rather than four copies of it.
-- app.tyre_in_estate_asof and the wear-rate views read a tyre's LATEST
-- to_state event, so an instant stamped out of order silently reorders the
-- tyre's history — the same invariant app.dispose_tyre guards from the
-- disposal end (000031). A backdate of more than a day is a claim about the
-- past that has to carry its justification into the record.
CREATE FUNCTION app.fitment_instant_ok(p_tyre uuid, p_at timestamptz, p_reason text)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE last_at timestamptz;
BEGIN
  IF p_at IS NULL OR p_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a fitment movement is recorded as at now or earlier, never in the future';
  END IF;
  SELECT max(e.occurred_at) INTO last_at
    FROM app.tyre_event e WHERE e.tyre_id = p_tyre AND e.to_state IS NOT NULL;
  IF last_at IS NOT NULL AND p_at < last_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre''s last recorded movement is %s; this one cannot predate it', last_at);
  END IF;
  IF p_at < now() - interval '24 hours'
     AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a movement backdated more than 24 hours records why',
      HINT    = 'give the reason the workshop recorded it late (FR-FIT-016)';
  END IF;
END $$;

CREATE FUNCTION app.fit_tyre(p_tyre uuid, p_vehicle uuid, p_position uuid,
                             p_tread_mm numeric,
                             p_mount_orientation app.mount_orientation,
                             p_odometer bigint DEFAULT NULL,
                             p_occurred_at timestamptz DEFAULT now(),
                             p_reason text DEFAULT NULL)
RETURNS TABLE (fitment_id uuid, warnings jsonb)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
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
  -- the row is what makes the pair race-free in both directions — the
  -- disposal's FOR UPDATE waits for an in-flight fit, and a fit that starts
  -- after one sees the committed status — while two fits on the same unit
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

  -- FR-FIT-001: a fitment records the tread it went on at. The upper bound is
  -- the deepest drive pattern sold plus headroom, so a keyed-in odometer or a
  -- misplaced decimal is refused rather than stored as a tread.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > 30 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a fitment records its tread in millimetres, above 0 and at most 30';
  END IF;
  PERFORM app.fitment_instant_ok(p_tyre, p_occurred_at, p_reason);

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
  -- rule reaches a fit at all (CHG-038 — fleet practice, never a legal claim).
  IF ty.status = 'RETREAD' THEN
    SELECT tp.retreads_permitted INTO permitted
      FROM app.threshold_policy tp
     WHERE tp.tenant_id = app.current_tenant_id()
       AND tp.operating_group_id IS NULL
       AND (tp.axle_class = pos.axle_class OR tp.axle_class IS NULL)
       AND tp.effective_from <= now()
     ORDER BY (tp.axle_class IS NULL), tp.effective_from DESC
     LIMIT 1;
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
      SELECT o.last_tread_mm INTO mate
        FROM app.fitment f
        JOIN app.position p ON p.id = f.position_id
        JOIN app.tyre o     ON o.id = f.tyre_id
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
  VALUES (app.current_tenant_id(), p_tyre, p_vehicle, p_position, p_occurred_at,
          p_odometer, p_tread_mm, p_mount_orientation)
  RETURNING id INTO new_fit;

  -- current_depot_id goes to NULL: a fitted casing is on a unit, and leaving
  -- the depot set would keep it in that depot's stock counts.
  -- U10: the tread moves forward in time only, so a backdated fit cannot
  -- overwrite a newer inspection's reading.
  UPDATE app.tyre t
     SET state            = 'FITTED',
         current_depot_id = NULL,
         last_tread_mm    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                 THEN p_tread_mm ELSE t.last_tread_mm END,
         last_tread_at    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                 THEN p_occurred_at ELSE t.last_tread_at END
   WHERE t.id = p_tyre;

  -- The backdate justification is carried onto the event rather than
  -- discarded: requiring it and then dropping it would leave FR-FIT-016's
  -- rule with nothing to show for itself.
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, payload)
  VALUES (app.current_tenant_id(), p_tyre,
          CASE WHEN prior THEN 'REFITTED' ELSE 'FITTED' END,
          p_occurred_at, ty.state, 'FITTED',
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
                                p_occurred_at timestamptz DEFAULT now(),
                                p_backdate_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
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
  -- are computed from, so it is required on the same terms as the fitment's.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > 30 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a removal records its tread in millimetres, above 0 and at most 30';
  END IF;
  PERFORM app.fitment_instant_ok(fit.tyre_id, p_occurred_at, p_backdate_reason);

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
     SET removed_at       = p_occurred_at,
         removed_odometer = p_odometer,
         removed_tread_mm = p_tread_mm,
         removal_reason   = p_reason,
         distance_km      = km,
         distance_source  = src
   WHERE f.id = p_fitment;

  -- A removed casing comes to rest at the unit's home depot: that is where
  -- the workshop physically has it, and stock reports read current_depot_id.
  SELECT v.home_depot_id INTO home FROM app.vehicle v WHERE v.id = fit.vehicle_id;
  UPDATE app.tyre t
     SET state            = 'REMOVED',
         current_depot_id = home,
         last_tread_mm    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                 THEN p_tread_mm ELSE t.last_tread_mm END,
         last_tread_at    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                 THEN p_occurred_at ELSE t.last_tread_at END
   WHERE t.id = fit.tyre_id;

  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, payload)
  VALUES (app.current_tenant_id(), fit.tyre_id, 'REMOVED', p_occurred_at,
          ty.state, 'REMOVED', p_reason,
          jsonb_build_object('fitment_id', p_fitment,
                             'distance_km', km,
                             'distance_source', src));
END $$;

CREATE FUNCTION app.rotate_tyres(p_vehicle uuid, p_moves jsonb,
                                 p_odometer bigint DEFAULT NULL,
                                 p_occurred_at timestamptz DEFAULT now())
RETURNS TABLE (tyre_id uuid, fitment_id uuid)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  veh     app.vehicle;
  m       jsonb;
  mv      record;
  befores jsonb;
  moved   uuid[];
  n_moves  int;
  n_uniq   int;
  n_closed int;
  new_fit  uuid;
  to_code  text;
BEGIN
  SELECT * INTO veh FROM app.vehicle v WHERE v.id = p_vehicle FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such unit in this fleet';
  END IF;
  -- INV-2's converse, on the other writer that opens a fitment; the lock and
  -- the DISPOSED-only scope are app.fit_tyre's, for its reasons.
  IF veh.status = 'DISPOSED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'this unit is disposed; nothing is fitted to it';
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

  -- Everything is validated before anything is written: the RAISE rolls this
  -- function's own transaction back, but a caller holding a savepoint around
  -- it must not be able to keep half a rotation (FR-FIT-010, FR-FIT-014).
  -- The checks run as ordered passes rather than per move, so which rule
  -- refuses a set does not depend on the order the moves were listed in, and
  -- a tyre that is not on this unit is reported as such instead of as a
  -- position clash on a unit it was never on.
  FOR m IN SELECT e.value FROM jsonb_array_elements(p_moves) e LOOP
    -- U3: a rotation moves tyres this unit is carrying. Cross-unit moves
    -- inside a rig are a coupling question, not this surface's.
    IF NOT EXISTS (SELECT 1 FROM app.fitment f
                    WHERE f.tyre_id = (m->>'tyre_id')::uuid
                      AND f.vehicle_id = p_vehicle AND f.removed_at IS NULL) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('tyre %s is not on this unit', m->>'tyre_id');
    END IF;
  END LOOP;

  FOR m IN SELECT e.value FROM jsonb_array_elements(p_moves) e LOOP
    IF NOT EXISTS (SELECT 1 FROM app.position p
                    WHERE p.id = (m->>'to_position_id')::uuid
                      AND p.configuration_id = veh.configuration_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such position on this unit';
    END IF;
    IF (m->>'tread_mm')::numeric IS NULL
       OR (m->>'tread_mm')::numeric <= 0 OR (m->>'tread_mm')::numeric > 30 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'every move records its tread in millimetres, above 0 and at most 30';
    END IF;
    -- A rotation never displaces a tyre it was not told about: a target is
    -- either empty or vacated by this same set of moves.
    IF EXISTS (SELECT 1 FROM app.fitment f
                WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL
                  AND f.position_id = (m->>'to_position_id')::uuid
                  AND NOT (f.tyre_id = ANY (moved))) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('position %s carries a tyre this rotation does not move',
                         (SELECT p.code FROM app.position p WHERE p.id = (m->>'to_position_id')::uuid));
    END IF;
    PERFORM app.fitment_instant_ok((m->>'tyre_id')::uuid, p_occurred_at, NULL);
  END LOOP;

  SELECT count(DISTINCT e.value->>'to_position_id'), count(*) INTO n_uniq, n_moves
    FROM jsonb_array_elements(p_moves) e;
  IF n_uniq <> n_moves THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'two moves cannot target the same position';
  END IF;
  IF array_length(ARRAY(SELECT DISTINCT unnest(moved)), 1) <> n_moves THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'a tyre appears twice in this rotation';
  END IF;
  -- The same bound remove_tyre applies, checked here so the whole set is
  -- refused before any row is closed (FR-FIT-009).
  IF p_odometer IS NOT NULL AND EXISTS (
       SELECT 1 FROM app.fitment f
        WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL
          AND f.tyre_id = ANY (moved)
          AND f.fitted_odometer IS NOT NULL AND f.fitted_odometer > p_odometer) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('this unit reads %s, below the odometer of a fitment being rotated out', p_odometer);
  END IF;

  -- Where each casing is coming from, read while the rows are still open.
  SELECT jsonb_object_agg(f.tyre_id::text,
                          jsonb_build_object('code', p.code,
                                             'orientation', f.mount_orientation::text))
    INTO befores
    FROM app.fitment f
    JOIN app.position p ON p.id = f.position_id
   WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL AND f.tyre_id = ANY (moved);

  -- Every fitment closes before any opens. A swap passes through a moment
  -- where two tyres would claim one position, and the partial unique indexes
  -- are checked per statement, so closing first is what keeps them quiet.
  -- One reading per tyre serves both ends of the move: the casing is measured
  -- once, on the ground, during the rotation.
  UPDATE app.fitment f
     SET removed_at       = p_occurred_at,
         removed_odometer = p_odometer,
         removed_tread_mm = (SELECT (e.value->>'tread_mm')::numeric
                               FROM jsonb_array_elements(p_moves) e
                              WHERE (e.value->>'tyre_id')::uuid = f.tyre_id),
         removal_reason   = 'rotation',
         distance_km      = CASE WHEN p_odometer IS NOT NULL AND f.fitted_odometer IS NOT NULL
                                 THEN p_odometer - f.fitted_odometer END,
         distance_source  = CASE WHEN p_odometer IS NOT NULL AND f.fitted_odometer IS NOT NULL
                                 THEN 'MEASURED'::app.distance_provenance
                                 ELSE 'UNAVAILABLE'::app.distance_provenance END
   WHERE f.vehicle_id = p_vehicle AND f.removed_at IS NULL AND f.tyre_id = ANY (moved);

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

  FOR mv IN SELECT (e.value->>'tyre_id')::uuid       AS tid,
                   (e.value->>'to_position_id')::uuid AS pid,
                   (e.value->>'tread_mm')::numeric    AS tread
              FROM jsonb_array_elements(p_moves) e LOOP
    -- D13: a rotation does not turn the casing round, so the orientation
    -- comes off the closed row. A flip is a remove and a fit.
    INSERT INTO app.fitment (tenant_id, tyre_id, vehicle_id, position_id, fitted_at,
                             fitted_odometer, fitted_tread_mm, mount_orientation)
    VALUES (app.current_tenant_id(), mv.tid, p_vehicle, mv.pid, p_occurred_at,
            p_odometer, mv.tread,
            (befores->(mv.tid::text)->>'orientation')::app.mount_orientation)
    RETURNING id INTO new_fit;

    UPDATE app.tyre t
       SET last_tread_mm = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                THEN mv.tread ELSE t.last_tread_mm END,
           last_tread_at = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                THEN p_occurred_at ELSE t.last_tread_at END
     WHERE t.id = mv.tid;

    SELECT p.code INTO to_code FROM app.position p WHERE p.id = mv.pid;
    -- to_state repeats FITTED although the state has not changed: the
    -- state_change_carries_to_state CHECK exempts only BRANDED and INSPECTED,
    -- and app.tyre_in_estate_asof resolves a tyre from its latest to_state
    -- event, so a rotation that carried none would hand the estate the
    -- movement before it (FR-VAL-022).
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                                from_state, to_state, reason, payload)
    VALUES (app.current_tenant_id(), mv.tid, 'ROTATED', p_occurred_at,
            'FITTED', 'FITTED', 'rotation',
            jsonb_build_object('from_position_code', befores->(mv.tid::text)->>'code',
                               'to_position_code', to_code,
                               'fitment_id', new_fit));

    tyre_id    := mv.tid;
    fitment_id := new_fit;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION app.dispatch_tyre(p_tyre uuid, p_destination app.tyre_state,
                                  p_depot uuid, p_sent_on date DEFAULT NULL)
RETURNS TABLE (retread_job_id uuid)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tz    text;
  ty    app.tyre;
  dep   app.depot;
  want  app.depot_type;
  sent    date;
  stamp   timestamptz;
  last_at timestamptz;
  cap     int;
  job     uuid;
BEGIN
  IF p_destination NOT IN ('AT_RETREADER', 'AT_BREAKDOWN_SUPPLIER') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a dispatch is to the retreader or to the breakdown supplier';
  END IF;
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  SELECT * INTO ty FROM app.tyre t WHERE t.id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  -- U2: Appendix C lists no dispatch out of stock, and FR-TYR-011 makes every
  -- transition it does not list invalid.
  IF ty.state <> 'REMOVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; a dispatch is from REMOVED only', ty.state);
  END IF;

  want := CASE WHEN p_destination = 'AT_RETREADER' THEN 'RETREADER' ELSE 'BREAKDOWN_SUPPLIER' END;
  SELECT * INTO dep FROM app.depot d WHERE d.id = p_depot;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such depot in this fleet';
  END IF;
  -- The depot type is what makes the casing's location meaningful: a casing
  -- "at the retreader" that is really at a branch is a lost casing
  -- (FR-FIT-012, FR-FIT-013).
  IF dep.type <> want OR NOT dep.active THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('%s is not an active %s', dep.name, want);
  END IF;

  sent := COALESCE(p_sent_on, app.tenant_today(tz));
  IF sent > app.tenant_today(tz) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a casing is sent on or before today, never on a future date';
  END IF;
  -- FR-VAL-022, FR-FIT-016. app.tyre_in_estate_asof resolves a tyre's state
  -- from its LATEST to_state event, so this instant decides whether the
  -- estate agrees with app.tyre.state. Today's date means now(), not the
  -- calendar day's opening midnight: midnight would lose to the same day's
  -- removal and leave the estate reading REMOVED while the row reads
  -- AT_RETREADER. An earlier date means midnight in the TENANT's zone
  -- (rule 6) rather than the session's, still never ahead of now().
  stamp := CASE WHEN sent = app.tenant_today(tz) THEN now()
                ELSE least((sent::timestamp AT TIME ZONE tz), now()) END;
  IF stamp > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a dispatch is recorded as at now or earlier, never in the future';
  END IF;
  -- The guard is inline rather than app.fitment_instant_ok: that helper's
  -- 24-hour rule needs a justification parameter, and a dispatch carries a
  -- date rather than an instant, so there is none to pass it. The known
  -- cost, accepted: a send that happened on Monday and is logged on Tuesday
  -- is refused unless it is recorded as Tuesday's.
  --
  -- Refused, never clamped to the last event: two to_state events sharing one
  -- instant leave the estate resolution ambiguous, which is the failure this
  -- guard exists to prevent rather than to relocate.
  SELECT max(e.occurred_at) INTO last_at
    FROM app.tyre_event e WHERE e.tyre_id = p_tyre AND e.to_state IS NOT NULL;
  IF last_at IS NOT NULL AND stamp < last_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre''s last recorded movement is %s; a dispatch cannot predate it', last_at);
  END IF;

  IF p_destination = 'AT_RETREADER' THEN
    -- U5: a REMOVED casing has no axle class, so the per-class rows cannot
    -- govern it; the cap is the tenant-wide policy row (FR-CFG-044).
    SELECT tp.max_retreads INTO cap
      FROM app.threshold_policy tp
     WHERE tp.tenant_id = app.current_tenant_id()
       AND tp.operating_group_id IS NULL
       AND tp.axle_class IS NULL
       AND tp.effective_from <= now()
     ORDER BY tp.effective_from DESC
     LIMIT 1;
    -- Refused rather than treated as unlimited, and refused as a refusal:
    -- an unconfigured cap is the tenant's gap to close, and a bare P0001
    -- would reach the client as a retried 500 (ADR-0012, rule 5).
    IF cap IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY015',
        MESSAGE = 'no retread policy is configured for this fleet',
        HINT    = 'set max_retreads on the fleet-wide threshold policy (FR-CFG-044)';
    END IF;
    -- BR-FIT-009: the one dispatch rule that refuses. Past its cap the casing
    -- has no retread left in it, so sending it costs the retread fee for a
    -- carcass that comes back as scrap.
    IF ty.retread_count >= cap THEN
      RAISE EXCEPTION USING ERRCODE = 'TY015',
        MESSAGE = format('this casing has been retreaded %s time(s), at a cap of %s; at its cap it is a purchase, not a retread candidate',
                         ty.retread_count, cap);
    END IF;
    INSERT INTO app.retread_job (tenant_id, tyre_id, retreader_depot_id, sent_at)
    VALUES (app.current_tenant_id(), p_tyre, p_depot, sent)
    RETURNING id INTO job;
  END IF;

  UPDATE app.tyre t SET state = p_destination, current_depot_id = p_depot WHERE t.id = p_tyre;
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, payload)
  VALUES (app.current_tenant_id(), p_tyre,
          CASE WHEN p_destination = 'AT_RETREADER'
               THEN 'SENT_FOR_RETREAD' ELSE 'SENT_TO_BREAKDOWN_SUPPLIER' END,
          stamp, ty.state, p_destination,
          jsonb_build_object('depot_id', p_depot, 'retread_job_id', job));

  retread_job_id := job;
  RETURN NEXT;
END $$;

CREATE FUNCTION app.return_tyre_to_stock(p_tyre uuid, p_depot uuid DEFAULT NULL,
                                         p_occurred_at timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  ty  app.tyre;
  dep app.depot;
BEGIN
  SELECT * INTO ty FROM app.tyre t WHERE t.id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
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
  PERFORM app.fitment_instant_ok(p_tyre, p_occurred_at, NULL);

  -- A NULL depot leaves the casing where it already is rather than clearing
  -- it: the return says the fleet has it back, not that it moved.
  UPDATE app.tyre t
     SET state = 'IN_STOCK', current_depot_id = COALESCE(p_depot, t.current_depot_id)
   WHERE t.id = p_tyre;
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, payload)
  VALUES (app.current_tenant_id(), p_tyre, 'RETURNED', p_occurred_at,
          ty.state, 'IN_STOCK',
          jsonb_build_object('depot_id', COALESCE(p_depot, ty.current_depot_id)));
END $$;
