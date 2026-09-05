-- ============================================================================
--  A rotation crosses the units of one rig, and the tread ceiling and the day
--  rule each have one implementation (TYRE-101)
--  Implements: FR-FIT-001, FR-FIT-002, FR-FIT-007, FR-FIT-009, FR-FIT-010,
--  FR-FIT-014, FR-FIT-016, FR-FIT-020, FR-FIT-021, FR-FIT-022, FR-VAL-022,
--  FR-VEH-031, FR-CFG-044, BR-FIT-005, BR-FIT-009, BR-VAL-004, CR-012;
--  B6.3's U8 (a date reaches an instant through app.tenant_day_instant),
--  U15 (a move names its destination; the source is derived),
--  U16 (the scope is one rig, resolved at the rotation's own instant),
--  U17 (a rotation need not move anything on the unit it is addressed to),
--  U18 (a target is the unit-and-position pair), U19 (one ROTATED per casing),
--  U20 (an odometer reading per unit), U21 (one tread ceiling),
--  U22 (the dual-mate warning reads its mate as at the fitment instant)
--  — docs/superpowers/specs/2026-09-03-b6-rig-setup-design.md
-- ============================================================================
-- SQLSTATEs (all ours; the TY class forwards verbatim, ADR-0012):
--   TY012 — an invalid lifecycle transition, or a row this tenant cannot see
--   TY014 — an input this surface does not accept
--   TY015 — the casing is at its retread cap (BR-FIT-009)
--
-- A missing row and another tenant's row are indistinguishable under RLS, so
-- each object gets its own message rather than a shared one: a cross-tenant
-- probe can then pin which branch refused it and prove that isolation, not
-- some second rule, is what did the refusing (suite 41r, 47f).
--
-- The writers below are created whole rather than amended: where a slice needs
-- a shape a function does not have, the function is replaced entire and its
-- body goes with it (the B6 design spec's rule for the code it meets). The
-- drops carry full argument lists and no existence guard, so a signature that
-- has already moved fails this migration loudly rather than leaving a second
-- overload behind for a caller to resolve against.
--
-- Two U-tables meet in this file and their numbering collides. The U-codes
-- inside app.fit_tyre, app.remove_tyre, app.dispatch_tyre and
-- app.log_retread_return are the fitment surface's own (TYRE-92, TYRE-93);
-- those inside app.rotate_tyres, like the nine named above, are B6.3's.
--
-- Invoker rights and a pinned search_path throughout, like every routine in
-- app except app.refresh_governing_tread: they run as app_rw inside the
-- caller's tenant-bound transaction, so RLS binds them (suite check 8c).
--
-- Occupancy is deliberately absent from these writers. One tyre per open
-- position and one open fitment per tyre are the two partial unique indexes
-- from 000001; a pre-check here would be a second implementation that a raw
-- INSERT walks past (FR-FIT-004, suite 41d).
DROP FUNCTION app.log_retread_return(uuid, date, boolean, text, numeric, numeric, numeric, uuid);
DROP FUNCTION app.dispatch_tyre(uuid, app.tyre_state, uuid, date);
DROP FUNCTION app.rotate_tyres(uuid, jsonb, bigint, timestamptz);
DROP FUNCTION app.remove_tyre(uuid, text, numeric, bigint, timestamptz, text);
DROP FUNCTION app.fit_tyre(uuid, uuid, uuid, numeric, app.mount_orientation, bigint, timestamptz, text);

-- The deepest drive pattern sold plus headroom: a keyed-in odometer or a
-- misplaced decimal is refused rather than stored as a tread. This is an
-- input-sanity bound and deliberately NOT tenant configuration -- a fleet
-- does not get to declare that 900mm is a tread (TYRE-128 decision 8,
-- owner of record 3 September 2026). Every writer that accepts a tread
-- calls it and interpolates it into its own refusal, so the number lives
-- here and nowhere else.
CREATE FUNCTION app.max_tread_mm() RETURNS numeric
LANGUAGE sql IMMUTABLE
SET search_path = app, pg_temp AS $$ SELECT 30::numeric $$;

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

  -- FR-FIT-001: a fitment records the tread it went on at. The ceiling is
  -- app.max_tread_mm's, for the reason stated there, and reaches the refusal
  -- through the same call rather than as a second copy of the figure.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > app.max_tread_mm() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('a fitment records its tread in millimetres, above 0 and at most %s',
                       app.max_tread_mm());
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
      -- FR-FIT-020, TYRE-126: the register ranks an inspection reading above
      -- app.tyre.last_tread_mm wherever one exists (000036), so the warning
      -- reads the same precedence -- a gap measured against a depth the
      -- dashboard does not show is a gap nobody can check. As at this
      -- fitment's own instant, not the latest overall: a reading taken after
      -- the fitter put the casing on did not inform the fitter.
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
                AND i.submitted_at <= p_occurred_at
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
  -- are computed from, so it is required on the same terms as the fitment's,
  -- against the ceiling app.max_tread_mm states and holds.
  IF p_tread_mm IS NULL OR p_tread_mm <= 0 OR p_tread_mm > app.max_tread_mm() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('a removal records its tread in millimetres, above 0 and at most %s',
                       app.max_tread_mm());
  END IF;
  -- FR-FIT-016, against the fitment row itself, which fitment_instant_ok has
  -- no way to see: that helper bounds an instant against the tyre's latest
  -- to_state EVENT, which a fitment opened outside app.fit_tyre never has —
  -- every one of the pilot tenant's 27 open fitments is in that shape. A
  -- closure stamped before its own fitment orders the casing's history
  -- against itself, the removal standing ahead of the fit that caused it,
  -- and gives the fitment a negative elapsed time — a span a distance and a
  -- cost-per-kilometre would then be computed over (FR-VAL-022, CR-012).
  IF p_occurred_at < fit.fitted_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre was fitted at %s; a removal cannot predate its own fitment',
                       fit.fitted_at);
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
  -- the workshop physically has it, and stock reports read current_depot_id
  -- (TYRE-92).
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
                                 p_odometers jsonb DEFAULT NULL,
                                 p_occurred_at timestamptz DEFAULT now())
