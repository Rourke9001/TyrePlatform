-- ============================================================================
--  Consent record, price list at receipt and fleet settings (TYRE-283)
--  Implements: FR-TEN-021, FR-TEN-022, FR-CFG-012, FR-CFG-021, FR-CFG-040,
--  FR-CFG-041, FR-CFG-042, FR-TYR-017, FR-TYR-040 as amended by TYRE-418,
--  FR-TYR-041, FR-VAL-006, CR-012, OR-LEG-005; ADR-0012, ADR-0013,
--  ADR-0014. Design:
--  docs/superpowers/specs/2026-10-20-consent-price-list-receipt-design.md
-- ============================================================================
-- New SQLSTATEs TY026 (a receipt refused, reached by the receipt routes) and
-- TY027 (a consent record refused, reached by no route)
-- (api/internal/httpapi/refusal_codes.json). Every routine here runs with
-- invoker rights and names its tenant in every read and write, so it stays
-- in the bound tenant under a role that bypasses RLS as well as under
-- app_login (db/CLAUDE.md, Adding a function).
--
-- Both new checks validate against every environment's rows: consent rows
-- reach staging and production only through provision_tenant.py, which
-- writes the two purposes below, and every tenant provisioned so far is KPA
-- and KM (spec, Units and currency).

-- ---------------------------------------------------------------------------
-- Consent (FR-TEN-022, U143 item 4)
-- ---------------------------------------------------------------------------
-- Adding a purpose is a code change, never file content (OR-LEG-005).
ALTER TABLE app.tenant_consent
  ADD CONSTRAINT tenant_consent_purpose_code_check
    CHECK (purpose_code IN ('SERVICE_DELIVERY', 'ANONYMISED_BENCHMARKING'));

-- 000012's revoke stops app_rw; this stops the owning role the runbook
-- connects as, which no revoke binds, as threshold_policy_written_once does
-- (000054). DELETE stays grant-only, because a tenant's deletion cascades
-- through its ledger (DR-014).
CREATE FUNCTION app.tenant_consent_is_written_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'TY027',
    MESSAGE = 'a consent record is written once; a change of consent is a new record';
END $$;

CREATE TRIGGER tenant_consent_written_once
BEFORE UPDATE ON app.tenant_consent
FOR EACH ROW EXECUTE FUNCTION app.tenant_consent_is_written_once();

-- The one writer: provisioning, make record-consent and the runbook all
-- call it. It takes no tenant parameter, so a caller cannot name another
-- fleet (TYRE-369). The tech team is no app user, so actor_id is NULL at
-- onboarding. occurred_at is when consent was given, the agreement's date,
-- and may precede created_at, when it was recorded.
CREATE FUNCTION app.record_consent(p_purpose text, p_granted boolean, p_notice_version text,
                                   p_occurred_at timestamptz DEFAULT now())
RETURNS uuid
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tid    uuid := app.current_tenant_id();
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
  -- Consent cannot be granted retroactively, nor ahead of the agreement.
  IF p_occurred_at > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'TY027',
      MESSAGE = 'consent is recorded as given now or earlier, never at a future time';
  END IF;

  INSERT INTO app.tenant_consent (tenant_id, purpose_code, granted, notice_version, actor_id, occurred_at)
  VALUES (tid, p_purpose, p_granted, p_notice_version, app.current_actor_id(), p_occurred_at)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- The latest row per fleet and purpose: by when consent was given, then by
-- when it was recorded, a row a direct insert left undated last. A purpose
-- with no row has no current consent, since an empty ledger is not consent.
-- TYRE-428 reads the same shape.
CREATE VIEW app.v_tenant_consent_current WITH (security_invoker = true) AS
SELECT DISTINCT ON (c.tenant_id, c.purpose_code)
       c.tenant_id, c.purpose_code, c.granted, c.notice_version, c.actor_id,
       c.occurred_at, c.created_at
  FROM app.tenant_consent c
 ORDER BY c.tenant_id, c.purpose_code, c.occurred_at DESC, c.created_at DESC NULLS LAST, c.id;

