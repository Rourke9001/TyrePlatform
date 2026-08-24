-- ============================================================================
--  "Current assignment" resolves today in the tenant's timezone (TYRE-57)
--  Implements: FR-AUT-005 (SRS §4.3), CR-003 / FR-TEN-005 (tenant.timezone)
-- ============================================================================

-- FR-AUT-005 makes this predicate the gate on whether a driver can inspect at
-- all, so "today" must be the tenant's civil date, not UTC's. Pinned to UTC
-- (000003), an assignment starting today was invisible from 00:00 to 02:00
-- SAST — and a 01:00 pre-trip walk-around is ordinary in a long-haul fleet,
-- with the failure indistinguishable from "you have no assignment". Day
-- granularity itself is correct and stays; only the calendar the day is read
-- from changes.
--
-- The timestamp parameter exists so the midnight boundary is testable
-- deterministically; production callers take the default.
CREATE FUNCTION app.tenant_today(p_tz text, p_at timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (p_at AT TIME ZONE p_tz)::date
$$;

-- The tenant join supplies the calendar. The window is end-date inclusive,
-- matching vehicle_driver's CHECK. An unset tenant context sees no tenant row
-- under RLS, so the view matches no rows for an unbound session — the
-- fail-closed shape FR-TEN-004 requires.
CREATE OR REPLACE VIEW app.v_current_assignment WITH (security_invoker = true) AS
SELECT vd.tenant_id,
       vd.vehicle_id,
       vd.user_id,
       vd.from_date,
       vd.to_date,
       v.fleet_number,
       v.registration,
       u.display_name,
       u.staff_number
  FROM app.vehicle_driver vd
  JOIN app.vehicle  v ON v.id = vd.vehicle_id
  JOIN app.app_user u ON u.id = vd.user_id
  JOIN app.tenant   t ON t.id = vd.tenant_id
 WHERE vd.from_date <= app.tenant_today(t.timezone)
   AND (vd.to_date IS NULL OR vd.to_date >= app.tenant_today(t.timezone));
