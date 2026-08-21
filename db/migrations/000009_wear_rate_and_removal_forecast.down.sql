-- Reverses 000009. The horizon list returns the forecast's own row type and
-- the forecast reads the wear rate, so they drop in that order.
DROP FUNCTION IF EXISTS app.removal_forecast_within(date, int);
DROP VIEW IF EXISTS app.v_removal_forecast;
DROP VIEW IF EXISTS app.v_tyre_wear_rate;
DROP VIEW IF EXISTS app.v_tyre_reading_odometer;
