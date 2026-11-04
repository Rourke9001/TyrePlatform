---
description: Find a mechanism the repo keeps patching, and check it against the proven approach
argument-hint: [mechanism, path or ticket; empty for the whole repo]
---
Audit **$ARGUMENTS** for designs that keep needing fixes; with no argument,
audit the whole repo. Report only: do not fix, commit, push, raise tickets
or comment on GitHub or Jira unless the owner says so after reading the
report.

The unit is a **mechanism**: one approach to one problem, across every file
that implements it, such as "a hook that parses shell text to refuse a
push" or "reload the page to recover a failed lazy chunk". A mechanism
that draws fix after fix is usually fighting its platform, and the cure is
a different design, not another patch.

1. **Find candidates.** For a scoped run, gather this evidence for the named
   mechanism only. Collect every signal, then group the hits by mechanism:
   - **Review rounds.** Commit subjects naming a later round
     (`git log --format="%h %s" | rg "round [2-9]"`; `--grep` also matches
     bodies), and the reports under `.superpowers/sdd/*review-pr*/`. Those
     are gitignored, so read them in the main checkout; a worktree has none.
     Two rounds whose findings land in the same mechanism is the strongest
     signal.
   - **Fix churn.** `fix(` commits counted per ticket
     (`git log --format=%s | rg "^fix\("`), and the files they keep touching.
   - **Stacked amendments.** `rg -n "^\*Amended|Superseded" docs/superpowers/specs`
     and `## Amendment` in `docs/adr/`. Three riders on one section, or
     owner rulings that each patch the last, mark a mechanism.
   - **`docs/lessons.md`.** Entries about the same tool, library or gate.
     Note any whose rule teaches the next patch instead of the replacement:
     sessions treat the register as binding.
   - **Code.** Comments explaining a platform quirk the code works around;
     flags, timers or guards stacked on one path; a helper copied three or
     more times.
2. **Rank and pick.** One line per mechanism: a name, its files and its
   evidence counts. Rank by how many kinds of signal hit it (rounds, churn,
   amendments and rulings, lessons, code), then by its count of fix events.
   The review archive starts on 8 Oct 2026, so older work shows in churn
   and rulings rather than in rounds. Repo-wide, research the top five and
   list the rest.
3. **Research each picked mechanism** in its own subagent, in parallel,
   with `model: "fable"`, read-only. The brief gives the mechanism, its
   evidence and its files, and asks:
   - What problem it solves, and what belief about a library or platform it
     rests on. Check that belief against the installed source
     (`node_modules`, the Go module cache) and primary documentation (the
     vendor's docs, the spec, the RFC). Every claim cites a URL or
     `file:line`; memory is not a source (docs/lessons.md, 2026-09-23).
   - What the platform's docs and established projects do for this problem,
     and whether a layer already knows the answer: git for a push's target,
     the browser for module loading, the database for isolation.
   - Whether the past fixes were edge cases a sound design still has, or
     symptoms of the design.
   - For a replacement: what it deletes (functions and files), what it
     costs (bytes, latency, process, the owner's time), and which ADRs,
     owner rulings, lessons or CLAUDE.md lines it reverses.
4. **Give each a verdict**, and verify every Replace yourself against the
   code and CLAUDE.md's non-negotiable rules before keeping it:
   - **Sound.** The fixes were edge cases and no proven design removes
     them. Keep it.
   - **Misread.** It rests on a wrong belief about a library or platform.
     Correct the belief where it is written (comment, lesson, spec rider);
     the design may stand.
   - **Replace.** A proven design removes the class of fix. A Replace that
     reverses an ADR or an owner ruling says so, because that change is the
     owner's.

   A bug met on the way is listed apart, with its file and the input that
   reaches it, under CLAUDE.md's definition. It is not a verdict.
5. **Report** to `.superpowers/sdd/<date>-design-audit[-<slug>]/report.md`,
   mechanisms ranked by evidence. For each: name and files; evidence
   (commits, rounds, rulings, riders, lessons); the belief and what the
   sources say; the verdict; for a Replace, the design, what it deletes,
   its cost and what it reverses; and the next step, a ticket for a Replace
   (search the board first and add to an open one) or the corrected text
   for a Misread. Then the bugs, then the candidates not researched.

Reply in plain words for an owner with no infrastructure background: the
count per verdict, the top Replace and its cost, each bug, and the report
path. Give one proven option per mechanism, not a survey.
