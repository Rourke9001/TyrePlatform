-- ============================================================================
--  D12 display-code policy, D13 mount orientation, TYRE-48 event vocabulary
--  Implements: D12/D13 (Reconciliation 30 Aug 2026, page 17170433);
--  CHG-023/CHG-037 remainders; FR-TYR-004 as amended by D12
-- ============================================================================

-- D12: per-tenant policy. FREE keeps FR-TYR-004's "warns, never blocks";
-- GENERATED has the platform issue the code and refuse a hand-typed one —
-- the mark is the only identity that survives rotation and retread, so the
-- pilot enforces it (D12's stated reasoning). Enforcement lives in
-- app.receive_tyres (000031); DB uniqueness stays active-only per tenant
-- (one_active_display_code_per_tenant, ADR-0008/DR-002) in both modes.
CREATE TYPE app.display_code_policy AS ENUM ('FREE','GENERATED');
ALTER TABLE app.tenant
  ADD COLUMN display_code_policy app.display_code_policy NOT NULL DEFAULT 'FREE';

-- The GENERATED scheme's per-tenant counter (ADR-0008's recommended
-- sequential code, e.g. BAC-04217). A table row rather than a sequence so
-- issuance can take the row lock inside the receive transaction — two
-- concurrent bulk receives serialise instead of minting a duplicate.
CREATE TABLE app.display_code_counter (
  tenant_id   uuid PRIMARY KEY REFERENCES app.tenant(id),
  prefix      text   NOT NULL CHECK (prefix ~ '^[A-Z0-9]{2,8}$'),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0)
);
CALL app.enable_tenant_rls('app.display_code_counter'::regclass);
-- Explicit per-table grant, matching 000012's idiom: enable_tenant_rls only
-- does ENABLE/FORCE/POLICY, never grants. DELETE is deliberately withheld —
-- a counter the app role can delete is a numbering reset waiting to happen,
-- unlike 000012's own new tables, none of which mint an identity.
GRANT SELECT, INSERT, UPDATE ON app.display_code_counter TO app_rw;

-- D13: the tyre's own orientation on the side it is fitted to — which
-- sidewall carries the mark — distinct from the position's left/right and
-- from reading orientation (FR-CFG-024), neither derivable from the other.
-- No behaviour reads it until per-casing irregular-wear analysis
-- (FR-EXC-035, BR-ANL-010); it exists now because a pilot fitment recorded
-- as UNKNOWN is unrecoverable later.
CREATE TYPE app.mount_orientation AS ENUM ('MARK_OUTBOARD','MARK_INBOARD','UNKNOWN');
ALTER TABLE app.fitment
  ADD COLUMN mount_orientation app.mount_orientation NOT NULL DEFAULT 'UNKNOWN';

-- TYRE-48 / CHG-037: the lifecycle vocabulary, closed now that this batch
-- writes its first events. A CHECK rather than an enum: the vocabulary is
-- young — TYRE-92/93 write half of it for the first time — and replacing a
-- CHECK is one migration where enum surgery is not. REBALANCED is
-- deliberately absent (30 Aug clarification: not a fitment event; open on
-- TYRE-48).
ALTER TABLE app.tyre_event
  ADD CONSTRAINT tyre_event_type_in_vocabulary CHECK (type IN
    ('RECEIVED','BRANDED','FITTED','ROTATED','REMOVED','SENT_FOR_RETREAD',
     'RETURNED','REFITTED','INSPECTED','SCRAPPED','SOLD','LOST')),
  -- app.tyre_in_estate_asof (000016) reads the latest non-NULL to_state and
  -- is fail-open: an event that changes membership but omits to_state is
  -- invisible to valuation. ROTATED still states FITTED — unchanged is not
  -- unsaid.
  ADD CONSTRAINT state_change_carries_to_state CHECK
    (type IN ('BRANDED','INSPECTED') OR to_state IS NOT NULL),
  ADD CONSTRAINT sold_carries_proceeds CHECK
    ((type = 'SOLD') = (proceeds IS NOT NULL));
