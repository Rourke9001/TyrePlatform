---
description: Judgment pass over the branch's comments before closing it out
---
Audit the comments this branch adds or changes against `docs/comments.md`.
The deterministic checker has already handled the greppable violations; your
job is the judgment calls a regex cannot make.

1. Read `docs/comments.md` in full first — including the explicit exceptions,
   so you do not flag an allowed gloss or a bare divider.
2. `git diff develop...HEAD` and collect every ADDED or MODIFIED comment line.
   Untouched comments are out of scope; this is not a licence to re-audit the
   whole repo.
3. Judge each against the standard:
   - Does it state something the code cannot say itself (a constraint,
     platform fact, requirement, accepted risk)? Or does it restate the code?
   - Does it duplicate a rationale that already has a canonical home in
     another file? If so, it should cite that home in one line instead.
   - Is it longer than its load-bearing content?
   - Does a domain rule lack its requirement or ticket ID?
4. Report findings as `file:line`, the comment, which rule it breaks, and a
   suggested rewrite (or deletion). If everything passes, say so plainly.
5. Only edit comments the user asks you to fix. A finding you are unsure
   about is a question for the user, not a silent pass and not a silent edit.
