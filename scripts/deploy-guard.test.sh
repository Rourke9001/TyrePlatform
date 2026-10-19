#!/usr/bin/env bash
# Cases for scripts/deploy-guard.sh (TYRE-397, TYRE-403). Ancestry is real
# git's answer on histories built here; only docker is stubbed. A case passes
# on its exact exit code, and a refusal also on its ::error:: line and its
# rule's text, so a missing script (127), a usage slip (2) or a set -e abort
# (128) fails here rather than passing as a refusal.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
guard="$here/deploy-guard.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/tags"

# No host config, hook or signing setting can change a result.
export HOME="$work/home" XDG_CONFIG_HOME="$work/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=guard GIT_AUTHOR_EMAIL=guard@example.test
export GIT_COMMITTER_NAME=guard GIT_COMMITTER_EMAIL=guard@example.test

# docker answers only the one read the guard makes. Any other call leaves a
# marker that fails the case, so a refusal caused by a wrong call never
# passes as the refusal a case expects.
cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
if ! { [ "$#" -eq 6 ] && [ "$1 $2 $3" = "buildx imagetools inspect" ] \
       && [ "$5" = --format ] && [ "$6" = '{{.Manifest.Digest}}' ]; }; then
  echo "unexpected docker call: $*" >>"$STUB_DIR/bad-call"; exit 3
fi
case "$4" in
  cr.example.test/tyre-api:*) tag=${4#cr.example.test/tyre-api:} ;;
  *) echo "docker read the wrong repository: $4" >>"$STUB_DIR/bad-call"; exit 3 ;;
esac
[ -f "$STUB_DIR/tags/$tag" ] || { echo "ERROR: $4: not found" >&2; exit 1; }
printf '%s' "$(cat "$STUB_DIR/tags/$tag")"
EOF
chmod +x "$work/bin/docker"
export STUB_DIR="$work" PATH="$work/bin:$PATH"

# c1 <- c2 <- c3 on develop; main starts at c2; x is a child of c2 that
# develop never has, standing for a commit authored on main.
git init -q --bare -b develop "$work/origin.git"
git init -q -b develop "$work/seed"
git -C "$work/seed" remote add origin "$work/origin.git"
commit() { git -C "$work/seed" commit -q --allow-empty -m "$1" && git -C "$work/seed" rev-parse HEAD; }
c1=$(commit c1)
c2=$(commit c2)
git -C "$work/seed" push -q origin HEAD:refs/heads/develop HEAD:refs/heads/main
c3=$(commit c3)
git -C "$work/seed" push -q origin HEAD:refs/heads/develop
git -C "$work/seed" checkout -q --detach "$c2"
x=$(commit x)
set_main() { git -C "$work/seed" push -q --force origin "$1:refs/heads/main"; }

git clone -q "$work/origin.git" "$work/full"

# A plain local path makes git ignore --depth, and under Git Bash a
# file:///tmp URL names a path native git cannot read.
p=$(cd "$work/origin.git" && { pwd -W 2>/dev/null || pwd; })
case "$p" in
  [A-Za-z]:*) url="file:///$p" ;;
  *) url="file://$p" ;;
esac
git clone -q --depth 1 "$url" "$work/shallow"
[ "$(git -C "$work/shallow" rev-parse --is-shallow-repository)" = true ] \
  || { echo "FAIL: setup: the shallow clone is not shallow, so its case would prove nothing"; exit 1; }

git clone -q "$work/origin.git" "$work/cut"
git -C "$work/cut" remote set-url origin "$work/missing.git"

fails=0

case_in() { # dir name want-exit fragment args...
  local dir=$1 name=$2 want=$3 frag=$4 out got why=""
  shift 4
  rm -f "$work/bad-call"
  out=$(cd "$dir" && bash "$guard" "$@" 2>&1)
  got=$?
  if [ -e "$work/bad-call" ]; then
    why=$(cat "$work/bad-call")
  elif [ "$got" -ne "$want" ]; then
    why="exit $got, wanted $want"
  elif [ "$want" -eq 1 ]; then
    [[ "$out" == *"::error::"* ]] || why="no ::error:: line"
    [[ "$out" == *"$frag"* ]] || why="${why:+$why; }no '$frag'"
  elif [ "$want" -eq 2 ]; then
    [[ "$out" == *"usage:"* ]] || why="no usage line"
  else
    [[ "$out" != *"::error::"* ]] || why="admitted with an ::error:: line"
  fi
  if [ -n "$why" ]; then
    echo "FAIL: $name ($why)"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok: $name"
  fi
}
case_run() { case_in "$work/full" "$@"; }

