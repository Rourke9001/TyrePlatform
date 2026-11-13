#!/usr/bin/env bash
# Cases for scripts/guard-check.sh (TYRE-473). gh is a stub that answers the
# check's three reads and nothing else, so a wrong call fails the case; git is
# a pass-through that records the dry run's argv and environment, so the real
# git decides whether the push would sign in. A case passes on its exit code
# and on exactly the rows it expects to fail.
set -uo pipefail
# No stub or case ever sees the session's own token.
export GH_TOKEN=github_pat_TYRE473SENTINEL
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
real_git=$(command -v git)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home"
fails=0
cases=0

export HOME="$work/home" XDG_CONFIG_HOME="$work/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=guard GIT_AUTHOR_EMAIL=guard@example.test
export GIT_COMMITTER_NAME=guard GIT_COMMITTER_EMAIL=guard@example.test
unset TYRE_PROMOTE

if ! command -v jq >/dev/null 2>&1; then echo "FAIL: jq is needed to run the stub gh's --jq filter"; exit 1; fi

# gh answers only the three argv shapes the check uses. Any other call leaves
# a marker that fails the case. When the token holds the sentinel it is
# written to stderr, so a script that relayed gh's output would leak it.
cat >"$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
d=$STUB_DIR
r=repos/Rourke9001/TyrePlatform
case "${GH_TOKEN:-}" in *TYRE473SENTINEL*) echo "${GH_TOKEN:-}" >&2 ;; esac
bad() { echo "$*" >>"$d/bad-call"; exit 3; }
notfound() { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
unauthorized() { echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; }
emit() { if [ -e "$d/jq-crlf" ]; then sed $'s/$/\r/'; else cat; fi; }
if [ "$#" -eq 4 ] && [ "$1" = api ] && [ "$3" = --jq ]; then
  case "$2" in
    "$r/rules/branches/develop")
      [ "$4" = '[.[] | select(.type == "pull_request") | .ruleset_id] | unique | .[]' ] || bad "$*"
      [ -e "$d/rules.fail" ] && notfound
      [ -e "$d/rules.401" ] && unauthorized
      jq -r "$4" "$d/rules.json" | tr -d '\r' | emit
      exit 0 ;;
    "$r/rulesets/"*)
      id=${2#"$r/rulesets/"}
      case "$id" in '' | *[!0-9]*) bad "$*" ;; esac
      [ "$4" = '.current_user_can_bypass // "absent"' ] || bad "$*"
      [ -e "$d/ruleset-$id.fail" ] && notfound
      [ -e "$d/ruleset-$id.json" ] || bad "no fixture for ruleset $id: $*"
      jq -r "$4" "$d/ruleset-$id.json" | tr -d '\r' | emit
      exit 0 ;;
  esac
fi
if [ "$#" -eq 7 ] && [ "$1 $2 $3 $4 $5 $6" = "api -i -X PATCH $r/git/refs/heads/tyre-473-no-such-ref -f" ]; then
  case "${7#sha=}" in
    *[!0-9a-f]* | '') bad "$*" ;;
  esac
  [ "${#7}" -eq 44 ] || bad "$*"
  cat "$d/patch.out"
  echo "gh: $(cat "$d/patch.err")" >&2
  exit "$(cat "$d/patch.rc")"
fi
bad "$*"
EOF

# git records the dry run, then always runs the real git.
cat >"$work/bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "push --dry-run" ]; then
  echo "$*" >"$STUB_DIR/push-argv"
  echo "GIT_TERMINAL_PROMPT=${GIT_TERMINAL_PROMPT-unset} GCM_INTERACTIVE=${GCM_INTERACTIVE-unset} GIT_ASKPASS=${GIT_ASKPASS-unset} SSH_ASKPASS=${SSH_ASKPASS-unset}" >"$STUB_DIR/push-env"
fi
exec "$REAL_GIT" "$@"
EOF
chmod +x "$work/bin/gh" "$work/bin/git"
export STUB_DIR="$work" REAL_GIT="$real_git" PATH="$work/bin:$PATH"
for tool in gh git; do
  if [ "$(command -v "$tool")" != "$work/bin/$tool" ]; then
    echo "FAIL: command -v $tool is not the stub in $work/bin"; exit 1
  fi
done

# The owner's real layout: a global gh helper, which a repository's own
# reset and manager come after.
cat >"$HOME/.gitconfig" <<'EOF'
[credential "https://github.com"]
	helper =
	helper = !gh auth git-credential
EOF

