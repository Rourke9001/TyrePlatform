---
description: Pull a Jira ticket, restate it, and run it through spec, plan, red team and implementation
argument-hint: [TYRE-nnn]
---
Work ticket **$ARGUMENTS** through the five stages in CLAUDE.md (How work
runs). Do not start a stage until the one before it is done.

1. Fetch it from Jira (`getJiraIssue`). Read the description in full.
2. Read the requirement IDs it cites from the SRS in Confluence, not from a
   local copy (CLAUDE.md). Search, do not read the whole page.
3. Restate in your own words: what changes, what must not change, and how we
   will know it worked. If the ticket is ambiguous, say which part and what
   you are assuming.
4. Check whether it is blocked by another ticket (its Jira links). If it is,
   stop and say so rather than guessing at the answer.
5. Say whether it is a small fix by the definition in CLAUDE.md, and why.
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
11. Anything you find that is not this ticket's to fix is checked against the
    SRS and raised as a new Jira ticket, linked to this one (CLAUDE.md).
12. `make check`, then open the PR. Stop there. The code review is stage 5,
    and it runs in a separate session: tell the owner to run
    `/review-pr <n>` in a new session.
