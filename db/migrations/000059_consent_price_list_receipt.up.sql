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
