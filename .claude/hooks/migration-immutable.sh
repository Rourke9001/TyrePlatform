#!/usr/bin/env bash
# golang-migrate records a version as applied and never re-runs it, so editing a
# migration that is already on develop changes what new databases build while
# every existing one keeps the old definition. The two diverge silently, and the
# Appendix E pins are cent-exact against the old one.
#
# The line is origin/develop, not HEAD: a migration authored on a feature branch
# has not been applied anywhere that matters and stays editable until it merges.
set -uo pipefail
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[[ -z "$file" ]] && exit 0

root="${CLAUDE_PROJECT_DIR:-}"
[[ -z "$root" ]] && exit 0
norm="${file//\\//}"
root="${root//\\//}"
[[ "$norm" == "$root"/* ]] || exit 0
rel="${norm#"$root"/}"
[[ "$rel" == db/migrations/* ]] || exit 0

# No network: the fetched ref is enough, and a stale ref errs towards allowing.
ref=origin/develop
git -C "$root" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref=HEAD
git -C "$root" cat-file -e "$ref:$rel" 2>/dev/null || exit 0

next=$(printf '%06d' "$(( 10#$(ls "$root"/db/migrations/*.up.sql 2>/dev/null | sed -E 's#.*/([0-9]+)_.*#\1#' | sort -n | tail -1) + 1 ))" 2>/dev/null)
cat >&2 <<EOF
Blocked: $rel is already on $ref, which means it has been applied. golang-migrate
will not re-run it, so this edit would only reach databases built from scratch.

Write a new migration instead. The next free number is ${next:-<check db/migrations>}.

If the intent is to reverse something, the down file of the migration that added
it is the place, and a new pair is how it reaches an existing database.
CLAUDE.md, Commands: never edit an applied migration.
EOF
exit 2
