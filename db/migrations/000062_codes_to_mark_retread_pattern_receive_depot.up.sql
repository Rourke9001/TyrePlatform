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
