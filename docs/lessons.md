# Lessons

Repeatable, avoidable mistakes — things that bit once and must not bite
again. This is a curated register, not a diary: an entry earns its place by
changing how we work next time. If it cannot be written as a rule, it is an
anecdote, not a lesson.

Entry format — keep each one to this shape:

```
## YYYY-MM-DD — Title
**What happened:** one or two lines.
**The rule:** the behaviour that prevents a repeat, stated imperatively.
```

Newest first.

## 2026-09-03 — A "later write predates an earlier one" refusal in an untouched e2e step is the Docker VM clock (TYRE-72)

**What happened:** four full `make e2e` runs each failed one spec, never the
same one and never one the branch touched. The decisive one was
`fitments.spec.ts`: `TY012 this tyre was fitted at 19:31:05.13; a removal
cannot predate its own fitment` on a removal posted 1.2 s after the rotation
that opened the fitment, with neither side sending an instant — both were
`now()`. `docker exec tyre-pg date` against the host drifted by up to a second
between samples eight seconds apart (-0.72, -0.03, -0.35, -0.65, +0.02, -0.33 s)
while `w32tm` showed the host itself steady; `hwclock -s` in the docker-desktop
distro and a Docker Desktop restart did not settle it. Forty minutes went on
reading fitment SQL that was correct.

**The rule:** when an e2e refusal says a later event predates an earlier one,
or a date step fails on a spec the branch did not touch, compare the
container clock to the host before opening the code:
`docker exec tyre-pg date -u +%s.%N; date -u +%s.%N` a few times. A jitter of
tenths of a second between samples is the WSL 2 VM clock, seen after a PC
restart; take CI's Browser smoke job as the e2e line and say so in the PR.

## 2026-09-03 — A gate run in the background ends a subagent's turn before the result exists (TYRE-72)

**What happened:** an implementer subagent started `make e2e` and later
`make lint` with `run_in_background` and then had nothing left to do, so its
turn ended and it reported the task with the gate still running. Its report
described a run it had never seen; the orchestrator had to resume it twice by
message to collect the real result.

**The rule:** inside a subagent, run `make check`, `make lint`, `make db-test`
and `make e2e` in the foreground and wait for them. Backgrounding is for the
orchestrator, which stays alive; a subagent's turn is over the moment it has
no foreground work, and a gate it did not wait for is a gate it did not run.

## 2026-09-03 — A "tomorrow" read off the browser clock is the tenant's today for two hours a day (TYRE-92)

**What happened:** an e2e step meant to trip `app.dispatch_tyre`'s future-date
refusal built its date from `new Date()` plus one UTC day. The guard compares
against `app.tenant_today` (Africa/Johannesburg, UTC+2), which already reads
tomorrow's date between 22:00 and 24:00 UTC, so in that window the "future"
dispatch would have succeeded and the real one after it would have refused.
The step had never been run: it was added in a fix wave and reviewed on paper.

**The rule:** a test that needs a date the tenant will call future uses a
fixed far-future literal, never arithmetic on the browser or CI clock. Any
`new Date()` in a spec that reaches a tenant-day comparison is a finding.

## 2026-09-03 — A report file's existence is not a handoff signal (TYRE-92)

**What happened:** two fix implementers were told to hold their database
gates until the valuation-verifier's report file existed. The verifier wrote
the report section by section, so the file existed while its probes were
still running against the same Postgres; the DB implementer's `make db-reset`
would have wiped a probe mid-flight had the hold not been re-sent against a
terminal marker.

**The rule:** when agents share one database, gate a handoff on a terminal
marker in the report (`VERDICT`), never on the file existing. Tell
long-running reviewers to write incrementally, since a usage-limit cut loses
an unwritten report, and tell everyone waiting on them what the last line is.

## 2026-09-03 — Suite section 39p is a coin flip between 22:00 and 24:00 UTC (TYRE-121)

**What happened:** `make db-test` passed cold and failed warm at the branch base
with `FAIL: a disposed tyre is back in the estate`, which reads as a
warm-database regression and is not one. `app.receive_tyres` stamps
`least(tenant_today::timestamptz, now())`; while the tenant calendar day runs
ahead of UTC, that cast is in the future and `least()` clamps the receipt onto
`now()` — the same instant the disposal carries. `tyre_event.recorded_at` also
defaults to `now()`, so `tyre_in_estate_asof` orders by two keys that tie and
the estate answer follows heap order.

**The rule:** before treating a 39p failure as a regression, read the clock
(`SELECT now()` in the container). Between 22:00 and 24:00 UTC the section
proves nothing either way; re-run after the UTC day rolls over. The fix is a
tie-break the two events cannot share and belongs to the merged 000031
(TYRE-121), never to the suite.

## 2026-09-03 — Parallel agents in one worktree share one git index (TYRE-92)

**What happened:** two fix-wave agents worked concurrently in the same
checkout, each staging only the files it owned. `git add <my files>` followed
by `git commit` still committed the sibling's files: `git add` and `git commit`
write and read the one `.git/index`, so anything the sibling staged in between
was swept into the commit under the wrong message and author intent. Staging by
name is not enough — the index is shared state, not per-agent.

**The rule:** when more than one agent shares a worktree, commit with
`git commit -m "…" -- <paths>` (the message before the `--`, the pathspec after it), which takes the working-tree contents of exactly those
paths and ignores the rest of the index. Never `git add` followed by a bare
`git commit`. Verify with `git show --stat HEAD` immediately afterwards, and if
a commit has already swallowed a sibling's work, report it rather than
rewriting history the sibling is still committing onto. A file the commit is
creating needs `git add -N <file>` (intent-to-add) first, or the pathspec
matches nothing and the commit fails; intent-to-add stages no content, so the
pathspec commit still takes the working tree and still ignores whatever a
sibling has staged — it is not the `git add` this entry forbids.

## 2026-09-03 — A long-lived `make api-run` cannot survive `make e2e`'s reseed (TYRE-92)

