# Keep/Kill ledger — TYRE-97

Phase 1 of `docs/HANDOFF_refactor_audit_prompt.md`, run 1 Sep 2026 against
`develop` @ `bc74262` (tree `5927512`), the commit that merged B5 slice 1.
Companion pages: `architecture.md` (dependency map, layering, structure) and
`report.md` (what was actioned, evidence, defects, baseline vs final).

**Baseline — the behaviour oracle.** `make check` EXIT=0 in 3m14s: db suite
110 PASS / 0 FAIL (last section 39t), Go 4 packages ok (89 top-level `Test`
functions), web 27 files / 338 tests; tree clean afterwards. `make e2e` 22
passed in 2m16s. Every Phase 2 commit is held to identical outcomes.

**Two things the handoff gets wrong about this repo, settled before the audit
ran.** Its ADR numbers are stale — "ADR-0004 unit-centric, 0005 tyre
identity, 0006 client, 0007 provenance" are this repo's 0007, 0008, 0009 and
0010; they were read by title. And its target layering
(`domain/application/infrastructure/interfaces`) is a generic template that
contradicts the ADR-decided inversion this codebase is built on: **the
database is the domain model** (`docs/architecture.md`), and `api/` and
`web/` are deliberately thin. The handoff's own Phase 0 forbids relitigating
ADRs and its Phase 2 says "adapt to what's actually there; don't force it",
so no row below proposes moving a rule out of SQL or splitting a tier into
layers. That is the single most important non-finding of this audit.

## Status vocabulary

`DONE` — actioned on this branch, commit cited in `report.md`.
`PROPOSED` — worth doing, left for a human decision (risk, scope, or a
question only the owner can answer). `DEFERRED` — worth doing
opportunistically, not as its own change. `REJECTED` — considered and
declined, reason given. `NONE` — informational; nothing to do.

## Cross-cutting checks the handoff named

| # | Check | Finding | Status |
|---|---|---|---|
| X-1 | Tenant scoping / RLS context set in more than one way or place | **Go: one path.** `store.InActorTx` (`api/internal/store/store.go:107`) is the only production `set_config`; `rg '\bpool\.' api/internal/httpapi` (non-test) returns nothing, so no handler bypasses the transaction. **Suite: three forms** — `SET app.tenant_id` once (`db/tests/004_tests.sql:37`), `RESET` once (`:21`), `set_config(..., false)` 107 times, `set_config(..., true)` inside wrapped blocks. Traced: every block that switches away from tenant 1 restores it as its last statement, so nothing leaks between sections today (see DB-4) | NONE (Go) / see DB-4 |
| X-2 | Position-map / axle-configuration logic duplicated between generators and app code | **Not duplicated.** `db/seeds/gen_seed_configurations.py:21-28` (`build()`) is the one encoding of the plan-view slot order — dual axle `LEFT-OUTER, LEFT-INNER, RIGHT-INNER, RIGHT-OUTER`, single `LEFT, RIGHT` (ADR-0007 rule 6) — and it lands in `app.position.sequence`. `web/src/capture/rig.ts:20-36` sorts by the served `sequence` and numbers non-spares; `CaptureDiagram.tsx:49-71` groups by `vehicleId:axleNumber`. Neither re-derives the slot order. `dashboard/AxleSchematic.tsx` is a static decorative SVG, not a projection (WEB-5) | NONE |
| X-3 | Valuation arithmetic anywhere other than one domain function | `app.tread_value` / `app.rand_per_mm` (`db/migrations/000001_init.up.sql:602`) are the only implementations. Go carries money as `*string` → `$N::numeric` (`api/internal/httpapi/tyres.go:41-43,351,395`); `rg 'decimal|float64'` finds no money use. Web keeps money a string. **One leak:** the fixture generator writes `rand_per_mm` as the literal `205.7100` instead of deriving it (DB-1) | DB-1 DONE |
| X-4 | Measured-vs-derived provenance (ADR-0010) leaking into presentation | Rendered, not computed: cost provenance is a `<select>` over `COST_SOURCES` (`web/src/api/tyres.ts:55-60`); `"unmeasured"` is a first-class `Severity` (`capture/warnings.ts`), never a zero. The client's `governingTread` (`warnings.ts:64-67`) re-derives `MIN()` for instant feedback under the three-minute constraint and is **never sent** — `payload.ts:172-173`, pinned by `payload.test.ts:83-86`. The trigger remains the sole authority (CR-011) | NONE — documented accepted duplication (WEB-8) |
| X-5 | Offline/outbox code tangled with capture UI | Clean seam. Dexie is touched only in `capture/draft.ts` and `capture/outbox.ts`; every screen goes through their exported functions. `OutboxIndicator.tsx:2` imports `liveQuery` from `dexie` but subscribes to `listOutbox()`, for the reason `docs/lessons.md` 2026-08-26 records | NONE (WEB-9) |
| X-6 | Seed/fixture scripts carrying business rules the app also carries | `gen_seed_configurations.py` inserts thresholds, bands and pressures as tenant configuration rows — inputs, not rules (rule 5 respected). `gen_seed_fixture.py` transcribes the Appendix J sheet and lets SQL derive governing tread, bands and exceptions. The one derived value it hard-codes is DB-1 | DB-1 DONE |
| X-7 | Prototype HTML that has become de facto production or is dead | `docs/prototypes/*.html` is **gitignored** (`git ls-files docs/prototypes` is empty) — a local mirror of Confluence pages 13238274 / 13271042 / 13303810, cited by `web/CLAUDE.md` as the capture interaction reference. Not in the repo, so neither `DEAD` nor deletable; nothing in `web/src` imports or copies from it | NONE |

