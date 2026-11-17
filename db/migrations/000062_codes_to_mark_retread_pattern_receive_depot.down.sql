-- Reverses 000062 to 000061's state. Each function it restores is its source
-- migration's text, byte for byte: scripts/provision-tenant.test.sh step 17
-- compares md5(prosrc) with version 61's.

-- app.log_retread_return, 000054:139-414.
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

-- The codes-to-mark half. Only this migration's app_writer grants are
-- revoked; 000061's stay.
DROP FUNCTION app.mark_code_on_sidewall(uuid, uuid, date);
REVOKE SELECT ON app.tyre FROM app_writer;
REVOKE UPDATE (brand_pending) ON app.tyre FROM app_writer;
REVOKE SELECT, INSERT ON app.tyre_event FROM app_writer;
REVOKE SELECT ON app.tyre_receipt FROM app_writer;
DROP VIEW app.v_tyre_code_to_mark;
COMMENT ON COLUMN app.tyre.brand_pending IS NULL;
-- The table-level REVOKE takes the column grants with it.
REVOKE UPDATE ON app.tyre FROM app_rw;
GRANT UPDATE ON app.tyre TO app_rw;

-- app.receive_tyres, 000059:377-638.
CREATE OR REPLACE FUNCTION app.receive_tyres(payload jsonb)
RETURNS TABLE (tyre_id uuid, display_code text)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  pol   app.display_code_policy;
  tz    text;
  qty   int  := COALESCE((payload->>'quantity')::int, 1);
  hand  text := NULLIF(btrim(COALESCE(payload->>'display_code','')), '');
  -- numeric(12,2) on the local, not on the argument, so the cents round
  -- before app.rand_per_mm divides and the stored rate reproduces from the
  -- stored price (FR-VAL-006; the reasoning is 000031:25-30).
  price numeric(12,2) := (payload->>'purchase_price')::numeric;
  tread numeric(4,1)  := (payload->>'new_tread_mm')::numeric;
  -- An omitted source reads as UNKNOWN; the checks below hold UNKNOWN to
  -- an unpriced receive and never impute a source to a priced one.
  src   app.cost_source := COALESCE(payload->>'cost_source', 'UNKNOWN')::app.cost_source;
  inv   text := NULLIF(btrim(COALESCE(payload->>'invoice_number','')), '');
  est   numeric;
  rcpt  uuid;
  sz       uuid;
  br       uuid;
  pt       uuid;
  pt_brand uuid;
  pt_use   text;
  thr      numeric;
  rate     numeric;
  rcv   date;
  stamp timestamptz;
  code  text;
  new_id uuid;
