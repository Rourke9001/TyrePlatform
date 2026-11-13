#!/usr/bin/env bash
# Cases for .claude/hooks (TYRE-413). Every hook settings.json names must be
# executable in git, or Linux, where the cloud routines run, cannot run it.
# Then each merge-push-guard.sh case feeds the hook the JSON Claude Code sends
# before a Bash call, with cwd set to a real repository on the branch it needs.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
hook="$here/../.claude/hooks/merge-push-guard.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

repo() {
  local dir="$work/$1" branch=$2
  git init -q -b "$branch" "$dir"
  git -C "$dir" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
}
repo on-develop develop
repo on-main main
repo on-feature TYRE-1-feature
repo tracks-develop TYRE-2-tracks
git -C "$work/tracks-develop" config branch.TYRE-2-tracks.remote origin
git -C "$work/tracks-develop" config branch.TYRE-2-tracks.merge refs/heads/develop
git -C "$work/tracks-develop" config push.default upstream

# Runs the hook; sets rc and out.
run() {
  local cmd=$1 cwd=$2
  out=$(jq -n --arg c "$cmd" --arg d "$cwd" \
    '{hook_event_name: "PreToolUse", tool_name: "Bash", cwd: $d, tool_input: {command: $c}}' |
    HOME="${hook_home:-$HOME}" bash "$hook" 2>/dev/null)
  rc=$?
}

denied() {
  local label=$1 cmd=$2 cwd=${3:-$work/on-feature}
  run "$cmd" "$cwd"
  if [ "$rc" -eq 2 ]; then echo "PASS: denied $label"; else
    echo "FAIL: $label exited $rc, not 2"; fails=$((fails + 1)); fi
}

asked() {
  local label=$1 cmd=$2 cwd=${3:-$work/on-feature} decision
  run "$cmd" "$cwd"
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  if [ "$rc" -eq 0 ] && [ "$decision" = ask ]; then echo "PASS: asked $label"; else
    echo "FAIL: $label exited $rc with decision '${decision}', not ask"; fails=$((fails + 1)); fi
}

allowed() {
  local label=$1 cmd=$2 cwd=${3:-$work/on-feature}
  run "$cmd" "$cwd"
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then echo "PASS: allowed $label"; else
    echo "FAIL: $label exited $rc with output '$out'"; fails=$((fails + 1)); fi
}

root=$(cd "$here/.." && pwd)
while IFS= read -r path; do
  mode=$(git -C "$root" ls-files -s -- "$path" | cut -d" " -f1)
  if [ "$mode" = 100755 ]; then echo "PASS: $path is executable in git"; else
    echo "FAIL: $path is mode ${mode:-untracked} in git, not 100755"; fails=$((fails + 1)); fi
done < <(jq -r ".hooks[][].hooks[].command" "$root/.claude/settings.json" | tr -d "\r" | sed -E "s#^\"[$]CLAUDE_PROJECT_DIR\"/##"; echo .githooks/pre-push)

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

R=repos/Rourke9001/TyrePlatform

# A merge never runs from a session: the owner merges every PR (U123).
denied "gh pr merge" "gh pr merge 158 --rebase"
denied "gh pr merge after cd" "cd /tmp && gh pr merge 158"
denied "gh pr merge inside bash -c" "bash -c \"gh pr merge 158\""
denied "gh pr merge inside \$( )" "echo \$(gh pr merge 158)"
denied "a PUT to a PR's merge endpoint" "gh api -X PUT $R/pulls/158/merge"
denied "the merge endpoint, method last" "gh api /$R/pulls/158/merge -X PUT -f merge_method=rebase"
denied "the branch-merge endpoint" "gh api -X POST $R/merges -f base=develop -f head=TYRE-1-x"
denied "a graphql mergePullRequest" "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'"
denied "a graphql auto-merge" "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'"

