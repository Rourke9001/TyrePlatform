# B5 slice 1 — Tyre Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver B5's first slice — TYRE-88 and TYRE-87 hardening, the D12/D13 schema, TYRE-48's event vocabulary frozen by its first writer, and TYRE-91's tyre-register surface (receive, awaiting-cost, dated code lookup, scrap/sell/lost) end to end.

**Architecture:** Business rules land as SQL (a vocabulary CHECK, per-tenant policy, lifecycle functions shaped like `app.submit_inspection`); Go adds four thin `ManageAssets`-gated endpoints on the ADR-0013 pattern; the web adds a Tyres section beside Units. TYRE-92/93/94 are a follow-on plan once this lands — the vocabulary must be frozen by real code first (docs/implementation-order.md §B5).

**Tech Stack:** PostgreSQL 16 migrations (golang-migrate), Go `net/http`+chi+pgx, React+Vite+Tanstack Query, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-b5-tyre-register-design.md` — read it first; every decision below cites it.

## Global Constraints

- Branch `TYRE-91-tyre-register`, cut from `develop`. Conventional commits with the ticket key. Rebase, never merge.
- `make db-reset && make db-test` for every suite change — a bare `db-test` on a warm DB skips guarded sections (docs/lessons.md:183). Run as `app_login`, never superuser.
- Money is `numeric` in SQL, string on the wire (`"4319.91"`), never a JSON number or Go float.
- `tenant_id` always from `app.current_tenant_id()`, never the request (ADR-0013 d.2).
- Handlers gate with `require(a, auth.ManageAssets)`, never a role name (ADR-0011).
- New tables: `CALL app.enable_tenant_rls(...)` + add to the isolation sweep array in `db/tests/004_tests.sql` + grants matching the idiom of `000012`'s new tables.
- New suite sections are `BEGIN;`…`ROLLBACK;`-wrapped, numbered 36+, appended before the final `ALL CHECKS PASSED` echo, styled on sections 32/33.
- **TY009 gets NO `submitStatus` entry in this slice** — no HTTP path reaches it until TYRE-92 (ADR-0012 deferral; spec D5).
- Never name any of this "Configuration" — the Fleet vocabulary is Units · Tyres · Rigs · Fitments (reconciliation §3).
- Never edit a merged migration; new numbers start at `000028`.
- `TODO` requires a ticket ID on the same line; comments say *why* (docs/comments.md).
- White-box `package httpapi` test files must alias testify's `require` import (docs/lessons.md:164).
- The e2e spec writes rows: `chromium` project only, **Sandbox Fleet tenant (`33333333-…`) only, never BAC**.

---

### Task 1: Migration 000028 — TYRE-88 trigger hardening

**Files:**
- Create: `db/migrations/000028_harden_history_triggers.up.sql`, `.down.sql`
- Test: `db/tests/004_tests.sql` (new section 36, inserted before the final `ALL CHECKS PASSED` echo at the end of the file)

**Interfaces:**
- Consumes: `app.reject_configuration_change_with_history()` (000024), `app.require_odometer_where_unit_has_one()` (000025) — both replaced with `CREATE OR REPLACE`.
- Produces: TY008 now also refuses known→different `unit_kind` with history; TY009 passes the legacy-NULL-odometer UPDATE gate. Later tasks (and TYRE-92) rely on these exact semantics.

- [ ] **Step 1: Write failing suite section 36**

Append before the final `\echo '================  ALL CHECKS PASSED  ================'`:

```sql
\echo '== 36. TYRE-88: history triggers pass backfill and legacy rows, refuse edits (TY008/TY009)'
BEGIN;
DO $$
DECLARE cfg uuid; pos uuid; veh uuid := md5('t88veh')::uuid; veh2 uuid := md5('t88veh2')::uuid;
        fit uuid := md5('t88fit')::uuid; t1 uuid := md5('t88tyre1')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  SELECT id INTO pos FROM app.position WHERE configuration_id = cfg ORDER BY id LIMIT 1;

  -- A unit of unknown kind takes an odometer-less fitment (legal, CHG-027)...
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, status)
  VALUES (veh, '11111111-1111-1111-1111-111111111111', 'T88-1', 'T88 GP', cfg, 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T88TYRE1', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at)
  VALUES (fit, '11111111-1111-1111-1111-111111111111', t1, veh, pos, now() - interval '30 days');

  -- ...then its kind is backfilled to HORSE with history present (must pass)...
  UPDATE app.vehicle SET unit_kind = 'HORSE' WHERE id = veh;

  -- (a) the legacy NULL-odometer fitment can still be closed
  UPDATE app.fitment SET removed_at = now(), removed_odometer = 120000,
         removed_tread_mm = 9.0, removal_reason = 'WORN'
   WHERE id = fit;
  RAISE NOTICE 'PASS  36a legacy NULL-odometer fitment closed on a HORSE';

  -- (b) an UPDATE cannot null out a supplied fitted_odometer — proven on a
  -- fitment this section creates, so the probe cannot silently match nothing
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (veh2, '11111111-1111-1111-1111-111111111111', 'T88-2', 'T88B GP', cfg, 'HORSE', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (md5('t88tyre2')::uuid, '11111111-1111-1111-1111-111111111111', 'T88TYRE2', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at, fitted_odometer)
  VALUES (md5('t88fit2')::uuid, '11111111-1111-1111-1111-111111111111',
          md5('t88tyre2')::uuid, veh2, pos, now(), 100000);
  BEGIN
    UPDATE app.fitment SET fitted_odometer = NULL WHERE id = md5('t88fit2')::uuid;
    RAISE EXCEPTION 'FAIL: nulling a fitted_odometer was accepted';
  EXCEPTION WHEN sqlstate 'TY009' THEN RAISE NOTICE 'PASS  36b nulling fitted_odometer refused';
  END;

  -- (c) a vehicle repoint does not ride the legacy gate out of TY009
  BEGIN
    UPDATE app.fitment SET vehicle_id = veh2 WHERE id = fit;
    RAISE EXCEPTION 'FAIL: repointing a NULL-odometer fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY009' THEN RAISE NOTICE 'PASS  36c repoint refused';
  END;

  -- (d) known-to-different unit_kind with history raises; the NULL backfill above passed
  BEGIN
    UPDATE app.vehicle SET unit_kind = 'RIGID' WHERE id = veh;
    RAISE EXCEPTION 'FAIL: unit_kind edit with history was accepted';
  EXCEPTION WHEN sqlstate 'TY008' THEN RAISE NOTICE 'PASS  36d unit_kind edit refused with history';
  END;
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run to verify it fails.** `make db-reset && make db-test` → expect FAIL at 36a (closing the fitment trips TY009's fitted leg) — proving the defect before the fix.
- [ ] **Step 3: Write the migration.** `000028_harden_history_triggers.up.sql` — `CREATE OR REPLACE` both functions. Preserve 000024/000025's header rationale comments, amending rather than deleting; both files' comment style is the house reference.

```sql
-- TY009, second cut (TYRE-88 defect 1). The fitted-odometer leg must not
-- re-fire on the UPDATE of a fitment that was legitimately created without
-- one — a NULL-kind unit later backfilled to HORSE (CHG-027), or any
-- pre-000025 legacy row — or such fitments can never be closed. The gate is
-- exactly the ticket's: TG_OP = 'UPDATE' AND OLD.fitted_odometer IS NULL AND
-- NEW.vehicle_id = OLD.vehicle_id. Not a bare INSERT gate (it would re-break
-- the backfill), and not a bare OLD-is-NULL pass (a repoint must not escape).
CREATE OR REPLACE FUNCTION app.require_odometer_where_unit_has_one()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE k app.unit_kind;
BEGIN
  SELECT v.unit_kind INTO k FROM app.vehicle v
   WHERE v.id = NEW.vehicle_id AND v.tenant_id = NEW.tenant_id;

  IF k IS NULL OR k = 'TRAILER' THEN
    RETURN NEW;
  END IF;

  IF NEW.fitted_odometer IS NULL
     AND NOT (TG_OP = 'UPDATE'
              AND OLD.fitted_odometer IS NULL
              AND NEW.vehicle_id = OLD.vehicle_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at fitment; only a trailer, or a unit of unknown kind, may omit it';
  END IF;

  IF NEW.removed_at IS NOT NULL AND NEW.removed_odometer IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY009',
      MESSAGE = 'fitment odometer is required for a unit that has one',
      HINT    = 'record the reading shown on this unit at removal; without it the distance this tyre ran is unrecoverable';
  END IF;

  RETURN NEW;
END $$;

-- TY008 widens to unit_kind (TYRE-88 defect 2): editing the kind of a unit
-- with history retroactively changes what recorded MEASURED distances meant
-- and what TY009 enforces. A NULL kind may be backfilled once — that is
-- CHG-027's legitimate path and the very one that makes defect 1's rows —
-- but any change FROM a known kind is refused, including to NULL: allowing
-- known→NULL would let two legal steps launder the edit the rule refuses.
-- That last clause exceeds TYRE-88's literal wording (which names only
-- known→known); the PR body states the strengthening and this comment is
-- its rationale. The EXISTS fold is the ticket's cosmetic rider.
CREATE OR REPLACE FUNCTION app.reject_configuration_change_with_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF NEW.configuration_id IS NOT DISTINCT FROM OLD.configuration_id
     AND (OLD.unit_kind IS NULL OR NEW.unit_kind IS NOT DISTINCT FROM OLD.unit_kind) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM app.fitment    f WHERE f.vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM app.inspection i WHERE i.vehicle_id = OLD.id)
     OR EXISTS (SELECT 1 FROM app.reading    r WHERE r.vehicle_id = OLD.id) THEN
    IF NEW.configuration_id IS DISTINCT FROM OLD.configuration_id THEN
      RAISE EXCEPTION USING
        ERRCODE  = 'TY008',
        MESSAGE  = 'axle configuration cannot change once the unit has history',
        HINT     = 'correct a wrong configuration by retiring the unit and re-adding it, or by a dated migration that moves the history with it — never by an edit';
    END IF;
    RAISE EXCEPTION USING
      ERRCODE  = 'TY008',
      MESSAGE  = 'unit kind cannot change once the unit has history',
      HINT     = 'a NULL kind may be backfilled once; correcting a known kind is a retire-and-re-add (D11(ii))';
  END IF;

  RETURN NEW;
END $$;

-- TYRE-88 defect 3: name the legacy rows the new gate grandfathers, in the
-- 000011 RAISE WARNING idiom — visibility, not enforcement.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT f.id, v.fleet_number, v.unit_kind
      FROM app.fitment f
      JOIN app.vehicle v ON v.id = f.vehicle_id AND v.tenant_id = f.tenant_id
     WHERE v.unit_kind IN ('HORSE','RIGID','LIGHT') AND f.fitted_odometer IS NULL
  LOOP
    RAISE WARNING 'fitment % on unit % (%) has no fitted_odometer; its distance will be UNAVAILABLE (TYRE-88)',
      r.id, r.fleet_number, r.unit_kind;
  END LOOP;
END $$;
```

The `.down.sql` restores both function bodies verbatim from `000024_configuration_immutable_with_history.up.sql:22-45` and `000025_fitment_odometer_by_unit_kind.up.sql:19-52` (copy them, do not retype).

- [ ] **Step 4: Run to verify it passes.** `make db-reset && make db-test` → section 36 all PASS, sections 32–34 still green (DoD item e).
- [ ] **Step 5: Comment style + commit.** `node scripts/check-comment-style.mjs db/migrations/000028_harden_history_triggers.up.sql db/migrations/000028_harden_history_triggers.down.sql` (explicit paths — untracked files are invisible to the no-arg run, docs/lessons.md:200). Then:

```bash
git add db/migrations/000028_* db/tests/004_tests.sql
git commit -m "fix(db): TYRE-88 harden the TY008/TY009 triggers for backfill and legacy rows"
```

---

### Task 2: TYRE-87 — the tenant-key sweep

**Files:**
- Test: `db/tests/004_tests.sql` (new section 37, after 36)
- Create (only if the probe or the disposition rules demand re-keys): `db/migrations/000029_tenant_first_unique_keys.up.sql`, `.down.sql`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a suite section that fails on any future unique/exclusion key or unique index omitting a leading `tenant_id`; Task 3's new table must satisfy it.

- [ ] **Step 1: Write the failing sweep as section 37**

```sql
\echo '== 37. TYRE-87: unique/exclusion keys on tenant tables lead with tenant_id'
BEGIN;
DO $$
DECLARE bad text;
BEGIN
  -- The generalisation of B1's cross-tenant date oracle: a unique or
  -- exclusion check whose key omits tenant_id fires before RLS and before
  -- the composite FK, so its distinguishable error discloses another
  -- tenant's values to a caller who chose the probe value. PKs are excluded
  -- (opaque uuids; and every PK index carries a pg_constraint row the second
  -- arm skips). The allowlist names each deliberate exception and why.
  WITH tenant_tables AS (
    SELECT c.oid, c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'app' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  ),
  keys AS (
    SELECT t.relname AS tbl, con.conname AS keyname,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.attnum = con.conkey[1]) AS first_col
      FROM pg_constraint con JOIN tenant_tables t ON t.oid = con.conrelid
     WHERE con.contype IN ('u','x')
    UNION ALL
    -- Standalone unique indexes with no pg_constraint row — the three-of-seven
    -- blind spot the ticket names. indkey[0] = 0 (an expression) yields NULL
    -- and is treated as an offender unless allowlisted.
    SELECT t.relname, ic.relname,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.attnum = i.indkey[0])
      FROM pg_index i
      JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN tenant_tables t ON t.oid = i.indrelid
     WHERE i.indisunique
       AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conindid = i.indexrelid)
  )
  SELECT string_agg(tbl || '.' || keyname, ', ') INTO bad
    FROM keys
   WHERE first_col IS DISTINCT FROM 'tenant_id'
     AND keyname NOT IN (
       -- Allowlist. Every entry states its reason; an unexplained entry is a
       -- review defect.
       'app_user_platform_admin_email_key'  -- 000026: PLATFORM_ADMIN rows are tenant-free by design; unreachable by app_rw (PR #29 RLS audit: informational)
     );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: unique/exclusion keys not led by tenant_id: %', bad;
  END IF;
  RAISE NOTICE 'PASS  37 every tenant-table unique/exclusion key leads with tenant_id or is allowlisted';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run and record the offenders.** `make db-reset && make db-test` → expect FAIL listing the real names (the ticket counts seven; the allowlist name above is a guess to be corrected from this output). Copy the list into the task's commit message body.
- [ ] **Step 3: Probe `valuation_snapshot` empirically (the ticket's DoD).** With `make db-up` running, as `app_login` via the compose psql idiom the Makefile uses: set `app.tenant_id` to tenant 2, and `INSERT INTO app.valuation_snapshot` naming a tenant-1 tyre uuid (`md5('scrapprobe')` exists only transiently — use a uuid from `SELECT id FROM app.tyre LIMIT 1` run as tenant 1) and an `as_at` you first confirmed exists for tenant 1. Record which error comes back: `23505` (unique fired first — **oracle confirmed**, re-key) vs `23503`/RLS refusal (FK or policy first — record disposition as informational). Paste the observed SQLSTATE into the migration or allowlist comment.
- [ ] **Step 4: Disposition each offender.** Rule (spec D9): a key containing a **caller-chosen natural value** (dates, codes, numbers) is re-keyed tenant-first in `000029_tenant_first_unique_keys.up.sql` (`DROP INDEX`/`ADD CONSTRAINT` pairs recreating each with `tenant_id` leading; down.sql restores the originals); a key over opaque uuids alone, or serving a deliberately tenant-free rule, is allowlisted with its reason. Re-run step 2's grep of Go for any re-keyed name — a renamed schema object orphans every Go string naming it (docs/lessons.md:34); `conflictCodes` keys are the known risk surface.
- [ ] **Step 5: Run to verify green.** `make db-reset && make db-test` → 37 PASS; `TestConflictCodesNameLiveSchemaObjects` still green via `make test`.
- [ ] **Step 6: Commit.**

```bash
git add db/tests/004_tests.sql db/migrations/000029_* 2>/dev/null; git add db/tests/004_tests.sql
git commit -m "feat(db): TYRE-87 sweep unique and exclusion keys for a missing tenant_id"
```

---

### Task 3: Migration 000030 — D12/D13 schema, the event vocabulary, seeds

**Files:**
- Create: `db/migrations/000030_display_code_policy_and_vocabulary.up.sql`, `.down.sql`
- Modify: `db/seeds/gen_seed_configurations.py` (tenant policies + counters), `db/tests/004_tests.sql` (fixture `'SCRAP'` → `'SCRAPPED'` at the section-20 probe near line 1511; isolation sweep array + new section 38)

**Interfaces:**
- Consumes: Task 2's sweep (the new counter table's PK leads with `tenant_id` and must pass it).
- Produces: `app.display_code_policy` enum + `tenant.display_code_policy`; `app.display_code_counter (tenant_id, prefix, next_number)`; `app.mount_orientation` enum + `fitment.mount_orientation`; `tyre_event` CHECKs `tyre_event_type_in_vocabulary`, `state_change_carries_to_state`, `sold_carries_proceeds`. Task 4's functions and Task 8's endpoints depend on all of these names exactly.

- [ ] **Step 1: Edit the fixture first.** In `db/tests/004_tests.sql`, change the section-20 probe's event insert `'SCRAP'` → `'SCRAPPED'` (one occurrence; `rg "'SCRAP'" db/tests` must then be empty). It predates the vocabulary and would fail the new CHECK.
- [ ] **Step 2: Write failing section 38**

```sql
\echo '== 38. D12/D13 schema and the TYRE-48 event vocabulary (CHG-023/CHG-037, FR-TYR-004 as amended)'
BEGIN;
DO $$
DECLARE t1 uuid := md5('t48tyre')::uuid;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T48TYRE', 'NEW', 'IN_STOCK');

  -- The vocabulary is closed
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'REBALANCED', now(), 'IN_STOCK');
    RAISE EXCEPTION 'FAIL: an off-vocabulary event type was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38a vocabulary is closed';
  END;

  -- A state-changing event must say what state it produced, or
  -- app.tyre_in_estate_asof (000016) cannot see it
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SCRAPPED', now());
    RAISE EXCEPTION 'FAIL: a SCRAPPED event with no to_state was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38b state changes carry to_state';
  END;

  -- Only a sale carries proceeds, and a sale must (CHG-037, FR-FIT-023)
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, from_state, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SOLD', now(), 'REMOVED', 'SOLD');
    RAISE EXCEPTION 'FAIL: a SOLD event with no proceeds was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  38c a sale records proceeds';
  END;

  -- D12: policies are seeded as decided — BAC and Sandbox generate, and a
  -- FREE tenant exists so both branches stay provable (tenant 2)
  IF (SELECT display_code_policy FROM app.tenant
       WHERE id = '11111111-1111-1111-1111-111111111111') <> 'GENERATED' THEN
    RAISE EXCEPTION 'FAIL: BAC is not GENERATED (D12)';
  END IF;
  RAISE NOTICE 'PASS  38d display_code_policy seeded per D12';

  -- D13: the column exists, defaulted UNKNOWN, and is not yet load-bearing
  IF (SELECT count(*) FROM app.fitment WHERE mount_orientation <> 'UNKNOWN') <> 0 THEN
    RAISE EXCEPTION 'FAIL: mount_orientation carries a value nothing has written';
  END IF;
  RAISE NOTICE 'PASS  38e mount_orientation defaults UNKNOWN (D13)';
END $$;
ROLLBACK;
```

- [ ] **Step 3: Run to verify it fails** (`make db-reset && make db-test` — 38a errors because the CHECK does not exist yet).
- [ ] **Step 4: Write the migration**

```sql
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
```

Before committing, confirm the grant idiom against what `000012` does for its new tables and match it exactly; if `enable_tenant_rls`'s procedure already handles grants, drop the GRANT line. The `.down.sql` drops the three constraints, the two columns, the table and the two types, in reverse order.

- [ ] **Step 5: Seeds.** In `gen_seed_configurations.py`, extend the tenant insert (generator line ~39) to name the new column — BAC `GENERATED`, Second Fleet `FREE` (the live FREE tenant the suite uses), Sandbox `GENERATED` (the DoD's refusal proof runs on Sandbox; BAC rows are the acceptance fixture) — and append counter rows:

```python
L.append("INSERT INTO app.tenant (id,name,subdomain,state,display_code_policy) VALUES")
L.append("  ('11111111-1111-1111-1111-111111111111','BAC Transport','bac','ACTIVE','GENERATED'),")
L.append("  ('22222222-2222-2222-2222-222222222222','Second Fleet (isolation control)','other','ACTIVE','FREE'),")
L.append("  ('33333333-3333-3333-3333-333333333333','Sandbox Fleet','sandbox','ACTIVE','GENERATED');")
L.append("INSERT INTO app.display_code_counter (tenant_id,prefix) VALUES")
L.append("  ('11111111-1111-1111-1111-111111111111','BAC'),")
L.append("  ('33333333-3333-3333-3333-333333333333','SBX');")
```

(Adapt to the file's actual structure — the tenant insert exists; replace it rather than duplicating it. Change the generator, never the generated SQL.)

- [ ] **Step 6: Isolation sweep.** Add `'display_code_counter'` to the sweep array in `db/tests/004_tests.sql` (the array `enable_tenant_rls` demands; find it with `rg -n "sweep" db/tests/004_tests.sql`).
- [ ] **Step 7: Run to verify green.** `make db-reset && make db-test` → 38 PASS, section 37's sweep PASS over the new table, everything else green.
- [ ] **Step 8: Comment style on both new files (explicit paths), then commit.**

```bash
git add db/migrations/000030_* db/seeds/gen_seed_configurations.py db/tests/004_tests.sql
git commit -m "feat(db): TYRE-91 D12 display-code policy, D13 mount orientation, TYRE-48 vocabulary"
```

---

### Task 4: Migration 000031 — the lifecycle functions

**Files:**
- Create: `db/migrations/000031_tyre_lifecycle_functions.up.sql`, `.down.sql`
- Test: `db/tests/004_tests.sql` (new section 39)

**Interfaces:**
- Consumes: Task 3's schema, `app.rand_per_mm(numeric,numeric,numeric)` and `app.current_removal_threshold_mm()` (000001/000006), `app.tenant_today` (TYRE-89's migrations — **verify its exact signature with `\df app.tenant_today` before writing**), `v_tyre_awaiting_cost` (000012:505 — confirm its id column name by reading the view first).
- Produces, for Task 8's handlers to call verbatim:
  - `app.receive_tyres(payload jsonb) RETURNS TABLE (tyre_id uuid, display_code text)` — payload keys `quantity, display_code, size_id, brand_id, pattern_id, purchase_date, purchase_price, cost_source, new_tread_mm, received_date, depot_id` (snake_case; Go authors it).
  - `app.set_tyre_cost(p_tyre uuid, p_price numeric, p_source app.cost_source) RETURNS void`
  - `app.dispose_tyre(p_tyre uuid, p_disposal app.tyre_state, p_reason text, p_proceeds numeric, p_occurred timestamptz) RETURNS void`
  - `app.tyre_for_code(p_code text, p_on date) RETURNS SETOF uuid`
  - New SQLSTATEs **TY011** (display-code policy), **TY012** (invalid lifecycle transition / unknown tyre), **TY013** (cost entry refused).

- [ ] **Step 1: Write failing section 39.** Transaction-wrapped; models on section 33 (creates its own rows). Assertions, each in the `BEGIN…EXCEPTION WHEN sqlstate` idiom of section 36:

```sql
\echo '== 39. Tyre lifecycle: receive, cost, dispose, dated lookup (TYRE-48/91, FR-TYR-040..043, D12)'
BEGIN;
DO $$
DECLARE r record; a uuid; b uuid; c uuid; n int; rate numeric;
BEGIN
  -- BAC is GENERATED (D12): a hand-typed code is refused, an issued one is
  -- sequential from the counter
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    PERFORM app.receive_tyres('{"display_code":"HAND-1"}'::jsonb);
    RAISE EXCEPTION 'FAIL: hand-typed code accepted under GENERATED';
  EXCEPTION WHEN sqlstate 'TY011' THEN RAISE NOTICE 'PASS  39a hand-typed code refused (D12)';
  END;

  SELECT * INTO r FROM app.receive_tyres('{"new_tread_mm":"25.0"}'::jsonb);
  a := r.tyre_id;
  IF r.display_code !~ '^BAC-\d{5}$' THEN
    RAISE EXCEPTION 'FAIL: issued code % is not the ADR-0008 scheme', r.display_code;
  END IF;
  RAISE NOTICE 'PASS  39b generated code issued: %', r.display_code;

  -- Unpriced receipt sits in the awaiting-cost queue (FR-TYR-041) with no
  -- invented rate; costing it computes rand_per_mm through the one permitted
  -- implementation (rule: check 7 pins the arithmetic, this pins the wiring)
  SELECT count(*) INTO n FROM app.v_tyre_awaiting_cost WHERE id = a;  -- adjust column to the view's actual name
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: unpriced tyre not in awaiting-cost queue'; END IF;
  PERFORM app.set_tyre_cost(a, 4319.91, 'INVOICE');
  SELECT rand_per_mm INTO rate FROM app.tyre WHERE id = a;
  IF rate IS DISTINCT FROM app.rand_per_mm(4319.91, 25.0, app.current_removal_threshold_mm()) THEN
    RAISE EXCEPTION 'FAIL: costing did not recompute rand_per_mm through app.rand_per_mm';
  END IF;
  RAISE NOTICE 'PASS  39c awaiting-cost discharged, rate recomputed: %', rate;
  BEGIN
    PERFORM app.set_tyre_cost(a, 1.00, 'INVOICE');
    RAISE EXCEPTION 'FAIL: a second costing was accepted';
  EXCEPTION WHEN sqlstate 'TY013' THEN RAISE NOTICE 'PASS  39d re-pricing refused';
  END;

  -- Bulk issue is sequential and atomic
  SELECT count(DISTINCT display_code) INTO n FROM app.receive_tyres('{"quantity":3}'::jsonb);
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL: bulk receive issued % codes, expected 3', n; END IF;
  RAISE NOTICE 'PASS  39e bulk receive issues distinct sequential codes';

  -- Disposal transitions (Appendix C): SOLD from REMOVED only; a scrap
  -- carries its reason; a sale its proceeds; events append with to_state so
  -- app.tyre_in_estate_asof sees them
  BEGIN
    PERFORM app.dispose_tyre(a, 'SOLD', NULL, 100.00, now());
    RAISE EXCEPTION 'FAIL: sale from IN_STOCK accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39f REMOVED→SOLD only';
  END;
  BEGIN
    PERFORM app.dispose_tyre(a, 'SCRAPPED', NULL, NULL, now());
    RAISE EXCEPTION 'FAIL: scrap without reason accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39g a scrap records its reason';
  END;
  PERFORM app.dispose_tyre(a, 'SCRAPPED', 'sidewall breach', NULL, now());
  IF (SELECT state FROM app.tyre WHERE id = a) <> 'SCRAPPED'
     OR NOT EXISTS (SELECT 1 FROM app.tyre_event
                     WHERE tyre_id = a AND type = 'SCRAPPED' AND to_state = 'SCRAPPED') THEN
    RAISE EXCEPTION 'FAIL: scrap did not move state and event together';
  END IF;
  IF app.tyre_in_estate_asof(a, current_date + 1) THEN
    RAISE EXCEPTION 'FAIL: a scrapped tyre is still in the estate as-of tomorrow';
  END IF;
  RAISE NOTICE 'PASS  39h disposal appends the event, moves the state, leaves the estate';

  -- FREE tenant (2): the code is the tenant''s own, required, and reusable
  -- across history with the dated lookup resolving by date (FR-TYR-042)
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  BEGIN
    PERFORM app.receive_tyres('{}'::jsonb);
    RAISE EXCEPTION 'FAIL: FREE receive without a code accepted';
  EXCEPTION WHEN sqlstate 'TY011' THEN RAISE NOTICE 'PASS  39i FREE requires the tenant''s code';
  END;
  SELECT tyre_id INTO b FROM app.receive_tyres('{"display_code":"CA123-11","received_date":"2026-01-10"}'::jsonb);
  BEGIN
    PERFORM app.receive_tyres('{"display_code":"CA123-11"}'::jsonb);
    RAISE EXCEPTION 'FAIL: second active tyre with the same code accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS  39j duplicate active code refused by the DB';
  END;
  PERFORM app.dispose_tyre(b, 'SCRAPPED', 'worn out', NULL, '2026-06-01T08:00:00Z');
  SELECT tyre_id INTO c FROM app.receive_tyres('{"display_code":"CA123-11","received_date":"2026-06-15"}'::jsonb);
  IF (SELECT app.tyre_for_code('CA123-11', '2026-03-01')) IS DISTINCT FROM b
     OR (SELECT app.tyre_for_code('CA123-11', '2026-07-01')) IS DISTINCT FROM c THEN
    RAISE EXCEPTION 'FAIL: dated code lookup did not resolve historical reuse';
  END IF;
  RAISE NOTICE 'PASS  39k code lookup resolves by date across reuse';

  -- Cross-tenant: tenant 2 disposing tenant 1''s tyre finds nothing to
  -- dispose — RLS makes another tenant''s uuid indistinguishable from a
  -- missing one, which is the point
  BEGIN
    PERFORM app.dispose_tyre(md5('t48tyre')::uuid, 'LOST', NULL, NULL, now());
    RAISE EXCEPTION 'FAIL: cross-tenant disposal was accepted';
  EXCEPTION WHEN sqlstate 'TY012' THEN RAISE NOTICE 'PASS  39l cross-tenant tyre invisible to disposal';
  END;
END $$;
ROLLBACK;
```

(39l's uuid must be one that exists in tenant 1 outside this section's rollback — use a seeded tyre id from `003_seed_fixture.sql` instead if `md5('t48tyre')` only exists inside section 38's rolled-back transaction; pick with `SELECT id FROM app.tyre LIMIT 1` as tenant 1 while writing the section.)

- [ ] **Step 2: Run to verify it fails** (`make db-reset && make db-test` — 39a errors: function does not exist).
- [ ] **Step 3: Write the migration.** All functions `SECURITY INVOKER` (the default — they run as `app_rw` under the caller's RLS; say so in the header comment, since `refresh_governing_tread` is the schema's one DEFINER exception). Full bodies:

```sql
-- ============================================================================
--  Tyre lifecycle: receive, cost, dispose, dated code lookup (TYRE-48/91)
--  Implements: FR-TYR-040/041/042, FR-TYR-002, FR-TYR-010, FR-FIT-023,
--  CHG-023/CHG-037 remainders, D12; ADR-0013 decision 1 (a write with a rule
--  of its own is a SQL function, shaped like app.submit_inspection)
-- ============================================================================
-- SQLSTATEs (all ours; the TY class forwards verbatim, ADR-0012):
--   TY011 — display-code policy refusal (D12)
--   TY012 — invalid lifecycle transition, or a tyre this tenant cannot see
--   TY013 — cost entry refused (already recorded, or not a valid amount)

CREATE FUNCTION app.receive_tyres(payload jsonb)
RETURNS TABLE (tyre_id uuid, display_code text)
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE
  pol   app.display_code_policy;
  qty   int  := COALESCE((payload->>'quantity')::int, 1);
  hand  text := NULLIF(btrim(COALESCE(payload->>'display_code','')), '');
  price numeric(12,2) := (payload->>'purchase_price')::numeric;
  tread numeric(4,1)  := (payload->>'new_tread_mm')::numeric;
  src   app.cost_source := COALESCE(payload->>'cost_source',
                                    CASE WHEN payload->>'purchase_price' IS NULL
                                         THEN 'UNKNOWN' ELSE 'INVOICE' END)::app.cost_source;
  rcv   date;
  code  text;
  new_id uuid;
BEGIN
  -- Defaulted server-side to the tenant's calendar day, never the caller's
  -- (rule 6; B4.5's from_date precedent).
  rcv := COALESCE((payload->>'received_date')::date,
                  app.tenant_today((SELECT timezone FROM app.tenant
                                     WHERE id = app.current_tenant_id())));

  SELECT t.display_code_policy INTO pol
    FROM app.tenant t WHERE t.id = app.current_tenant_id();

  IF qty < 1 OR qty > 200 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a receive is between 1 and 200 tyres';
  END IF;
  IF pol = 'GENERATED' AND hand IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'this fleet''s display codes are issued by the platform; leave the code blank and the next one is assigned',
      HINT    = 'D12: under a generated scheme a hand-typed code is refused, never merely warned about';
  END IF;
  IF pol = 'FREE' AND hand IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'this fleet brands its own tyres; enter the code branded on the sidewall';
  END IF;
  IF hand IS NOT NULL AND qty > 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY011',
      MESSAGE = 'a hand-typed display code names one tyre; bulk receives use issued codes';
  END IF;

  FOR i IN 1..qty LOOP
    IF pol = 'GENERATED' THEN
      -- The counter row lock is the concurrency story: two receives
      -- serialise here rather than minting one code twice.
      UPDATE app.display_code_counter c
         SET next_number = c.next_number + 1
       WHERE c.tenant_id = app.current_tenant_id()
       RETURNING c.prefix || '-' || lpad((c.next_number - 1)::text, 5, '0') INTO code;
      IF NOT FOUND THEN
        -- A configuration fault, not a client mistake: an honest 500.
        RAISE EXCEPTION 'display_code_counter has no row for this tenant; seed one before receiving under GENERATED';
      END IF;
    ELSE
      code := hand;
    END IF;

    INSERT INTO app.tyre (tenant_id, display_code, size_id, brand_id, pattern_id,
                          status, retread_count, purchase_date, purchase_price,
                          cost_source, new_tread_mm, rand_per_mm, state,
                          current_depot_id, received_date)
    VALUES (app.current_tenant_id(), code,
            (payload->>'size_id')::uuid, (payload->>'brand_id')::uuid,
            (payload->>'pattern_id')::uuid, 'NEW', 0,
            (payload->>'purchase_date')::date, price, src, tread,
            app.rand_per_mm(price, tread, app.current_removal_threshold_mm()),
            'IN_STOCK', (payload->>'depot_id')::uuid, rcv)
    RETURNING id INTO new_id;

    -- The vocabulary's first writer (TYRE-48): receipt is the point a tyre
    -- becomes trackable (FR-TYR-040), and branding is a dated event so the
    -- code resolves by date across reuse (FR-TYR-042, ADR-0008 rule 2).
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES (app.current_tenant_id(), new_id, 'RECEIVED', rcv::timestamptz, 'IN_STOCK');
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, payload)
    VALUES (app.current_tenant_id(), new_id, 'BRANDED', rcv::timestamptz,
            jsonb_build_object('display_code', code));

    tyre_id := new_id; display_code := code;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION app.set_tyre_cost(p_tyre uuid, p_price numeric, p_source app.cost_source)
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE cur numeric;
BEGIN
  SELECT purchase_price INTO cur FROM app.tyre WHERE id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  IF cur IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013',
      MESSAGE = 'this tyre''s cost is already recorded',
      HINT    = 'a correction is a decision this surface does not take; raise it against TYRE-48';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION USING ERRCODE = 'TY013', MESSAGE = 'a cost is a non-negative amount';
  END IF;
  -- No event: cost entry is provenance, not a lifecycle transition. The rate
  -- goes through the one permitted implementation (db/CLAUDE.md, FR-VAL-006).
  UPDATE app.tyre
     SET purchase_price = p_price, cost_source = p_source,
         rand_per_mm = app.rand_per_mm(p_price, new_tread_mm, app.current_removal_threshold_mm())
   WHERE id = p_tyre;
END $$;

CREATE FUNCTION app.dispose_tyre(p_tyre uuid, p_disposal app.tyre_state,
                                 p_reason text, p_proceeds numeric,
                                 p_occurred timestamptz DEFAULT now())
RETURNS void
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
DECLARE cur app.tyre_state; why text := NULLIF(btrim(COALESCE(p_reason,'')), '');
BEGIN
  IF p_disposal NOT IN ('SCRAPPED','SOLD','LOST') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = 'a disposal is SCRAPPED, SOLD or LOST';
  END IF;
  -- FOR UPDATE: state and event must move together, and a concurrent
  -- disposal must see this one's state, not race it.
  SELECT state INTO cur FROM app.tyre WHERE id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    -- RLS makes another tenant's uuid indistinguishable from a missing one;
    -- one message for both is the non-oracle answer.
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
  IF p_disposal = 'SOLD' AND cur <> 'REMOVED' THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('a tyre is sold from REMOVED only; this one is %s (Appendix C)', cur);
  END IF;
  IF p_disposal IN ('SCRAPPED','LOST') AND cur NOT IN ('IN_STOCK','REMOVED') THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012',
      MESSAGE = format('this tyre is %s; close its fitment or log its retread return first', cur),
      HINT    = 'the rejected-casing scrap belongs to Log Retread (TYRE-93), not here';
  END IF;
  IF p_disposal = 'SCRAPPED' AND why IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'a scrap records its reason';
  END IF;
  IF p_disposal = 'SOLD' AND p_proceeds IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'a sale records its proceeds (FR-FIT-023)';
  END IF;
  IF p_disposal <> 'SOLD' AND p_proceeds IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'only a sale carries proceeds';
  END IF;

  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at,
                              from_state, to_state, reason, proceeds)
  VALUES (app.current_tenant_id(), p_tyre, p_disposal::text, p_occurred,
          cur, p_disposal, why, p_proceeds);
  UPDATE app.tyre SET state = p_disposal WHERE id = p_tyre;
END $$;

-- FR-TYR-042: a code resolves to the tyre carrying it ON THAT DATE. The
-- governing brand per tyre is its latest BRANDED event on or before the
-- date — but a disposed tyre is never re-branded, so its latest event
-- matches forever; "carrying the code" therefore also means being in the
-- estate on that date (app.tyre_in_estate_asof, 000016): the scrapped
-- tyre's sidewall may still read the code, but it is not in the fleet to
-- be found. Historical reuse then returns the right tyre per date, and two
-- ACTIVE matches return two rows for a human to resolve — never fewer
-- (FR-TYR-043, ADR-0008 rule 3).
CREATE FUNCTION app.tyre_for_code(p_code text, p_on date)
RETURNS SETOF uuid
LANGUAGE sql STABLE
SET search_path = app, pg_temp AS $$
  SELECT latest.tyre_id FROM (
    SELECT DISTINCT ON (e.tyre_id) e.tyre_id, e.payload->>'display_code' AS code
      FROM app.tyre_event e
     WHERE e.type = 'BRANDED' AND e.occurred_at::date <= p_on
     ORDER BY e.tyre_id, e.occurred_at DESC
  ) latest
  WHERE latest.code = p_code
    AND app.tyre_in_estate_asof(latest.tyre_id, p_on);
$$;
```

The `.down.sql` drops the four functions. Before running: verify `app.tenant_today`'s signature (`\df app.tenant_today` via the Makefile's psql idiom) and `v_tyre_awaiting_cost`'s id column (read `000012` around line 505); adjust the two call sites and section 39c to match what is actually there.

- [ ] **Step 4: Run to verify green.** `make db-reset && make db-test` — section 39 all PASS, **check 7's Appendix E pins and check 17/18 untouched and green**.
- [ ] **Step 5: Comment style (explicit paths) + commit.**

```bash
git add db/migrations/000031_* db/tests/004_tests.sql
git commit -m "feat(db): TYRE-48 TYRE-91 lifecycle functions freeze the event vocabulary"
```

---

### Task 5: RLS audit of the batch's schema

- [ ] **Step 1:** Dispatch the **rls-auditor** agent over migrations `000028`–`000031`, the seed generator change, and the sweep section — its proactive trigger is exactly this (new tenant column, new table, re-keyed constraints).
- [ ] **Step 2:** Fix anything it confirms (a PLAUSIBLE-only finding is verified against the actual files first, per superpowers:receiving-code-review); re-run `make db-reset && make db-test`; commit fixes as `fix(db): TYRE-91 <finding>`.

---

### Task 6: `GET /api/me` carries the display-code policy

**Files:**
- Modify: `api/internal/httpapi/httpapi.go:421-457` (the `me` handler and `meJSON`)
- Test: `api/internal/httpapi/httpapi_test.go`

**Interfaces:**
- Produces: `meJSON.DisplayCodePolicy string \`json:"displayCodePolicy"\`` — `"FREE"` or `"GENERATED"`; Task 9's `Me` type mirrors it.

- [ ] **Step 1: Write the failing test** — extend the existing `GET /api/me` test (find it with `rg -n "api/me" api/internal/httpapi/*_test.go`) to assert `displayCodePolicy == "GENERATED"` for a BAC actor.
- [ ] **Step 2: Run** (`make test` or the package's focused `go test` via the Makefile's docker idiom) → FAIL.
- [ ] **Step 3: Implement** — add the field to `meJSON` and widen the tenant query in place:

```go
if err := tx.QueryRow(ctx,
        `SELECT timezone, display_code_policy FROM app.tenant WHERE id = app.current_tenant_id()`).
        Scan(&body.Timezone, &body.DisplayCodePolicy); err != nil {
        return fmt.Errorf("reading tenant timezone and display-code policy: %w", err)
}
```

- [ ] **Step 4: Run to verify green, then commit** `feat(api): TYRE-91 /api/me carries the tenant display-code policy`.

---

### Task 7: `GET /api/tyres` — the register read

**Files:**
- Create: `api/internal/httpapi/tyres.go`, `api/internal/httpapi/tyres_test.go`
- Modify: `api/internal/httpapi/httpapi.go:112` area (route registration)

**Interfaces:**
- Consumes: `withActor`, `require`, `writeJSON`, `auth.ManageAssets`, `auth.ViewValuation`, `app.tyre_for_code` (Task 4).
- Produces: `tyreJSON{ID, DisplayCode, State, Status, RetreadCount, SizeName, BrandName, PatternName, ReceivedDate *string, AwaitingCost bool, PurchasePrice, RandPerMm, CasingValue *string}` (money fields `*string` + `omitempty`); `func tyreJSONFor(row tyreRow, canSeeMoney bool) tyreJSON` — Task 10's wire type mirrors it.

- [ ] **Step 1: Failing tests** in `tyres_test.go`, table-driven on the B4 pattern (`admin_test.go` is the model): a DRIVER gets 403; a CONTROLLER lists only their tenant's tyres; `?code=&on=` resolves through the dated lookup; `?awaitingCost=true` filters. Unit-test `tyreJSONFor` both ways — every role that can reach the endpoint holds `ViewValuation` today, so the hidden branch is only reachable as a unit test; say that in a comment (FR-AUT-005a is why the projection exists anyway).
- [ ] **Step 2: Run** → FAIL (handler undefined).
- [ ] **Step 3: Implement** `listTyres`:

```go
func listTyres(s *store.Store) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
                ctx := r.Context()
                q := r.URL.Query()
                code, on := q.Get("code"), q.Get("on")
                awaitingOnly := q.Get("awaitingCost") == "true"
                if (code == "") != (on == "") {
                        writeError(ctx, w, http.StatusBadRequest, codeBadRequest,
                                "a code lookup names both code and on (FR-TYR-042 resolves by date)")
                        return
                }

                var out []tyreJSON
                ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
                        if err := require(a, auth.ManageAssets); err != nil {
                                return err
                        }
                        // Money leaves the server only for a holder of ViewValuation
                        // (FR-AUT-005a, NFR-SEC-006): projected out here, never
                        // filtered client-side.
                        canSeeMoney := a.Can(auth.ViewValuation)
                        sql := `SELECT t.id, t.display_code, t.state::text, t.status::text,
                                       t.retread_count, s.name, b.name, p.name,
                                       t.received_date::text, (t.purchase_price IS NULL),
                                       t.purchase_price::text, t.rand_per_mm::text, t.casing_value::text
                                  FROM app.tyre t
                                  LEFT JOIN app.tyre_size    s ON s.id = t.size_id
                                  LEFT JOIN app.tyre_brand   b ON b.id = t.brand_id
                                  LEFT JOIN app.tyre_pattern p ON p.id = t.pattern_id`
                        var args []any
                        switch {
                        case code != "":
                                sql += ` WHERE t.id IN (SELECT app.tyre_for_code($1, $2::date))`
                                args = append(args, code, on)
                        case awaitingOnly:
                                sql += ` WHERE t.id IN (SELECT id FROM app.v_tyre_awaiting_cost)`
                        }
                        sql += ` ORDER BY t.received_date DESC NULLS LAST, t.display_code`
                        rows, err := tx.Query(ctx, sql, args...)
                        if err != nil {
                                return fmt.Errorf("listing tyres: %w", err)
                        }
                        defer rows.Close()
                        out = []tyreJSON{}
                        for rows.Next() {
                                var row tyreRow
                                if err := rows.Scan(&row.id, &row.displayCode, &row.state, &row.status,
                                        &row.retreadCount, &row.sizeName, &row.brandName, &row.patternName,
                                        &row.receivedDate, &row.awaitingCost,
                                        &row.purchasePrice, &row.randPerMm, &row.casingValue); err != nil {
                                        return fmt.Errorf("scanning tyre: %w", err)
                                }
                                out = append(out, tyreJSONFor(row, canSeeMoney))
                        }
                        return rows.Err()
                })
                if !ok {
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                writeJSON(ctx, w, map[string]any{"tyres": out})
        }
}
```

with `tyreRow` holding nullable columns as `*string`, and `tyreJSONFor` copying everything and nilling the three money fields when `!canSeeMoney`. Adjust the `v_tyre_awaiting_cost` column name to what Task 4 confirmed. Register `r.Get("/tyres", listTyres(s))` beside the other reads.

- [ ] **Step 4: Run to verify green** (`make test`), **Step 5: commit** `feat(api): TYRE-91 tyre register read with dated code lookup`.

---

### Task 8: The register's write endpoints and refusal vocabulary

**Files:**
- Modify: `api/internal/httpapi/tyres.go` (three handlers), `api/internal/httpapi/httpapi.go` (routes; codes `:187-206`; messages `:213-227`; `submitStatus :229-259`; `conflictCodes :280-291`; `conflictMessages :293-298`)
- Test: `api/internal/httpapi/tyres_test.go`

**Interfaces:**
- Consumes: Task 4's functions, verbatim signatures.
- Produces: `POST /api/tyres` (201 `{"tyres":[{"id","displayCode"}]}`), `POST /api/tyres/{tyreID}/cost`, `POST /api/tyres/{tyreID}/dispose` (both 204); wire codes `TY011`/`TY012`/`TY013` (messages forwarded verbatim — TY class) and `display_code_taken`.

- [ ] **Step 1: Failing tests.** Per write path: the happy path; the capability 403; **the cross-tenant probe** — for these endpoints the tenant comes only from the session, so the B4 `TestWriteAimedAtAnotherTenantIsRefused` shape becomes: a tenant-2 actor naming a tenant-1 tyre id gets 422 `TY012` "no such tyre in this fleet" (RLS invisibility, not disclosure). Plus: BAC actor sending `displayCode` → 422 `TY011` with the SQL function's own message intact; tenant-2 actor omitting it → 422 `TY011`; double-receive of one FREE code → 409 `display_code_taken`; sale from `IN_STOCK` → 422 `TY012`; cost twice → 422 `TY013`. Remember the `require` alias (lessons.md:164) if any test is white-box.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Requests validate **shape only** before any transaction (ADR-0013 d.5) — uuids parse, quantity 1..200, strings trimmed via the existing `text()` helper; every rule stays in SQL. The receive handler marshals the snake_case payload and reads the set-returning function:

```go
type receiveTyresRequest struct {
        Quantity      int     `json:"quantity"`
        DisplayCode   *string `json:"displayCode"`
        SizeID        *string `json:"sizeId"`
        BrandID       *string `json:"brandId"`
        PatternID     *string `json:"patternId"`
        PurchaseDate  *string `json:"purchaseDate"`
        PurchasePrice *string `json:"purchasePrice"` // money stays a string end to end
        CostSource    *string `json:"costSource"`
        NewTreadMm    *string `json:"newTreadMm"`
        ReceivedDate  *string `json:"receivedDate"`
        DepotID       *string `json:"depotId"`
}
```

`receiveTyres` builds `map[string]any{"quantity": qty, "display_code": ..., ...}` (omitting nils), `json.Marshal`s it, then inside `withActor` + `require(a, auth.ManageAssets)`:

```go
rows, err := tx.Query(ctx, `SELECT tyre_id, display_code FROM app.receive_tyres($1::jsonb)`, payload)
```

collecting `{ID, DisplayCode}` pairs; 201 with `{"tyres": [...]}`. The two action handlers share one shape — uuid from the path, refused before any transaction if unparseable, then one `tx.Exec` on the function:

```go
func setTyreCost(s *store.Store) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
                ctx := r.Context()
                tyreID, err := uuid.Parse(chi.URLParam(r, "tyreID"))
                if err != nil {
                        writeError(ctx, w, http.StatusUnprocessableEntity, codeInvalidSubmission, msgInvalidSubmission)
                        return
                }
                var body struct {
                        Price  string `json:"price"` // money stays a string; the DB casts and refuses
                        Source string `json:"source"`
                }
                if !decodeJSON(w, r, &body) {
                        return
                }
                ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
                        if err := require(a, auth.ManageAssets); err != nil {
                                return err
                        }
                        if _, err := tx.Exec(ctx,
                                `SELECT app.set_tyre_cost($1, $2::numeric, $3::app.cost_source)`,
                                tyreID, body.Price, body.Source); err != nil {
                                return fmt.Errorf("costing tyre %s: %w", tyreID, err)
                        }
                        return nil
                })
                if !ok {
                        return
                }
                w.WriteHeader(http.StatusNoContent)
        }
}

func disposeTyre(s *store.Store) http.HandlerFunc {
        return func(w http.ResponseWriter, r *http.Request) {
                ctx := r.Context()
                tyreID, err := uuid.Parse(chi.URLParam(r, "tyreID"))
                if err != nil {
                        writeError(ctx, w, http.StatusUnprocessableEntity, codeInvalidSubmission, msgInvalidSubmission)
                        return
                }
                var body struct {
                        Disposal string  `json:"disposal"`
                        Reason   *string `json:"reason"`
                        Proceeds *string `json:"proceeds"`
                }
                if !decodeJSON(w, r, &body) {
                        return
                }
                ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
                        if err := require(a, auth.ManageAssets); err != nil {
                                return err
                        }
                        // Every rule — the transition table, reason, proceeds — is
                        // app.dispose_tyre's; its TY012 arrives via refusalForPgError
                        // with the message intact (ADR-0013 d.5).
                        if _, err := tx.Exec(ctx,
                                `SELECT app.dispose_tyre($1, $2::app.tyre_state, $3, $4::numeric, now())`,
                                tyreID, body.Disposal, body.Reason, body.Proceeds); err != nil {
                                return fmt.Errorf("disposing tyre %s: %w", tyreID, err)
                        }
                        return nil
                })
                if !ok {
                        return
                }
                w.WriteHeader(http.StatusNoContent)
        }
}
```

Vocabulary edits in `httpapi.go`:

```go
codeDisplayCodeTaken = "display_code_taken"
msgDisplayCodeTaken  = "an active tyre already carries that display code; two active tyres may never share one (FR-TYR-004/DR-002)"
```

`submitStatus` gains — with this comment, which is the ADR-0012 deferral's third and final re-statement:

```go
// TY011/TY012/TY013 are the tyre lifecycle's refusals (000031). TY009 is
// still deliberately absent: TYRE-92 writes the first fitment and adds it
// with a test that can fail; an entry now could not be exercised (ADR-0012).
"TY011": http.StatusUnprocessableEntity,
"TY012": http.StatusUnprocessableEntity,
"TY013": http.StatusUnprocessableEntity,
```

`conflictCodes` gains `"one_active_display_code_per_tenant": codeDisplayCodeTaken` (index name from `000011:49`; `TestConflictCodesNameLiveSchemaObjects` verifies it against the live schema for free) and `conflictMessages` its message. Routes:

```go
r.Post("/tyres", receiveTyres(s))
r.Post("/tyres/{tyreID}/cost", setTyreCost(s))
r.Post("/tyres/{tyreID}/dispose", disposeTyre(s))
```

- [ ] **Step 4: Run to verify green** (`make test` — including the conflict-codes schema test), **Step 5: commit** `feat(api): TYRE-91 receive, cost and dispose endpoints on the lifecycle functions`.

---

### Task 9: Web wire layer

**Files:**
- Create: `web/src/api/tyres.ts`, `web/src/api/tyres.test.ts`
- Modify: `web/src/auth/me.ts` (add `displayCodePolicy: string` with a D12 comment; kept `string` not a union, same deploy-ordering rationale as capabilities)

**Interfaces:**
- Consumes: `apiGet`/`apiPost` from `web/src/api/client.ts` (they stamp dev headers and throw `ApiError{status, message, code}`).
- Produces, for Tasks 10–12:

```ts
export interface Tyre {
  id: string; displayCode: string; state: string; status: string;
  retreadCount: number;
  sizeName: string | null; brandName: string | null; patternName: string | null;
  receivedDate: string | null; awaitingCost: boolean;
  // Present only when the actor holds ViewValuation — the server projects,
  // the client merely tolerates absence. Money stays a string (web/CLAUDE.md).
  purchasePrice?: string; randPerMm?: string; casingValue?: string;
}
export interface ReceivedTyre { id: string; displayCode: string }
export interface NewTyres {
  quantity?: number; displayCode?: string; sizeId?: string; brandId?: string;
  patternId?: string; purchasePrice?: string; costSource?: string;
  newTreadMm?: string; receivedDate?: string; depotId?: string;
}
export type Disposal = "SCRAPPED" | "SOLD" | "LOST";
export function fetchTyres(opts?: { code?: string; on?: string; awaitingCost?: boolean }): Promise<Tyre[]>;
export function receiveTyres(body: NewTyres): Promise<ReceivedTyre[]>;
export function setTyreCost(tyreId: string, body: { price: string; source: string }): Promise<void>;
export function disposeTyre(tyreId: string, body: { disposal: Disposal; reason?: string; proceeds?: string }): Promise<void>;
```

- [ ] **Step 1: Failing vitest** per function (msw-free fetch stubs, same style as `web/src/api/admin.test.ts` — read it first and copy its harness), asserting URLs/query strings, the unwrap of `{tyres: [...]}`, and that an `ApiError`'s `message` and `code` survive.
- [ ] **Step 2: Run** `make web-test` → FAIL. **Step 3: implement.** **Step 4: green.** **Step 5: commit** `feat(web): TYRE-91 tyre register api module and display-code policy on Me`.

---

### Task 10: The Tyres screen

**Files:**
- Create: `web/src/fleet/TyreList.tsx`, `web/src/fleet/TyreList.test.tsx`

**Interfaces:**
- Consumes: Task 9's module; `useTenantDate` (`web/src/time/tenantTime.ts` — the ONLY date path; the eslint ban is active); `useCan("ViewValuation")` for column presence; `getDevTenantId` for the query key (`["tyres", tenantKey, filters]`, `AddUnit.tsx`'s idiom).
- Produces: `<TyreList />` — routed in Task 12.

