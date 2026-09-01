-- ============================================================================
--  Tyre lifecycle: receive, cost, dispose, dated code lookup (TYRE-48/91)
--  Implements: FR-TYR-040/041/042, FR-TYR-002, FR-TYR-010, FR-FIT-023,
--  CHG-023/CHG-037 remainders, D12; ADR-0013 decision 1 (a write with a rule
--  of its own is a SQL function, shaped like app.submit_inspection)
-- ============================================================================
-- SQLSTATEs (all ours; the TY class forwards verbatim, ADR-0012):
--   TY011 — display-code policy refusal (D12)
--   TY012 — invalid lifecycle transition, or a tyre this tenant cannot see
--   TY013 — cost entry refused (already recorded, or not a valid amount)

-- Invoker rights, deliberately, on all four: the suite allows exactly one
-- SECURITY DEFINER routine in this schema (app.refresh_governing_tread,
-- 000001) and none of these is it. Everything below runs as app_rw under the
-- calling tenant's RLS, same as app.submit_inspection.
CREATE FUNCTION app.receive_tyres(payload jsonb)
RETURNS TABLE (tyre_id uuid, display_code text)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  pol   app.display_code_policy;
  qty   int  := COALESCE((payload->>'quantity')::int, 1);
  hand  text := NULLIF(btrim(COALESCE(payload->>'display_code','')), '');
  price numeric(12,2) := (payload->>'purchase_price')::numeric;
  tread numeric(4,1)  := (payload->>'new_tread_mm')::numeric;
  src   app.cost_source := COALESCE(payload->>'cost_source',
                                    CASE WHEN payload->>'purchase_price' IS NULL
                                         THEN 'UNKNOWN' ELSE 'INVOICE' END)::app.cost_source;
  rcv   date;
  code  text;
  new_id uuid;
BEGIN
  -- Defaulted server-side to the tenant's calendar day, never the caller's
  -- (rule 6; B4.5's from_date precedent). app.tenant_today(p_tz, p_at)
  -- defaults p_at to now(), so the single-argument call below is its
  -- ordinary one-arg form, not a partial application.
  rcv := COALESCE((payload->>'received_date')::date,
                  app.tenant_today((SELECT timezone FROM app.tenant
                                     WHERE id = app.current_tenant_id())));

  SELECT t.display_code_policy INTO pol
    FROM app.tenant t WHERE t.id = app.current_tenant_id();

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
    VALUES (app.current_tenant_id(), code,
            (payload->>'size_id')::uuid, (payload->>'brand_id')::uuid,
            (payload->>'pattern_id')::uuid, 'NEW', 0,
            (payload->>'purchase_date')::date, price, src, tread,
            app.rand_per_mm(price, tread, app.current_removal_threshold_mm()),
            'IN_STOCK', (payload->>'depot_id')::uuid, rcv)
    RETURNING id INTO new_id;

    -- The vocabulary's first writer (TYRE-48): receipt is the point a tyre
    -- becomes trackable (FR-TYR-040), and branding is a dated event so the
    -- code resolves by date across reuse (FR-TYR-042, ADR-0008 rule 2).
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES (app.current_tenant_id(), new_id, 'RECEIVED', rcv::timestamptz, 'IN_STOCK');
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
    VALUES (app.current_tenant_id(), new_id, 'BRANDED', rcv::timestamptz,
            jsonb_build_object('display_code', code));

    tyre_id := new_id; display_code := code;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION app.set_tyre_cost(p_tyre uuid, p_price numeric, p_source app.cost_source)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE cur numeric;
BEGIN
  SELECT purchase_price INTO cur FROM app.tyre WHERE id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  IF cur IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = 'this tyre''s cost is already recorded',
      HINT    = 'a correction is a decision this surface does not take; raise it against TYRE-48';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013', MESSAGE = 'a cost is a non-negative amount';
  END IF;
  -- No event: cost entry is provenance, not a lifecycle transition. The rate
  -- goes through the one permitted implementation (db/CLAUDE.md, FR-VAL-006).
  UPDATE app.tyre
     SET purchase_price = p_price, cost_source = p_source,
         rand_per_mm = app.rand_per_mm(p_price, new_tread_mm, app.current_removal_threshold_mm())
   WHERE id = p_tyre;
END $$;

CREATE FUNCTION app.dispose_tyre(p_tyre uuid, p_disposal app.tyre_state,
                                 p_reason text, p_proceeds numeric,
                                 p_occurred timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE cur app.tyre_state; why text := NULLIF(btrim(COALESCE(p_reason,'')), '');
BEGIN
  IF p_disposal NOT IN ('SCRAPPED','SOLD','LOST') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a disposal is SCRAPPED, SOLD or LOST';
  END IF;
  -- FOR UPDATE: state and event must move together, and a concurrent
  -- disposal must see this one's state, not race it.
  SELECT state INTO cur FROM app.tyre WHERE id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    -- RLS makes another tenant's uuid indistinguishable from a missing one;
    -- one message for both is the non-oracle answer.
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  IF p_disposal = 'SOLD' AND cur <> 'REMOVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('a tyre is sold from REMOVED only; this one is %s (Appendix C)', cur);
  END IF;
  IF p_disposal IN ('SCRAPPED','LOST') AND cur NOT IN ('IN_STOCK','REMOVED') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; close its fitment or log its retread return first', cur),
      HINT    = 'the rejected-casing scrap belongs to Log Retread (TYRE-93), not here';
  END IF;
  IF p_disposal = 'SCRAPPED' AND why IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'a scrap records its reason';
  END IF;
  IF p_disposal = 'SOLD' AND p_proceeds IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'a sale records its proceeds (FR-FIT-023)';
  END IF;
  IF p_disposal <> 'SOLD' AND p_proceeds IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'only a sale carries proceeds';
  END IF;

  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, proceeds)
  VALUES (app.current_tenant_id(), p_tyre, p_disposal::text, p_occurred,
          cur, p_disposal, why, p_proceeds);
  UPDATE app.tyre SET state = p_disposal WHERE id = p_tyre;
END $$;

-- FR-TYR-042: a code resolves to the tyre carrying it ON THAT DATE. The
-- governing brand per tyre is its latest BRANDED event on or before the
-- date — but a disposed tyre is never re-branded, so its latest event
-- matches forever; "carrying the code" therefore also means being in the
-- estate on that date (app.tyre_in_estate_asof, 000016): the scrapped
-- tyre's sidewall may still read the code, but it is not in the fleet to
-- be found. Historical reuse then returns the right tyre per date, and two
-- ACTIVE matches return two rows for a human to resolve — never fewer
-- (FR-TYR-043, ADR-0008 rule 3).
CREATE FUNCTION app.tyre_for_code(p_code text, p_on date)
RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT latest.tyre_id FROM (
    SELECT DISTINCT ON (e.tyre_id) e.tyre_id, e.payload->>'display_code' AS code
      FROM app.tyre_event e
     WHERE e.type = 'BRANDED' AND e.occurred_at::date <= p_on
     ORDER BY e.tyre_id, e.occurred_at DESC
  ) latest
  WHERE latest.code = p_code
    AND app.tyre_in_estate_asof(latest.tyre_id, p_on);
$$;