**What happened:** `make e2e` was run against an API container that had been
serving for seven hours across earlier reseeds. `make e2e` reseeds by dropping
and re-creating schema `app`, which mints new OIDs for every enum and composite
type, but the API's pgx pool still held prepared statements and type OIDs from
before the drop. The suite failed on `admin.spec.ts` — "The unit could not be
added" on screen, `creating vehicle: ERROR: cache lookup failed for type 908424
(SQLSTATE XX000)` and `cached plan must not change result type (SQLSTATE 0A000)`
in the API log — which reads exactly like a regression in a spec nobody touched.
A restart of the same container, giving it a cold pool, made the identical suite
green.

**The rule:** restart the API immediately before `make e2e`, every time, and
never reuse one that has already served a query — one warmed request is enough,
and the first reseed is as dangerous as the fifth. When
a spec you did not touch fails with a generic "could not be added"/"could not be
saved" fallback, read `docker logs` on the API before reading the spec: a
`0A000` or `XX000` there means the process predates the schema it is querying,
not that anything in the branch is wrong.

## 2026-09-03 — A banner-delimited slice of `make db-test` output is not a stable baseline (TYRE-93)

**What happened:** the standard way of proving a slice left the pinned
sections alone — `make db-test 2>&1 | sed -n '/== 7\./,/== 9\./p'`, diffed
before and after — reported a PASS line as *missing* when nothing had
changed. `\echo` banners go to stdout and psql's `NOTICE` lines to stderr, so
`2>&1` interleaves two streams whose relative order is not fixed: the last
`NOTICE` of section 18 printed one line after the `== 19.` banner on the
second run and fell outside the range. Chasing it as a real regression costs
a reset cycle; believing it costs more.

**The rule:** diff the ordered `NOTICE`/`PASS` stream, never a
banner-delimited range. `diff <(grep PASS before.log) <(grep PASS after.log)`
with the new section's own lines filtered out is order-stable and covers the
whole suite; slice it with `sed -n '/<first pinned PASS text>/,/<last>/p'` on
that stream if a section-scoped diff is wanted.

## 2026-09-03 — An idempotency guard makes a "does nothing after X" assertion vacuous (TYRE-94)

**What happened:** `app.generate_inspection_tasks` skips any unit that
already holds an OPEN or ESCALATED task, so "park the unit, generate again,
no new task appears" passed even with the `v.status = 'ACTIVE'` filter
deleted — the second call creates nothing for any unit, parked or not, so the
assertion could not have caught the regression it was meant to guard.

**The rule:** before asserting that a filter excluded something, clear
whatever the guard keys on (here: cancel the existing tasks, and move the
as-of date past the due-date window) and pair the claim with a control the
same call still acts on. If the assertion cannot fail when the rule under
test is removed, it is testing the guard, not the rule.

## 2026-09-03 — A date-driven event instant needs a floor at the tyre's own history, not just today (TYRE-93)

**What happened:** `dispatch_tyre`'s event instant was `least(p_sent_on::timestamptz, now())`, cast in the session's time zone rather than the
tenant's, which stamped a same-day dispatch at midnight — behind the removal
it follows. `app.tyre_in_estate_asof` then read `REMOVED` while
`app.tyre.state` read `AT_RETREADER` for the gap between midnight and the
removal's real timestamp: two views of the same tyre disagreeing about where
it was.

**The rule:** a date-driven event instant is `now()` when the date equals
the tenant's today, otherwise `least(date::timestamptz, now())` cast in the
*tenant's* zone — and the function must refuse the write when that instant
is earlier than the tyre's latest recorded movement, rather than clamping to
it (a clamp ties two events at the same instant, which makes
`tyre_in_estate_asof` ambiguous). Applies to any event whose caller supplies
a date rather than a timestamp.

## 2026-09-03 — A TanStack `mutate` spy read inside `fireEvent`'s act is blind to a missing guard (TYRE-92)

**What happened:** a double-submit test asserted the mutate spy's call count
immediately after `fireEvent.click`, inside the click's own synchronous
`act()`. It read `1` whether or not the double-submit guard was present,
because neither the guard nor its absence had run yet at that point — the
assertion passed for a component that could not have failed it.

**The rule:** a mutation call count proves nothing until the mutation has
actually resolved. Assert after the success text renders (`await
findByText(...)`), not inside the event's synchronous `act`, and confirm the
assertion fails with the guard removed before trusting it.

## 2026-09-03 — "Wait for the sibling" on both sides of a shared file deadlocks (TYRE-92)

**What happened:** two agents were both told to wait for the other's commit
before touching a file they shared (`web/src/fleet/fleet.css`) mid-round.
After several minutes of polling, neither had committed, because each was
waiting on the other by the same rule. The deadlock was broken by staging one
agent's two hunks directly into the git index — built as `HEAD` plus its own
hunks only, via `hash-object`/`update-index`, never touching the sibling's
working copy — rather than committing the sibling's uncommitted work.

**The rule:** when two agents share one file in one worktree, name which one
commits first; do not tell both sides to wait for the other. If a deadlock
happens anyway, resolve it by writing only your own hunks to the index, never
by committing or reverting the sibling's working tree.

## 2026-09-03 — `scripts/check-comment-style.mjs` does not see `.css` (TYRE-110)

**What happened:** a narrating comment ("no longer …") slipped into
`dashboard.css` and passed every gate — `make lint`, the pre-commit hook, and
CI — because `scripts/check-comment-style.mjs` only checks the file
extensions it was written against, and `.css` is not one of them. The
comment-style standard (`docs/comments.md`) applies to every language in the
repo; the gate does not yet enforce that.

**The rule:** until the gate covers `.css`, check CSS comments by eye —
during review and at `/comment-audit` time — rather than trusting a clean
`make lint` to mean CSS narration was caught.

## 2026-09-01 — A staging guard with assertions inside it is a test that runs once (TYRE-97)

**What happened:** the TYRE-85 entry below recorded one suite section that
persisted its probe rows behind `IF NOT EXISTS` and so ran only on a fresh
database. A structural audit found the same shape in eight sections, and
two of them (20 and 23) kept their assertions *inside* the guard — on a warm
database those assertions were not vacuous, they were never reached. Six
were wrapped in `BEGIN`/`ROLLBACK`. The three that could not be had a
consumer of their persisted rows elsewhere in the file — one of them
(section 26 scheduling section 21's `t2veh3`) 400 lines away and missed by
a static identifier trace; only the per-section cold run caught it.

**The rule:** a suite section stages its rows inside `BEGIN;`/`ROLLBACK;`,
never behind a bare existence guard, and never puts an assertion inside the
guard. Before wrapping an existing unwrapped section, `rg` every identifier
it plants across the whole file, then wrap one section at a time with
`make db-reset && make db-test` between — a green run after each is the
attribution; a trace, from a person or an agent, is a lead. Keep the
trailing `set_config(..., false)` reset when you wrap: a session GUC
survives the rollback.

## 2026-09-01 — Renaming a CSS class is unchecked by every gate we have (TYRE-91)

**What happened:** a review commit renamed `.tyre-dispose` to `.tyres-row-form`
in `TyreList.tsx` and did not rename the eight rules in `fleet.css`. Both row
forms on the register lost their styling entirely — controls fell back to
browser defaults. `make check` and `make e2e` were green over it, because
nothing in this codebase connects a `className` string to a stylesheet:
TypeScript does not see CSS, eslint does not see CSS, and every e2e assertion
is deliberately on roles and text rather than CSS (web/CLAUDE.md, correctly).
It was found only by screenshotting the screen before and after an unrelated
change. A whole-file scan for orphaned selectors was tried as a possible gate
and abandoned: `capture.css` composes class names dynamically
(`cap-pos--${band}`), so the check is noise without real work.

**The rule:** a CSS class rename is a two-file edit — grep the old name across
`web/src` and confirm zero hits before committing. When a change touches a
stylesheet or a `className` at all, screenshot the affected screens before and
after; four of five screens being byte-identical is what makes the fifth one's
difference worth reading. Do not trust a green gate for anything visual.

## 2026-09-01 — A function parameter's `numeric(p,s)` is discarded; only a local rounds (TYRE-91)

**What happened:** `app.set_tyre_cost` and `app.receive_tyres` both computed
`rand_per_mm` through the one permitted implementation, with what looked like
identical arguments — and stored different rates for the same input.
`receive_tyres` assigns the price into a `numeric(12,2)` *local*, which
applies the type modifier and rounds to cents before the divide;
`set_tyre_cost` used its `p_price` argument directly. Postgres discards type
modifiers on parameters, so declaring `p_price numeric(12,2)` would not have
helped either — the argument arrives as bare `numeric` regardless. The
column rounded afterwards, leaving a row whose stored rate could not be
reproduced from the price stored beside it: a cent of divergence at
Appendix E magnitude, against the acceptance gate itself.

**The rule:** never rely on a parameter's declared precision — it is
documentation, not behaviour. Round money explicitly, into a typmod'd local
or with `round(x, 2)`, before any arithmetic whose result is stored. And
when two writers must agree to the cent, pin the invariant with a value that
can actually break it: the existing check used a 2dp price, which no
rounding-order bug can fail.

## 2026-09-01 — A calendar date cast to `timestamptz` can land in the future (TYRE-91)

**What happened:** `app.receive_tyres` stamped its `RECEIVED` and `BRANDED`
events at `received_date::timestamptz` — midnight of that date. Two ways
that outruns `now()`: a caller-supplied future date, which nothing bounded,
and simply being east of UTC, where the tenant's calendar day begins up to
14 hours before UTC midnight. `app.tyre_in_estate_asof` reads the *latest*
`to_state` event, so a tyre disposed afterwards kept `RECEIVED` as its
governing event and sat in the valuation estate permanently. The suite's own
section 39b had already sidestepped the hazard by pinning `received_date` to
the past — the workaround was written, the defect was not seen.

**The rule:** an event instant is `least(derived_date::timestamptz, now())`,
never a bare date cast, and a user-supplied date that drives one is bounded
against `app.tenant_today()`. Separately: comparing `occurred_at::date`
reads the session `TimeZone`, which nothing in this deployment pins — use
the `< ((d + 1)::timestamp AT TIME ZONE 'UTC')` boundary `000016` uses, so
two predicates in one `WHERE` cannot disagree by a day. And when a test
avoids a shape rather than asserting on it, ask what it is avoiding.

## 2026-09-01 — `display_code_counter` has no `ON DELETE CASCADE` on `tenant_id`, unlike every other tenant FK (TYRE-91)

**What happened:** a Task 8 test fixture (`plantGeneratedPolicyTenant`)
seeded a row in `app.display_code_counter` for a GENERATED-policy tenant,
then let `plantTenant`'s existing `t.Cleanup` delete the tenant as usual.
Cleanup failed on `display_code_counter_tenant_id_fkey` (23503). Every other
tenant-scoped table in the schema declares `tenant_id ... REFERENCES
app.tenant(id) ON DELETE CASCADE` (migration 000001 onward); migration
000030's `display_code_counter` is the one exception, plain `REFERENCES
app.tenant(id)` with no cascade.

**The rule:** any test (or future write path) that plants a row in
`app.display_code_counter` must delete it explicitly before the owning
tenant is deleted — register the counter's own `t.Cleanup` after the
tenant's, since `t.Cleanup` runs LIFO. Do not assume a tenant delete cascades
through every tenant-scoped table in this schema; `display_code_counter` is
the one it does not.

## 2026-09-01 — Two refusal branches sharing a SQLSTATE make a cross-tenant probe vacuous (TYRE-91)

**What happened:** suite section 39l probed cross-tenant isolation by calling
`app.dispose_tyre` on another tenant's tyre and expecting `TY012`. The chosen
fixture tyre was seeded `FITTED`, which `dispose_tyre` *also* refuses with
`TY012` on its own terms (an invalid source state for the disposal
attempted), independent of RLS. A follow-on RLS audit ran the probe with RLS
bypassed and it still printed PASS: the row leaked, but the state check fired
before anyone could tell, and the shared SQLSTATE hid it. The fix needed two
parts, and either alone would still be vacuous — matching the caught error's
message text against the RLS-correct branch's exact string (`'no such tyre in
this fleet'`), *and* a second, independent probe (`set_tyre_cost` on the same
row) whose refusal comes from a different function and a different SQLSTATE
entirely, so the section does not rest on message-text matching alone.

