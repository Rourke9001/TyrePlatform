#!/usr/bin/env bash
# Cases for .claude/hooks and .githooks (TYRE-473, TYRE-481). Every hook
# settings.json names, and .githooks/pre-push, must be executable in git, or
# Linux, where the cloud routines run, cannot run it. Then the make wiring, the
# gh hook's registration and its cases, local and cloud, the connector allow
# rules, then the push cases: real git push against a bare remote, through the
# hook installed as make hooks-install installs it.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

root=$(cd "$here/.." && pwd)
while IFS= read -r path; do
  mode=$(git -C "$root" ls-files -s -- "$path" | cut -d" " -f1)
  if [ "$mode" = 100755 ]; then echo "PASS: $path is executable in git"; else
    echo "FAIL: $path is mode ${mode:-untracked} in git, not 100755"; fails=$((fails + 1)); fi
done < <(jq -r ".hooks[][].hooks[].command" "$root/.claude/settings.json" | tr -d "\r" | sed -E "s#^\"[$]CLAUDE_PROJECT_DIR\"/##"; echo .githooks/pre-push)

# The gh hook must be registered for Bash with "if" keeping it to gh calls and
# "onFailure" making a hook that cannot start count as a refusal (TYRE-473).
reg=$(jq -c '[.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[]
  | select(.command | endswith("/.claude/hooks/gh-token-required.sh"))]' "$root/.claude/settings.json" | tr -d '\r')
reg_n=$(printf '%s' "$reg" | jq 'length' | tr -d '\r')
reg_type=$(printf '%s' "$reg" | jq -r '.[0].type // empty' | tr -d '\r')
reg_if=$(printf '%s' "$reg" | jq -r '.[0].if // empty' | tr -d '\r')
reg_fail=$(printf '%s' "$reg" | jq -r '.[0].onFailure // empty' | tr -d '\r')
if [ "$reg_n" = 1 ] && [ "$reg_type" = command ] && [ "$reg_if" = 'Bash(gh *)' ] && [ "$reg_fail" = block ]; then
  echo "PASS: gh-token-required.sh is registered for Bash with if and onFailure"
else
  echo "FAIL: gh-token-required.sh registration is '$reg'"; fails=$((fails + 1))
fi

# The connector's tools: settings.json allows exactly these twelve, and
# executeWrite is left to ask, since it runs any write the connector has
# (TYRE-481). No tracked file under .claude names the removed connector.
want_mcp=$(printf 'mcp__claude_ai_Atlassian_MCP__%s\n' getJiraIssue listJiraIssueComments \
  searchJiraIssuesUsingJql getConfluenceContent searchConfluence getAccessibleAtlassianResources \
  search addOrEditJiraIssueComment transitionJiraIssue createJiraIssue discover executeRead | LC_ALL=C sort)
got_mcp=$(jq -r '.permissions.allow[] | select(startswith("mcp__claude_ai_Atlassian"))' "$root/.claude/settings.json" | tr -d '\r' | LC_ALL=C sort)
if [ "$got_mcp" = "$want_mcp" ]; then echo "PASS: settings.json allows the connector's twelve tools and no other Atlassian tool"; else
  echo "FAIL: settings.json's Atlassian allow rules are: $got_mcp"; fails=$((fails + 1)); fi
rovo=$(git -C "$root" grep -l Atlassian_Rovo -- .claude 2>/dev/null)
if [ -z "$rovo" ]; then echo "PASS: no tracked file under .claude names Atlassian_Rovo"; else
  echo "FAIL: these name Atlassian_Rovo: $rovo"; fails=$((fails + 1)); fi
want_tools="tools: Read, Grep, Glob, Bash, mcp__claude_ai_Atlassian_MCP__getJiraIssue, mcp__claude_ai_Atlassian_MCP__listJiraIssueComments, mcp__claude_ai_Atlassian_MCP__searchConfluence, mcp__claude_ai_Atlassian_MCP__getConfluenceContent"
got_tools=$(grep -m1 '^tools: ' "$root/.claude/agents/plan-red-team.md" | tr -d '\r')
if [ "$got_tools" = "$want_tools" ]; then echo "PASS: plan-red-team names the connector's four tools"; else
  echo "FAIL: plan-red-team's tools line is '$got_tools'"; fails=$((fails + 1)); fi

