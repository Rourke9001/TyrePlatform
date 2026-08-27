DROP TRIGGER IF EXISTS vehicle_configuration_is_immutable ON app.vehicle;
DROP FUNCTION IF EXISTS app.reject_configuration_change_with_history();
