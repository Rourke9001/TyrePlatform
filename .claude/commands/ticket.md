---
description: Pull a Jira ticket, restate it, and run it through spec, plan, red team and implementation
argument-hint: [TYRE-nnn]
---
This command is the manual path. The owner can instead run a ticket, or a
bundle of small-fix keys, to a reviewed PR with an agent team by launching
`make pipeline T=<key>` from a terminal (`/pipeline`, ADR-0018); a session
never starts it from here.

Work ticket **$ARGUMENTS** through the five stages in
`docs/how-work-runs.md` (How work runs). Do not start a stage until the one before it is done.

1. Fetch it from Jira with `getJiraIssue` and its comments with
   `listJiraIssueComments`, because the ticket's later parts can be comments
   that `getJiraIssue` only counts. Read the description and the comments in
   full.
2. Read the requirement IDs it cites from the SRS in Confluence, not from a
   local copy (CLAUDE.md). Search, do not read the whole page.
3. Restate in your own words: what changes, what must not change, and how we
   will know it worked. If the ticket is ambiguous, say which part and what
   you are assuming.
4. Check whether it is blocked by another ticket (its Jira links). If it is,
   stop and say so rather than guessing at the answer.
5. Say whether it is a small fix by the small-fix definition
   (`docs/how-work-runs.md`, Small fixes), and why.
   Then stop and wait for the owner to confirm before going on.
6. Create the branch: `git checkout -b $ARGUMENTS-short-description` from
   `origin/develop`.
7. **Spec**, unless it is a small fix: `superpowers:brainstorming`, then
   commit the spec.
8. **Plan**: `superpowers:writing-plans`. For a small fix, write a short plan
   for the PR body instead.
9. **Red team**, unless it is a small fix: dispatch the `plan-red-team` agent
   with the spec path, the plan path and the key. Fix every Critical and
   Important finding in the plan, or put it to the owner, and dispatch the
   agent again until it returns no Critical. Keep the verdict for the PR body.
10. **Implement**: `superpowers:subagent-driven-development`. Business rules
    go in SQL with a test in `db/tests/`; transport and auth go in Go.
11. A bug you find is handled by its class (`docs/how-work-runs.md`, Which
    bugs a branch fixes, U191). If the fix needs a live environment step or a
    decision you cannot make, or would take a small fix past the small-fix
    definition (`docs/how-work-runs.md`, Small fixes), stop and put it to the
    owner as a comment on this ticket. Anything that is not a bug goes
    through the schedule test (`docs/how-work-runs.md`, Which bugs a branch
    fixes, U130): a ticket linked to this one if it passes, a line under "Set
    aside" in the PR body if it does not (U130).
12. `make check`, then open the PR. Stop there. The code review is stage 5,
    and it runs in a separate session: tell the owner to run
    `/review-pr <n>` in a new session. Its fix rounds follow
    `docs/how-work-runs.md`, The review loop. A fix round, for a blocking
    finding, is a fresh session given the review report's path and the brief
    under "The fixer brief" in `.claude/commands/pipeline.md`; open Minors
    alone get one Minor batch session the same way, which adds a
    `Minor batch: <before>..<after>` Decisions line. The brief runs only the
    tests a fix touches, so when that work is done the same session runs
    `make lint` and `make test`, comments each `unrelated` finding's evidence on
    its ticket (an `unrelated` Minor's line marked unverified, and one with
    `ticket: none found` under Set aside, with no ticket raised), adds the
    Decisions lines to the PR body and pushes, which the brief leaves to its
    caller. A Minor the fixer reports `not fixed, <why>` goes under Minors left
    open, and one it reports `not reproduced` under Set aside. Then a separate
    session runs `/review-pr <n> <level> from <sha>`, where for the Minor batch
    `<sha>` is its `<before>`; a Minor batch that committed nothing gets no
    re-review (U196). After the Minor batch's re-review, the Minors it
    reports go in the PR body under Minors left open, and a blocking finding it
    reports goes to the owner.