BEGIN
  SELECT t.timezone, t.display_code_policy INTO tz, pol
    FROM app.tenant t WHERE t.id = app.current_tenant_id();

  -- Defaulted server-side to the tenant's calendar day, never the caller's
  -- (rule 6; B4.5's from_date precedent). app.tenant_today(p_tz, p_at)
  -- defaults p_at to now(), so the single-argument call below is its
  -- ordinary one-arg form, not a partial application.
  rcv := COALESCE((payload->>'received_date')::date, app.tenant_today(tz));
  IF rcv > app.tenant_today(tz) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a tyre is received on or before today, never on a future date';
  END IF;
  -- The event instant is clamped to now(), which the calendar date alone does
  -- not guarantee: for a tenant east of UTC, today's date cast to timestamptz
  -- is still up to 14 hours ahead. An event stamped in the future outranks
  -- every later one in app.tyre_in_estate_asof's ORDER BY, which would leave
  -- a disposed tyre inside the valuation estate for good (FR-VAL-022).
  stamp := least(rcv::timestamptz, now());

  IF qty < 1 OR qty > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a receive is between 1 and 200 tyres';
  END IF;
  IF pol = 'GENERATED' AND hand IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'this fleet''s display codes are issued by the platform; leave the code blank and the next one is assigned',
      HINT    = 'D12: under a generated scheme a hand-typed code is refused, never merely warned about';
  END IF;
  IF pol = 'FREE' AND hand IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'this fleet brands its own tyres; enter the code branded on the sidewall';
  END IF;
  IF hand IS NOT NULL AND qty > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a hand-typed display code names one tyre; bulk receives use issued codes';
  END IF;

  -- FR-TYR-031, U93: new_tread_mm is written only here and at a retread
  -- return, so a receive without a size, a pattern and a new tread leaves a
  -- tyre app.rand_per_mm can never rate.
  IF payload->>'size_id' IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a received tyre needs its size; choose one from the catalogue';
  END IF;
  IF payload->>'pattern_id' IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a received tyre needs its pattern; choose one from the catalogue';
  END IF;
  IF tread IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a received tyre needs its new tread depth in millimetres';
  END IF;
  -- TYRE-128 decision 8: every writer that accepts a tread refuses one
  -- outside app.max_tread_mm's ceiling, so a dropped decimal never fixes a
  -- wrong rate. The figure is that function's, interpolated, never copied.
  IF tread <= 0 OR tread > app.max_tread_mm() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = format('a new tread is in millimetres, above 0 and at most %s; check the depth entered',
                       app.max_tread_mm());
  END IF;

  -- A receive offers active entries only (the receive spec's Q4, owner,
  -- 12 Oct 2026), the deactivation FR-CFG-007 provides for. A missing id,
  -- another tenant's (hidden by RLS, and by the tenant named under a role
  -- that bypasses it) and a deactivated row get one message per kind, so
  -- the refusal is no oracle for another tenant's ids.
  sz := (payload->>'size_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM app.tyre_size s
                  WHERE s.id = sz AND s.tenant_id = app.current_tenant_id() AND s.active) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it';
  END IF;
  pt := (payload->>'pattern_id')::uuid;
  SELECT p.brand_id, p.applies_to INTO pt_brand, pt_use
    FROM app.tyre_pattern p
   WHERE p.id = pt AND p.tenant_id = app.current_tenant_id() AND p.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it';
  END IF;
  -- A pattern whose brand is deactivated would store a brand no form
  -- offers (TYRE-318). The brand is this tenant's own row, so naming it is
  -- no oracle.
  IF pt_brand IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.tyre_brand b
                      WHERE b.id = pt_brand AND b.tenant_id = app.current_tenant_id() AND b.active) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that pattern''s brand is not in this fleet''s active catalogue; choose another pattern, or ask an administrator to restore the brand';
  END IF;
  br := (payload->>'brand_id')::uuid;
  IF br IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.tyre_brand b
                      WHERE b.id = br AND b.tenant_id = app.current_tenant_id() AND b.active) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that brand is not in this fleet''s active catalogue; choose another, leave it blank, or ask an administrator to add it';
  END IF;

  -- FR-CFG-004: every tyre minted below is NEW, which a retread-only
  -- pattern does not describe.
  IF pt_use NOT IN ('NEW', 'BOTH') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that pattern is for retreads only; a received tyre takes a new-tyre pattern';
  END IF;
  -- NFR-USE-006: a branded pattern already names its brand, so an omitted
  -- brand is taken from it and a different one is refused.
  IF pt_brand IS NOT NULL THEN
    IF br IS NOT NULL AND br <> pt_brand THEN
      RAISE EXCEPTION USING ERRCODE = 'TY011',
        MESSAGE = 'that pattern belongs to a different brand; choose its own brand or leave the brand blank';
    END IF;
    br := pt_brand;
  END IF;

  -- U93, BR-VAL-002: app.rand_per_mm divides by the tread above the removal
  -- threshold, so a tread at or below it is unratable. One resolution
  -- serves this check and the rate below. With no threshold in force there
  -- is nothing to check the tread against (rule 5).
  thr := app.current_removal_threshold_mm();
  IF thr IS NOT NULL AND tread <= thr THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = format('new tread must exceed the removal threshold of %s mm; check the depth entered', thr);
  END IF;

  -- A recorded cost is never corrected (D5, TY013), so a priced receive
  -- names where its price came from (TYRE-370), and UNKNOWN means exactly
  -- "no price yet" (U128, DR-019, NFR-PRO-002): a price never carries it,
  -- here or at app.set_tyre_cost, and no other source arrives
  -- without a price.
  IF price IS NOT NULL AND payload->>'cost_source' IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a purchase price needs a cost source; choose invoice or price list estimate';
  END IF;
  IF price IS NOT NULL AND src = 'UNKNOWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a purchase price needs a known cost source; choose invoice or price list estimate';
  END IF;
  IF price IS NULL AND src <> 'UNKNOWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a cost source is recorded with its purchase price; enter the price, or leave the source out until it is known';
  END IF;
  -- TYRE-418: the number names the invoice the price came from, so it comes
  -- with an invoice price and nothing else.
  IF inv IS NOT NULL AND src <> 'INVOICE' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'an invoice number is recorded with an invoice price; enter the price from the invoice, or leave the invoice number blank';
  END IF;
  -- FR-CFG-041: an estimate is the price list's figure for this size and
  -- brand on the received date, never a figure someone labelled one.
  IF src = 'PRICE_LIST_ESTIMATE' THEN
    SELECT e.typical_price INTO est FROM app.price_list_estimate(sz, br, rcv, pt) e;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY011',
        MESSAGE = format('this size and brand have no price list entry in force on %s, so the tyres cannot be received at a price list estimate; enter the invoice price, or leave the price blank',
                         rcv);
    END IF;
    IF price <> est THEN
      RAISE EXCEPTION USING ERRCODE = 'TY011',
        MESSAGE = format('the price list estimate for this size and brand on %s is %s; a price list estimate is received at that figure, and any other figure is an invoice price',
                         rcv, est);
    END IF;
  END IF;

  -- U129: a price is stored only with the rate it gives, because TY013
  -- refuses a second costing and would keep an unrated tyre out of the
  -- awaiting-cost backlog for good. A cost the threshold in force cannot
  -- rate is refused, here and at set_tyre_cost, and an unpriced tyre
  -- lands and awaits its cost (FR-TYR-041).
  IF price IS NOT NULL AND thr IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'this fleet has no removal threshold configured, so a priced tyre cannot be rated; configure the removal threshold first, or receive the tyre without its price';
  END IF;
  -- FR-VAL-006: the bound is rand_per_mm's numeric(12,4), not a business
  -- threshold, tested on the rounded rate the column stores, so a positive
  -- rate past it is refused here and not as a bare 22003 (the reasoning is
  -- log_retread_return's, 000048).
  rate := app.rand_per_mm(price, tread, thr);
  IF rate >= 100000000 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = format('a purchase price of %s over %s mm of usable tread is a rate above what the register carries; check the price and the new tread entered',
                       price, tread - thr);
  END IF;

  -- One receipt per receive (FR-CFG-041), holding what defined the set as
  -- resolved above. Its state follows the cost source.
  INSERT INTO app.tyre_receipt (tenant_id, size_id, brand_id, pattern_id, received_date, depot_id,
                                invoice_number, price_state)
  VALUES (app.current_tenant_id(), sz, br, pt, rcv, (payload->>'depot_id')::uuid, inv,
          CASE src WHEN 'INVOICE' THEN 'INVOICED'
                   WHEN 'PRICE_LIST_ESTIMATE' THEN 'ESTIMATED'
                   ELSE 'UNPRICED' END::app.receipt_price_state)
  RETURNING id INTO rcpt;

  FOR i IN 1..qty LOOP
    IF pol = 'GENERATED' THEN
      -- The counter row lock is the concurrency story: two receives
      -- serialise here rather than minting one code twice.
      UPDATE app.display_code_counter c
         SET next_number = c.next_number + 1
       WHERE c.tenant_id = app.current_tenant_id()
       RETURNING c.prefix || '-' || lpad((c.next_number - 1)::text, 5, '0') INTO code;
      IF NOT FOUND THEN
        -- A configuration fault, not a client mistake: an honest 500.
        RAISE EXCEPTION 'display_code_counter has no row for this tenant; seed one before receiving under GENERATED';
      END IF;
    ELSE
      code := hand;
    END IF;

    INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id,
                          status, retread_count, purchase_date, purchase_price,
                          cost_source, new_tread_mm, rand_per_mm, state,
                          current_depot_id, received_date, receipt_id)
    VALUES (app.current_tenant_id(), code, sz, br, pt, 'NEW', 0,
            (payload->>'purchase_date')::date, price, src, tread, rate,
            'IN_STOCK', (payload->>'depot_id')::uuid, rcv, rcpt)
    RETURNING id INTO new_id;

    -- The vocabulary's first writer (TYRE-48): receipt is the point a tyre
    -- becomes trackable (FR-TYR-040), and branding is a dated event so the
    -- code resolves by date across reuse (FR-TYR-042, ADR-0008 rule 2).
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES (app.current_tenant_id(), new_id, 'RECEIVED', stamp, 'IN_STOCK');
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
    VALUES (app.current_tenant_id(), new_id, 'BRANDED', stamp,
            jsonb_build_object('display_code', code));

    tyre_id := new_id; display_code := code;
    RETURN NEXT;
  END LOOP;
