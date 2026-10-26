# Lessons

Repeatable, avoidable mistakes — things that bit once and must not bite
again. This is a curated register, not a diary: an entry earns its place by
changing how we work next time. If it cannot be written as a rule, it is an
anecdote, not a lesson.

Entry format — keep each one to this shape:

```
## 2026-09-06 — `rg -rn` is a replace flag, and the corrupted quote looks like source

**What happened:** during the review sweep a lane quoted a source line as
`// n — the same direction the diagram above them reads.` and reasoned about
it. The file says `// plan view — …`. `rg -rn "plan view"` parses `-r n` as
`--replace n`, so every match is printed with the matched text swapped for
the letter `n`; counts and exit codes stay right, only the quoted line is
wrong, which is why it survived a self-check.

**The rule:** never stack `-r` into an `rg` flag cluster. Use `rg -n` (or
`rg --color=never -n`), and take any line you intend to quote from `sed -n`
or `cat -n`, never from a grep's output.

## YYYY-MM-DD — Title
**What happened:** one or two lines.
**The rule:** the behaviour that prevents a repeat, stated imperatively.
```

Newest first. An entry that merges several lessons is dated by its newest
one and names the older dates and tickets in its heading, so a citation by
date still finds it; each rule bullet carries its own source date.

## 2026-10-26 - A trigger's "not found" is not always another tenant's row (PR #148)

**What happened:** three BEFORE triggers in 000060 skipped their checks when
the row they judged was not found, reasoning that only another tenant's row
is unseen and the composite FK refuses it. A row an unreferenced
data-modifying CTE inserts in the same statement is unseen too, and the FK,
checked at the statement's end, finds it, so the checks were stepped round.
Two review rounds accepted the reasoning. The first fix raised the FK's
code on every not-found, and section 72c failed: a row naming another
tenant then met the trigger's 23503 before its table's policy.

**The rule:** a trigger that judges a referenced row refuses a not-found one
itself, with `ERRCODE = 'foreign_key_violation'` and `CONSTRAINT` set to the
FK's name, and only when `NEW.tenant_id = app.current_tenant_id()`, so a
row naming another tenant still reaches its policy. Probe any such check
with `WITH x AS (INSERT ...) INSERT|UPDATE ...` where the CTE is not
referenced.

## 2026-10-22 - The format hook rewraps JSON outside web/, and no gate notices

**What happened:** on TYRE-326 an Edit to `api/internal/httpapi/refusal_codes.json`
rewrapped lines nobody touched. `.claude/hooks/format.sh` runs web's prettier
(`cd web && npx prettier --write`) on every edited `*.json`, `api/` included,
while `make lint` checks prettier only over `web/` (`npm run format:check`).
The hook changes the file and the gate that would flag it never looks there.

**The rule:** edit JSON outside `web/` from the shell, or revert the hook's
rewrap before committing, and check that `git diff` shows only your lines.

## 2026-10-21 - A capture entry a byte over budget can be filename noise (#146)

**What happened:** #146 failed `bundle:check` at 140374 gzip bytes against
a budget of 140373, with no new import in the entry. Built from the branch
and from develop, the entry chunk was 436555 raw bytes both times. The only
difference was the lazy chunks' content-hashed filenames in its preload
map, which change whenever a lazy route's source does, and gzip sized the
new names a byte or two differently. The budget is recorded with no
headroom, so a new hash alone can cross it.

**The rule:** when the entry goes over by a few bytes, build develop's
`web/src` in the same tree and compare the raw entry size and its text
before suspecting the change. If the raw bytes match and only filenames
differ, run `--record` and say so in the commit. Anything else is real
growth: move the import behind `React.lazy`.

## 2026-10-20 - A cloud session has no Docker daemon and loads no project plugin (TYRE-445)

**What happened:** in a claude.ai cloud session, `docker` and `dockerd`
are installed but no daemon runs, so `make db-up`, `make db-test` and
`make check` fail at their first Docker call (`docker.sock`: no such
file). Starting `dockerd` from inside the session was refused as a
containment escape. In the same session, `ui-ux-pro-max`, enabled in
`.claude/settings.json` through `extraKnownMarketplaces`, never loaded:
no skill was listed and `~/.claude/plugins/installed_plugins.json` was
empty. Skills vendored under `.claude/skills/` did load.

**The rule:** before planning stage 4 or `make check` in a cloud session,
run `docker info`. If it fails, do the ticket locally or have the owner
start the daemon in the environment's setup script; never start it from
the session. Do not count on a plugin (superpowers at user scope,
`ui-ux-pro-max` at project scope) in a cloud session; vendor the skill under
`.claude/skills/` or run the ticket locally.

## 2026-10-20 - Another session moved the shared checkout between two release blocks (TYRE-397)

**What happened:** during production's bring-up, a close-out session
working in the same checkout switched it to its own branch,
`TYRE-435-pr133-close-out`. The owner's next block, step 3's what-if,
printed that branch in `git log`, and the shell still held `ENV=staging`
from the switch-over. Only an added `[ "$ENV" = prod ]` guard kept the
block from setting staging's admin password to a new one. The bring-up
moved to a worktree detached at `origin/develop` and finished there.

**The rule:** run a release from its own worktree
(`git worktree add --detach ../TyrePlatform-release origin/develop`), never
from a checkout another session uses. Every block that writes production
checks `[ "$ENV" = prod ]` first.

## 2026-10-20 - A merge's deploy that needs unapplied state is held by cancelling its queued run, and a re-run keeps the run id (TYRE-435)

**What happened:**

- PR #133's merged `infra/app.bicep` named `kv-tyre-api-staging`, which
  only switch-over step 1 creates. Its `develop` run, 39399161984, still
  queued behind the previous merge's run, was cancelled before any job
  started; steps 0 to 2 ran from the merge commit, and `gh run rerun` then
  deployed it green. Develop runs are not cancel-in-progress, because
  cancelling a deploy mid-rollout strands a half-applied release.
- The close-out routine read that run as `cancelled`, found no later
  `develop` push run and stopped at step 2. Attempt 2 went green an hour
  later under the same run id, so the close-out was run by hand: step 2's
  `cancelled` case looks only for a later push run, and a re-run creates
  none.

**The rule:**

- When a merge's deploy would name Azure state that does not exist yet,
  cancel its `develop` run while it is queued, never once its deploy job
  has started. Then apply from the merge commit, after
  `git diff --quiet <reviewed head> HEAD -- infra` succeeds, and
  `gh run rerun` the same run id.
- When the merge commit's run reads `cancelled`, read its `run_attempt`
  and the attempt's job count
  (`gh api repos/Rourke9001/TyrePlatform/actions/runs/<id>/attempts/<n>/jobs --jq .total_count`)
  before deciding. While no later push run contains the merge commit, keep
  watching that same id for the full 60 minutes, because a re-run reuses
  it.

## 2026-10-19 - Text written through the Bash, Write and Edit tools is not always the text typed (2026-09-05, 2026-09-08, 2026-09-30, 2026-10-16; TYRE-101, TYRE-75, TYRE-346, TYRE-369, TYRE-435)

**What happened:**

- 2026-09-05 (TYRE-101): a plan written through `cat > file <<'EOF'` in
  the Bash tool failed with `ENAMETOOLONG: name too long, uv_spawn`. The
  heredoc is part of the spawned command line, so a few tens of KB overrun
  the argument limit, and the error names a path problem for a size
  problem.
- 2026-09-08 (TYRE-75):
  `sed -n "/^\\\\echo '== 58\\./,/^ROLLBACK;$/p" db/tests/004_tests.sql`
  printed nothing though the section was there. A script invoked as
  `probe.sh 'x\\y'`, in single quotes, reported its argument as
  `x\y`: every doubled backslash loses one before bash parses the
  command, so sed received `\e`. The same collapse silently rewrites
  heredoc bodies.
- 2026-09-30 (TYRE-346): suite section 67, spliced into
  `db/tests/004_tests.sql` with `node -e` and `String.prototype.replace`,
  lost a dollar from every `DO $$` body (in a replacement string `$$` means
  a literal `$`), and the halved backslashes turned `\echo` into
  `echo`. The mangled section reached a commit.
- 2026-10-16 (TYRE-369): `'[[:space:]\u00a0\u2007...]'` typed
  into 000058 through the Edit tool became six raw invisible characters,
  because the tool decodes `\uXXXX` in its input. The suite passed;
  only the re-review saw that no reader could see them and an editor could
  strip them. A doubled backslash and `\x` arrive as typed. Bash is
  the reverse: a single `\u` arrives as typed, and a doubled backslash
  before `u` collapses to one.
- 2026-10-19 (TYRE-435): a plan section written as
  `cat > step4.md <<'PLAN'` held a runbook block with
  `cat > "$s" <<'EOF'`. The file stopped at that inner line, cut inside its
  quote (`<<'EOF`), and the commands after the heredoc never ran; the only
  sign was bash's warning that the here-document ended at end-of-file while
  it wanted `PLAN`. The exact cause was not pinned down.

**The rule:**

- Write long files, and any content that itself contains a heredoc, with
  the Write tool, then run commands on the file. Reserve heredocs for short
  fragments, and after any heredoc write check the file's last line with
  `tail -1` before using it. If `uv_spawn` says `ENAMETOOLONG` and the path
  is plainly short, stop reading the path and look at the payload size
  (2026-09-05, 2026-10-19).
- Never spell a literal backslash as `\\` through the Bash tool.
  In a regex use a bracket expression, which survives because it holds a
  single backslash: `sed -n "/^[\]echo '== NN\./,/^ROLLBACK;$/p"`.
  Prove any such cut before trusting it: diff the extracted text against
  the section as it stands in the suite, because an empty cut piped into
  psql exits 0 and reads like a pass. For file content that must contain
  backslashes, use the Write or Edit tool rather than a heredoc
  (2026-09-08).
- Never type a `\u` escape into Write or Edit. Name the character by
  code point (`chr(160)` in SQL), or write the line through Bash. After any
  edit meant to add an escape, run `grep -nP '[^\x00-\x7F]'` on
  the file before committing (2026-10-16).
- Never splice SQL through a string `replace` or a quoted `-e` script.
  Write the new section to its own file with the Write tool and join the
  pieces by line number (`head -n`, `cat`, `tail -n +`), or use Edit. Then
  check `git diff` for `$$` and `\echo` before committing
  (2026-09-30).

## 2026-10-15 - psql does not interpolate a variable inside `-c` (TYRE-369)

**What happened:** the catalogue load was first drafted as `psql -v
tenant=<uuid> -c "SELECT set_config('app.tenant_id', :'tenant', true)"`.
psql sends a `-c` string to the server as written, so `:'tenant'` arrived as
text and failed with `syntax error at or near ":"`. The same statement read
from a file or from standard input is interpolated, which is why the form
looks right.

**The rule:** never expect `:'name'` to expand inside `-c`. Check the value
in the shell against a strict pattern and write it into the SQL, as `make
provision-catalogue` does with its uuid, or put the statements in a file
psql reads.

## 2026-10-12 — A teammate's subagents and forks report to the lead, not to the teammate (TYRE-412)

**What happened:** in the TYRE-412 spike (Claude Code 2.1.296, agent teams
on), a teammate dispatched a subagent and blocked on it. The subagent's
`SubagentHandback` was refused with "the agent that spawned you is no
longer running" while the teammate was still waiting, and the teammate's
Agent call returned "no report was delivered". The subagent's later
hand-back reached the lead. The teammate's `/code-review` fork also
completed to the lead and never to the teammate. Separately, the lead
wrote that the teammate had not answered a message: the teammate had sent
its reply 30 seconds earlier, and it had not reached the lead yet.

