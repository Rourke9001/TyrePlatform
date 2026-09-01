# What changed, and the evidence — TYRE-97

Phase 2 and 3 of `docs/HANDOFF_refactor_audit_prompt.md`. The ledger is
`ledger.md`; the structure and layering are `architecture.md`. Branch
`TYRE-97-refactor-audit`, cut from `develop` @ `bc74262`.

## How to verify nothing changed

```
git diff --stat bc74262..HEAD -- db/migrations/    # empty
make check                                          # EXIT=0; db 108 PASS, web 338, Go 4 packages
make db-test                                        # a second, warm run: the same 108 PASS lines
make e2e                                            # needs make api-run; 22 passed at baseline
```

Every commit below was followed by a full `make check` whose db, Go and web
outcomes matched the baseline exactly. The logs are not committed; the
numbers are in "Baseline vs final".

## Actioned ledger rows

Each entry: the problem, the change, why it is behaviour-neutral, the
evidence.

### API-2 — `d932991` — `Store.Pool()`'s comment

**Problem.** The comment named health checks and connection stats as the
method's use. `healthz` never touches the store; the only callers are two
tests proving what an unbound query sees.
**Change.** The comment says that.
**Neutral.** Comment only.
**Evidence.** `make check` EXIT=0, outcomes identical.

### WEB-7 — `5ebcdaa` — one construction site for test fixtures

**Problem.** Eight hand-built `Me` literals across seven test files, six
identical `QueryClient` constructions, six `respond` helpers, three
`sentBody` helpers. `docs/lessons.md` 2026-08-31 records a required field
added to `Me` that a grep-based sweep missed at one of them.
**Change.** `web/src/test/fixtures.ts` exports `testQueryClient()`,
`me(overrides)`, `respond` and `sentBody`; every site imports them and
passes exactly the values it set before (`userId`, `displayName`, `role`,
`capabilities`, `displayCodePolicy` are all overridden where they differed
from the defaults).
**Neutral.** Test-only files; every test's inputs are unchanged.
**Evidence.** `tsc` is what proved the sweep: it failed on a second
`testClient()` call in `routes.test.tsx:139` that the edit had missed, then
passed. `npm run lint` clean (the type-aware rules web tests are subject
to). `make check` EXIT=0, 338 tests, identical.

### API-3 — `c54533e` — `writeStatus`

**Problem.** Five handlers answering 201 and `writeError` each set
`Content-Type` before `WriteHeader` — necessarily, because `WriteHeader`
locks the header map and `writeJSON`'s own `Set` would be dropped, sending
`text/plain` with every status assertion still green. Three sites carried
the rationale verbatim.
**Change.** `writeStatus(ctx, w, status, body)` in `httpapi.go` owns the
order and the comment; `writeError` and the five sites call it. The submit
handler's implicit 200 (no `WriteHeader` when `created` is false) becomes an
explicit `WriteHeader(200)`.
**Neutral.** Same headers, same status, same body at every site. An
explicit 200 and the implicit one produce the same bytes.
**Evidence.** New `TestWriteStatusKeepsContentTypeAcrossTheStatus` pins the
invariant directly; `TestWriteErrorEnvelope` unchanged and green;
`admin_test.go`, `tyres_test.go`, `capture_test.go` assert status and
Content-Type on the round trip. `make check` EXIT=0, identical. `make e2e`
re-run at the end of the branch because this is the one change on the
response path.

### API-10 — `2a2f052` — enum mirrors pinned to the schema

**Problem.** `unitKinds` and `tenantRoles` are Go copies of `app.unit_kind`
and `app.user_role` (minus `PLATFORM_ADMIN`), kept so a bad value is a 422
naming the field rather than a canned 500 (ADR-0013). Nothing asserted they
track the enum, unlike `conflictCodes`.
**Change.** `admin_internal_test.go`: `TestEnumMirrorsMatchTheLiveSchema`
reads `enum_range` on the admin connection and asserts set-equality, with
`PLATFORM_ADMIN` as a named omission that must still exist in the enum.
**Neutral.** A test; no runtime code touched.
**Evidence.** Proven able to fail: dropping `LIGHT` from `unitKinds` fails
it (`--- FAIL: TestEnumMirrorsMatchTheLiveSchema`), reverted, tree clean.
`make check` EXIT=0.

### DB-1 — `b365b4f` — the fixture derives `rand_per_mm`

**Problem.** `gen_seed_fixture.py` wrote `rand_per_mm` as the literal
`205.7100`. Suite section 7 proves `app.rand_per_mm(4319.91, 25.0, 4)`
returns that today; nothing kept the literal true if the generator's price,
new tread or threshold moved. A seed carrying the answer to the acceptance
arithmetic is a second copy of it (rule 2, `db/CLAUDE.md` "Money").
**Change.** The INSERT calls `app.rand_per_mm(4319.91,25.0,4.0)`. The three
inputs stay literals because the seed loads as a superuser with no tenant
context, so `app.current_removal_threshold_mm()` is not available there.
**Neutral.** 4319.91 / 21 is exact; the function rounds to four places and
the column is `numeric(12,4)`.
**Evidence.** Regenerating changed exactly 30 lines of the generated SQL —
three comment lines and the 27 tyre rows. After `make check` (which
regenerates and reloads), `SELECT rand_per_mm, count(*) FROM app.tyre WHERE
tenant_id = <BAC> GROUP BY 1` returns `205.7100 | 27`. Sections 7, 8
(19 / 11 / 9) and 17 green.