## api/

| # | Path | Tag | Evidence | Action | Risk | Coverage | Status |
|---|---|---|---|---|---|---|---|
| API-1 | `api/internal/store/store.go:60-77` `InTenantTx` | SPECULATIVE | Zero production callers (`rg InTenantTx` → definition + 4 test hits). `api/CLAUDE.md:47-50` and ADR-0011 keep it deliberately for actor-less tenant work that does not yet exist | Leave. Removal is a product decision and must edit `api/CLAUDE.md` and ADR-0011 together | L | `store_test.go: TestInTenantTx*` | REJECTED — documented deferral |
| API-2 | `api/internal/store/store.go:44-46` `Store.Pool()` | SPECULATIVE | Doc comment names health checks and connection stats as its use; the only callers are `store_test.go:156,184` fixtures, and `healthz` (`httpapi.go:123-126`) never touches the store | Make the comment true: it serves tests and tenant-free setup | L | n/a | DONE |
| API-3 | `admin.go:262-267`, `admin.go:479-481`, `admin.go:577-580`, `tyres.go:320-322`, `capture.go:406-413` | DUP | Five sites write `Content-Type` → `WriteHeader(status)` → `writeJSON`, three of them restating the header-order rationale verbatim; `writeError` (`httpapi.go:697-701`) is the same shape with the envelope. A sixth site getting the order wrong sends `text/plain` with the status assertion still green | One `writeStatus(ctx, w, status, body)`; `writeError` and all five call it. The capture site's implicit 200 becomes an explicit 200, which is wire-identical | L | `admin_test.go`, `tyres_test.go`, `capture_test.go` assert status + Content-Type on the round trip; a direct header-order test is added | DONE |
| API-4 | `store_test.go:41,192` vs `httpapi_test.go:46,124` `plantTenant`/`plantUser` | DUP | Near-identical fixtures in two packages | Leave: a shared `testsupport` package trades honest duplication for a fixture that must serve two packages' differing needs | M if changed | they are the setup | REJECTED |
| API-5 | `httpapi.go:235-348` `submitStatus`/`conflictCodes`/`conflictMessages`/`refusalForPgError` | — | Three lookup tables consulted in sequence by one function, by ADR-0013 design; `TestConflictCodesNameLiveSchemaObjects` keeps the name map honest | None | — | `refusal_internal_test.go`, `httpapi_test.go` | NONE |
| API-6 | `capture.go:380-398` Go-side `errVehicleNotVisible` and SQL `TY007` | — | Two guards, one code, by ADR-0012 design: a depot-scoped actor is caught in Go, a tenant-scoped one in SQL | None. Flagged so nobody "simplifies" it into one path and widens what a driver can submit against | — | `capture_test.go` | NONE |
| API-7 | `admin.go:355-363` `mayCreateRole` beside `require` (`httpapi.go:417-422`) | REFACTOR-NOT-WORTH | A second gate for the one capability (D9 `InviteDriver`) whose grant depends on the target role | Leave; folding it into `require` would add a role parameter to 13 call sites for one caller | L | `admin_test.go` createUser matrix | REJECTED |
| API-8 | money in Go | — | No `decimal`, no `float64` on money; `PurchasePrice`/`RandPerMm`/`CasingValue` are `*string` end to end | None | — | `tyres_test.go` | NONE |
| API-9 | tenant context in Go | — | One binding path; no bare-pool query in any handler | None | — | `store_test.go`, `httpapi_test.go` | NONE |
| API-10 | `admin.go:167` `unitKinds`, `admin.go:303-306` `tenantRoles` | EARN-ITS-KEEP | Go mirrors of `app.unit_kind` and `app.user_role` (minus `PLATFORM_ADMIN`), kept so an invalid value is a 422 naming the field rather than a canned 500 (ADR-0013 decision 5). Nothing asserts they track the enum — unlike `conflictCodes`, which has `TestConflictCodesNameLiveSchemaObjects` | Pin each map to `enum_range` of the live type, the same pattern ADR-0013 established for constraint names | L | UNCOVERED → covered by the new test | DONE |
| API-11 | `capture.go:134-316` `loadCaptureContext` (~182 lines) | REFACTOR-NOT-WORTH | Four linear query-and-scan blocks, each carrying a load-bearing business comment; one caller | Leave; a split improves the size table and nothing else | L | `capture_test.go` | REJECTED |
| API-12 | `admin.go:370-483` `createUser` (~113 lines, 5-way switch) | REFACTOR-NOT-WORTH | Encodes D10's rehire state machine inside one transaction; the density is the narrative | Leave | L | `admin_test.go` | REJECTED |

