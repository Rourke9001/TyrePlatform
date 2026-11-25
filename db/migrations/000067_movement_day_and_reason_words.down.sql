-- Reverses 000067 (TYRE-240).

DROP FUNCTION app.positions_free_at(timestamptz, uuid[], uuid[]);
DROP FUNCTION app.backdate_reason_ok(date, text);
DROP FUNCTION app.place_movement(date, uuid[], uuid[], uuid[]);
DROP FUNCTION app.last_movement(uuid[], uuid[], uuid[]);
