-- ============================================================================
--  last_tread_mm / last_tread_at documented at the column (TYRE-57)
--  Implements: FR-TYR-016 (errata E1), FR-TYR-032, SRS §5.1 tyre note
-- ============================================================================

-- Discoverable from the database alone: the register (tyre_valuation_asof)
-- COALESCEs the latest reading over this column, so a stale value here can
-- never shadow a reading. A tyre with neither is UNVALUED — excluded from
-- tread totals, casing still counted (FR-TYR-032, NFR-PRO-002).
COMMENT ON COLUMN app.tyre.last_tread_mm IS
  'Onboarding-audit fallback (FR-TYR-016 errata E1): populated at tyre creation where a tread is known, never subsequently maintained. Not a cache of the latest reading — current tread always derives from reading.';
COMMENT ON COLUMN app.tyre.last_tread_at IS
  'Measurement date accompanying last_tread_mm; same fallback-only contract. Drives the AUDIT tread_source label and staleness display (FR-TYR-017), never a substitute for reading.submitted_at.';
