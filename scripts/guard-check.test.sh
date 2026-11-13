#!/usr/bin/env bash
# Cases for scripts/guard-check.sh (TYRE-473). gh is a stub that answers the
# check's three reads and nothing else, so a wrong call fails the case; git is
# a pass-through that records the dry run's argv and environment, so the real
# git decides whether the push would sign in. A case passes on its exit code
# and on exactly the rows it expects not to be OK, in order, each FAIL or
# UNCHECKED.
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
set_patch() { printf '%s\n' "$1" >"$work/patch.out"; echo "$2" >"$work/patch.err"; echo "$3" >"$work/patch.rc"; }
no_answer() { set_patch 'error connecting to api.github.com' 'dial tcp: lookup api.github.com' 1; }

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

# check_case <label> <want exit> <want rows | -> [args...]
# The rows are every line that is not OK, in order: F<n> for FAIL, U<n> for
# UNCHECKED. A FAIL line names its fix. An UNCHECKED line names none: it ends
# with the re-run, then the row's own step (scripts/guard-check.sh, the
# comment above unchecked).
check_case() {
  local label=$1 want=$2 rows=$3 rc problems="" got n i line r step token_step=3
  shift 3
  [ "${1:-}" = --cloud ] && token_step=4
  cases=$((cases + 1))
  out=$(cd "$repo" && bash "$here/guard-check.sh" "$@" 2>&1)
  rc=$?
  [ -e "$work/bad-call" ] && problems="$problems unexpected call: $(cat "$work/bad-call");"
  [ "$rc" -eq "$want" ] || problems="$problems exit $rc, not $want;"
  case "$out" in *TYRE473SENTINEL*) problems="$problems the output leaks the token;" ;; esac
  got=$(printf '%s\n' "$out" | sed -n 's/^FAIL row \([0-9]\):.*/F\1/p; s/^UNCHECKED row \([0-9]\):.*/U\1/p' | tr '\n' ' ')
  if [ "$rows" != - ]; then
    [ "$got" = "$rows " ] || problems="$problems rows '$got', not '$rows';"
  elif [ "$rc" -eq 0 ]; then
    n=6
    [ "${1:-}" = --cloud ] && n=5
    [ -z "$got" ] || problems="$problems rows '$got' on an exit 0;"
    [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -eq "$n" ] || problems="$problems not $n lines;"
    for i in $(seq 1 "$n"); do
      line=$(printf '%s\n' "$out" | sed -n "${i}p")
      case "$line" in "OK row $i:"*) ;; *) problems="$problems line $i is not 'OK row $i:';" ;; esac
    done
  fi
  while IFS= read -r line; do
    case "$line" in
      "FAIL row "[1-6]": "?*". Fix: "?*) ;;
      "FAIL "*) problems="$problems a FAIL line names no fix;" ;;
      "UNCHECKED row "*)
        r=${line#UNCHECKED row }
        r=${r%%:*}
        case "$r" in
          3) step=1 ;;
          5) step=$token_step ;;
          6) step=2 ;;
          *) problems="$problems row $r cannot be UNCHECKED;"; continue ;;
        esac
        case "$line" in
          *"Fix:"*) problems="$problems UNCHECKED row $r names a fix;" ;;
          "UNCHECKED row $r: "?*". Run make guard-check again once any FAIL row is fixed; if row $r stays UNCHECKED, docs/runbooks/github-access.md step $step") ;;
          *) problems="$problems UNCHECKED row $r does not end with the re-run, then step $step;" ;;
        esac ;;
    esac
  done <<<"$out"
  if [ -n "$problems" ]; then fail_case "$label" "$problems"; return 1; fi
  echo "PASS: $label"
}
line_has() { printf '%s\n' "$out" | grep -q -- "$1"; }
extra() { fail_case "$1" "$2"; }

good
check_case "G1 every row passes on the owner's credential layout" 0 - &&
  { [ "$(cat "$work/push-argv" 2>/dev/null)" = "push --dry-run origin HEAD:refs/heads/tyre-473-guard-check" ] || extra G1 "dry run argv was '$(cat "$work/push-argv" 2>/dev/null)'"
    [ "$(cat "$work/push-env" 2>/dev/null)" = "GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS= SSH_ASKPASS=" ] || extra G1 "dry run env was '$(cat "$work/push-env" 2>/dev/null)'"; }
good
check_case "G2 --cloud runs five rows and no dry run" 0 - --cloud &&
  { [ ! -e "$work/push-argv" ] || extra G2 "the dry run ran in cloud mode"; }

