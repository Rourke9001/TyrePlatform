-- ============================================================================
--  A tenant's tyre catalogue, casing estimates and price list (TYRE-369)
--  Implements: FR-CFG-001 to FR-CFG-005, FR-CFG-007, FR-CFG-040, FR-CFG-042,
--  FR-CFG-043, FR-TEN-006, DR-007; ADR-0003, ADR-0013. Design:
--  docs/superpowers/specs/2026-10-15-tenant-catalogue-provisioning-design.md
-- ============================================================================
-- New SQLSTATEs TY024 (a catalogue file refused) and TY025 (a seed
-- refused), reached by no route (api/internal/httpapi/refusal_codes.json).
-- Every routine here runs with invoker rights and names its tenant in every
-- read and write, so it stays in the bound tenant under a role that bypasses
-- RLS as well as under app_login (db/CLAUDE.md, Adding a function). Each row
-- they write names the bound actor in created_by, NULL when none is bound,
-- as the runbook and the make target bind none (spec, Lineage and actor).

-- ---------------------------------------------------------------------------
-- The platform catalogue (FR-CFG-005, spec D1)
-- ---------------------------------------------------------------------------
-- A platform entry is one fact for every tenant, so these tables carry no
-- tenant_id. RLS is forced with a read-everyone policy and no write policy,
-- and the app role holds SELECT only, so a migration is the one writer.
-- created_by carries no foreign key, because a composite one needs a
-- tenant_id and an id-only one would reach app_user below RLS (DR-013,
-- check 16).
CREATE TABLE app.platform_tyre_size (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  construction text CHECK (construction IN ('RADIAL','CROSS_PLY')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid DEFAULT app.current_actor_id()
);
CREATE TABLE app.platform_tyre_brand (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT app.current_actor_id()
);
-- applies_to has no default, so every platform pattern states what it is
-- fitted as (ADR-0010 rule 2).
CREATE TABLE app.platform_tyre_pattern (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  brand_id   uuid REFERENCES app.platform_tyre_brand (id),
  applies_to text NOT NULL CHECK (applies_to IN ('NEW','RETREAD','BOTH')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT app.current_actor_id()
);

ALTER TABLE app.platform_tyre_size    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_tyre_size    FORCE ROW LEVEL SECURITY;
ALTER TABLE app.platform_tyre_brand   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_tyre_brand   FORCE ROW LEVEL SECURITY;
ALTER TABLE app.platform_tyre_pattern ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.platform_tyre_pattern FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_catalogue_public_read ON app.platform_tyre_size    FOR SELECT USING (true);
CREATE POLICY platform_catalogue_public_read ON app.platform_tyre_brand   FOR SELECT USING (true);
CREATE POLICY platform_catalogue_public_read ON app.platform_tyre_pattern FOR SELECT USING (true);
REVOKE INSERT, UPDATE, DELETE ON app.platform_tyre_size    FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON app.platform_tyre_brand   FROM app_rw;
REVOKE INSERT, UPDATE, DELETE ON app.platform_tyre_pattern FROM app_rw;

-- D8: the starter list, the SRS's own examples and nothing else. Every size
-- is radial (SRS Appendix D.5), the brands are FR-CFG-002's and the
-- patterns FR-CFG-003's, which state no pairing, so no pattern names a
-- brand. These are market names, not findings about any fleet. An id is
-- derived from its name, so every environment holds the same lineage id for
-- one entry and a later migration can name it.
INSERT INTO app.platform_tyre_size (id, name, construction) VALUES
  (md5('platform_tyre_size:315/80R22.5')::uuid, '315/80R22.5', 'RADIAL'),
  (md5('platform_tyre_size:225/70R19.5')::uuid, '225/70R19.5', 'RADIAL'),
  (md5('platform_tyre_size:11R22.5')::uuid,     '11R22.5',     'RADIAL'),
  (md5('platform_tyre_size:185/65R15')::uuid,   '185/65R15',   'RADIAL');
INSERT INTO app.platform_tyre_brand (id, name) VALUES
  (md5('platform_tyre_brand:Dunlop')::uuid,    'Dunlop'),
  (md5('platform_tyre_brand:Evergreen')::uuid, 'Evergreen'),
  (md5('platform_tyre_brand:Roadshine')::uuid, 'Roadshine');
INSERT INTO app.platform_tyre_pattern (id, name, applies_to) VALUES
  (md5('platform_tyre_pattern:SP431')::uuid, 'SP431', 'NEW'),
  (md5('platform_tyre_pattern:EGT88')::uuid, 'EGT88', 'NEW'),
  (md5('platform_tyre_pattern:RS620')::uuid, 'RS620', 'NEW');

-- ---------------------------------------------------------------------------
-- Lineage (FR-CFG-005) and the price list's key (FR-CFG-040)
-- ---------------------------------------------------------------------------
-- A tenant row's lineage names the platform entry it was seeded from, and a
-- tenant holds one copy of each entry. A NULL lineage is the tenant's own
-- row and is unconstrained. tenant_id leads each key (check 37a).
ALTER TABLE app.tyre_size
  ADD CONSTRAINT tyre_size_platform_catalogue_id_fkey
    FOREIGN KEY (platform_catalogue_id) REFERENCES app.platform_tyre_size (id),
  ADD CONSTRAINT tyre_size_tenant_id_platform_catalogue_id_key
    UNIQUE (tenant_id, platform_catalogue_id);
ALTER TABLE app.tyre_brand
  ADD CONSTRAINT tyre_brand_platform_catalogue_id_fkey
    FOREIGN KEY (platform_catalogue_id) REFERENCES app.platform_tyre_brand (id),
  ADD CONSTRAINT tyre_brand_tenant_id_platform_catalogue_id_key
    UNIQUE (tenant_id, platform_catalogue_id);
ALTER TABLE app.tyre_pattern
  ADD CONSTRAINT tyre_pattern_platform_catalogue_id_fkey
    FOREIGN KEY (platform_catalogue_id) REFERENCES app.platform_tyre_pattern (id),
  ADD CONSTRAINT tyre_pattern_tenant_id_platform_catalogue_id_key
    UNIQUE (tenant_id, platform_catalogue_id);

-- A brandless row is the price for its size, and NULLs are distinct in a
-- plain unique key, so two brandless rows on one date would leave the read
-- to choose by heap order (FR-CFG-040).
ALTER TABLE app.tyre_price_list
  DROP CONSTRAINT tyre_price_list_tenant_id_size_id_brand_id_effective_from_key,
  ADD CONSTRAINT tyre_price_list_one_row_per_date
    UNIQUE NULLS NOT DISTINCT (tenant_id, size_id, brand_id, effective_from);

-- ---------------------------------------------------------------------------
-- Audit (FR-AUD-001, ADR-0014)
-- ---------------------------------------------------------------------------
-- The two functions below are these tables' first write path, and a table
-- with a write path is audited (ADR-0014, U12).
CREATE TRIGGER tyre_size_audited
AFTER INSERT OR UPDATE ON app.tyre_size
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER tyre_brand_audited
AFTER INSERT OR UPDATE ON app.tyre_brand
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER tyre_pattern_audited
AFTER INSERT OR UPDATE ON app.tyre_pattern
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER casing_estimate_by_size_audited
AFTER INSERT OR UPDATE ON app.casing_estimate_by_size
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER tyre_price_list_audited
AFTER INSERT OR UPDATE ON app.tyre_price_list
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- ---------------------------------------------------------------------------
-- Seeding a tenant (FR-CFG-005, FR-TEN-006, spec D2 and D4)
-- ---------------------------------------------------------------------------
-- Copies every platform entry the bound tenant holds no copy of, matched by
-- lineage, so a second call inserts nothing and a call after a later
-- platform migration inserts only that migration's entries. An entry still
-- to copy whose name the tenant holds as a row of its own refuses the whole
-- seed, because a row is never adopted or merged by name (TYRE-369 comment
-- 13592).
CREATE FUNCTION app.seed_tenant_catalogue() RETURNS int
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tid   uuid := app.current_tenant_id();
  clash text;
  n     int;
  total int := 0;
BEGIN
  IF tid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY025',
      MESSAGE = 'a seed needs app.tenant_id bound to the fleet it seeds';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tenant t WHERE t.id = tid) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY025',
      MESSAGE = format('app.tenant_id %s names no fleet', tid);
  END IF;

  SELECT string_agg(c.what, ', ' ORDER BY c.what) INTO clash
    FROM (SELECT format('brand %L', t.name) AS what
            FROM app.platform_tyre_brand p
            JOIN app.tyre_brand t ON t.tenant_id = tid AND t.name = p.name
           WHERE NOT EXISTS (SELECT 1 FROM app.tyre_brand k WHERE k.tenant_id = tid AND k.platform_catalogue_id = p.id)
          UNION ALL
          SELECT format('pattern %L', t.name)
            FROM app.platform_tyre_pattern p
            JOIN app.tyre_pattern t ON t.tenant_id = tid AND t.name = p.name
           WHERE NOT EXISTS (SELECT 1 FROM app.tyre_pattern k WHERE k.tenant_id = tid AND k.platform_catalogue_id = p.id)
          UNION ALL
          SELECT format('size %L', t.name)
            FROM app.platform_tyre_size p
            JOIN app.tyre_size t ON t.tenant_id = tid AND t.name = p.name
           WHERE NOT EXISTS (SELECT 1 FROM app.tyre_size k WHERE k.tenant_id = tid AND k.platform_catalogue_id = p.id)) c;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY025',
      MESSAGE = format('this fleet already has its own %s; a platform entry never adopts a row by name, so nothing was seeded', clash);
  END IF;

  INSERT INTO app.tyre_brand (tenant_id, name, platform_catalogue_id, created_by)
  SELECT tid, p.name, p.id, app.current_actor_id()
    FROM app.platform_tyre_brand p
   WHERE NOT EXISTS (SELECT 1 FROM app.tyre_brand t WHERE t.tenant_id = tid AND t.platform_catalogue_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  INSERT INTO app.tyre_size (tenant_id, name, construction, platform_catalogue_id, created_by)
  SELECT tid, p.name, p.construction, p.id, app.current_actor_id()
    FROM app.platform_tyre_size p
   WHERE NOT EXISTS (SELECT 1 FROM app.tyre_size t WHERE t.tenant_id = tid AND t.platform_catalogue_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  -- A pattern's brand is the tenant's copy of its platform brand, found by
  -- lineage and never by name (D4).
  INSERT INTO app.tyre_pattern (tenant_id, name, brand_id, applies_to, platform_catalogue_id, created_by)
  SELECT tid, p.name, b.id, p.applies_to, p.id, app.current_actor_id()
    FROM app.platform_tyre_pattern p
    LEFT JOIN app.tyre_brand b ON b.tenant_id = tid AND b.platform_catalogue_id = p.brand_id
   WHERE NOT EXISTS (SELECT 1 FROM app.tyre_pattern t WHERE t.tenant_id = tid AND t.platform_catalogue_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN total + n;
END $$;

-- ---------------------------------------------------------------------------
-- Loading a tenant's file (FR-CFG-001 to 003, FR-CFG-040, FR-CFG-042,
-- FR-CFG-043, spec D3 to D5)
-- ---------------------------------------------------------------------------
-- The readers below refuse a file's shape as TY024, naming the section, the
-- row's position in it (from 1) and the reason, so a supplier can correct
-- the file. They read no table.

-- A section's rows, each an object holding only the section's fields. An
-- absent or null section has no rows.
CREATE FUNCTION app.catalogue_file_rows(p_payload jsonb, p_section text, p_fields text[])
RETURNS TABLE (pos bigint, rw jsonb)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  sec   jsonb := p_payload -> p_section;
  extra text;
BEGIN
  IF sec IS NULL OR jsonb_typeof(sec) = 'null' THEN
    RETURN;
  END IF;
  IF jsonb_typeof(sec) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s is not a list; each section is a JSON array of rows', p_section);
  END IF;
  FOR rw, pos IN SELECT e.value, e.ordinality FROM jsonb_array_elements(sec) WITH ORDINALITY e LOOP
    IF jsonb_typeof(rw) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s row %s is not an object; each row is a JSON object of fields', p_section, pos);
    END IF;
    -- A misspelt field would otherwise load as a row without that value.
    SELECT min(k.key) INTO extra FROM jsonb_object_keys(rw) AS k(key) WHERE k.key <> ALL (p_fields);
    IF extra IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s row %s: %L is not a field; the fields are %s',
                         p_section, pos, extra, array_to_string(p_fields, ', '));
    END IF;
    RETURN NEXT;
  END LOOP;
END $$;

-- A name or a choice. A JSON null reads as absent. A name with white space
-- at either end would sit beside its trimmed twin under UNIQUE (tenant_id,
-- name), so it is refused rather than trimmed.
CREATE FUNCTION app.catalogue_file_text(p_row jsonb, p_field text, p_label text, p_required boolean)
RETURNS text
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v jsonb := p_row -> p_field;
  s text;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    IF p_required THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: %s is required', p_label, p_field);
    END IF;
    RETURN NULL;
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is written as a JSON string', p_label, p_field);
  END IF;
  s := v #>> '{}';
  IF s = '' OR s ~ '^[[:space:]]' OR s ~ '[[:space:]]$' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is empty or begins or ends with white space', p_label, p_field, s);
  END IF;
  RETURN s;
END $$;

-- Rule 2, DR-007. An amount arrives as a string of rand with at most two
-- decimal places, and anything else is refused, never rounded or coerced.
-- Most JSON tools hold a number as a float, so a number's cents may
-- already be gone by the time it arrives.
CREATE FUNCTION app.catalogue_file_money(p_row jsonb, p_field text, p_label text)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v jsonb := p_row -> p_field;
  s text;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is required', p_label, p_field);
  END IF;
  IF jsonb_typeof(v) = 'number' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is a JSON number; write the amount as a string, such as "1837.50", so nothing reads it as a float', p_label, p_field);
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is written as a JSON string, such as "1837.50"', p_label, p_field);
  END IF;
  s := v #>> '{}';
  IF s ~ '^-' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is negative', p_label, p_field, s);
  END IF;
  IF s ~ '^[0-9]+[.][0-9]{3,}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L has more than two decimal places; a load never rounds an amount', p_label, p_field, s);
  END IF;
  IF s !~ '^[0-9]+([.][0-9]{1,2})?$' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is not an amount in rand, such as "1837.50"', p_label, p_field, s);
  END IF;
  -- numeric(12,2)'s ceiling, the type of both money columns.
  IF s::numeric > 9999999999.99 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is above 9999999999.99, the most an amount can hold', p_label, p_field, s);
  END IF;
  RETURN s::numeric;
END $$;

-- D5: every estimate and price row states its own date, written YYYY-MM-DD.
CREATE FUNCTION app.catalogue_file_date(p_row jsonb, p_field text, p_label text)
RETURNS date
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  v jsonb := p_row -> p_field;
  s text;
  d date;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is required', p_label, p_field);
  END IF;
  IF jsonb_typeof(v) <> 'string' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s is written as a JSON string, such as "2026-11-01"', p_label, p_field);
  END IF;
  s := v #>> '{}';
  IF s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is not a date written YYYY-MM-DD', p_label, p_field, s);
  END IF;
  -- The shape passes 2026-02-30; the cast is what knows the calendar.
  BEGIN
    d := s::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%s: %s %L is not a date written YYYY-MM-DD', p_label, p_field, s);
  END;
  RETURN d;
END $$;

-- One file, one transaction, insert-only (D3). Sizes, brands and patterns
-- load first, so a later section may name an entry an earlier one adds.
-- Names resolve against the bound tenant's rows alone, seeded or its own,
-- and exactly as UNIQUE (tenant_id, name) compares them. A row from the
-- file carries no lineage (D4). A price change is a new row with a later
-- effective_from, and the row it supersedes stays (FR-CFG-042).
CREATE FUNCTION app.provision_catalogue(p_payload jsonb)
RETURNS TABLE (section text, inserted int)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  tid   uuid := app.current_tenant_id();
  r     record;
  lbl   text;
  nm    text;
  val   text;
  bname text;
  which text;
  prev  bigint;
  sz    uuid;
  br    uuid;
  amt   numeric;
  eff   date;
  extra text;
  n_sizes     int := 0;
  n_brands    int := 0;
  n_patterns  int := 0;
  n_estimates int := 0;
  n_prices    int := 0;
BEGIN
  IF tid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = 'a catalogue load needs app.tenant_id bound to the fleet it loads into';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.tenant t WHERE t.id = tid) THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('app.tenant_id %s names no fleet', tid);
  END IF;
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = 'a catalogue file is one JSON object of sections: sizes, brands, patterns, casing_estimates and price_list';
  END IF;
  SELECT min(k.key) INTO extra FROM jsonb_object_keys(p_payload) AS k(key)
   WHERE k.key NOT IN ('sizes', 'brands', 'patterns', 'casing_estimates', 'price_list');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY024',
      MESSAGE = format('%L is not a section; the sections are sizes, brands, patterns, casing_estimates and price_list', extra);
  END IF;

  FOR r IN SELECT f.pos, f.rw
             FROM app.catalogue_file_rows(p_payload, 'sizes', ARRAY['name', 'construction']) f LOOP
    lbl := format('sizes row %s', r.pos);
    nm  := app.catalogue_file_text(r.rw, 'name', lbl, true);
    val := app.catalogue_file_text(r.rw, 'construction', lbl, false);
    IF val NOT IN ('RADIAL', 'CROSS_PLY') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: construction is RADIAL or CROSS_PLY, not %L', lbl, val);
    END IF;
    SELECT min(e.ordinality) INTO prev
      FROM jsonb_array_elements(p_payload -> 'sizes') WITH ORDINALITY e
     WHERE e.ordinality < r.pos AND e.value ->> 'name' = nm;
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the name %L repeats sizes row %s; a file names each entry once', lbl, nm, prev);
    END IF;
    IF EXISTS (SELECT 1 FROM app.tyre_size s WHERE s.tenant_id = tid AND s.name = nm) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: this fleet already has the size %L; a load adds rows and never changes one', lbl, nm);
    END IF;
    INSERT INTO app.tyre_size (tenant_id, name, construction, created_by)
    VALUES (tid, nm, val, app.current_actor_id());
    n_sizes := n_sizes + 1;
  END LOOP;

  FOR r IN SELECT f.pos, f.rw
             FROM app.catalogue_file_rows(p_payload, 'brands', ARRAY['name']) f LOOP
    lbl := format('brands row %s', r.pos);
    nm  := app.catalogue_file_text(r.rw, 'name', lbl, true);
    SELECT min(e.ordinality) INTO prev
      FROM jsonb_array_elements(p_payload -> 'brands') WITH ORDINALITY e
     WHERE e.ordinality < r.pos AND e.value ->> 'name' = nm;
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the name %L repeats brands row %s; a file names each entry once', lbl, nm, prev);
    END IF;
    IF EXISTS (SELECT 1 FROM app.tyre_brand b WHERE b.tenant_id = tid AND b.name = nm) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: this fleet already has the brand %L; a load adds rows and never changes one', lbl, nm);
    END IF;
    INSERT INTO app.tyre_brand (tenant_id, name, created_by) VALUES (tid, nm, app.current_actor_id());
    n_brands := n_brands + 1;
  END LOOP;

  FOR r IN SELECT f.pos, f.rw
             FROM app.catalogue_file_rows(p_payload, 'patterns', ARRAY['name', 'brand', 'applies_to']) f LOOP
    lbl := format('patterns row %s', r.pos);
    nm  := app.catalogue_file_text(r.rw, 'name', lbl, true);
    -- Required although the column has a default, because whether receipt
    -- offers the pattern turns on it (FR-CFG-004, ADR-0010 rule 2).
    val := app.catalogue_file_text(r.rw, 'applies_to', lbl, true);
    IF val NOT IN ('NEW', 'RETREAD', 'BOTH') THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: applies_to is NEW, RETREAD or BOTH, not %L', lbl, val);
    END IF;
    bname := app.catalogue_file_text(r.rw, 'brand', lbl, false);
    br := NULL;
    IF bname IS NOT NULL THEN
      SELECT b.id INTO br FROM app.tyre_brand b WHERE b.tenant_id = tid AND b.name = bname;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'TY024',
          MESSAGE = format('%s: this fleet has no brand named %L', lbl, bname);
      END IF;
    END IF;
    SELECT min(e.ordinality) INTO prev
      FROM jsonb_array_elements(p_payload -> 'patterns') WITH ORDINALITY e
     WHERE e.ordinality < r.pos AND e.value ->> 'name' = nm;
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the name %L repeats patterns row %s; a file names each entry once', lbl, nm, prev);
    END IF;
    IF EXISTS (SELECT 1 FROM app.tyre_pattern p WHERE p.tenant_id = tid AND p.name = nm) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: this fleet already has the pattern %L; a load adds rows and never changes one', lbl, nm);
    END IF;
    INSERT INTO app.tyre_pattern (tenant_id, name, brand_id, applies_to, created_by)
    VALUES (tid, nm, br, val, app.current_actor_id());
    n_patterns := n_patterns + 1;
  END LOOP;

  FOR r IN SELECT f.pos, f.rw
             FROM app.catalogue_file_rows(p_payload, 'casing_estimates',
                                          ARRAY['size', 'estimated_value', 'effective_from']) f LOOP
    lbl := format('casing_estimates row %s', r.pos);
    nm  := app.catalogue_file_text(r.rw, 'size', lbl, true);
    SELECT s.id INTO sz FROM app.tyre_size s WHERE s.tenant_id = tid AND s.name = nm;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: this fleet has no size named %L', lbl, nm);
    END IF;
    amt := app.catalogue_file_money(r.rw, 'estimated_value', lbl);
    eff := app.catalogue_file_date(r.rw, 'effective_from', lbl);
    SELECT min(e.ordinality) INTO prev
      FROM jsonb_array_elements(p_payload -> 'casing_estimates') WITH ORDINALITY e
     WHERE e.ordinality < r.pos AND e.value ->> 'size' = nm
       AND e.value ->> 'effective_from' = r.rw ->> 'effective_from';
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the size %L effective %s repeats casing_estimates row %s',
                         lbl, nm, to_char(eff, 'YYYY-MM-DD'), prev);
    END IF;
    IF EXISTS (SELECT 1 FROM app.casing_estimate_by_size e
                WHERE e.tenant_id = tid AND e.size_id = sz AND e.effective_from = eff) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the size %L already has a casing estimate effective %s; a change is a new row with a later effective_from',
                         lbl, nm, to_char(eff, 'YYYY-MM-DD'));
    END IF;
    INSERT INTO app.casing_estimate_by_size (tenant_id, size_id, estimated_value, effective_from, created_by)
    VALUES (tid, sz, amt, eff, app.current_actor_id());
    n_estimates := n_estimates + 1;
  END LOOP;

  FOR r IN SELECT f.pos, f.rw
             FROM app.catalogue_file_rows(p_payload, 'price_list',
                                          ARRAY['size', 'brand', 'typical_price', 'effective_from']) f LOOP
    lbl := format('price_list row %s', r.pos);
    nm  := app.catalogue_file_text(r.rw, 'size', lbl, true);
    SELECT s.id INTO sz FROM app.tyre_size s WHERE s.tenant_id = tid AND s.name = nm;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: this fleet has no size named %L', lbl, nm);
    END IF;
    bname := app.catalogue_file_text(r.rw, 'brand', lbl, false);
    br := NULL;
    IF bname IS NOT NULL THEN
      SELECT b.id INTO br FROM app.tyre_brand b WHERE b.tenant_id = tid AND b.name = bname;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'TY024',
          MESSAGE = format('%s: this fleet has no brand named %L', lbl, bname);
      END IF;
    END IF;
    amt := app.catalogue_file_money(r.rw, 'typical_price', lbl);
    eff := app.catalogue_file_date(r.rw, 'effective_from', lbl);
    which := CASE WHEN bname IS NULL THEN 'with no brand' ELSE format('for the brand %L', bname) END;
    SELECT min(e.ordinality) INTO prev
      FROM jsonb_array_elements(p_payload -> 'price_list') WITH ORDINALITY e
     WHERE e.ordinality < r.pos AND e.value ->> 'size' = nm
       AND e.value ->> 'brand' IS NOT DISTINCT FROM bname
       AND e.value ->> 'effective_from' = r.rw ->> 'effective_from';
    IF prev IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the size %L %s effective %s repeats price_list row %s',
                         lbl, nm, which, to_char(eff, 'YYYY-MM-DD'), prev);
    END IF;
    IF EXISTS (SELECT 1 FROM app.tyre_price_list p
                WHERE p.tenant_id = tid AND p.size_id = sz
                  AND p.brand_id IS NOT DISTINCT FROM br AND p.effective_from = eff) THEN
      RAISE EXCEPTION USING ERRCODE = 'TY024',
        MESSAGE = format('%s: the size %L already has a price %s effective %s; a change is a new row with a later effective_from',
                         lbl, nm, which, to_char(eff, 'YYYY-MM-DD'));
    END IF;
    INSERT INTO app.tyre_price_list (tenant_id, size_id, brand_id, typical_price, effective_from, created_by)
    VALUES (tid, sz, br, amt, eff, app.current_actor_id());
    n_prices := n_prices + 1;
  END LOOP;

  RETURN QUERY VALUES ('sizes', n_sizes), ('brands', n_brands), ('patterns', n_patterns),
                      ('casing_estimates', n_estimates), ('price_list', n_prices);
END $$;
