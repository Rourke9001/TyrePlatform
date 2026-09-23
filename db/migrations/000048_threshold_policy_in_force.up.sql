-- ============================================================================
--  One resolver for the threshold policy in force now (TYRE-211, TYRE-142)
--  Implements: FR-CFG-051, FR-CFG-044, FR-FIT-006, BR-FIT-009, FR-VAL-006,
--  FR-ANL-004
-- ============================================================================
-- No new SQLSTATE. Every routine here runs with invoker rights (db/CLAUDE.md,
-- "Adding a function").
--
-- A threshold_policy row answers two questions, and they part at one
-- instant. An as-at reader values a day and passes that day's exclusive
-- upper edge to app.threshold_policy_for (000045). A writer asks what governs
-- the call it is making, and a row effective at that instant governs it, so a
-- policy written earlier in the same transaction applies to the next write
-- (FR-CFG-051). Every reader of the second kind resolves through
-- app.threshold_policy_in_force, and log_retread_return takes its removal
-- threshold and its retread cap from one resolution of it, so one call cannot
-- read the two from different rows (TYRE-142).
--
-- fit_tyre, dispatch_tyre and log_retread_return are restated whole, with the
-- signatures, defaults and search_path pins they carry, so CREATE OR REPLACE
-- keeps each routine's oid and grants.

-- The dimensions and precedence of app.threshold_policy_for: an
-- operating-group row over a tenant-wide one, an axle-class row over a
-- class-blind one, latest effective within each. A row is in force from its
-- own effective_from instant, so now() is an inclusive edge here (FR-CFG-051,
-- TYRE-142). Section 63 holds the two resolvers to one precedence.
CREATE FUNCTION app.threshold_policy_in_force(p_tenant uuid, p_operating_group uuid,
                                              p_axle_class app.axle_class)
RETURNS app.threshold_policy
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM app.threshold_policy p
   WHERE p.tenant_id = p_tenant
     AND (p.operating_group_id IS NULL OR p.operating_group_id = p_operating_group)
     AND (p.axle_class IS NULL OR p.axle_class = p_axle_class)
     AND p.effective_from <= now()
   ORDER BY (p.operating_group_id IS NULL), (p.axle_class IS NULL), p.effective_from DESC
   LIMIT 1
$$;

-- The session tenant's removal point in force now, the tenant-wide row's
-- retread threshold, which receive_tyres and set_tyre_cost price the stored
-- rand_per_mm against (FR-VAL-006, TYRE-142).
CREATE OR REPLACE FUNCTION app.current_removal_threshold_mm() RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT (app.threshold_policy_in_force(app.current_tenant_id(), NULL, NULL)).retread_threshold_mm
$$;

-- A forecast is judged against the policy in force now (FR-ANL-004,
-- TYRE-142). thr.mm is read at several sites below, so the resolver sits
-- behind an OFFSET 0 fence (000045's header gives the mechanism, TYRE-41).
-- The ::numeric keeps removal_threshold_mm the unconstrained numeric it is
-- declared as, which CREATE OR REPLACE VIEW requires of an existing column.
CREATE OR REPLACE VIEW app.v_removal_forecast WITH (security_invoker = true) AS
SELECT ft.tenant_id,
       ft.tyre_id,
       ft.display_code,
       ft.vehicle_id,
       ft.fleet_number,
       ft.depot_name,
       ft.position_code,
       ft.is_spare,
       ft.current_tread_mm,
       ft.read_at AS later_read_at,
       thr.mm AS removal_threshold_mm,
       w.rate_mm_per_month AS wear_rate_mm_per_month,
       osib.wear_rate_mm_per_1000km,
       w.reading_count,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN (ft.read_at AT TIME ZONE 'UTC')::date
            ELSE pred.earliest END AS earliest_removal_date,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN (ft.read_at AT TIME ZONE 'UTC')::date
            ELSE pred.latest END AS latest_removal_date,
       CASE WHEN thr.mm IS NOT NULL AND ft.current_tread_mm IS NOT NULL
             AND ft.current_tread_mm <= thr.mm
            THEN 'AT_OR_BELOW_THRESHOLD' ELSE pred.basis END AS basis,
       CASE WHEN thr.mm IS NULL                    THEN 'NO_THRESHOLD_POLICY'
            WHEN ft.current_tread_mm IS NULL       THEN 'INSUFFICIENT_DATA'
            WHEN ft.current_tread_mm <= thr.mm     THEN 'AT_OR_BELOW_THRESHOLD'
            WHEN w.rate_mm_per_month IS NULL       THEN 'INSUFFICIENT_DATA'
            WHEN w.rate_mm_per_month <= 0          THEN 'NO_MEASURABLE_WEAR'
            ELSE 'FORECAST' END AS forecast_status
  FROM app.v_fitted_tread ft
  CROSS JOIN LATERAL (
       SELECT (app.threshold_policy_in_force(ft.tenant_id, NULL, NULL)).retread_threshold_mm::numeric AS mm
       OFFSET 0) thr
  CROSS JOIN LATERAL app.wear_rate_mm_per_month(ft.tyre_id) w
  CROSS JOIN LATERAL app.predicted_threshold_range(
       ft.tyre_id, ft.current_tread_mm, thr.mm) pred
  LEFT JOIN LATERAL (
       SELECT wr.wear_rate_mm_per_1000km
         FROM app.v_tyre_wear_rate wr
        WHERE wr.tyre_id = ft.tyre_id
        LIMIT 1) osib ON true;

CREATE OR REPLACE FUNCTION app.fit_tyre(p_tyre uuid, p_vehicle uuid, p_position uuid,
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
      -- p_occurred_at.
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

CREATE OR REPLACE FUNCTION app.dispatch_tyre(p_tyre uuid, p_destination app.tyre_state,
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
    cap := (app.threshold_policy_in_force(app.current_tenant_id(), NULL, NULL)).max_retreads;
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
CREATE OR REPLACE FUNCTION app.log_retread_return(p_job uuid, p_returned_on date,
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
  pol     app.threshold_policy;
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
  -- The ceiling is the column's own capacity, not a policy limit. A limit on
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
    -- so an accepted casing may not carry one. The register labels both
    -- ACTUAL from the RETREADER source alone and could not tell them apart.
    IF cval <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'an accepted casing carries a value above zero; a zero belongs to a rejection (FR-TYR-009)';
    END IF;

    -- One resolution serves the threshold here and the cap below, so a policy
    -- committed between the two statements cannot split them (TYRE-142).
    pol := app.threshold_policy_in_force(app.current_tenant_id(), NULL, NULL);
    thr := pol.retread_threshold_mm;
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
    -- app.tyre.rand_per_mm on the UPDATE below as a bare 22003, outside the
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
    -- force now. Same resolver as the dispatch: U5, a REMOVED casing has no
    -- axle class, so the tenant-wide row governs.
    cap := pol.max_retreads;
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
    -- new tread and a new rate, the CR-012 defect of a stale figure read as
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
    -- rather than left absent. An absent figure reads as UNVALUED in the
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
