-- ============================================================================
--  Case-folded email uniqueness (TYRE-95)
--  Implements: one email comparison rule across both uniqueness indexes, so a
--  rehire retyped in different case matches the stored row (FR-VEH-008)
-- ============================================================================

-- A rehire whose address is retyped in different case must land on the same
-- row, or one human splits into two and their inspection history with them
-- (FR-VEH-008). 000026 stated the governing principle — one email comparison
-- rule in the schema, not two — so both uniqueness rules fold together here:
-- folding only the tenant-scoped one would leave the platform-admin index
-- answering a different question about the same column. Case is preserved in
-- storage; only comparison folds.

-- Fail with the colliding groups named, rather than letting the index build
-- die on a bare duplicate-key error that names one row and no cause. Every
-- seeded email is already lowercase, so this guards a future dataset, not
-- this one. One GROUP BY covers both indexes: NULL tenant_ids group together
-- here even though the btree treats them as distinct rows.
DO $$
DECLARE
  collided text;
BEGIN
  SELECT string_agg(
           format('%s (tenant %s, %s rows)', folded,
                  COALESCE(tenant_id::text, 'NULL'), cnt), '; ')
    INTO collided
    FROM (SELECT tenant_id, lower(email) AS folded, count(*) AS cnt
            FROM app.app_user
           GROUP BY tenant_id, lower(email)
          HAVING count(*) > 1) g;
  IF collided IS NOT NULL THEN
    RAISE EXCEPTION 'emails that collide once case-folded must be merged before 000027 can apply: %',
      collided;
  END IF;
END $$;

ALTER TABLE app.app_user DROP CONSTRAINT app_user_tenant_id_email_key;
CREATE UNIQUE INDEX app_user_tenant_email_key
  ON app.app_user (tenant_id, lower(email));

DROP INDEX app.app_user_platform_admin_email_key;
CREATE UNIQUE INDEX app_user_platform_admin_email_key
  ON app.app_user (lower(email)) WHERE tenant_id IS NULL;