unknown=0123456789abcdef0123456789abcdef01234567
# Upper-case A to E only: in a locale that collates aAbB..., a [a-f] range
# admits these and refuses F, so a random SHA would catch the bug only
# sometimes.
upper=ABCDE01234ABCDE01234ABCDE01234ABCDE01234

# pairing
set_main "$c2"
case_run "staging deploys from develop" 0 - commit staging develop "$c3" 1
case_run "staging refuses main" 1 "deploys only from" commit staging main "$c2" 1
case_run "production refuses develop" 1 "deploys only from" commit prod develop "$c3" 1
case_run "an unknown target is refused" 1 "unknown target" commit qa develop "$c3" 1

# ancestry
case_run "production deploys a develop commit" 0 - commit prod main "$c2" 1
set_main "$x"
case_run "production refuses a commit authored on main" 1 "not an ancestor of origin/develop" commit prod main "$x" 1
case_run "production refuses a rollback dispatched from a commit authored on main" 1 "not an ancestor of origin/develop" commit prod main "$x" 1 "$c1"

# re-runs (TYRE-403)
set_main "$c2"
case_run "a re-run of a commit no longer at develop's head is refused" 1 TYRE-403 commit staging develop "$c2" 2
case_run "a first attempt of that same commit deploys" 0 - commit staging develop "$c2" 1
case_run "a re-run at the head deploys" 0 - commit staging develop "$c3" 2
case_run "a production re-run at main's head deploys" 0 - commit prod main "$c2" 2
set_main "$c3"
case_run "a production re-run behind main is refused" 1 TYRE-403 commit prod main "$c2" 2
case_run "a re-run of a rollback dispatch at main's head deploys" 0 - commit prod main "$c3" 2 "$c1"
case_run "a re-run of a rollback dispatch behind main is refused" 1 TYRE-403 commit prod main "$c2" 2 "$c1"

# rollback
set_main "$c3"
case_run "production rolls back to a commit on main" 0 - commit prod main "$c3" 1 "$c1"
set_main "$c2"
case_run "production refuses a rollback main never had" 1 "not an ancestor of origin/main" commit prod main "$c2" 1 "$c3"
case_run "production refuses a rollback to an unknown commit" 1 "not an ancestor of origin/main" commit prod main "$c2" 1 "$unknown"
case_run "a short rollback sha is refused" 1 "full 40-character lower-case commit SHA" commit staging develop "$c3" 1 "${c1:0:7}"
case_run "an upper-case rollback sha is refused" 1 "full 40-character lower-case commit SHA" commit staging develop "$c3" 1 "$upper"
case_run "staging rolls back to any well-formed commit" 0 - commit staging develop "$c3" 1 "$c1"

# the guard cannot see
set_main "$c2"
case_in "$work/shallow" "a shallow checkout is refused" 1 "fetch-depth: 0" commit staging develop "$c3" 1
case_in "$work/cut" "an unreachable origin is refused" 1 "cannot read origin" commit staging develop "$c3" 1
case_run "a missing argument is usage" 2 - commit staging develop "$c3"
case_run "no subcommand is usage" 2 -

# staging's record
img=$unknown
d1=sha256:$(printf 'a%.0s' $(seq 64))
d2=sha256:$(printf 'b%.0s' $(seq 64))
tags() { rm -f "$work/tags/"*; while [ "$#" -ge 2 ]; do printf '%s' "$2" >"$work/tags/$1"; shift 2; done; }
tags "$img" "$d1" "$img-staging-passed" "$d1"
case_run "an image with staging's matching record deploys" 0 - image cr.example.test "$img"
tags
case_run "an image with no tag is refused" 1 "is not in cr.example.test" image cr.example.test "$img"
tags "$img" "$d1"
case_run "a production rollback image with no staging record is refused" 1 "staging never passed" image cr.example.test "$img"
tags "$img" "$d1" "$img-staging-passed" "$d2"
case_run "a record whose digest differs from the tag's is refused" 1 "does not match staging's record" image cr.example.test "$img"
tags "$img" "" "$img-staging-passed" ""
case_run "an empty digest is refused" 1 "no digest" image cr.example.test "$img"
case_run "image usage" 2 - image cr.example.test

[ "$fails" -eq 0 ] || { echo "$fails deploy-guard case(s) failed"; exit 1; }
echo "deploy-guard: all cases pass"
