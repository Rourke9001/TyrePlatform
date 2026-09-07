-- 000043 down. The bodies were never touched; only the setting comes off.
ALTER FUNCTION app.check_measurement_ordinals() RESET search_path;
ALTER PROCEDURE app.enable_tenant_rls(regclass) RESET search_path;
ALTER FUNCTION app.predicted_threshold_range(uuid, numeric, numeric) RESET search_path;