**The rule:** a cross-tenant refusal probe must target an operation whose
*observable outcome* genuinely differs between "RLS correctly hid the row"
and "RLS leaked the row but something else also refused it" — asserting only
a shared SQLSTATE is not enough, because two different code paths can raise
the same SQLSTATE for entirely different reasons. Before trusting such a
probe, check whether the fixture row would independently fail the same
check for a non-RLS reason, and if there is any doubt, add a second probe
through a different function so no single error code (or message string) is
carrying the whole proof. Extends the 2026-08-20 "a test that cannot fail is
worse than no test" entry and the 2026-08-28 WITH-CHECK-mask entry: same
family — a security-relevant assertion that passes for the wrong reason.

## 2026-09-01 — A flow narrated in a plan is a claim about UI, not a fact (TYRE-91)

**What happened:** B5's Task 13 brief described an e2e flow — "set its cost
via the register's inline flow," "a hand-typed code shows the TY011
message," "scrap it and see it leave the active register" — that read as
settled fact but wasn't: no landed task had built a cost-setting control,
Task 11's own DoD required the hand-typed code field be *absent* under
GENERATED (so nothing could ever type into it), and the register has no
"active only" filter to leave. All three surfaced only by reading Tasks
10/11/12's actual briefs and the landed component files line by line, not
by trusting the plan's prose.

