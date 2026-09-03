# Handoff — close out B5 slice 2: move the tickets, then review PR #41

*Executed 3 Sep 2026. Outcome: PR #41 reviewed, nine commits of fixes landed
(final `2533ffa`), rebase-merged to `develop`; the review report is the PR's
review comment and every open item is TYRE-128 (with TYRE-124..127). Kept
beside `HANDOFF_b5_slice2_prompt.md` as the record of how the batch closed;
whether prompts of this kind stay in `docs/` is TYRE-128's question 4.*

Paste everything below the line into a fresh Claude Code session opened at
the repository root. Orchestrator model: **Fable**. Every reviewer: **Opus**.
Mechanical fix implementers: Sonnet.

---

You are closing out B5 slice 2 of TyrePlatform, at
`C:\Users\Rourke Amiss\Documents\Personal\Projects\TyrePlatform`. The branch
is built, gated and pushed, and its pull request is open. Two things remain:
finish the Jira bookkeeping the last session was interrupted on, then run an
independent review of the pull request and fix what it finds. You do not
redesign, and you do not merge.

## State as the last session left it (verify before acting)

- Branch `TYRE-92-fitment-surface`, HEAD `56b7a5b`, pushed. Cut from
  `develop` at `ff1744e`. Working tree clean apart from this file.
- PR #41 (`gh pr view 41`) is OPEN, base `develop`, head this branch:
  https://github.com/Rourke9001/TyrePlatform/pull/41. Its body was generated
  from the SDD ledger; its first line repeats the PR title (harmless, tidy it
  if you edit the body for any other reason).
- Gates on `56b7a5b`, all green: `make lint` EXIT 0; `make db-reset` +
  `make db-test` 166 PASS / ALL CHECKS PASSED; `make api-test` 4 packages ok;
  `make web-test` 43 files / 486 tests; `make e2e` 23 passed.
- Jira (cloudId `rourke9001.atlassian.net`, project TYRE): TYRE-92 and
  TYRE-93 were moved to *In Review* (transition id 31) on 3 Sep. TYRE-94 and
  TYRE-48 were NOT moved — the session was interrupted. No ticket carries the
  PR link yet. Follow-ups TYRE-98..TYRE-123 exist, parented to TYRE-55; the
  map is `.superpowers/sdd/2026-09-01-b5-fitment-surface/ticket-keys.md`.
- The SDD workspace `.superpowers/sdd/2026-09-01-b5-fitment-surface/` still
  exists (git-ignored). `progress.md` is the ledger; every `Ruling:` line in
  it is a settled decision. Its last line says "Branch pushed; PR next." —
  the PR line was never appended. `pr-body-final.md` is the PR body as
  posted; `followups.md` and `ticket-keys.md` are the residuals register.

## Read first

1. `CLAUDE.md`. Rules 1–6 bind this branch directly (RLS in the database,
   money numeric, fitment events immutable, tread is a set, thresholds are
   tenant configuration, UTC stored / tenant displayed).
2. `docs/superpowers/specs/2026-09-01-b5-fitment-surface-design.md` (the
   authority; U1–U11 as amended on the branch) and
   `docs/superpowers/plans/2026-09-01-b5-fitment-surface.md`.
3. The ledger `progress.md` above — read every `Ruling:` line. A reviewer
   who disagrees with a ruling reports it as a *question for the owner*, not
   as a defect; the rulings are not relitigated on this branch.
4. `docs/adr/0012-api-error-envelope.md` (amended on the branch),
   `0013-write-surface-contract.md`, `0014-audit-mechanism.md` (new).
5. `docs/lessons.md`, entries dated 2026-08-27 onward, especially the
   2026-09-03 entries (shared git index, API restart before e2e, db-test
   warm flake window, .css gate).
6. The PR #39 lesson: the branch's own five-lane review said 0 Critical and
   a second independent pass still found four real defects. That is the
   reason this review exists. Do not trust a green gate on money or
   event-time changes.

## Part A — move the tickets