-- ---------------------------------------------------------------------------
-- Units (FR-CFG-021)
-- ---------------------------------------------------------------------------
-- Pressure is stored in kPa and distance in km, and nothing converts them,
-- so a psi or miles fleet would read kPa figures under its own labels. The
-- check goes when conversion is built (spec, Units and currency).
ALTER TABLE app.tenant
  ADD CONSTRAINT tenant_metric_units CHECK (pressure_unit = 'KPA' AND distance_unit = 'KM');

-- ---------------------------------------------------------------------------
-- Tread age (FR-TYR-017)
-- ---------------------------------------------------------------------------
-- Counted in the bound fleet's calendar (rule 6), so no Go or browser clock
-- decides a fleet's day. NULL for no instant, and for no fleet bound.
CREATE FUNCTION app.tenant_days_since(p_at timestamptz) RETURNS int
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT app.tenant_today(t.timezone) - app.tenant_today(t.timezone, p_at)
    FROM app.tenant t
   WHERE t.id = app.current_tenant_id()
$$;

-- ---------------------------------------------------------------------------
-- What the fleet settings page reads (FR-CFG-012, FR-CFG-040, FR-CFG-042)
-- ---------------------------------------------------------------------------
-- Each scope's row in force now. A scope whose rows all start later is
-- absent; the as-at resolvers (000054) stay the rule for any other instant.
CREATE VIEW app.v_threshold_policy_in_force WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.tenant_id, p.operating_group_id, p.axle_class)
       p.tenant_id, p.operating_group_id, g.name AS operating_group_name, p.axle_class,
       p.retread_threshold_mm, p.warning_threshold_mm, p.max_retreads, p.retreads_permitted,
       p.effective_from
  FROM app.threshold_policy p
  LEFT JOIN app.operating_group g ON g.tenant_id = p.tenant_id AND g.id = p.operating_group_id
 WHERE p.effective_from <= now()
 ORDER BY p.tenant_id, p.operating_group_id, p.axle_class, p.effective_from DESC;

-- Each size and brand's price in force on the fleet's today. The rows it
-- supersedes stay in the table (FR-CFG-042).
CREATE VIEW app.v_tyre_price_list_in_force WITH (security_invoker = true) AS
SELECT DISTINCT ON (p.tenant_id, p.size_id, p.brand_id)
       p.tenant_id, p.size_id, s.name AS size_name, p.brand_id, b.name AS brand_name,
       p.typical_price, p.effective_from
  FROM app.tyre_price_list p
  JOIN app.tenant tn ON tn.id = p.tenant_id
  JOIN app.tyre_size s ON s.tenant_id = p.tenant_id AND s.id = p.size_id
  LEFT JOIN app.tyre_brand b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
 WHERE p.effective_from <= app.tenant_today(tn.timezone)
 ORDER BY p.tenant_id, p.size_id, p.brand_id, p.effective_from DESC;

-- ---------------------------------------------------------------------------
-- The receipt (FR-CFG-041, FR-TYR-040 as amended by TYRE-418, spec D2, D3)
-- ---------------------------------------------------------------------------
-- A receipt is one call to app.receive_tyres. It stores what defined its
-- set as the receive resolved it, because a retread return rewrites a
-- tyre's pattern (000054), so the moves and the list read the receipt and
-- never a tyre. Its tyres are those linked to it, a link nothing changes.
-- UNPRICED, ESTIMATED and INVOICED follow the receive's cost source;
-- ESTIMATE_KEPT records that no invoice will come. INVOICED and
-- ESTIMATE_KEPT are final (spec, Receipt and invoice).
CREATE TYPE app.receipt_price_state AS ENUM ('UNPRICED', 'ESTIMATED', 'INVOICED', 'ESTIMATE_KEPT');

