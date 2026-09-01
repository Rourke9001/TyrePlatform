# B5 slice 1 — the tyre register: design

**Date:** 2026-09-01 · **Batch:** B5 (docs/implementation-order.md) · **Tickets:**
TYRE-88, TYRE-87, TYRE-48 (schema half), TYRE-91. **Authority:** Confluence
page 17170433 (*Reconciliation — Asset Flow, 30 Aug 2026*), D12/D13/D14, and
each ticket's own definition of done.

## Why this is a slice, not all of B5

B5 is TYRE-48+91, then TYRE-92+93, then TYRE-94, with TYRE-87/88 riding along.
The order doc's own rule — *"the event vocabulary is frozen by the code that
first writes it; frozen in the abstract it will be wrong"* — forbids writing
executable-grade plans for the fitment surface (TYRE-92/93) before the
register's writes exist. So this design covers slice 1: the schema hardening,
the D12/D13 columns, the lifecycle vocabulary, and the register surface.
TYRE-92/93 and TYRE-94 get their own plan once this lands, exactly as B4.5 got
its own plan after B4.

**TYRE-48 stays open at slice-1 end.** Its DoD includes the retread paths,
which belong to TYRE-92/93. Do not close it.

## Sequencing inside the slice

1. **TYRE-88** — harden TY009/TY008's triggers. Cheap before the first real
   fitment writer (TYRE-92) exists; the register's disposal path also assumes
   fitments can be closed, which defect 1 currently prevents for legacy rows.
2. **TYRE-87** — the tenant-key sweep, before this slice adds two more
   constraints of exactly the class it sweeps (`display_code_counter`'s PK,
   and the vocabulary checks ride the same migration territory).
3. **D12/D13 schema + TYRE-48 vocabulary** — the last cheap-before-pilot-data
   schema changes.
4. **TYRE-91** — lifecycle functions, Go endpoints, screens, e2e.

## Decisions

### D1. The event vocabulary is a CHECK constraint, not an enum

`tyre_event.type` gets `CHECK (type IN (...))` with the full list now, per
TYRE-48's 30 Aug comment ("land vocabulary with TYRE-91"):

`RECEIVED, BRANDED, FITTED, ROTATED, REMOVED, SENT_FOR_RETREAD, RETURNED,
REFITTED, INSPECTED, SCRAPPED, SOLD, LOST`

- The ticket's CHG-037 list omits `BRANDED` (CHG-023's dated branding event)
  and `LOST` (FR-TYR-010) — both are written by this very slice, so they are
  in. "Rebalancing" stays out per the 30 Aug clarification (a maintenance
  note, not a fitment event; unresolved on TYRE-48).
- CHECK, not enum: the vocabulary is closed but young. Slice 2 writes half of
  it for the first time; if a value proves wrong, replacing a CHECK is one
  migration, where enum surgery is not. Merged migrations are never edited, so
  a slice-2 mismatch means a new migration replacing the constraint — accepted.
- The one existing fixture write (`db/tests/004_tests.sql:1511`) uses
  `'SCRAP'`; it is a test file and is edited to `'SCRAPPED'`.

### D2. State-transition events must carry `to_state`; SOLD must carry proceeds

`app.tyre_in_estate_asof` (000016) reads the latest **non-NULL** `to_state`
and is fail-open — an event that changes estate membership but omits
`to_state` is invisible to valuation. Two CHECKs make the discipline
structural:

- `state_change_carries_to_state`: `type IN ('BRANDED','INSPECTED') OR
  to_state IS NOT NULL`. (`ROTATED` sets `to_state = 'FITTED'` — the state is
  unchanged but the row must still say so.)
- `sold_carries_proceeds`: `(type = 'SOLD') = (proceeds IS NOT NULL)`
  (CHG-037/FR-FIT-023).

### D3. D12 — `display_code_policy` on the tenant, seeded deliberately

Enum `app.display_code_policy ('FREE','GENERATED')`; column on `app.tenant`,
`NOT NULL DEFAULT 'FREE'`. Seed values (generator, never the generated SQL):

| Tenant | Policy | Why |
|---|---|---|
| BAC | `GENERATED` | D12's decision, verbatim |
| Sandbox Fleet | `GENERATED` | TYRE-91's DoD proves the hand-typed refusal *on Sandbox*; BAC rows are the acceptance fixture nobody writes to |
| Second Fleet | `FREE` | a live FREE tenant, so the suite proves FREE behaviour without manufacturing a tenant |

### D4. Generated codes come from a per-tenant counter table

`app.display_code_counter (tenant_id PK → tenant, prefix, next_number)`,
RLS-enabled and added to the isolation sweep. Issuance is
`UPDATE ... SET next_number = next_number + 1 ... RETURNING` inside the
receive function — the row lock serialises concurrent receives, so two bulk
receives cannot mint the same code. Format per ADR-0008's recommended scheme:
`prefix || '-' || lpad(n, 5, '0')` → `BAC-00001`. Seeds: BAC → `BAC`,
Sandbox → `SBX`. A GENERATED tenant with no counter row is a configuration
fault and raises a plain exception (an honest 500), not a TY refusal.

