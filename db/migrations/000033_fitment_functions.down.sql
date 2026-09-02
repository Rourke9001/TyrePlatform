-- Reverses 000033: drops the five fitment writers and the instant guard they
-- share. The fitment rows, tyre states, events and retread jobs they wrote
-- stay: they are the fleet's history, and a migration that reversed them
-- would be deleting records, not a schema change (rule 3).
DROP FUNCTION app.return_tyre_to_stock(uuid, uuid, timestamptz);
DROP FUNCTION app.dispatch_tyre(uuid, app.tyre_state, uuid, date);
DROP FUNCTION app.rotate_tyres(uuid, jsonb, bigint, timestamptz);
DROP FUNCTION app.remove_tyre(uuid, text, numeric, bigint, timestamptz, text);
DROP FUNCTION app.fit_tyre(uuid, uuid, uuid, numeric, app.mount_orientation, bigint, timestamptz, text);
DROP FUNCTION app.fitment_instant_ok(uuid, timestamptz, text);
