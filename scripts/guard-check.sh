#!/usr/bin/env bash
# Read-only proof of what holds a merge and a push: the git hook, the develop
# ruleset, the restricted gh token and git's own credential. One line per row:
# OK; FAIL when a read shows the control missing, with its fix, most often a
# runbook step; or UNCHECKED when GitHub gave the row no answer about it, with
# a re-run and then the row's step (TYRE-473, U210,
# docs/runbooks/github-access.md). Of what gh and git return it prints only an
# HTTP status code, the core.hooksPath value and the hook's index mode, so
# neither the token nor a credential in a remote URL can reach it.
set -uo pipefail

usage() { echo "usage: make guard-check [CLOUD=1]" >&2; exit 2; }
cloud=0
case $# in
  0) ;;
  1) if [ "$1" = --cloud ]; then cloud=1; else usage; fi ;;
  *) usage ;;
esac

top=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "guard-check: not inside a git work tree" >&2; exit 2; }
cd "$top" || exit 2

repo=Rourke9001/TyrePlatform
failed=0
ok() { echo "OK row $1: $2"; }
bad() { echo "FAIL row $1: $2: $3. Fix: $4"; failed=1; }
# FAIL takes only an answer on the row's own list. gh exits 1 for any failure,
# and the cloud proxy and GitHub's rate limits answer 403 too, so any other
# result says nothing about the control and guesses no cause (TYRE-473, U210).
unchecked() { echo "UNCHECKED row $1: $2: $3. Run make guard-check again once any FAIL row is fixed; if row $1 stays UNCHECKED, $4"; failed=1; }

hooks_path=$(git config --get core.hooksPath 2>/dev/null | tr -d '\r')
hook_mode=$(git ls-files -s -- .githooks/pre-push | cut -d' ' -f1)
if [ "$hooks_path" != .githooks ]; then
  bad 1 "push hook installed" "core.hooksPath is '${hooks_path:-unset}', not .githooks" "make hooks-install, on a checkout whose .githooks/pre-push is 100755 in git"
elif [ ! -f .githooks/pre-push ]; then
  bad 1 "push hook installed" ".githooks/pre-push is missing" "make hooks-install, on a checkout whose .githooks/pre-push is 100755 in git"
elif [ "$hook_mode" != 100755 ]; then
  bad 1 "push hook installed" ".githooks/pre-push is mode ${hook_mode:-untracked} in git, not 100755" "make hooks-install, on a checkout whose .githooks/pre-push is 100755 in git"
else
  ok 1 "push hook installed"
fi

# An empty value counts: the hook compares to 1, but the check asks for unset.
if [ -n "${TYRE_PROMOTE+set}" ]; then
  bad 2 "TYRE_PROMOTE not set" "TYRE_PROMOTE is set in this environment" "unset TYRE_PROMOTE; only the owner's promotion push sets it (docs/runbooks/github-access.md)"
else
  ok 2 "TYRE_PROMOTE not set"
fi

# GitHub applies every ruleset that matches develop, so one ruleset that
# requires a pull request and cannot be bypassed is enough; a read that fails
# or has no field never counts as "never".
ids=$(gh api "repos/$repo/rules/branches/develop" --jq '[.[] | select(.type == "pull_request") | .ruleset_id] | unique | .[]' 2>/dev/null)
rules_rc=$?
ids=${ids//$'\r'/}
pr_held=0
unread=""
[ "$rules_rc" -ne 0 ] && unread="develop's rules"
if [ "$rules_rc" -eq 0 ] && [ -n "$ids" ]; then
  for id in $ids; do
    bypass=$(gh api "repos/$repo/rulesets/$id" --jq '.current_user_can_bypass // "absent"' 2>/dev/null)
    bypass_rc=$?
    bypass=${bypass//$'\r'/}
    if [ "$bypass_rc" -ne 0 ]; then unread="a pull request ruleset on develop"
    elif [ "$bypass" = never ]; then pr_held=1; fi
  done
fi
if [ "$pr_held" -eq 1 ]; then
  ok 3 "develop needs a pull request"
elif [ -n "$unread" ]; then
  unchecked 3 "develop needs a pull request" "gh could not read $unread" "docs/runbooks/github-access.md step 1"
elif [ -z "$ids" ]; then
  bad 3 "develop needs a pull request" "no ruleset requires a pull request on develop" "docs/runbooks/github-access.md step 1"
else
  bad 3 "develop needs a pull request" "no pull request ruleset on develop is one this token's user cannot bypass" "docs/runbooks/github-access.md step 1"
fi

token_step="docs/runbooks/github-access.md step 3"
[ "$cloud" -eq 1 ] && token_step="docs/runbooks/github-access.md step 4"
case "${GH_TOKEN:-}" in
  github_pat_*) ok 4 "restricted gh token" ;;
  *) bad 4 "restricted gh token" "GH_TOKEN is not a fine-grained github_pat_ token" "$token_step" ;;
