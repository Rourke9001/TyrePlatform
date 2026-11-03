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
done < <(jq -r ".hooks[][].hooks[].command" "$root/.claude/settings.json" | tr -d "\r" | sed -E "s#^\"[$]CLAUDE_PROJECT_DIR\"/##")

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

if [ "$fails" -ne 0 ]; then
  echo "$fails CASE(S) FAILED"
  exit 1
fi
echo "ALL HOOK CASES PASSED"