git init -q --bare -b develop "$work/origin.git"
repo="$work/repo"
git init -q -b develop "$repo"
mkdir -p "$repo/.githooks"
cp "$root/.githooks/pre-push" "$repo/.githooks/pre-push"
(
  cd "$repo" || exit 1
  git add --chmod=+x .githooks/pre-push
  git commit -q -m init
  git remote add origin "$work/origin.git"
  git push -q origin develop
) >/dev/null 2>&1

cr=$'\r'
patch_403() {
  printf 'HTTP/2.0 403 Forbidden\nContent-Type: application/json; charset=utf-8\n\n{"message":"Resource not accessible by personal access token","status":"403"}\n' >"$work/patch.out"
  echo 'Resource not accessible by personal access token (HTTP 403)' >"$work/patch.err"
  echo 1 >"$work/patch.rc"
}

good() {
  git -C "$repo" config core.hooksPath .githooks
  git -C "$repo" update-index --chmod=+x .githooks/pre-push 2>/dev/null
  git -C "$repo" checkout -- .githooks/pre-push
  git -C "$repo" config --unset-all credential.https://github.com.helper 2>/dev/null
  git -C "$repo" config --add credential.https://github.com.helper ""
  git -C "$repo" config --add credential.https://github.com.helper manager
  git -C "$repo" remote set-url origin "$work/origin.git"
  echo '[{"type":"deletion","ruleset_source_type":"Repository","ruleset_source":"Rourke9001/TyrePlatform","ruleset_id":21929055},{"type":"pull_request","parameters":{"required_approving_review_count":0},"ruleset_source_type":"Repository","ruleset_source":"Rourke9001/TyrePlatform","ruleset_id":21929055}]' >"$work/rules.json"
  echo '{"id":21929055,"name":"Protect develop from deletion","enforcement":"active","bypass_actors":[],"current_user_can_bypass":"never"}' >"$work/ruleset-21929055.json"
  patch_403
  rm -f "$work/rules.fail" "$work/rules.401" "$work"/ruleset-*.fail "$work/ruleset-21929056.json" "$work/jq-crlf" \
    "$work/push-argv" "$work/push-env" "$work/bad-call"
  unset TYRE_PROMOTE
  export GH_TOKEN=github_pat_TYRE473SENTINEL
}

out=""
fail_case() { echo "FAIL: $1 ($2)"; if [ -n "$out" ]; then printf '%s\n' "$out" | sed 's/^/    /'; fi; fails=$((fails + 1)); }

# check_case <label> <want exit> <want fail row | -> [args...]
check_case() {
  local label=$1 want=$2 row=$3 rc problems="" nf n i line
  shift 3
  cases=$((cases + 1))
  out=$(cd "$repo" && bash "$here/guard-check.sh" "$@" 2>&1)
  rc=$?
  [ -e "$work/bad-call" ] && problems="$problems unexpected call: $(cat "$work/bad-call");"
  [ "$rc" -eq "$want" ] || problems="$problems exit $rc, not $want;"
  case "$out" in *TYRE473SENTINEL*) problems="$problems the output leaks the token;" ;; esac
  if [ "$row" != - ]; then
    nf=$(printf '%s\n' "$out" | grep -c '^FAIL ')
    [ "$nf" -eq 1 ] || problems="$problems $nf FAIL lines, not 1;"
    printf '%s\n' "$out" | grep -q "^FAIL row $row:" || problems="$problems no line starting 'FAIL row $row:';"
  elif [ "$rc" -eq 0 ]; then
    n=6
    [ "${1:-}" = --cloud ] && n=5
    nf=$(printf '%s\n' "$out" | grep -c '^FAIL ')
    [ "$nf" -eq 0 ] || problems="$problems a FAIL line on an exit 0;"
    [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -eq "$n" ] || problems="$problems not $n lines;"
    for i in $(seq 1 "$n"); do
      line=$(printf '%s\n' "$out" | sed -n "${i}p")
      case "$line" in "OK row $i:"*) ;; *) problems="$problems line $i is not 'OK row $i:';" ;; esac
    done
  fi
  if [ -n "$problems" ]; then fail_case "$label" "$problems"; return 1; fi
  echo "PASS: $label"
}
line_has() { printf '%s\n' "$out" | grep -q -- "$1"; }
extra() { fail_case "$1" "$2"; }
# Row 3's fix for a failed read: scripts/guard-check.sh, the comment above
# read_fix (TYRE-473).
row3_names_token_rows() {
  local l3
  l3=$(printf '%s\n' "$out" | grep '^FAIL row 3:')
  case "$l3" in
    *"Fix: docs/runbooks/github-access.md step 1") extra "$1" "row 3 sends a failed read to step 1 alone" ;;
    *"row 4 or 5"*) ;;
    *) extra "$1" "row 3 does not name rows 4 and 5" ;;
  esac
}
# Rows 3 and 5 when GitHub gives no answer: scripts/guard-check.sh, the
# comment in row 5's no-status-line branch (TYRE-473).
names_no_token_step() {
  local label=$1 l row
  shift
  for row in "$@"; do
    l=$(printf '%s\n' "$out" | grep "^FAIL row $row:")
    case "$l" in
      '') extra "$label" "no FAIL row $row line" ;;
      *"step 3"* | *"step 4"*) extra "$label" "row $row sends a missing answer to the token's step" ;;
    esac
  done
}
fail_rows() { printf '%s\n' "$out" | sed -n 's/^FAIL row \([0-9]\):.*/\1/p' | tr '\n' ' '; }