## web/

| # | Path | Tag | Evidence | Action | Risk | Coverage | Status |
|---|---|---|---|---|---|---|---|
| WEB-1 | `capture/CaptureFlow.tsx:40-447` (465 LOC, 14 hooks) | EARN-ITS-KEEP | The largest hotspot in the app; every hook cites the requirement that pins it in place, and `storageFault` sits above every branch because four sites raise it | Question for the owner: is one state machine in one file the safety property? Recommendation: yes — revisit only when a fifth fault source arrives | M | `CaptureFlow.test.tsx` | PROPOSED |
| WEB-2 | `capture/PositionSheet.tsx:26-346` | REFACTOR-NOT-WORTH | 8 hooks guarding StrictMode double-invoke and hold-timer races that were hard-won (`:130-134`, `:223-251`) | Leave | H if touched | `PositionSheet.test.tsx` | REJECTED |
| WEB-3 | `fleet/TyreList.tsx` (358 LOC, three components) | EARN-ITS-KEEP | `TyreList`, `DisposeForm`, `CostForm` share one file because they mutate one table's rows | Question: split into three files or keep co-located? Low payoff either way | L | `TyreList.test.tsx` | PROPOSED |
| WEB-4 | `admin/AddDriver.tsx:46-247` (two forms) | — | Deliberately sequential — a driver with no assignment reaches no capture (`:41-45`) | Leave | L | `AddDriver.test.tsx` | REJECTED |
| WEB-5 | `dashboard/AxleSchematic.tsx` | SPECULATIVE | A prop-less decorative SVG with two literal axle x-positions, mounted once (`VehicleList.tsx:101`), `aria-hidden`, named like a projection it is not yet | Leave; it is rendered, so not dead. Rename only when it becomes data-driven | L | UNCOVERED | NONE |
| WEB-6 | `admin/AddDriver.tsx:110-176,211-240`, `admin/AddUnit.tsx:50-126`, `fleet/ReceiveTyre.tsx:59-151`, `fleet/TyreList.tsx:239-293,319-357` | DUP | Six forms: field state → `useMutation` clearing on success → `submit` with `preventDefault` + guard → pending-disabled button with a `"Verb…"/"Verb"` ternary → `role="alert"` refusal | The genuinely shared part is ~3 lines per site; the success paths (which fields clear, which queries invalidate) all differ, so a `useFormMutation` hook would be thin and one-implementation-per-caller. Extract when a seventh form appears | L | each site's `.test.tsx` | DEFERRED |
| WEB-7 | `routes.test.tsx:12,44,138`, `auth/RequireCapability.test.tsx:8`, `admin/AddDriver.test.tsx:13-22`, `admin/AddUnit.test.tsx:9`, `capture/CaptureFlow.test.tsx:17`, `fleet/TyreList.test.tsx:13-22`, `fleet/ReceiveTyre.test.tsx:11-20`, `time/tenantTime.test.tsx:118-126` | DUP | `new QueryClient({ defaultOptions: { queries: { retry: false } } })` six times; a hand-built `Me` eight times across seven files; a `respond(status, body)` helper six times (the two `api/*.test.ts` included) and `sentBody(call)` three times. `docs/lessons.md` 2026-08-31 records what that costs when `Me` grows a field | `web/src/test/fixtures.ts` with `testQueryClient()`, `me(overrides)`, `respond` and `sentBody`; every site passes exactly the values it set before. Test-only; `tsc` proves the sweep — and did, catching a second `testClient()` call the edit missed | L | test-only | DONE |
| WEB-8 | `capture/warnings.ts:64-67` `governingTread` | — | One client implementation, three consumers, never transmitted (X-4) | None — the reference pattern | — | `warnings.test.ts`, `payload.test.ts` | NONE |
| WEB-9 | `capture/outbox.ts` / `draft.ts` | — | The Dexie seam (X-5) | None | — | `outbox.test.ts`, `OutboxIndicator.test.tsx` | NONE |
| WEB-10 | `dashboard/AppShell.tsx:6` → `capture/OutboxIndicator.tsx` | — | The only `dashboard → capture` edge, deliberate: a driver away from the vehicle still sees the queue. Not a cycle | None | — | — | NONE |
| WEB-11 | CSS orphans | — | Every selector in `fleet.css`, `dashboard.css`, `admin.css`, `theme/*.css` and `capture.css` traced to a `className`; the two `capture.css` misses (`.cap-alert--below-removal`, `--caution`) are composed at `PositionSheet.tsx:323`. The 2026-09-01 CSS-rename lesson is not currently live | None | — | — | NONE |

