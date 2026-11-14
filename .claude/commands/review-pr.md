---
description: Stage 5 code review of a PR, run in a session that did not write it
argument-hint: [PR number] [level, default high] [from <sha> for a re-review]
---
Review PR **$ARGUMENTS** before it merges (`docs/how-work-runs.md`, How work runs, stage 5).
Report only: do not fix, commit, push, comment on GitHub or touch Jira unless
the owner says so after reading the report.

If this session wrote any of the PR's code, stop and say so. The review must
come from a session that does not share the author's context.

The arguments are the PR number `<n>`, a level (default `high`) and, for the
re-review of one fix round, `from <sha>`, where `<sha>` is the PR head the
round started from. Without `from`, this is the full review of the PR.

A pipeline lead's verifier has no PR and no arguments. It follows steps 1, 4
and 5 only, on the raw findings in the file its caller gives. A pipeline lead
does not use step 2: it runs the review and the auditors in place by
`/pipeline`'s own steps, because nothing else is writing in the checkout.

1. **Read first.** `gh pr view <n>` for the body, the Jira key and the base
   branch, and `gh pr view <n> --json headRefName,headRefOid` for the head
   branch and commit. With `from`, run step 2's worktree check now, before
   reading on. A verifier takes the keys, the spec path, the review base and
   the range from its caller instead; with no range given, the range is
   `@{upstream}...HEAD`, and with no review base,
   `git merge-base origin/develop HEAD`. Then `CLAUDE.md`,
   `docs/how-work-runs.md`, the `CLAUDE.md`
   of each directory the diff touches, `docs/comments.md`, the spec the PR
   body names and any ADR it cites. Read each ticket and its
   comments in Jira and the SRS IDs it cites in Confluence. Read the earlier
   review reports for this PR under `.superpowers/sdd/*-review-pr<n>/` in
   the main checkout, or the previous report a verifier's caller gives. For
   a PR a `/pipeline` run opened, also read the run's reports: the
   `review-*.md` files in the `.superpowers/sdd/*-pipeline-*/` directory
   of the main checkout whose `state.md` has a `PR:` line naming `#<n>`,
   and that file's
   `Owner answers`. A
   deviation that an owner ruling covers is not a finding, unless you show
   that the ruling itself is wrong.
2. **Review.** Without `from`, run `/code-review <level> <n>` (default
   `high`). For a stacked PR, review its own diff (`gh pr diff <n>`), not its
   diff against `develop`. Stay read-only in the main checkout and never
   switch branches there. To run anything on the branch, use a worktree
   (`git worktree add ../tp-review-<n> <branch>`) and remove it afterwards.

   With `from <sha>`, review only `<sha>...<PR head>`. `/code-review` with no
   target reviews the upstream of the directory the session started in, so
   this session must have been started inside a worktree at the PR head. If
   `git rev-parse --show-toplevel` is the main checkout (the first path
   `git worktree list` prints), stop and give the owner these commands,
   filled in, to run from the main checkout: `git fetch origin <head branch>`,
   then `git worktree add -b review-pr<n> ../tp-review-<n> <PR head>`, then,
   from `../tp-review-<n>`, start
   `MSYS2_ARG_CONV_EXCL='/review-pr ' claude "/review-pr <n> <level> from <sha>"`.
   The prefix is for Git Bash, whose path conversion would otherwise rewrite
   the leading slash, the reason `scripts/pipeline.sh` sets it; PowerShell
   needs no prefix. Inside the worktree, HEAD must be the PR head on branch
   `review-pr<n>`; if it is not, stop and say so. Before reviewing
   `<sha>...<PR head>`, check `git merge-base --is-ancestor <sha> <PR head>`;
   if `<sha>` is not an ancestor (the fix round rebased), stop and say so.
   Run `git branch -f review-pr<n>-base <sha>` and
   `git branch --set-upstream-to=review-pr<n>-base`, the only refs this
   form writes, and check that `git rev-parse @{upstream}` equals
   `git rev-parse <sha>`. Then run `/code-review <level>` with no target.

   Either way, wait for `/code-review`'s result before step 3.
3. **Run the auditors** whose trigger the reviewed diff meets, each given
   that diff's range: `rls-auditor`, `append-only-auditor`,
   `valuation-verifier`.
4. **Give each raw item a severity, then verify what could block.**
   `/code-review` gives no severity, so give each item one by
   `docs/how-work-runs.md`, Severity. Verify every item that could be Critical
   or Important, every item against rules 1 to 3 and every spec finding,
   whatever its severity, before keeping it. Try to disprove it against the
   code, the spec and the installed library source, citing `file:line`. Never
   rely on memory of how a library behaves (docs/lessons.md, 2026-09-23). Drop
   what does not survive, and say why. Every other item is a Minor: read it
   from the diff against the review base, without reproducing it, for its one
   line in step 5.