### D5. Lifecycle writes are SQL functions (ADR-0013 decision 1 applied)

Receive, cost entry and disposal each carry genuine rules (policy gating,
state-transition legality, `rand_per_mm` computation, tyre-state/event sync),
so they are SQL functions shaped like `app.submit_inspection`, not
parameterised inserts. All are `SECURITY INVOKER` (the default): they run as
`app_rw` inside the tenant-bound transaction, so RLS binds. This is an
application of ADR-0013, not a new decision — no new ADR.

- `app.receive_tyres(jsonb) RETURNS TABLE (tyre_id uuid, display_code text)` —
  single and bulk in one atomic call. Rules: GENERATED + hand-typed code →
  **TY011**; FREE + no code → **TY011** (different message); quantity > 1 with
  a hand-typed code → **TY011**. Computes `rand_per_mm` via the one permitted
  implementation, `app.rand_per_mm(price, new_tread, app.current_removal_threshold_mm())`,
  NULL when unpriced (→ awaiting-cost queue, `v_tyre_awaiting_cost`,
  FR-TYR-041). Writes the tyre row (`IN_STOCK`), a `RECEIVED` event
  (`to_state 'IN_STOCK'`) and a dated `BRANDED` event
  (`payload {"display_code": ...}`) — the freeze point of the vocabulary.
- `app.set_tyre_cost(uuid, numeric, app.cost_source)` — discharges the
  awaiting-cost queue; recomputes `rand_per_mm`; refuses a re-price with
  **TY013** (a correction later is a decision this slice does not take).
  No event: cost entry is not a lifecycle transition. **Amended after the
  whole-branch review:** it also refuses a tyre in one of the three terminal
  states (TY013). This design originally specified no state guard; costing
  recomputes `rand_per_mm`, so allowing it on a tyre that has left the estate
  rewrites the rate behind valuations already taken against it. A `FITTED`
  tyre stays costable — it is still in `v_tyre_awaiting_cost` (CFL-002).
- `app.dispose_tyre` likewise refuses an `occurred_at` in the future or
  earlier than the tyre's last `to_state` event (TY012), which is the same
  ordering invariant `receive_tyres`' stamp clamp protects from the other
  end. Unreachable through today's handler, which passes `now()`; it binds
  if TYRE-92 ever builds a backdating surface.
- `app.dispose_tyre(uuid, app.tyre_state, reason, proceeds, occurred_at)` —
  Appendix C transitions: `SOLD` from `REMOVED` only (TYRE-91 verbatim);
  `SCRAPPED`/`LOST` from `IN_STOCK` or `REMOVED`. Anything else — including
  an unknown or cross-tenant id, which RLS makes indistinguishable from
  missing — is **TY012**, message naming the tyre's current state where there
  is one. `SCRAPPED` requires a reason; `SOLD` requires proceeds (guarded as
  TY012 ahead of the CHECK, so the message is ours). Locks the tyre row
  `FOR UPDATE`, appends the event, updates `tyre.state` — the one place state
  and event move together. The rejected-casing scrap path (zero casing value)
  is TYRE-93's, not here.
- `app.tyre_for_code(text, date) RETURNS SETOF uuid` — the FR-TYR-042 dated
  lookup: latest `BRANDED` event per tyre on-or-before the date must equal
  the code. Historical reuse returns the right tyre per date; two active
  matches return both rows — the API and screen surface the ambiguity, never
  auto-resolve (FR-TYR-043). The *observed*-duplicate exception (FR-EXC-041,
  raised from capture) is later work; the unique index already refuses
  *creating* the duplicate.

New SQLSTATEs, all ours (TY class forwards verbatim per ADR-0012):
**TY011** display-code policy refusal (D12) · **TY012** invalid tyre lifecycle
transition · **TY013** cost already recorded. All three map to 422 in
`submitStatus`. **TY009 does NOT get an entry in this slice** — TYRE-88
rewrites the trigger but no HTTP path reaches it until TYRE-92 writes the
first fitment; an entry now could carry no test able to fail (ADR-0012's
deferral, discharged by slice 2, not here).

### D6. The API surface

All four endpoints gated on `ManageAssets` (TYRE-91: "gated on `ManageAssets`,
never a role name"); money fields (`purchasePrice`, `randPerMm`,
`casingValue`) are projected out server-side unless the actor holds
`ViewValuation` (FR-AUT-005a, NFR-SEC-006) — omitted from the JSON, not
nulled. Money travels as strings, per api/CLAUDE.md.

