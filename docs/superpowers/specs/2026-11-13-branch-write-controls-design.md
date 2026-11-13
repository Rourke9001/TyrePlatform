# Branch writes held by GitHub and git: a develop ruleset, a scoped gh token and a pre-push hook

Date: 2026-11-13. Ticket: TYRE-473 (epic TYRE-10). Status: approved by
the owner on 13 Nov 2026 (U209). From the 9 Nov 2026 design audit, section 3 (verdict
Replace); owner ruling U201 accepted the ruleset and the owner's GitHub
steps. The ticket cites no SRS requirement: this is repo tooling, no
product code.

It reverses TYRE-413's mechanism choice (c13982) and U167 item 1's
framing of evasion forms as the accepted limit of a text guard. U123 (the
owner merges every PR), U126 (a feature-branch push runs without a
prompt) and TYRE-250 (a written rule is enforced, not recalled) stand.

The owner answered the product questions on 13 Nov 2026 (U208): the
token is created now and probed; the owner's setup steps run after the
PR opens and before the merge; the cloud routine gets a restricted
token of its own. With the approval (U209) the owner moved three of
those steps to before the build: the ruleset, git's credential and the
local token.

This spec departs from the ticket's design in six places:

1. The token lives in this project's local Claude settings, not in the
   owner's shell (Approaches).
2. Git in this repository signs in through Git Credential Manager, which
   the ticket did not cover (Approaches, section 3).
3. A second token goes on the cloud routine's environment (section 2).
4. A small hook refuses `gh` in a session without the token, and
   `make guard-check` proves the controls; the ticket adds neither
   (sections 6 and 7).
5. The owner's steps get a runbook (section 12).
6. Three of the owner's steps come before implementation, not after the
   PR opens (Constraints).

## Intent

The owner merges every PR, and a write that lands on `develop` or `main`
deploys an environment. `.claude/hooks/merge-push-guard.sh` holds both
rules by reading a Bash command's text: 309 lines of regexes, an awk
tokenizer, cd tracking and heredoc handling. #162's three review rounds
found 9, 8 and 4 bugs in it, each a bash-grammar form, and U176 found a
form no text reader can judge: in
`git push -u origin "$(git branch --show-current)"` the target exists
only at run time. Claude Code's own documentation says a Bash rule
"isn't a security boundary around the program"
(code.claude.com/docs/en/permissions).

Three things already know the answer the guard guesses at. Git resolves
a push's target before it runs `pre-push`. GitHub decides what a
credential may write. A ruleset decides what a branch accepts. This
design gives each rule to the one that knows, and deletes the guard.

## What the spec-stage reading showed

The research and probes are in
`.superpowers/sdd/2026-11-13-pipeline-TYRE-473/` (gitignored):
`research-rulings.md`, `research-docs.md` and `probes/`.

- **Git on this machine signs in to GitHub through `gh`.**
  `~/.gitconfig` sets `credential.https://github.com.helper` to
  `gh auth git-credential`, and
  `GH_TOKEN=probe gh auth git-credential get` answers `password=probe`.
  So a `GH_TOKEN` with Contents read, the ticket's design item 2, would
  reach git too and refuse every feature-branch push.
- **`gh` keeps a full-rights stored login**, with the `repo` and
  `workflow` scopes (`gh auth status`), and no shell profile sets
  `GH_TOKEN`. `GH_TOKEN` "takes precedence over previously stored
  credentials" (cli.github.com/manual/gh_help_environment), so a session
  started where the variable is absent runs `gh` on the full login and
  nothing says so. A token set in the owner's shell fails open, the same
  class as the guard's `jq ... || exit 0` (`merge-push-guard.sh:12`).
- **The gh manual says where a fine-grained token goes:** "Favour
  setting `GH_TOKEN` for fine-grained personal access token usage", and
  it warns against `gh auth login --with-token` for one
  (cli.github.com/manual/gh_auth_login).
- **Claude Code settings carry a per-project environment.** The `env`
  key sets variables "for every session and its subprocesses", "they
  take effect no matter how `claude` was launched", and where the shell
  also sets one "the settings file value applies in most sessions"
  (code.claude.com/docs/en/settings, /env-vars).
  `.claude/settings.local.json` is "not read" in a cloud session.
- **`.claude/settings.local.json` is ignored only by this clone's
  `.git/info/exclude`**, not by the tracked `.gitignore`
  (`git check-ignore -v`). The repo is public.
- **A linked worktree may not read the main checkout's local settings
  on Windows.** The settings page says "In a worktree, it uses the file
  at the main checkout's root", and the worktrees page says "On Windows
  and in the other cases where Claude Code doesn't use the repository
  root, the rule stays with that worktree". One worktree exists,
  `D:/Code/Projects/TyrePlatform-capture` (`git worktree list`). A
  session there could run `gh` on the stored login with nothing saying
  so, so the design does not rest on which reading is right (section 7).
- **A hook entry can be limited by Claude Code's own command reader.**
  The `if` field takes "Permission rule syntax to filter when this hook
  runs, such as `"Bash(git *)"`", checks each subcommand of a compound
  command, and "When Claude Code can't determine which commands the Bash
  input runs, it runs your hook regardless of the pattern"
  (code.claude.com/docs/en/hooks). Exit 2 "blocks the tool call".
- **A ten-line `pre-push` hook refused every push form the guard's test
  lists.** `probes/pre-push-probe.sh` ran real `git push` commands
  against a bare remote through a candidate hook installed by
  `core.hooksPath` (git 2.41.0.windows.1). The U176 form, a refspec in a
  variable, `--all`, `--mirror`, a glob refspec, `git push origin :`,
  `sh -c`, `eval`, `-C`, a push by URL, a branch whose upstream is
  `develop`, and a linked worktree were all refused. `develop-notes`,
  `TYRE-9-main` and a tag named `main` passed.
