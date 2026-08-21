-- Reverses 000007. Order matters: the two rankings and the distribution
-- depend on v_fitted_tread and tread_band_list, so they go first.
DROP VIEW IF EXISTS app.v_dual_mate_ranking;
DROP VIEW IF EXISTS app.v_irregular_wear_ranking;
DROP FUNCTION IF EXISTS app.inflation_compliance(date, date);
DROP VIEW IF EXISTS app.v_tread_distribution;
DROP VIEW IF EXISTS app.v_tread_summary;
DROP VIEW IF EXISTS app.v_fitted_tread;
DROP FUNCTION IF EXISTS app.tread_band_list(jsonb);
DROP FUNCTION IF EXISTS app.config_for(uuid, text, timestamptz);