**The rule:** before writing a spec against a flow a plan narrates, check
each step against the specific task brief that was supposed to build that
step's UI surface — not against the plan document's description of the
flow. A plan's prose is written once, ahead of implementation, and nothing
re-verifies it against what actually landed; the task briefs and the
component source are the only things that do.

## 2026-09-01 — A ban proven against the forms that were written is unproven against the forms that are reachable (TYRE-95)

**What happened:** B4.5's rule 6 lint gate banned the `toLocale*` methods and
proved each selector with a planted violation. Every plant was a form already
in the tree, and three routes to the same browser-zone formatting sailed
past: `Intl.DateTimeFormat(...)` called without `new` (ECMA-402 permits it),
`const { DateTimeFormat } = Intl`, and aliasing `Intl` itself. TYRE-95 closed
them with two further selectors, each proven by its own plant.

**The rule:** when banning behaviour with an AST selector, enumerate the
syntactic routes the platform offers to that behaviour — call-without-`new`,
destructuring, aliasing, bracket access — and plant one violation per route,
not per selector written. Extends the 2026-08-20 "prove the test can fail"
entry: these plants did fail, but only against the shapes someone had
happened to type, which proves the selector, not the ban.

## 2026-09-01 — A migration that renames a schema object orphans every Go string naming it (TYRE-95)

**What happened:** migration 000027 folded email uniqueness to
`(tenant_id, lower(email))`, replacing the unique index the reactivate race
translates through. `conflictCodes` kept the old index name as its key, so
the new index's `23505` would no longer map to the intended refusal, and a
full green `make check` said nothing — no test drove the race into the
renamed index. Review caught it; the fix re-keyed the map and added
`TestConflictCodesNameLiveSchemaObjects`, which resolves every key against
the live schema.

**The rule:** when a migration renames, replaces or drops a named schema
object, `rg` the Go tree for the old name as a string literal before calling
the migration done — error translation couples to names the compiler never
checks. Any new map keyed on schema object names needs a test that resolves
its keys against the live schema, as `conflictCodes` now has.

## 2026-09-01 — A post-merge review that skips the PR body re-reports the author's recorded decisions (TYRE-95)

**What happened:** the TYRE-95 review read B4.5's diff and its plan and
raised its findings; four of them were decisions PR #37's body had already
recorded as accepted, the transient UTC flash on `/my` among them. Each cost
an adjudication round to separate from the real defects.

**The rule:** hand a post-merge reviewer the PR body alongside the diff, and
read it before writing findings. A decision the author recorded there is
context — challenge it explicitly as a disagreement if it is wrong, never
re-report it as a discovery.

## 2026-08-31 — A grep cannot answer "have I updated every construction of this type"

**What happened:** TYRE-89 made `timezone` a required field on `Me`. The plan
named three fixtures to patch; an implementer searched the tree and reported
"exactly three, no fourth"; a reviewer then searched independently and
confirmed it. All three were wrong. A fourth lived at `routes.test.tsx:12` as
`const actor = (capabilities: string[]): Me => ({ … })` — an arrow factory,
which shares no searchable shape with an annotated object literal, and which
a fixture could dodge entirely by carrying no annotation at all. `tsc` found
it in seconds and the branch had been left not typechecking.

**The rule:** when a change makes a field required on a shared type, find the
call sites with the typechecker, never with a search — `make lint` runs
`tsc`, so run it before believing the sweep is done. Never accept "I grepped
and found them all" as evidence that every construction was updated, from a
subagent or from a reviewer.

## 2026-08-31 — `make web-test` passing says nothing about eslint

**What happened:** two idioms that read as ordinary vitest cost a fix round
each in B4.5, both invisible to the test run. `String(init?.body)` fails
`@typescript-eslint/no-base-to-string`, because `RequestInit.body` is
`BodyInit` and `String()` on a `Blob` or `FormData` yields `"[object Object]"`
— which would also have made the assertion pass while testing nothing.
`new Promise(() => {})`, the usual "request that never settles", fails
`@typescript-eslint/no-empty-function`.

**The rule:** run `make lint` after changing any web test file, not just
`make web-test` — the type-aware rules live only there and test files are not
exempt. To assert on a stubbed `fetch` body, narrow it with a `typeof` guard
that throws, never a cast: the cast silences the linter and keeps the vacuous
assertion. To hold a request in flight, use a deferred whose executor assigns
the resolver, and release it before the test ends.

