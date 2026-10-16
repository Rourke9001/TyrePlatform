-- ============================================================================
--  A tenant's tyre catalogue, casing estimates and price list (TYRE-369)
--  Implements: FR-CFG-001 to FR-CFG-005, FR-CFG-007, FR-CFG-040, FR-CFG-042,
--  FR-CFG-043, FR-TEN-006, DR-007; ADR-0003, ADR-0013. Design:
--  docs/superpowers/specs/2026-10-15-tenant-catalogue-provisioning-design.md
-- ============================================================================

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
