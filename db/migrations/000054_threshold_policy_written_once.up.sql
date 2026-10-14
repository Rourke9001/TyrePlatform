-- ============================================================================
--  Threshold policy rows are written once and never back-dated (TYRE-299)
--  Implements: FR-CFG-051, FR-CFG-010, FR-CFG-012, FR-CFG-044, FR-EXC-021,
--  FR-VAL-006, FR-VAL-020, FR-TYR-019, BR-FIT-009; U68, U69, U70 items 1
--  and 3, TYRE-189 F5
-- ============================================================================
-- New SQLSTATE TY023, raised by the two triggers below and reached by no
-- route (api/internal/httpapi/refusal_codes.json). Every routine here runs
-- with invoker rights (db/CLAUDE.md, "Adding a function"). The design and the
-- owner's rulings: docs/superpowers/specs/2026-10-14-threshold-policy-integrity-design.md.
--
-- Every stored rand_per_mm divides by a threshold resolved from this table,
-- so a past row that moves moves a past valuation (FR-VAL-020), and
-- FR-VAL-006's reproduction rests on it staying put. A change is a new row
-- dated now or later (FR-CFG-051).

-- Both resolvers order by group, class, then effective_from DESC, so two rows
-- sharing all three would resolve by heap order. NULLS NOT DISTINCT because
-- the tenant-wide scope is a NULL group and a NULL class.
ALTER TABLE app.threshold_policy
  ADD CONSTRAINT threshold_policy_one_row_per_instant
  UNIQUE NULLS NOT DISTINCT (tenant_id, operating_group_id, axle_class, effective_from);

-- U68: nothing reads these. TYRE-299 comment 13723 carries the SRS change
-- for FR-CFG-010's scrap and insurance figures.
ALTER TABLE app.threshold_policy
  DROP CONSTRAINT retread_at_or_above_scrap,
  DROP COLUMN scrap_threshold_mm,
  DROP COLUMN insurance_minimum_mm,
  DROP COLUMN insurance_note;

-- FR-EXC-021's warning band lies between the two thresholds, so a warning at
-- or below the retread threshold is a band nothing can fall in (S1). A NULL
-- warning passes.
ALTER TABLE app.threshold_policy
  ADD CONSTRAINT warning_above_retread CHECK (warning_threshold_mm > retread_threshold_mm);

-- Rule 5, TYRE-189 F5: every row states its own threshold and cap. A new
-- tenant's 4 mm (FR-CFG-011) is the baseline row provisioning writes.
ALTER TABLE app.threshold_policy
  ALTER COLUMN retread_threshold_mm DROP DEFAULT,
  ALTER COLUMN max_retreads DROP DEFAULT;

-- U69. The grant stops app_rw; the trigger stops the owner and a superuser,
-- which no grant binds. threshold_policy_stamps_updated (000017) stays,
-- unreachable.
REVOKE UPDATE ON app.threshold_policy FROM app_rw;

CREATE FUNCTION app.threshold_policy_is_written_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'TY023',
    MESSAGE = 'a threshold policy row is history and is never edited; a change is a new row with a later effective_from (FR-CFG-051)';
END $$;

CREATE TRIGGER threshold_policy_written_once
BEFORE UPDATE ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.threshold_policy_is_written_once();

-- U70 item 3. now() is the transaction's start, so a row taking its DEFAULT
-- now() passes, as does any later instant. The one earlier instant is a
-- scope's first row at -infinity, the baseline FR-CFG-051 applies
-- prospectively from (SRS §5.1, errata E1).
CREATE FUNCTION app.threshold_policy_is_not_backdated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  -- A class or group scope's first baseline reaches back over all its
  -- history. That is safe only while U5 holds: no as-at reader names a class
  -- or a group, so no past figure moves.
  IF NEW.effective_from = '-infinity' THEN
    -- Under RLS this sees only the caller's tenant, which is enough because
    -- WITH CHECK refuses another tenant's row after the trigger (70c).
    -- Two sessions planting one empty scope at once can both pass it; no
    -- route writes this table and provisioning writes a scope's baseline
    -- once, so the spec accepts that race.
    IF EXISTS (SELECT 1 FROM app.threshold_policy p
                WHERE p.tenant_id = NEW.tenant_id
                  AND p.operating_group_id IS NOT DISTINCT FROM NEW.operating_group_id
                  AND p.axle_class IS NOT DISTINCT FROM NEW.axle_class) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY023',
        MESSAGE = 'this scope already has a threshold policy; only its first row may be the -infinity baseline (SRS 5.1, errata E1)';
    END IF;
  ELSIF NEW.effective_from < now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY023',
      MESSAGE = 'a threshold policy row takes effect when it is written or later, never earlier (FR-CFG-051)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER threshold_policy_not_backdated
