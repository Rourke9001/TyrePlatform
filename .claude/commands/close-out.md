---
description: Reconcile the board and the docs after a pull request merges
argument-hint: [PR number] [cloud]
---
Close out a merged batch. The board is the live authority, so the work is to
make it say what is true, with the evidence attached.

Take the PR number as the first argument. If none is given, find the most
recently merged one with `gh pr list --state merged --limit 5`; in cloud
mode the number is always given. A second argument `cloud` means this runs
in the close-out routine (`docs/how-work-runs.md`, How work runs; ADR-0018).

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
from there. Then run `make hooks-install` and `make guard-check CLOUD=1`; on a
non-zero exit, post its output as the report and stop. A refused `gh` call, there or in the
guards above, also stops the run, and since the report cannot be posted then,
the push notification carries the check's output or the refusal (below).
Never merge a pull request and never call a merge endpoint (`gh pr merge`,
`PUT .../pulls/<n>/merge`): in the cloud only this line holds it (U213,
`docs/runbooks/github-access.md` step 4). Never call the connector's
`executeWrite` here, since a routine can sit at a permission prompt nobody sees
(docs/lessons.md, 2026-10-12): a ticket this run raises names its parent's key
in its description, and the link goes under Waiting on the owner.

**Local mode only, next:** before checking anything out, look for
`.superpowers/sdd/*-pipeline-*/state.md`. If one exists whose last finished
stage is neither "handed over" nor "ended at the cap", stop: a pipeline is
working in this checkout.

1. **Confirm the merge.** The guards have read `merged` and
   `merge_commit_sha`. Read the PR body's gate section and check every
   unticked box: a PR can merge with a gate still open, and that open gate
   is usually the thing this pass has to resolve or record.

   Then list the migrations the PR added, because staging's migrate is a
   manual step that nothing else reminds anyone of (U94, TYRE-433):
   `gh api 'repos/Rourke9001/TyrePlatform/pulls/<n>/files?per_page=100' --paginate --jq '.[] | select(.status == "added") | .filename | select(startswith("db/migrations/"))'`.
   When it lists any file, the report and every ticket comment carry this
   under a **Waiting on the owner** heading:
   `Run environment-release.md Each release on staging, to <NNNNNN>`, where
   `<NNNNNN>` is the highest six-digit prefix listed. Tickets are still
   transitioned by the steps below.
2. **Run the gate on the merged head**, not on the branch. A rebase merge
   rewrites every SHA, so the branch's green does not transfer unless the trees
   are identical. `make check`, unpiped, and read the real exit code.

   In cloud mode the gate is CI's push run on `develop` for the merge commit.
   It already ran the same gates on that exact commit, so a second run in the
   cloud would only repeat it, slower. Find it with the full SHA:
   `gh run list -R Rourke9001/TyrePlatform --branch develop --commit <merge_commit_sha> --workflow CI --json databaseId,status,conclusion,url`.
   The foreground refuses `sleep`, so every wait is a bounded watch, run in
   the foreground and unpiped, with the Bash tool's timeout set to 600000 ms
   so the watch is not moved to the background at the 2-minute default:
   `timeout 540 gh run watch <id> -R Rourke9001/TyrePlatform --interval 30 > /dev/null 2>&1`.
   - To wait for a run to finish, watch it, then read
     `gh api repos/Rourke9001/TyrePlatform/actions/runs/<id> --jq '.status, .conclusion'`,
     and repeat until `status` is `completed`.
   - To wait for a run that is not listed yet (a develop run can take
     minutes to appear in the list), watch develop's newest CI run, used only as a wait, then
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
     not listed yet, then list again. A re-run reuses the run id: before
     deciding, read the run's `run_attempt` and that attempt's job count
     (`gh api repos/Rourke9001/TyrePlatform/actions/runs/<id>/attempts/<n>/jobs --jq .total_count`).
     While no later push run contains the merge commit, keep watching that
     same id for the full 60 minutes (docs/lessons.md, 2026-10-20).
   - `failure` where every failed job stopped at its deploy Guard step with
     the `TYRE-403` refusal
     (`gh run view <id> -R Rourke9001/TyrePlatform --log-failed` shows only
     Guard steps, each with `TYRE-403: attempt`): the run was re-run after
     a later merge moved `develop` on, which the guard refuses by design. Treat it as
     `cancelled`.
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
   what has stopped being about the queue. List every key checked and its
   status in the report, even when none changed.
6. **Residuals.** The PR body's "Set aside" list is their record; chat is
   not. Read it for bugs first, by the definition in `docs/how-work-runs.md`,
   Which bugs a branch fixes. A line marked not reproduced, or an `unrelated`
   Minor's line with `ticket: none found`, is a Minor nobody verified, not a
   bug (U212). An `introduced` or `on-path` bug there
   (`docs/how-work-runs.md`, Which bugs a branch fixes) means the
   branch merged with one unfixed: raise no ticket for it, and list it
   under Waiting on the owner with the PR's key, as a miss for the owner to
   rule on (U191). Raise a ticket, linked to its parent (in cloud mode, the
   parent named in its description and the link under Waiting on the owner, as
   the cloud paragraph says), only for an item that is not a bug and passes
   the schedule test (`docs/how-work-runs.md`, Which bugs a branch fixes,
   U130). An SRS
   change is a comment on the working ticket, never a ticket (U194). Search
   the board first, and comment on an open ticket
   rather than raise a second. If more than two items qualify, raise none
   and list them in the report as a decision waiting on the owner.

   **Minors left open.** Read the PR body's Minors left open list. If it has
   lines, search with `searchJiraIssuesUsingJql` for
   `project = TYRE AND status = "To Do" AND summary ~ "Minors left open"` and
   take the hit whose summary is exactly `Minors left open by pipeline runs`,
   the lowest key if more than one. If there is none, raise one with
   `createJiraIssue`: type Task, that summary, `priority` Low, and `parent`
   TYRE-10 where the tool has that field; where it has not, the description
   names TYRE-10 and the link goes under Waiting on the owner, with no
   `executeWrite` call. Comment the lines on it, with the PR number. This is
   not one of the items this step limits to two, and its lines are not misses
   for the owner (U212).