## db tests, seeds, scripts, CI

| # | Path | Tag | Evidence | Action | Risk | Coverage | Status |
|---|---|---|---|---|---|---|---|
| DB-1 | `db/seeds/gen_seed_fixture.py:161` | DUP (of the acceptance arithmetic's *output*) | `rand_per_mm` is the literal `205.7100`. Suite section 7 proves `app.rand_per_mm(4319.91, 25.0, 4.0)` returns that today; nothing keeps the literal true if the price, new tread or threshold in the generator moves | Emit `app.rand_per_mm(4319.91, 25.0, 4.0)` in the generated INSERT so the seed derives the value through the one implementation (rule 2, `db/CLAUDE.md` "Money"). The stored value is identical: 4319.91 / 21 is exact | L | sections 7, 8 (19/11/9), 17 | DONE |
| DB-2 | `db/tests/004_tests.sql` §18, 19, 20, 21, 23, 24, 25, 27 | BEHAVIOUR-DEFECT (of the suite, not the product) | Eight sections plant probe rows behind `IF NOT EXISTS` with no `BEGIN`/`ROLLBACK`, so a warm `make db-test` skips the guarded block — the TYRE-85 trap (`docs/lessons.md` 2026-08-27) in seven more places. Worse, §20 (`:1296-1300`, `:1374-1406`) and §23 (`:2030-2051`) keep assertions **inside** the guard, so those never run at all on a warm database. A static trace found §20, §21's first block, §23, §24, §25 and §27 self-contained. Three are not: §18's guards feed its own pre-existing inner transaction (`:944-971`) and month-end assertion (`:990-993`); §19's `T2GAP1` is read by §27 (`v_tyre_awaiting_cost`); §21's second block plants `t2veh3`, which §26 schedules a task against — the trace's identifier search missed that one and the per-section cold run found it | Wrap each self-contained block in `BEGIN;`/`ROLLBACK;`, keeping the guards and the trailing `set_config(..., false)` resets (session GUCs survive rollback); §20's five blocks share one transaction because the later ones read the first two's rows. One section per edit, `make db-reset && make db-test` after each, then a warm `make db-test` — identical PASS lines both ways, and only the three unwrapped sections' probes remain in the database afterwards | M | the sections themselves | DONE (§20, §21a, §23, §24, §25, §27) / PROPOSED (§18, §19, §21b — each needs its consumer re-planted, not a bracket) |
| DB-3 | `004_tests.sql`, 40 hand-written `DO $$ … RAISE NOTICE 'PASS' … $$` blocks | DUP | No assert helper exists; every section restates the PASS/FAIL shape | Two helpers (`test_assert`, `test_pass`) for *new* sections only; no mass retrofit of a file whose `\echo` banners are cited by number elsewhere. Needs `CREATE FUNCTION` rights for `app_login` or a superuser preamble — a Makefile change | L | n/a | PROPOSED |
| DB-4 | `004_tests.sql` tenant-context forms (X-1) | EARN-ITS-KEEP | `set_config(..., false)` is session-scoped; a block that switched to tenant 2 and forgot to switch back would run the next section as the wrong tenant. Traced every unwrapped block §17–§27: each restores tenant 1 last. §28's "pin tenant 1 rather than inherit" (`:2374`) is defensive, not a fix for a live leak | Nothing today. Rule for DB-2's wraps: never drop the trailing reset on the grounds that rollback cleans up — it does not | — | would surface as a spurious FAIL downstream | NONE |
| DB-5 | `004_tests.sql` §31 (`:2584-3347`, 764 lines) | REFACTOR-WORTH if the file is ever split | Largest section by 1.8×, one transaction, no cross-section fixture | First extraction candidate if `db-test` becomes a manifest of files; not worth a split on its own | L | itself | DEFERRED |
| DB-6 | `004_tests.sql:2233` guard inside §26's wrap | REFACTOR-NOT-WORTH | Redundant but harmless | Leave | L | §26 | REJECTED |
| DB-7 | `Makefile` vs `.github/workflows/ci.yml` migrate-seed-test sequence (×3 in CI) | DUP (justified) | CI has no docker-in-docker Go/Python, so it re-encodes what `make db-reset` owns; actions are SHA-pinned and a local composite action is a new trust surface for three sites | Leave | L | n/a | REJECTED |
| DB-8 | `gen_seed_fixture.py:144` `"…".format(T)` among ~60 f-strings | — | Style only | Nothing | L | n/a | NONE |
| DB-9 | `004_tests.sql` §12 self-enrolling RLS sweep | — | Taken on `db/CLAUDE.md`'s word this pass; consistent with §8b/§8c | Nothing | — | itself | NONE |
| DB-10 | `scripts/check-comment-style.mjs`, `scripts/check-release-age.mjs` | REFACTOR-NOT-WORTH | Different domains, no shared logic despite "two check scripts" | Leave | L | n/a | REJECTED |
| DB-11 | `Makefile:143-144,162-166` vs `.claude/settings.json` format hook | gap | The edit hook formats `.py` with `ruff`; `make fmt` and `make lint` never format or check Python, so the two seed generators — the single source of truth for the configuration library — have no gate in `make check` or CI | Add a Python formatter/linter to `make lint` and CI. Needs a dependency decision (ruff pinned where?), so out of this branch's scope | L | UNCOVERED | PROPOSED |

## Target structure

**No relocation in any tier.** The api DAG (`auth ← store ← httpapi ← cmd/api`), the web DAG (`api ← auth/theme/time ← screens ← routes/App/main`) and the single-file suite are each already the smallest shape that holds their constraints. The handoff's `src/domain|application|infrastructure|interfaces` tree is not adopted — see the second paragraph of this page and `architecture.md`, which maps the handoff's layer names onto what the repo actually has.