END $$;

-- app.costed_rand_per_mm, 000059:326-367.
CREATE OR REPLACE FUNCTION app.costed_rand_per_mm(p_retread_count int, p_new_tread_mm numeric,
                                       p_current_rate numeric, p_price numeric, p_subject text)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  -- A parameter's typmod is discarded, so the cents round here before the
  -- divide and the stored rate reproduces from the stored price
  -- (docs/lessons.md, 2026-09-01).
  price numeric(12,2) := p_price;
  thr   numeric;
  rate  numeric;
BEGIN
  IF p_retread_count <> 0 THEN
    RETURN p_current_rate;
  END IF;
  thr := app.current_removal_threshold_mm();
  IF thr IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = format('this fleet has no removal threshold configured, so %s''s cost cannot be rated; configure the removal threshold first, then record the cost',
                       p_subject);
  END IF;
  IF p_new_tread_mm IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = format('%s has no new tread recorded, so its cost cannot be rated; leave it awaiting its cost until its new tread is recorded',
                       p_subject);
  END IF;
  IF p_new_tread_mm <= thr THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = format('%s''s new tread of %s mm does not exceed the removal threshold of %s mm, so its cost cannot be rated; check the removal threshold configured',
                       p_subject, p_new_tread_mm, thr);
  END IF;
  -- The one permitted implementation (db/CLAUDE.md, FR-VAL-006). The bound
  -- is rand_per_mm's numeric(12,4), tested on the rate the column stores.
  rate := app.rand_per_mm(price, p_new_tread_mm, thr);
  IF rate >= 100000000 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = format('a purchase price of %s over %s mm of usable tread is a rate above what the register carries; check the price entered',
                       price, p_new_tread_mm - thr);
  END IF;
  RETURN rate;