RETURNS TABLE (tyre_id uuid, fitment_id uuid)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
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

  -- U16: the scope is one open rig, resolved AT p_occurred_at rather than at
  -- now(). A yard move recorded after the rig was uncoupled is still a move
  -- that happened while it was coupled, and FR-VEH-031 attributes over time.
  -- INV-4 (000037) makes memberships non-overlapping, so this is at most one
  -- rig; the lock is what makes a concurrent app.end_combination serialise
  -- against the answer rather than race it.
  PERFORM 1
     FROM app.combination c
     JOIN app.combination_member cm ON cm.combination_id = c.id
    WHERE cm.vehicle_id = p_vehicle
      AND c.effective_from <= p_occurred_at
      AND (c.effective_to IS NULL OR p_occurred_at < c.effective_to)
      FOR SHARE OF c;

  SELECT COALESCE(array_agg(DISTINCT cm2.vehicle_id), ARRAY[]::uuid[])
    INTO rig_units
    FROM app.combination c
    JOIN app.combination_member cm  ON cm.combination_id = c.id
                                   AND cm.vehicle_id = p_vehicle
    JOIN app.combination_member cm2 ON cm2.combination_id = c.id
   WHERE c.effective_from <= p_occurred_at
     AND (c.effective_to IS NULL OR p_occurred_at < c.effective_to);

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
  -- The checks run as ordered passes rather than per move, so which rule
  -- refuses a set does not depend on the order the moves were listed in, and
  -- a casing that is nowhere in this rig is reported as such instead of as a
  -- position clash on a unit it was never on.
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
    IF p_occurred_at < fit_at THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('tyre %s was fitted at %s; a rotation cannot predate its own fitment',
                         m->>'tyre_id', fit_at);
    END IF;
    PERFORM app.fitment_instant_ok((m->>'tyre_id')::uuid, p_occurred_at, NULL);
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
      -- rounded — an odometer the caller did not enter is a distance nobody
      -- can check afterwards (FR-FIT-009).
      IF jsonb_typeof(kv.v) <> 'number' OR (kv.v #>> '{}') !~ '^-?[0-9]+$' THEN
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
  -- Checked here so the whole set is refused before any row is closed.
  FOR un IN SELECT DISTINCT f.vehicle_id AS vid
              FROM app.fitment f
             WHERE f.removed_at IS NULL AND f.tyre_id = ANY (moved)
               AND f.vehicle_id = ANY (allowed) LOOP
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
  -- indexes are checked per statement. Odometers resolve per unit because a
  -- horse records one and a trailer has none (FR-FIT-002, TY009 on each row).
  -- One reading per tyre serves both ends of the move: the casing is measured
  -- once, on the ground, during the rotation.
  UPDATE app.fitment f
     SET removed_at       = p_occurred_at,
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
    VALUES (app.current_tenant_id(), mv.tid, mv.vid, mv.pid, p_occurred_at,
            (p_odometers ->> mv.vid::text)::bigint, mv.tread,
            (befores->(mv.tid::text)->>'orientation')::app.mount_orientation)
    RETURNING id INTO new_fit;

    UPDATE app.tyre t
       SET last_tread_mm = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                THEN mv.tread ELSE t.last_tread_mm END,
           last_tread_at = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < p_occurred_at
                                THEN p_occurred_at ELSE t.last_tread_at END
     WHERE t.id = mv.tid;

    SELECT p.code INTO to_code FROM app.position p WHERE p.id = mv.pid;
    SELECT v.fleet_number INTO to_fleet FROM app.vehicle v WHERE v.id = mv.vid;
    -- One event per casing, and its states repeat FITTED: the casing did not
    -- leave the estate, it changed position -- possibly onto another unit of
    -- the same rig. Two to_state events sharing one instant would leave
    -- app.tyre_in_estate_asof unable to say which is later, which is the
    -- ambiguity app.dispatch_tyre's own instant guard exists to prevent; the
    -- move is recorded in the fitment rows, which is where "which unit" has
    -- always lived (FR-VAL-022, 000030's state_change_carries_to_state).
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                                from_state, to_state, reason, payload)
    VALUES (app.current_tenant_id(), mv.tid, 'ROTATED', p_occurred_at,
            'FITTED', 'FITTED', 'rotation',
            jsonb_build_object('from_position_code', befores->(mv.tid::text)->>'code',
                               'to_position_code', to_code,
                               'from_vehicle_id', befores->(mv.tid::text)->>'vehicle_id',
                               'to_vehicle_id', mv.vid,
                               'from_fleet_number', befores->(mv.tid::text)->>'fleet_number',
                               'to_fleet_number', to_fleet,
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

  -- The job carries the day; the estate carries the instant that day resolves
  -- to, and the two are not the same figure.
  sent := COALESCE(p_sent_on, app.tenant_today(tz));
  -- FR-VAL-022, FR-FIT-016. app.tyre_in_estate_asof resolves a tyre's state
  -- from its LATEST to_state event, so this instant decides whether the
  -- estate agrees with app.tyre.state; app.tenant_day_instant (000037) is
  -- the one implementation of the rule that turns a day into it (U8). It
  -- answers NULL for a day the tenant has not reached, which each caller
  -- refuses in its own words, because a workshop reads about the casing it
  -- is sending rather than about a shared date helper.
  stamp := app.tenant_day_instant(p_sent_on);
  IF stamp IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a casing is sent on or before today, never on a future date';
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

-- This is the one place a retread's arithmetic is done. The rate is recomputed
-- from the retread cost through app.rand_per_mm, so the same implementation
-- Appendix E is pinned against governs a retreaded casing too (FR-VAL-006).
--
-- app.tyre.casing_value is deliberately NOT written. The register's casing
-- precedence (000013, app.tyre_valuation_asof) reads the latest
-- casing_valuation row first and falls back to that column only as the
-- onboarding AUDIT figure; writing both would give one casing two numbers of
-- different provenance and no rule to choose between them.
CREATE FUNCTION app.log_retread_return(p_job uuid, p_returned_on date,
                                       p_casing_accepted boolean,
                                       p_report_reference text,
                                       p_retread_cost numeric DEFAULT NULL,
                                       p_post_tread_mm numeric DEFAULT NULL,
                                       p_casing_value numeric DEFAULT NULL,
                                       p_new_pattern_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  job     app.retread_job;
  ty      app.tyre;
  stamp   timestamptz;
  last_at timestamptz;
  thr     numeric;
  cap     int;
  -- Every stored figure is rounded into its column's own type here, before
  -- anything divides by it or compares against it; app.receive_tyres
  -- (000031:25-30) holds the same invariant for the same reason (FR-VAL-006).
  cost    numeric(12,2);
  tread   numeric(4,1);
  cval    numeric(12,2);
  -- The one local deliberately left unconstrained. app.tyre.rand_per_mm is
  -- numeric(12,4), so typing this numeric(12,4) too would raise the very
  -- 22003 the check below exists to replace, one assignment earlier and out
  -- of reach of any rule (ADR-0012).
  rate    numeric;
BEGIN
  -- Open is part of the identity, not a separate check: a job already
  -- returned is not a job this call can act on, and RLS makes another
  -- fleet's job indistinguishable from a missing one. One message for all
  -- three (suite 42d, 42i).
  SELECT * INTO job FROM app.retread_job j
   WHERE j.id = p_job AND j.returned_at IS NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'no such open retread job in this fleet';
  END IF;
  -- FOR UPDATE on the tyre as well: the casing's state, its rate and the
  -- event move together, and a concurrent writer has to see this one's state
  -- rather than race it (the house pattern from 000031 and 000033).
  SELECT * INTO ty FROM app.tyre t WHERE t.id = job.tyre_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  IF ty.state <> 'AT_RETREADER' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; a retread return is logged against a casing at the retreader', ty.state);
  END IF;

  IF p_returned_on IS NULL OR p_returned_on < job.sent_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('a casing returns on or after the day it was sent (%s)', job.sent_at);
  END IF;
  -- The same day rule the dispatch end of this journey runs, through the same
  -- implementation (app.tenant_day_instant, 000037; U8). A day the tenant has
  -- not reached answers NULL and is refused here in this surface's own words,
  -- and an instant behind the tyre's last movement is refused below rather
  -- than clamped onto it (FR-FIT-016, FR-VAL-022).
  stamp := app.tenant_day_instant(p_returned_on);
  IF stamp IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a casing returns on or before today, never on a future date';
  END IF;
  SELECT max(e.occurred_at) INTO last_at
    FROM app.tyre_event e WHERE e.tyre_id = ty.id AND e.to_state IS NOT NULL;
  IF last_at IS NOT NULL AND stamp < last_at THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre''s last recorded movement is %s; a return cannot predate it', last_at);
  END IF;

  -- The job's return_is_complete CHECK would refuse this too, as a bare
  -- 23514 the client cannot act on; a decision the retreader has not made is
  -- a missing input, so it is refused as one (ADR-0012).
  IF p_casing_accepted IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a return records whether the retreader accepted the casing';
  END IF;
  -- Bounded on the parameter for the reason the tread bound below carries: a
  -- figure wider than numeric(12,2) overflows at the assignment on the next
  -- line and reaches the client as a bare 22003 it cannot act on (ADR-0012).
  -- The ceiling is the column's own capacity, not a policy limit — a limit on
  -- what a casing may be worth would be tenant configuration (rule 5); this
  -- is the point at which a figure stops being storable at all.
  IF abs(p_casing_value) > 9999999999.99 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a casing value is an amount of at most 9999999999.99';
  END IF;
  cval := p_casing_value;

  IF p_casing_accepted THEN
    -- Each named separately: a workshop retyping a report needs to know which
    -- figure is missing, not that one of three is.
    IF p_retread_cost IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a retread return records what the retread cost';
    END IF;
    IF p_post_tread_mm IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a retread return records the tread the casing came back on';
    END IF;
    IF cval IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a retread return records the casing value the retreader put on it';
    END IF;
    -- Checked on the parameter rather than on the local below it: a keyed-in
    -- odometer overflows numeric(4,1) at the assignment and would reach the
    -- client as a bare 22003. The ceiling is app.max_tread_mm's, read from it
    -- rather than restated; the wording is this surface's own, because what a
    -- workshop is retyping here is a retreader's report.
    IF p_post_tread_mm <= 0 OR p_post_tread_mm > app.max_tread_mm() THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('a retread return records its tread in millimetres, above 0 and at most %s',
                         app.max_tread_mm());
    END IF;
    -- Same reason on the cost side, and the same ceiling: numeric(12,2) is
    -- what the retread_job column holds, and a wider figure would 22003 at
    -- the assignment below rather than answer as an input this surface does
    -- not accept.
    IF p_retread_cost < 0 OR p_retread_cost > 9999999999.99 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a retread cost is a non-negative amount of at most 9999999999.99';
    END IF;
    cost  := p_retread_cost;
    tread := p_post_tread_mm;
    -- FR-TYR-009, BR-VAL-004: a zero casing value is what a rejection means,
    -- so an accepted casing may not carry one — the register labels both
    -- ACTUAL from the RETREADER source alone and could not tell them apart.
    IF cval <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'an accepted casing carries a value above zero; a zero belongs to a rejection (FR-TYR-009)';
    END IF;

    thr := app.current_removal_threshold_mm();
    -- An unconfigured threshold would make the comparison below NULL and the
    -- rate NULL with it, which reads downstream as an unvalued casing rather
    -- than as the tenant's gap it is (rule 5, ADR-0012).
    IF thr IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'no removal threshold is configured for this fleet',
        HINT    = 'set retread_threshold_mm on the fleet-wide threshold policy (FR-CFG-044)';
    END IF;
    -- BR-VAL-002 divides by (tread - threshold), so a casing returned at or
    -- below the threshold has no usable tread and no rate. FR-TYR-019 wants a
    -- rate on every paid retread, so the return is refused rather than stored
    -- with a NULL one.
    IF tread <= thr THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('post-retread tread must exceed the removal threshold of %s mm', thr);
    END IF;
    -- FR-VAL-006, BR-VAL-002. Bounding the cost at its own column's capacity
    -- does not bound the rate it produces: the divide is by the usable tread,
    -- so a cost at or above 10^8 times the usable millimetres overflows
    -- app.tyre.rand_per_mm on the UPDATE below as a bare 22003 — outside the
    -- TY class, a 500 on the wire, and an outbox retry that never stops. The
    -- figure that gets there is not absurd: a casing returned 0.1 mm over the
    -- threshold reaches the ceiling at R10 000 000.
    --
    -- The rate is computed once, checked, and then stored, rather than the
    -- cost being checked against a multiplied-out bound: BR-VAL-002 rounds to
    -- four places, so only the rounded figure is the figure the column has to
    -- hold, and a bound tested on anything else is testing a different number.
    rate := app.rand_per_mm(cost, tread, thr);
    IF rate >= 100000000 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('a retread cost of %s over %s mm of usable tread is a rate above what the register carries',
                         cost, tread - thr);
    END IF;
    IF p_new_pattern_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM app.tyre_pattern p WHERE p.id = p_new_pattern_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014', MESSAGE = 'no such pattern in this fleet';
    END IF;

    -- BR-FIT-009 again, on the way back: app.dispatch_tyre checked the cap
    -- when the casing went out, and the policy can be lowered in between, so
    -- the count that is about to be incremented is checked against the cap in
    -- force now. Same resolver as the dispatch — U5, a REMOVED casing has no
    -- axle class, so the tenant-wide row governs.
    SELECT tp.max_retreads INTO cap
      FROM app.threshold_policy tp
     WHERE tp.tenant_id = app.current_tenant_id()
       AND tp.operating_group_id IS NULL
       AND tp.axle_class IS NULL
       AND tp.effective_from <= now()
     ORDER BY tp.effective_from DESC
     LIMIT 1;
    IF cap IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY015',
        MESSAGE = 'no retread policy is configured for this fleet',
        HINT    = 'set max_retreads on the fleet-wide threshold policy (FR-CFG-044)';
    END IF;
    IF ty.retread_count >= cap THEN
      RAISE EXCEPTION USING ERRCODE = 'TY015',
        MESSAGE = format('this casing has been retreaded %s time(s), at a cap of %s; at its cap it is a purchase, not a retread candidate',
                         ty.retread_count, cap);
    END IF;

    -- One statement, so retread_count_matches_status (000001) holds by
    -- construction rather than by the two writes being kept in step.
    -- FR-TYR-018: a retread is a new tread depth on the same casing, and
    -- FR-TYR-019 re-rates it at what that tread cost.
    --
    -- last_tread_mm moves with it, under U10's rule and for U10's reason
    -- (stated in full at app.fit_tyre, 000033): the returned depth is a
    -- measured value on a report, and a casing left at the depth it was
    -- pulled at would sit in the register priced as worn while carrying a
    -- new tread and a new rate — the CR-012 defect of a stale figure read as
    -- current. Monotonic on time like its siblings, so a return logged
    -- against an older date never overwrites a newer measurement.
    UPDATE app.tyre t
       SET retread_count    = t.retread_count + 1,
           status           = 'RETREAD',
           new_tread_mm     = tread,
           pattern_id       = COALESCE(p_new_pattern_id, t.pattern_id),
           rand_per_mm      = rate,
           state            = 'IN_STOCK',
           current_depot_id = NULL,
           last_tread_mm    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                   THEN tread ELSE t.last_tread_mm END,
           last_tread_at    = CASE WHEN t.last_tread_at IS NULL OR t.last_tread_at < stamp
                                   THEN stamp ELSE t.last_tread_at END
     WHERE t.id = ty.id;
    -- FR-FIT-022. The retreader's figure, on a report, against the job that
    -- produced it; the register labels it ACTUAL from the source alone.
    INSERT INTO app.casing_valuation (tenant_id, tyre_id, value, source,
                                      retread_job_id, effective_from)
    VALUES (app.current_tenant_id(), ty.id, cval, 'RETREADER',
            p_job, p_returned_on);
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                                from_state, to_state, payload)
    VALUES (app.current_tenant_id(), ty.id, 'RETURNED', stamp,
            'AT_RETREADER', 'IN_STOCK',
            jsonb_build_object('retread_job_id', p_job,
                               'retread_count', ty.retread_count + 1));
  ELSE
    -- The job's rejected_casing_has_no_value CHECK is the backstop; refusing
    -- here makes it a trappable input error rather than a 23514.
    IF p_retread_cost IS NOT NULL OR COALESCE(cval, 0) <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a rejected casing carries no retread cost and no casing value';
    END IF;
    UPDATE app.tyre t SET state = 'SCRAPPED' WHERE t.id = ty.id;
    -- U9, FR-TYR-009, BR-VAL-004: the rejection is the one legitimate source
    -- of a zero casing value, and it is written as a valuation citing the job
    -- rather than left absent — an absent figure reads as UNVALUED in the
    -- register, which is a different claim from a casing the retreader
    -- inspected and found worthless.
    INSERT INTO app.casing_valuation (tenant_id, tyre_id, value, source,
                                      retread_job_id, effective_from)
    VALUES (app.current_tenant_id(), ty.id, 0, 'RETREADER', p_job, p_returned_on);
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                                from_state, to_state, reason, payload)
    VALUES (app.current_tenant_id(), ty.id, 'SCRAPPED', stamp,
            'AT_RETREADER', 'SCRAPPED', 'casing rejected by retreader',
            jsonb_build_object('retread_job_id', p_job));
  END IF;

  -- FR-FIT-021: turnaround_days is the table's generated column, so the job
  -- gets the two dates and computes it itself. The rounded locals go in, not
  -- the parameters: the job is the record the rate has to be reproducible
  -- from, so it must hold the figures the rate was derived from.
  UPDATE app.retread_job j
     SET returned_at      = p_returned_on,
         casing_accepted  = p_casing_accepted,
         report_reference = p_report_reference,
         retread_cost     = cost,
         post_tread_mm    = CASE WHEN p_casing_accepted THEN tread END,
         casing_value     = CASE WHEN p_casing_accepted THEN cval ELSE 0 END,
         new_pattern_id   = CASE WHEN p_casing_accepted THEN p_new_pattern_id END
   WHERE j.id = p_job;
END $$;
