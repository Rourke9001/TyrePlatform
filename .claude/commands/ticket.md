---
description: Pull a Jira ticket, restate it, and run it through spec, plan, red team and implementation
argument-hint: [TYRE-nnn]
---
This command is the manual path. The owner can instead run stages 1 to 4
with an agent team by launching `make pipeline T=<key>` from a terminal
(`/pipeline`, ADR-0018); a session never starts it from here.

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
11. A bug you find that is not this ticket's: fix it in this branch with a
    regression test, whatever its file or age, and name it under Decisions
    in the PR body (CLAUDE.md, U146). If it is outside every file
    `git diff --name-only origin/develop...HEAD` lists and needs a
    migration, endpoint, route, screen or deploy step this branch does not
    add, raise one ticket linked to this one, after searching the board,
    and say why under Decisions. If the fix needs a live environment step
    or a decision you cannot make, or would take a small fix past
    CLAUDE.md's definition, stop and put it to the owner as a comment on
    this ticket. Anything that is not a bug goes through CLAUDE.md's
    schedule test: a ticket linked to this one if it passes, a line under
    "Set aside" in the PR body if it does not (U130).
12. `make check`, then open the PR. Stop there. The code review is stage 5,
    and it runs in a separate session: tell the owner to run
    `/review-pr <n>` in a new session.