# A push that lands on develop or main asks the owner first.
asked "a push naming develop" "git push origin develop"
asked "a push of HEAD to main" "git push origin HEAD:main"
asked "a push of a sha to refs/heads/main" "git push origin 0458eed:refs/heads/main"
asked "a forced refspec onto develop" "git push origin +TYRE-1-feature:develop"
asked "a delete of develop" "git push origin :develop"
asked "a push of every branch" "git push --all origin"
asked "a bare push on develop" "git push" "$work/on-develop"
asked "a push of HEAD on main" "git push -u origin HEAD" "$work/on-main"
asked "a push through -C onto develop" "git -C '$work/on-develop' push"
asked "a push after cd onto develop" "cd '$work/on-develop' && git push origin"
asked "a bare push whose upstream is develop" "git push" "$work/tracks-develop"
asked "a gh api write to develop's ref" "gh api -X PATCH $R/git/refs/heads/develop -f sha=abc"
if command -v cygpath >/dev/null 2>&1; then
  asked "a bare push on develop, Windows cwd" "git push" "$(cygpath -w "$work/on-develop")"
fi

# Everything else runs as it did.
allowed "a read of a PR" "gh api $R/pulls/158 --jq .merged"
allowed "a PR comment" "gh api -X POST $R/issues/158/comments -F body=@note.md"
allowed "a read of develop's ref" "gh api $R/git/refs/heads/develop"
allowed "gh pr view" "gh pr view 158"
allowed "a search that mentions gh pr merge" "rg -n \"gh pr merge\" .claude"
allowed "a push of a feature branch" "git push -u origin TYRE-1-feature"
allowed "a push of HEAD on a feature branch" "git push -u origin HEAD"
allowed "a bare push on a feature branch" "git push"
allowed "a branch whose name starts with develop" "git push origin develop-notes"
allowed "a push to a main-like name" "git push origin TYRE-9-main:TYRE-9-main"
allowed "a command with no git or gh" "make check > log 2>&1"

# Single quotes are literal to bash, so text in them is never run, unless a
# shell's -c reads it. Double quotes still run a backtick or $( ).
allowed "a mention in single quotes" "node -e 'const t = \"deny \`gh pr merge\` here\";'"
allowed "a commit message in single quotes" "git commit -m 'see \`gh pr merge 1\` and git push origin main'"
denied "a merge inside bash -c single quotes" "bash -c 'gh pr merge 158'"
denied "a backtick merge inside double quotes" "git commit -m \"see \`gh pr merge 1\`\""
denied "a \$( ) merge inside double quotes" "echo \"\$(gh pr merge 158)\""
denied "a quoted merge path" "gh api -X PUT 'repos/o/r/pulls/1/merge'"
asked "a push inside sh -c double quotes" "sh -c \"cd /tmp; git push origin develop\""

# A heredoc's body is data, such as a PR body or a doc, unless a shell reads it.
nl=$'\n'
allowed "a heredoc that mentions a merge and a push" \
  "gh pr create --body-file - <<'EOF'${nl}Run \`gh pr merge 12\` by hand.${nl}git push origin main${nl}EOF"
allowed "a here-string beside a heredoc-like word" "jq -r . <<<\"\$x\"${nl}echo ok"
denied "a heredoc fed to bash" "bash <<'EOF'${nl}gh pr merge 12${nl}EOF"
asked "a push after a heredoc ends" "cat > n.md <<'EOF'${nl}text${nl}EOF${nl}git push origin develop"

