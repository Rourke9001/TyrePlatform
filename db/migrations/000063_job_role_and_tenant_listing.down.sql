-- Reverses 000063's listing. The role and its membership in app_rw stay:
-- DROP ROLE fails while any database in the cluster refers to the role
-- (https://www.postgresql.org/docs/16/sql-droprole.html), as 000061's down
-- keeps app_writer, and 000063's guard lets up run again over it.

DROP FUNCTION app.active_tenant_ids();
