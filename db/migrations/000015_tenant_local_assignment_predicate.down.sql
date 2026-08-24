-- Restores the 000003 UTC-date predicate verbatim, then drops the helper.
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
 WHERE vd.from_date <= (now() AT TIME ZONE 'UTC')::date
   AND (vd.to_date IS NULL OR vd.to_date >= (now() AT TIME ZONE 'UTC')::date);

DROP FUNCTION app.tenant_today(text, timestamptz);
