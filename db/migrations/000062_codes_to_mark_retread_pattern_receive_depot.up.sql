-- ============================================================================
--  Codes to mark, the retread return's pattern, the depot at Receive and
--  PR #139's set-aside bugs (TYRE-99, TYRE-102, TYRE-450)
--  Implements: FR-TYR-035, FR-TYR-040 and FR-FIT-021 as amended; FR-TEN-022;
--  rule 1, rule 3, rule 6; ADR-0024. Design:
--  docs/superpowers/specs/2026-11-17-codes-to-mark-retread-pattern-receive-depot-design.md
-- ============================================================================
-- Written for a migrating role that is not a superuser, as tyreadmin is on
-- Azure. scripts/provision-tenant.test.sh step 17 runs it as one.

-- A consent row dated in the future becomes the purpose's current consent,
-- and app.record_consent then refuses every later record for it, a
-- withdrawal included (R10a, X7). A trigger, not a revoke, so it binds every
-- role, as tenant_consent_written_once does (000059; spec, Lead's call 10).
CREATE FUNCTION app.tenant_consent_is_not_future_dated() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.occurred_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'consent is recorded as given now or earlier, never at a future time';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_consent_not_future_dated
BEFORE INSERT ON app.tenant_consent
FOR EACH ROW EXECUTE FUNCTION app.tenant_consent_is_not_future_dated();

-- 000059's writer, restated: the U144 refusal dates the latest record in the
-- fleet's timezone (X5).
CREATE OR REPLACE FUNCTION app.record_consent(p_purpose text, p_granted boolean, p_notice_version text,
                                   p_occurred_at timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tid    uuid := app.current_tenant_id();
  tz     text;
  latest timestamptz;
  new_id uuid;
BEGIN
  IF tid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'a consent record needs app.tenant_id bound to the fleet it records for';
  END IF;
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = tid;
  IF NOT FOUND THEN
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
  -- Formatted in the fleet's timezone, not the session's (rule 6, X5).
  -- TYRE-131 owns the other refusal messages that print an instant.
  IF p_occurred_at <= latest THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = format('the latest %s consent record is dated %s %s; a new one is dated after it',
                       p_purpose, to_char(latest AT TIME ZONE tz, 'YYYY-MM-DD HH24:MI:SS'), tz);
  END IF;

  INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, actor_id, occurred_at)
  VALUES (tid, p_purpose, p_granted, p_notice_version, app.current_actor_id(), p_occurred_at)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- 000059's rate rule, restated: the bound's refusal is true on the invoice,
-- list-price and per-tyre routes alike, and names what it rated (R3).
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
      MESSAGE = format('%s''s price of %s over %s mm of usable tread is a rate above what the register carries; check the price and the new tread recorded for it',
                       p_subject, price, p_new_tread_mm - thr);
  END IF;
  RETURN rate;
END $$;

-- 000059's receive, restated whole with its signature and pin, so CREATE OR
-- REPLACE keeps its oid and grants.
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
  dp       uuid := (payload->>'depot_id')::uuid;
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

  -- B39 (TYRE-450): the stock lands at a depot or store, the pair
  -- app.return_tyre_to_stock stocks (000033), required while the fleet has
  -- one. A missing, foreign, inactive or wrong-type depot shares one
  -- message, so the refusal is no oracle. Narrowing it to the user's own
  -- depots is write-side scoping, deferred for every asset write (D8).
  IF dp IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM app.depot d
                    WHERE d.id = dp AND d.tenant_id = app.current_tenant_id() AND d.active
                      AND d.type IN ('DEPOT', 'STORE')) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY011',
        MESSAGE = 'no such active depot or store in this fleet; choose the depot or store that takes the stock';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM app.depot d
                 WHERE d.tenant_id = app.current_tenant_id() AND d.active
                   AND d.type IN ('DEPOT', 'STORE')) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a receive names the depot or store that takes the stock; choose one';
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

  -- NaN sorts above every number, so "< 0" alone passes it, and a negative
  -- price would otherwise reach the CHECK as a canned 23514 (X12).
  IF price = 'NaN' OR price < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = format('a purchase price is an amount of zero or more, not %s', price);
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
  VALUES (app.current_tenant_id(), sz, br, pt, rcv, dp, inv,
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

    -- B22 (FR-TYR-035 as amended): under GENERATED the platform issued the
    -- code and someone must mark it on the sidewall; under FREE the code was
    -- read off the sidewall.
    INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id,
                          status, retread_count, purchase_date, purchase_price,
                          cost_source, new_tread_mm, rand_per_mm, state,
                          current_depot_id, received_date, receipt_id, brand_pending)
    VALUES (app.current_tenant_id(), code, sz, br, pt, 'NEW', 0,
            (payload->>'purchase_date')::date, price, src, tread, rate,
            'IN_STOCK', dp, rcv, rcpt, pol = 'GENERATED')
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