END $$;

-- app.record_consent, 000059:50-106.
CREATE OR REPLACE FUNCTION app.record_consent(p_purpose text, p_granted boolean, p_notice_version text,
                                   p_occurred_at timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tid    uuid := app.current_tenant_id();
  latest timestamptz;
  new_id uuid;
BEGIN
  IF tid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'a consent record needs app.tenant_id bound to the fleet it records for';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tenant t WHERE t.id = tid) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = format('app.tenant_id %s names no fleet', tid);
  END IF;
  -- tenant_consent_purpose_code_check holds the list; this refuses first so
  -- the caller reads which purposes exist.
  IF p_purpose IS NULL OR p_purpose NOT IN ('SERVICE_DELIVERY', 'ANONYMISED_BENCHMARKING') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = format('%L is not a consent purpose; the purposes are SERVICE_DELIVERY and ANONYMISED_BENCHMARKING',
                       p_purpose);
  END IF;
  IF p_granted IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'a consent record states whether consent was granted or withdrawn';
  END IF;
  IF p_notice_version IS NULL OR btrim(p_notice_version) = '' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'a consent record names the notice version the client signed';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'a consent record states when consent was given';
  END IF;
  IF p_occurred_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'consent is recorded as given now or earlier, never at a future time';
  END IF;
  -- U144: each record is dated after the purpose's latest, so the history
  -- reads in order and the current record is never a tie. Two concurrent
  -- writers can both pass; the writers are the tech team's, one at a time.
  SELECT max(c.occurred_at) INTO latest FROM app.tenant_consent c
   WHERE c.tenant_id = tid AND c.purpose_code = p_purpose;
  IF p_occurred_at <= latest THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = format('the latest %s consent record is dated %s; a new one is dated after it',
                       p_purpose, latest);
  END IF;

  INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, actor_id, occurred_at)
  VALUES (tid, p_purpose, p_granted, p_notice_version, app.current_actor_id(), p_occurred_at)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

DROP TRIGGER tenant_consent_not_future_dated ON app.tenant_consent;
DROP FUNCTION app.tenant_consent_is_not_future_dated();