- **A push that would update nothing gives the hook no line**, so it
  exits 0 and nothing lands. A test case must keep the local branch
  ahead of the remote, or it proves nothing.
- **`--no-verify` and `-c core.hooksPath=` skip the hook**, and an
  unset `core.hooksPath` means no hook at all (same probe). "With
  `--no-verify`, the hook is bypassed completely"
  (git-scm.com/docs/git-push).
- **`git push --dry-run` proves the push credential and writes
  nothing.** It passed on the real credential, failed with
  "Authentication failed" on a bad token, and left no ref on origin.
- **A full-rights token gets 422 for a ref update on a ref that does
  not exist** (`PATCH .../git/refs/heads/tyre-473-no-such-ref`,
  "Reference does not exist"). A token without Contents write should get
  403 for the same call, and the call can never change anything.
- **The ruleset API says whether the caller can bypass.** Rulesets
  21929055 and 21133437 both read `"current_user_can_bypass": "never"`
  with an empty `bypass_actors`. GitHub's pages do not say in words that
  an empty bypass list binds the admin, so the check reads this field.
  A read with no credential answers 200 and leaves the field out. Under
  the restricted token it reads `never` (the lead's read on 13 Nov 2026,
  once the owner had installed the token).
- **`develop` has only the deletion rule today**
  (`gh api repos/Rourke9001/TyrePlatform/rules/branches/develop`), and
  the `production` environment has a `required_reviewers` rule naming
  Rourke9001 (`.../environments`, read 13 Nov 2026).
- **In the cloud, a `GH_TOKEN` on the environment is what `gh` uses.**
  "If you set a token, it passes through to the container unchanged, so
  your scripts and GitHub's `gh` CLI use it directly"; with none, "the
  proxy substitutes your real credentials on outbound GitHub requests".
  The proxy "doesn't limit which branches a push can update. To do that,
  use branch protection rules or rulesets on GitHub"
  (code.claude.com/docs/en/cloud-environments). So once the guard is
  deleted, a REST merge from the routine would pass unless its
  environment carries a restricted token.
- **`~/.git-credentials` holds two `github.com` lines in plaintext**
  (counted, never read). Git does not consult the file for GitHub today,
  because the `gh` helper entry resets the list first. If either token
  is still valid it is a credential outside every control here.
- **Today a push to `develop` or `main` asks; the hook refuses.** A git
  hook cannot ask. U201 does not name that change; the owner was told it
  with the product questions on 13 Nov 2026.
- **The runbook never mentions the production approval click**, and
  ADR-0017 says the environment has no required reviewer
  (`docs/adr/0017-staging-and-production-environments.md:146-147,
  155-156`). The design rests on that approval.

### What the token allows (the owner's probe)

GitHub lists "Using fine-grained personal access token to call the
Checks API" as unsupported, and the pipeline's hand-over runs
`gh pr checks`, `gh pr view` and `gh pr create`. So the owner created
`tyre-claude-local` on 13 Nov 2026 with the permissions in section 2 and
ran `probes/token-probe.sh` with it, installed nowhere. The result is
`probes/token-probe.out`: 20 passed, 0 failed.

- **Every `gh` form the pipeline and close-out use works under the
  token.** `gh pr view` with and without `statusCheckRollup`,
  `gh pr checks`, `gh pr list`, `gh pr diff`, `gh run list`,
  `gh run view`, a job log download, and the REST reads of pulls, pull
  files, runs, attempt jobs, rules, rulesets and environments. No
  command in `.claude/commands/` needs a REST rewrite.
- **The writes it needs work.** A REST `PATCH` of a PR and `gh pr edit`
  (a GraphQL mutation), each re-saving PR #214's own title, succeeded.
  Cancelling a completed run answered 409, which is Actions write with
  nothing to cancel. `gh pr create --dry-run` got as far as "Would have
  created a Pull Request".
- **The writes it must refuse are refused.** The ref update on a ref
  that does not exist answered 403, where the full login got 422. A
  REST merge of the already-merged PR #214 answered 403. The GraphQL
  `mergePullRequest` mutation on it answered `FORBIDDEN`.
- **The token carries no classic scopes** (no `X-OAuth-Scopes` value).

Not run, because each would leave a mark: a real `gh pr create`, a
comment, a label, and a re-run of a workflow. The permission table puts
each under a permission the token holds.

## Goals

1. A `git push` from this checkout that runs its hooks does not land on
   `develop` or `main` unless `TYRE_PROMOTE=1` is set for that command.
   Git decides the target, not a reader of the command's text. The
   forms that skip the hook are named under Not covered.
2. `develop` takes a change only through a pull request, whoever pushes
   and from wherever, the cloud routine included.
3. `gh` running on the restricted token cannot merge a pull request or
   write a branch, however the command is written: GitHub refuses the
   credential. A session that does not carry the token, local or cloud,
   a linked worktree included, has its `gh` calls refused with the fix
   named. A command that drops the token on purpose is named under Not
   covered.
4. A session where any of the controls is missing is told so before it
   works unattended: `make pipeline` refuses to start, and the cloud
   close-out stops with a report.
5. The guard, its cases (about 140, `scripts/hooks.test.sh:64-250`) and
   its registration are gone, and no doc line describes them as live.
6. The owner's setup is written down once, in a runbook, with a
   read-only check for each step, so it can be repeated on a new machine
   and when a token expires.

