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
