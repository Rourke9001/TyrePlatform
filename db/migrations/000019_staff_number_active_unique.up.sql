-- ============================================================================
--  staff_number unique among ACTIVE users within a tenant (TYRE-30)
--  Implements: FR-AUT-022 (errata E1 note), mirroring DR-002's pattern
-- ============================================================================

-- The display-code lesson (000011, one_active_display_code_per_tenant)
-- applies to people too: real identifiers are unique among things currently
-- in play and reused across time. A global constraint would reject the first
-- rehired employee number; no constraint lets two active drivers share one
-- and makes FR-AUT-022's "durable identifier" ambiguous at the moment it is
-- used for inspection attribution. The partial index is the reading that
-- survives both possible sponsor answers (TYRE-64 carries the question).
CREATE UNIQUE INDEX one_active_staff_number_per_tenant
  ON app.app_user (tenant_id, staff_number)
  WHERE staff_number IS NOT NULL AND active;
