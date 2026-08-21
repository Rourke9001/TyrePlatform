-- ============================================================================
--  Auth schema: depot-scoping isolation and user retention (TYRE-24)
--  Implements: FR-AUT-004, FR-AUT-011, DR-001, DR-013 (SRS v1.3 §4.3, §5.2)
-- ============================================================================

-- user_depot is tenant data — who may see which depot — so DR-001 requires a
-- non-nullable tenant key, and the standard policy shape needs the column to
-- bind RLS at all. The backfill resolves through depot, whose tenant_id is
-- NOT NULL; app_user's cannot anchor it because PLATFORM_ADMIN rows carry
-- NULL there (FR-AUT-003).
ALTER TABLE app.user_depot
  ADD COLUMN tenant_id uuid REFERENCES app.tenant(id) ON DELETE CASCADE;

UPDATE app.user_depot ud
   SET tenant_id = d.tenant_id
  FROM app.depot d
 WHERE d.id = ud.depot_id;

ALTER TABLE app.user_depot ALTER COLUMN tenant_id SET NOT NULL;

-- DR-013: every entity carries created_at.
ALTER TABLE app.user_depot
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

CALL app.enable_tenant_rls('app.user_depot'::regclass);

-- FR-AUT-011: users are deactivated (active = false), never deleted, so
-- historical attribution survives. Revoking is the enforcement, exactly as
-- CR-004 does for readings — the app cannot rewrite history through its own
-- connection. INSERT and UPDATE stay: ORG_ADMIN invites, suspends and
-- reactivates users (FR-AUT-010).
REVOKE DELETE ON app.app_user FROM app_rw;
