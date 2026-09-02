-- ============================================================================
--  Log Retread: the return that re-rates the casing (TYRE-93)
--  Implements: FR-FIT-021, FR-FIT-022, FR-TYR-009, FR-TYR-018, FR-TYR-019,
--  BR-VAL-004, BR-VAL-006, BR-FIT-009, FR-CFG-044;
--  U5 (the cap is the tenant-wide policy row),
--  U9 (a rejected casing writes a zero RETREADER valuation citing the job)
-- ============================================================================
-- SQLSTATEs, the same three the fitment surface raises (ADR-0012):
--   TY012 — an invalid lifecycle transition, or a row this tenant cannot see
--   TY014 — an input this surface does not accept
--   TY015 — the casing is at its retread cap (BR-FIT-009)
--
-- This is the one place a retread's arithmetic is done. The rate is recomputed
-- from the retread cost through app.rand_per_mm, so the same implementation
-- Appendix E is pinned against governs a retreaded casing too (FR-VAL-006).
--
-- app.tyre.casing_value is deliberately NOT written. The register's casing
-- precedence (000013, app.tyre_valuation_asof) reads the latest
-- casing_valuation row first and falls back to that column only as the
-- onboarding AUDIT figure; writing both would give one casing two numbers of
-- different provenance and no rule to choose between them.
--
-- Invoker rights, like the rest of the surface: it runs as app_rw inside the
-- caller's tenant-bound transaction, so RLS binds it (suite check 8c).
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
  tz      text;
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
BEGIN
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();

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
  IF p_returned_on > app.tenant_today(tz) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = 'a casing returns on or before today, never on a future date';
  END IF;

  -- app.dispatch_tyre's instant rule (000033), applied to the return end of
  -- the same journey: today means now(), an earlier date means midnight in
  -- the tenant's zone, and an instant behind the tyre's last movement is
  -- refused rather than clamped onto it (FR-FIT-016, FR-VAL-022).
  stamp := CASE WHEN p_returned_on = app.tenant_today(tz) THEN now()
                ELSE least((p_returned_on::timestamp AT TIME ZONE tz), now()) END;
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
    -- client as a bare 22003. Same bound and same wording as app.fit_tyre.
    IF p_post_tread_mm <= 0 OR p_post_tread_mm > 30 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = 'a retread return records its tread in millimetres, above 0 and at most 30';
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
           rand_per_mm      = app.rand_per_mm(cost, tread, thr),
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