good; git -C "$repo" config --unset core.hooksPath
check_case "H1 no hooksPath" 1 F1
good; git -C "$repo" config core.hooksPath .git/hooks
check_case "H2 hooksPath elsewhere" 1 F1
good; rm "$repo/.githooks/pre-push"
check_case "H3 hook file missing" 1 F1
good; git -C "$repo" update-index --chmod=-x .githooks/pre-push
check_case "H4 hook committed without the executable bit" 1 F1

good; export TYRE_PROMOTE=1
check_case "P1 TYRE_PROMOTE set to 1" 1 F2
good; export TYRE_PROMOTE=
check_case "P2 TYRE_PROMOTE set but empty" 1 F2

good; echo '[{"type":"deletion","ruleset_id":21929055}]' >"$work/rules.json"
check_case "R1 no pull_request rule" 1 F3 && { line_has '^FAIL row 3:.*step 1$' || extra R1 "the fix does not name step 1"; }
good; echo '{"id":21929055,"current_user_can_bypass":"pull_requests_only"}' >"$work/ruleset-21929055.json"
check_case "R2 the token's user can bypass" 1 F3 && { line_has '^FAIL row 3:.*step 1$' || extra R2 "the fix does not name step 1"; }
good; echo '{"id":21929055}' >"$work/ruleset-21929055.json"
check_case "R3 the ruleset lacks the field" 1 F3
good
echo '[{"type":"pull_request","ruleset_id":21929055},{"type":"pull_request","ruleset_id":21929056}]' >"$work/rules.json"
echo '{"id":21929055,"current_user_can_bypass":"always"}' >"$work/ruleset-21929055.json"
echo '{"id":21929056,"current_user_can_bypass":"never"}' >"$work/ruleset-21929056.json"
check_case "R5 a second pull_request ruleset that cannot be bypassed" 0 -
good; touch "$work/jq-crlf"
check_case "R7 gh output ending in a CR" 0 -

good; unset GH_TOKEN
check_case "K1 no token" 1 F4 && { line_has '^FAIL row 4:.*step 3$' || extra K1 "the fix does not name step 3"; }
good; export GH_TOKEN=
check_case "K2 empty token" 1 F4
good; export GH_TOKEN=ghp_TYRE473SENTINEL
check_case "K3 classic token" 1 F4
good; unset GH_TOKEN
check_case "K4 no token in the cloud" 1 F4 --cloud && { line_has '^FAIL row 4:.*step 4$' || extra K4 "the fix does not name step 4"; }

good; printf 'HTTP/1.1 403 Forbidden%s\n\n{"message":"Resource not accessible by personal access token"}\n' "$cr" >"$work/patch.out"
check_case "W5 a status line ending in a CR" 0 -

