-- Reverses 000010. The eight standalone types drop cleanly: every consumer
-- lives in 000011+ and is gone by the time this runs.
DROP TYPE app.task_state;
DROP TYPE app.temperature_state;
DROP TYPE app.distance_provenance;
DROP TYPE app.cost_source;
DROP TYPE app.valuation_source;
DROP TYPE app.unit_kind;
DROP TYPE app.axle_type;
DROP TYPE app.tread_position;

-- The ADD VALUE extensions stay: PostgreSQL cannot remove an enum value, and
-- rebuilding tyre_state / vehicle_status / reading_source would force dropping
-- every function whose signature carries them. The extra values are additive
-- and inert — nothing at 000009 writes or reads them — so a down+up cycle is
-- clean (000010's ADD VALUE IF NOT EXISTS is idempotent).