# make hooks-install points git at .githooks, and pipeline runs it first
# (TYRE-473). Make prints CRs on Windows, so strip them.
mk_lines() { make -s -n -C "$root" "$@" | tr -d '\r' | sed -E 's/[[:space:]]+$//'; }
want="git config core.hooksPath .githooks"
got=$(mk_lines hooks-install)
if [ "$got" = "$want" ]; then echo "PASS: make hooks-install runs one git config line"; else
  echo "FAIL: make hooks-install printed '$got'"; fails=$((fails + 1)); fi
got=$(mk_lines pipeline T=TYRE-1 | head -n 1)
if [ "$got" = "$want" ]; then echo "PASS: make pipeline installs the hook first"; else
  echo "FAIL: make pipeline printed '$got' first"; fails=$((fails + 1)); fi

# The gh hook: a gh call without the restricted token is refused with the
# runbook named, and the token's value is never echoed (TYRE-473).
token_case() {
  local label=$1 want=$2 rc
  shift 2
  local json='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"gh pr view 1"}}'
  env -u GH_TOKEN -u CLAUDE_CODE_REMOTE "$@" bash "$root/.claude/hooks/gh-token-required.sh" <<<"$json" >"$work/tok.out" 2>"$work/tok.err"
  rc=$?
  if [ "$rc" -ne "$want" ]; then
    echo "FAIL: $label exited $rc, not $want"; fails=$((fails + 1)); return
  fi
  if [ "$want" -eq 2 ]; then
    if ! grep -q 'docs/runbooks/github-access.md' "$work/tok.err" || [ -s "$work/tok.out" ]; then
      echo "FAIL: $label did not name the runbook on stderr, or wrote stdout"; fails=$((fails + 1)); return
    fi
  elif [ -s "$work/tok.out" ] || [ -s "$work/tok.err" ]; then
    echo "FAIL: $label printed output on a pass"; fails=$((fails + 1)); return
  fi
  echo "PASS: $label"
}
token_case "T1 gh hook refuses an unset token" 2
if grep -q 'step 4' "$work/tok.err"; then
  echo "FAIL: T1 names step 4"; fails=$((fails + 1))
else echo "PASS: T1 names no step 4"; fi
token_case "T2 gh hook refuses an empty token" 2 GH_TOKEN=
token_case "T3 gh hook refuses a classic token" 2 GH_TOKEN=ghp_tyre473classic
if grep -q 'ghp_tyre473classic' "$work/tok.err"; then
  echo "FAIL: T3 echoed the token's value"; fails=$((fails + 1))
else echo "PASS: T3 never echoes the token's value"; fi
token_case "T4 gh hook passes a github_pat_ token" 0 GH_TOKEN=github_pat_tyre473test
token_case "T5 gh hook passes a cloud session with no token" 0 CLAUDE_CODE_REMOTE=true
token_case "T6 gh hook passes a cloud session whatever the token" 0 CLAUDE_CODE_REMOTE=true GH_TOKEN=ghp_tyre481classic
token_case "T7 gh hook refuses an empty CLAUDE_CODE_REMOTE" 2 CLAUDE_CODE_REMOTE=
token_case "T8 gh hook refuses CLAUDE_CODE_REMOTE=false" 2 CLAUDE_CODE_REMOTE=false
token_case "T9 gh hook refuses CLAUDE_CODE_REMOTE=1" 2 CLAUDE_CODE_REMOTE=1