### DB-2 — `4550005` — six suite sections roll back their staging

**Problem.** Eight sections planted probe rows behind `IF NOT EXISTS` with
no `BEGIN`/`ROLLBACK`: on a warm `make db-test` the guarded block is skipped
— the TYRE-85 trap (`docs/lessons.md` 2026-08-27) in seven more places.
Sections 20 and 23 additionally kept assertions *inside* the guard, so on a
warm database those never ran.
**Change.** Sections 20 (all five blocks in one transaction, because the
later blocks read the first two's rows), 21's first block, 23, 24, 25 and 27
are `BEGIN;` … `ROLLBACK;`. Guards kept; every trailing
`set_config(..., false)` kept (session GUCs survive rollback). Section 23's
comment, which said the probes "stage once and persist", now says why they
are rolled back rather than deleted.
**Not changed.** Section 18 (its guards feed its own inner transaction and
month-end assertion), 19 (`T2GAP1` is read by section 27) and 21's second
block (`t2veh3` is scheduled by section 26 at `:2241` — a consumer the
static trace missed and the per-section cold run found). Each needs its
consumer to re-plant the row, which is a restructuring rather than a
bracket; left PROPOSED.
**Neutral.** The cold run is what `make check` and CI execute, and its 108
PASS lines are unchanged. The warm run now executes the wrapped sections
instead of skipping them, which is the point.
**Evidence.** One section per edit, `make db-reset && make db-test` after
each (six cold runs, all 108 PASS). Then `make db-test` warm: 108 PASS,
`diff` of the PASS lines against the cold run empty. Afterwards
`SELECT display_code, count(*) FROM app.tyre WHERE display_code IN (...)`
returns only `T2GAP1`, `T2PARK1`, `T2PROBE1` — the three unwrapped
sections' probes — and none of the six wrapped ones.

## Behaviour defects

**No product-behaviour defect was found.** The handoff's seven specific
look-fors (ledger X-1 … X-7) all came back clean: one tenant-context path,
one position-map encoding, one valuation implementation, provenance
rendered not computed, a clean outbox seam, generators that insert inputs
not rules, and prototypes that are not in the repo.

Defects in the tests and tooling, for separate tickets (suggested
summaries; not created):

| # | Repro | Expected | Actual | Ref | Suggested Jira summary |
|---|---|---|---|---|---|
| 1 | `make db-reset && make db-test && make db-test` on `develop` before this branch | Second run executes every section | Sections 18–21, 23–25, 27 skip their staged blocks; 20 and 23 skip assertions | lessons 2026-08-27 (TYRE-85) | Closed for six sections by DB-2. Remaining: **"Re-plant the probes sections 18, 19 and 21 persist so the suite is transactional end to end"** |
| 2 | Edit `db/seeds/gen_seed_fixture.py` to something `ruff` would reject; `make lint` | Red | Green — `make fmt`/`make lint`/CI never format or check Python; only the Claude Code edit hook runs `ruff` | ledger DB-11 | **"Format and lint the seed generators in make lint and CI"** — needs a pinned Python tool decision |
| 3 | Read `store.go:41` on `develop` | Comment describes real callers | Named a health check that does not use it | ledger API-2 | Closed by API-2 |

## Proposals left for a human

Ledger rows with status PROPOSED or DEFERRED: WEB-1 (is `CaptureFlow`'s
density the safety property?), WEB-3 (split `TyreList.tsx`'s three
components?), WEB-6 (a form-mutation hook once a seventh form exists),
DB-2's three remaining sections, DB-3 (assert helpers for new sections),
DB-5 (section 31 as the first extraction if the suite is ever split),
DB-11 (the Python gate).

## Baseline vs final

| Measure | Baseline `bc74262` | Final | Delta |
|---|---|---|---|
| `make check` | EXIT=0 | EXIT=0 | — |
| db suite PASS lines | 108 | 108 (cold and warm) | 0 |
| Go packages ok | 4 | 4 | 0 |
| Go top-level `Test` functions | 89 | 91 | +2 |
| web tests | 338 / 27 files | 338 / 27 files | 0 |
| e2e | 22 passed | 22 passed, against an API restarted on the final commit (the first re-run had hit the process started at baseline, which is not evidence) | 0 |
| Coverage | not measured in this repo | not measured | n/a — the gate is outcome identity, not a percentage |
| Go LOC (`api/`) | 6,696 | 6,766 | +70 (two new tests; the helper nets negative) |
| web LOC (`src/*.ts,*.tsx`) | 11,242 | 11,169 | −73 |
| `004_tests.sql` LOC | 4,049 | 4,066 | +17 (six `BEGIN`/`ROLLBACK` pairs, one comment) |
| Import cycles | 0 | 0 | 0 |
| Tracked files | 251 | 256 | +5 (`docs/refactor/*` ×3, `web/src/test/fixtures.ts`, `admin_internal_test.go`) |
| `db/migrations/` diff | — | empty | — |
| Files relocated | — | 0 | — |

Handoff commits, in order: `2d672cb` gate · `d932991` API-2 · `5ebcdaa`
WEB-7 · `c54533e` API-3 · `2a2f052` API-10 · `b365b4f` DB-1 · `4550005`
DB-2 · `62e7b06` the `/comment-audit` fixes (two comments on the branch
claimed more than held: `writeStatus` is not the only status writer, and
the enum test cited its sibling as history).