## 2026-08-31 — eslint strips a trailing period, and a transcript missing one is not a forgery

**What happened:** a reviewer compared a rule's committed message, ending
`(rule 6).`, against the implementer's pasted lint transcript, which read
`(rule 6)` with no period. It reasoned that the stylish formatter prints
messages unmodified, concluded the evidence for the lint gate was not an
authentic capture, and failed the task on that alone. Re-running the planted
violation showed eslint does strip the trailing period. The evidence had been
genuine and the code was never in question.

**The rule:** when a finding turns on how a tool formats its output, reproduce
it before acting — a minute of running beats an hour of adjudicating, and a
confident byte-level argument can still rest on a false premise about the
tool. Ask reviewers to say out loud when a finding depends on such a premise.

## 2026-08-31 — `gh pr merge` reports failure after the merge has already landed

**What happened:** `gh pr merge 35 --rebase --delete-branch` ended in
`fatal: Not possible to fast-forward, aborting.` The merge had in fact
succeeded — the failure came from gh's *post*-merge step, updating the local
`develop`, which could not fast-forward because local `develop` still pointed
at pre-promotion hashes. Re-running the merge would have hit an already-merged
PR, and reading the exit code alone would have reported the work as unmerged.

**The rule:** after any `gh pr merge` failure, check
`gh pr view <n> --json state,mergeCommit` before concluding anything or
retrying. gh's exit code covers the local housekeeping as well as the merge,
and the two fail independently.

## 2026-08-31 — A promotion through the merge button deletes the branch it promotes

**What happened:** `develop` was promoted to `main` through pull request #34.
GitHub cannot fast-forward, so it rebase-merged — rewriting all 44 hashes —
and `deleteBranchOnMerge: true` then deleted `origin/develop`, leaving the
repository with no integration branch. Nothing was lost: the trees were
identical. But every hash cited in `docs/implementation-order.md` stopped
resolving, and a local `develop` left unreset silently became a fork.

**The rule:** promote with `git push origin origin/develop:main` from a
terminal, never a pull request (ADR-0004, CONTRIBUTING.md). To check whether
two branches agree after any promotion, compare
`git rev-parse <ref>^{tree}` — **trees, never hashes**, because a rebase leaves
the tree equal and every hash different. Cut feature branches as
`git checkout -b <name> origin/develop`, naming the remote, so a stale local
`develop` cannot seed one. A ruleset now blocks deletion of `develop`; nothing
yet blocks a pull request into `main`.

## 2026-08-28 — A WITH CHECK kill can be masked by an unrelated FK (TYRE-81)

**What happened:** Task 3's proof that `app.vehicle`'s `tenant_isolation`
policy refuses a cross-tenant insert used a row built with every column but
`tenant_id` left to plausible defaults, including `created_by` left to its
`app.current_actor_id()` default (000017, DR-013). With RLS disabled to prove
the test could fail, the insert still errored — but as `23503` on
`vehicle_created_by_fkey`'s composite FK `(tenant_id, created_by)`, not
`42501` from the policy: `created_by` defaulted to the acting tenant's own
user, which cannot exist paired with the smuggled tenant_id. The kill
"worked" but proved the wrong thing — the row was never actually valid in
every way but the one under test, so RLS was never reached.

**The rule:** every audit-columned table (000017 stamped `created_by` plus its
tenant-scoped composite FK onto roughly thirty tables) needs a WITH CHECK proof
that stamps `created_by` explicitly with a real user from the *target* tenant,
not left to its default. A row that would fail on an unrelated FK regardless
of the policy under test proves nothing when the kill succeeds for the wrong
reason. Before trusting a RED, confirm which constraint produced it.

## 2026-08-28 — `package httpapi`'s own `require` function shadows testify's import (TYRE-77)

**What happened:** the B3 plan's Task 2 test code imports
`"github.com/stretchr/testify/require"` unaliased into a new white-box test
file declaring `package httpapi`. `httpapi.go:257` already defines a
package-level function `require(a auth.Actor, c auth.Capability) error` (the
capability-check helper `api/CLAUDE.md` documents). Go merges identifiers
across every file sharing one package name, so the build fails:
`require already declared through import of package require`. The plan was
written and tested against a description of the file, not the file itself.

**The rule:** any new `package httpapi` (not `httpapi_test`) file that needs
testify's `require` must alias the import — `req "github.com/stretchr/testify/require"`
— exactly as `ratelimit_test.go` already does, with the same explanatory
comment. This is a permanent property of the package, not a one-off typo:
every future white-box test file in `internal/httpapi` hits it. Check for an
existing same-name package-level identifier before trusting a plan's
unaliased import block for an internal test file.

## 2026-08-27 — A guarded, non-transactional test section is dead on a warm database (TYRE-85)

**What happened:** `TY009` should have refused suite section 24's odometer-less
fitment immediately — the section hangs it on a unit the seed declares `HORSE`.
Two full `make db-test` runs passed with the migration applied and the defect
live. Section 24 wraps its inserts in `IF NOT EXISTS (… 'T2TRL1')` and, unlike
sections 29–34, is not `BEGIN`/`ROLLBACK`-wrapped, so its rows persisted from an
earlier run and the whole block was skipped. Only `make db-reset` ever ran it.
The same shape hides any regression in every guarded section of the suite.

**The rule:** a suite section that persists rows behind an existence guard is
only exercised on a fresh database. Verify anything touching one with `make
db-reset && make db-test`, never `make db-test` alone — and when a new
constraint plausibly conflicts with existing fixtures, reset before believing a
green run. `make check` does reset, which is the reason it is the gate and a
bare suite run is not.

## 2026-08-27 — The comment checker sees only tracked files (TYRE-82)

**What happened:** `node scripts/check-comment-style.mjs` was run with no
arguments over a tree holding three new, unstaged migrations and exited 0. The
migrations contained two change-narration violations. With no arguments the
script enumerates `git ls-files`, so untracked files are invisible to it; the
green run said nothing about the only files under review. `make lint` inherits
the same blind spot for work that is not yet staged.

