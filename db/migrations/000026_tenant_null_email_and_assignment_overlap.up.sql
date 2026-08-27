-- ============================================================================
--  Platform-admin email uniqueness and driver-assignment overlap (TYRE-30)
--  Implements: the two folded decisions TYRE-30 left open; DR-003
-- ============================================================================

-- UNIQUE (tenant_id, email) in 000001 treats NULL tenant_id as distinct, so
-- two PLATFORM_ADMIN rows can share an email. Hygiene rather than exposure:
-- app_rw's WITH CHECK rejects any NULL-tenant insert, so this is reachable
-- only through the postgres provisioning path. Case folding deliberately
-- matches the existing index rather than improving on it — one email
-- comparison rule in the schema, not two.
CREATE UNIQUE INDEX app_user_platform_admin_email_key
  ON app.app_user (email) WHERE tenant_id IS NULL;

-- gist over uuid equality: btree_gist is what lets a uuid participate in an
-- exclusion constraint alongside a range.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- An exact-duplicate open assignment multiplies its vehicle through
-- v_current_assignment and v_driver_vehicle, so a driver's own vehicle list
-- shows the unit twice.
--
-- Keyed on (vehicle_id, user_id), NOT on vehicle_id alone. Constraining a
-- vehicle to one driver at a time would answer OI-32 — fixed per horse or
-- pooled per trip (TYRE-44) — which is an open sponsor question. This rejects
-- a driver overlapping themselves on one unit and nothing else.
--
-- No SRS requirement ID: TYRE-30 asked for a decision rather than citing one,
-- and this comment is that decision.
--
-- tenant_id leads the key because an exclusion check bypasses RLS: without it
-- the check scans every tenant's rows, and exclusion_violation versus the
-- composite FK's foreign_key_violation tells a caller holding another tenant's
-- vehicle and user uuids whether that pair was assigned on a caller-chosen
-- date. It costs nothing to exclude: 000004's composite FK makes vehicle_id
-- functionally determine tenant_id, so the key matches exactly the same rows.
-- It rests on vehicle_driver's policy keeping its WITH CHECK: that is what
-- forces a probing row to carry the caller's own tenant_id, and a
-- USING-only policy would reopen this.
--
-- '[]' bounds because to_date is the last day held, not the first day free:
-- this table's CHECK reads (to_date >= from_date) and 000015's
-- v_current_assignment reads (to_date IS NULL OR to_date >= tenant_today), so
-- exclusive bounds here would call a range current that this constraint
-- treated as ended. An open assignment has to_date NULL, which daterange reads
-- as unbounded above, so two open assignments always overlap.
ALTER TABLE app.vehicle_driver
  ADD CONSTRAINT vehicle_driver_no_overlap
  EXCLUDE USING gist (
    tenant_id  WITH =,
    vehicle_id WITH =,
    user_id    WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  );