**The rule:** never give a teammate work that dispatches a subagent or a
background fork, such as subagent-driven development, `/code-review` or
`/review-pr`; it runs inline or stays outside the team (ADR-0018, U125). A
lead waits for a teammate's explicit report and never reads silence as an
answer.

## 2026-10-12 - A routine's trigger filter and its Run now settings are not what the API or develop say (TYRE-412, TYRE-416)

**What happened:**

- TYRE-412: the close-out routine's GitHub trigger, created with
  RemoteTrigger `create_webhook_trigger` and a filter for merged PRs into
  `develop` whose title names a `TYRE-` key, came back without the filter
  and fires on every closed PR. The API has no delete for a webhook
  trigger, and neither the create's response nor `get` on the routine
  shows its webhook triggers.
- TYRE-416: the push probe, started with Run now, sat at a permission
  prompt until the owner approved it on the session page; nobody was
  notified. Run now starts on `main` (the PR 53 run began at `08c6d2b`,
  main's head), whose `.claude/settings.json` then still asked before
  `git push`, which `develop` allowed since U126. The run on #108's merge
  started on that PR's head branch, with `develop`'s settings, and ran
  `git checkout --detach origin/develop` with no prompt, although no allow
  rule names that command.

**The rule:**

- Set and confirm a routine's trigger filters on its claude.ai routine
  page, never through the API. Never create a second trigger to correct the
  first: there is no delete, and both would fire (TYRE-412).
- Run now starts on `main`, whose settings lag `develop`'s between
  promotions. Test a routine with a real merge into `develop`, not Run now,
  whenever `main` does not yet carry the settings under test. Before adding
  allow rules for a routine's prompt, read the `ask` rules on the branch the
  run started on. Since the 20 Oct promotion (`d2bd08c`) `main` allows
  `git push` as well, so that particular prompt is gone (TYRE-416).

## 2026-10-11 — A failing Container Apps revision reads 100% traffic while the old one serves

**What happened:** during TYRE-79's red proof, `az containerapp revision list`
showed the new revision `d10-1-752c04b` at `trafficWeight` 100 and the
serving `c312-1-e055ae2` at 0, first while it was Activating and then after
it reached `ActivationFailed`. Every request was still answered by
`e055ae2`. In single revision mode the weight follows the template's
`latestRevision: true` at once, and traffic moves only when the revision is
ready, so the listing looks like the failed build took staging.

**The rule:** judge which build serves by what answers, `/readyz`'s sha and
revision through the FQDN, or by `latestReadyRevisionName`, never by a
revision's `trafficWeight` alone. `scripts/deploy-gate.sh` already requires
both.

## 2026-10-09 - Azure CLI flags drift, and a ticket's "staging is at N" was never read (TYRE-79)

**What happened:** a check script for the owner used `az postgres
flexible-server firewall-rule show -n <server> --rule-name <rule>`, written
from memory. The installed CLI takes `-s <server> -n <rule>`, and refused
the command. In the same pass, TYRE-368 said staging held migrations up to
000008. Reading `schema_migrations` showed version 1, because 000002 to
000008 reached git after the 21 Aug hand migration.

**The rule:** take every `az` flag for a script or runbook from `az <command>
-h` on the installed CLI, never from memory or an older doc. Read the live
state of an environment (`schema_migrations`, firewall rules, secrets)
before a spec plans around it, and record what was read on the ticket.

## 2026-10-02 - `az ad app update --set api.*` fails, and the admin center makes password users (TYRE-317)

**What happened:** during the CIAM checks, `az ad app update --id <tyre-api>
--set api.acceptMappedClaims=true` failed with "Couldn't find 'api' in ''"
and changed nothing. Separately, a test user created in the External ID
admin center ("Create new external user") was asked for its generated
password by the email passcode flow, never sent a code: the admin center
always writes a password user (`creationType: LocalAccount`, an
`emailAddress` identity), and a user keeps the method it was created with.

**The rule:** to change an application's `api` block, GET it with
`az rest`, edit the whole block and PATCH `{"api": <whole block>}`, then
read it back. Create a passcode user only through Graph, with no password,
`creationType` and `passwordPolicies` null and a `federated` / `mail`
identity (TYRE-317 comment 13468), never in the admin center.

## 2026-10-02 - A TanStack call count or refetch is read only after the render that proves it (2026-09-03; TYRE-92, TYRE-317)

**What happened:**

- 2026-09-03 (TYRE-92): a double-submit test asserted the `mutate` spy's
  call count straight after `fireEvent.click`, inside the click's own
  synchronous `act()`. It read `1` with or without the guard, because
  neither the guard nor its absence had run yet.
- 2026-10-02 (TYRE-317): a test that a 401 never unmounts the capture
  asserted straight after `client.refetchQueries()` in `act()`, and passed
  against a provider changed to drop the actor. query-core 5.101.4's
  `notifyManager` schedules observers with `setTimeout(0)`
  (`build/modern/notifyManager.js`, line 3), so the provider had not
  re-rendered yet.

**The rule:**

- A mutation call count proves nothing until the mutation has actually
  resolved. Assert after the success text renders
  (`await findByText(...)`), not inside the event's synchronous `act`, and
  confirm the assertion fails with the guard removed before trusting it
  (2026-09-03).
- After a refetch, assert only once the provider re-renders on it, with a
  `findBy` on what it derives from the new result (2026-10-02).

## 2026-10-02 - Parallel agents and worktrees share more state than they seem to (2026-08-26, 2026-09-03, 2026-09-09, 2026-09-23; TYRE-4, TYRE-92, TYRE-237, TYRE-180, TYRE-317)

**What happened:**

- 2026-08-26 (TYRE-4): a resumed subagent found HEAD past its own commit,
  read the author `Rourke Amiss` as the owner working alongside it, and
  declined to run `make check`. The commit was a sibling subagent's: every
  agent commits under the repo's configured git identity.
- 2026-09-03 (TYRE-92): two agents in one checkout each staged only their
  own files, and `git add <my files>` then `git commit` still swept in the
  sibling's staged files, because both commands use the one `.git/index`.
- 2026-09-03 (TYRE-92): two agents each told to wait for the other's commit
  before touching `web/src/fleet/fleet.css` deadlocked. It was broken by
  staging one agent's hunks directly into the index, built as `HEAD` plus
  its own hunks via `hash-object`/`update-index`, never touching the
  sibling's working copy.
- 2026-09-03 (TYRE-92): two implementers held their database gates until a
  verifier's report file existed, but it was written section by section
  while its probes still ran, so a `make db-reset` would have wiped a probe
  mid-flight had the hold not been re-sent against a terminal marker.
- 2026-09-09 (TYRE-237): seven agents dispatched in one message each wrote
  `edits.json` and `checker-before.txt` to the scratchpad root; two had
  their before-state files overwritten by a sibling and reported "before"
  numbers from memory.
- 2026-09-23 (TYRE-180): Agent isolation "worktree" created worktrees at
  08c6d2b while the session sat on develop 6ce7444. Two of four lanes built
  on that stale tree and reported "cut from develop"; one ran a green
  `make check` against a tree three weeks old.
- 2026-10-02 (TYRE-317): `make db-up` in the worktree `tp-fix-92` failed on
  a container-name conflict: compose names the project after the folder,
  while the running `tyre-pg` (the fixed `container_name` in
  `docker-compose.yml`) belongs to project `tyreplatform`. With
  `COMPOSE_PROJECT_NAME=tyreplatform` a dry run showed
  `Container tyre-pg Running` and no recreate, and the gate ran.

**The rule:**

- When HEAD has moved unexpectedly, do not infer a concurrent human from
  the commit author: it is the same name either way. Ask the controller,
  or read the commit message and the ledger, which name the task that
  produced it. The caution is right, the inference is not (2026-08-26).
- When more than one agent shares a worktree, commit with
  `git commit -m "…" -- <paths>` (the message before the `--`, the
  pathspec after it), which takes the working-tree contents of exactly
  those paths and ignores the rest of the index. Never `git add` followed
  by a bare `git commit`. A file the commit is creating needs
  `git add -N <file>` (intent-to-add) first, or the pathspec matches
  nothing and the commit fails; intent-to-add stages no content, so the
  pathspec commit still takes the working tree and still ignores whatever
  a sibling has staged, and it is not the `git add` this forbids. Verify with `git show --stat HEAD` immediately afterwards, and if
  a commit has already swallowed a sibling's work, report it rather than
  rewrite history the sibling is still committing onto (2026-09-03).
- When two agents share one file in one worktree, name which one commits
  first; never tell both sides to wait for the other. If a deadlock happens
  anyway, write only your own hunks to the index, never commit or revert
  the sibling's working tree (2026-09-03).
- When agents share one database, gate a handoff on a terminal marker in
  the report (`VERDICT`), never on the file existing. Tell long-running
  reviewers to write incrementally, since a usage-limit cut loses an
  unwritten report, and tell everyone waiting on them what the last line
  is (2026-09-03).
- Give every parallel agent its own scratch subdirectory in the packet
  (`scratchpad/<slice>/`), and have it record its baseline inside the
  report, not only in a file (2026-09-09).
- First thing in any agent worktree, run `git merge-base HEAD develop`. If
  it is not develop's tip, rebuild the branch onto develop before editing.
  The orchestrator re-checks the merge-base before trusting any lane's gate
  (2026-09-23).
- Run gates in a worktree as
  `COMPOSE_PROJECT_NAME=tyreplatform VITEST_MAX_WORKERS=4 make check`. A
  worktree's gate loads that branch's schema into the shared `tyre-pg`, so
  another checkout runs `make db-reset` before it next uses the database
  (2026-10-02).

## 2026-10-02 - oidc-client-ts bounds a request only when the timeout is passed per call, and then only until the headers arrive (2026-10-01; TYRE-317)

**What happened:**

- 2026-10-01: `renew()` called `signinSilent()` with no arguments, trusting
  `silentRequestTimeoutInSeconds` in the settings. In oidc-client-ts 3.5.0
  `signinSilent()` passes that option on from its own arguments as
  `timeoutInSeconds`, `_useRefreshToken` spreads the explicit `undefined`
  over its settings default, and `fetchWithTimeout` calls bare `fetch` with
  no abort signal. A node probe showed a signal only with
  `signinSilent({ silentRequestTimeoutInSeconds: 10 })`. The token store
  shares one renewal, so one stalled refresh would hold every API call on
  the page.
- 2026-10-02: with the timeout passed per call, the code comment and the
  spec said the refresh was bounded. But `fetchWithTimeout` clears its
  abort timer in a `finally` once `fetch()` resolves
  (`dist/esm/oidc-client-ts.js` 685-706), and `postForm` then awaits
  `response.text()` (784) with no signal, as `getJson` does with
  `response.json()` (739). Headers that arrived ahead of a stalled body held
  the shared renewal, and every API call behind it, until a reload.

**The rule:**

- Pass `silentRequestTimeoutInSeconds` to `signinSilent()` on every call,
  never rely on the settings for it, and keep a test that the refresh
  request carries an abort signal (`web/src/auth/oidc.test.ts`). On a
  library bump, re-check that a request the design bounds still gets a
  signal before trusting a setting's name (2026-10-01).
- A library timeout that aborts `fetch()` bounds only the wait for headers.
  Bound the caller's wait yourself (the token store's `bounded()` in
  `web/src/api/token.ts`), and when checking a library's timeout, read
  where its timer is cleared as well as whether a signal is passed
  (2026-10-02).