# Stage 5 of #162: forms a session writes in ordinary work (U167). Only a
# form built to evade a text guard is its accepted limit.
D=$work/on-develop
# A command starts after a keyword, a wrapper, or inside a flagged shell -c.
asked "a push after then" "if true; then git push origin develop; fi"
asked "a push after do" "for i in 1; do git push origin develop; done"
asked "a push after !" "! git push origin develop"
asked "a push after else" "if false; then :; else git push origin develop; fi"
asked "a push after env" "env GIT_TRACE=0 git push origin develop"
asked "a push after timeout" "timeout 60 git push origin develop"
asked "a push inside bash -ec" "bash -ec \"git push origin develop\""
asked "an unquoted echo of a push" "echo git push origin develop"
denied "a merge after then" "if true; then gh pr merge 1; fi"
denied "a merge inside braces" "{ gh pr merge 1; }"
denied "a merge after env" "env GH_DEBUG=0 gh pr merge 1"
denied "a merge inside bash -ec" "bash -ec \"gh pr merge 1\""
denied "a merge inside bash -x -c" "bash -x -c 'gh pr merge 158'"
denied "a merge inside /bin/bash -c" "/bin/bash -c 'gh pr merge 158'"
denied "a merge through xargs" "echo 158 | xargs gh pr merge"
denied "a merge through eval" "eval \"gh pr merge 1\""
# A newline in quotes is part of the string; a backslash-newline joins lines;
# a comment ends at the line's end, whatever quote it holds.
allowed "a multi-line commit message in single quotes" "git commit -m 'Fix the guard${nl}gh pr merge is refused now'"
allowed "a multi-line node script in single quotes" "node -e 'const x = 1;${nl}git push origin main'"
denied "a merge split by a line continuation" "gh pr \\${nl}  merge 158 --rebase"
denied "a merge path after a line continuation" "gh api -X PUT \\${nl}  $R/pulls/158/merge"
asked "a push split by a line continuation" "git push \\${nl}  origin develop"
asked "a push after a comment with an apostrophe" "# it's the docs push${nl}cd '$D' && git push origin"
denied "a merge after a comment with an apostrophe" "# don't wait${nl}echo hi; gh pr merge 1"
denied "a multi-line graphql merge" "gh api graphql -f query='mutation {${nl}  mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId }${nl}}'"
# A redirection is not a refspec.
asked "a bare push with 2>&1 on develop" "git push origin 2>&1" "$D"
asked "a bare push redirected to a file on develop" "git push origin > /tmp/x.log" "$D"
asked "a push to develop redirected with no space" "git push origin develop>/tmp/x.log"
asked "a push to develop inside quoted \$( )" "out=\"\$(git push origin develop)\""
# A PR number may be a variable, and the path may end in a slash.
denied "a merge path with \$n" "gh api -X PUT $R/pulls/\$n/merge"
denied "a merge path with \${PR}" "gh api -X PUT $R/pulls/\${PR}/merge"
denied "a merge path with a trailing slash" "gh api -X PUT $R/pulls/158/merge/"
# A heredoc's delimiter is a whole word, and << in quotes opens nothing.
asked "a push after a hyphenated heredoc" "cat > n.md <<'PR-BODY'${nl}text${nl}PR-BODY${nl}git push origin develop"
asked "a push after << in a commit message" "git commit -m \"x <<EOF\"${nl}git push origin develop"
# -X takes its value with no space, and ~ is the home directory.
asked "a ref delete with -XDELETE" "gh api -XDELETE $R/git/refs/heads/main"
hook_home=$work asked "a bare push after cd ~ onto develop" "cd ~/on-develop && git push"
# A mutation name in a heredoc body or another command is not a merge.
allowed "a comment body that names a mutation" "gh api -X POST $R/issues/1/comments -F body=@- <<'EOF'${nl}mergePullRequest is denied${nl}EOF"
allowed "a mutation name in a later echo" "gh api $R/pulls/1 && echo 'mergePullRequest'"
# U167: a contents-API write to develop or main asks the owner.
asked "a contents write to develop" "gh api -X PUT $R/contents/docs/x.md -f message=m -f content=Zg== -f branch=develop"
asked "a contents write to main, -F" "gh api -X PUT $R/contents/docs/x.md -F message=m -F content=Zg== -F branch=main"
asked "a contents delete on develop" "gh api -X DELETE $R/contents/docs/x.md -f message=m -f sha=abc --field branch=develop"
allowed "a contents write to a feature branch" "gh api -X PUT $R/contents/docs/x.md -f message=m -f content=Zg== -f branch=TYRE-1-x"
allowed "a contents read at develop" "gh api '$R/contents/docs/x.md?ref=develop'"