**The rule:** run the comment checker with explicit paths when auditing new
files — `node scripts/check-comment-style.mjs <paths>` — or stage them first.
A no-argument run proves something only about files git already tracks. This
compounds the 2026-08-26 entry below: that one says a green run is not evidence
of no narration; this one says a green run may not have read the file at all.

## 2026-08-27 — A requirement declared unbuildable was never re-read (TYRE-4, CS-4)

**What happened:** the capture slice shipped the odometer field empty and
raised "FR-INS-020 cannot be built as written" to the sponsor, on the strength
of a quotation — *"optional, pre-filled… It shall never block a tyre
inspection"* — carried between documents rather than fetched. The live
requirement pre-fills a **projection** for the driver to **confirm or
correct** and records confirmed values only, which already contains the guard
the objection asked the errata to invent. The escalation, the assumption
recorded in the questions file, the PR's Decisions paragraph and a week of the
sponsor's attention were all spent on a requirement that says something else.

**The rule:** before declaring a requirement contradictory, unbuildable or in
conflict with another, fetch its current text from Confluence and quote it in
full. An ellipsis in a quotation is where the answer usually was. This costs
one MCP call; not doing it costs a sponsor round trip and a build of the wrong
thing.

## 2026-08-27 — A window with one bound answers a different question (TYRE-66)

**What happened:** FR-INS-038's duplicate guard bounded its interval below
only. Every test asked whether a later capture was refused, so the whole suite
agreed with a predicate that would silently discard any capture arriving out
of order — which, behind a durable outbox, is the ordinary case rather than
the exotic one.

**The rule:** when a rule is about the distance between two events, test it in
both directions. A test suite that only ever plants the older event first
cannot see a missing bound, and "within N hours of each other" is symmetric
whatever order the payloads happen to arrive in.

## 2026-08-26 — A sibling agent's commit is indistinguishable from a human's (TYRE-4)

**What happened:** a subagent resumed, found HEAD had moved past its own commit,
read the author as `Rourke Amiss` and concluded the repo owner was working
alongside it. It then declined to run `make check`, reasonably not wanting to
reseed a person's live database to verify their in-progress commit. The commit
was another subagent's, dispatched by the same controller. Every agent commits
under the repo's configured git identity, so authorship cannot tell a sibling
from a person.

**The rule:** when HEAD has moved unexpectedly, do not infer a concurrent human
from the commit author — it is the same name either way. Ask the controller, or
read the commit message and the ledger, which name the task that produced it. A
gate declined on a wrong premise costs a verification the work needed; the
caution is right, the inference is not.

## 2026-08-26 — A mutation check is only as wide as the run you check it with (TYRE-4)

**What happened:** an implementer proved a fixture change had strengthened the
suite by mutating a key function and reporting "4 failed across 3 files". Run
against the whole suite the same mutation failed **5 tests across 4 files** — the
subset had simply not contained the fourth. The error was harmless in that
direction, but the same habit run the other way concludes "nothing catches this"
from a subset that merely did not include the test that does, and buys a
redundant test or a wrong claim about coverage.

**And a mutation outlives the agent holding it.** A later session had one killed
by a rate limit mid-check; it left `DRAFT_KEY = "current-v2"` live in the working
tree, in the file carrying this branch's most load-bearing fix. Its own report
said only that it had begun reading — nothing in what it returned revealed the
edit.

**The rule:** run a mutation against the **whole suite**, never a file subset and
never `-t`. The count is the evidence, and a count from a filtered run is
evidence about the filter. Revert it immediately — never hold one across a
long-running command — and prove the tree is clean with `git status
--porcelain`. Whoever dispatched the agent checks the tree too, and checks it
hardest when the agent died: a killed process reverts nothing, and the diff it
leaves reads exactly like intended work.

## 2026-08-26 — Position ids repeat across units of the same axle configuration (TYRE-4)

**What happened:** the capture client keyed the draft, its React mirror, the
diagram lookup, the done set and the review index on `position_id` alone.
`app.position` belongs to an axle *configuration*, not to a vehicle, so the two
links of an ordinary superlink share every position id byte for byte. One
trailer's readings overwrote the other's, tapping one link's cell opened the
other's sheet under the wrong fleet number, and the submit carried 20 readings
where the driver had entered 29 — with the header still reading "29 of 29 done".
The unit suite could not have caught it: every multi-unit fixture in it gave
each unit distinct position ids, which is the one shape the real fixture never
produces.

**The rule:** never key client state on a position id alone. The identity of a
reading is the pair `(position_id, vehicle_id)`, which is what `app.reading`'s
`UNIQUE (inspection_id, position_id, vehicle_id)` has said since 000001. Build
every multi-unit fixture from two units of the *same* configuration so they
share ids — that is the ordinary superlink, and a fixture with per-unit distinct
ids is blind to this whole class of bug.

## 2026-08-26 — A wrapper reports its own exit code, not the gate's (TYRE-4)

**What happened:** twice in one session, a failing `make check` was reported as
success. First as `make check | tail -60`, which exits with `tail`'s status —
this shell runs without `pipefail`. Then, subtler, as
`(make check > log 2>&1; echo "EXIT=$?" >> log)`: the subshell exits with the
status of `echo`, so the tool reports 0 no matter what `make` did. That one reads
like a harness bug and is not one — the wrapper genuinely succeeded.

**The rule:** never judge a gate by the exit status of anything wrapping it — a
pipeline, a subshell, a backgrounded compound. Write the status into the artifact
and read it back from there: `make check > check.log 2>&1; echo "EXIT=$?" >>
check.log`, then `grep EXIT= check.log`. The reported status of the outer command
answers a different question from the one being asked.

## 2026-08-26 — A green comment-style run is not evidence of no narration (TYRE-4)

**What happened:** `scripts/check-comment-style.mjs` flagged a comment reading
"used to have" but passed two others in the same commit reading "used to render"
and "One entry read…", which narrate a change just as plainly. Its
change-narration verb list is deliberately narrow — the checker's stated posture
is precision over recall, so it catches the phrasings it knows and stays silent
on the rest rather than drowning real code in false positives.

