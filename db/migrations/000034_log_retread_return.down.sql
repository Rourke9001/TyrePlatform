-- Reverses 000034: drops the retread return writer. The retread jobs it
-- closed, the casing valuations and the tyre events it wrote stay — they are
-- the fleet's record of what the retreader did, and a migration that removed
-- them would be deleting facts, not a schema change (rule 3).
DROP FUNCTION app.log_retread_return(uuid, date, boolean, text, numeric, numeric, numeric, uuid);