esac

# A write to a ref that does not exist is refused by the token's permissions
# before GitHub looks for the ref, so the probe changes nothing even if the
# token were wrong. The capture is never printed (TYRE-473).
sha=$(git rev-parse HEAD 2>/dev/null | tr -d '\r')
resp=$(gh api -i -X PATCH "repos/$repo/git/refs/heads/tyre-473-no-such-ref" -f "sha=$sha" 2>&1)
resp=${resp//$'\r'/}
code=$(printf '%s\n' "$resp" | grep -Eo -m1 '^HTTP/[0-9.]+ [0-9]{3}' | grep -Eo '[0-9]{3}$')
if [ "$code" = 403 ] && [[ "$resp" == *"Resource not accessible by personal access token"* ]]; then
  ok 5 "token cannot write a branch"
elif [ "$code" = 401 ]; then
  bad 5 "token cannot write a branch" "GitHub refused the token (HTTP 401), so it is expired or revoked" "docs/runbooks/github-access.md step 6"
elif [[ "$code" == 2?? || "$code" == 409 || "$code" == 422 ]]; then
  # The endpoint's own answers, which GitHub gives only past the token's
  # permission check (docs.github.com/en/rest/git/refs, TYRE-473).
  bad 5 "token cannot write a branch" "the probe write got HTTP $code, so GitHub let this token try the write" "$token_step"
else
  seen=${code:+HTTP $code}
  [ "$code" = 403 ] && seen="HTTP 403 without GitHub's refusal of the token's permissions"
  unchecked 5 "token cannot write a branch" "the probe write got ${seen:-no status line}" "$token_step"
fi

# The cloud has no git credential of its own, so only a local run reads this
# row. Prompts and askpass are off so a missing credential fails here instead
# of waiting for a person.
if [ "$cloud" -eq 0 ]; then
  helper=$(git config --get-all credential.https://github.com.helper 2>/dev/null | tail -n 1 | tr -d '\r')
  if [[ "$helper" == *"auth git-credential"* ]]; then
    bad 6 "git signs in by its own credential" "git's last helper for github.com is gh's, so a push would sign in as the token" "docs/runbooks/github-access.md step 2"
  elif GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS= SSH_ASKPASS= git push --dry-run origin HEAD:refs/heads/tyre-473-guard-check >/dev/null 2>&1; then
    ok 6 "git signs in by its own credential"
  elif [ "$rules_rc" -eq 0 ]; then
    # The check sees only the rules read's exit code, so only a read that
    # succeeded shows GitHub took a request in this run; only then is a failed
    # dry run read as git's sign-in (TYRE-473, U210).
    bad 6 "git signs in by its own credential" "a dry-run push to origin failed without a prompt" "docs/runbooks/github-access.md step 2"
  else
    unchecked 6 "git signs in by its own credential" "a dry-run push to origin failed without a prompt, and so did row 3's rules read" "docs/runbooks/github-access.md step 2"
  fi
fi

# END OF ROWS
exit "$failed"