# Stage 5 of #162, round 2. A substitution is its own command, and the
# command around it stays whole; a directory the hook cannot resolve asks.
F=$work/on-feature
asked "a push with -C from a substitution" "git -C \"\$(git rev-parse --show-toplevel)\" push origin develop"
denied "a merge path with a substituted number" "gh api -X PUT \"$R/pulls/\$(gh pr view --json number -q .number)/merge\""
denied "a merge after a substitution and a hash" "x=\$(date)#y; gh pr merge 1"
asked "a bare push with -C from a substitution" "git -C \"\$(git rev-parse --show-toplevel)\" push"
asked "a bare push after cd to a variable" "cd \"\$dir\" && git push"
# U167, clarified (c14119): a contents write asks unless it names another branch.
asked "a contents write with no branch" "gh api -X PUT $R/contents/docs/x.md -f message=m -f content=Zg=="
asked "a contents write to 'develop'" "gh api -X PUT $R/contents/docs/x.md -f message=m -f content=Zg== -f branch='develop'"
asked "a contents write to \"develop\"" "gh api -X PUT $R/contents/docs/x.md -f message=m -f content=Zg== -f branch=\"develop\""
# A heredoc a shell reads after a pipe, or with arguments, is code; a graphql
# query read from a heredoc is part of the call.
denied "a heredoc piped to bash" "cat <<'EOF' | bash${nl}gh pr merge 12${nl}EOF"
denied "a heredoc piped to sh" "cat <<EOF | sh${nl}gh pr merge 12${nl}EOF"
denied "a heredoc read by bash -s with arguments" "bash -s -- x <<EOF${nl}gh pr merge 12${nl}EOF"
denied "a graphql merge from a heredoc" "gh api graphql -F query=@- <<'EOF'${nl}mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }${nl}EOF"
# A shell's -c after long options, and a -c script joined by '\''.
denied "a merge inside bash -o pipefail -c" "bash -o pipefail -c 'gh pr merge 1'"
denied "a merge inside bash --norc -c" "bash --norc -c 'gh pr merge 1'"
denied "a merge after the '\\'' idiom" "bash -c 'echo '\\''x'\\''; gh pr merge 1'"
# cd anywhere in a command, its first word only, and scoped to its subshell.
asked "a bare push after then cd" "if true; then cd '$D' && git push; fi"
asked "a bare push after { cd" "{ cd '$D'; git push; }"
asked "a bare push after cd with 2>/dev/null" "cd '$D' 2>/dev/null && git push"
asked "a bare push after a subshell's cd" "(cd '$F' && ls); git push" "$D"
asked "a bare push after a substitution's cd" "root=\$(cd '$F' && pwd); git push" "$D"
asked "a bare push after any cd in a subshell" "(cd '$D' && ls); git push"
# gh takes -R or --repo before its subcommand.
denied "gh -R pr merge" "gh -R o/r pr merge 1"
denied "gh --repo pr merge" "gh --repo o/r pr merge 1"
denied "gh --repo= pr merge" "gh --repo=o/r pr merge 1"