BEFORE INSERT ON app.threshold_policy
FOR EACH ROW EXECUTE FUNCTION app.threshold_policy_is_not_backdated();

-- One inclusive resolver at any instant (U70 item 1). The predicate and the
-- precedence live here once for the in-force readers. threshold_policy_for
-- (000045) is the exclusive twin, and section 63 holds the two to one
-- precedence at any instant. threshold_policy_in_force keeps the signature
-- and oid v_removal_forecast depends on, as a projection at now(), so the
-- view, fit_tyre, dispatch_tyre and current_removal_threshold_mm still
-- resolve at now().
CREATE FUNCTION app.threshold_policy_in_force_at(p_tenant uuid, p_operating_group uuid,
                                                 p_axle_class app.axle_class, p_at timestamptz)
RETURNS app.threshold_policy
LANGUAGE sql STABLE AS $$
  SELECT p.* FROM app.threshold_policy p
   WHERE p.tenant_id = p_tenant
     AND (p.operating_group_id IS NULL OR p.operating_group_id = p_operating_group)
     AND (p.axle_class IS NULL OR p.axle_class = p_axle_class)
     AND p.effective_from <= p_at
   ORDER BY (p.operating_group_id IS NULL), (p.axle_class IS NULL), p.effective_from DESC
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.threshold_policy_in_force(p_tenant uuid, p_operating_group uuid,
                                                         p_axle_class app.axle_class)
RETURNS app.threshold_policy
LANGUAGE sql STABLE AS $$
  SELECT app.threshold_policy_in_force_at(p_tenant, p_operating_group, p_axle_class, now())
$$;

-- log_retread_return is restated whole, with its signature, defaults and
-- search_path pin, so CREATE OR REPLACE keeps its oid and grants. It stores
-- nothing new. The rate re-derives from the job's figures at the RETURNED
-- event's occurred_at, the instant it resolved at, which for a return keyed
-- today is not the start of returned_at (FR-VAL-006). That holds from the
-- commit of every policy writer open at that instant (U131, db/CLAUDE.md).

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
    -- committed between the two statements cannot split them (TYRE-142). It
    -- resolves at stamp, the RETURNED event's instant, so a back-dated return
    -- is priced and capped by the policy of its own day (U70).
    pol := app.threshold_policy_in_force_at(app.current_tenant_id(), NULL, NULL, stamp);
    thr := pol.retread_threshold_mm;
    -- An unconfigured threshold would make the comparison below NULL and the
    -- rate NULL with it, which reads downstream as an unvalued casing rather
    -- than as the tenant's gap it is (rule 5, ADR-0012). It fires only for a
    -- return dated before the fleet's first row, and the fleet may have a
    -- threshold today, so the message names the day (U70).
    IF thr IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY014',
        MESSAGE = format('no removal threshold is configured for this fleet on %s', p_returned_on),
        HINT    = 'this return predates the first fleet-wide threshold policy row and cannot be priced (FR-CFG-051)';
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
    -- force on the return's day. Same scope as the dispatch: U5, a REMOVED
    -- casing has no axle class, so the tenant-wide row governs.
    cap := pol.max_retreads;
    -- A backstop that cannot fire while max_retreads is NOT NULL, because a
    -- return with no row in force stops at TY014 above.
    IF cap IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY015',
        MESSAGE = format('no retread policy is configured for this fleet on %s', p_returned_on),
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