7. **Promote to production** if the owner asks, and never in cloud mode.
   This follows `docs/runbooks/environment-release.md`, Promote to
   production, except that it never migrates production: production holds
   real data, and the migrate runs as the database's admin.
   - The commit, `<sha>`, is this PR's merge commit, unless the owner names
     another `develop` commit.
   - **Read each database's version; never write.** For staging and then
     production, run only the reads of Each release step 1: the server's
     state, and the `AllowDevMachine` rule beside the current IP. Skip that
     step's start and firewall update. If the server is not `Ready`, or the
     rule's IP differs from the current one, stop and list "start the
     server" or "update `AllowDevMachine` (Each release step 1)" for that
     environment under Waiting on the owner. Otherwise run Each release
     step 3 on a clean checkout of `<sha>` (`git switch --detach <sha>`,
     then `git switch -`).
   - Stop before any push, and list the matching action under Waiting on
     the owner, when any of these holds:
     - `<sha>` is not an ancestor of `origin/develop`, or `origin/main` is
       not an ancestor of `<sha>`;
     - there is no `tyre-api:<sha>-staging-passed` tag
       (`az acr repository show-tags`, as in the runbook's step 1);
     - staging's version is below the commit's highest migration, read with
       `git ls-tree --name-only <sha> db/migrations/`: list
       "Run environment-release.md Each release on staging, to <NNNNNN>";
     - production's version is dirty, which is a decision for the owner;
     - production's version is below the commit's highest migration: list
       "migrate production per Promote to production, step 2". At or above
       is safe, because every migration leaves the schema usable by the
       image production runs;
     - `git diff --name-only --diff-filter=A origin/main <sha> -- db/migrations`
       lists a file, and the SAST hour, `$(( (10#$(date -u +%H) + 2) % 24 ))`,
       is from 6 to 17 inclusive: list "promote outside 06:00 to 18:00
       SAST" (NFR-AVL-003). The `10#` matters: bash reads a zero-padded `08`
       or `09` as invalid octal.
   - Otherwise stop and give the owner the full 40-character `<sha>`
     first, then the push for their own terminal with it typed in, never
     through a pull request (ADR-0004): Git Bash
     `TYRE_PROMOTE=1 git push origin <sha>:main`, PowerShell
     `$env:TYRE_PROMOTE='1'; git push origin <sha>:main; $env:TYRE_PROMOTE=$null`.
     Type the SHA, not a variable: a variable set here does not exist in
     the owner's terminal, and an empty one turns the refspec into `:main`,
     a delete. A session cannot push `main` (`.githooks/pre-push`). When
     the owner says it is pushed, go on from `git fetch origin main`;
     `git rev-parse origin/main` must equal `<sha>`.
   - Watch CI's `main` run for `<sha>` with step 2's bounded watch
     (`--branch main --commit <sha>`) and cite its URL. Green means
     production's gate and smoke passed.
   - List "record the release row (Each release step 5, `ENV=prod`)" under
     Waiting on the owner; the owner records it (U118).
   - The owner can still run the runbook with Claude in a session. That is
     the runbook path, with the owner present, not close-out's.
8. **Append to `docs/lessons.md`** if something failed in a way that would fool
   the next session. Only that; it is a register, not a diary.

In cloud mode, if steps 5 and 8 changed nothing
(`git status --porcelain -- docs/implementation-order.md docs/lessons.md`
prints nothing), cut no branch and open no PR. Otherwise their edits go on
a branch `<first key>-pr<n>-close-out` cut from `origin/develop`, where
`<first key>` is the first `TYRE-<n>` the PR's title names. Push it, then
open the PR and label it:
`gh api -X POST repos/Rourke9001/TyrePlatform/pulls -f title='docs(close-out): <first key> <summary>' -f head=<branch> -f base=develop -F body=@<file> --jq .number`,
then `gh api -X POST repos/Rourke9001/TyrePlatform/issues/<that number>/labels -f 'labels[]=close-out'`.
Never push to `develop` or `main`.

Report what you changed on the board and what you left alone. The decisions
and actions waiting on the owner go under a **Waiting on the owner** heading,
in the report and in its ticket comments. In cloud mode, post this report as
a comment on the merged PR
(`gh api -X POST repos/Rourke9001/TyrePlatform/issues/<n>/comments -F body=@<file>`)
on every path past the guards, including each stop in step 2. The routine
acts as the owner, and neither GitHub nor Jira notifies the owner of their
own comment, so when the run stops early or leaves a decision waiting on
the owner, also send the owner a push notification with the session's
notification tool, and say in the report whether it was sent. Do not mark
a ticket Done to tidy the board: an unmet definition of done is the
finding, not an obstacle.