# Real pushes to a bare remote through .githooks/pre-push, installed the way
# make hooks-install installs it (TYRE-473). The hook judges the remote ref git
# resolves, so no spelling of the command matters.
unset TYRE_PROMOTE
mkdir -p "$work/home"
export HOME="$work/home" XDG_CONFIG_HOME="$work/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
push_cases=0
remote="$work/push/remote.git"
prepo="$work/push/repo"
mkdir -p "$work/push"
git init -q --bare -b develop "$remote"
git init -q -b develop "$prepo"
mkdir -p "$prepo/.githooks"
cp "$root/.githooks/pre-push" "$prepo/.githooks/pre-push" 2>/dev/null
(
  cd "$prepo" || exit 1
  git add --chmod=+x .githooks/pre-push
  git commit -q -m A
  git remote add origin "$remote"
  git push -q origin develop develop:main
  git config core.hooksPath .githooks
  git commit -q --allow-empty -m B
  git switch -q -c TYRE-1-feature
  git commit -q --allow-empty -m F
) >/dev/null 2>&1
cd "$prepo" || exit 1

remote_ref() { git -C "$remote" rev-parse -q --verify "$1" 2>/dev/null; }
snapshot() { git -C "$remote" for-each-ref --format='%(refname) %(objectname)'; }
push_fail() { echo "FAIL: $1 ($2)"; fails=$((fails + 1)); }
push_out=""
push_rc=0
run_push() { push_out=$("$@" 2>&1); push_rc=$?; }

# refused <label> <dest branch> <local rev | delete> <cmd...>
refused() {
  local label=$1 dest=$2 rev=$3 before after
  shift 3
  push_cases=$((push_cases + 1))
  if [ "$rev" = delete ]; then
    [ -n "$(remote_ref "refs/heads/$dest")" ] || { push_fail "$label" "vacuous: refs/heads/$dest is not on the remote"; return; }
  else
    [ "$(git rev-parse "$rev")" != "$(remote_ref "refs/heads/$dest")" ] || { push_fail "$label" "vacuous: remote $dest already at $rev"; return; }
  fi
  before=$(snapshot)
  run_push "$@"
  after=$(snapshot)
  if [ "$push_rc" -eq 0 ]; then push_fail "$label" "exit 0"; return; fi
  case "$push_out" in *"pre-push: refused"*) ;; *) push_fail "$label" "no 'pre-push: refused' in output: $push_out"; return ;; esac
  if [ "$before" != "$after" ]; then push_fail "$label" "the remote moved"; return; fi
  echo "PASS: refused $label"
}
# refused_delete <label> <dest branch> <cmd...>
refused_delete() {
  local label=$1 dest=$2
  shift 2
  refused "$label" "$dest" delete "$@"
  case "$push_out" in *"delete refs/heads/$dest"*) ;; *) push_fail "$label" "refusal lacks 'delete refs/heads/$dest'" ;; esac
}
# pushed <label> <full remote ref> <want object | absent> <cmd...>
pushed() {
  local label=$1 ref=$2 want=$3 dm dn
  shift 3
  push_cases=$((push_cases + 1))
  [ "$want" = absent ] && want=""
  [ "$(remote_ref "$ref")" != "$want" ] || { push_fail "$label" "vacuous: $ref already at the wanted value"; return; }
  dm=$(remote_ref refs/heads/develop)
  dn=$(remote_ref refs/heads/main)
  run_push "$@"
  if [ "$push_rc" -ne 0 ]; then push_fail "$label" "exit $push_rc: $push_out"; return; fi
  case "$push_out" in *"pre-push: refused"*) push_fail "$label" "refused"; return ;; esac
  if [ "$(remote_ref "$ref")" != "$want" ]; then push_fail "$label" "$ref is not at the wanted value"; return; fi
  if [ "$ref" != refs/heads/develop ] && [ "$(remote_ref refs/heads/develop)" != "$dm" ]; then push_fail "$label" "develop moved"; return; fi
  if [ "$ref" != refs/heads/main ] && [ "$(remote_ref refs/heads/main)" != "$dn" ]; then push_fail "$label" "main moved"; return; fi
  echo "PASS: pushed $label"
}
# noop <label> <cmd...>
noop() {
  local label=$1 before after
  shift
  push_cases=$((push_cases + 1))
  before=$(snapshot)
  run_push "$@"
  after=$(snapshot)
  if [ "$push_rc" -eq 0 ] && [ "$before" = "$after" ]; then echo "PASS: noop $label"; else
    push_fail "$label" "exit $push_rc: $push_out"; fi
}
commit() { git commit -q --allow-empty -m "$1"; }