-- updated_at and updated_by say when and by whom the receipt last moved;
-- one never moved reads its created_at and created_by. invoice_number is
-- free text, with no uniqueness, since one invoice may cover several
-- receipts and every supplier numbers differently (spec, Calls made here 1).
CREATE TABLE app.tyre_receipt (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES app.tenant (id) ON DELETE CASCADE,
  size_id        uuid NOT NULL,
  brand_id       uuid,
  pattern_id     uuid NOT NULL,
  received_date  date NOT NULL,
  depot_id       uuid,
  invoice_number text CHECK (invoice_number IS NULL
                             OR (invoice_number <> '' AND invoice_number = btrim(invoice_number))),
  price_state    app.receipt_price_state NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid DEFAULT app.current_actor_id(),
  updated_at     timestamptz,
  updated_by     uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, size_id)    REFERENCES app.tyre_size (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)   REFERENCES app.tyre_brand (tenant_id, id),
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES app.tyre_pattern (tenant_id, id),
  FOREIGN KEY (tenant_id, depot_id)   REFERENCES app.depot (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
CALL app.enable_tenant_rls('app.tyre_receipt'::regclass);
-- The app role moves a receipt's state and records its invoice number, and
-- nothing else; tyre_receipt_moves_once holds which moves exist (check 4).
GRANT INSERT ON app.tyre_receipt TO app_rw;
GRANT UPDATE (price_state, invoice_number) ON app.tyre_receipt TO app_rw;

CREATE TRIGGER tyre_receipt_stamps_updated BEFORE UPDATE ON app.tyre_receipt
FOR EACH ROW EXECUTE FUNCTION app.stamp_updated();

-- Each move prices its tyres before it moves the receipt, so a bare UPDATE
-- of the state cannot leave a final receipt over unpriced tyres. A tyre
-- that has left the fleet keeps its price, as app.set_tyre_cost leaves it.
-- The tyres are read in the receipt's own tenant, so a role that bypasses
-- RLS reads no other fleet's.
CREATE FUNCTION app.tyre_receipt_moves_once() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  priced_as app.cost_source;
BEGIN
  IF OLD.price_state IN ('INVOICED', 'ESTIMATE_KEPT') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'this receipt''s price is final and does not change';
  END IF;
  IF (OLD.price_state::text, NEW.price_state::text) NOT IN (('UNPRICED', 'ESTIMATED'),
                                                            ('UNPRICED', 'INVOICED'),
                                                            ('ESTIMATED', 'INVOICED'),
                                                            ('ESTIMATED', 'ESTIMATE_KEPT')) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = format('a receipt moves from %s to %s only through its own moves',
                       OLD.price_state, NEW.price_state);
  END IF;
  IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number AND NEW.price_state <> 'INVOICED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'an invoice number is recorded with the receipt''s invoice';
  END IF;
  priced_as := CASE NEW.price_state WHEN 'INVOICED' THEN 'INVOICE' ELSE 'PRICE_LIST_ESTIMATE' END;
  IF EXISTS (SELECT 1 FROM app.tyre t
              WHERE t.tenant_id = NEW.tenant_id AND t.receipt_id = NEW.id
                AND t.state NOT IN ('SCRAPPED', 'SOLD', 'LOST')
                AND t.cost_source <> priced_as) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = format('a receipt is %s only once every tyre on it still in the fleet carries that price; move it through its own function',
                       NEW.price_state);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tyre_receipt_moves_once BEFORE UPDATE ON app.tyre_receipt
FOR EACH ROW EXECUTE FUNCTION app.tyre_receipt_moves_once();

-- The receipt is audited as the tyres are: it has a write path (ADR-0014,
-- U12).
CREATE TRIGGER tyre_receipt_audited
AFTER INSERT OR UPDATE ON app.tyre_receipt
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- A tyre's receipt is set when it is received. Tyres received before this
-- migration have none and keep per-tyre costing (spec, Receipt and invoice).
ALTER TABLE app.tyre
  ADD COLUMN receipt_id uuid,
  ADD CONSTRAINT tyre_receipt_id_fkey
    FOREIGN KEY (tenant_id, receipt_id) REFERENCES app.tyre_receipt (tenant_id, id);
CREATE INDEX tyre_by_receipt ON app.tyre (tenant_id, receipt_id) WHERE receipt_id IS NOT NULL;

-- app_rw holds UPDATE on app.tyre at table level (check 4), so a trigger,
-- not a grant, holds the link fixed.
CREATE FUNCTION app.tyre_receipt_is_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'TY026',
    MESSAGE = 'a tyre''s receipt is set when it is received and never changes';
END $$;

CREATE TRIGGER tyre_receipt_fixed
BEFORE UPDATE ON app.tyre
FOR EACH ROW WHEN (NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
EXECUTE FUNCTION app.tyre_receipt_is_fixed();

-- ---------------------------------------------------------------------------
-- The price list match (FR-CFG-040, FR-CFG-041)
-- ---------------------------------------------------------------------------
-- The one implementation of the match: the API relays it to the form, and
-- app.receive_tyres and the receipt's list-price move call it, so the
-- figure the form shows is the figure the database accepts. A brand row
-- beats a size-only row whatever their dates, and within each the latest
-- effective_from on or before the date wins. The brand is resolved as
-- app.receive_tyres resolves it, a branded pattern's own first. No date is
-- the fleet's today (rule 6).
CREATE FUNCTION app.price_list_estimate(p_size uuid, p_brand uuid, p_on date, p_pattern uuid DEFAULT NULL)
RETURNS TABLE (typical_price numeric, effective_from date, brand_id uuid)
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT p.typical_price, p.effective_from, p.brand_id
    FROM app.tyre_price_list p
    JOIN app.tenant tn ON tn.id = p.tenant_id
   WHERE p.tenant_id = app.current_tenant_id()
     AND p.size_id = p_size
     AND (p.brand_id IS NULL
          OR p.brand_id = COALESCE((SELECT pt.brand_id FROM app.tyre_pattern pt
                                     WHERE pt.tenant_id = app.current_tenant_id() AND pt.id = p_pattern),
                                   p_brand))
     AND p.effective_from <= COALESCE(p_on, app.tenant_today(tn.timezone))
   ORDER BY (p.brand_id IS NULL), p.effective_from DESC
   LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- The rate a cost gives (U129, FR-VAL-006, FR-TYR-019)
-- ---------------------------------------------------------------------------
-- One rule for app.set_tyre_cost and the receipt's moves. A retreaded
-- tyre's rate is its retread cost's (BR-VAL-006), so its price rates
-- nothing and needs no threshold. Otherwise the rate divides the tread
-- above the removal threshold in force, and a cost that cannot be rated is
-- refused rather than stored unrated, which would keep the tyre out of the
-- awaiting-cost backlog for good. p_subject names the tyre in the message:
-- 'this tyre' at set_tyre_cost, its display code on a receipt.
CREATE FUNCTION app.costed_rand_per_mm(p_retread_count int, p_new_tread_mm numeric,
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

-- ---------------------------------------------------------------------------
-- Receive and cost (FR-CFG-041, FR-TYR-040 as amended by TYRE-418)
-- ---------------------------------------------------------------------------
-- Both functions are restated whole, with their signatures and search_path
-- pins, so CREATE OR REPLACE keeps their oids and grants. receive_tyres
-- takes 000057's body; it refuses an estimate off the price list and an
-- invoice number without an invoice price, and makes the receipt.
-- The parameter keeps the name payload (db/CLAUDE.md, Adding a function).
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

-- set_tyre_cost takes 000053's body. It refuses a tyre that arrived on a
-- receipt, so a set is never priced part one way and part another (spec,
-- Per-tyre costing), and its rate rule is app.costed_rand_per_mm's.
CREATE OR REPLACE FUNCTION app.set_tyre_cost(p_tyre uuid, p_price numeric, p_source app.cost_source)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  cur      numeric;
  st       app.tyre_state;
  retreads int;
  tread    numeric;
  rate     numeric;
  rcpt     uuid;
  -- A parameter's type modifier is discarded by Postgres, so p_price arrives
  -- unrounded however it is declared; only assignment to a typmod'd local
  -- rounds it, and the stored price is this local.
  price numeric(12,2);
BEGIN
  -- The tenant is named so that under a role that bypasses RLS a tyre id
  -- from another fleet is not found (TYRE-369's rule).
  SELECT t.purchase_price, t.state, t.retread_count, t.new_tread_mm, t.rand_per_mm, t.receipt_id
    INTO cur, st, retreads, tread, rate, rcpt
    FROM app.tyre t
   WHERE t.id = p_tyre AND t.tenant_id = app.current_tenant_id()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  -- Before every other refusal, so a received tyre is always pointed at its
  -- receipt (FR-CFG-041).
  IF rcpt IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = 'this tyre was received on a receipt, so its price is recorded on the receipt for the whole set; open the receipt to record it';
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
  rate := app.costed_rand_per_mm(retreads, tread, rate, price, 'this tyre');
  -- No event: cost entry is provenance, not a lifecycle transition.
  UPDATE app.tyre
     SET purchase_price = price, cost_source = p_source, rand_per_mm = rate
   WHERE id = p_tyre AND tenant_id = app.current_tenant_id();
END $$;

-- ---------------------------------------------------------------------------
-- The receipt's moves (FR-CFG-041, spec D2 and D3)
-- ---------------------------------------------------------------------------
-- Each move locks the receipt, then its tyres in display-code order, and
-- applies to the whole set in one transaction. A tyre that has left the
-- fleet keeps what it has, purchase date included, as app.set_tyre_cost
-- leaves it, and is counted in left_fleet. Every tyre is written before the
-- receipt moves, as tyre_receipt_moves_once requires. A receipt not in the
-- bound fleet is not found, as a tyre is.
CREATE FUNCTION app.apply_receipt_list_price(p_receipt uuid)
RETURNS TABLE (priced int, left_fleet int)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  rc  app.tyre_receipt;
  est numeric;
  t   record;
BEGIN
  SELECT * INTO rc FROM app.tyre_receipt r
   WHERE r.id = p_receipt AND r.tenant_id = app.current_tenant_id()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such receipt in this fleet';
  END IF;
  IF rc.price_state <> 'UNPRICED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'only an unpriced receipt takes the list price';
  END IF;
  -- The receipt's own size, brand and date, never a tyre's.
  SELECT e.typical_price INTO est
    FROM app.price_list_estimate(rc.size_id, rc.brand_id, rc.received_date) e;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = format('no price list entry for this size and brand was in force on %s, the day these tyres were received; record the invoice price instead',
                       rc.received_date);
  END IF;

  priced := 0;
  left_fleet := 0;
  FOR t IN SELECT x.id, x.display_code, x.state, x.retread_count, x.new_tread_mm, x.rand_per_mm
             FROM app.tyre x
            WHERE x.tenant_id = app.current_tenant_id() AND x.receipt_id = rc.id
            ORDER BY x.display_code
              FOR UPDATE LOOP
    IF t.state IN ('SCRAPPED', 'SOLD', 'LOST') THEN
      left_fleet := left_fleet + 1;
      CONTINUE;
    END IF;
    UPDATE app.tyre
       SET purchase_price = est, cost_source = 'PRICE_LIST_ESTIMATE',
           rand_per_mm = app.costed_rand_per_mm(t.retread_count, t.new_tread_mm, t.rand_per_mm, est,
                                                format('tyre %s', t.display_code))
     WHERE id = t.id AND tenant_id = app.current_tenant_id();
    priced := priced + 1;
  END LOOP;

  UPDATE app.tyre_receipt SET price_state = 'ESTIMATED'
   WHERE id = rc.id AND tenant_id = app.current_tenant_id();
  RETURN NEXT;
END $$;

-- Records that no invoice will come, so the estimate is final. No tyre is
-- written: the tyres already carry the estimate the receipt moved on.
CREATE FUNCTION app.keep_receipt_estimate(p_receipt uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  st app.receipt_price_state;
BEGIN
  SELECT r.price_state INTO st FROM app.tyre_receipt r
   WHERE r.id = p_receipt AND r.tenant_id = app.current_tenant_id()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such receipt in this fleet';
  END IF;
  IF st <> 'ESTIMATED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'only a receipt priced from the price list can keep its estimate';
  END IF;
  UPDATE app.tyre_receipt SET price_state = 'ESTIMATE_KEPT'
   WHERE id = p_receipt AND tenant_id = app.current_tenant_id();
END $$;

-- The invoice is recorded once, before the receipt is final (spec D2). The
-- invoice date is the tyres' purchase_date (spec, Calls made here 1), and a
-- tyre still in the fleet has its past valuations restated at the invoice
-- figure, as app.set_tyre_cost does (000008's header).
CREATE FUNCTION app.record_receipt_invoice(p_receipt uuid, p_price numeric,
                                           p_invoice_number text DEFAULT NULL,
                                           p_invoice_date date DEFAULT NULL)
RETURNS TABLE (priced int, left_fleet int)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  st    app.receipt_price_state;
  tz    text;
  -- Rounded here, before the rate divides (docs/lessons.md, 2026-09-01).
  price numeric(12,2);
  t     record;
BEGIN
  SELECT r.price_state INTO st FROM app.tyre_receipt r
   WHERE r.id = p_receipt AND r.tenant_id = app.current_tenant_id()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such receipt in this fleet';
  END IF;
  IF st IN ('INVOICED', 'ESTIMATE_KEPT') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'this receipt''s price is final and does not change';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026', MESSAGE = 'an invoice price is a non-negative amount';
  END IF;
  -- Today is the fleet's (rule 6), as at app.receive_tyres.
  SELECT tn.timezone INTO tz FROM app.tenant tn WHERE tn.id = app.current_tenant_id();
  IF p_invoice_date > app.tenant_today(tz) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY026',
      MESSAGE = 'an invoice is dated today or earlier, never in the future';
  END IF;
  price := p_price;

  priced := 0;
  left_fleet := 0;
  FOR t IN SELECT x.id, x.display_code, x.state, x.retread_count, x.new_tread_mm, x.rand_per_mm
             FROM app.tyre x
            WHERE x.tenant_id = app.current_tenant_id() AND x.receipt_id = p_receipt
            ORDER BY x.display_code
              FOR UPDATE LOOP
    IF t.state IN ('SCRAPPED', 'SOLD', 'LOST') THEN
      left_fleet := left_fleet + 1;
      CONTINUE;
    END IF;
    UPDATE app.tyre
       SET purchase_price = price, cost_source = 'INVOICE',
           rand_per_mm = app.costed_rand_per_mm(t.retread_count, t.new_tread_mm, t.rand_per_mm, price,
                                                format('tyre %s', t.display_code)),
           purchase_date = COALESCE(p_invoice_date, purchase_date)
     WHERE id = t.id AND tenant_id = app.current_tenant_id();
    priced := priced + 1;
  END LOOP;

  UPDATE app.tyre_receipt
     SET price_state = 'INVOICED',
         invoice_number = NULLIF(btrim(COALESCE(p_invoice_number, '')), '')
   WHERE id = p_receipt AND tenant_id = app.current_tenant_id();
  RETURN NEXT;
END $$;

-- The receipts still waiting for their price. Received date and names come
-- from the receipt's own columns, the counts and codes from its tyres.
-- unit_price is the price its priced tyres share; min() passes over a tyre
-- that left the fleet unpriced. There is no cost source column: the state
-- says it, and an aggregate over tyre sources would answer by alphabetical
-- accident once a tyre left the fleet unpriced.
CREATE VIEW app.v_open_tyre_receipt WITH (security_invoker = true) AS
SELECT rc.tenant_id, rc.id AS receipt_id, rc.price_state, rc.depot_id, d.name AS depot_name,
       rc.received_date, s.name AS size_name, b.name AS brand_name, p.name AS pattern_name,
       count(t.id)::int AS quantity,
       count(t.id) FILTER (WHERE t.state NOT IN ('SCRAPPED', 'SOLD', 'LOST'))::int AS in_fleet,
       COALESCE(array_agg(t.display_code ORDER BY length(t.display_code), t.display_code)
                  FILTER (WHERE t.id IS NOT NULL), '{}') AS display_codes,
       min(t.purchase_price) AS unit_price,
       rc.created_at
  FROM app.tyre_receipt rc
  JOIN app.tyre_size s ON s.tenant_id = rc.tenant_id AND s.id = rc.size_id
  JOIN app.tyre_pattern p ON p.tenant_id = rc.tenant_id AND p.id = rc.pattern_id
  LEFT JOIN app.tyre_brand b ON b.tenant_id = rc.tenant_id AND b.id = rc.brand_id
  LEFT JOIN app.depot d ON d.tenant_id = rc.tenant_id AND d.id = rc.depot_id
  LEFT JOIN app.tyre t ON t.tenant_id = rc.tenant_id AND t.receipt_id = rc.id
 WHERE rc.price_state IN ('UNPRICED', 'ESTIMATED')
 GROUP BY rc.tenant_id, rc.id, d.name, s.name, b.name, p.name;