## Non-goals

- A rule on `main` beyond ruleset 21133437. Promotion is a fast-forward
  push, the production deploy refuses a commit that is not on `develop`
  or that staging did not pass (`scripts/deploy-guard.sh`), and the
  `production` environment needs the owner's approval.
- New `deny` or `ask` permission rules for `--no-verify`, `TYRE_PROMOTE`
  or `gh api`. They are the text rules this ticket moves away from.
  `Bash(gh pr merge:*)` and `Bash(git push --force:*)` stay as they are.
- Changing what the owner's own terminal can do. Outside a Claude
  session `gh` keeps its stored login.
- A new ADR. ADR-0018 already names the `develop` ruleset as the owner's
  open call, and U201 made it; the decision is recorded by amending
  ADR-0004, ADR-0017 and ADR-0018 (Docs).

## Anti-goals

- No code in the repo reads a shell command's text to find a push or a
  merge.
- The token is never written to a tracked file, a commit, a PR body, a
  ticket or a log.
- No make target that CI or the cloud runs changes a credential setting.

## Constraints

- The run that builds this cannot change the owner's machine or GitHub
  settings. Until the owner's steps are done, the guard on `develop`
  still protects every other session, so the owner does the steps before
  merging the PR (owner, 13 Nov 2026).
- The design's own controls gate the run that builds it. "Claude Code
  watches your settings files and reloads them when they change, so it
  applies most edits to the running session without a restart, including
  edits to `permissions`, `hooks`" (code.claude.com/docs/en/settings).
  Once section 7's hook is registered on this branch, the lead's own
  `gh` calls at hand-over are refused unless the session carries the
  token. So the ruleset, git's credential and the local token (the
  runbook's steps 1 to 3) come before implementation, not after the PR
  opens. The owner chose that with the approval (U209, 13 Nov 2026),
  changing the timing first chosen for those three steps (U208).
- The guard's registration and its file leave in one commit, the
  registration first. A registered hook whose file is gone would fail on
  every Bash call of every session in this checkout.
- Git must leave the `gh` helper and prove a push before the token goes
  into the settings file. Settings reload in a running session, so the
  other order breaks pushes at once.
- Windows first: Git for Windows runs the hook with its own `sh`, the
  owner's terminal is PowerShell, and Git Bash drops a `C:/` entry from
  `PATH` when a test stubs a binary (`docs/lessons.md`, the Git Bash
  PATH entry). CI and the cloud run the same files on Linux, so the hook
  is mode 100755 in git with LF endings (`.gitattributes:3`).