- [ ] **Step 1: Failing component tests:** renders register rows (natural-order sort by `displayCode`, NFR-USE-012 — reuse the comparator `VehicleList` uses if one exists, else `localeCompare` with `numeric: true`); an awaiting-cost filter toggle; a code+date lookup form that shows **all** matches with an explicit "two tyres carried this code — resolve by eye, the system never guesses" note when >1 (FR-TYR-043); a dispose flow per row (disposal select, reason input shown for SCRAPPED, proceeds input shown for SOLD, submit) whose refusal renders the server's own TY011/TY012 message via a `refusalMessage` helper with a `speakable` allow-list (`AddUnit.tsx:22-33` is the model; include `display_code_taken`, `TY011`, `TY012`, `TY013`, `invalid_submission`, `conflict`); money columns absent without `ViewValuation`; `role="alert"` + Retry on query error.
- [ ] **Step 2: Run** → FAIL. **Step 3: implement** (Tanstack `useQuery` for the list, `useMutation` + query invalidation for dispose; `<section aria-labelledby>` per house pattern; no hex literals — tokens only). **Step 4: green** (`make web-test`). **Step 5: commit** `feat(web): TYRE-91 tyre register screen with dated lookup and disposal`.

---

### Task 11: The receive screen

**Files:**
- Create: `web/src/fleet/ReceiveTyre.tsx`, `web/src/fleet/ReceiveTyre.test.tsx`

