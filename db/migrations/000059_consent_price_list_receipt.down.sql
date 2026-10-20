-- 000059 down. Drops what the up created, in the reverse of its order,
-- proved by catalogue against a baseline taken before the up ran
-- (docs/lessons.md, 2026-09-15 and 2026-10-01).

-- The moves and the open list read app.tyre.receipt_id and
-- app.tyre_receipt, so they go before either.
DROP VIEW app.v_open_tyre_receipt;
DROP FUNCTION app.record_receipt_invoice(uuid, numeric, text, date);
DROP FUNCTION app.keep_receipt_estimate(uuid);
DROP FUNCTION app.apply_receipt_list_price(uuid);

-- receive_tyres and set_tyre_cost take back the bodies 000057 and 000053
-- gave them, verbatim. No ALTER FUNCTION touches either after those, and
-- each keeps its search_path pin.
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
  -- another tenant's (hidden by RLS) and a deactivated row get one message
  -- per kind, so the refusal is no oracle for another tenant's ids.
  sz := (payload->>'size_id')::uuid;
  IF NOT EXISTS (SELECT 1 FROM app.tyre_size s WHERE s.id = sz AND s.active) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that size is not in this fleet''s active catalogue; choose another, or ask an administrator to add it';
  END IF;
  pt := (payload->>'pattern_id')::uuid;
  SELECT p.brand_id, p.applies_to INTO pt_brand, pt_use
    FROM app.tyre_pattern p
   WHERE p.id = pt AND p.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that pattern is not in this fleet''s active catalogue; choose another, or ask an administrator to add it';
  END IF;
  -- A pattern whose brand is deactivated would store a brand no form
  -- offers (TYRE-318). The brand is this tenant's own row, so naming it is
  -- no oracle.
  IF pt_brand IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.tyre_brand b WHERE b.id = pt_brand AND b.active) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'that pattern''s brand is not in this fleet''s active catalogue; choose another pattern, or ask an administrator to restore the brand';
  END IF;
  br := (payload->>'brand_id')::uuid;
  IF br IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.tyre_brand b WHERE b.id = br AND b.active) THEN
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
                          current_depot_id, received_date)
    VALUES (app.current_tenant_id(), code, sz, br, pt, 'NEW', 0,
            (payload->>'purchase_date')::date, price, src, tread, rate,
            'IN_STOCK', (payload->>'depot_id')::uuid, rcv)
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

CREATE OR REPLACE FUNCTION app.set_tyre_cost(p_tyre uuid, p_price numeric, p_source app.cost_source)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  cur      numeric;
  st       app.tyre_state;
  retreads int;
  tread    numeric;
  thr      numeric;
  rate     numeric;
  -- A parameter's type modifier is discarded by Postgres, so p_price arrives
  -- unrounded however it is declared; only assignment to a typmod'd local
  -- rounds it. Rounding before the divide is what makes the stored rate
  -- reproducible from the stored price. See app.receive_tyres' own price
  -- local for the invariant.
  price numeric(12,2);
BEGIN
  SELECT t.purchase_price, t.state, t.retread_count, t.new_tread_mm, t.rand_per_mm
    INTO cur, st, retreads, tread, rate
    FROM app.tyre t WHERE t.id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  -- Extends D5, which specified no state guard: costing recomputes
  -- rand_per_mm, and doing that to a tyre that has left the estate rewrites
  -- the rate behind valuations already taken against it. Only the three
  -- terminal states are refused. A FITTED tyre is still in
  -- v_tyre_awaiting_cost and must stay costable (CFL-002).
  IF st IN ('SCRAPPED','SOLD','LOST') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = format('this tyre is %s and has left the fleet; its cost cannot be recorded now', st);
  END IF;
  IF cur IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = 'this tyre''s cost is already recorded',
      HINT    = 'a correction is a decision this surface does not take; raise it against TYRE-48';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013', MESSAGE = 'a cost is a non-negative amount';
  END IF;
  -- U128 (TYRE-422), stated at receive_tyres' cost-source checks above.
  IF p_source = 'UNKNOWN' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = 'a purchase price needs a known cost source; choose invoice or price list estimate';
  END IF;
  price := p_price;
  -- A retreaded tyre's rate is its retread cost's (FR-TYR-019, BR-VAL-006),
  -- and its new_tread_mm is the retread's, so its price rates nothing and
  -- needs no threshold.
  IF retreads = 0 THEN
    -- U129, stated at receive_tyres' threshold refusal above.
    thr := app.current_removal_threshold_mm();
    IF thr IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY013',
        MESSAGE = 'this fleet has no removal threshold configured, so this tyre''s cost cannot be rated; configure the removal threshold first, then record the cost';
    END IF;
    IF tread IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY013',
        MESSAGE = 'this tyre has no new tread recorded, so its cost cannot be rated; leave it awaiting its cost until its new tread is recorded';
    END IF;
    IF tread <= thr THEN
      RAISE EXCEPTION USING ERRCODE = 'TY013',
        MESSAGE = format('this tyre''s new tread of %s mm does not exceed the removal threshold of %s mm, so its cost cannot be rated; check the removal threshold configured',
                         tread, thr);
    END IF;
    -- The one permitted implementation (db/CLAUDE.md, FR-VAL-006), with the
    -- bound stated at receive_tyres' rate above.
    rate := app.rand_per_mm(price, tread, thr);
    IF rate >= 100000000 THEN
      RAISE EXCEPTION USING ERRCODE = 'TY013',
        MESSAGE = format('a purchase price of %s over %s mm of usable tread is a rate above what the register carries; check the price entered',
                         price, tread - thr);
    END IF;
  END IF;
  -- No event: cost entry is provenance, not a lifecycle transition.
  UPDATE app.tyre
     SET purchase_price = price, cost_source = p_source, rand_per_mm = rate
   WHERE id = p_tyre;
END $$;

DROP TRIGGER tyre_receipt_fixed ON app.tyre;
DROP FUNCTION app.tyre_receipt_is_fixed();
ALTER TABLE app.tyre DROP COLUMN receipt_id;
DROP TABLE app.tyre_receipt;
DROP FUNCTION app.tyre_receipt_moves_once();
DROP TYPE app.receipt_price_state;
DROP FUNCTION app.costed_rand_per_mm(int, numeric, numeric, numeric, text);
DROP FUNCTION app.price_list_estimate(uuid, uuid, date, uuid);

DROP VIEW app.v_tyre_price_list_in_force;
DROP VIEW app.v_threshold_policy_in_force;
DROP FUNCTION app.tenant_days_since(timestamptz);
ALTER TABLE app.tenant DROP CONSTRAINT tenant_metric_units;
DROP VIEW app.v_tenant_consent_current;
DROP FUNCTION app.record_consent(text, boolean, text, timestamptz);
DROP TRIGGER tenant_consent_written_once ON app.tenant_consent;
DROP FUNCTION app.tenant_consent_is_written_once();
ALTER TABLE app.tenant_consent DROP CONSTRAINT tenant_consent_purpose_code_check;
