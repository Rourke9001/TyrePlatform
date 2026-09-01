DROP FUNCTION IF EXISTS app.tyre_for_code(text, date);
DROP FUNCTION IF EXISTS app.dispose_tyre(uuid, app.tyre_state, text, numeric, timestamptz);
DROP FUNCTION IF EXISTS app.set_tyre_cost(uuid, numeric, app.cost_source);
DROP FUNCTION IF EXISTS app.receive_tyres(jsonb);
