-- 000051 down. Restores the two grants the up migration found: PUBLIC's
-- default EXECUTE and 000001's schema-wide grant to app_rw.
GRANT EXECUTE ON FUNCTION app.refresh_governing_tread() TO PUBLIC, app_rw;