1. `searchJiraIssuesUsingJql`: `key in (TYRE-92, TYRE-93, TYRE-94, TYRE-48)`
   with fields `status`. Record what you find.
2. For each of the four not already *In Review*: `transitionJiraIssue` with
   `{"id": "31"}`.
3. On all four, `addCommentToJiraIssue` (load it with
   `ToolSearch select:mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue`)
   with one comment: "PR #41 opened against develop at 56b7a5b:
   https://github.com/Rourke9001/TyrePlatform/pull/41 — landed by B5 slice 2
   (TYRE-92-fitment-surface). Owner merges in the browser." Do not repeat a
   comment that is already there.
4. Append to the ledger: `- PR #41 opened: <url> (base develop, head
   TYRE-92-fitment-surface @ 56b7a5b). Jira TYRE-92/93/94/48 → In Review.`
5. Report the four statuses in your reply before starting Part B.

## Part B — independent review of PR #41

Use `superpowers:requesting-code-review` for the shape, with these lanes run
as **parallel Opus reviewers**, each reading one diff package you write with
`git diff develop...TYRE-92-fitment-surface -- <paths>` to a file in the
workspace (never paste diffs into a prompt). Each reviewer also gets the spec,
the ledger's rulings, the ADRs above, the CLAUDE.md rules verbatim, and
`ticket-keys.md` so an already-ticketed residual is not re-reported.

1. **Database** — `db/migrations/00003[2-6]_*`, `db/tests/004_tests.sql`.
   Look for: a view or function without `security_invoker`/the right
   SECURITY mode; a `WITH CHECK` gap on any write path; a cross-tenant probe
   made vacuous by two refusal branches sharing a SQLSTATE; float anywhere
   near money; the `rand_per_mm` recompute on retread return and its TY014
   rate bound; the event-instant rule (now() on the tenant's today, else
   `least(date at tenant tz, now())`, TY012 when predating the last
   movement); 000036's dated as-at fallback and the UTC-day slicing it
   inherits (TYRE-123); the audit trigger's no-op skip (ADR-0014); the
   immutability trigger; and whether sections 7, 8, 17, 18 (Appendix E/J
   pins) are byte-identical to `develop` — capture both and diff them.
   Also dispatch the project's `rls-auditor` and `valuation-verifier` agents
   on the same diff and quote their verdicts verbatim.
2. **Go API** — `api/internal/httpapi/*`. Capability gates on every new
   route (the PR claims a table-driven gate test covering five endpoints);
   `SET LOCAL app.tenant_id` inside the transaction on every write; ADR-0012
   envelope on every refusal path incl. TY012/TY014/TY015/TY016; the strict
   decoder; `maxTextLen`/`maxTagsPerPatch`; warnings decoding on fit; no
   tyre business rule reimplemented in Go.
3. **Web: unit screen** — `web/src/fleet/unit/*`. Fit/remove/rotate/dispatch
   forms; odometer required only where the unit has one and never blocking
   where it has not; distance provenance shown at removal; confirmation
   keyed to the fitment id (TYRE-115 is the known residual); every date via
   `useTenantDate`/`formatTenantDate`; TanStack invalidation of
   `openFitmentsKey`/`retreadJobsKey`; `strict` types, no `any`; the
   three-minute capture rule is not touched by this surface but say so if
   anything here leaks into the capture app.
4. **Web: register, retread queue, fitment list, e2e** —
   `web/src/fleet/tyres/*`, `RetreadQueue.tsx`, `FitmentList.tsx`,
   `routes.tsx`, `AppShell*.tsx`, `web/e2e/fitments.spec.ts`,
   `web/playwright.config.ts`. Does the e2e spec exercise every step of the
   TYRE-92 definition of done, as the Sandbox CONTROLLER only, with no BAC
   rows touched? Any test that asserts nothing?