**The rule:** treat the comment gate as a floor, not a ceiling. Before closing a
branch, read the comments the diff adds and ask of each whether it explains a
constraint or merely narrates the edit — `/comment-audit` exists for this. Do
not widen the checker's patterns to catch a phrasing you just hit: precision is
the design, and a noisy gate gets ignored, which is worse than a narrow one.

## 2026-08-26 — `dexie-react-hooks` will not typecheck here, and the reason is not in its own types (TYRE-4)

**What happened:** a plan called for `npm install dexie-react-hooks` to get
`useLiveQuery`. The package ships `useDocument.d.ts`, which imports `y-dexie`
and `yjs` — optional peers nothing here uses. `web/tsconfig.json` deliberately
has no `skipLibCheck` (only `tsconfig.e2e.json` sets it, with a comment
explaining why that one is the exception), so `tsc` fails `TS2307` on
declaration files belonging to a package the code never calls. The obvious
escapes are both wrong: `skipLibCheck: true` relaxes type checking for the whole
app to accommodate one hook, and installing `yjs`/`y-dexie` adds two unused
runtime dependencies.

**The rule:** for a live Dexie query in this repo, subscribe to Dexie's own
`liveQuery` through `useSyncExternalStore` rather than adding
`dexie-react-hooks` — it is the same subscription `useLiveQuery` wraps, in about
twenty lines and no new dependency. More generally: before adding a dependency
for one hook, check what its `.d.ts` files import, because `skipLibCheck` is off
here and a transitive optional peer will fail the build.

## 2026-08-26 — A wall of identical failures in untouched files is a resolution bug, not a regression (TYRE-4)

**What happened:** a reviewer ran `npx vitest run` from the repo root while
other vitest processes were running. `npx` resolved a *different* vitest than
the project's pinned one and ran from the wrong working directory, so it picked
up files vitest normally excludes (the Playwright e2e spec among them) and every
test failed identically on `document is not defined` and
`__APP_VERSION__ is not defined` — including files the change under review never
touched. Read at face value it looks like the branch is broken end to end.

**The rule:** run the web suite through the project's own scripts from `web/`
(`cd web && npx vitest run`, or `make check` from the root), never `npx vitest`
from the repo root. When a run fails in files the diff does not touch, and fails
the same way in all of them, suspect the runner's resolution and working
directory before you suspect the code — check the reported vitest version
against `package.json` first.

## 2026-08-26 — testing-library's fake-timer detection only looks for a `jest` global (TYRE-4)

**What happened:** the first `userEvent` call after `vi.useFakeTimers()` hung
forever, and the obvious diagnosis — a wrong `toFake` list — was wrong.
`@testing-library/react`'s `asyncWrapper` drains microtasks after every
`userEvent`/`waitFor` call through a real `setTimeout(resolve, 0)`, and advances
a fake clock to fire it only if it detects fake timers. Both
`@testing-library/react/dist/pure.js` and `@testing-library/dom/dist/helpers.js`
gate that detection on `typeof jest !== "undefined"`. Vitest has no `jest`
global, so the advance is silently skipped and the awaited promise has nothing
left to resolve it. Changing `toFake` cannot reach this: the pending call is
real whatever is faked.

**The rule:** a Vitest project combining `vi.useFakeTimers()` with
`@testing-library/react` needs a `jest` shim in shared test setup, satisfying
the detection gate without claiming to be jest. `web/src/test/setup.ts` already
carries one — do not remove it, and do not diagnose a fake-timer hang by
reaching for `toFake` first.

## 2026-08-26 — `vi.advanceTimersByTimeAsync` fires timer callbacks outside `act()` (TYRE-4)

**What happened:** a test drove a component's 200ms auto-advance with
`vi.advanceTimersByTimeAsync` and then read the DOM. testing-library's `act()`
wrapping applies only to its own APIs, so the `setState` the timer callback
triggered never flushed. The DOM kept showing the pre-timer field, every
`aria-current` read after it was stale, and a helper that branched on that
attribute took the wrong branch — a green test over an entry path no driver
takes.

**The rule:** wrap every `vi.advanceTimersByTime`/`advanceTimersByTimeAsync`
that can fire a React state update in `await act(async () => { ... })`. A bare
advance is only safe when nothing it fires touches component state.

## 2026-08-26 — A finished subagent cannot be resumed unless you wrote its id down (TYRE-4)

**What happened:** a task review came back with changes requested, and the
process prescribes resuming the same implementer for the early fix rounds so
it keeps its context. The agent id was not in the ledger, and a completed
in-process subagent does not appear in `ListAgents` — that lists peer sessions,
not finished children. Several turns went into hunting temp transcript files by
modification time and guessing from an empty output file, then the round was
dispatched to a fresh agent anyway, which had to re-derive context the original
already had.

**The rule:** record a dispatched subagent's agent id in the ledger on the same
line as the commit it produced, at dispatch time, not when you next need it.
The id is unrecoverable once the agent finishes and your own context has moved
on, and every recovery route from there is a guess.

## 2026-08-26 — Fake timers deadlock IndexedDB, and the failure lands on the wrong test (TYRE-4)

**What happened:** a heartbeat test called `vi.useFakeTimers()` with no
`toFake` restriction. Dexie and `fake-indexeddb` complete their requests on a
real `setTimeout`, so faking it deadlocked every IndexedDB operation and the
test hit vitest's 5s timeout. The timeout fired *before* the test's own
`vi.useRealTimers()` line ran, so fake timers leaked into the next
`beforeEach`, which hung on `db.open()` — cascading into five more failures in
unrelated `describe` blocks. The real defect was in one test; the report showed
six, none of them obviously the culprit.

