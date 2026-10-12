---
description: Reconcile the board and the docs after a pull request merges
argument-hint: [PR number] [cloud]
---
Close out a merged batch. The board is the live authority, so the work is to
make it say what is true, with the evidence attached.

Take the PR number as the first argument. If none is given, find the most
recently merged one with `gh pr list --state merged --limit 5`; in cloud
mode the number is always given. A second argument `cloud` means this runs
in the close-out routine (CLAUDE.md, How work runs; ADR-0018).

Cloud sessions reject GitHub's GraphQL API, so every GitHub call below uses
`gh api` with `repos/Rourke9001/TyrePlatform` written out, except
`gh run list` and `gh run watch`, which use REST. Where a step, or a method
a doc names, says `gh pr list` or `gh pr view`, use the REST form:
`gh api 'repos/Rourke9001/TyrePlatform/pulls?state=open&per_page=100'` or
`gh api repos/Rourke9001/TyrePlatform/pulls/<n>`.

**The guards, before anything else.** Read the PR:
`gh api repos/Rourke9001/TyrePlatform/pulls/<n> --jq '{head: .head.ref, labels: [.labels[].name], merged, merge_commit_sha, title, body}'`.

- If `merged` is not `true`, stop: there is nothing to close out yet.
- If the head branch ends in `-close-out` or the labels include
  `close-out`, stop without changing anything and say why: it is a
  close-out's own PR, and closing it out would start another.
- If neither the title nor the body names a `TYRE-<n>` key, comment that on
  the PR (`gh api -X POST repos/Rourke9001/TyrePlatform/issues/<n>/comments -F body=@<file>`)
  and stop.

**Cloud mode only, next:** a run started by a PR event begins on that PR's
head commit, not on `develop`. Run `git fetch origin develop main`
(adding `--unshallow` if `git rev-parse --is-shallow-repository` says
`true`) and `git checkout --detach origin/develop`, and read and edit only
from there.

**Local mode only, next:** before checking anything out, look for
`.superpowers/sdd/*-pipeline-*/state.md`. If one exists whose last finished
stage is not "handed over", stop: a pipeline is working in this checkout.

1. **Confirm the merge.** The guards have read `merged` and
   `merge_commit_sha`. Read the PR body's gate section and check every
   unticked box: a PR can merge with a gate still open, and that open gate
   is usually the thing this pass has to resolve or record.
2. **Run the gate on the merged head**, not on the branch. A rebase merge
   rewrites every SHA, so the branch's green does not transfer unless the trees
   are identical. `make check`, unpiped, and read the real exit code.

   In cloud mode the gate is CI's push run on `develop` for the merge commit.
   It already ran the same gates on that exact commit, so a second run in the
   cloud would only repeat it, slower. Find it with the full SHA:
   `gh run list -R Rourke9001/TyrePlatform --branch develop --commit <merge_commit_sha> --workflow CI --json databaseId,status,conclusion,url`.
   The foreground refuses `sleep`, so every wait is a bounded watch, run in
   the foreground and unpiped:
   `timeout 540 gh run watch <id> -R Rourke9001/TyrePlatform --interval 30 > /dev/null 2>&1`.
   - To wait for a run to finish, watch it, then read
     `gh api repos/Rourke9001/TyrePlatform/actions/runs/<id> --jq '.status, .conclusion'`,
     and repeat until `status` is `completed`.
   - To wait for a run that is not listed yet (GitHub queues develop runs
     for minutes), watch develop's newest CI run, used only as a wait, then
     list again:
     `gh run list -R Rourke9001/TyrePlatform --branch develop --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId'`.

   When the merge commit's run completes:
   - `success`: cite the run URL and go on.
   - `cancelled`: a later push queued behind it replaced it. List develop's
     CI push runs created after it
     (`gh run list -R Rourke9001/TyrePlatform --branch develop --event push --workflow CI --json databaseId,headSha,createdAt,status`),
     take the oldest whose head contains the merge commit, checked with
     `gh api repos/Rourke9001/TyrePlatform/compare/<merge_commit_sha>...<headSha> --jq .status`
     returning `ahead` or `identical`, wait for it the same way, and judge
     its result by these same cases. If none exists yet, wait as for a run
     not listed yet, then list again.
   - anything else, including a failed staging deploy: comment the run URL
     on each ticket the PR names, transition nothing, post the report (at
     the end), and stop.

   If 60 minutes pass with no completed run that contains the merge commit,
   comment that on each ticket the PR names, transition nothing, post the
   report (at the end), and stop.
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
7. **Promote `main`** if the owner asks, and never in cloud mode: `git push origin origin/develop:main`,
   never through a pull request, because the merge button cannot fast-forward
   (ADR-0004). Verify `git merge-base --is-ancestor origin/main origin/develop`
   first and compare **trees** afterwards, never hashes.
8. **Append to `docs/lessons.md`** if something failed in a way that would fool
   the next session. Only that; it is a register, not a diary.

In cloud mode, if steps 5 and 8 changed nothing (`git status --porcelain`
prints nothing), cut no branch and open no PR. Otherwise their edits go on
a branch `<first key>-pr<n>-close-out` cut from `origin/develop`, where
`<first key>` is the first `TYRE-<n>` the PR's title names. Push it, then
open the PR and label it:
`gh api -X POST repos/Rourke9001/TyrePlatform/pulls -f title='docs(close-out): <first key> <summary>' -f head=<branch> -f base=develop -F body=@<file> --jq .number`,
then `gh api -X POST repos/Rourke9001/TyrePlatform/issues/<that number>/labels -f 'labels[]=close-out'`.
Never push to `develop` or `main`.

Report what you changed on the board and what you left alone, and say plainly
which decisions are waiting on the owner. In cloud mode, post this report as
a comment on the merged PR
(`gh api -X POST repos/Rourke9001/TyrePlatform/issues/<n>/comments -F body=@<file>`)
on every path past the guards, including each stop in step 2. The routine
acts as the owner, and neither GitHub nor Jira notifies the owner of their
own comment, so when the run stops early or leaves a decision waiting on
the owner, also send the owner a push notification with the session's
notification tool. Do not mark a ticket Done to tidy the board: an unmet
definition of done is the finding, not an obstacle.
