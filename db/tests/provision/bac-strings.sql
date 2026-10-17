-- Rows that name the pilot client, across app.tenant and every app table
-- with a tenant_id (U92: the demonstration tenant's readings must never read
-- as findings about BAC's vehicles; TYRE-374). Runs as postgres. Case
-- sensitive on purpose, because ids are lowercase hex.
--
-- Variable: expect, "some" for the control (the local fixture does name
-- BAC) or "none" for the demonstration database.
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('provision.expect', :'expect', false);
\o
DO $$
DECLARE
  pattern text := '(BAC|Bac|\mbac\M)';
  rel text;
  n bigint;
  total bigint;
  hits text := '';
BEGIN
  SELECT count(*) INTO total FROM app.tenant t WHERE t::text ~ pattern;
  IF total > 0 THEN
    hits := 'tenant ';
  END IF;
  FOR rel IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM app.%I r WHERE r::text ~ $1', rel) INTO n USING pattern;
    IF n > 0 THEN
      hits := hits || rel || ' ';
    END IF;
    total := total + n;
  END LOOP;
  IF current_setting('provision.expect') = 'some' AND total = 0 THEN
    RAISE EXCEPTION 'FAIL B1: the control found no row naming BAC, so the probe proves nothing';
  END IF;
  IF current_setting('provision.expect') = 'none' AND total > 0 THEN
    RAISE EXCEPTION 'FAIL B2: % rows name BAC, in %', total, hits;
  END IF;
  IF current_setting('provision.expect') NOT IN ('some', 'none') THEN
    RAISE EXCEPTION 'FAIL B0: expect is %, not some or none', current_setting('provision.expect');
  END IF;
END $$;
\echo 'bac strings: as expected'