## 2026-10-01 - Web tests failing in files the branch did not touch are the runner or the host first (2026-08-26, 2026-09-24; TYRE-4, TYRE-211, TYRE-317)

**What happened:**

- 2026-08-26 (TYRE-4): `npx vitest run` from the repo root resolved a
  different vitest than the project's pinned one, from the wrong working
  directory, picked up files vitest excludes (the Playwright e2e spec among
  them), and every test failed identically on `document is not defined`
  and `__APP_VERSION__ is not defined`, untouched files included.
- 2026-09-24 (TYRE-211): a `make check` left running while the session sat
  idle was reaped by the harness for low host memory. The orphaned `make`
  carried on and its vitest step reported
  `Error: Worker exited unexpectedly`, 58 errors, 15 of 73 files run and
  every test that ran passing, on a branch with no web change; the same
  tree passed 702/702 once memory was free. It recurred on 25 Sep (PR #81)
  with a backgrounded `make check`.
- 2026-10-01 (TYRE-317): `make check` on a branch with no web change failed
  `web-test` three runs in a row with `Test timed out in 5000ms`, a
  different handful of CaptureFlow, Exceptions and Dashboard tests each
  run. Vitest 4.1 starts about 15 jsdom workers on the 16-core host with
  about 3.6 GB of RAM free; the same files passed alone, and
  `VITEST_MAX_WORKERS=4 make check` passed 837 of 837.

**The rule:**

- Run the web suite through the project's own scripts from `web/`
  (`cd web && npx vitest run`, or `make check` from the root), never
  `npx vitest` from the repo root. When a run fails in files the diff does
  not touch, and fails the same way in all of them, suspect the runner's
  resolution and working directory before the code: check the reported
  vitest version against `package.json` first (2026-08-26).
- When vitest fails with worker exits and no assertion failure, read it as
  the host, not the code. Do not debug it and do not re-run it while memory
  is short. Re-run the whole `make check` when the machine is quiet, and
  quote that run as the gate. Run it in the foreground in two halves,
  `make fmt lint` then `make test`, each inside the tool's 10-minute limit,
  so an idle session never holds it (2026-09-24).
- On this host run the gate as `VITEST_MAX_WORKERS=4 make check`. When web
  tests time out in files the branch did not touch, cap the workers and
  re-run before reading the diff for a cause. Never raise a test timeout or
  add `maxWorkers` to `vite.config.ts` to get there: the limit is the
  host's, not the repo's. Here the workers ran and were too slow, where on
  2026-09-24 they exited (2026-10-01).

## 2026-10-01 - Down files restore state, not text, and one migration file is not the schema (2026-08-26, 2026-09-05, 2026-09-15; TYRE-4, TYRE-101, TYRE-252, TYRE-317)

**What happened:**

- 2026-08-26 (TYRE-4): a reviewer read
  `app.inspection.odometer bigint NOT NULL` in `000001_init.up.sql` and
  raised a blocking finding; migration `000011` had dropped that
  constraint, and the live column is nullable.
- 2026-09-05 (TYRE-101):
  `docker compose run --rm migrate -path=/migrations … down 1` from Git
  Bash failed with
  `failed to open source, "file://C:/Program Files/Git/migrations"` (MSYS
  rewrote the container path), so neither `down 1` nor `up 1` ran, and the
  green `make db-test` afterwards read as a passing round-trip proof.
- 2026-09-15 (TYRE-252): the plan said to restore
  `app.check_measurement_ordinals()` in the down file from
  `000001_init.up.sql` verbatim, but 000043 had pinned
  `search_path = app, pg_temp` on it with `ALTER FUNCTION`.
  `CREATE OR REPLACE FUNCTION` assigns every property the command does not
  carry: without a `SET` clause `proconfig` goes from
  `{"search_path=app, pg_temp"}` to `NULL`. The suite runs at the up state
  and section 8d sweeps only what is installed there, so the gate would not
  have caught it.
- 2026-10-01 (TYRE-317): migration files moved to `$TMP/hold` for a
  pre-000052 baseline came back through an unquoted glob on the Windows
  temp path (`C:\Users\ROURKE~1\...`) that did not match.
  The database sat at 000051, and `migrate down 1` reverted 000051 while
  the diff still printed "grants restored".

**The rule:**

- In a migration chain, the initial migration states what a column was,
  never what it is: later migrations relax and re-tighten. Before asserting
  a constraint exists, query the running database
  (`information_schema.columns` via `docker exec tyre-pg psql`), or at
  minimum grep the whole of `db/migrations/` for later `ALTER`s on that
  column. One file is never the answer (2026-08-26).
- A down file restores **the state the up migration found**, which is the
  initial definition plus every `ALTER` since, not the text of the
  migration that first created the object. Before writing one, grep the
  whole migration chain for the object's name and fold in what you find
  (2026-09-15).
- Prove a down file or a round-trip by catalogue, not by a suite run:
  execute `migrate down 1` and read back `schema_migrations.version` and
  the property the later migration set (`proconfig`, `prosecdef`, grants, a
  dropped function, a restored signature), then again after `up 1`. The
  suite cannot run at the down state, a green gate at the up state says
  nothing about it, and a green suite after a down/up that printed an
  error is not evidence (2026-09-05, 2026-09-15).
- Prefix any hand-typed `docker compose run` that passes a container path
  with `MSYS_NO_PATHCONV=1`. The Makefile's `MIGRATE` carries the
  workaround; a typed command does not (2026-09-05).
- Never prove a down file by moving its migration out of `db/migrations/`.
  Take the baseline from the catalogue before the up is applied (migrate to
  the prior version, query, then up), and before trusting a `down 1`, read
  the `NN/d name` line it prints and check it is the migration under test
  (2026-10-01).

## 2026-09-29 - `npm ci` can leave `node_modules` short, and the failure surfaces in a later tool (2026-09-23; TYRE-143, TYRE-180, TYRE-239)

**What happened:**

- 2026-09-23 (TYRE-143): `npm ci` beside a running Vite dev server from the
  same checkout deleted `node_modules`, then failed with `EPERM ... unlink`
  on `node_modules/@esbuild/win32-x64/esbuild.exe`, which the server held
  open on Windows. `make lint` then failed with "'prettier' is not
  recognized"; `npm install` repaired it without touching the locked
  binary.
- 2026-09-23 (TYRE-180): `npm ci` in a fresh worktree reported
  `added 259 packages` and exit 0, then `make lint` failed on untouched
  `web/src/ui/Dialog.tsx` with
  `@typescript-eslint/no-unsafe-call`/`no-unsafe-member-access`, because
  `node_modules/@radix-ui/` did not exist though `package-lock.json` names
  it. A second `npm ci` reported `added 302 packages` and lint passed.
- 2026-09-29 (TYRE-239): a stopped `npm run dev` can leave vite's node
  child on the port. `TaskStop`, or killing its Git Bash shell, stops the
  shell but leaves vite's `node` child listening on 5173, found with
  `Get-CimInstance Win32_Process` and stopped with `Stop-Process -Id`.

**The rule:**

- Never run `npm ci` in a checkout whose dev server is running. Run gates
  in a worktree with its own `node_modules`, or stop the server first. If it
  has already happened, run `npm install` (not `npm ci`) to put back what
  was deleted, then confirm `git status` shows no lockfile drift you did not
  mean (2026-09-23).
- After stopping a dev server, confirm the port is closed
  (`curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` prints
  000) before any `npm ci` or `npm install`, and stop a survivor by pid
  (2026-09-29).
- When `make lint`'s TypeScript-aware eslint fails on a file the branch
  never touched, check whether the failing import actually resolves
  (`node -e "require('./node_modules/<pkg>/package.json')"`) before reading
  the diff for a cause. If it does not, re-run `npm ci` rather than
  debugging the lint rule: a short-counted `npm ci` is a silent partial
  install, not a reported failure, and a package's absence surfaces as a
  type-resolution error two tools later (2026-09-23).

## 2026-09-29 - `toContainText` runs sibling block text together with no separator (TYRE-239)

**What happened:** a Playwright `toContainText` reads an element's text
content, which runs sibling block elements together with no separator: the
dashboard's open-exceptions tile read "...1911 urgent..." because its value
`<p>19</p>` sat directly before the qualifier. A digit-guarded regex
`/(^|\D)11 urgent/`, proved only against a hand-built string starting at
"11", passed there and failed on the real page.

**The rule:** when an assertion depends on what sits beside a figure, pass
`{ useInnerText: true }` (rendered text, one line per block) and prove the
assertion on the real page with a planted wrong value, never against a
string you wrote.

## 2026-09-29 - A database measurement counts only when taken alone, on a fresh reset, and attributed by pg_stat_statements (2026-09-16, 2026-09-17; TYRE-247, TYRE-257, TYRE-348)

**What happened:**

- 2026-09-16 (TYRE-247): the dashboard read-path measurement took three
  attempts. The first blamed stale statistics for `app.v_exception` not
  finishing, though the `lr` CTE costed identically to the cent before and
  after `ANALYZE`: a backgrounded `make db-explain` was still running, and
  alone the statement took 4.9 seconds. Then auditor agents ran during a
  `make db-volume` load, and one's `make db-reset` queued a
  `DROP SCHEMA app CASCADE` behind the load's transaction and, cancelled,
  left `public.schema_migrations` dirty at version 1. The load's 977
  seconds against 328 before was then blamed on the contention; alone it
  took 923.
- 2026-09-17 (TYRE-257): the 328 to 923 second delta had been put down to
  000047's index being maintained once per `reading_measurement_governs`
  update. One instrumented run
  (`ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'`,
  `pg_stat_statements.track = all` so statements nested in plpgsql triggers
  are counted, `track_functions = all`, `log_min_duration_statement = 0`,
  container restarted, all reset afterwards) attributed every second. The
  largest term was `refresh_governing_tread`'s MIN() subquery seq-scanning
  the whole measurement table per row, because the SECURITY DEFINER
  function's query carried no tenant column (TYRE-259). The delta was the
  foreign-key check `reading_measurement -> reading`: planned once at the
  top of one transaction against an empty, never-analysed table, its
  cached generic plan walked the new index on `tenant_id` alone for all
  90,480 checks. Index maintenance did not register, and the same file
  took 524 seconds alone on the same box a day later.
- 2026-09-29 (TYRE-348): a `make db-volume` straight after `make db-test`
  on a fresh reset was cancelled at 23 minutes, against 248 s the day
  before. The suite's rolled-back inserts had set off autoanalyze on
  `reading` and `reading_measurement` 35 seconds before the load, which
  then planned on statistics that said 53 rows and probed
  `reading_by_tyre` once per inspection. Run as `make db-reset` then
  `make db-volume`, the same code loaded in 281 s; the change under test, a
  tiebreaker on the register's latest-reading sort, planned identically
  either way.

**The rule:**

- Nothing else touches the database while `make db-volume` or
  `make db-explain` is in flight, including a suite run, a second
  measurement pass and any subagent. Dispatch auditors before the load or
  after the measurement, never during, and check `ListAgents` before
  starting a run. `db-volume` holds one transaction for its whole load, so
  a concurrent `db-reset` blocks the entire database and then destroys the
  load when it unblocks. The Makefile's `db-reset` now runs with
  `ON_ERROR_STOP`, so a cancelled reset no longer leaves
  `schema_migrations` dirty; the rule stands (2026-09-16).
- When a timing looks pathological, the first question is what else was
  running, not what the planner did: confirm by re-running alone before
  diagnosing, because a plan that is identical cost for cost was not the
  thing that changed (2026-09-16).
- Load the volume state only as `make db-reset` immediately followed by
  `make db-volume`, with nothing that writes in between: no suite run, Go
  integration test or `make e2e`, since rolled-back inserts count toward
  autoanalyze too. When a load runs long, compare
  `pg_stat_user_tables.last_autoanalyze` with the load's start time, and
  `EXPLAIN` the suspect lookup under both versions on the same state,
  before blaming the change (2026-09-29).
- Before attributing a load or a query to a schema change, switch on
  `pg_stat_statements` with `track = all` and `track_functions = all`,
  reset the counters, run once, and read the nested statement totals and
  `pg_stat_user_tables` / `pg_stat_user_indexes`; that one run costs less
  than one wrong diagnosis. Inside a single-transaction bulk load, every
  plan the trigger chain and the RI checks cache is built against the
  statistics the table had when the transaction began, so interleave
  `ANALYZE` of the growing tables in the file (legal inside a transaction)
  before blaming an index. `make db-volume` runs `ANALYZE` after the load,
  which settles the plan `db-explain` prints, not the plans cached inside
  the load. A delta is only a delta between two runs taken back to back on
  the same box (2026-09-17).

## 2026-09-25 - A run on a database something else wrote to proves nothing: reset first (2026-08-27, 2026-09-01; TYRE-85, TYRE-97, TYRE-269)

**What happened:**

- 2026-08-27 (TYRE-85): two `make db-test` runs passed with a `TY009`
  defect live, because suite section 24 planted its rows behind
  `IF NOT EXISTS (… 'T2TRL1')` without a `BEGIN`/`ROLLBACK` wrap, so on a
  warm database the whole block was skipped. Only `make db-reset` ever ran
  it.
- 2026-09-01 (TYRE-97): eight sections had that shape, and two (20 and 23)
  kept their assertions inside the guard, never reached on a warm database.
  Six were wrapped; the three that could not be had consumers elsewhere in
  the file, one (section 26 scheduling section 21's `t2veh3`) 400 lines
  away, missed by a static identifier trace and caught only by the
  per-section cold run.
- 2026-09-25 (TYRE-269): a focused
  `go test -run "TestEstate|TestValuation|TestDashboard"` failed
  `TestEstateRelaysAppendixEToTheCent` and
  `TestDashboardRelaysEveryPinnedFigure`, reading as a valuation
  regression, on a database an earlier `make e2e` had likely written to.
  After `make db-reset` the same tests passed unchanged.

**The rule:**

- A suite section that persists rows behind an existence guard is only
  exercised on a fresh database. Verify anything touching one with
  `make db-reset && make db-test`, never `make db-test` alone, and when a
  new constraint plausibly conflicts with existing fixtures, reset before
  believing a green run (2026-08-27).
- Before a focused Go or suite run, `make db-reset`. A red pin on a
  database another run has written to says nothing about the change; only
  the reset run counts (2026-09-25).
- A suite section stages its rows inside `BEGIN;`/`ROLLBACK;`, never
  behind a bare existence guard, and never puts an assertion inside the
  guard. Before wrapping an existing unwrapped section, `rg` every
  identifier it plants across the whole file, then wrap one section at a
  time with `make db-reset && make db-test` between: a green run after each
  is the attribution; a trace, from a person or an agent, is a lead. Keep
  the trailing `set_config(..., false)` reset when you wrap: a session GUC
  survives the rollback (2026-09-01).
- `make test`, and so `make check`, runs `db-reset` before `db-test`
  (Makefile, `test` target), which is the reason it is the gate and a bare
  suite or focused run is not (2026-09-25, 2026-08-27).

## 2026-09-25 — vitest stubs every CSS import to `""`, `?raw` included, unless `test.css.include` matches (TYRE-276)

**What happened:** `brandConfinement.test.ts` reads the app's stylesheets as
text with `import.meta.glob(..., { query: "?raw" })` to check which
selectors read a brand custom property. Before `vite.config.ts`'s `test`
block carried a `css.include` pattern, the glob found all eight sheets but
every one came back as an empty string, so the test failed on
`expected [] to include '.shell-wordmark'` rather than on the CSS content.

**The rule:** a test that reads a stylesheet as text needs a guard
assertion that it saw a known selector, not just that the glob returned
files. Without that guard, a config gap that stubs every sheet to `""`
passes silently, because an empty haystack also satisfies "found no
offenders".

## 2026-09-24 - A gate's verdict is its own exit code, never the status of whatever wraps it (2026-08-26, 2026-08-31, 2026-09-05, 2026-09-06, 2026-09-16; TYRE-4, TYRE-101, TYRE-250, TYRE-252, TYRE-303)

**What happened:**

- 2026-08-26 (TYRE-4): a failing `make check` was reported as success twice
  in one session: as `make check | tail -60`, which exits with `tail`'s
  status since this shell runs without `pipefail`, and as
  `(make check > log 2>&1; echo "EXIT=$?" >> log)`, whose subshell exits
  with `echo`'s status whatever `make` did.
- 2026-08-31: `gh pr merge 35 --rebase --delete-branch` ended in
  `fatal: Not possible to fast-forward, aborting.` after the merge had
  landed: the failure was gh's post-merge update of a local `develop` that
  still pointed at pre-promotion hashes.
- 2026-09-05 (TYRE-101): `make db-test 2>&1 | tail -25` was reported as
  "completed (exit code 0)" on a suite whose output ended
  `make: *** [Makefile:63: db-test] Error 3`. It recurred on 2026-09-15 in
  a session with this rule in context (`make check 2>&1 | tail -40`, docker
  down, `fmt` failed), so TYRE-250 made it a hook.
- 2026-09-06: a background command ran `make e2e`, wrote `EXIT=0` to its
  log, then ended with a `grep -c` for `make: ***` lines. The count was 0,
  `grep` exits 1 when it matches nothing, and the harness reported the
  passed gate as failed.
- 2026-09-16 (TYRE-252):
  `gh pr checks 58 --watch --interval 20 --fail-fast | tail -20`, run to
  decide whether PR #58 could be merged, ended on
  `Post "https://api.github.com/graphql": ... connection was aborted` with
  `Browser smoke` still `pending` and exit 0, read as every check passing.
  The 0 was `tail`'s: `(exit 3) | tail -1; echo $?` prints `0`, and
  `set -o pipefail` makes it print `3`. The hook's pattern matches `make`,
  `npm` and `go test`, so it let `gh` through.
- 2026-09-24 (TYRE-303): the hook refused
  `go test -run 'TestA|TestB' ./internal/httpapi/` as a piped gate. It
  splits the command on `;`, `&&` and `||` and refuses any gate segment
  containing a `|`, without parsing quotes, so a `-run` alternation reads
  as a pipe.

**The rule:**

- Never judge a gate by the exit status of anything wrapping it: a
  pipeline, a subshell, a backgrounded compound. Write the status into the
  artifact and read it back from there:
  `make check > check.log 2>&1; echo "EXIT=$?" >> check.log`, then
  `grep EXIT= check.log`. Treat any agent that reports "exit 0" for a
  command containing a pipe as having reported nothing about that gate
  (2026-08-26, 2026-09-05).
- Enforced in part: `.claude/hooks/gate-not-piped.sh` refuses a piped
  `make`, `npm` or `go test` gate at PreToolUse (TYRE-250). `set -o pipefail`
  or an explicit `${PIPESTATUS[0]}` read is the way through, or run the
  gate unpiped and let its own status stand; read the output for the
  `make: *** … Error` line either way (2026-09-05).
- A gate is anything whose exit code you are about to believe, not the
  commands the hook can spell. `gh pr checks`, `gh run watch` and
  `gh run view` are gates the hook does not know: never pipe one. Redirect
  to a file and read the file, or put `set -o pipefail` first. Whatever the
  watch reported, re-read plain `gh pr checks <n>` before merging and
  require every row to carry a terminal state. A `pending` row means only
  that the watch stopped before that check finished, which `--fail-fast`, a
  dropped connection and an interrupted terminal all produce; in every one
  the run was never seen through (2026-09-16).
- A gate's verdict is the `EXIT=` line written to its log immediately after
  the gate, never the exit status of whatever ran last in the same command.
  Put diagnostics such as a match count before the `EXIT=` write or in a
  separate command, and read the log before believing a "failed"
  notification (2026-09-06).
- To run several Go tests by name, put `set -o pipefail;` first (the hook
  lets any command naming pipefail through), or run the package. Do not
  rewrite the regex to dodge the `|`, and do not weaken the hook to parse
  quotes: a false refusal costs one retry, and a missed pipe costs a green
  gate that never ran (2026-09-24).
- After any `gh pr merge` failure, check
  `gh pr view <n> --json state,mergeCommit` before concluding anything or
  retrying. gh's exit code covers the local housekeeping as well as the
  merge, and the two fail independently (2026-08-31).

## 2026-09-23 — A focusable SVG chart mark takes focus on mousedown, so a focus-driven tooltip sticks after a click (TYRE-238)

**What happened:** the PR #70 fix gave BandChart separate hover and focus
state so a keyboard user's tooltip survives the pointer leaving. A
`<g tabIndex={0}>` also takes focus when clicked, so a mouse user's tooltip
then stayed on the clicked bar after they moved away. jsdom does not focus
on mousedown, so every test passed; the whole-branch review found it.

**The rule:** when a chart mark's tooltip follows focus, suppress pointer
focus with `onMouseDown={(e) => e.preventDefault()}` on the focusable mark,
and test that mechanism (`createEvent.mouseDown`, assert `defaultPrevented`),
since jsdom cannot show the stuck tooltip.

## 2026-09-23 - A finding's premise about a tool, a library or the data is reproduced before anyone acts on it (2026-08-31, 2026-09-19; TYRE-36, TYRE-238)

**What happened:**

- 2026-08-31: a reviewer failed a task because the pasted lint transcript
  read `(rule 6)` where the rule's committed message ends `(rule 6).`,
  reasoning that the stylish formatter prints messages unmodified.
  Re-running the planted violation showed eslint strips the trailing
  period; the evidence was genuine.
- 2026-09-19 (TYRE-36): a review said the analytics API renormalised the
  tread distribution because the seeded `tread_bands` `[[0,4],[5,7],...]`
  leave gaps, naming a 4.5 mm tyre. The regression test written on that
  sentence passed before the fix: `app.tread_band_list` takes
  `upper_exclusive_mm` from `lead(lower)`, so the bands partition
  [0, infinity). The defect was real for another reason (nothing pins the
  lowest band to zero). The same review found the money gate blind to a
  tagged struct field, a shape its own `--self-test` control did not
  contain, so it had reported green over it on every run.
- 2026-09-23 (TYRE-238): the PR #70 review said `@radix-ui/react-select`
  throws on an Item with `value=""`. The installed 2.3.7 treats `""` as no
  selection and shows the placeholder, so the app would mislabel, not
  blank.

**The rule:**

- When a finding turns on how a tool formats its output, reproduce it
  before acting: a minute of running beats an hour of adjudicating, and a
  confident byte-level argument can still rest on a false premise about the
  tool. Ask reviewers to say out loud when a finding depends on such a
  premise (2026-08-31).
- Before writing the regression test, reproduce the finding's premise
  against the source or the running database, not against the review text;
  a test that passes before the fix is the premise failing, not the fix
  being unnecessary (2026-09-19).
- A gate's control carries the shape its real input has, tags and all, or
  the run proves only that the control fires (2026-09-19).
- Before a finding states what a dependency does, grep its installed `dist`
  under `web/node_modules` (or run it) and cite the line. Severity follows
  the behaviour you saw, not the behaviour you remember (2026-09-23).

## 2026-09-23 — A dev-only route written as `{x && <Route/>}` survives the production build and fails the capture budget (TYRE-238)

**What happened:** the gallery's `{Gallery && <Route/>}` emitted no chunk, yet
the minifier kept `null` in the route children and the entry went over budget.

**The rule:** a build-time-false JSX child still leaves a placeholder in the
children array (`!1`, or a kept `null` const). When a dev-only guard must
leave nothing, fold it into a sibling that exists anyway, so both branches
build to the same output. Prove any dev-only guard with
`npm run bundle:check`, never by a missing chunk. `make lint` runs it
through the `web-bundle` target, so an over-budget capture entry fails the
gate.

## 2026-09-19 — A control query on the admin connection reads a tenant-scoped function as empty, and passes (TYRE-36)

**What happened:** B7.2's inflation compliance test compared the endpoint's
band total against a control query run on the `admin` (postgres) connection:
`SELECT sum(reading_count) FROM app.inflation_compliance(...)`. The function
filters on `current_setting('app.tenant_id')`, which the admin connection
never sets, so the control returned 0 while the endpoint correctly returned
26. The test only failed because the endpoint was right. Had both been
broken it would have compared 0 to 0 and passed. The estate and exception
controls in the same file are safe for a different reason: they read views
with an explicit `WHERE tenant_id = $1`, and postgres bypasses RLS.

**The rule:** a control that reads a tenant-scoped function binds
`app.tenant_id` itself, in its own transaction (`set_config(..., true)`,
rolled back), and asserts the control is non-zero before comparing it to
what the endpoint returned. A control whose expected value could be the
empty answer is not a control.

## 2026-09-18 — An audit's drafted replacement comment drops requirement IDs (TYRE-260)

**What happened:** the repo-wide comment trim ran as read-only audits that
drafted replacement text per block, then executors that applied it. Every
executor, across all six slices, found drafts that had dropped a requirement
or ticket ID the original carried: about fifteen cases, from `NFR-USE-005`
in a dashboard test to `TYRE-80` in an e2e header to `BR-VAL-002` in a seed
generator's emitted comment. The drafts read well and passed the style
checker; the ID was simply gone, and shorthand such as `FR-INS-030a/030b`
had also stopped matching the second ID's token. The audits had been told
to preserve IDs and believed they had.

**The rule:** never accept a comment edit, hand-written or delegated, without
a per-file diff of the ID set against `HEAD` (the regex is in
`docs/comments.md`'s ID list plus `TY[0-9]{3}` and bare `D`/`U`/`Q`
numbers). Run it after the edit and before the gate, per file, because a
package-level union hides a loss that moved between files. A shorthand
range is two IDs written out in full.

## 2026-09-11 — PostgreSQL pulls up a no-FROM LATERAL and re-runs the resolver at every reference site (TYRE-41)

**What happened:** `app.v_exception` reads a resolved `threshold_policy` row
and a resolved `target_pressure` row through `CROSS JOIN LATERAL`. A LATERAL
subquery with no `FROM` clause of its own is pulled up by the planner, which
then substitutes the subquery's target-list expression at every site that
references the result, multiplied again by every CTE it inlines. Over the 53
readings of the fixture tenant that was 878 resolver evaluations at 35 ms,
against 4 at 6 ms once fenced, the fence also letting the planner memoize.
Nothing in the result set differs, so a correctness-only review sees no
symptom. The header then stated the rule as "more than one field off a
resolved row", while the file's own part F fences a lateral that reads one
field twice, so the canonical instruction did not describe the practice
beside it and a reader copying the header would have dropped that fence.

**The rule:** fence every LATERAL that calls a resolver with `OFFSET 0`, and
judge the need by whether the resolved row is referenced more than once, not
by how many fields come off it. The canonical rationale is the header of
`db/migrations/000045_exception_view.up.sql`; cite it rather than restating
the mechanism at each site.

## 2026-09-11 — A `now()`-stamped configuration plant does nothing against an as-at bound (TYRE-41)

**What happened:** a suite block planted `app.configuration` with
`effective_from = now() - interval '1 minute'` to shift
`reading_staleness_days`, then asserted against
`app.unit_inspection_status('2026-08-01')`. Nothing moved. The function
resolves its keys at the as-at bound, not at `now()`, and `app.config_for`
takes `effective_from` strictly before that bound, so a row stamped today is
simply not in force on a historical day. The plant read like a working setup
and the assertion failed for a reason that had nothing to do with the code
under test.

**The rule:** when planting `app.configuration` or `app.threshold_policy`
for a function that resolves at a historical as-at bound, stamp
`effective_from` before that bound, not a minute back from `now()`. Check
which instant the function resolves at before choosing the timestamp, and
say so in the block's comment so the next author does not undo it.
`app.threshold_policy` refuses a row dated before its own transaction
(000054), except an empty scope's first row at `-infinity`: plant
`-infinity` in an empty scope, or ask at an as-at bound after `now()`.

## 2026-09-09 - A green comment check is a floor: it reads only the files it is given and catches only the phrasings it names (2026-08-26, 2026-08-27; TYRE-4, TYRE-82, TYRE-237)

**What happened:**

- 2026-08-26 (TYRE-4): `scripts/check-comment-style.mjs` flagged "used to
  have" but passed "used to render" and "One entry read…" in the same
  commit, which narrate a change just as plainly. Its change-narration list
  is deliberately narrow: precision over recall.
- 2026-08-27 (TYRE-82): `node scripts/check-comment-style.mjs` with no
  arguments exited 0 over three new, unstaged migrations holding two
  narration violations: with no arguments it enumerates `git ls-files`.
- 2026-09-09 (TYRE-237): the first em-dash rule required a letter or digit
  beside the dash so a quoted lone glyph would pass, and reported 0 on
  files still holding about twenty em dashes after `"`, `)` or `}` at the
  end of a wrapped line. Three slice agents found them with a plain `grep`.

**The rule:**

- Treat the comment gate as a floor, not a ceiling. Before closing a
  branch, read the comments the diff adds and ask of each whether it
  explains a constraint or merely narrates the edit; `/comment-audit` exists
  for this. Do not widen the checker's patterns to catch a phrasing you just
  hit: precision is the design, and a noisy gate gets ignored, which is
  worse than a narrow one (2026-08-26).
- A no-argument run proves something only about files git already tracks.
  When auditing new files, run `node scripts/check-comment-style.mjs <paths>`
  or stage them first. The PostToolUse hook `.claude/hooks/comment-style.sh`
  checks each file Write or Edit touches by its path, tracked or not;
  `make lint`'s no-argument run still does not see untracked files
  (2026-08-27).
- A gate for a character matches the character, then subtracts the one
  legal form (`strip` the quoted lone glyph before matching), never the
  other way round; the checker's em-dash rule now does this. After changing
  a checker, confirm it with the dumbest possible grep over the same files
  before trusting its zero (2026-09-09).

## 2026-09-08 — Dropping a policy's WITH CHECK weakens nothing, and an audited table refuses twice (TYRE-75)

**What happened:** a red proof was meant to show suite section 58g's
cross-tenant INSERT probe has teeth, by re-creating
`app.composition_observation`'s policy with `USING` only. The section stayed
green. Two probes explained it, and both are traps a mutation-testing pass
will hit again. First, a `FOR ALL` policy that omits `WITH CHECK` reuses its
`USING` expression for writes, so the "mutation" was the original policy —
the refusal named `composition_observation` itself. Second, with the honest
mutation `WITH CHECK (true)`, the row landed and the table's ADR-0014 audit
trigger then inserted an `app.audit_log` row carrying the *other* tenant's
`tenant_id`, which `audit_log`'s own policy refused with the identical
42501. An `EXCEPTION WHEN insufficient_privilege THEN NULL` probe cannot
tell the two apart, so the assertion — and the comment above it claiming to
prove "WITH CHECK, not merely USING" — asserted less than it said.

**The rule:** to isolate a policy's WITH CHECK half, mutate it to
`WITH CHECK (true)`; omitting the clause is a no-op (`polwithcheck` stores
NULL and the executor falls back to `polqual`, which is why the catalogue
shape sweep still flags it). And on any audited tenant table, trap the
refusal's message text for the table under test —
`… for table "composition_observation"` — never the bare
`insufficient_privilege`, because the audit chain answers with the same
SQLSTATE from a different table.

## 2026-09-07 — A grant restored for a teeth proof trips the catalogue sweep first (TYRE-158)

**What happened:** to prove suite section 55 detects a landed write, a fix
wave re-granted `UPDATE ON app.tenant` to `app_rw` and ran `make db-test`
expecting section 55 to fail. Section 37b's catalogue sweep — which reads
`information_schema` for exactly that grant — stopped the suite twenty
sections earlier, so section 55's own detector never ran under the exploited
grant, and the implementer could only report "not disproven".

**The rule:** a behavioural probe of a grant or a policy sits behind the
catalogue sweeps that assert the same fact, so a teeth proof that restores
the privilege must run the target section standalone: cut the section from
its `\echo` banner to its `ROLLBACK;` and pipe it through
`docker exec -i tyre-pg psql -U app_login -d tyre -v ON_ERROR_STOP=1`. Expect
the section's own attributable FAIL line, then REVOKE and re-run the cut
section for its PASS before the full gate.

## 2026-09-05 — A control character in source passes every gate and turns `git diff` into "Binary files differ" (TYRE-101)

**What happened:** a template-string key separator was written as a literal
NUL byte. vitest, eslint, prettier, `tsc` and `check-comment-style.mjs` were
all green — the byte is a legal string character and a working map-key
separator, and no gate in `make check` looks at source bytes. Only `git diff`
refusing to render a hunk (`Binary files … differ`) gave it away. Committed,
it would have made every later diff and review of that file unreadable.

**The rule:** read `git diff --stat` before committing. A `Bin` line or a
`Binary files … differ` hunk on a text source file is a control character the
gates cannot see — find it with
`grep -nP '[\x00-\x08\x0b\x0c\x0e-\x1f]' <file>` (which leaves tabs, line
endings and the repo's non-ASCII punctuation alone) and replace it. Never use
a control character as a composite-key separator; pick one the domain's ids
cannot contain.

## 2026-09-05 - Windows hosts lie about their toolchain (2026-08-20; TYRE-101, TYRE-369)

**What happened:**

- 2026-08-20: `python3` on stock Windows is a Microsoft Store stub that
  opens a browser, and Git Bash rewrites `/migrations` into a Windows path
  and breaks container mounts. Both failed far from the cause.
- 2026-09-05 (TYRE-101): a script comparing the suite's pin sections
  between `git show origin/develop:db/tests/004_tests.sql` and the working
  tree reported sections 8, 17 and 18 moved on an untouched file (`git diff`
  empty, both sides 360121 bytes). `subprocess.run(..., text=True)` decodes
  with the locale codec, cp1252 here, so every section holding an em dash
  decoded differently; pure-ASCII section 7 looked clean. A false moved pin
  costs the rest of the session on any branch touching money.
- TYRE-369: a `docker run -v` typed in Git Bash with `$(pwd)` mounted a
  folder the container never saw.

**The rule:**

- On this host, route every command through the Makefile, which already
  carries the workarounds (`PYTHON` detection, `MSYS_NO_PATHCONV`). When
  adding a new command, assume the host toolchain is hostile and pin the
  workaround in the Makefile, not in a shell history (2026-08-20).
- A `docker run -v` typed in Git Bash needs a Windows host path,
  `$(pwd -W)` or make's `$(CURDIR)`, because with `$(pwd)` the folder never
  reaches the container. List the mount before anything reads from it
  (TYRE-369).
- Never let `subprocess` or `open()` pick an encoding on this host: read
  bytes and `.decode("utf-8")` explicitly on both sides of any comparison
  (2026-09-05).
- Give any comparison script a control that reports what it found
  differing everywhere, not just in the range you care about: "three of my
  four pins moved and nothing else did" is the shape of a decoding bug, and
  the control is what makes that visible instead of alarming (2026-09-05).

## 2026-09-03 - An e2e failure in a spec the branch did not touch is the environment until shown otherwise (TYRE-72, TYRE-92)

**What happened:**

- TYRE-72: four `make e2e` runs each failed a different spec the branch
  never touched, decisively `fitments.spec.ts` with
  `TY012 this tyre was fitted at 19:31:05.13; a removal cannot predate its own fitment`
  on a removal posted 1.2 s after the fitment, both stamped `now()`.
  `docker exec tyre-pg date` drifted by up to a second against a host that
  `w32tm` showed steady; `hwclock -s` in the docker-desktop distro and a
  Docker Desktop restart did not settle it. Forty minutes went on correct
  fitment SQL.
- TYRE-92: `make e2e` ran against a long-lived `make api-run` container
  that had served across earlier reseeds. The reseed re-creates schema
  `app`, minting new type OIDs, while the API's pgx pool kept its prepared
  statements, so `admin.spec.ts` showed "The unit could not be added" and
  the API log
  `creating vehicle: ERROR: cache lookup failed for type 908424 (SQLSTATE XX000)`
  and `cached plan must not change result type (SQLSTATE 0A000)`. A
  restart, giving a cold pool, made the identical suite green.

**The rule:**

- When an e2e refusal says a later event predates an earlier one, or a date
  step fails on a spec the branch did not touch, compare the container
  clock to the host before opening the code. The container's busybox `date`
  prints `%N` literally, so ask Postgres for the instant instead:
  `docker exec -i tyre-pg psql -U postgres -d tyre -Atc "select extract(epoch from clock_timestamp())"`
  against the host's `date -u +%s.%N`, a few times. A jitter of tenths of a
  second between samples is the WSL 2 VM clock, seen after a PC restart;
  take CI's Browser smoke job as the e2e line and say so in the PR
  (TYRE-72).
- Restart the API immediately before `make e2e`, every time, and never
  reuse one that has already served a query: one warmed request is enough,
  and the first reseed is as dangerous as the fifth. When a spec you did
  not touch fails with a generic "could not be added"/"could not be saved"
  fallback, read `docker logs` on the API before reading the spec: a `0A000`
  or `XX000` there means the process predates the schema it is querying,
  not that anything in the branch is wrong (TYRE-92).

## 2026-09-03 — A gate run in the background ends a subagent's turn before the result exists (TYRE-72)

**What happened:** an implementer subagent started `make e2e` and later
`make lint` with `run_in_background` and then had nothing left to do, so its
turn ended and it reported the task with the gate still running. Its report
described a run it had never seen; the orchestrator had to resume it twice by
message to collect the real result.

**The rule:** inside a subagent, run `make check`, `make lint`, `make db-test`
and `make e2e` in the foreground and wait for them. Backgrounding is for the
orchestrator, which stays alive; a subagent's turn is over the moment it has
no foreground work, and a gate it did not wait for is a gate it did not run.

## 2026-09-03 - A calendar date is not an instant, and the tenant's day runs ahead of UTC's (2026-09-01; TYRE-91, TYRE-92, TYRE-93, TYRE-121)

**What happened:**

- 2026-09-01 (TYRE-91): `app.receive_tyres` stamped its events at
  `received_date::timestamptz`, midnight of that date, which outruns
  `now()` for a future date and simply east of UTC, where the tenant's day
  begins up to 14 hours before UTC midnight. `app.tyre_in_estate_asof`
  reads the latest `to_state` event, so a tyre disposed afterwards stayed in
  the valuation estate. Suite section 39b had sidestepped the hazard by
  pinning `received_date` to the past.
- 2026-09-03 (TYRE-93): `dispatch_tyre`'s instant,
  `least(p_sent_on::timestamptz, now())` cast in the session's zone,
  stamped a same-day dispatch at midnight, behind the removal it follows,
  so `app.tyre_in_estate_asof` read `REMOVED` while `app.tyre.state` read
  `AT_RETREADER`.
- 2026-09-03 (TYRE-92): an e2e step meant to trip `app.dispatch_tyre`'s
  future-date refusal built its date as `new Date()` plus one UTC day, but `app.tenant_today` (Africa/Johannesburg, UTC+2)
  already reads that date between 22:00 and 24:00 UTC, when the step would
  have passed the wrong way. It had never been run.
- 2026-09-03 (TYRE-121): `make db-test` passed cold and failed warm with
  `FAIL: a disposed tyre is back in the estate`. `app.receive_tyres` stamps
  `least(tenant_today::timestamptz, now())`, which clamps to `now()`, the
  disposal's instant, while the tenant day runs ahead of UTC;
  `tyre_event.recorded_at` also defaults to `now()`, so
  `tyre_in_estate_asof` orders by two keys that tie and heap order decides.

**The rule:**

- An event instant is `least(derived_date::timestamptz, now())`, never a
  bare date cast, and a user-supplied date that drives one is bounded
  against `app.tenant_today()` (2026-09-01). Where the caller supplies a
  date rather than a timestamp, the instant is `now()` when the date equals
  the tenant's today, otherwise `least(date::timestamptz, now())` cast in
  the tenant's zone, and the function refuses the write when that instant
  is earlier than the tyre's latest recorded movement rather than clamping
  to it: a clamp ties two events at the same instant, which makes
  `tyre_in_estate_asof` ambiguous (2026-09-03). `app.tenant_day_instant`
  (000037) computes that instant: `now()` for the tenant's today,
  tenant-local midnight for an earlier day, and NULL for a future day so the
  caller refuses.
- Comparing `occurred_at::date` reads the session `TimeZone`, which nothing
  in this deployment pins: use the `< ((d + 1)::timestamp AT TIME ZONE 'UTC')`
  boundary `000016` uses, so two predicates in one `WHERE` cannot disagree
  by a day. And when a test avoids a shape rather than asserting on it, ask
  what it is avoiding (2026-09-01).
- A test that needs a date the tenant will call future uses a fixed
  far-future literal, never arithmetic on the browser or CI clock. Any
  `new Date()` in a spec that reaches a tenant-day comparison is a finding
  (2026-09-03).
- Before treating a suite section 39p failure as a regression, read the
  clock (`SELECT now()` in the container). Between 22:00 and 24:00 UTC the
  section proves nothing either way; re-run after the UTC day rolls over.
  The fix is a tie-break the two events cannot share and belongs to the
  merged 000031 (TYRE-121), never to the suite. `app.tyre_in_estate_asof`
  (000016) still orders by `occurred_at DESC, recorded_at DESC`, so the tie
  stands (2026-09-03).

## 2026-09-03 — A banner-delimited slice of `make db-test` output is not a stable baseline (TYRE-93)

**What happened:** the standard way of proving a slice left the pinned
sections alone — `make db-test 2>&1 | sed -n '/== 7\./,/== 9\./p'`, diffed
before and after — reported a PASS line as *missing* when nothing had
changed. `\echo` banners go to stdout and psql's `NOTICE` lines to stderr, so
`2>&1` interleaves two streams whose relative order is not fixed: the last
`NOTICE` of section 18 printed one line after the `== 19.` banner on the
second run and fell outside the range. Chasing it as a real regression costs
a reset cycle; believing it costs more.

**The rule:** diff the ordered `NOTICE`/`PASS` stream, never a
banner-delimited range. `diff <(grep PASS before.log) <(grep PASS after.log)`
with the new section's own lines filtered out is order-stable and covers the
whole suite; slice it with `sed -n '/<first pinned PASS text>/,/<last>/p'` on
that stream if a section-scoped diff is wanted.

## 2026-09-03 — An idempotency guard makes a "does nothing after X" assertion vacuous (TYRE-94)

**What happened:** `app.generate_inspection_tasks` skips any unit that
already holds an OPEN or ESCALATED task, so "park the unit, generate again,
no new task appears" passed even with the `v.status = 'ACTIVE'` filter
deleted — the second call creates nothing for any unit, parked or not, so the
assertion could not have caught the regression it was meant to guard.

**The rule:** before asserting that a filter excluded something, clear
whatever the guard keys on (here: cancel the existing tasks, and move the
as-of date past the due-date window) and pair the claim with a control the
same call still acts on. If the assertion cannot fail when the rule under
test is removed, it is testing the guard, not the rule.

## 2026-09-01 — Renaming a CSS class is unchecked by every gate we have (TYRE-91)

**What happened:** a review commit renamed `.tyre-dispose` to `.tyres-row-form`
in `TyreList.tsx` and did not rename the eight rules in `fleet.css`. Both row
forms on the register lost their styling entirely — controls fell back to
browser defaults. `make check` and `make e2e` were green over it, because
nothing in this codebase connects a `className` string to a stylesheet:
TypeScript does not see CSS, eslint does not see CSS, and every e2e assertion
is deliberately on roles and text rather than CSS (web/CLAUDE.md, correctly).
It was found only by screenshotting the screen before and after an unrelated
change. A whole-file scan for orphaned selectors was tried as a possible gate
and abandoned: `capture.css` composes class names dynamically
(`cap-pos--${band}`), so the check is noise without real work.

**The rule:** a CSS class rename is a two-file edit — grep the old name across
`web/src` and confirm zero hits before committing. When a change touches a
stylesheet or a `className` at all, screenshot the affected screens before and
after; four of five screens being byte-identical is what makes the fifth one's
difference worth reading. Do not trust a green gate for anything visual.

## 2026-09-01 — A function parameter's `numeric(p,s)` is discarded; only a local rounds (TYRE-91)

**What happened:** `app.set_tyre_cost` and `app.receive_tyres` both computed
`rand_per_mm` through the one permitted implementation, with what looked like
identical arguments — and stored different rates for the same input.
`receive_tyres` assigns the price into a `numeric(12,2)` *local*, which
applies the type modifier and rounds to cents before the divide;
`set_tyre_cost` used its `p_price` argument directly. Postgres discards type
modifiers on parameters, so declaring `p_price numeric(12,2)` would not have
helped either — the argument arrives as bare `numeric` regardless. The
column rounded afterwards, leaving a row whose stored rate could not be
reproduced from the price stored beside it: a cent of divergence at
Appendix E magnitude, against the acceptance gate itself.

**The rule:** never rely on a parameter's declared precision — it is
documentation, not behaviour. Round money explicitly, into a typmod'd local
or with `round(x, 2)`, before any arithmetic whose result is stored. And
when two writers must agree to the cent, pin the invariant with a value that
can actually break it: the existing check used a 2dp price, which no
rounding-order bug can fail.

## 2026-09-01 — `display_code_counter` has no `ON DELETE CASCADE` on `tenant_id`, unlike every other tenant FK (TYRE-91)

**What happened:** a Task 8 test fixture (`plantGeneratedPolicyTenant`)
seeded a row in `app.display_code_counter` for a GENERATED-policy tenant,
then let `plantTenant`'s existing `t.Cleanup` delete the tenant as usual.
Cleanup failed on `display_code_counter_tenant_id_fkey` (23503). Every other
tenant-scoped table in the schema declares `tenant_id ... REFERENCES
app.tenant(id) ON DELETE CASCADE` (migration 000001 onward); migration
000030's `display_code_counter` is the one exception, plain `REFERENCES
app.tenant(id)` with no cascade.

**The rule:** any test (or future write path) that plants a row in
`app.display_code_counter` must delete it explicitly before the owning
tenant is deleted — register the counter's own `t.Cleanup` after the
tenant's, since `t.Cleanup` runs LIFO. Do not assume a tenant delete cascades
through every tenant-scoped table in this schema; `display_code_counter` is
the one it does not.

## 2026-09-01 — Two refusal branches sharing a SQLSTATE make a cross-tenant probe vacuous (TYRE-91)

**What happened:** suite section 39l probed cross-tenant isolation by calling
`app.dispose_tyre` on another tenant's tyre and expecting `TY012`. The chosen
fixture tyre was seeded `FITTED`, which `dispose_tyre` *also* refuses with
`TY012` on its own terms (an invalid source state for the disposal
attempted), independent of RLS. A follow-on RLS audit ran the probe with RLS
bypassed and it still printed PASS: the row leaked, but the state check fired
before anyone could tell, and the shared SQLSTATE hid it. The fix needed two
parts, and either alone would still be vacuous — matching the caught error's
message text against the RLS-correct branch's exact string (`'no such tyre in
this fleet'`), *and* a second, independent probe (`set_tyre_cost` on the same
row) whose refusal comes from a different function and a different SQLSTATE
entirely, so the section does not rest on message-text matching alone.

**The rule:** a cross-tenant refusal probe must target an operation whose
*observable outcome* genuinely differs between "RLS correctly hid the row"
and "RLS leaked the row but something else also refused it" — asserting only
a shared SQLSTATE is not enough, because two different code paths can raise
the same SQLSTATE for entirely different reasons. Before trusting such a
probe, check whether the fixture row would independently fail the same
check for a non-RLS reason, and if there is any doubt, add a second probe
through a different function so no single error code (or message string) is
carrying the whole proof. Extends the 2026-08-20 "a test that cannot fail is
worse than no test" entry and the 2026-08-28 WITH-CHECK-mask entry: same
family — a security-relevant assertion that passes for the wrong reason.

## 2026-09-01 - What a plan or a handover states is a hypothesis until checked against the code (2026-08-26; TYRE-4, TYRE-91)

**What happened:**

- 2026-08-26 (TYRE-4): three times on one plan, a task's summary
  "Interfaces"/"Files" block disagreed with the verbatim code in the same
  task: a component attributed to the wrong task, a type the code never
  imports, a required `meta` field omitted.
- 2026-08-26 (TYRE-4): three times in one branch a value the controller
  handed over as settled was wrong (a test count of eleven that a `grep -c`
  made thirteen; a predicted mutation result of `Infinity` that was `100`,
  because a clamp added in the same ruling absorbed it), caught only
  because the implementer re-ran the derivation.
- 2026-08-26 (TYRE-4): handed "type the full `1200`, it must not settle at
  three digits", an implementer wrote a test carrying that sentence as its
  title and comment while typing `120`, a byte-for-byte duplicate of the
  test above it. Its self-review and a skim of the diff both read it as
  done.
- 2026-09-01 (TYRE-91): B5's Task 13 brief narrated an e2e flow (setting a
  cost through an inline register control, a hand-typed code showing the
  TY011 message, a scrapped tyre leaving an "active" register) that no
  landed task had built and one task's DoD forbade. Only reading the task
  briefs and the landed component files line by line showed it.

**The rule:**

- Where a plan describes an interface in prose and also shows the code, the
  code wins: check the two against each other before dispatching, and treat
  a prose/code disagreement as a defect in the prose, not a choice. Never
  build a file list from a summary block alone (2026-08-26).
- Before writing a spec against a flow a plan narrates, check each step
  against the specific task brief that was meant to build that step's UI
  surface, and against the component source, not against the plan's
  description of the flow. A plan's prose is written once, ahead of
  implementation, and nothing re-verifies it against what landed
  (2026-09-01).
- Hand over the derivation, not just the result, and say which values are
  expected rather than observed: an implementer can only check reasoning it
  can see. Count with a command, never by eye. When a prediction and an
  observation disagree, work out why before assuming the observation is the
  error; the mismatch above exposed that two guards were each load-bearing
  for a different failure, which the original reasoning had missed
  (2026-08-26).
- Hand over the literal input and the complete list of assertions, never
  the intent alone: an intent restated in a comment is indistinguishable
  from an intent implemented. When reviewing a test, read its inputs against
  its name; never let its comment stand in for either (2026-08-26).

## 2026-09-01 — A ban proven against the forms that were written is unproven against the forms that are reachable (TYRE-95)

**What happened:** B4.5's rule 6 lint gate banned the `toLocale*` methods and
proved each selector with a planted violation. Every plant was a form already
in the tree, and three routes to the same browser-zone formatting sailed
past: `Intl.DateTimeFormat(...)` called without `new` (ECMA-402 permits it),
`const { DateTimeFormat } = Intl`, and aliasing `Intl` itself. TYRE-95 closed
them with two further selectors, each proven by its own plant.

**The rule:** when banning behaviour with an AST selector, enumerate the
syntactic routes the platform offers to that behaviour — call-without-`new`,
destructuring, aliasing, bracket access — and plant one violation per route,
not per selector written. Extends the 2026-08-20 "prove the test can fail"
entry: these plants did fail, but only against the shapes someone had
happened to type, which proves the selector, not the ban.

## 2026-09-01 — A migration that renames a schema object orphans every Go string naming it (TYRE-95)

**What happened:** migration 000027 folded email uniqueness to
`(tenant_id, lower(email))`, replacing the unique index the reactivate race
translates through. `conflictCodes` kept the old index name as its key, so
the new index's `23505` would no longer map to the intended refusal, and a
full green `make check` said nothing — no test drove the race into the
renamed index. Review caught it; the fix re-keyed the map and added
`TestConflictCodesNameLiveSchemaObjects`, which resolves every key against
the live schema.

**The rule:** when a migration renames, replaces or drops a named schema
object, `rg` the Go tree for the old name as a string literal before calling
the migration done — error translation couples to names the compiler never
checks. Any new map keyed on schema object names needs a test that resolves
its keys against the live schema, as `conflictCodes` now has.

## 2026-09-01 — A post-merge review that skips the PR body re-reports the author's recorded decisions (TYRE-95)

**What happened:** the TYRE-95 review read B4.5's diff and its plan and
raised its findings; four of them were decisions PR #37's body had already
recorded as accepted, the transient UTC flash on `/my` among them. Each cost
an adjudication round to separate from the real defects.

**The rule:** hand a post-merge reviewer the PR body alongside the diff, and
read it before writing findings. A decision the author recorded there is
context — challenge it explicitly as a disagreement if it is wrong, never
re-report it as a discovery.

## 2026-08-31 — A grep cannot answer "have I updated every construction of this type"

**What happened:** TYRE-89 made `timezone` a required field on `Me`. The plan
named three fixtures to patch; an implementer searched the tree and reported
"exactly three, no fourth"; a reviewer then searched independently and
confirmed it. All three were wrong. A fourth lived at `routes.test.tsx:12` as
`const actor = (capabilities: string[]): Me => ({ … })` — an arrow factory,
which shares no searchable shape with an annotated object literal, and which
a fixture could dodge entirely by carrying no annotation at all. `tsc` found
it in seconds and the branch had been left not typechecking.

**The rule:** when a change makes a field required on a shared type, find the
call sites with the typechecker, never with a search — `make lint` runs
`tsc`, so run it before believing the sweep is done. Never accept "I grepped
and found them all" as evidence that every construction was updated, from a
subagent or from a reviewer.

## 2026-08-31 — `make web-test` passing says nothing about eslint

**What happened:** two idioms that read as ordinary vitest cost a fix round
each in B4.5, both invisible to the test run. `String(init?.body)` fails
`@typescript-eslint/no-base-to-string`, because `RequestInit.body` is
`BodyInit` and `String()` on a `Blob` or `FormData` yields `"[object Object]"`
— which would also have made the assertion pass while testing nothing.
`new Promise(() => {})`, the usual "request that never settles", fails
`@typescript-eslint/no-empty-function`.

**The rule:** run `make lint` after changing any web test file, not just
`make web-test` — the type-aware rules live only there and test files are not
exempt. To assert on a stubbed `fetch` body, narrow it with a `typeof` guard
that throws, never a cast: the cast silences the linter and keeps the vacuous
assertion. To hold a request in flight, use a deferred whose executor assigns
the resolver, and release it before the test ends.

## 2026-08-31 — A promotion through the merge button deletes the branch it promotes

**What happened:** `develop` was promoted to `main` through pull request #34.
GitHub cannot fast-forward, so it rebase-merged — rewriting all 44 hashes —
and `deleteBranchOnMerge: true` then deleted `origin/develop`, leaving the
repository with no integration branch. Nothing was lost: the trees were
identical. But every hash cited in `docs/implementation-order.md` stopped
resolving, and a local `develop` left unreset silently became a fork.

**The rule:** promote with `git push origin origin/develop:main` from a
terminal, never a pull request (ADR-0004, CONTRIBUTING.md). To check whether
two branches agree after any promotion, compare
`git rev-parse <ref>^{tree}` — **trees, never hashes**, because a rebase leaves
the tree equal and every hash different. Cut feature branches as
`git checkout -b <name> origin/develop`, naming the remote, so a stale local
`develop` cannot seed one. A ruleset now blocks deletion of `develop`, and
`.github/workflows/close-main-prs.yml`, on `main` since the first production
release, closes any pull request into `main` (TYRE-313).

## 2026-08-28 — A WITH CHECK kill can be masked by an unrelated FK (TYRE-81)

**What happened:** Task 3's proof that `app.vehicle`'s `tenant_isolation`
policy refuses a cross-tenant insert used a row built with every column but
`tenant_id` left to plausible defaults, including `created_by` left to its
`app.current_actor_id()` default (000017, DR-013). With RLS disabled to prove
the test could fail, the insert still errored — but as `23503` on
`vehicle_created_by_fkey`'s composite FK `(tenant_id, created_by)`, not
`42501` from the policy: `created_by` defaulted to the acting tenant's own
user, which cannot exist paired with the smuggled tenant_id. The kill
"worked" but proved the wrong thing — the row was never actually valid in
every way but the one under test, so RLS was never reached.

**The rule:** every audit-columned table (000017 stamped `created_by` plus its
tenant-scoped composite FK onto roughly thirty tables) needs a WITH CHECK proof
that stamps `created_by` explicitly with a real user from the *target* tenant,
not left to its default. A row that would fail on an unrelated FK regardless
of the policy under test proves nothing when the kill succeeds for the wrong
reason. Before trusting a RED, confirm which constraint produced it.

## 2026-08-28 — `package httpapi`'s own `require` function shadows testify's import (TYRE-77)

**What happened:** the B3 plan's Task 2 test code imports
`"github.com/stretchr/testify/require"` unaliased into a new white-box test
file declaring `package httpapi`. `refusal.go:322` already defines a
package-level function `require(a auth.Actor, c auth.Capability) error` (the
capability-check helper `api/CLAUDE.md` documents). Go merges identifiers
across every file sharing one package name, so the build fails:
`require already declared through import of package require`. The plan was
written and tested against a description of the file, not the file itself.

**The rule:** any new `package httpapi` (not `httpapi_test`) file that needs
testify's `require` must alias the import — `req "github.com/stretchr/testify/require"`
— exactly as `ratelimit_test.go` already does, with the same explanatory
comment. This is a permanent property of the package, not a one-off typo:
every future white-box test file in `internal/httpapi` hits it. Check for an
existing same-name package-level identifier before trusting a plan's
unaliased import block for an internal test file.

## 2026-08-27 — A requirement declared unbuildable was never re-read (TYRE-4, CS-4)

**What happened:** the capture slice shipped the odometer field empty and
raised "FR-INS-020 cannot be built as written" to the sponsor, on the strength
of a quotation — *"optional, pre-filled… It shall never block a tyre
inspection"* — carried between documents rather than fetched. The live
requirement pre-fills a **projection** for the driver to **confirm or
correct** and records confirmed values only, which already contains the guard
the objection asked the errata to invent. The escalation, the assumption
recorded in the questions file, the PR's Decisions paragraph and a week of the
sponsor's attention were all spent on a requirement that says something else.

**The rule:** before declaring a requirement contradictory, unbuildable or in
conflict with another, fetch its current text from Confluence and quote it in
full. An ellipsis in a quotation is where the answer usually was. This costs
one MCP call; not doing it costs a sponsor round trip and a build of the wrong
thing.

## 2026-08-27 — A window with one bound answers a different question (TYRE-66)

**What happened:** FR-INS-038's duplicate guard bounded its interval below
only. Every test asked whether a later capture was refused, so the whole suite
agreed with a predicate that would silently discard any capture arriving out
of order — which, behind a durable outbox, is the ordinary case rather than
the exotic one.

**The rule:** when a rule is about the distance between two events, test it in
both directions. A test suite that only ever plants the older event first
cannot see a missing bound, and "within N hours of each other" is symmetric
whatever order the payloads happen to arrive in.

## 2026-08-26 — A mutation check is only as wide as the run you check it with (TYRE-4)

**What happened:** an implementer proved a fixture change had strengthened the
suite by mutating a key function and reporting "4 failed across 3 files". Run
against the whole suite the same mutation failed **5 tests across 4 files** — the
subset had simply not contained the fourth. The error was harmless in that
direction, but the same habit run the other way concludes "nothing catches this"
from a subset that merely did not include the test that does, and buys a
redundant test or a wrong claim about coverage.

**And a mutation outlives the agent holding it.** A later session had one killed
by a rate limit mid-check; it left `DRAFT_KEY = "current-v2"` live in the working
tree, in the file carrying this branch's most load-bearing fix. Its own report
said only that it had begun reading — nothing in what it returned revealed the
edit.

**The rule:** run a mutation against the **whole suite**, never a file subset and
never `-t`. The count is the evidence, and a count from a filtered run is
evidence about the filter. Revert it immediately — never hold one across a
long-running command — and prove the tree is clean with `git status
--porcelain`. Whoever dispatched the agent checks the tree too, and checks it
hardest when the agent died: a killed process reverts nothing, and the diff it
leaves reads exactly like intended work.

## 2026-08-26 — Position ids repeat across units of the same axle configuration (TYRE-4)

**What happened:** the capture client keyed the draft, its React mirror, the
diagram lookup, the done set and the review index on `position_id` alone.
`app.position` belongs to an axle *configuration*, not to a vehicle, so the two
links of an ordinary superlink share every position id byte for byte. One
trailer's readings overwrote the other's, tapping one link's cell opened the
other's sheet under the wrong fleet number, and the submit carried 20 readings
where the driver had entered 29 — with the header still reading "29 of 29 done".
The unit suite could not have caught it: every multi-unit fixture in it gave
each unit distinct position ids, which is the one shape the real fixture never
produces.

**The rule:** never key client state on a position id alone. The identity of a
reading is the pair `(position_id, vehicle_id)`, which is what `app.reading`'s
`UNIQUE (inspection_id, position_id, vehicle_id)` has said since 000001. Build
every multi-unit fixture from two units of the *same* configuration so they
share ids — that is the ordinary superlink, and a fixture with per-unit distinct
ids is blind to this whole class of bug.

## 2026-08-26 — `dexie-react-hooks` will not typecheck here, and the reason is not in its own types (TYRE-4)

**What happened:** a plan called for `npm install dexie-react-hooks` to get
`useLiveQuery`. The package ships `useDocument.d.ts`, which imports `y-dexie`
and `yjs` — optional peers nothing here uses. `web/tsconfig.json` deliberately
has no `skipLibCheck` (only `tsconfig.e2e.json` sets it, with a comment
explaining why that one is the exception), so `tsc` fails `TS2307` on
declaration files belonging to a package the code never calls. The obvious
escapes are both wrong: `skipLibCheck: true` relaxes type checking for the whole
app to accommodate one hook, and installing `yjs`/`y-dexie` adds two unused
runtime dependencies.

**The rule:** for a live Dexie query in this repo, subscribe to Dexie's own
`liveQuery` through `useSyncExternalStore` rather than adding
`dexie-react-hooks` — it is the same subscription `useLiveQuery` wraps, in about
twenty lines and no new dependency. More generally: before adding a dependency
for one hook, check what its `.d.ts` files import, because `skipLibCheck` is off
here and a transitive optional peer will fail the build.

## 2026-08-26 - Fake timers deadlock IndexedDB, skip testing-library's drain and fire outside act() (TYRE-4)

**What happened:**

- A heartbeat test's unrestricted `vi.useFakeTimers()` deadlocked every
  IndexedDB operation, because Dexie and `fake-indexeddb` complete their
  requests on a real `setTimeout`. Vitest's 5s timeout fired before the
  test's own `vi.useRealTimers()` line, the leaked fake timers hung the
  next `beforeEach` on `db.open()`, and six tests failed for one defect.
- The first `userEvent` call after `vi.useFakeTimers()` hung forever.
  `@testing-library/react`'s `asyncWrapper` drains microtasks after every
  `userEvent`/`waitFor` call through a real `setTimeout(resolve, 0)` and
  advances a fake clock to fire it only
  if it detects fake timers, and both `@testing-library/react/dist/pure.js`
  and `@testing-library/dom/dist/helpers.js` detect them by
  `typeof jest !== "undefined"`. Vitest has no `jest` global, and no
  `toFake` list can reach the pending call, which is real whatever is
  faked.
- A test drove a 200ms auto-advance with `vi.advanceTimersByTimeAsync` and
  then read the DOM. The timer's `setState` ran outside testing-library's
  `act()` and never flushed, so every `aria-current` read was stale and a
  helper branching on it took the wrong branch: a green test over an entry
  path no driver takes.

**The rule:**

- When faking timers around code that touches IndexedDB, restrict `toFake`
  to exactly what you need (`["setInterval", "clearInterval", "Date"]`),
  and do the IndexedDB setup under real timers before switching.
- Wait for the condition rather than for a fixed number of ticks before
  asserting on fire-and-forget async work: `vi.waitFor(...)`, not one
  `await new Promise((r) => setTimeout(r, 0))`. A single real tick is
  enough on an idle machine and not under a loaded full-suite run, where
  the same sequence needs several: a fixed sleep there is a flaky test that
  teaches people to re-run the suite, which is how a real regression gets
  waved through. (This rule once prescribed the single tick, and that
  advice produced exactly such a flake in the outbox heartbeat test.)
- Always put `vi.useRealTimers()` in a shared `afterEach`, not only at the
  end of the test that enabled them: a test that times out never reaches
  its own cleanup, and leaked timer state misattributes the failure to
  whatever runs next.
- A Vitest project combining `vi.useFakeTimers()` with
  `@testing-library/react` needs a `jest` shim in shared test setup,
  satisfying the detection gate without claiming to be jest.
  `web/src/test/setup.ts` already carries one: do not remove it, and do not
  diagnose a fake-timer hang by reaching for `toFake` first.
- Wrap every `vi.advanceTimersByTime`/`advanceTimersByTimeAsync` that can
  fire a React state update in `await act(async () => { ... })`. A bare
  advance is only safe when nothing it fires touches component state.

## 2026-08-26 — A finished subagent cannot be resumed unless you wrote its id down (TYRE-4)

**What happened:** a task review came back with changes requested, and the
process prescribes resuming the same implementer for the early fix rounds so
it keeps its context. The agent id was not in the ledger, and a completed
in-process subagent does not appear in `ListAgents` — that lists peer sessions,
not finished children. Several turns went into hunting temp transcript files by
modification time and guessing from an empty output file, then the round was
dispatched to a fresh agent anyway, which had to re-derive context the original
already had.

**The rule:** record a dispatched subagent's agent id in the ledger on the same
line as the commit it produced, at dispatch time, not when you next need it.
The id is unrecoverable once the agent finishes and your own context has moved
on, and every recovery route from there is a guess.

## 2026-08-26 — An expected value can be correct and still prove nothing (TYRE-4)

**What happened:** a boundary expectation was derived by hand, verified to be
the value the code really produces, and handed to an implementer — and the
assertion built from it still could not fail. Asserting `pressureKpa === null`
for a guarded pressure field held whether or not the guard existed, because
removing the guard wrote its bad value into a *different* field.

**The rule:** correctness and discriminating power are two different
properties, and checking the first does not give you the second. For every
assertion, name the mutation it is supposed to catch and confirm that mutation
would flip it. Extends the 2026-08-20 entry below beyond security tests: prove
the test can fail, not just that it currently passes.

## 2026-08-21 - A control nothing enforces is decoration (2026-08-20; TYRE-21)

**What happened:**

- 2026-08-20 (TYRE-21): `web/.npmrc` set `min-release-age=14`, but the npm
  bundled with Node 22 predates the key and ignores unknown config without
  a warning, and `npm config get` echoes the value back even on an npm that
  ignores it. The supply-chain gate read as configured while enforcing
  nothing.
- 2026-08-21: an earlier comment-style document changed nothing: generated
  comments kept violating it because it was never in context when comments
  were written, and nothing checked the output.

**The rule:**

- Never verify a control by checking its configuration is present; verify
  the enforcing tool's version supports it, or better, test the artefact
  the control is supposed to protect. Presence proves the file was read,
  not that anything is enforced (2026-08-20). The release-age case is now
  refused by `make lint`'s `npm-release-age-check` and by ci.yml's
  "Release-age gate is active" step, which both require npm 11.10.0 or
  later, and `scripts/check-release-age.mjs` checks the lockfile in CI.
- A convention only holds if it is either in the writer's context at write
  time (CLAUDE.md) or enforced on the artefact afterwards (hook, lint, CI),
  ideally both. A standalone standards document with neither is decoration.
  See `docs/comments.md` for the pattern applied (2026-08-21).

## 2026-08-20 — A test that cannot fail is worse than no test

**What happened:** the RLS isolation suite passes vacuously when run as a
superuser — every assertion becomes a no-op that still prints PASS. Nothing
looked wrong until the suite was made to assert its own runtime identity
(check 0).

**The rule:** for any test guarding a security property, first prove the
test *can* fail — run it in the broken configuration, or make it assert the
preconditions that give it teeth.