good
check_case "G1 every row passes on the owner's credential layout" 0 - &&
  { [ "$(cat "$work/push-argv" 2>/dev/null)" = "push --dry-run origin HEAD:refs/heads/tyre-473-guard-check" ] || extra G1 "dry run argv was '$(cat "$work/push-argv" 2>/dev/null)'"
    [ "$(cat "$work/push-env" 2>/dev/null)" = "GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS= SSH_ASKPASS=" ] || extra G1 "dry run env was '$(cat "$work/push-env" 2>/dev/null)'"; }
good
check_case "G2 --cloud runs five rows and no dry run" 0 - --cloud &&
  { [ ! -e "$work/push-argv" ] || extra G2 "the dry run ran in cloud mode"; }

good; git -C "$repo" config --unset core.hooksPath
check_case "H1 no hooksPath" 1 1
good; git -C "$repo" config core.hooksPath .git/hooks
check_case "H2 hooksPath elsewhere" 1 1
good; rm "$repo/.githooks/pre-push"
check_case "H3 hook file missing" 1 1
good; git -C "$repo" update-index --chmod=-x .githooks/pre-push
check_case "H4 hook committed without the executable bit" 1 1

good; export TYRE_PROMOTE=1
check_case "P1 TYRE_PROMOTE set to 1" 1 2
good; export TYRE_PROMOTE=
check_case "P2 TYRE_PROMOTE set but empty" 1 2

good; echo '[{"type":"deletion","ruleset_id":21929055}]' >"$work/rules.json"
check_case "R1 no pull_request rule" 1 3
good; echo '{"id":21929055,"current_user_can_bypass":"pull_requests_only"}' >"$work/ruleset-21929055.json"
check_case "R2 the token's user can bypass" 1 3
good; echo '{"id":21929055}' >"$work/ruleset-21929055.json"
check_case "R3 the ruleset lacks the field" 1 3
good; touch "$work/rules.fail"
check_case "R4 the rules read fails" 1 3 && row3_names_token_rows R4
good
echo '[{"type":"pull_request","ruleset_id":21929055},{"type":"pull_request","ruleset_id":21929056}]' >"$work/rules.json"
echo '{"id":21929055,"current_user_can_bypass":"always"}' >"$work/ruleset-21929055.json"
echo '{"id":21929056,"current_user_can_bypass":"never"}' >"$work/ruleset-21929056.json"
check_case "R5 a second pull_request ruleset that cannot be bypassed" 0 -
good; touch "$work/ruleset-21929055.fail"
check_case "R6 the ruleset read fails" 1 3 && row3_names_token_rows R6
good; touch "$work/jq-crlf"
check_case "R7 gh output ending in a CR" 0 -

good; unset GH_TOKEN
check_case "K1 no token" 1 4 && { line_has 'github-access.md step 3' || extra K1 "the fix does not name step 3"; }
good; export GH_TOKEN=
check_case "K2 empty token" 1 4
good; export GH_TOKEN=ghp_TYRE473SENTINEL
check_case "K3 classic token" 1 4
good; unset GH_TOKEN
check_case "K4 no token in the cloud" 1 4 --cloud && { line_has 'github-access.md step 4' || extra K4 "the fix does not name step 4"; }

set_patch() { printf '%s\n' "$1" >"$work/patch.out"; echo "$2" >"$work/patch.err"; echo "$3" >"$work/patch.rc"; }
good; set_patch 'HTTP/2.0 422 Unprocessable Entity' 'Validation Failed (HTTP 422)' 1
check_case "W1 a 422" 1 5
good; set_patch 'HTTP/2.0 401 Unauthorized' 'Bad credentials (HTTP 401)' 1
check_case "W2 a 401" 1 5 && { line_has 'step 6' || extra W2 "the fix does not name step 6"; }
good; set_patch 'HTTP/2.0 200 OK' '' 0
check_case "W3 a 200" 1 5
no_answer() { set_patch 'error connecting to api.github.com' 'dial tcp: lookup api.github.com' 1; }
good; no_answer
check_case "W4 no status line" 1 5 &&
  { names_no_token_step W4 5; line_has '^FAIL row 5:.*network' || extra W4 "row 5 does not name the network"; }