**Interfaces:**
- Consumes: Task 9's module; `useActor()` for `displayCodePolicy`.
- Produces: `<ReceiveTyre />` — routed in Task 12.

- [ ] **Step 1: Failing tests:** under `GENERATED` the code field is **absent** and a quantity field (1–200, default 1) is present, with copy telling the operator codes are issued ("the platform assigns the next code — mark the sidewall with the code shown after saving": AS-014 is load-bearing, the screen says the workshop step out loud); under `FREE` the code field is present and required, no quantity; price optional with an "add to awaiting-cost queue" hint when blank, `costSource` select (`INVOICE`/`PRICE_LIST_ESTIMATE`) shown only when a price is entered; success shows the issued codes explicitly (NFR-USE-010) and clears the form; refusals through the same `speakable` pattern; the form never `Number()`s the price — it stays a string.
- [ ] **Step 2: Run** → FAIL. **Step 3: implement.** **Step 4: green.** **Step 5: commit** `feat(web): TYRE-91 receive-into-fleet screen honours the display-code policy`.

---

### Task 12: Routes and navigation

**Files:**
- Modify: `web/src/routes.tsx`, `web/src/shell/navigation.ts`
- Test: `web/src/routes.test.tsx`, `web/src/shell/navigation.test.ts`

- [ ] **Step 1: Failing tests:** nav for a CONTROLLER shows **Units** (`/fleet` — relabelled from "Vehicles"; reconciliation §3's vocabulary, and the note on TYRE-68's navigation) and **Tyres** (`/fleet/tyres`, `ManageAssets`); a DRIVER sees neither; `/fleet/tyres` and `/fleet/tyres/new` render `TyreList`/`ReceiveTyre` behind `AdminRoute capability="ManageAssets"` and explain the refusal to a navigated-to visitor.
- [ ] **Step 2: Run** → FAIL. **Step 3: implement:**

