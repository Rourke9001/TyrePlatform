# B5 slice 2 — Fitment Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver B5's second slice — TYRE-92's fitment surface (fit, remove, rotate, dispatch, return, with D13's mount orientation and D14's no-move rule), TYRE-93's Log Retread propagation and cap, TYRE-94's unit edit and status transitions — end to end from SQL through Go to the unit's plan view, closing TYRE-48 and discharging TY009's wire entry.

**Architecture:** Every business rule is SQL (a fitment-immutability trigger, six lifecycle functions shaped like slice 1's, an audit trigger recorded by ADR-0014); Go adds thin capability-gated endpoints on the ADR-0013 pattern plus the PATCH plumbing nothing had needed; the web gains a data-driven unit screen that replaces the decorative axle schematic, a fitments list, a retread queue, and two register actions, sharing one form-mutation hook. TY008 stays out of the wire map permanently, recorded in code.

**Tech Stack:** PostgreSQL 16 migrations (golang-migrate), Go `net/http`+chi+pgx, React+Vite+Tanstack Query, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-b5-fitment-surface-design.md` — read it first, including its "Decisions taken without the owner" table (U1–U10); every task below cites it.

## Global Constraints

- Branch `TYRE-92-fitment-surface`, cut from `develop` @ `ff1744e` or later. Conventional commits with the ticket key of the task (TYRE-92, TYRE-93 or TYRE-94; ADR and plumbing commits use TYRE-92). Rebase, never merge.
- `make db-reset && make db-test` for every suite change — a bare `db-test` on a warm DB skips guarded sections (docs/lessons.md 2026-08-27). Run as `app_login`, never superuser. New suite sections are `BEGIN;`…`ROLLBACK;`-wrapped, numbered **40–43**, appended before the final `ALL CHECKS PASSED` echo (`db/tests/004_tests.sql:4066`), styled on section 39 (`:3855`), with **no existence guards and no assertion inside a guard** (lessons 2026-09-01).
- Never edit a merged migration; new numbers are **000032–000035**. New SQLSTATEs are **TY014** (fitment write refused), **TY015** (retread cap), **TY016** (unit status transition refused). TY012 keeps its slice-1 meaning: an illegal lifecycle transition or an id this tenant cannot see.
- Money is `numeric` in SQL, string on the wire, never a JSON number or Go float. `rand_per_mm` is computed only by `app.rand_per_mm(...)`, with the cost assigned into a `numeric(12,2)` local first (lesson 2026-09-01).
- Event instants: never a bare date cast, and user-supplied dates bounded against `app.tenant_today(tz)` (lesson 2026-09-01). A date-driven instant is `now()` when the date is the tenant's today and `least(date::timestamp AT TIME ZONE tz, now())` — tenant-local midnight — for an earlier one, and is refused with TY012 when it would fall before the tyre's latest `to_state` event rather than clamped to it (corrected 2026-09-02, Task 3; see the spec's D2 correction note).
- `tenant_id` always from `app.current_tenant_id()`, never the request (ADR-0013 d.2). Handlers gate with `require(a, auth.X)`, never a role name (ADR-0011).
- Cross-tenant proof, by write kind: a **raw-insert RLS probe** (`TestWriteAimedAtAnotherTenantIsRefused_*`, asserts SQLSTATE `42501`, admin_test.go:170's shape) for direct inserts (`vehicle_tag_map`, `app.fitment`); a **handler-level invisibility probe** (`Test*CrossTenantIsInvisible`, asserts 422 + the function's pinned not-found message, tyres_test.go:561's shape) for every function-backed write. Every SQL not-found message is distinct per object so a probe can pin it, and every SQL section's cross-tenant probe has a second independent probe through a different function (lesson 2026-09-01).
- White-box `package httpapi` test files alias testify's `require` import (docs/lessons.md 2026-08-28).
- Any migration that names, renames or replaces a schema object: `rg` the Go tree for the old string before calling it done (lesson 2026-09-01); `TestConflictCodesNameLiveSchemaObjects` must stay green.
- Never name any of this "Configuration"; the Fleet vocabulary is **Units · Tyres · Fitments** (Rigs in B6). Dates render only through `useTenantDate`/`formatTenantDate`.
- A CSS class rename is a two-file edit; screenshot any screen whose stylesheet or `className` changes before and after (lesson 2026-09-01).
- The e2e spec writes rows: `chromium` project only, **Sandbox Fleet (`33333333-3333-3333-3333-333333333333`) only, never BAC**.
- `TODO` requires a ticket ID on the same line; comments say *why* (docs/comments.md). Run `/comment-audit` at close-out.
- Run `make check` at the end of every task, not only the test you touched.

## File map

| Area | Create | Modify | Delete |
|---|---|---|---|
| ADR | `docs/adr/0014-audit-mechanism.md` | | |
| DB | `db/migrations/000032_fitment_written_once.{up,down}.sql`, `000033_fitment_functions.{up,down}.sql`, `000034_log_retread_return.{up,down}.sql`, `000035_vehicle_status_and_audit.{up,down}.sql` | `db/seeds/gen_seed_configurations.py` (removal_reasons), `db/seeds/gen_seed_fixture.py` (Sandbox depots), `db/tests/004_tests.sql` (sections 40–43) | |
| Go | `api/internal/httpapi/units.go`, `units_test.go`, `fitments.go`, `fitments_test.go`, `retreads.go`, `retreads_test.go` | `httpapi.go` (router, `submitStatus`, `conflictCodes`, `pathID`), `admin.go` (`maxWriteBytes`), `tyres.go` (named structs, `pathID`, dispatch/return handlers), `tyres_test.go`, `httpapi_test.go` (`patch` helper), `capture.go` (`pathID`) | |
| Web api | `web/src/api/units.ts`, `units.test.ts`, `retreads.ts`, `retreads.test.ts` | `client.ts` (`apiPatch`), `client.test.ts`, `tyres.ts` (dispatch/return/open fitments) | |
| Web fleet | `web/src/fleet/useFormMutation.ts`, `useFormMutation.test.tsx`, `fleet/tyres/{TyreList,DisposeForm,CostForm,DispatchForm,ReturnToStockButton}.tsx` + tests, `fleet/unit/{UnitDetail,UnitPlan,PositionPanel,RotateForm,UnitEditForm,UnitStatusForm,FitmentHistory}.tsx` + tests, `fleet/FitmentList.tsx` + test, `fleet/RetreadQueue.tsx` + test | `dashboard/VehicleList.tsx` (links, copy), `routes.tsx`, `shell/navigation.ts`, `fleet.css` | `fleet/TyreList.tsx` (moved), `dashboard/AxleSchematic.tsx` |
| e2e | `web/e2e/fitments.spec.ts` | | |
| Docs | | `docs/implementation-order.md`, `docs/lessons.md` (only if a lesson is earned) | |

---

### Task 1: ADR-0014 — how mutations are audited

**Files:**
- Create: `docs/adr/0014-audit-mechanism.md`
- Reference: `docs/adr/0000-template.md`, `docs/adr/0013-write-surface-contract.md` (house style), `db/migrations/000001_init.up.sql:502-515` (`app.audit_log`), `db/migrations/000017_audit_columns_dr013.up.sql:319-330`

**Interfaces:**
- Produces: the decision Task 5's trigger implements — function name `app.audit_row_change()`, trigger name pattern `<table>_audited`, `AFTER INSERT OR UPDATE FOR EACH ROW`, columns written.

- [ ] **Step 1: Verify the premise before writing.** Run `rg -n "audit_log" db/migrations db/seeds api` and confirm no `INSERT INTO app.audit_log` exists anywhere. Record the command and its empty result in the ADR's Context.
- [ ] **Step 2: Write the ADR** from the template. Required content:
  - **Context:** FR-AUD-001 ("an immutable audit entry for every creation, modification and deletion of any persisted record"); `app.audit_log` exists since 000001, append-only (000001:585), RLS-swept (000001:546), no writer; TYRE-94 is the first write surface whose ticket names audit (AUD-001 → FR-AUD-001).
  - **Options:** A — Go writes an audit row per handler (rejected: every handler re-implements it, and SQL-function writes have no Go hook per column). B — one generic row trigger per audited table (chosen). C — logical decoding / CDC (rejected for the POC: infrastructure the pilot does not have).
  - **Decision:** `app.audit_row_change()` (`LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = app, pg_temp`) writes `(tenant_id = NEW.tenant_id, actor_id = app.current_actor_id(), action = TG_OP, entity_type = TG_TABLE_NAME, entity_id = NEW.id, before = to_jsonb(OLD) or NULL on INSERT, after = to_jsonb(NEW))`. Attached `AFTER INSERT OR UPDATE FOR EACH ROW` as `<table>_audited`. `app.vehicle` in this slice; the tables that should follow — `app.tyre`, `app.fitment`, `app.retread_job`, `app.app_user`, `app.vehicle_driver`, `app.threshold_policy`, `app.configuration` — are listed under Consequences with "raised as TYRE-NN at close-out" (Task 17 fills the number).
  - **Consequences:** Good — seed-loaded and suite-planted rows get an INSERT audit row with a NULL actor ("loaded, not acted") because `app.current_actor_id()` returns NULL when unbound (000001:32); state this as intended, not incidental. Bad — `before`/`after` carry every column including PII on `app_user` when it follows (NFR-PRV-004's 84-month rule then applies to audit rows too; say so). Revisit when — a table's row is large enough that full-row jsonb per update is a storage concern, or when CDC infrastructure arrives.
- [ ] **Step 3: Comment-style check.** Run `node scripts/check-comment-style.mjs` (or `make lint`) — ADRs are prose but the hook runs on the tree.
- [ ] **Step 4: Commit.**

```bash
git add docs/adr/0014-audit-mechanism.md
git commit -m "docs(adr): TYRE-94 ADR-0014 how mutations are audited"
```

---

### Task 2: Migration 000032 — fitment written once, one vocabulary value, removal reasons, Sandbox depots

**Files:**
- Create: `db/migrations/000032_fitment_written_once.up.sql`, `.down.sql`
- Modify: `db/seeds/gen_seed_configurations.py:60-79` (add `removal_reasons`), `db/seeds/gen_seed_fixture.py:97` (two Sandbox depots)
- Test: `db/tests/004_tests.sql` — new section 40

**Interfaces:**
- Consumes: `app.fitment` columns as of 000030; triggers `fitment_odometer_matches_unit_kind` (000025/000028) and `fitment_stamps_updated` (000017); CHECK `tyre_event_type_in_vocabulary` (000030:49).
- Produces: trigger `fitment_written_once` raising **TY014**; vocabulary value `SENT_TO_BREAKDOWN_SUPPLIER`; configuration key `removal_reasons` on every seeded tenant; Sandbox depots `md5('sbretreader1')` (type `RETREADER`, name `Sandbox Retreaders`) and `md5('sbbreakdown1')` (type `BREAKDOWN_SUPPLIER`, name `Sandbox Roadside`).

- [ ] **Step 1: Write failing suite section 40.** Append before the final `ALL CHECKS PASSED` echo:

```sql
\echo '== 40. TYRE-92: a fitment is written once and closed once (TY014); the vocabulary carries the breakdown dispatch'
BEGIN;
DO $$
DECLARE cfg uuid; pos uuid; pos2 uuid; veh uuid := md5('t40veh')::uuid;
        t1 uuid := md5('t40tyre1')::uuid; fit uuid := md5('t40fit')::uuid; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT configuration_id INTO cfg FROM app.vehicle WHERE id = md5('veh1')::uuid;
  SELECT id INTO pos  FROM app.position WHERE configuration_id = cfg ORDER BY sequence LIMIT 1;
  SELECT id INTO pos2 FROM app.position WHERE configuration_id = cfg ORDER BY sequence OFFSET 1 LIMIT 1;
  INSERT INTO app.vehicle (id, tenant_id, fleet_number, registration, configuration_id, unit_kind, status)
  VALUES (veh, '11111111-1111-1111-1111-111111111111', 'T40-1', 'T40 GP', cfg, 'TRAILER', 'ACTIVE');
  INSERT INTO app.tyre (id, tenant_id, display_code, status, state)
  VALUES (t1, '11111111-1111-1111-1111-111111111111', 'T40TYRE1', 'NEW', 'IN_STOCK');
  INSERT INTO app.fitment (id, tenant_id, tyre_id, vehicle_id, position_id, fitted_at, mount_orientation)
  VALUES (fit, '11111111-1111-1111-1111-111111111111', t1, veh, pos, now() - interval '10 days', 'MARK_OUTBOARD');

  -- (a) an identity column cannot change on an open fitment
  BEGIN
    UPDATE app.fitment SET position_id = pos2 WHERE id = fit;
    RAISE EXCEPTION 'FAIL: repositioning an open fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40a open fitment identity is immutable';
  END;
  -- (b) nor can the orientation (a flip is a remove-and-fit, D13)
  BEGIN
    UPDATE app.fitment SET mount_orientation = 'MARK_INBOARD' WHERE id = fit;
    RAISE EXCEPTION 'FAIL: flipping an open fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40b mount_orientation is immutable';
  END;
  -- (c) closure is the one permitted UPDATE, and it stamps updated_at
  UPDATE app.fitment SET removed_at = now(), removed_tread_mm = 9.0, removal_reason = 'damage',
         distance_source = 'UNAVAILABLE' WHERE id = fit;
  SELECT count(*) INTO n FROM app.fitment WHERE id = fit AND removed_at IS NOT NULL AND updated_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: closure did not land'; END IF;
  RAISE NOTICE 'PASS  40c closure is permitted';
  -- (d) a closed fitment is frozen entirely, even its closure columns
  BEGIN
    UPDATE app.fitment SET removal_reason = 'worn_to_threshold' WHERE id = fit;
    RAISE EXCEPTION 'FAIL: editing a closed fitment was accepted';
  EXCEPTION WHEN sqlstate 'TY014' THEN RAISE NOTICE 'PASS  40d closed fitment is frozen';
  END;
  -- (e) the vocabulary accepts the breakdown dispatch and still refuses a stranger
  INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
  VALUES ('11111111-1111-1111-1111-111111111111', t1, 'SENT_TO_BREAKDOWN_SUPPLIER', now(), 'AT_BREAKDOWN_SUPPLIER');
  BEGIN
    INSERT INTO app.tyre_event (tenant_id, tyre_id, type, occurred_at, to_state)
    VALUES ('11111111-1111-1111-1111-111111111111', t1, 'REBALANCED', now(), 'FITTED');
    RAISE EXCEPTION 'FAIL: REBALANCED accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS  40e vocabulary gained exactly the breakdown dispatch';
  END;
  -- (f) every seeded tenant carries removal_reasons with the FR-FIT-008 minimum
  SELECT count(*) INTO n FROM app.configuration
   WHERE key = 'removal_reasons' AND value ? 'worn_to_threshold' AND value ? 'rotation' AND value ? 'correction';
  IF n < 1 THEN RAISE EXCEPTION 'FAIL: removal_reasons not seeded for this tenant'; END IF;
  RAISE NOTICE 'PASS  40f removal_reasons is tenant configuration';
END $$;
ROLLBACK;
```

- [ ] **Step 2: Run to verify it fails.** `make db-reset && make db-test` → FAIL at 40a (the UPDATE is accepted).
- [ ] **Step 3: Write the migration.**

```sql
-- 000032: a fitment is written once and closed once (rule 3, FR-FIT-014).
--
-- app.fitment is not in the append-only grant set: closing a fitment IS an
-- UPDATE of its removed_* columns, so UPDATE stays granted (000001) and only
-- DELETE is revoked (000018). Nothing, until now, stopped an UPDATE of the
-- identity columns or a second closure. This trigger permits exactly one
-- shape of UPDATE — an open row gaining its closure — and refuses the rest
-- with TY014. Corrections are compensating events (FR-FIT-015, CR-004).
--
-- The trigger's NAME is load-bearing: BEFORE triggers on one table fire in
-- name order, and fitment_odometer_matches_unit_kind (TY009) must keep
-- firing first so suite section 36 keeps its SQLSTATEs; fitment_stamps_updated
-- writes updated_at/updated_by on every UPDATE, which is why those two
-- columns are excluded from the comparison rather than relying on order.
CREATE FUNCTION app.fitment_is_written_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY014',
      MESSAGE = 'a closed fitment cannot be changed',
      HINT    = 'record a compensating event instead (FR-FIT-015)';
  END IF;
  IF NEW.tyre_id           IS DISTINCT FROM OLD.tyre_id
  OR NEW.vehicle_id        IS DISTINCT FROM OLD.vehicle_id
  OR NEW.position_id       IS DISTINCT FROM OLD.position_id
  OR NEW.fitted_at         IS DISTINCT FROM OLD.fitted_at
  OR NEW.fitted_odometer   IS DISTINCT FROM OLD.fitted_odometer
  OR NEW.fitted_tread_mm   IS DISTINCT FROM OLD.fitted_tread_mm
  OR NEW.mount_orientation IS DISTINCT FROM OLD.mount_orientation
  OR NEW.tenant_id         IS DISTINCT FROM OLD.tenant_id
  OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  OR NEW.created_by        IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TY014',
      MESSAGE = 'an open fitment can only be closed, never edited',
      HINT    = 'close it with a reason and fit again; a flip is a remove-and-fit (D13)';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fitment_written_once
BEFORE UPDATE ON app.fitment
FOR EACH ROW EXECUTE FUNCTION app.fitment_is_written_once();

-- The vocabulary was one value short: dispose_tyre writes the target state's
-- name as the event type, and slice 1 froze SENT_FOR_RETREAD without its
-- breakdown-supplier sibling (FR-FIT-013). RETURNED serves every return.
ALTER TABLE app.tyre_event DROP CONSTRAINT tyre_event_type_in_vocabulary;
ALTER TABLE app.tyre_event ADD CONSTRAINT tyre_event_type_in_vocabulary CHECK (type IN
  ('RECEIVED','BRANDED','FITTED','ROTATED','REMOVED','SENT_FOR_RETREAD',
   'SENT_TO_BREAKDOWN_SUPPLIER','RETURNED','REFITTED','INSPECTED','SCRAPPED','SOLD','LOST'));
```

Down: `DROP TRIGGER fitment_written_once ON app.fitment; DROP FUNCTION app.fitment_is_written_once();` and restore 000030's CHECK verbatim.

- [ ] **Step 4: Seed `removal_reasons`** in `gen_seed_configurations.py`'s per-tenant key loop (beside `dual_mate_warn_mm`), with a comment citing FR-FIT-008 and rule 5:

```python
                # FR-FIT-008's minimum plus the two this platform writes itself
                # (rotation closes a fitment; a correction is FR-FIT-015's
                # compensating close). Tenant configuration, never a constant.
                ('removal_reasons',["worn_to_threshold","damage","irregular_wear","casing_failure",
                                    "vehicle_disposal","rotation","correction","puncture"]),
```

- [ ] **Step 5: Seed the Sandbox depots** in `gen_seed_fixture.py` after line 97:

```python
# Dispatch (TYRE-92) needs a destination of each kind, and nothing creates a
# depot through the API yet. Sandbox only — BAC's rows are the fixture.
L.append("INSERT INTO app.depot (id,tenant_id,name,type) VALUES (md5('sbretreader1')::uuid,'%s','Sandbox Retreaders','RETREADER'),(md5('sbbreakdown1')::uuid,'%s','Sandbox Roadside','BREAKDOWN_SUPPLIER');"%(T3,T3))
```

- [ ] **Step 6: Run.** `make db-reset && make db-test` → 40a–40f PASS, sections 36 and 38 unchanged (36b/36c still TY009 — this is the trigger-order proof). Then `make db-test` warm: identical PASS lines.
- [ ] **Step 7: Grep for the old constraint name in Go** (`rg tyre_event_type_in_vocabulary api/`) — expect none. Run `make check`.
- [ ] **Step 8: Commit.**

```bash
git add db/migrations/000032_* db/seeds/gen_seed_configurations.py db/seeds/gen_seed_fixture.py db/seeds/*.sql db/tests/004_tests.sql
git commit -m "feat(db): TYRE-92 a fitment is written once and closed once; the breakdown dispatch joins the vocabulary"
```

---

### Task 3: Migration 000033 — the fitment functions (TYRE-92)

**Files:**
- Create: `db/migrations/000033_fitment_functions.up.sql`, `.down.sql`
- Test: `db/tests/004_tests.sql` — new section 41
- Reference: `db/migrations/000031_tyre_lifecycle_functions.up.sql` (the house pattern: `FOR UPDATE`, `tz` lookup, event insert shape at `:107-111` and `:223-227`), spec D2.

**Interfaces:**
- Consumes: TY014 (Task 2), `removal_reasons` config, `dual_mate_warn_mm` config, `app.threshold_policy`, `app.tenant_today(tz)`, `app.current_removal_threshold_mm()` (not used here; Task 4 uses it).
- Produces, exactly these signatures (Go binds to them in Tasks 9–10):

```sql
app.fit_tyre(p_tyre uuid, p_vehicle uuid, p_position uuid, p_tread_mm numeric,
             p_mount_orientation app.mount_orientation, p_odometer bigint DEFAULT NULL,
             p_occurred_at timestamptz DEFAULT now(), p_reason text DEFAULT NULL)
  RETURNS TABLE (fitment_id uuid, warnings jsonb)
app.remove_tyre(p_fitment uuid, p_reason text, p_tread_mm numeric, p_odometer bigint DEFAULT NULL,
                p_occurred_at timestamptz DEFAULT now(), p_backdate_reason text DEFAULT NULL)
  RETURNS void
app.rotate_tyres(p_vehicle uuid, p_moves jsonb, p_odometer bigint DEFAULT NULL,
                 p_occurred_at timestamptz DEFAULT now())
  RETURNS TABLE (tyre_id uuid, fitment_id uuid)
app.dispatch_tyre(p_tyre uuid, p_destination app.tyre_state, p_depot uuid, p_sent_on date DEFAULT NULL)
  RETURNS TABLE (retread_job_id uuid)
app.return_tyre_to_stock(p_tyre uuid, p_depot uuid DEFAULT NULL, p_occurred_at timestamptz DEFAULT now())
  RETURNS void
```

Not-found messages, verbatim (probes pin them): `'no such tyre in this fleet'`, `'no such unit in this fleet'`, `'no such fitment in this fleet'`, `'no such position on this unit'`, `'no such depot in this fleet'`. Warning codes: `SIZE_DIFFERS_ON_AXLE`, `RETREAD_ON_NON_PERMITTED_AXLE`, `DUAL_MATE_TREAD_GAP`. `p_moves` elements: `{"tyre_id","to_position_id","tread_mm"}`.

- [ ] **Step 1: Write failing suite section 41.** Fixture — **plant your own units**: the seed already fills every position on BAC's `veh1`–`veh3` with the 27 fixture tyres, so a fit to a seeded unit hits `one_open_fitment_per_position` before it reaches anything this section tests. As section 36 does, insert a fresh `HORSE` (`T41-H`) and a fresh `TRAILER` (`T41-T`) both on `veh1`'s `configuration_id` (so the STEER/DRIVE position rows and the seeded `retreads_permitted=false` STEER policy apply), plus in-section tyres (`T41TYRE1..6`, `IN_STOCK`); `sz1` and a second `tyre_size` row planted in-section for the size warning. Every position named below is on these two units; 41d's raw-insert probe targets a position this section filled itself. Lettered assertions — each is a `BEGIN … EXCEPTION WHEN sqlstate` block or an `IF NOT … RAISE EXCEPTION 'FAIL'` guard, exactly as section 39 does:

  - **41a** fit from `IN_STOCK` on the trailer, no odometer, `MARK_OUTBOARD` → one open fitment, tyre `FITTED`, one `FITTED` event with `to_state='FITTED'`, `warnings = '[]'`, `last_tread_mm` = supplied tread.
  - **41b** fit the same tyre again → TY012, message contains `'FITTED'` and the position code (D14 "naming its current location").
  - **41c** fit a `REMOVED` tyre → TY012 naming `REMOVED` (U1).
  - **41d** fit onto an occupied position **by raw INSERT** past the function → `unique_violation`, constraint `one_open_fitment_per_position`; a raw second open row for the fitted tyre → `unique_violation`, `one_open_fitment_per_tyre` (the DoD's "refused by the DB").
  - **41e** fit to a position from a *different* configuration → TY014 `'no such position on this unit'`.
  - **41f** fit on the HORSE without odometer → **TY009** (the trigger, reached through the function).
  - **41g** fit a `RETREAD` tyre (status RETREAD, retread_count 1) to the horse's STEER position → success with warning `RETREAD_ON_NON_PERMITTED_AXLE`; fit a tyre of a different size on the other side of the same axle → warning `SIZE_DIFFERS_ON_AXLE`; fit an INNER whose OUTER mate's tread differs by 4mm (config 3) → warning `DUAL_MATE_TREAD_GAP`. None blocks.
  - **41h** `remove_tyre` with reason `'wrong_reason'` → TY014; with `'damage'`, both odometers → closed, `distance_source='MEASURED'`, `distance_km` = difference, tyre `REMOVED`, `current_depot_id = home_depot_id`, event `REMOVED` with reason; removing again → TY012.
  - **41i** removal on the trailer with no odometer → `distance_source='UNAVAILABLE'`, `distance_km IS NULL` — never silently NULL provenance.
  - **41j** removal with `removed_odometer < fitted_odometer` → TY014.
  - **41k** backdate: `p_occurred_at` before the tyre's latest event → TY012; 25 h back with no reason → TY014; with reason → accepted.
  - **41l** `rotate_tyres` on the horse with two moves swapping two open fitments (same odometer, one tread each) → both old rows closed with reason `rotation`, two new open rows, `mount_orientation` carried over, two `ROTATED` events with `to_state='FITTED'` and from/to codes in payload.
  - **41m** rotation whose second move targets a position off the unit → TY014, **and** afterwards every original fitment is still open and no new row exists (the DoD's no-half-state proof).
  - **41n** rotation with one move → TY014; with a tyre not on this unit → TY012.
  - **41o** `dispatch_tyre` from `IN_STOCK` → TY012 (U2); from `REMOVED` to `AT_RETREADER` with a `DEPOT`-type depot → TY014; with the retreader depot → a `retread_job` row (`sent_at` = tenant today), tyre `AT_RETREADER`, event `SENT_FOR_RETREAD`; to `AT_BREAKDOWN_SUPPLIER` → `SENT_TO_BREAKDOWN_SUPPLIER`, `retread_job_id IS NULL`.
  - **41p** dispatch with `retread_count = max_retreads` (plant a tenant-wide policy row with `max_retreads = 1` and a tyre at 1) → **TY015**, message names `1` and the cap.
  - **41q** `return_tyre_to_stock` from `AT_BREAKDOWN_SUPPLIER` → `IN_STOCK`, event `RETURNED`; from `AT_RETREADER` → TY012.
  - **41r** cross-tenant, two independent probes: as tenant 2, `fit_tyre` on BAC's tyre → TY012 with message exactly `'no such tyre in this fleet'`; `remove_tyre` on the BAC fitment → TY012 exactly `'no such fitment in this fleet'`.
  - **41s** the `REFITTED` predicate: return the removed trailer tyre to stock and fit it again → event type `REFITTED` (U8).

- [ ] **Step 2: Run to verify it fails.** `make db-reset && make db-test` → FAIL at 41a: function does not exist.
- [ ] **Step 3: Write the migration.** Header comment cites FR-FIT-001..010, 012, 013, 016, D13, D14, U1/U2/U3/U8/U10. Per-function rule order is the spec's; the shared preamble every function opens with:

```sql
  SELECT t.timezone INTO tz FROM app.tenant t WHERE t.id = app.current_tenant_id();
  SELECT * INTO ty FROM app.tyre WHERE id = p_tyre FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'TY012', MESSAGE = 'no such tyre in this fleet';
  END IF;
```

The instant guard, shared as a private helper `app.fitment_instant_ok(p_tyre uuid, p_at timestamptz, p_reason text)` that raises TY012 (before the latest event) or TY014 (backdate over 24 h without reason) so the three writers do not restate it. The warnings collector in `fit_tyre` is a `jsonb` local built with `||` per rule; the dual-mate rule reads `(SELECT (value #>> '{}')::numeric FROM app.configuration WHERE tenant_id = app.current_tenant_id() AND key = 'dual_mate_warn_mm' ORDER BY effective_from DESC LIMIT 1)` and is silent when the key is absent (absence is absence). `rotate_tyres` closes every fitment in one UPDATE before its INSERTs, so the partial unique indexes see no interim double occupancy. `last_tread_mm` updates are `WHERE last_tread_at IS NULL OR last_tread_at < p_occurred_at` (U10).

Down: `DROP FUNCTION` each, plus the helper.

- [ ] **Step 4: Run.** `make db-reset && make db-test` → 41a–41s PASS; sections 7, 8, 17, 18, 36–40 unchanged. Warm `make db-test` identical.
- [ ] **Step 5: Comment audit of the migration.** Every rule comment cites its requirement; no narration. `make check`.
- [ ] **Step 6: Commit.**

```bash
git add db/migrations/000033_* db/tests/004_tests.sql
git commit -m "feat(db): TYRE-92 fit, remove, rotate, dispatch and return as lifecycle functions"
```

---

### Task 4: Migration 000034 — Log Retread return (TYRE-93)

**Files:**
- Create: `db/migrations/000034_log_retread_return.up.sql`, `.down.sql`
- Test: `db/tests/004_tests.sql` — new section 42
- Reference: spec D3; `app.retread_job` and `app.casing_valuation` (000012:204-249); `app.rand_per_mm` (000001:602); lesson 2026-09-01 on `numeric(p,s)` parameters.

**Interfaces:**
- Consumes: `app.dispatch_tyre` (Task 3) to create the job under test; TY015.
- Produces: `app.log_retread_return(p_job uuid, p_returned_on date, p_casing_accepted boolean, p_report_reference text, p_retread_cost numeric DEFAULT NULL, p_post_tread_mm numeric DEFAULT NULL, p_casing_value numeric DEFAULT NULL, p_new_pattern_id uuid DEFAULT NULL) RETURNS void`. Not-found message: `'no such open retread job in this fleet'`.

- [ ] **Step 1: Write failing suite section 42.** Stage: a BAC tyre planted `REMOVED` with `retread_count 0`, `status NEW`, `new_tread_mm 25.0`, `purchase_price 4319.91`, `rand_per_mm` derived via `app.rand_per_mm(4319.91, 25.0, 4.0)`; dispatch it to `md5('depot1')`-style retreader depot planted in-section with type `RETREADER`. Assertions:
  - **42a** return accepted: cost `2500.005` (three decimals, so rounding order can fail — lesson 2026-09-01), post tread `16.0`, casing value `800.00`, no new pattern → tyre: `retread_count 1`, `status 'RETREAD'`, `new_tread_mm 16.0`, `pattern_id` unchanged, `state 'IN_STOCK'`, `rand_per_mm = app.rand_per_mm(2500.01, 16.0, app.current_removal_threshold_mm())` — asserted by calling the function, never a literal — and the stored rate reproduces from the job's stored `retread_cost` to four places.
  - **42b** one `casing_valuation` row: `value 800.00`, `source 'RETREADER'`, `retread_job_id` = job, `effective_from` = returned date; `v_tyre_register`-style read (000013's precedence) shows `casing_basis = 'ACTUAL'` for this tyre.
  - **42c** event `RETURNED` with `to_state 'IN_STOCK'` and the job id in payload; `retread_job.returned_at`, `turnaround_days` = returned − sent.
  - **42d** returning the same job again → TY012 `'no such open retread job in this fleet'`.
  - **42e** rejected casing on a second dispatched tyre: `p_casing_accepted false`, cost NULL → tyre `SCRAPPED`, `retread_count` unchanged, a **zero** `RETREADER` casing valuation citing the job (U9), event `SCRAPPED` with `from_state 'AT_RETREADER'` and reason `'casing rejected by retreader'`; the register shows casing value `0.00` with basis `ACTUAL`.
  - **42f** rejected with a non-zero casing value → TY014; accepted with post tread `4.0` (= threshold) → TY014; accepted with `returned_on < sent_at` → TY014; accepted with cost NULL → TY014.
  - **42g** cap backstop: plant tenant-wide `max_retreads = 1`, a job for a tyre already at 1 (insert the job directly, bypassing dispatch) → TY015.
  - **42h** `dispose_tyre(..., 'SCRAPPED')` on a tyre `AT_RETREADER` → still TY012 (the only scrap path from the retreader is this function).
  - **42i** cross-tenant: tenant 2 calls `log_retread_return` on BAC's open job → TY012 with the exact not-found message; second probe: tenant 2 calls `dispatch_tyre` on the BAC tyre → TY012 `'no such tyre in this fleet'`.
  - **42j** section 7's Appendix E pin is unaffected — assert `app.rand_per_mm(4319.91, 25.0, 4.0) = 205.7100` still, inside this section, as the local sentinel that nothing here redefined the function.
- [ ] **Step 2: Run to verify it fails.** → FAIL at 42a.
- [ ] **Step 3: Write the migration.** The one arithmetic line, with the local:

```sql
DECLARE cost numeric(12,2); thr numeric;
...
  cost := p_retread_cost;                     -- rounds to cents HERE, before the divide
  thr  := app.current_removal_threshold_mm();
  IF p_post_tread_mm IS NULL OR p_post_tread_mm <= thr THEN
    RAISE EXCEPTION USING ERRCODE = 'TY014',
      MESSAGE = format('post-retread tread must exceed the removal threshold of %s mm', thr);
  END IF;
  UPDATE app.tyre
     SET retread_count = retread_count + 1,
         status        = 'RETREAD',
         new_tread_mm  = p_post_tread_mm,
         pattern_id    = COALESCE(p_new_pattern_id, pattern_id),
         rand_per_mm   = app.rand_per_mm(cost, p_post_tread_mm, thr),   -- FR-TYR-019, BR-VAL-006
         state         = 'IN_STOCK',
         current_depot_id = NULL
   WHERE id = ty.id;
```

Rejected branch, event and valuation rows exactly per spec D3. `retread_job` is UPDATEd with all return columns. Header cites FR-FIT-021/022, FR-TYR-009/018/019, BR-VAL-004/006, BR-FIT-009, and says why `tyre.casing_value` is not written.

- [ ] **Step 4: Run.** `make db-reset && make db-test` → 42a–42j PASS; **sections 7, 17, 18 unchanged**. Warm run identical.
- [ ] **Step 5: Dispatch the `valuation-verifier` agent** on `000034` and section 42 with the question: does anything here change a figure Appendix E, section 17 or section 18 pins, and is the cent-rounding order right? Fix anything it finds before committing; record its verdict in the commit body.
- [ ] **Step 6: `make check`, then commit.**

```bash
git add db/migrations/000034_* db/tests/004_tests.sql
git commit -m "feat(db): TYRE-93 a retread return propagates to the tyre; the cap and the rejected casing"
```

---

### Task 5: Migration 000035 — unit status transitions and the audit trigger (TYRE-94)

**Files:**
- Create: `db/migrations/000035_vehicle_status_and_audit.up.sql`, `.down.sql`
- Test: `db/tests/004_tests.sql` — new section 43
- Reference: ADR-0014 (Task 1); `app.generate_inspection_tasks` (000012:389); `app.vehicle_status` values incl. 000010's `PARKED`/`OUT_OF_SERVICE`; 000018:66 (the `vehicle_tag_map` DELETE revoke).

**Interfaces:**
- Produces: `app.set_vehicle_status(p_vehicle uuid, p_status app.vehicle_status, p_reason text DEFAULT NULL) RETURNS void` raising **TY016**; `app.audit_row_change()` + trigger `vehicle_audited`; `GRANT DELETE ON app.vehicle_tag_map TO app_rw`. Not-found message: `'no such unit in this fleet'`.

- [ ] **Step 1: Write failing suite section 43.**
  - **43a** a planted ACTIVE unit with an open fitment (fit via `app.fit_tyre`) → `set_vehicle_status(..., 'DISPOSED', 'sold')` → TY016, message says the unit still has fitted tyres.
  - **43b** `PARKED` → status changes; **exactly one** new `audit_log` row for `entity_type 'vehicle'`, `entity_id` = unit, `action 'UPDATE'`, `before->>'status' = 'ACTIVE'`, `after->>'status' = 'PARKED'`, `actor_id = app.current_actor_id()` (set `app.actor_id` in the section).
  - **43c** `PARKED` again (no-op) → TY016; an unknown id → TY012 `'no such unit in this fleet'`.
  - **43d** schedule pause: plant an `inspection_schedule` due today for the parked unit, call `app.generate_inspection_tasks(current_date)` → no `inspection_task` for it; set `ACTIVE` → the call creates one (FR-VEH-006, FR-INS-054).
  - **43e** remove the tyre, `DISPOSED` with reason → succeeds; any transition out of `DISPOSED` → TY016; `DISPOSED` without reason → TY016.
  - **43f** the audit row is append-only for the app role: `UPDATE app.audit_log SET action = 'x'` → `insufficient_privilege`.
  - **43g** cross-tenant: tenant 2 → TY012 exact message; second probe: tenant 2 raw `UPDATE app.vehicle SET description = 'x' WHERE id = <BAC unit>` affects 0 rows.
  - **43h** `DELETE FROM app.vehicle_tag_map WHERE vehicle_id = <unit>` succeeds for the app role (0 rows, no privilege error); `DELETE FROM app.vehicle_tag` → `insufficient_privilege` still.
- [ ] **Step 2: Run to verify it fails.** → FAIL at 43a.
- [ ] **Step 2b: Verify the trigger's blast radius before writing it.** `app.current_actor_id()` (000001:32) is `nullif(current_setting('app.actor_id', true), '')::uuid` — it returns NULL, never raises, when no actor is bound. So the 18 `INSERT INTO app.vehicle` in the suite and the seed loader (superuser, no actor) each produce an INSERT audit row with `actor_id NULL` rather than failing. That is the intended "loaded, not acted" outcome ADR-0014 records; confirm the ADR's Consequences say it (Task 1), and add assertion **43i**: a vehicle inserted with no `app.actor_id` bound has an audit row whose `actor_id IS NULL`.
- [ ] **Step 3: Write the migration.** Function per spec D5; trigger per ADR-0014 verbatim; `GRANT DELETE ON app.vehicle_tag_map TO app_rw;` with the FR-VEH-041 rationale in a comment. The status function's header records **why TY008 has no wire entry**: no endpoint updates `configuration_id` or `unit_kind`, and this function does not touch either.
- [ ] **Step 4: Run.** → 43a–43h PASS; suite section 16/37 sweeps unchanged; the isolation sweep already lists `audit_log`. Warm run identical.
- [ ] **Step 5: `make check`, commit.**

```bash
git add db/migrations/000035_* db/tests/004_tests.sql
git commit -m "feat(db): TYRE-94 unit status transitions, audited per ADR-0014"
```

---

### Task 6: RLS audit of 000032–000035

**Files:** none created; findings fixed in place in the four migrations or their sections.

- [ ] **Step 1: Dispatch the `rls-auditor` agent** over migrations 000032–000035 and suite sections 40–43, with the standing checks (FORCE RLS on any new table — none expected; every new function `SECURITY INVOKER`; `security_invoker` on any new view — none; the audit trigger writes under the writer's tenant; the tag-map grant does not widen a cross-tenant path) and the specific question: can any new function's refusal disclose another tenant's row through a distinguishable error or message? Run each cross-tenant probe in 41r/42i/43g under a simulated RLS bypass and confirm it **fails** — a probe that passes with RLS off is vacuous (lesson 2026-09-01).
- [ ] **Step 2: Fix findings** in the migration files (they are unmerged, so edited in place) and re-run `make db-reset && make db-test`.
- [ ] **Step 3: Commit** any fix as `fix(db): TYRE-92 <finding> [rls-audit]`; if none, no commit — record "7/7 standing checks, N probes proven non-vacuous" in the PR body notes file (`.superpowers/` scratch or the PR body draft).

---

### Task 7: Go plumbing — PATCH, `pathID`, the wire codes, named request structs

**Files:**
- Modify: `api/internal/httpapi/httpapi.go` (`submitStatus` `:235-272`, `conflictCodes` `:293-308`, new `pathID`, `writeError` unchanged), `admin.go:81` (`maxCreateBytes` → `maxWriteBytes`, all uses), `tyres.go:329-400` (named structs, `pathID`), `capture.go:110-113` (`pathID`), `admin.go:517` (`pathID`), `httpapi_test.go` (`patch` helper beside `post` at `:111`)
- Test: `refusal_internal_test.go` (table rows for TY009/TY014/TY015/TY016), `tyres_test.go` (the two 422→400 assertions)

**Interfaces:**
- Produces: `func pathID(w http.ResponseWriter, r *http.Request, name string) (uuid.UUID, bool)` — writes 400 `codeBadRequest` `"malformed id in path"` and returns false on parse failure; `patch(t, h, path, tenant, user, body string) *httptest.ResponseRecorder`; `submitStatus` entries `TY009`, `TY014`, `TY015`, `TY016` → 422; `conflictCodes` entries `one_open_fitment_per_position → codePositionOccupied` (`"position_occupied"`, message `"that position already carries a tyre; remove it first (FR-FIT-004)"`), `one_open_fitment_per_tyre → codeTyreAlreadyFitted` (`"tyre_already_fitted"`, message `"that tyre is already fitted elsewhere; remove it first (D14)"`); named types `setTyreCostRequest`, `disposeTyreRequest`.

- [ ] **Step 1: Failing tests.** In `refusal_internal_test.go`'s table add four rows asserting a `*pgconn.PgError{Code: "TY014", Message: "x"}` maps to 422 with code `TY014` and the message verbatim (same for TY009, TY015, TY016). In `tyres_test.go`, change the malformed-id assertions for `/api/tyres/not-a-uuid/cost` and `/dispose` from 422 to **400** `bad_request`. Add `TestConflictCodesNameLiveSchemaObjects` coverage for the two new keys (it iterates the map, so adding the keys is enough — confirm it fails first by adding a deliberately wrong key, then remove it).
- [ ] **Step 2: Run** `make api-test` → the four table rows fail (unmapped → not found), the two 400 assertions fail.
- [ ] **Step 3: Implement.**
  - `submitStatus`: replace the TY011–TY013 comment block with one that says TY009 is now reachable through `app.fit_tyre` (TYRE-92) and lists TY014–TY016's meanings; add beneath it the **permanent TY008 note**: "TY008 has no entry and never will unless configuration editing is reopened: no endpoint updates `vehicle.configuration_id` or `unit_kind` — PATCH refuses both fields before SQL (docs/implementation-order.md §B5). An entry could carry no test able to fail (ADR-0012)."
  - `pathID` in `httpapi.go` beside `require`; replace the four `uuid.Parse(chi.URLParam(...))` sites. `capture.go` keeps its 400 (now via the helper); `tyres.go`'s two become 400 (U7).
  - `maxCreateBytes` → `maxWriteBytes` with its comment saying it bounds every write body.
  - `setTyreCostRequest{Price string; Source string}` and `disposeTyreRequest{Disposal string; Reason, Proceeds *string}` replace the anonymous structs.
  - `patch` helper: a copy of `post` with `http.MethodPatch`.
- [ ] **Step 4: Run** `make api-test` → green. `rg maxCreateBytes api/` → none. `make check`.
- [ ] **Step 5: Commit.**

```bash
git add api/
git commit -m "refactor(api): TYRE-92 PATCH plumbing, one path-id helper, and the slice-2 wire codes"
```

---

### Task 8: Go reads — the unit, its fitments, open fitments, depots, retread jobs

**Files:**
- Create: `api/internal/httpapi/units.go` (`getUnit`, `listUnitFitments`, `listOpenFitments`, `listDepots`), `units_test.go`, `retreads.go` (`listRetreadJobs` only in this task), `retreads_test.go`
- Modify: `httpapi.go:96-121` (routes)

**Interfaces:**
- Produces JSON shapes (camelCase, money as strings and only with `ViewValuation`):

```go
type unitJSON struct {
    ID, FleetNumber, Registration string; Description, BodyType, UnitDescriptor *string
    UnitKind *string; Status string; ConfigurationID string; ConfigurationName string
    HomeDepotID, OperatingGroupID *string; Tags []string; HasHistory bool
    RemovalReasons []string; HasOdometer bool          // unit_kind not NULL and not TRAILER
    Positions []unitPositionJSON
}
type unitPositionJSON struct {
    ID, Code string; Sequence int; AxleNumber *int; AxleClass string; Side, Slot *string; IsSpare bool
    Fitment *openFitmentJSON
}
type openFitmentJSON struct {
    FitmentID, TyreID, DisplayCode string; FittedAt string; FittedOdometer *int64
    FittedTreadMm *string; MountOrientation string; TyreStatus string; RetreadCount int
    SizeName *string; LastTreadMm *string
}
type fitmentHistoryJSON struct {   // GET /api/vehicles/{id}/fitments
    FitmentID, TyreID, DisplayCode, PositionCode string; FittedAt string; RemovedAt *string
    FittedOdometer, RemovedOdometer *int64; FittedTreadMm, RemovedTreadMm *string
    RemovalReason *string; DistanceKm *int64; DistanceSource string; MountOrientation string
}
type fleetFitmentJSON struct {     // GET /api/fitments?open=true
    FitmentID, VehicleID, FleetNumber, PositionCode, TyreID, DisplayCode, FittedAt string; DaysFitted int
}
type depotJSON struct { ID, Name, Type string }
type retreadJobJSON struct { ID, TyreID, DisplayCode, DepotName, SentAt string; DaysOut int }
```

Routes: `GET /api/vehicles/{vehicleID}` (ViewFleet), `GET /api/vehicles/{vehicleID}/fitments` (ViewFleet), `GET /api/fitments` (ViewFleet; `?open=true` required for now, 400 otherwise), `GET /api/depots?type=` (ManageAssets; type optional), `GET /api/retread-jobs?open=true` (LogRetread).

- [ ] **Step 1: Failing tests** in `units_test.go`: `TestGetUnitCarriesPositionsAndCurrentFitments` (plant via `plantTenantWithVehicle` + a raw `app.fit_tyre` call in an actor tx; assert the fitted position carries the code and orientation, empty ones carry `null`, `hasHistory` true, `removalReasons` non-empty after planting the config key, `hasOdometer` per kind); `TestGetUnitIsTenantScoped` (tenant B → 404 `not_found`); `TestUnitFitmentHistoryCarriesProvenanceWithDistance` (a closed row shows `distanceSource` and `distanceKm` together); `TestOpenFitmentsAreFleetWide`; `TestDepotsFilterByType`; `TestRetreadJobsRequireLogRetread` (TECHNICIAN 403, CONTROLLER 200) in `retreads_test.go`; `TestUnitReadIsCapabilityGated` (DRIVER 403).
- [ ] **Step 2: Run** → fail (404 route).
- [ ] **Step 3: Implement** the five handlers with `withActor`, one query each (positions LEFT JOIN open fitment LEFT JOIN tyre; `hasHistory` as `EXISTS` over fitment/inspection/reading — the TY008 predicate); a helper `unitByID(ctx, tx, id) (unitJSON, error)` that Task 11's PATCH reuses for its response. `getUnit` answers 404 when RLS hides the unit (a read, not a write — `not_found`, not TY012).
- [ ] **Step 4: Run** → green. `make check`. Commit.

```bash
git add api/
git commit -m "feat(api): TYRE-92 the unit read with its positions, fitment history, open fitments, depots and retread jobs"
```

---

### Task 9: Go fitment writes — fit, remove, rotate (TY009 discharged)

**Files:**
- Create: `api/internal/httpapi/fitments.go`, `fitments_test.go`
- Modify: `httpapi.go` routes

**Interfaces:**
- Consumes: Task 3's functions; `pathID`, `decodeJSON`, `withActor`, `require`.
- Produces:

```go
type fitTyreRequest struct {
    TyreID string `json:"tyreId"`; PositionID string `json:"positionId"`
    TreadMm string `json:"treadMm"`; MountOrientation string `json:"mountOrientation"`
    Odometer *int64 `json:"odometer"`; OccurredAt *string `json:"occurredAt"`; Reason *string `json:"reason"`
}
type fitTyreResponse struct { FitmentID string `json:"fitmentId"`; Warnings []fitWarningJSON `json:"warnings"` }
type fitWarningJSON struct { Code, Message string }
type removeFitmentRequest struct {
    Reason string; TreadMm string; Odometer *int64; OccurredAt *string; BackdateReason *string
}
type rotateRequest struct { Moves []rotateMove; Odometer *int64; OccurredAt *string }
type rotateMove struct { TyreID, ToPositionID, TreadMm string }
type rotateResponse struct { Moves []struct{ TyreID, FitmentID string } }
```

Routes: `POST /api/vehicles/{vehicleID}/fitments` → 201 `fitTyreResponse`; `POST /api/fitments/{fitmentID}/remove` → 204; `POST /api/vehicles/{vehicleID}/rotations` → 201 `rotateResponse`. All `ManageAssets`. Validation in Go is shape only (ADR-0013 d.5): required strings present, `moves` length ≥ 2 is **not** checked in Go (TY014 is the rule's home).

- [ ] **Step 1: Failing tests.** `TestFitTyreHappyPath` (trailer, no odometer, 201, empty warnings, then the unit read shows it); `TestFitOnHorseWithoutOdometerIsTY009` — **the deferral's discharge: 422, code `TY009`, message verbatim from the trigger; this test must fail with the `TY009` entry removed from `submitStatus` (prove it once, note it in the commit)**; `TestFitOnOccupiedPositionIs409PositionOccupied` (drives the raw 23505 through the handler by fitting twice — the function has no pre-check, so this reaches `conflictCodes`); `TestFitReturnsWarningsWithoutBlocking` (RETREAD on STEER → 201 with `RETREAD_ON_NON_PERMITTED_AXLE`); `TestRemoveFitmentWritesProvenance`; `TestRotateIsAtomic` (a bad second move → 422 TY014 and the unit read is unchanged); `TestFitmentWritesAreCapabilityGated` (TECHNICIAN 403 on all three); `TestFitmentWriteCrossTenantIsInvisible` (tenant B removes tenant A's fitment → 422 `TY012` `"no such fitment in this fleet"`); `TestWriteAimedAtAnotherTenantIsRefused_Fitment` (raw INSERT into `app.fitment` naming tenant B under tenant A's tx → 42501).
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** the three handlers on the `setTyreCost` idiom (`tx.QueryRow(ctx, "SELECT fitment_id, warnings FROM app.fit_tyre($1,$2,$3,$4::numeric,$5::app.mount_orientation,$6,COALESCE($7::timestamptz, now()),$8)", ...)`), rotate marshalling `moves` to jsonb.
- [ ] **Step 4: Run** → green; remove `"TY009"` from `submitStatus` temporarily and confirm `TestFitOnHorseWithoutOdometerIsTY009` fails, restore. `make check`. Commit.

```bash
git add api/
git commit -m "feat(api): TYRE-92 fit, remove and rotate; TY009 reaches the wire with a test that fails without it"
```

---

### Task 10: Go dispatch, return-to-stock, Log Retread return

**Files:**
- Modify: `api/internal/httpapi/tyres.go` (`dispatchTyre`, `returnTyreToStock`), `tyres_test.go`, `retreads.go` (`logRetreadReturn`), `retreads_test.go`, `httpapi.go` routes

**Interfaces:**

```go
type dispatchTyreRequest struct { Destination string `json:"destination"`; DepotID string `json:"depotId"`; SentOn *string `json:"sentOn"` }
type dispatchTyreResponse struct { RetreadJobID *string `json:"retreadJobId"` }
type returnTyreRequest struct { DepotID *string `json:"depotId"` }
type retreadReturnRequest struct {
    ReturnedOn string; CasingAccepted bool; ReportReference string
    RetreadCost, PostTreadMm, CasingValue *string; NewPatternID *string
}
```

Routes: `POST /api/tyres/{tyreID}/dispatch` → 201 (ManageAssets); `POST /api/tyres/{tyreID}/return` → 204 (ManageAssets); `POST /api/retread-jobs/{jobID}/return` → 204 (**LogRetread**).

- [ ] **Step 1: Failing tests.** `TestDispatchToRetreaderOpensAJob` (201 with a job id; `GET /api/retread-jobs?open=true` lists it with `daysOut 0`); `TestDispatchFromInStockIsTY012`; `TestDispatchAtCapIsTY015` (plant `max_retreads 0` on the tenant-wide policy row); `TestReturnToStockFromBreakdownSupplier`; `TestLogRetreadReturnPropagates` (as CONTROLLER: after return, `GET /api/tyres` shows `status RETREAD`, `retreadCount 1`, and with `ViewValuation` a `randPerMm` string equal to the SQL function's result fetched in the test through `SELECT app.rand_per_mm($1::numeric(12,2), $2, app.current_removal_threshold_mm())` — the test never computes money); `TestLogRetreadRequiresLogRetread` (a role without it → 403 — none of the tenant roles lacks it today, so plant the actor as TECHNICIAN which holds only ViewFleet); `TestRetreadReturnCrossTenantIsInvisible` (422 `TY012` `"no such open retread job in this fleet"`).
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4:** green, `make check`, commit.

```bash
git add api/
git commit -m "feat(api): TYRE-93 dispatch, return to stock and Log Retread, gated on LogRetread"
```

---

### Task 11: Go unit PATCH and status

**Files:**
- Modify: `api/internal/httpapi/units.go` (`patchUnit`, `setUnitStatus`), `units_test.go`, `httpapi.go` routes

**Interfaces:**

```go
type patchUnitRequest struct {   // every field optional; absent means unchanged
    FleetNumber, Registration, Description, BodyType, UnitDescriptor *string
    HomeDepotID, OperatingGroupID *string   // "" clears
    Tags *[]string                          // nil = unchanged; [] = clear
}
type setUnitStatusRequest struct { Status string; Reason *string }
```

Routes: `PATCH /api/vehicles/{vehicleID}` → 200 `unitJSON` (Task 8's `unitByID`); `POST /api/vehicles/{vehicleID}/status` → 204. Both `ManageAssets`.

- [ ] **Step 1: Failing tests.** `TestPatchUnitEditsDescriptiveFields`; `TestPatchUnitRefusesConfigurationID` — body `{"configurationId": "..."}` → 422 `invalid_submission`, message names `configurationId`; same for `unitKind` and for the snake-case spellings (`json.Decoder.DisallowUnknownFields` makes any unknown key a refusal; the test asserts the message names the offending key); `TestPatchUnitReplacesTags` (set two, then one, then empty — each read back); `TestPatchUnitFleetNumberConflictIs409` (`fleet_number_taken`, existing map entry); `TestPatchUnitAuditsTheChange` (one `audit_log` row, read on the admin conn); `TestWriteAimedAtAnotherTenantIsRefused_VehicleTag` (raw insert into `vehicle_tag_map` naming tenant B → 42501); `TestSetUnitStatusParksAndDisposes` (PARKED → `GET /api/my/tasks` for its driver no longer lists it after `generate_inspection_tasks`; DISPOSED with a fitted tyre → 422 `TY016`; after removal → 204); `TestUnitStatusCrossTenantIsInvisible` (422 `TY012` `"no such unit in this fleet"`).
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** PATCH decodes with `DisallowUnknownFields` into `patchUnitRequest`, issues one parameterised `UPDATE app.vehicle SET ... WHERE id = $n`. Text columns: `col = COALESCE($k, col)` (nil = unchanged; these cannot be cleared). The two nullable ids use a three-way shape so an empty string clears: `home_depot_id = CASE WHEN $k IS NULL THEN home_depot_id WHEN $k = '' THEN NULL ELSE $k::uuid END` (same for `operating_group_id`). Then `DELETE FROM app.vehicle_tag_map WHERE vehicle_id = $1` + `INSERT INTO app.vehicle_tag (tenant_id, name) ... ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id` per tag + map inserts, all in the actor tx; `tenant_id` from `app.current_tenant_id()`. Zero rows updated → 404.
- [ ] **Step 4:** green, `make check`, commit.

```bash
git add api/
git commit -m "feat(api): TYRE-94 unit PATCH refusing configuration and kind, and status transitions"
```

---

### Task 12: Web plumbing — `apiPatch`, API modules, `useFormMutation`, the register split

**Files:**
- Create: `web/src/api/units.ts` + `units.test.ts`, `web/src/api/retreads.ts` + `retreads.test.ts`, `web/src/fleet/useFormMutation.ts` + `useFormMutation.test.tsx`, `web/src/fleet/tyres/{TyreList,DisposeForm,CostForm}.tsx` + their tests (moved from `fleet/TyreList.tsx` / `TyreList.test.tsx`)
- Modify: `web/src/api/client.ts` (`apiPatch`), `client.test.ts`, `web/src/api/tyres.ts` (`dispatchTyre`, `returnTyreToStock`, `fetchOpenFitments`), `tyres.test.ts`, `routes.tsx` (import path), `fleet.css` (selectors unchanged — verify with `rg` per the CSS lesson)
- Delete: `web/src/fleet/TyreList.tsx`, `web/src/fleet/TyreList.test.tsx` (moved)

**Interfaces:**
- `apiPatch<T>(path, body): Promise<T>` — `apiPost`'s shape with `method: "PATCH"`.
- `units.ts`: `interface Unit`, `UnitPosition`, `OpenFitment`, `FitmentHistoryRow`, `FleetFitment`, `Depot` mirroring Task 8's JSON; `fetchUnit(id)`, `fetchUnitFitments(id)`, `fetchOpenFitments()`, `fetchDepots(type?)`, `fitTyre(unitId, body: NewFitment): Promise<FitResult>`, `removeFitment(fitmentId, body: Removal)`, `rotateTyres(unitId, body: Rotation)`, `patchUnit(id, body: UnitPatch): Promise<Unit>`, `setUnitStatus(id, body: {status, reason?})`.
- `retreads.ts`: `RetreadJob`, `fetchRetreadJobs()`, `logRetreadReturn(jobId, body: RetreadReturn)`.
- `tyres.ts`: `dispatchTyre(tyreId, {destination, depotId, sentOn?})`, `returnTyreToStock(tyreId, {depotId?})`.
- `useFormMutation<TVars, TResult>({ mutate: (v) => Promise<TResult>, invalidate: QueryKey[], onSuccess?: (r) => void })` returning `{ submit(vars), isPending, error, result }`; the caller owns field state and the `<form onSubmit>` guard. Each form's JSX keeps its `role="alert"` line through `refusalMessage`.

- [ ] **Step 1: Failing tests.** `client.test.ts`: `apiPatch` sends `PATCH`, carries the dev headers, throws `ApiError` with the envelope's code and message. `units.test.ts`/`retreads.test.ts`: one test per function asserting method, path and `sentBody` (fixtures.ts). `useFormMutation.test.tsx`: a rendered probe form proves pending disables the button, success invalidates the given keys, a refusal renders through `refusalMessage`. The moved `TyreList` tests are unchanged and must stay green after the move.
- [ ] **Step 2: Run** `make web-test` → fail. **Step 3: Implement.** Move `TyreList.tsx` into `fleet/tyres/` split by component; migrate `DisposeForm` and `CostForm` onto `useFormMutation` (they are the files being edited; the ledger's rule). Keep every `className` string; `rg "tyres-row-form|tyre-" web/src` before and after must match.
- [ ] **Step 4:** `make web-test` green; `npm run lint` clean (eslint is not covered by web-test — lesson 2026-08-31); screenshot `/fleet/tyres` before and after the move via `make e2e`'s dev server or the `run` skill. `make check`. Commit.

```bash
git add web/
git commit -m "refactor(web): TYRE-92 apiPatch, the unit and retread API modules, useFormMutation, and the register split"
```

---

### Task 13: Web — the unit screen with its plan view

**Files:**
- Create: `web/src/fleet/unit/UnitDetail.tsx`, `UnitPlan.tsx`, `PositionPanel.tsx`, `RotateForm.tsx`, `UnitEditForm.tsx`, `UnitStatusForm.tsx`, `FitmentHistory.tsx`, one `.test.tsx` per component
- Modify: `web/src/dashboard/VehicleList.tsx:5,55-58,98-105` (row becomes a `Link` to `/fleet/units/${v.id}`, drop `AxleSchematic`, fix the empty-state copy to "No units yet. Add one from *Add a unit*."), `fleet.css`
- Delete: `web/src/dashboard/AxleSchematic.tsx`

**Interfaces:**
- `UnitDetail({ unitId })` reads `fetchUnit` and `fetchUnitFitments`; holds `selectedPositionId` state; renders `UnitPlan`, `PositionPanel` for the selection, `RotateForm`, `UnitEditForm`, `UnitStatusForm`, `FitmentHistory`. Action components render only when `useCan("ManageAssets")`; the screen itself is readable with `ViewFleet`.
- `UnitPlan({ positions, selectedId, onSelect })` — an SVG built from `axleNumber`/`side`/`slot`, one `<g role="button" aria-label="Position {code}: {displayCode|empty}">` per position, spare drawn beside axle 1. **No hard-coded axle count.**
- `PositionPanel({ unit, position })` — Fit form when `position.fitment` is null (tyre picker from `fetchTyres()` filtered `state === "IN_STOCK"` by code, `treadMm`, `mountOrientation` radio, `odometer` only if `unit.hasOdometer`), Remove form otherwise (reason `<select>` from `unit.removalReasons`, `treadMm`, `odometer` likewise). Warnings render in a `role="status"` list.
- `RotateForm({ unit })` — checkboxes over occupied positions, a target `<select>` per checked one, one odometer if `hasOdometer`, one tread per tyre.
- `UnitEditForm({ unit })` — the PATCH fields, tags as a comma-separated input; the axle configuration name rendered as text with "Read-only: this unit has history" when `hasHistory` (and as plain text when not — it is never editable here; the note only explains why).
- `UnitStatusForm({ unit })` — the six statuses; reason input shown for `DISPOSED`.
- Wording objects per form list only the codes each endpoint can raise: fit `["TY009","TY012","TY014","position_occupied","tyre_already_fitted"]`, remove `["TY012","TY014"]`, rotate `["TY012","TY014"]`, edit `["fleet_number_taken"]`, status `["TY012","TY016"]`.

- [ ] **Step 1: Failing tests** (vitest, `renderScreen(capabilities)` pattern from `TyreList.test.tsx:12-25` with `fixtures.ts`): `UnitPlan` renders one button per position and marks the selected; `PositionPanel` shows Fit for an empty position and Remove for an occupied one; a trailer never renders an odometer field; a fit response's warnings appear as status text; `RotateForm` submits `moves` with `toPositionId` per checked position; `UnitEditForm` never contains a configuration input and shows the read-only note when `hasHistory`; `UnitStatusForm` shows the TY016 message verbatim; `FitmentHistory` renders `distanceKm` beside its `distanceSource` label and never a bare number; `VehicleList` rows link to the unit. Dates via `formatTenantDate` (the ban is active — `tsc`/eslint will refuse anything else).
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** Delete `AxleSchematic.tsx`; `rg AxleSchematic web/src` → none. `rg "axle-schematic|schematic" web/src/*.css web/src/**/*.css` and remove orphaned rules.
- [ ] **Step 4:** `make web-test` + `npm run lint` green; screenshot `/fleet` before/after (the row changed). `make check`. Commit.

```bash
git add web/
git commit -m "feat(web): TYRE-92 the unit screen: a data-driven plan view, fit, remove, rotate, edit and status"
```

---

### Task 14: Web — register actions, the retread queue, the fitments list

**Files:**
- Create: `web/src/fleet/tyres/DispatchForm.tsx` + test, `ReturnToStockButton.tsx` + test, `web/src/fleet/RetreadQueue.tsx` + test, `web/src/fleet/FitmentList.tsx` + test
- Modify: `web/src/fleet/tyres/TyreList.tsx` (row actions by state), `fleet.css`

**Interfaces:**
- Row actions by `tyre.state`: `IN_STOCK` → CostForm (if `awaitingCost`), DisposeForm; `REMOVED` → ReturnToStockButton, DispatchForm, DisposeForm; `AT_BREAKDOWN_SUPPLIER` → ReturnToStockButton, DisposeForm (LOST only); `AT_RETREADER` → text "At {depot} — log the return under Retreads"; `FITTED` → text "Fitted — see the unit".
- `DispatchForm({ tyre, tenantKey })`: destination radio (Retreader / Breakdown supplier), depot `<select>` from `fetchDepots(type)`, date defaulting to empty (server defaults to tenant today). Wording speakable `["TY012","TY014","TY015"]`; TY015's message renders verbatim ("a purchase, not a retread candidate").
- `RetreadQueue()`: table of `fetchRetreadJobs()` with days out; a per-row return form: accepted/rejected radio; when accepted: cost, post tread, casing value; report reference always required. **The new-pattern field is not in the UI this slice** — no pattern-list read exists and a raw uuid input is not a usable control; the API accepts `newPatternId`, the queue never sends it, and Task 17 raises the picker as a follow-up ticket. Wording `["TY012","TY014","TY015"]`.
- `FitmentList()`: `fetchOpenFitments()`, rows link to `/fleet/units/{vehicleId}`.

- [ ] **Step 1: Failing tests:** row actions per state (one test per state); DispatchForm sends `destination` and `depotId`; the queue renders days out and posts the accepted body with money as strings; FitmentList links rows.
- [ ] **Step 2–4:** implement, green, lint, screenshots of `/fleet/tyres`, `make check`, commit.

```bash
git add web/
git commit -m "feat(web): TYRE-93 dispatch and return on the register, the retread queue, and the fitments list"
```

---

### Task 15: Routes and navigation

**Files:**
- Modify: `web/src/routes.tsx`, `routes.test.tsx`, `web/src/shell/navigation.ts:18-32`, `navigation.test.ts`

**Interfaces:**
- Routes: `/fleet/units/:unitId` → `RequireCapability="ViewFleet"` wrapping `UnitDetail` (a read destination, hidden like `/fleet`); `/fleet/fitments` → `RequireCapability="ViewFleet"` `FitmentList`; `/fleet/tyres/retreads` → `AdminRoute capability="LogRetread"` `RetreadQueue`. `UnitRoute` reads `useParams().unitId` and renders `NotFound` when absent, on `CaptureRoute`'s shape.
- `NAV_ITEMS`: `Units` (`/fleet`, ViewFleet), `Tyres` (`/fleet/tyres`, ManageAssets), **`Fitments`** (`/fleet/fitments`, ViewFleet), **`Retreads`** (`/fleet/tyres/retreads`, LogRetread), then the existing items. Replace the "Rigs and Fitments join this row when TYRE-72/92 build them" comment with one saying Rigs joins when TYRE-72 builds it.

- [ ] **Step 1: Failing tests:** `routes.test.tsx` — each new route renders its screen for a holder and the refusal/hide for a non-holder; `navigation.test.ts` — `navItemsFor(["ViewFleet"])` yields Units and Fitments only; `["LogRetread"]` yields Retreads.
- [ ] **Step 2–4:** implement, green, `make check`, commit.

```bash
git add web/
git commit -m "feat(web): TYRE-92 route the unit, fitments and retreads screens behind their capabilities"
```

---

### Task 16: The end-to-end proof

**Files:**
- Create: `web/e2e/fitments.spec.ts`
- Reference: `web/e2e/tyres.spec.ts` (the shape), `web/e2e/admin.ts` (`actAs(page, userId, tenantId)`; the CONTROLLER is `md5('sbcontroller1')`, resolve the uuid the way `admin.ts` resolves the org admin's), Sandbox units `md5('sbveh1')` (HORSE `SBX001GP`) and `md5('sbveh2')` (TRAILER `SBX002GP`), depots `md5('sbretreader1')`.

**Before writing a single step:** read Tasks 13–15's landed component files and confirm each control the step below relies on exists with the role/label the assertion uses (lesson 2026-09-01: a flow narrated in a plan is a claim, not a fact). If a control is missing, escalate rather than assert around it.

- [ ] **Step 1: Write the spec,** `test.describe.configure({ mode: "serial" })`, chromium only (`test.skip(({ browserName }) => browserName !== "chromium")` as `tyres.spec.ts` does), as the Sandbox CONTROLLER:
  1. `/fleet/tyres/new`: receive quantity 3; capture the three issued codes from the `role="status"` list.
  2. `/fleet` → click `SBX002GP` → select position 1 → Fit: code 1, tread 14, orientation Mark outboard; **no odometer field is present** (`toHaveCount(0)`); status shows no warnings; the plan shows the code at position 1.
  3. `/fleet` → `SBX001GP` → position 1 → Fit code 2, tread 16, odometer 250100; position 2 → Fit code 3, tread 16, odometer 250100.
  4. Rotate: check positions 1 and 2, targets swapped, odometer 251000, treads 15/15 → the plan shows code 3 at 1 and code 2 at 2; history shows two closed rows with reason `rotation` and `MEASURED 900 km`.
  5. Trailer: remove code 1, reason damage, tread 12 → history row shows `UNAVAILABLE` beside no distance.
  6. `/fleet/tyres`: code 1's row is `REMOVED`; Return to stock → `IN_STOCK`; Dispatch is absent on `IN_STOCK` (U1/U2's UI contract); dispose is offered. Code 1 is not used again.
  7. Horse `SBX001GP`: remove code 2 (reason worn_to_threshold, tread 5, odometer 251500). Register: code 2's row is `REMOVED`; Dispatch to *Sandbox Retreaders* → the row reads `AT_RETREADER` with the log-the-return note.
  8. `/fleet/tyres/retreads`: the job shows days out 0; log return accepted: reference `RT-1`, cost 2500.00, post tread 16, casing value 800 → register row for code 2 shows `RETREAD`, count 1.
  9. Unit `SBX001GP`: status → Parked; `/my` as the Sandbox driver in a second context shows no task for it (only if a schedule exists on Sandbox — if none, assert the status text on the unit instead and note it).
  10. Status → Disposed with reason → the TY016 message is visible (code 3 is still fitted). Remove code 3 (reason vehicle_disposal, tread 10, odometer 252000) → Disposed succeeds; the unit list shows it `DISPOSED`.
- [ ] **Step 2: Run** `make api-run` in one terminal, `make e2e` in another → the new spec passes on chromium, is skipped on android/ios, and the existing 22 still pass.
- [ ] **Step 3: Commit.**

```bash
git add web/e2e/fitments.spec.ts
git commit -m "test(e2e): TYRE-92 a controller fits, rotates, removes, dispatches, retreads and disposes on Sandbox"
```

---

### Task 17: Close-out

**Files:**
- Modify: `docs/implementation-order.md` (§B5: slice 2 delivered table in slice 1's format; B6 marked **next**; TY008 paragraph marked done-in-code), `docs/adr/0014-audit-mechanism.md` (fill the follow-up ticket key), `docs/lessons.md` (only for a failure that changes the next attempt)

- [ ] **Step 1: `/comment-audit`** over the branch; fix what it finds.
- [ ] **Step 2: Whole-branch review** — dispatch a reviewer with the PR body draft *and* the diff (lesson 2026-09-01), asking for Critical/Important findings against the spec's D1–D8 and U1–U10; every Important enters the fix loop.
- [ ] **Step 3: Raise the follow-up tickets** in Jira (project TYRE) and cite their keys in the ADR and PR body: attach `audit_row_change` to the remaining tables; `brand_pending` workshop workflow (from TYRE-48); depot-to-depot transfer (FR-FIT-011); cross-unit rotation within a rig (B6 note on TYRE-72); the retread queue's new-pattern picker; `useFormMutation` migration of the four untouched forms.
- [ ] **Step 4: Update `docs/implementation-order.md`** and commit `docs(order): TYRE-92 B5 delivered; B6 next`.
- [ ] **Step 5: `make check` and `make e2e`** in full on the final commit; read the output; record counts in the PR body.
- [ ] **Step 6: Open the PR** to `develop` with the body: what landed by task, the U1–U10 table verbatim with a "confirm or reverse" ask, the RLS probe result, the valuation-verifier verdict, deleted-rather-than-bent (`AxleSchematic`, the anonymous structs, the 422 path-id split), and the follow-up ticket keys. Do not merge — the owner merges in the browser.
- [ ] **Step 7: Jira** — transition TYRE-92, TYRE-93, TYRE-94 and TYRE-48 to *In Review* with a comment linking the PR; TYRE-55's epic DoD is met except the odometer/fuel import — say so on the epic.

---

## Self-review

**Spec coverage.** D1 → Task 2. D2 → Tasks 3, 9, 10. D3 → Tasks 4, 10. D4 → Task 8. D5 → Tasks 1, 5, 11. D6 → Tasks 7–11. D7 → Tasks 12–15. D8 → Task 2 (seeds), 16. U1–U10 each bind to a named step: U1/U2 (41c, 41o), U3 (41n, spec out-of-scope), U4 (Tasks 1, 5), U5 (41p), U6 (Task 11 tags), U7 (Task 7), U8 (41s), U9 (42e), U10 (41a `last_tread_mm`), U11 (41g's warning, not a refusal). TY009 discharge → Task 9 with its remove-and-fail proof. TY008 note → Task 7 and Task 5's header.

**Placeholder scan.** None found. The one deliberately omitted control (the retread queue's new-pattern picker) is stated as a decision with its follow-up in Task 17, not left open.

**Type consistency.** `pathID` (Task 7) used by Tasks 8–11; `unitByID` (Task 8) used by Task 11; `useFormMutation` (Task 12) used by 13–14; SQL signatures in Task 3 match the `SELECT` in Task 9; `fitTyreResponse.Warnings` matches `warnings jsonb` `[{code,message}]`; not-found messages identical across Tasks 3–5 and their Go probes.
