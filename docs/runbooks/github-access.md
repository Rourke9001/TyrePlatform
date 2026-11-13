# GitHub access: what holds a merge and a push

Three things hold what a Claude session can write to this repository
(TYRE-473, U201):

- **The `develop` ruleset** (ruleset 21929055) requires a pull request on
  `develop`. GitHub enforces it on the server, for every client.
- **A restricted token for `gh`**, set as `GH_TOKEN` in each session. It has no
  Contents write, so it cannot merge a pull request, write a branch or a file,
  or create a ref.
- **`.githooks/pre-push`** refuses a push to `develop` or `main` from this
  checkout, and a delete of either always. `main` is promoted only with
  `TYRE_PROMOTE=1`, from the owner's own terminal.

`make guard-check` reads each of them and prints one `OK` or `FAIL` line per
row. `make check` and `make pipeline` run `make hooks-install`, which installs
the push hook (guard-check row 1). Every step below runs in the owner's own
terminal, never in a Claude session, unless its check says "in a Claude
session".

## 1. The ruleset

In the repository's Settings, Rules, Rulesets, open "Protect develop from
deletion" and add the rule "Require a pull request before merging" with 0
required approvals. The bypass list stays empty and the target stays
`refs/heads/develop`. The owner still merges with the rebase or squash button.

Check: `make guard-check`, row 3.

## 2. Git's own credential

Git must sign in by Git Credential Manager here, not by the `gh` helper, or a
push would run on the stored `gh` login. Two local settings move this
repository off it:

```bash
git config --local credential.https://github.com.helper ""
git config --local --add credential.https://github.com.helper manager
```

The empty value resets the helper list, which also keeps a global `store`
helper from saving GitHub's credential in plaintext. Then sign in once, with a
push that writes nothing:

```bash
git push --dry-run origin HEAD:refs/heads/tyre-473-sign-in
```

Git Credential Manager opens the browser.

Check: `git config --get-all credential.https://github.com.helper` ends in
`manager`, and then the dry-run push exits 0. The dry run alone proves
nothing, since it passes on the `gh` helper too. `make guard-check` row 6 fails
when the list ends in the `gh` helper; otherwise it makes the dry run. It does
not look for `manager`, so read the list yourself.

## 3. The local token

Create a fine-grained token named `tyre-claude-local`: repository access only
`Rourke9001/TyrePlatform`; Contents read; Pull requests, Issues and Actions
read and write; Metadata read (GitHub adds it); expiry one year.

Put it in `.claude/settings.local.json`, beside any keys the file already has:

```json
{ "env": { "GH_TOKEN": "<token>" } }
```

Do this after step 2, never before. A running session reloads its settings, so
the other order would send every push on the token and break them at once. The
file is ignored by git (`.gitignore`); never commit it, and never paste the
token into a chat, a ticket or a log.

A linked worktree whose sessions have `gh` refused gets the same `env` block in
its own `.claude/settings.local.json`.

Check, in a Claude session: `make guard-check` prints six `OK` lines.

## 4. The cloud token

Create a second fine-grained token, `tyre-claude-cloud`, with the same
permissions, so revoking one never breaks the other. Set it as the environment
variable `GH_TOKEN` in the close-out routine's cloud environment.

That environment must serve only this repository, because every `gh` in it then
runs on a token that can write nowhere else. If the routine's environment is
shared, create one for it first and point the routine at it.

Check: the next close-out's report carries the check's five `OK` lines
(`make guard-check CLOUD=1`).

## 5. Remove the plaintext credentials

Remove the `github.com` lines from `~/.git-credentials` and revoke those tokens
on GitHub. The check counts and never prints:

- Git Bash: `grep -c 'github\.com' ~/.git-credentials`
- PowerShell: `(Select-String -Path ~/.git-credentials -Pattern 'github\.com').Count`

Each should say 0.

## 6. When a token expires or leaks

Revoke it, create its replacement with the same permissions, and repeat step 3
or step 4. An expired token answers 401, which `make guard-check` reads as a
failure, so expiry stops the pipeline and the close-out; it never fails open.

## Promote to production

`docs/runbooks/environment-release.md`, Promote to production, has the steps.
The push itself runs only in the owner's terminal, with the 40-character SHA
typed out:

```bash
TYRE_PROMOTE=1 git push origin <sha>:main
```

```powershell
$env:TYRE_PROMOTE='1'; git push origin <sha>:main; $env:TYRE_PROMOTE=$null
```

Type the SHA, not a variable. A variable set in one shell does not exist in
another, and an empty one turns the refspec into `:main`, a delete.

## What this does not hold

- `git push --no-verify`, `git -c core.hooksPath=... push`, and an agent typing
  `TYRE_PROMOTE=1` itself each skip the hook. On `develop` the ruleset still
  refuses. On `main`, what is left is ruleset 21133437 (fast-forward only), the
  deploy's own refusals and the owner's production approval.
- `env -u GH_TOKEN gh ...` in a local session runs `gh` on the stored full
  login. So does a call Claude Code does not read as `gh`, and reading git's
  credential out of Windows Credential Manager.
- The token is readable inside a session. On this repository it can comment,
  label, and open and edit pull requests.
- Actions write reaches further than re-run and cancel: a workflow dispatch,
  disabling a workflow, and deleting a run or its logs. A session can put
  staging on any image already in the registry. A production dispatch still
  waits for the owner's approval.
- A session that is neither the pipeline nor the cloud close-out runs no
  `make guard-check` at its start. `make check` installs the push hook, the
  ruleset does not depend on the session, and the `gh` hook refuses `gh` where
  the token is missing.
- A cloud session outside the routine's environment has its `gh` calls refused,
  but a request that is not a `gh` call is not covered there. The ruleset still
  holds `develop` against a push.
- A worktree checked out at a commit older than this change has no
  `.githooks/pre-push`, so pushes from it are not judged.