5. **Report.** Write
   `.superpowers/sdd/<date>-review-pr<n>/report-<short head sha>.md` in the
   main checkout, by absolute path (`git worktree list` prints the main
   checkout first), because `/design-audit` and `/pipeline` read reports
   only there. A verifier writes to the report path its caller gives. The
   first line is `Review: full, <range>`, or for a re-review
   `Review: fix round <k>, <range>`, where `<k>` is one more than the fix
   rounds this PR has had. With `from <sha>`, where `<sha>` is the `<before>` of a
   `Minor batch: <before>..<after>` line in the PR's Decisions, this is the
   Minor batch's re-review: its first line is `Review: Minor batch, <range>`,
   and it is not a fix round, so it does not count toward `<k>`. Count the fix-round reports already under
   `.superpowers/sdd/*-review-pr<n>/` in the main checkout, a fix-round report being one whose
   first line starts `Review: fix round`, and, for a PR a `/pipeline` run
   opened, the `Fix 1:`, `Fix 2:` and `Fix 3:` lines in the `state.md` step
   1 read; its other `Fix` lines are rounds outside the two and do not count.
   A verifier's first line is `Review: <range>`. For each finding step 4 verified,
   give the severity, `file:line`, what is wrong and why it matters, the
   evidence, and the fix, and on a line of its own `Class: <class>`, its
   class by `docs/how-work-runs.md`, Which bugs a branch fixes (U191): `introduced`,
   `on-path`, `unrelated` or `not a bug`. Where that section says merge
   base, use `git merge-base origin/<base branch> <PR head>`, or the
   verifier's review base from step 1, never `<sha>`. After the class, add
   `rule 1-3` to a finding against rules 1 to 3 and `spec` to a spec
   finding, as in `Class: on-path rule 1-3`; a spec finding is not a bug,
   so its line is `Class: not a bug spec`. Use the class words nowhere
   else in the report. For an `unrelated` bug, give the open ticket found
   and the search used, or "none found". For each Minor step 4 did not verify,
   give one line: its ID, `file:line`, what is wrong in a clause, and its
   `Class:` line; an `unrelated` one's line also carries `ticket: <key>` or
   `ticket: none found`, with the search used. For a Minor that is not a bug,
   give at most five, each with a one-line fix, and count the rest. It is
   fixed in the PR or goes under the PR's "Set aside", never into a ticket
   of its own the schedule test (`docs/how-work-runs.md`, Which bugs a branch fixes, U130). List what you set aside, with the reason,
   and what step 4 dropped, with why. When a finding lands on a mechanism
   that an earlier round of this PR, or an earlier PR, already fixed, say so
   in the finding and recommend `/design-audit <mechanism>` before the next
   fix round. Last, list each cited file that is not in
   `git diff --name-only <range>`, and end with the line
   `Scope: <n> files cited, <m> outside the range`, where `<n>` here is the
   number of distinct files the report cites and `<m>` the number in the
   list just above it. The range is `origin/<base branch>...<PR head>` for a
   full review, `<sha>...<PR head>` for a re-review, and the verifier's range
   from step 1.

Reply with the counts by severity and by class, the merge verdict (merge,
merge after fixes, or do not merge) and the report path. A blocking finding open
(`docs/how-work-runs.md`, A blocking finding) means merge after fixes. Open
`introduced` or `on-path` Minors alone mean merge after fixes on a PR whose
Decisions name no Minor batch, and merge on one whose Decisions do; then list
them for the PR body's Minors left open (`docs/how-work-runs.md`, The Minor
batch). A verifier replies as its caller's brief says.

For a PR, each fix round runs in a fresh session, and its re-review runs here
as `/review-pr <n> <level> from <sha>` (`docs/how-work-runs.md`, The review loop, U192, U212),
where `<sha>` is the short head sha in the previous report's filename. A
re-review takes that round's range and does not look outside it; a verified
finding that arrives from outside it anyway is classified like any other.
After the second fix round's re-review, a later one, or the Minor batch's, a
blocking finding still open goes to the owner, with a recommendation to run `/design-audit <mechanism>`
on the mechanism it sits in. Open Minors alone get one Minor batch session, which adds a
`Minor batch: <before>..<after>` line to the PR's Decisions, and one
re-review, `from <before>`. End a re-review by telling the owner to run,
from the main checkout, `git worktree remove ../tp-review-<n>` and
`git branch -D review-pr<n> review-pr<n>-base`.
