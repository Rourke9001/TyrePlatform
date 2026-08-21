-- Reverses 000005: drops the valuation views and the threshold resolver this
-- migration created, restoring the schema exactly as 000004 left it.
DROP VIEW app.v_estate_valuation;
DROP VIEW app.v_tyre_valuation;
DROP FUNCTION app.current_removal_threshold_mm();
