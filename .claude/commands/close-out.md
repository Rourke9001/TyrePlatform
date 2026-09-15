---
description: Reconcile the board and the docs after a pull request merges
---
Close out a merged batch. The board is the live authority, so the work is to
make it say what is true, with the evidence attached.

Take the PR number as the argument. If none is given, find the most recently
merged one with `gh pr list --state merged --limit 5`.

1. **Confirm the merge.** `gh pr view <n> --json state,mergedAt,mergeCommit`.
   Read the PR body's gate section and check every unticked box: a PR can merge
   with a gate still open, and that open gate is usually the thing this pass has
   to resolve or record.
2. **Run the gate on the merged head**, not on the branch. A rebase merge
   rewrites every SHA, so the branch's green does not transfer unless the trees
   are identical. `make check`, unpiped, and read the real exit code.
3. **Read each ticket's definition of done before transitioning it.** A key
   whose only commit is the one that wrote it down in a docs page has been
   recorded, not built. Where a ticket is half delivered, leave it open and
   comment which half landed and which half did not, naming the batch that
   takes the rest.
4. **Comment the evidence on every ticket you close**: the PR, the merge commit,
   the migration number, and the check that would go red if the work were
   reverted. Then transition it.
5. **Re-verify `docs/implementation-order.md` by the method in its own last
   section**, not only the row for this batch. Check every key the page lists as
   pending against `statusCategory = Done`; a hit means the page is stale
   somewhere else too. Correct any premise the batch has falsified, and prune
   what has stopped being about the queue.
6. **Raise every residual as a ticket**, linked to its parent. Nothing stays
   only in a PR body or in chat.
7. **Promote `main`** if the owner asks: `git push origin origin/develop:main`,
   never through a pull request, because the merge button cannot fast-forward
   (ADR-0004). Verify `git merge-base --is-ancestor origin/main origin/develop`
   first and compare **trees** afterwards, never hashes.
8. **Append to `docs/lessons.md`** if something failed in a way that would fool
   the next session. Only that; it is a register, not a diary.

Report what you changed on the board and what you left alone, and say plainly
which decisions are waiting on the owner. Do not mark a ticket Done to tidy the
board: an unmet definition of done is the finding, not an obstacle.