# Round 3: a body the hook does not decode (a shell's -c, eval, a heredoc a
# shell reads) is refused when it holds a merge and asks when it names a push
# or merge; after a cd it cannot follow, a bare push asks.
asked "a push inside bash -euo pipefail -c" "bash -euo pipefail -c 'git push origin develop'"
denied "a merge inside bash -euo pipefail -c" "bash -euo pipefail -c 'gh pr merge 1'"
denied "a merge inside bash -O extglob -c" "bash -O extglob -c 'gh pr merge 1'"
denied "a merge inside bash --rcfile -c" "bash --rcfile /dev/null -c 'gh pr merge 1'"
denied "a merge after '\\'' inside double quotes" "bash -c 'echo \"it'\\''s\"; gh pr merge 1'"
denied "a merge after '\\'' inside \$( )" "bash -c 'x=\$(echo '\\''a'\\''); gh pr merge 1'"
allowed "a test run then a commit heredoc" "bash scripts/hooks.test.sh && git commit -q -F - <<'EOF'${nl}gh pr merge is refused now.${nl}EOF"
allowed "a test run then a PR body heredoc" "bash scripts/hooks.test.sh > /tmp/h.log 2>&1 && gh pr create --base develop --title x --body-file - <<'EOF'${nl}The guard refuses gh pr merge, and it's tested.${nl}EOF"
allowed "a commit heredoc then a test run" "git commit -q -F - <<'EOF' && bash scripts/hooks.test.sh${nl}gh pr merge is refused${nl}EOF"
denied "a graphql merge from a heredoc piped to jq" "gh api graphql -F query=@- <<'Q' | jq .${nl}mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }${nl}Q"
denied "a graphql merge from a heredoc then echo" "gh api graphql -F query=@- <<'Q' && echo ok${nl}mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }${nl}Q"
denied "gh pr -R merge" "gh pr -R o/r merge 1"
denied "gh -R with no space" "gh -Ro/r pr merge 1"
asked "a bare push after eval cd" "eval \"cd '$D'\"; git push"
asked "a bare push after eval cd and &&" "eval \"cd '$D'\" && git push"
asked "a sibling subshell push after a subshell cd" "(cd '$F' && ls); (git push)" "$D"
asked "a subshell push after a subshell cd" "(cd '$F') && (git push)" "$D"
asked "a substitution push after a substitution cd" "echo \$(cd '$F')\$(git push)" "$D"
asked "a bare push after pushd" "pushd '$D' && git push"
asked "a bare push after builtin cd" "builtin cd '$D' && git push"

# Commands a working session ran on 3 Nov, from a feature branch. Each must
# pass, so a change that refuses ordinary work shows red.
allowed "session: push a feature branch and log" "git push -q -u origin TYRE-321-dr-scope-u166 && git log --oneline -1"
allowed "session: read a PR body through a pipe" "gh pr view 158 --json body -q .body | rg -n \"Re-review|830a299\" | cut -c1-160"
allowed "session: a commit heredoc then a push" "git commit -q -F - <<'EOF'${nl}fix(claude): TYRE-413 deny gh pr merge${nl}${nl}gh pr merge is refused, and git push origin main asks.${nl}EOF${nl}git push -q origin TYRE-413-merge-push-guard 2>&1 | rg -v \"^remote:\"; git log --oneline -1"
allowed "session: a PR body heredoc" "gh pr create --base develop --head TYRE-1-x --title \"docs: x\" --body-file - <<'EOF'${nl}Run \`gh api -X PUT $R/pulls/1/merge\` never.${nl}EOF"
allowed "session: list open PRs" "gh api '$R/pulls?state=open&per_page=100' --jq '.[].title'"
allowed "session: a comment from a file" "gh api -X POST $R/issues/158/comments -F body=@note.md"
allowed "session: switch to a new branch" "cd '$F' && git fetch -q origin && git switch -q -c TYRE-9-x origin/develop"
allowed "session: develop's runs" "gh run list --branch develop --limit 2 --json status -q '.[] | .status'"
allowed "session: push HEAD to a named feature ref" "git push -q origin HEAD:refs/heads/TYRE-443-tread-comment-audit"
allowed "session: node -e naming the merge" "node -e 'const s = \"deny \`gh pr merge\` (owner)\"; console.log(s)' \"\$MD\""
allowed "session: a gh pr checks loop" "for n in 160 161; do gh pr checks \$n 2>&1 | head -3; done"

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