**The rule:** when faking timers around code that touches IndexedDB, restrict
`toFake` to exactly what you need (`["setInterval", "clearInterval", "Date"]`),
do the IndexedDB setup under real timers before switching, and **wait for the
condition rather than for a fixed number of ticks** before asserting on
fire-and-forget async work — `vi.waitFor(...)`, not one
`await new Promise((r) => setTimeout(r, 0))`. A single real tick is enough on an
idle machine and not enough under a loaded full-suite run, where the same
sequence needs several: a fixed sleep there is a flaky test that teaches people
to re-run the suite, which is how a real regression gets waved through. (This
sentence originally prescribed the single tick, and that advice produced exactly
such a flake in the outbox heartbeat test.) Always put `vi.useRealTimers()` in a
shared
`afterEach`, not only at the end of the test that enabled them: a test that
times out never reaches its own cleanup, and leaked timer state misattributes
the failure to whatever runs next.

## 2026-08-26 — The column definition in 000001 is not the schema (TYRE-4)

**What happened:** a reviewer read `app.inspection.odometer bigint NOT NULL` in
`000001_init.up.sql` and raised a blocking finding that a null-odometer payload
would die on a `not_null_violation`. Migration `000011` had dropped that
constraint eleven migrations earlier; the live schema reports the column
nullable, and the db suite already covers trailer inspections recording without
one. The finding would have produced a ticket and a spurious blocker.

**The rule:** in a repo with a migration chain, the initial migration states
what a column *was*, never what it *is* — later migrations relax and re-tighten.
Before asserting a constraint exists, query the running database
(`information_schema.columns` via `docker exec tyre-pg psql`), or at minimum
grep the whole of `db/migrations/` for later `ALTER`s on that column. One file
is never the answer.

## 2026-08-26 — A handed-over derived value is a hypothesis, not a fact (TYRE-4)

**What happened:** three times in one branch, a value derived by the controller
and handed to an implementer as settled turned out to be wrong — a test count
stated as eleven that a `grep -c` showed was thirteen, and a predicted mutation
result of `Infinity` that was really `100`, because a clamp added in the same
ruling absorbed it. Each time the implementer caught it only because it re-ran
the derivation instead of transcribing the number.

**The rule:** hand over the derivation, not just the result, and say which
values are expected rather than observed — an implementer can only check
reasoning it can see. Count with a command, never by eye. When a prediction and
an observation disagree, work out why before assuming the observation is the
error: the mismatch above exposed that two guards were each load-bearing for a
different failure, which the original reasoning had missed.

## 2026-08-26 — An expected value can be correct and still prove nothing (TYRE-4)

**What happened:** a boundary expectation was derived by hand, verified to be
the value the code really produces, and handed to an implementer — and the
assertion built from it still could not fail. Asserting `pressureKpa === null`
for a guarded pressure field held whether or not the guard existed, because
removing the guard wrote its bad value into a *different* field.

**The rule:** correctness and discriminating power are two different
properties, and checking the first does not give you the second. For every
assertion, name the mutation it is supposed to catch and confirm that mutation
would flip it. Extends the 2026-08-20 entry below beyond security tests: prove
the test can fail, not just that it currently passes.

## 2026-08-26 — A comment restating the intent reads as done work (TYRE-4)

**What happened:** an implementer was handed a boundary case — "type the full
`1200`, it must not settle at three digits" — and produced a test carrying that
sentence as its comment and its title, while typing `120`. The result was a
byte-for-byte duplicate of the test above it, so the sharpest case in the file
was the one case with no coverage, and both the implementer's self-review and a
skim of the diff read it as done.

**The rule:** hand over the literal input and the complete list of assertions,
never the intent alone — an intent restated in a comment is indistinguishable
from an intent implemented. When reviewing a test, read its *inputs* against
its *name*; never let its comment stand in for either.

## 2026-08-26 — A plan that states an interface twice will state it wrong once (TYRE-4)

**What happened:** three separate times on one plan, a task's summary
"Interfaces"/"Files" block disagreed with the verbatim code in the same task's
implementation step — a component attributed to the wrong task, a consumed type
the code never imports, and a required `meta` field omitted. Each would have
produced a wrong file list or a missing dependency if followed.

**The rule:** where a plan describes an interface in prose and also shows the
code, the code wins — check the two against each other before dispatching, and
treat a prose/code disagreement as a defect in the prose, not a choice. Never
build a file list from a summary block alone.

## 2026-08-20 — A tool silently ignoring config is not enforcement (TYRE-21)

**What happened:** `web/.npmrc` set `min-release-age=14`, but the npm bundled
with Node 22 predates the key and ignores unknown config without a warning.
The supply-chain gate read as configured while enforcing nothing. Worse,
`npm config get` echoes the value back even on an npm that ignores it.

**The rule:** never verify a control by checking its configuration is
present; verify the enforcing tool's version supports it, or better, test
the artefact the control is supposed to protect. Presence proves the file
was read, not that anything is enforced.

## 2026-08-20 — A test that cannot fail is worse than no test

**What happened:** the RLS isolation suite passes vacuously when run as a
superuser — every assertion becomes a no-op that still prints PASS. Nothing
looked wrong until the suite was made to assert its own runtime identity
(check 0).

**The rule:** for any test guarding a security property, first prove the
test *can* fail — run it in the broken configuration, or make it assert the
preconditions that give it teeth.

## 2026-08-20 — Windows hosts lie about their toolchain

**What happened:** `python3` on stock Windows is a Microsoft Store stub that
opens a browser; Git Bash rewrites `/migrations` into a Windows path and
breaks container mounts. Both produced confusing failures far from the cause.

**The rule:** on this host, route every command through the Makefile, which
already carries the workarounds (`PYTHON` detection, `MSYS_NO_PATHCONV`).
When adding a new command, assume the host toolchain is hostile and pin the
workaround in the Makefile, not in a shell history.

## 2026-08-21 — A standard nobody's context window contains does not exist

**What happened:** a previous attempt at a comment-style document changed
nothing: generated comments kept violating it because the document was never
in context at the moment comments were written, and nothing checked the
output.

**The rule:** a convention only holds if it is either in the writer's context
at write time (CLAUDE.md) or enforced on the artefact afterwards (hook,
lint, CI) — ideally both. A standalone standards document with neither is
decoration. See `docs/comments.md` for the pattern applied.
