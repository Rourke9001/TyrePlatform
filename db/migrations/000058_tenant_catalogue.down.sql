-- 000058 down. Drops what the up created and restores the price list's key
-- under its own name, proved by catalogue (docs/lessons.md, 2026-09-15). A
-- seeded copy keeps its platform_catalogue_id, a column the down does not
-- own, and the value then references nothing.

DROP FUNCTION app.seed_tenant_catalogue();

DROP TRIGGER tyre_price_list_audited ON app.tyre_price_list;
DROP TRIGGER casing_estimate_by_size_audited ON app.casing_estimate_by_size;
DROP TRIGGER tyre_pattern_audited ON app.tyre_pattern;
DROP TRIGGER tyre_brand_audited ON app.tyre_brand;
DROP TRIGGER tyre_size_audited ON app.tyre_size;

ALTER TABLE app.tyre_price_list
  DROP CONSTRAINT tyre_price_list_one_row_per_date,
  ADD CONSTRAINT tyre_price_list_tenant_id_size_id_brand_id_effective_from_key
    UNIQUE (tenant_id, size_id, brand_id, effective_from);

ALTER TABLE app.tyre_pattern
  DROP CONSTRAINT tyre_pattern_platform_catalogue_id_fkey,
  DROP CONSTRAINT tyre_pattern_tenant_id_platform_catalogue_id_key;
ALTER TABLE app.tyre_brand
  DROP CONSTRAINT tyre_brand_platform_catalogue_id_fkey,
  DROP CONSTRAINT tyre_brand_tenant_id_platform_catalogue_id_key;
ALTER TABLE app.tyre_size
  DROP CONSTRAINT tyre_size_platform_catalogue_id_fkey,
  DROP CONSTRAINT tyre_size_tenant_id_platform_catalogue_id_key;

DROP TABLE app.platform_tyre_pattern;
DROP TABLE app.platform_tyre_brand;
DROP TABLE app.platform_tyre_size;
