-- 000047 down. Restores the state the up migration found: app.reading with
-- reading_by_tyre and its unique constraints only. Dropping this index costs
-- the full-history sort the up file's header describes; it costs nothing
-- else, since nothing reads the index by name except suite section 61.
DROP INDEX app.reading_by_vehicle;
