-- ============================================================================
--  Driver-assignment scope predicates (TYRE-25)
--  Implements: FR-VEH-007/008 read side, FR-AUT-005 (SRS v1.3 §4.3, §4.5)
-- ============================================================================

-- "Current" means the date window covers today, end date inclusive — the
-- same inclusive shape as vehicle_driver's CHECK (to_date >= from_date).
-- "Today" is fixed to the UTC date, independent of the session TimeZone GUC
-- (CURRENT_DATE would follow that GUC): an assignment starting "today" in SAST
-- is not current until UTC midnight. Accepted for the POC — the mismatch
-- window closes at 02:00 SAST, before depot working hours. Rendering in tenant
-- timezone (CR-003, tenant.timezone) is a display concern, not this predicate.
CREATE VIEW app.v_current_assignment WITH (security_invoker = true) AS
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
 WHERE vd.from_date <= (now() AT TIME ZONE 'UTC')::date
   AND (vd.to_date IS NULL OR vd.to_date >= (now() AT TIME ZONE 'UTC')::date);

-- FR-AUT-005: the one place "vehicles currently assigned to me" is defined.
-- API handlers compose this view rather than re-deriving the predicate
-- (ADR-0006). An unset actor matches no rows, failing closed the same way
-- the tenant context does (FR-TEN-004).
CREATE VIEW app.v_driver_vehicle WITH (security_invoker = true) AS
SELECT *
  FROM app.v_current_assignment
 WHERE user_id = app.current_actor_id();