good; printf 'HTTP/1.1 403 Forbidden%s\n\n{"message":"Resource not accessible by personal access token"}\n' "$cr" >"$work/patch.out"
check_case "W5 a status line ending in a CR" 0 -
good
printf 'HTTP/2.0 403 Forbidden\n\n{"message":"Blocked by egress policy"}\n' >"$work/patch.out"
echo 'Blocked by egress policy (HTTP 403)' >"$work/patch.err"
check_case "W6 a proxy's 403" 1 5

good; touch "$work/rules.401"; set_patch 'HTTP/2.0 401 Unauthorized' 'Bad credentials (HTTP 401)' 1
check_case "R8 an expired token fails the rules read and the probe write" 1 - &&
  { { [ "$(printf '%s\n' "$out" | grep -c '^FAIL ')" -eq 2 ] && line_has '^FAIL row 3:' && line_has '^FAIL row 5:.*step 6'; } ||
      extra R8 "the FAIL lines are not rows 3 and 5 with step 6 on row 5"
    row3_names_token_rows R8; }

good; no_answer
check_case "W7 no status line in the cloud" 1 5 --cloud &&
  { names_no_token_step W7 5; line_has '^FAIL row 5:.*network' || extra W7 "row 5 does not name the network"; }
good; touch "$work/rules.fail"; no_answer
check_case "R9 no answer from GitHub fails the rules read and the probe write" 1 - &&
  { [ "$(fail_rows)" = "3 5 " ] || extra R9 "the FAIL rows are '$(fail_rows)', not 3 and 5"
    names_no_token_step R9 3 5
    row3_names_token_rows R9; }
good; touch "$work/rules.fail"; no_answer
check_case "R10 no answer from GitHub in the cloud" 1 - --cloud &&
  { [ "$(fail_rows)" = "3 5 " ] || extra R10 "the FAIL rows are '$(fail_rows)', not 3 and 5"
    names_no_token_step R10 3 5
    row3_names_token_rows R10; }
good; unset GH_TOKEN; touch "$work/rules.fail"; no_answer
check_case "K5 no token and no answer in the cloud" 1 - --cloud &&
  { [ "$(fail_rows)" = "3 4 5 " ] || extra K5 "the FAIL rows are '$(fail_rows)', not 3, 4 and 5"
    line_has '^FAIL row 4:.*step 4' || extra K5 "row 4 does not name step 4"
    line_has '^FAIL row 5:.*row 4 fails, the step it names' || extra K5 "row 5 does not send the owner to row 4's step"; }

good; git -C "$repo" config --unset-all credential.https://github.com.helper
check_case "C1 the gh helper is git's last" 1 6 && { [ ! -e "$work/push-argv" ] || extra C1 "the dry run ran with a failed helper check"; }
good; git -C "$repo" remote set-url origin "$work/missing.git"
check_case "C2 the dry run cannot push" 1 6
good; git -C "$repo" config --unset-all credential.https://github.com.helper; git -C "$repo" remote set-url origin "$work/missing.git"
check_case "C3 the cloud skips row 6" 0 - --cloud

good
check_case "U1 an unknown argument" 2 - --bogus && { line_has 'usage: make guard-check' || extra U1 "no usage line"; }

# The make contract: CLOUD=1, not --cloud.
mk_last() { make -s -n -C "$root" "$@" | tr -d '\r' | sed -E 's/[[:space:]]+$//' | tail -n 1; }
out=""
got=$(mk_last guard-check CLOUD=1)
case "$got" in *"guard-check.sh --cloud") echo "PASS: M1 make guard-check CLOUD=1 passes --cloud" ;; *) fail_case M1 "printed '$got'" ;; esac
got=$(mk_last guard-check)
case "$got" in *"--cloud"*) fail_case M2 "printed '$got'" ;; *"guard-check.sh") echo "PASS: M2 make guard-check passes no argument" ;; *) fail_case M2 "printed '$got'" ;; esac

if [ "$fails" -ne 0 ]; then
  echo "$fails GUARD CHECK CASE(S) FAILED"
  exit 1
fi
echo "ALL GUARD CHECK CASES PASSED"