```ts
{ to: "/fleet", label: "Units", capability: "ViewFleet" },
// Rigs and Fitments join this row when TYRE-72/92 build them — no stubs; a
// menu item that 404s is worse than an absent one.
{ to: "/fleet/tyres", label: "Tyres", capability: "ManageAssets" },
```

and the two routes in `routes.tsx` on the `AdminRoute` pattern (`:83-98`). Check for other user-visible "Vehicles" copy the relabel should carry (`rg -n '"Vehicles"' web/src`); update `VehicleList`'s heading only if it says "Vehicles" — the reconciliation's word is Units.

- [ ] **Step 4: green** (`make web-test` **and** `make lint` — vitest says nothing about eslint, lessons.md:80). **Step 5: commit** `feat(web): TYRE-91 Tyres joins Units under the fleet vocabulary`.

---

### Task 13: End-to-end proof

**Files:**
- Create: `web/e2e/tyres.spec.ts`
- Modify: `web/playwright.config.ts` (add `tyres.spec` to the `android` and `ios` projects' `testIgnore` — the spec writes rows, so it runs on `chromium` alone, the `admin.spec.ts` precedent)

- [ ] **Step 1: Write the spec** using `actAsOrgAdmin` from `web/e2e/admin.ts` **pointed at Sandbox Fleet** (Sandbox is `GENERATED` with prefix `SBX`; BAC is the acceptance fixture and is never written): receive one tyre without a price → the issued `SBX-…` code is shown; the register lists it flagged awaiting cost; set its cost; receive attempt with a hand-typed code shows the TY011 message; scrap it with a reason and see it leave the active register. Assert on roles and visible text, per web/CLAUDE.md.
- [ ] **Step 2: Run** `make api-run` in one terminal, `make e2e` in another → all specs green (the reseed is not optional). Fix, rerun.
- [ ] **Step 3: Commit** `test(e2e): TYRE-91 an admin receives, costs and scraps a tyre on Sandbox`.

---

### Task 14: Close-out

- [ ] **Step 1: The D12 SRS erratum row** — prepared here, pasted by hand into the SRS errata table in Confluence (pages exceed the MCP's limits; **TYRE-91's DoD blocks on the paste**, memory: srs-errata-are-manual):

> **FR-TYR-004** (D12, 30 Aug 2026): "The platform imposes no display-code format and warns, never blocks, on an unusual code — *unless the tenant has opted into a generated scheme* (`display_code_policy = GENERATED`), in which case the platform issues the code and a hand-typed one is refused." **§5.1**: `tenant` gains `display_code_policy` (`FREE` | `GENERATED`, default `FREE`); BAC is `GENERATED` for the pilot.

- [ ] **Step 2: Docs.** Update `docs/implementation-order.md`'s B5 section: slice 1 delivered (keys, migrations 000028–000031, new suite sections 36–39), slice 2 (TYRE-92+93, TYRE-94) is next and discharges TY009's deferral. Do **not** close TYRE-48 (its retread paths are slice 2's); move TYRE-88 and TYRE-87 to Done on the board with their evidence; TYRE-91 goes Done only after the erratum paste.
- [ ] **Step 3: Comment audit.** Run the `/comment-audit` skill over the branch.
- [ ] **Step 4: Full verification.** `make check` (runs db-reset + suite + api + web + lint in CI's order) and `make e2e`, both green, output read not assumed (superpowers:verification-before-completion).
- [ ] **Step 5: Final review.** Whole-branch review pass (superpowers:requesting-code-review); fix confirmed findings; then rebase onto `develop` and hand the branch to the user for the GitHub-web merge (memory: merges-via-github-web-ui — never merge locally). PR body must state: the known→NULL `unit_kind` strengthening beyond TYRE-88's wording; TY009's continued absence from `submitStatus` and why; the TYRE-87 offender dispositions with the probe's observed SQLSTATE.

---

## Self-review notes (already applied)

- Spec coverage: every D1–D9 decision in the spec maps to a task (D1/D2→3, D3/D4→3, D5→4/8, D6→7/8, D7→10–12, D8→1, D9→2); the three non-ticket deliverables land in Tasks 12 (nav) and 14 (erratum; the TYRE-48 comment already exists — verified 2026-09-01).
- Known verify-before-use points are called out inline rather than guessed: `app.tenant_today`'s signature, `v_tyre_awaiting_cost`'s column, the seed generator's exact line shape, the allowlist's real constraint names, section 39l's fixture uuid. Each has a step that resolves it against the live schema before the code runs.
- Type consistency: `receive_tyres` payload keys are snake_case at the SQL boundary and camelCase on the HTTP wire; `tyreJSONFor(row, canSeeMoney)` is named identically in Tasks 7 and 10's consumption notes.