F=$(git rev-parse TYRE-1-feature)
B=$(git rev-parse develop)
pushed P1 refs/heads/TYRE-1-feature "$F" git push -q -u origin TYRE-1-feature
commit p2
F=$(git rev-parse HEAD)
pushed P2 refs/heads/TYRE-1-feature "$F" git push -q
commit p3
F=$(git rev-parse HEAD)
pushed P3 refs/heads/TYRE-1-feature "$F" git push -q origin HEAD
refused R4 develop develop git push -q origin develop
refused R5 main HEAD git push -q origin HEAD:main
refused R6 main "$B" git push -q origin "$B:refs/heads/main"
refused R7 develop TYRE-1-feature git push -q origin +TYRE-1-feature:develop
refused R8 develop delete git push -q origin :develop
refused R9 develop develop git push -q --all origin
refused R10 develop develop git push -q --mirror origin
refused R11 develop develop git push -q origin 'refs/heads/*:refs/heads/*'
refused R12 develop develop git push -q origin :
commit r13
refused R13 develop develop git push -q origin TYRE-1-feature develop
F=$(git rev-parse TYRE-1-feature)
pushed P14 refs/heads/develop-notes "$F" git push -q origin TYRE-1-feature:develop-notes
pushed P15 refs/heads/TYRE-9-main "$F" git push -q origin TYRE-1-feature:TYRE-9-main
pushed P16 refs/heads/TYRE-9-main absent git push -q origin :TYRE-9-main
git switch -q develop
refused R18 develop develop git push -q -u origin "$(git branch --show-current)"
refused R19 develop HEAD git push -q -u origin HEAD
refused R20 develop HEAD bash -c 'cd "$1" && git -C "$2" push -q origin HEAD' _ "$work" "$prepo"
refused R21 develop develop bash -c 'b=develop; git push -q origin "$b"'
refused R22 develop develop sh -c 'git push -q origin develop'
refused R23 develop develop bash -c 'eval "git push -q origin develop"'
refused R24 develop develop git push -q "$remote" develop
pushed P25 refs/heads/TYRE-9-from-develop "$B" git push -q origin HEAD:refs/heads/TYRE-9-from-develop
git switch -q -c TYRE-2-tracks
commit r26
git config branch.TYRE-2-tracks.remote origin
git config branch.TYRE-2-tracks.merge refs/heads/develop
git config push.default upstream
refused R26 develop TYRE-2-tracks git push -q
git config --unset push.default
git worktree add -q "$work/push/wt" -b TYRE-3-wt develop
git -C "$work/push/wt" commit -q --allow-empty -m wt
W=$(git -C "$work/push/wt" rev-parse HEAD)
pushed P27 refs/heads/TYRE-3-wt "$W" git -C "$work/push/wt" push -q -u origin TYRE-3-wt
refused R28 main "$W" git -C "$work/push/wt" push -q origin HEAD:main
refused R29 develop develop env TYRE_PROMOTE=0 git push -q origin develop
refused R30 develop develop env TYRE_PROMOTE=true git push -q origin develop
refused R31 develop develop env TYRE_PROMOTE= git push -q origin develop
pushed P32 refs/heads/main "$B" env TYRE_PROMOTE=1 git push -q origin develop:main
refused_delete D34 main env TYRE_PROMOTE=1 git push -q origin :main
refused_delete D35 develop env TYRE_PROMOTE=1 git push -q origin :develop
pushed P17 refs/tags/main "$F" git push -q origin TYRE-1-feature:refs/tags/main
noop N33 git push -q origin "$(remote_ref refs/heads/main):refs/heads/main"
if [ "$push_cases" -ne 35 ]; then push_fail "push cases" "ran $push_cases push cases, not 35"; fi

if [ "$fails" -ne 0 ]; then
  echo "$fails CASE(S) FAILED"
  exit 1
fi
echo "ALL HOOK CASES PASSED"
