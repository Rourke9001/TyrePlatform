---
description: Stage 5 code review of a PR, run in a session that did not write it
argument-hint: [PR number] [level, default high]
---
Review PR **$ARGUMENTS** before it merges (CLAUDE.md, How work runs, stage 5).
Report only: do not fix, commit, push, comment on GitHub or touch Jira unless
the owner says so after reading the report.

If this session wrote any of the PR's code, stop and say so. The review must
come from a session that does not share the author's context.

1. **Read first.** `gh pr view <n>` for the body, the Jira key and the base
   branch. Then `CLAUDE.md`, the `CLAUDE.md` of each directory the diff
   touches, `docs/comments.md`, the spec the PR body names and any ADR it
   cites. Read the ticket and its comments in Jira and the SRS IDs it cites
   in Confluence. A deviation that an owner ruling covers is not a finding,
   unless you show that the ruling itself is wrong.
2. **Review.** Run `/code-review <level> <n>` (default `high`). For a stacked
   PR, review its own diff (`gh pr diff <n>`), not its diff against
   `develop`. Stay read-only in this checkout and never switch branches here.
   To run anything on the branch, use a worktree
   (`git worktree add ../tp-review-<n> <branch>`) and remove it afterwards.
3. **Run the auditors** whose trigger the diff meets: `rls-auditor`,
   `append-only-auditor`, `valuation-verifier`.
4. **Verify every Critical and Important finding** before keeping it. Try to
   disprove it against the code, the spec and the installed library source,
   citing `file:line`. Never rely on memory of how a library behaves
   (docs/lessons.md, 2026-09-23). Drop what does not survive, and say why.
5. **Report.** Write `.superpowers/sdd/<date>-review-pr<n>/report.md`. For
   each surviving finding give the severity, `file:line`, what is wrong and
   why it matters, the evidence, and the fix. List what you set aside, with
   the reason.

Reply with the counts by severity, the merge verdict (merge, merge after
fixes, or do not merge) and the report path. Fixes run in the authoring
session or a fresh one, then a scoped re-review runs here.