-- ---------------------------------------------------------------------------
-- Codes to mark (TYRE-99, B22, U224)
-- ---------------------------------------------------------------------------
-- The flag is cleared only by app.mark_code_on_sidewall, which runs as
-- app_writer (DoD 5, ADR-0024). A table-level REVOKE also revokes every
-- column grant (https://www.postgresql.org/docs/16/sql-revoke.html), so it
-- runs first. A later column needs its own grant: section 77a fails until
-- it has one.
REVOKE UPDATE ON app.tyre FROM app_rw;
GRANT UPDATE (id, tenant_id, display_code, size_id, brand_id, pattern_id, status, retread_count,
              purchase_date, purchase_price, new_tread_mm, rand_per_mm, casing_value, state,
              current_depot_id, last_tread_mm, last_tread_at, created_at, cost_source,
              received_date, created_by, updated_at, updated_by, receipt_id)
  ON app.tyre TO app_rw;

COMMENT ON COLUMN app.tyre.brand_pending IS
  'True while a code the platform issued at Receive waits to be marked on the sidewall (B22, FR-TYR-035 as amended). Set by app.receive_tyres under GENERATED; cleared only by app.mark_code_on_sidewall, which runs as app_writer (000062, ADR-0024).';

-- The one rule for the queue, shaped like v_tyre_awaiting_cost (000012):
-- pending and still in the fleet. app.mark_code_on_sidewall marks exactly
-- these rows, and the register joins this view rather than repeat it.
CREATE VIEW app.v_tyre_code_to_mark WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS tyre_id,
       t.display_code,
       t.receipt_id,
       t.received_date,
       t.state
  FROM app.tyre t
 WHERE t.brand_pending
   AND t.state NOT IN ('SCRAPPED', 'LOST', 'SOLD');

-- The one writer of the flag after receipt (B22): one tyre, or every tyre
-- on a receipt still in the queue. Who may mark is the handler's capability,
-- ManageAssets (U224). Every read and write names the bound tenant, so a
-- missing id, another fleet's and no fleet bound read alike (rule 1).
CREATE FUNCTION app.mark_code_on_sidewall(p_tyre uuid, p_receipt uuid, p_marked_on date)
RETURNS TABLE (tyre_id uuid, display_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp AS $$
DECLARE
  tid   uuid := app.current_tenant_id();
  tz    text;
  today date;
  d     date;
  ty    app.tyre;
  stamp timestamptz;
  n     int := 0;
BEGIN
  IF (p_tyre IS NULL) = (p_receipt IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a marking names one tyre or one receipt';
  END IF;
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = tid;
  today := app.tenant_today(tz);

  IF p_tyre IS NOT NULL THEN
    SELECT t.* INTO ty FROM app.tyre t WHERE t.tenant_id = tid AND t.id = p_tyre FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM app.tyre_receipt r WHERE r.tenant_id = tid AND r.id = p_receipt) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such receipt in this fleet';
  END IF;

  -- Back-dated to the day of receipt and no earlier, never forward, as
  -- receive_tyres and dispatch_tyre treat their days (spec, Lead's call 8).
  d := COALESCE(p_marked_on, today);
  IF d > today THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a marking is dated today or earlier, never in the future';
  END IF;
  IF p_tyre IS NOT NULL THEN
    IF ty.state IN ('SCRAPPED', 'LOST', 'SOLD') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('%s is %s and has left the fleet, so its code is not marked',
                         ty.display_code, lower(ty.state::text));
    END IF;
    IF NOT ty.brand_pending THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('%s has no code waiting to be marked on its sidewall', ty.display_code);
    END IF;
  END IF;

  -- The receipt's predicate repeats the view's, in the receipt moves' lock
  -- order. A row waited on is re-read and re-checked against it once its
  -- lock is free, so a concurrent marking leaves nothing to mark twice.
  FOR ty IN
    SELECT t.* FROM app.tyre t
     WHERE t.tenant_id = tid
       AND (t.id = p_tyre
            OR (p_tyre IS NULL AND t.receipt_id = p_receipt AND t.brand_pending
                AND t.state NOT IN ('SCRAPPED', 'LOST', 'SOLD')))
     ORDER BY t.display_code
       FOR UPDATE
  LOOP
    IF d < ty.received_date THEN
      RAISE EXCEPTION USING ERRCODE = 'TY012',
        MESSAGE = format('%s was received on %s; a marking is dated on or after that day',
                         ty.display_code, ty.received_date);
    END IF;
    -- Never before the tyre's receipt: receive_tyres stamps a back-dated
    -- day at UTC midnight, later than the fleet's own east of UTC (spec,
    -- Lead's call 13).
    stamp := greatest(app.tenant_day_instant(d),
                      (SELECT max(e.occurred_at) FROM app.tyre_event e
                        WHERE e.tenant_id = tid AND e.tyre_id = ty.id AND e.type = 'RECEIVED'));
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
    VALUES (tid, ty.id, 'BRANDED', stamp,
            jsonb_build_object('display_code', ty.display_code, 'marked', true));
    UPDATE app.tyre t SET brand_pending = false WHERE t.tenant_id = tid AND t.id = ty.id;
    tyre_id := ty.id; display_code := ty.display_code;
    n := n + 1;
    RETURN NEXT;
  END LOOP;
  IF n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'this receipt has no tyre whose code is waiting to be marked';
  END IF;
END $$;

-- What app.mark_code_on_sidewall's call tree needs, and nothing more; suite
-- check 8e pins it. app.tenant, app.audit_log and its sequence are
-- 000061's grants, which this function also uses (tyre_audited).
-- The tyre reads and the row locks.
GRANT SELECT ON app.tyre TO app_writer;
-- The clear.
GRANT UPDATE (brand_pending) ON app.tyre TO app_writer;
-- The RECEIVED read and the marked event.
GRANT SELECT, INSERT ON app.tyre_event TO app_writer;
-- The receipt check.
GRANT SELECT ON app.tyre_receipt TO app_writer;

-- The hand-over, as 000061 and db/CLAUDE.md (Adding a function) require:
-- OWNER TO needs the new owner to hold CREATE on the schema at that moment
-- only, and the ACL is set before the owner changes.
REVOKE ALL ON FUNCTION app.mark_code_on_sidewall(uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_code_on_sidewall(uuid, uuid, date) TO app_rw;
GRANT CREATE ON SCHEMA app TO app_writer;
ALTER FUNCTION app.mark_code_on_sidewall(uuid, uuid, date) OWNER TO app_writer;
REVOKE CREATE ON SCHEMA app FROM app_writer;
