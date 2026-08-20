---
description: Pull a Jira ticket, restate it, and plan the work before coding
argument-hint: [TYRE-nnn]
---
Work ticket **$ARGUMENTS**.

1. Fetch it from Jira (`getJiraIssue`). Read the description in full.
2. Read the requirement IDs it cites out of `docs/spec/SRS_v1.3.md`. Search,
   do not read the whole file.
3. Restate in your own words: what changes, what must not change, and how we
   will know it worked. If the ticket is ambiguous, say which part and what
   you are assuming.
4. Check whether it is blocked by anything in `docs/open-issues.md`. If it is,
   stop and say so rather than guessing at the answer.
5. Create the branch: `git checkout -b $ARGUMENTS-short-description`.
6. Plan the change, then implement it. Business rules go in SQL with a test in
   `db/tests/`; transport and auth go in Go.
7. `make check` before you claim it is done.