**Depot scope is deliberately not applied to `GET /api/tyres`:** a
DEPOT_MANAGER holds `ManageAssets` at `ScopeDepot`, and `v_depot_tyre`
(000014) exists, but the register answers tenant-wide here — the same shape
B4's writes took, and the depot-scoped path is TYRE-76's open scope
question, not this slice's. Do not "fix" it in passing.

Also deliberate: `app.tyre_for_code` filters through
`app.tyre_in_estate_asof` — a disposed tyre's latest `BRANDED` event
matches its code forever, but a tyre out of the estate on the date is not
"carrying" the code; without the filter every historical-reuse lookup after
a disposal returns two tyres.

- `GET /api/tyres` — the register; `?awaitingCost=true` filters via
  `v_tyre_awaiting_cost`; `?code=X&on=YYYY-MM-DD` resolves through
  `app.tyre_for_code`.
- `POST /api/tyres` — receive, single or bulk (`quantity`), 201 with the
  created `{id, displayCode}` list.
- `POST /api/tyres/{tyreID}/cost` — awaiting-cost discharge.
- `POST /api/tyres/{tyreID}/dispose` — `{disposal, reason?, proceeds?}`.

`conflictCodes` gains `one_active_display_code_per_tenant` →
`display_code_taken` (TestConflictCodesNameLiveSchemaObjects covers it for
free). `GET /api/me` gains `displayCodePolicy`, read in the same
`app.tenant` query as `timezone` — the receive form branches on it.

### D7. The web surface and naming

Per the reconciliation §3, the word **"Configuration" is never used** for any
of this. Nav: the existing `/fleet` item is relabelled **Units**; a **Tyres**
item (`/fleet/tyres`, `ManageAssets`) joins it. Rigs and Fitments appear when
slice 2 builds them — no stubs. Screens: `TyreList` (register, awaiting-cost
filter, code+date lookup, inline dispose, and — added mid-build as Task 10b —
the per-row cost form, rendered only on an awaiting-cost row) and
`ReceiveTyre`
(`/fleet/tyres/new`, policy-aware: GENERATED hides the code field and offers
quantity; FREE requires the code). Dates render only through
`useTenantDate` (TYRE-89's ban is active). The e2e spec runs on `chromium`
alone (it writes rows) against **Sandbox Fleet, never BAC**.

### D8. TYRE-88 — the trigger fixes are prescribed verbatim

The TY009 pass-through gate is exactly
`TG_OP = 'UPDATE' AND OLD.fitted_odometer IS NULL AND NEW.vehicle_id = OLD.vehicle_id`
— explicitly **not** a bare `TG_OP = 'INSERT'` gate and **not** a bare
`OLD.fitted_odometer IS NULL` pass-through (the ticket says why: the first
re-breaks the backfill path, the second lets a repoint escape). The
`unit_kind` guard refuses any change **from** a known kind once history
exists — known→NULL included, the plan's deliberate strengthening beyond
TYRE-88's own wording. NULL→known backfill stays legal (CHG-027). Plus the
RAISE WARNING validation pass over legacy rows and the cosmetic
`IF EXISTS ... OR EXISTS` fold in 000024's function.

### D9. TYRE-87 — sweep mechanics

A suite section sweeps `pg_constraint` (`contype IN ('u','x')`) **and**
`pg_index` (`indisunique`) over tenant-scoped tables for keys whose first
column is not `tenant_id`, failing with the offending names, against an
explicit allowlist (each entry commented with why). Disposition rules: a key
containing a caller-chosen natural value (the closed oracle's shape) is
re-keyed tenant-first by migration; a key over opaque uuids or on a
non-tenant-scoped table is allowlisted. `valuation_snapshot (tyre_id, as_at)`
is probed empirically from the foreign tenant before its disposition is
written, per the ticket's DoD.

## Out of scope (owned, not forgotten)

| Deferred | Owner |
|---|---|
| Fit / remove / rotate / dispatch, `mount_orientation` behaviour, TY009's `submitStatus` entry | TYRE-92 (slice 2) |
| Retread return propagation, rejected-casing scrap, `LogRetread` gate's first use | TYRE-93 (slice 2) |
| Unit PATCH/retire, TY008's permanent non-entry rationale in code | TYRE-94 (slice 2) |
| `brand_pending` workshop workflow (issue-then-physically-brand) | TYRE-48 residual |
| FR-EXC-041 observed-duplicate exception from capture | exceptions work, post-slice-2 |
| "Rebalancing" as maintenance note vs event | open on TYRE-48 |

## Non-ticket deliverables (reconciliation §5)

- **SRS erratum for D12** — prepared as a row in the plan's close-out task,
  pasted by hand (SRS pages exceed the MCP's limits); **blocks TYRE-91's
  DoD**.
- **Comment on TYRE-48** re: branding honouring the policy — already
  discharged (the 30 Aug comment exists; verified in this session's fetch).
- **Fleet-tab navigation note** — absorbed into D7.
