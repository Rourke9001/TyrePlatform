-- ============================================================================
--  DR-014a: revoke DELETE from app_rw everywhere it is not a cache (TYRE-30)
--  Implements: DR-014
--
--  A record of fact is corrected by a compensating event, never destroyed —
--  the CR-004/DR-011 principle 000001 already enforces with UPDATE/DELETE
--  revokes on reading, reading_measurement, tyre_event and audit_log, and
--  000012 extends to casing_valuation, tenant_consent and
--  vehicle_odometer_reading. This migration closes the remaining gap: every
--  OTHER table in schema app still grants app_rw plain DELETE, inherited from
--  000001's blanket `GRANT ... DELETE ON ALL TABLES` and 000012's per-table
--  grant loop, with no compensating-event discipline behind it at all — a
--  fleet manager's mis-click can erase a vehicle, a tyre, an inspection.
--
--  The one exception is app.valuation_snapshot: it is a derived CACHE of
--  app.tyre_valuation_asof(), explicitly documented as such since 000006/
--  000008 ("a derivable cache of the readings, never the record of fact"),
--  and app.reconcile_valuation_snapshots() deletes stale rows from it with
--  INVOKER rights — called directly by app.take_valuation_snapshots() (the
--  month-end pass, invoked over the app_rw connection) as well as indirectly
--  through the reading-trigger chain. Revoking DELETE there would break the
--  month-end reconciliation this migration is not the one to redesign.
--
--  DR-014b — soft-delete (an `active`-style flag) for the handful of tables
--  where a manager needs to retract a mistaken row without an event log
--  (vehicle_tag, operating_group membership, and similar) — is its own
--  ticket, TYRE-60. Nothing here does that; it only removes the capability
--  to hard-delete.
--
--  WARNING for future migrations: a blanket
--  `GRANT ALL ON ALL TABLES IN SCHEMA app TO app_rw` (or `GRANT DELETE ON ALL
--  TABLES ...`) silently undoes every revoke below, exactly as db/CLAUDE.md
--  warns for UPDATE on the append-only set. Grant DELETE per table, never
--  with ALL TABLES, if a future ticket legitimately needs to add one back.
-- ============================================================================

REVOKE DELETE ON app.tenant                    FROM app_rw;
REVOKE DELETE ON app.configuration             FROM app_rw;
REVOKE DELETE ON app.depot                     FROM app_rw;
REVOKE DELETE ON app.user_depot                FROM app_rw;
REVOKE DELETE ON app.axle_configuration        FROM app_rw;
REVOKE DELETE ON app.position                  FROM app_rw;
REVOKE DELETE ON app.vehicle                   FROM app_rw;
REVOKE DELETE ON app.vehicle_driver            FROM app_rw;
REVOKE DELETE ON app.combination               FROM app_rw;
REVOKE DELETE ON app.combination_member        FROM app_rw;
REVOKE DELETE ON app.tyre_size                 FROM app_rw;
REVOKE DELETE ON app.tyre_brand                FROM app_rw;
REVOKE DELETE ON app.tyre_pattern              FROM app_rw;
REVOKE DELETE ON app.tyre                      FROM app_rw;
REVOKE DELETE ON app.fitment                   FROM app_rw;
REVOKE DELETE ON app.inspection                FROM app_rw;
REVOKE DELETE ON app.photo                     FROM app_rw;
REVOKE DELETE ON app.exception_rule            FROM app_rw;
REVOKE DELETE ON app.exception                 FROM app_rw;
REVOKE DELETE ON app.notification              FROM app_rw;

-- app.valuation_snapshot: DELIBERATELY NOT REVOKED. app.reconcile_valuation_
-- snapshots() (000008/000009), invoker rights, prunes rows this tenant no
-- longer values whenever it runs on the app_rw connection (the month-end
-- app.take_valuation_snapshots() pass, and the reading-trigger chain). It is
-- a cache repair, not a destruction of record — see the file header.

REVOKE DELETE ON app.operating_group           FROM app_rw;
REVOKE DELETE ON app.vehicle_tag               FROM app_rw;
REVOKE DELETE ON app.vehicle_tag_map           FROM app_rw;
REVOKE DELETE ON app.threshold_policy          FROM app_rw;
REVOKE DELETE ON app.retread_job               FROM app_rw;
REVOKE DELETE ON app.casing_estimate_by_size   FROM app_rw;
REVOKE DELETE ON app.tyre_price_list           FROM app_rw;
REVOKE DELETE ON app.target_pressure           FROM app_rw;
REVOKE DELETE ON app.inspection_schedule       FROM app_rw;
REVOKE DELETE ON app.inspection_task           FROM app_rw;