5. **Docs, tests and the PR's own claims** — ADR-0012 amendment, ADR-0014,
   `docs/lessons.md`, `docs/implementation-order.md`, the spec's D7 edit,
   comment standard (`docs/comments.md`; the deterministic gate has run,
   judge the rest). Then read `pr-body-final.md` against the diff: is every
   claim in "what landed by task", the U1–U11 table, the RLS probe result and
   the verifier verdict true of `56b7a5b`? A claim the diff does not support
   is a finding.

Severity: Critical (tenant leak, money or event-time wrong, a test weakened,
a pin moved), Important (a wrong behaviour a user or the owner would hit),
Minor (everything else). Each reviewer returns findings as `file:line`,
the claim, the evidence, and a proposed fix — to a report file in the
workspace, with a one-line summary back to you.

### Fixing what the review finds

- Vet every Critical and Important yourself by reopening the cited code
  before dispatching a fix. Reviewer reports are leads, not facts.
- One fix wave: one implementer per lane that has findings, in parallel,
  each owning only its lane's paths. Agents share one `.git/index`: commit
  with `git commit -m "..." -- <paths>`; `git add -N` an untracked file
  first; never `git add .`/`-A`, never stash/reset/checkout. Conventional
  commits with the key, e.g. `fix(db): TYRE-92 ...`.
- Scoped Opus re-review of each fix diff. A second round is allowed for a
  finding still open; after that, ticket it (parent TYRE-55, cite the key in
  the PR comment) rather than a third round.
- Minor findings: fix if it is a one-line change inside a lane's wave;
  otherwise ticket or list as a residual with a reason.
- Gates on the final commit, in the foreground (a backgrounded `make check`
  gets killed by the harness): `make fmt` (tree unchanged), `make lint`,
  `make db-reset && make db-test`, `make api-test`, `make web-test`. Then
  `docker restart kind_proskuriakova`, wait until
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/` returns a
  2xx or 4xx (about a minute of compilation; code 000 means not yet), then
  `make e2e`. Read the EXIT line of each. If db-test flakes between 22:00
  and 24:00 UTC, that is TYRE-121; re-run outside the window before
  believing a failure.
- Push the branch (plain `git push`, never force). Post one PR comment on
  #41: findings by lane with severity, the fix commit for each, residuals
  with ticket keys, the re-run gate counts. Edit the PR body only if a count
  or a claim in it is now false.

### Rules that do not move

- Never commit to `develop` or `main`; never merge; never rebase or rewrite
  the pushed branch. The owner merges in the browser.
- Never touch `db/migrations/0000[0-2][0-9]_*`, `000030`, `000031`, any
  merged migration, or BAC's fixture rows (tenant `11111111-…`). Test data
  only in Sandbox Fleet (`33333333-3333-3333-3333-333333333333`).
- Never weaken a test. If a test is wrong, say why in the report and in the
  commit body before changing it.
- Stop and ask the owner if: a section 7/8/17/18 figure changes; a
  cross-tenant probe would become vacuous; a money or event-time finding is
  still disputed after one fix round; a fix needs a migration below 000032.
- Business rules about tyres go in SQL with a test in `db/tests/`; never in
  Go "for speed".
- The user's email is for identifying the user only.

## Deliverables

1. Jira: TYRE-92/93/94/48 in *In Review*, each carrying the PR link.
2. PR #41 commented with the review outcome; branch pushed with the fixes;
   every gate green on the final commit and the counts quoted.
3. Ledger appended with the PR line, the review verdicts, each fix commit,
   and any new `Ruling:`.
4. New follow-up tickets (if any) parented to TYRE-55 and cited in the PR
   comment.
5. `docs/lessons.md` entry only for a failure that changes how the next
   attempt should behave, in the file's newest-first format.
6. Then delete `.superpowers/sdd/2026-09-01-b5-fitment-surface/` — only
   after the PR comment is posted, since the workspace is the only copy of
   the review reports.
7. A final reply: the four Jira statuses, findings by severity with fix
   commits, what was left out and why, and the final gate counts against
   the pre-review baseline (166 / 4 / 486 / 23).