# Each case in this loop runs in both modes: row 5 names step 3 locally and
# step 4 in the cloud, and nothing else may change with the mode.
names_step() { line_has "^FAIL row $2:.*step $3\$" || extra "$1" "row $2 does not name step $3"; }
for mode in local cloud; do
  if [ "$mode" = cloud ]; then arg=--cloud tstep=4; else arg= tstep=3; fi
  # The endpoint's own answers come only past the token's permission check.
  good; set_patch 'HTTP/2.0 422 Unprocessable Entity' 'Validation Failed (HTTP 422)' 1
  check_case "W1 a 422, $mode" 1 F5 ${arg:+"$arg"} && names_step "W1 $mode" 5 "$tstep"
  good; set_patch 'HTTP/2.0 200 OK' '' 0
  check_case "W3 a 200 with gh exiting 0, $mode" 1 F5 ${arg:+"$arg"} && names_step "W3 $mode" 5 "$tstep"
  good; set_patch 'HTTP/2.0 409 Conflict' 'Conflict (HTTP 409)' 1
  check_case "W8 a 409, $mode" 1 F5 ${arg:+"$arg"} && names_step "W8 $mode" 5 "$tstep"
  good; set_patch 'HTTP/2.0 401 Unauthorized' 'Bad credentials (HTTP 401)' 1
  check_case "W2 a 401, $mode" 1 F5 ${arg:+"$arg"} && names_step "W2 $mode" 5 6
  good; touch "$work/rules.401"; set_patch 'HTTP/2.0 401 Unauthorized' 'Bad credentials (HTTP 401)' 1
  check_case "R8 an expired token fails the rules read and the probe write, $mode" 1 "U3 F5" ${arg:+"$arg"} && names_step "R8 $mode" 5 6

  # Every other answer says nothing about the control.
  good; no_answer
  check_case "W4 no status line, $mode" 1 U5 ${arg:+"$arg"}
  good; set_patch '' '' 0
  check_case "W9 empty output with gh exiting 0, $mode" 1 U5 ${arg:+"$arg"}
  good
  printf 'HTTP/2.0 403 Forbidden\n\n{"message":"Blocked by egress policy"}\n' >"$work/patch.out"
  echo 'Blocked by egress policy (HTTP 403)' >"$work/patch.err"
  check_case "W6 a 403 with another message, $mode" 1 U5 ${arg:+"$arg"}
  # The proxy's 403 for a repository not attached to the session: its message
  # starts with "GitHub access to" and contains "is not enabled for this
  # session" (code.claude.com/docs/en/cloud-environments).
  good
  printf 'HTTP/2.0 403 Forbidden\n\n{"message":"GitHub access to Rourke9001/TyrePlatform is not enabled for this session"}\n' >"$work/patch.out"
  echo 'GitHub access to Rourke9001/TyrePlatform is not enabled for this session (HTTP 403)' >"$work/patch.err"
  check_case "W10 the cloud proxy's 403, $mode" 1 U5 ${arg:+"$arg"}
  good
  printf 'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n{"message":"API rate limit exceeded for user ID 1."}\n' >"$work/patch.out"
  echo 'API rate limit exceeded for user ID 1. (HTTP 403)' >"$work/patch.err"
  check_case "W11 GitHub's 403 for a rate limit, $mode" 1 U5 ${arg:+"$arg"}
  for code in 404 407 429 500 502 503; do
    good; set_patch "HTTP/2.0 $code Status" "Status (HTTP $code)" 1
    check_case "W12 a $code, $mode" 1 U5 ${arg:+"$arg"}
  done
  good; touch "$work/rules.fail"
  check_case "R4 the rules read fails, $mode" 1 U3 ${arg:+"$arg"}
  good; touch "$work/ruleset-21929055.fail"
  check_case "R6 the ruleset read fails, $mode" 1 U3 ${arg:+"$arg"}
  good; touch "$work/rules.fail"; no_answer
  check_case "R9 no answer from GitHub on the rules read or the probe write, $mode" 1 "U3 U5" ${arg:+"$arg"}
  good; touch "$work/rules.fail"; set_patch 'HTTP/2.0 503 Service Unavailable' 'Service Unavailable (HTTP 503)' 1
  check_case "R10 a failed rules read and a 503 on the probe write, $mode" 1 "U3 U5" ${arg:+"$arg"}
done
good; unset GH_TOKEN; touch "$work/rules.fail"; no_answer
check_case "K5 no token and no answer in the cloud" 1 "U3 F4 U5" --cloud && names_step K5 4 4

good; git -C "$repo" config --unset-all credential.https://github.com.helper
check_case "C1 the gh helper is git's last" 1 F6 && { [ ! -e "$work/push-argv" ] || extra C1 "the dry run ran with a failed helper check"; }
good; git -C "$repo" remote set-url origin "$work/missing.git"
check_case "C2 the dry run cannot push" 1 F6 && names_step C2 6 2
good; git -C "$repo" config --unset-all credential.https://github.com.helper; git -C "$repo" remote set-url origin "$work/missing.git"
check_case "C3 the cloud skips row 6" 0 - --cloud
good; git -C "$repo" remote set-url origin "$work/missing.git"; touch "$work/ruleset-21929055.fail"
check_case "C4 the dry run cannot push after the rules read succeeded" 1 "U3 F6" && names_step C4 6 2
good; git -C "$repo" remote set-url origin "$work/missing.git"; touch "$work/rules.fail"; no_answer
check_case "C5 the dry run cannot push and GitHub gave no answer" 1 "U3 U5 U6"
good; git -C "$repo" remote set-url origin "$work/missing.git"; touch "$work/rules.401"; set_patch 'HTTP/2.0 401 Unauthorized' 'Bad credentials (HTTP 401)' 1
check_case "C6 an expired token and a dry run that cannot push" 1 "U3 F5 U6" && names_step C6 5 6
good; git -C "$repo" config --unset-all credential.https://github.com.helper; touch "$work/rules.fail"; no_answer
check_case "C7 the gh helper is git's last and GitHub gave no answer" 1 "U3 U5 F6" && names_step C7 6 2

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