- The auto-mode classifier has refused an agent's edit to
  `.claude/settings.json` before (TYRE-413's definition of done). If it
  refuses the removal of the guard's registration, that is a teammate's
  stop-and-ask: the owner makes the edit.

## Approaches

**Where the restricted token lives.** Departs from the ticket.

| Option | Verdict |
| --- | --- |
| `GH_TOKEN` in the owner's shell profile (the ticket) | Rejected. It fails open in any shell that lacks it, and it reaches git through the `gh` helper. |
| A Windows user environment variable | Rejected. Every `gh` on the machine, the owner's other repositories included, would run on a token that can write only this one. |
| The token as `gh`'s stored login (`gh auth login --with-token`) | Rejected. The manual warns against it for a fine-grained token, and it has the same reach as the row above. |
| `env.GH_TOKEN` in `.claude/settings.local.json` | **Chosen.** Every Claude Code session in this project gets it however it was launched, nothing else on the machine does, and the manual's advice is `GH_TOKEN`. |

**How git signs in once `GH_TOKEN` is in the session.** Departs from the
ticket, which did not cover it.

| Option | Verdict |
| --- | --- |
| Give the token Contents write | Rejected. Contents write is what a merge and a ref write need. |
| Wrap the helper as `env -u GH_TOKEN gh auth git-credential` | Rejected. It works, but nobody else does it, and it ties git to `gh`'s stored login for good. |
| Git Credential Manager for `github.com`, set in this repo's local config | **Chosen.** It ships with Git for Windows (2.1.2 is installed), signs in by browser, keeps the credential in Windows Credential Manager, and a local setting leaves the owner's other repositories alone. |

**Installing the hook.**

| Option | Verdict |
| --- | --- |
| The owner runs one `git config` line once (the ticket) | Rejected alone. A new clone or a new machine has no hook and nothing says so; the owner moved machines on 13 Nov 2026. |
| A make target that the routine commands depend on | **Chosen.** `make hooks-install` sets `core.hooksPath`, and `make check` and `make pipeline` depend on it. husky does the same: its install runs `git config core.hooksPath` (github.com/typicode/husky, `index.js`), and its docs say to "include it in the `prepare` script in `package.json` for automatic execution after each install (recommended)" (typicode.github.io/husky/how-to.html). `make guard-check` then proves it. |

## The design

### 1. The develop ruleset (the owner, in the web UI)

Ruleset 21929055, "Protect develop from deletion", gains the rule
"Require a pull request before merging" with 0 required approvals. Its
bypass list stays empty and its target stays `refs/heads/develop`. "The
pull request doesn't necessarily have to be approved, but it must be
opened" (GitHub docs, available rules for rulesets). The owner still
merges with the rebase or squash button.

One ruleset, not a second: one place to read what `develop` accepts.

It is enforced on the server, so it binds a push from the cloud routine
too. `main` gets no new rule (Non-goals).

### 2. The restricted token for gh (the owner creates two)

Two fine-grained tokens with the same permissions, so revoking one never
breaks the other: `tyre-claude-local` and `tyre-claude-cloud`.

- Repository access: only `Rourke9001/TyrePlatform`.
- Contents: read. Pull requests, Issues and Actions: read and write.
  Metadata: read, which GitHub adds.
- Expiry: one year.

Contents write is what GitHub's permission table requires for
`PUT /pulls/{n}/merge`, `POST /merges`, a git ref create or update and
`PUT /contents/{path}`, so neither token can do any of them.

`tyre-claude-local` goes in `.claude/settings.local.json` as
`"env": {"GH_TOKEN": "..."}`. The tracked `.gitignore` gains
`.claude/settings.local.json`, because the docs say a hand-made file is
the user's to ignore and this clone's exclude file does not travel.

`tyre-claude-cloud` goes in the close-out routine's cloud environment as
the environment variable `GH_TOKEN` (the owner, 13 Nov 2026).

An expired token answers 401, which the check below reads as a failure,
so expiry stops the pipeline and the close-out; it never fails open.

### 3. Git's own credential in this repository (the owner, once)

Two local settings move git off the `gh` helper for this repository
only:

```
git config --local credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper manager
```

The empty value "resets the helper list to empty"
(git-scm.com/docs/gitcredentials), which also keeps the global `store`
helper from saving GitHub's credential in plaintext. The owner then
signs in once, in their own terminal, with a push that writes nothing:
`git push --dry-run origin HEAD:refs/heads/tyre-473-sign-in`. Git
Credential Manager opens the browser.

No make target sets these. CI and the cloud have their own credentials
(Anti-goals).

### 4. The pre-push hook

`.githooks/pre-push`, POSIX `sh`, mode 100755, about ten lines:

- If `TYRE_PROMOTE` is exactly `1`, exit 0.
- Read each stdin line, "<local-ref> SP <local-object-name> SP
  <remote-ref> SP <remote-object-name> LF"
  (git-scm.com/docs/githooks). If a line's remote ref is
  `refs/heads/develop` or `refs/heads/main`, print one refusal to stderr
  and exit 1. "If this hook exits with a non-zero status, `git` `push`
  will abort without pushing anything."
- Otherwise exit 0.

The refusal says what was refused and what to do: open a pull request
for `develop`; for `main`, the owner promotes from their own terminal
(the runbook's Promote to production).

It judges every remote, not only `origin`, so a push by URL is refused
too. It names the two branches in the hook itself: they are the two
deploy branches of ADR-0004, not tenant configuration.

`TYRE_PROMOTE=1` opens both branches. On `develop` the ruleset still
refuses the push on the server. On `main` it is the promotion.

### 5. `make hooks-install`

Runs `git config core.hooksPath .githooks`. A relative path "is taken
as relative to the directory where the hooks are run", the root of the
working tree, and the repository config is shared by linked worktrees
(git-scm.com/docs/git-config, git-worktree). `check` and `pipeline`
depend on it. It is safe in CI and the cloud: it changes nothing but
that one setting.

### 6. `make guard-check`

`scripts/guard-check.sh` reads; it changes nothing. It prints one line
per row, `OK` or `FAIL` with the runbook step that fixes it, and exits 1
if any row failed. Rows:

1. `core.hooksPath` is `.githooks`, and `.githooks/pre-push` exists and
   is mode 100755 in git.
2. `TYRE_PROMOTE` is not set in this environment.
3. `GET /repos/Rourke9001/TyrePlatform/rules/branches/develop` lists a
   `pull_request` rule, and at least one ruleset carrying that rule
   reads `"current_user_can_bypass": "never"`. GitHub applies every
   ruleset that matches, so one the caller cannot bypass is enough. A
   ruleset read that leaves the field out does not count.
4. `GH_TOKEN` is set and starts with `github_pat_`.
5. `PATCH /repos/Rourke9001/TyrePlatform/git/refs/heads/tyre-473-no-such-ref`
   answers 403 from GitHub, with GitHub's message "Resource not
   accessible by personal access token" (the lead's read, 13 Nov 2026).
   A token with Contents write gets 422, an expired one 401, and the
   cloud proxy has 403s of its own with other messages; anything but
   that status and message fails the row.
6. Git's last `credential.https://github.com.helper` value is not the
   `gh` helper, and `git push --dry-run origin
   HEAD:refs/heads/tyre-473-guard-check` exits 0 with
   `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` and
   `SSH_ASKPASS=`, so a missing sign-in fails the row and never opens a
   browser or a prompt. The two askpass variables are emptied because
   VS Code's terminal sets them, and git falls back to that program
   even with terminal prompts off (the red team's probe, round 1; the
   owner's first sign-in attempt on 13 Nov 2026 was answered by
   something other than the browser).

`make guard-check CLOUD=1` runs rows 1 to 5 only: a cloud session's git
goes through the proxy.

`.claude/commands/pipeline.md`, Before anything, gains the check inside
step 1, after the agent-teams check, as a second paragraph: run
`make guard-check`; non-zero stops the run and shows the output. It is
not a new numbered step, because the playbook and
`docs/superpowers/specs/2026-11-11-bounded-lead-waits-design.md:323`
cite steps 2 to 7 by number. `.claude/commands/close-out.md`'s
cloud-mode paragraph
gains: run `make hooks-install`, then `make guard-check CLOUD=1`; on a
failure post the output as the report and stop. When the failing row is
the token, section 7's hook refuses the `gh api` call that posts the
report, so the stop goes to the owner as the push notification
close-out already sends when a run stops early (`close-out.md:190-193`),
with the check's output in it. Close-out's guards read the PR with
`gh api` before the cloud-mode paragraph runs (`close-out.md:20-35`), so
a cloud session without the token is refused there first; `close-out.md`
says that refusal stops the run the same way, with the notification.

It is not part of `make lint` or `make test`: CI has no token and must
not need one.

### 7. A `gh` call needs the restricted token

The token sits in an untracked file, so a second worktree, a new clone
or a cloud session on another environment can lack it, and `gh` would
then run on a full credential in silence. One hook closes that:
`.claude/hooks/gh-token-required.sh`, registered in
`.claude/settings.json` under `PreToolUse`, matcher `Bash`, with
`"if": "Bash(gh *)"` and `"onFailure": "block"`. Without the second, a
hook that cannot start or times out lets the call go ahead: the
settings schema in Claude Code 2.1.323 gives the default as "the
failure is reported and the action goes ahead" (planner's reading of
the installed schema, 13 Nov 2026), which would fail open.

The script reads no command text. It exits 0 when `GH_TOKEN` starts with
`github_pat_`, and otherwise exits 2 with one message: this session has
no restricted token, and `docs/runbooks/github-access.md` step 3 (or 4
in the cloud) installs it.

Which calls run `gh` is Claude Code's judgment, by the reader its
permission rules use, and it runs the hook when it cannot tell. That is
a seat belt for a session set up wrong, not a wall against one trying to
get round it (Not covered). If a Claude Code version ignores `if`, the
hook runs for every Bash call, which refuses more, never less.

It rests on one thing the docs give in two sentences, not one: settings
`env` values are "copied into its environment" and "A hook process
inherits the parent environment". If a hook does not see the settings
`env`, every `gh` call is refused at the owner's step 3, before the
merge, and that is a finding against this section.

### 8. Promotion

A session can no longer push `main`, with or without asking.
`close-out.md` step 7 keeps every check it makes today. Where it says
"run `git push origin <sha>:main`" it instead stops and gives the owner
the command for their own terminal, in both spellings:

- Git Bash: `TYRE_PROMOTE=1 git push origin <sha>:main`
- PowerShell: `$env:TYRE_PROMOTE='1'; git push origin <sha>:main; $env:TYRE_PROMOTE=$null`

When the owner says it is pushed, the step goes on from
`git fetch origin main` as today. The runbook's Promote to production
step 3 and CONTRIBUTING's promotion paragraph carry the same two forms,
and the runbook's step 4 says the `deploy-prod` jobs wait for the
owner's approval in the run's "Review deployments" box.

### 9. Deletes

- `.claude/hooks/merge-push-guard.sh`.
- Its registration in `.claude/settings.json` (the second hook of the
  `Bash` matcher). Section 7's hook takes that place.
- In `scripts/hooks.test.sh`: the guard's cases and everything only they
  use (`hook=`, `repo`, `run`, `denied`, `asked`, `allowed`, the four
  staged repositories).

Three guard bugs go with it and need no fix: a GraphQL
`createCommitOnBranch` to `develop` passed with no ask; GitHub's GET
"check if merged" was refused as a merge; and the guard failed open when
`jq` failed (ticket, Bugs this removes).

### 10. Tests

`scripts/hooks.test.sh` keeps its first check, that every hook
`settings.json` names is mode 100755 in git, and adds
`.githooks/pre-push` to it. Its header and `Makefile`'s `hooks-test`
description are rewritten. It then runs The push cases below with real
`git push` against a bare remote in a temp directory, the hook installed
through `core.hooksPath` exactly as `make hooks-install` does it. It
also runs section 7's hook four times: with `GH_TOKEN` unset, empty and
set to a value that does not start with `github_pat_`, each exiting 2
with the runbook named on stderr, and with a `github_pat_` value,
exiting 0 with no output. And it asserts that the hook's entry in
`settings.json` carries `"if": "Bash(gh *)"` and
`"onFailure": "block"`.

`scripts/guard-check.test.sh` runs The check's cases below with stub
`gh` and `git` on `PATH` and a temp repository. `make
guard-check-test` joins `make test` and CI's "Infrastructure and
workflows" job beside `hooks-test`.

Each case is shown red before the code that turns it green
(`docs/lessons.md`, 2026-11-03, the text-matching gate).

The registered hook is also watched refusing once, live, since a
configuration that is present proves nothing is enforced
(`docs/lessons.md`, 2026-08-21; TYRE-250's bar). After the registration
lands, the implementer makes the working copy's hook refuse every token,
runs one `gh` command and sees the refusal naming the runbook, runs one
`git` command and sees it run, and restores the file with the Edit tool,
ending with no diff. The result goes in the PR body.

### 11. Docs

| Where | Change |
| --- | --- |
| `CLAUDE.md:179-189`, the hooks paragraph | Still three hooks; the guard's sentences go and `gh-token-required.sh` takes its place, in one sentence. A new short paragraph says what holds the merge and the push now: the `develop` ruleset, the restricted `gh` token and `.githooks/pre-push`, that `make guard-check` proves them, that `--no-verify` and a hand-set `TYRE_PROMOTE` are the limits, and cites the runbook. |
| `.claude/settings.json` | The guard's registration goes; `gh-token-required.sh` is registered with `"if": "Bash(gh *)"`. Nothing under `permissions` changes. |
| `CLAUDE.md`, Commands | Add `make hooks-install` and `make guard-check`. |
| `CLAUDE.md`, Repo etiquette | `develop` takes a change only through a pull request (ruleset, U201). |
| `docs/lessons.md`, 2026-11-03, the text-matching gate (`:205-209`) | Amend the rule: the consumer of a push is git and of a merge GitHub, so ask them first; read the text the way its consumer does only when no consumer can be asked. Name TYRE-473 as where the guard went. |
| `docs/lessons.md`, 2026-11-03, the jq CR entry (`:211-221`) | Its "What happened" names the deleted file; say it was the guard deleted by TYRE-473. The rule stands. |
| `docs/adr/0017-...:146-156` | Dated amendment: the `production` environment requires the owner's review (read 13 Nov 2026), so "no required reviewer" and "Not taken: a reviewer click" no longer hold. |
| `docs/adr/0018-...:92-96` | Dated amendment: the `develop` ruleset now requires a pull request (U201), and the routine's `gh` runs on a restricted token; what is left to the prompt is a fast-forward of `main`, which the production approval holds. |
| `docs/adr/0004-...:75-78` | Dated paragraph: `develop` takes changes only by pull request (U201, TYRE-473), and a workflow closes a pull request into `main` (TYRE-313), so "nothing refuses a pull request into `main`" no longer holds. |
| `.claude/commands/close-out.md` | Step 7 (Promotion, above); the cloud-mode check (section 6). |
| `.claude/commands/pipeline.md` | Before anything: the `make guard-check` step. |
| `docs/runbooks/environment-release.md:1032-1042` | Promote to production steps 3 and 4 (Promotion, above). |
| `docs/runbooks/environment-release.md:1046-1048` | It says close-out's step 7 "follows this section"; say that close-out makes the checks and hands the push to the owner. |
| `docs/lessons.md`, 2026-08-31, the promotion rule (`:1691`) | Its command gains `TYRE_PROMOTE=1`, in the owner's terminal; the hook refuses it otherwise. |
| `docs/delivery-history.md:27-29` | The same promotion command, stated in the present tense; the same change. |
| `docs/runbooks/environment-release.md:128-133, 625-631` | These blocks write environments and variables, which need Administration and Environments write. Say they run in the owner's own terminal, not in a Claude session. |
| `CONTRIBUTING.md:47-51` | The promotion push needs `TYRE_PROMOTE=1`; add that a change reaches `develop` only by pull request. |
| `docs/implementation-order.md:196-200` | The restore of a deleted `develop` is the owner's, with `TYRE_PROMOTE=1`; ruleset 21929055 now refuses the deletion this guards against. |
| `docs/superpowers/specs/2026-11-09-autonomous-runs-design.md:258` | An italic rider above the paragraph: the guard was replaced by TYRE-473. The body is not rewritten. |
| `Makefile` | `hooks-install`, `guard-check`, `guard-check-test`; `hooks-test`'s description; `check` and `pipeline` depend on `hooks-install`; `test` runs `guard-check-test`. |
| `.gitignore` | `.claude/settings.local.json`. |
| `.github/workflows/ci.yml` | A "Guard check cases" step beside "Hook cases". |
| `.github/pull_request_template.md` | No change. This PR's body carries the owner's steps as its own boxes. |

### 12. The runbook: `docs/runbooks/github-access.md`

New, short, and the one home for the owner's steps. Every other doc
cites it. In this order, each with its read-only check:

1. The ruleset (section 1). Check: `make guard-check` row 3.
2. Git's credential and the sign-in (section 3). Check:
   `git config --get-all credential.https://github.com.helper` ends in
   `manager`, and then the dry-run push exits 0. The dry run alone
   proves nothing, since it passes on the `gh` helper too.
3. `tyre-claude-local` into `.claude/settings.local.json` (section 2),
   after step 2, never before. Check: in a Claude session,
   `make guard-check` prints six `OK` lines. A linked worktree whose
   sessions have `gh` refused gets the same `env` block in its own
   `.claude/settings.local.json`.
4. `tyre-claude-cloud` into the routine's cloud environment. That
   environment must serve only this repository, because every `gh` in it
   then runs on a token that can write nowhere else: if the routine's
   environment is shared, the owner first creates one for it and points
   the routine at it. Check: the next close-out's report carries the
   check's five `OK` lines.
5. Remove the `github.com` lines from `~/.git-credentials` and revoke
   those tokens on GitHub.
6. When a token expires or leaks: revoke it, create its replacement
   with the same permissions, and repeat step 3 or 4.

It also says what this does not hold (Not covered), in plain words.

## The push cases

The contract for `scripts/hooks.test.sh`. "Refused" means `git push`
exits non-zero, stderr carries the hook's refusal, and the remote's
`develop` and `main` have not moved. Local `develop` is one commit ahead
of the remote throughout.

| Case | Result |
| --- | --- |
| `git push -u origin TYRE-1-feature`; a bare `git push` on a feature branch; `git push origin HEAD` on one | pushed |
| `git push origin develop` | refused |
| `git push origin HEAD:main`; `<sha>:refs/heads/main` | refused |
| `git push origin +TYRE-1-feature:develop` | refused |
| `git push origin :develop` (a delete) | refused |
| `git push --all origin`; `--mirror`; `'refs/heads/*:refs/heads/*'`; `git push origin :` | refused |
| a feature branch and `develop` in one push | refused, and the feature branch is not pushed either |
| `TYRE-1-feature:develop-notes`; `TYRE-1-feature:TYRE-9-main` | pushed |
| a delete of a feature ref | pushed |
| a tag named `main` (`refs/tags/main`) | pushed |
| on `develop`: `git push -u origin "$(git branch --show-current)"` (U176) | refused |
| on `develop`: `git push -u origin HEAD` | refused |
| `git -C <repo> push origin HEAD` from another directory, on `develop` | refused |
| `b=develop; git push origin "$b"`; `sh -c 'git push origin develop'`; `eval "git push origin develop"` | refused |
| a push by URL with no remote name, to `develop` | refused |
| a bare `git push` on a branch whose upstream is `develop`, `push.default upstream` | refused |
| from a linked worktree: a feature push; `HEAD:main` | pushed; refused |
| `TYRE_PROMOTE=0`, `TYRE_PROMOTE=true`, `TYRE_PROMOTE=` with a push to `develop` | refused |
| `TYRE_PROMOTE=1 git push origin develop:main`, a fast-forward | pushed, and the remote's `main` moved |
| a push of `main`'s own commit to `main` (nothing to update) | exits 0, nothing moved |

`--no-verify`, `-c core.hooksPath=` and an unset `core.hooksPath` are
not cases: they are the named limits, and row 1 of the check covers the
last.

## The check's cases

The contract for `scripts/guard-check.test.sh`. Every row passing gives
exit 0 and one `OK` per row. Each of these alone gives exit 1 and a
`FAIL` naming the row:

- `core.hooksPath` unset; set to another directory; the hook file
  missing.
- `TYRE_PROMOTE=1` in the environment.
- The rules list has no `pull_request` rule; the ruleset reads
  `current_user_can_bypass` other than `never`; `gh` fails.
- `GH_TOKEN` unset; empty; a value that does not start with
  `github_pat_`.
- The ref update answers 422; 401; 200; `gh` prints no status line.
- The helper's last value is the `gh` helper; the dry-run push exits
  non-zero.
- With `CLOUD=1`: row 6 is not run, and its stubs failing changes
  nothing.

The output never contains the token's value, which a case asserts.

## Order of the owner's steps, and the PR's gate

Steps 1 to 3 (the ruleset, git's credential, the local token) are done
before implementation starts, from the lead's instructions in chat,
since the runbook does not exist yet; the lead checks each with a read.
The run then proves them: the lead runs `make guard-check` before the
push, and the push, the PR and the CI wait all run on the new
credentials.

The PR body carries steps 4 and 5 (the cloud token, the plaintext
credentials) as tick boxes under "Before you merge", each with its
check, and records steps 1 to 3 as done with the check's output.

The order matters twice: step 2 before step 3 (Constraints), and all of
them before the merge, because the merge deletes the guard for every
later session.

After the merge the first `make pipeline` runs `make guard-check`, so a
missed step stops that run with the row that failed.

## Not covered

- **`git push --no-verify`, `git -c core.hooksPath=... push`, and an
  agent typing `TYRE_PROMOTE=1` itself.** Each skips the hook. On
  `develop` the ruleset still refuses the push. On `main` what is left
  is ruleset 21133437 (fast-forward only), the deploy's own refusals and
  the owner's production approval.
- **`env -u GH_TOKEN gh ...` in a local session.** `gh` then uses the
  stored full login, and section 7's hook has already passed. It is a
  form only a deliberate evasion produces; the same is true of a `gh`
  call Claude Code's reader does not see as one, and of reading git's
  credential out of Windows Credential Manager.
- **The token is readable inside a session** (`printenv GH_TOKEN`). On
  this repository it can comment, label, and open and edit pull
  requests.
- **Actions write reaches further than re-run and cancel.** GitHub's
  table also puts a workflow dispatch, disabling a workflow and deleting
  a run or its logs under it. `deploy.yml` takes a dispatch with
  `target` and `image_sha` (`:30-40`), and the `staging` environment has
  no reviewer, so a session can put staging on any image already in the
  registry. A production dispatch still waits for the owner's approval.
  The stored login could do all of this and more, so the token narrows
  what a session holds; it does not close this.
- **GraphQL mutations under the token** beyond the two the owner's
  probe ran (`mergePullRequest` refused, a PR title update allowed).
  `createCommitOnBranch` and `enablePullRequestAutoMerge` were not
  called; the first needs Contents write by GitHub's table, and the repo
  has auto-merge off.
- **A session that is neither the pipeline nor the cloud close-out**
  (a plain chat, `/ticket`) runs no `make guard-check` at start.
  `make check` installs the push hook, the ruleset does not depend on
  the session, and section 7's hook refuses `gh` where the token is
  missing. The git credential rows are checked only where the check
  runs.
- **A cloud session outside the routine's environment** has its `gh`
  calls refused by section 7's hook. The proxy still holds the owner's
  credential there, so a request that is not a `gh` call (a `curl`, a
  built-in GitHub tool if one can merge, which the docs do not say) is
  not covered. The ruleset still holds `develop` against a push.
- **Whether teammates and subagents get the settings `env`.** The docs
  say "every session and its subprocesses" and do not name them. A
  teammate without it has its `gh` calls refused by section 7's hook,
  which is loud, not silent.
- **A worktree checked out at a commit older than this change** has no
  `.githooks/pre-push`, so pushes from it are not judged.

## Definition of done

1. `merge-push-guard.sh`, its registration and its cases are gone, and
   `rg merge-push-guard` finds it only in dated records (specs, the
   lessons entries as amended).
2. Every row of The push cases and The check's cases is a test that was
   seen red, and `make check` is green.
3. Every row of the Docs table is done.
4. `docs/runbooks/github-access.md` exists and the PR's "Before you
   merge" boxes cite it.
5. Before the push: `make guard-check` prints six `OK` lines in the
   lead's session, and the PR is opened by a `gh` running on the
   restricted token. Its output goes in the PR body.
6. Owner, before the merge: steps 4 and 5 of the runbook.
7. After the merge: the first `make pipeline` launch passes its
   `make guard-check` step, and the first cloud close-out's report
   carries the five `OK` lines. Items 6 and 7 are the owner's and the
   close-out's to record on the ticket; the run that builds this cannot.

## Lead's calls

1. **The token lives in `.claude/settings.local.json`, not the shell.**
   cli.github.com/manual/gh_auth_login ("Favour setting `GH_TOKEN`");
   code.claude.com/docs/en/env-vars ("no matter how `claude` was
   launched").
2. **Git moves to Git Credential Manager in this repo's local config.**
   The lead's probe (`GH_TOKEN=probe gh auth git-credential get`);
   git-scm.com/docs/gitcredentials (the empty value resets the list).
3. **One ruleset for `develop`, the existing 21929055 with a second
   rule.** docs.github.com, available rules for rulesets.
4. **The check reads `current_user_can_bypass`** because GitHub's pages
   do not say an empty bypass list binds the admin
   (`gh api .../rulesets/21929055`, read 13 Nov 2026).
5. **The token's refusal is proved by a ref update on a ref that does
   not exist.** The lead's call on the stored login returned 422 and
   created nothing.
6. **`make check` and `make pipeline` install the hook.**
   typicode.github.io/husky/how-to.html (the `prepare` script, "for
   automatic execution after each install"); github.com/typicode/husky
   `index.js` (it runs `git config core.hooksPath`).
7. **The pipeline's Before anything and the cloud close-out run the
   check**, so a missing control stops the two unattended paths
   (CLAUDE.md, "If a gate cannot run, fix the gate").
8. **No new deny rules.** code.claude.com/docs/en/permissions ("isn't a
   security boundary around the program").
9. **No new ADR; ADR-0004, ADR-0017 and ADR-0018 are amended.**
   `docs/adr/0018-ticket-orchestration.md:92-96` already frames the
   ruleset as the owner's pending call.
10. **A new runbook, `docs/runbooks/github-access.md`.** The steps are
    manual, repeat on a new machine and at each token's expiry, and a
    PR body is not where the next reader looks.
11. **`TYRE_PROMOTE` stays an environment variable, as the ticket has
    it**, with a PowerShell spelling beside the Git Bash one, since the
    owner's terminal is PowerShell.
12. **The hook judges every remote and both branches by name.** The
    probe's push-by-URL case; ADR-0004 names the two branches.
13. **ADR-0004's line that nothing refuses a pull request into `main`
    is corrected in the same amendment**, since TYRE-313's workflow
    made it false and this branch amends that paragraph.
14. **A hook refuses `gh` in a session without the restricted token,
    limited by `"if": "Bash(gh *)"`.** code.claude.com/docs/en/hooks
    (the `if` field; exit 2). The builder check found that a linked
    worktree on Windows may not read the main checkout's local settings
    (code.claude.com/docs/en/worktrees), which would fail open.
15. **Actions write stays on the token, as the ticket has it.**
    `.claude/commands/pipeline.md` re-runs and cancels CI runs
    (Hand-over step 4). What else it reaches is under Not covered.
16. **The routine's cloud environment serves only this repository.**
    code.claude.com/docs/en/cloud-environments ("If you set a token, it
    passes through to the container unchanged"), so a shared environment
    would put every other repository's `gh` on this token.
17. **The builder check's other questions.** Which `gh` forms work under
    the token: the owner's probe answers it. Whether the ruleset read
    carries `current_user_can_bypass` under the token: it does, read by
    the lead under the installed token.
18. **The owner's steps 1 to 3 were done and read back on 13 Nov 2026,
    before the plan.** `rules/branches/develop` lists `pull_request` on
    ruleset 21929055 with 0 required approvals; git's helper for
    `github.com` ends in `manager` and a non-interactive dry-run push
    exits 0; the session's `GH_TOKEN` is a fine-grained token, and the
    ref update on a ref that does not exist answers 403, "Resource not
    accessible by personal access token". The settings `env` reached
    the running session with no restart.

## Left to the builder

- The hook's exact refusal wording and the check's output format, within
  the contracts above.
- How the check's rows are split into functions, and how its test stubs
  `gh` and `git`.
- The wording of every doc row, in the repo's prose standard
  (`docs/comments.md`). `scripts/check-comment-style.mjs` does not read
  an extensionless file, so the hook's comments are checked by eye.
- Whether `hooks.test.sh` builds its repositories once or per case.

## Rejected

- **Keeping a small text check for the merge endpoint.** It is the
  mechanism the audit's verdict replaces, and its grammar holes come
  back with it.
- **A ruleset on `main` requiring a pull request.** Promotion is a
  fast-forward push by design (ADR-0004), and a pull request into
  `main` cannot fast-forward.
- **Required approvals on `develop`.** The owner is the only
  collaborator and "Pull request authors cannot approve their own pull
  requests" (GitHub docs).
- **A SessionStart hook that runs the check in every session.** It
  would put a network call and a failure mode in front of every chat;
  the two unattended paths are where a missing control costs.
- **Refusing every Bash call in a session without the token.** It needs
  no `if`, but a session could not even read the runbook's commands
  back, and a cloud review on another environment would lose its shell.
- **A placeholder `GH_TOKEN` in the tracked `settings.json`**, so `gh`
  fails wherever the local file does not override it. The docs say the
  settings value "applies in most sessions" over the environment's, so
  in the cloud it could override the routine's real token.
- **Dropping Actions write.** The pipeline's re-run and cancel steps
  would become the owner's, at every red CI run.
- **An in-run stop for the owner's steps.** CLAUDE.md's stops table has
  no such row. Steps 1 to 3 ride on the spec approval stop, and steps 4
  and 5 are the PR's boxes.
