#!/usr/bin/env bash
# A gate piped into tail exits with tail's status, which is 0 whatever the gate
# did. PreToolUse is the only point where the pipe can still be removed: once
# the command has run, the transcript holds a green gate that never passed
# (docs/lessons.md, 2026-09-05; repeated 2026-09-15 with docker down).
set -uo pipefail
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[[ -z "$cmd" ]] && exit 0

# An explicit status guard means the pipe has already been accounted for.
case "$cmd" in
  *PIPESTATUS*|*pipefail*) exit 0 ;;
esac

gate='(^|[[:space:]])(make[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(check|lint|fmt|test|e2e|db-test|db-test-privileged)|npm[[:space:]]+(run[[:space:]]+)?(test|lint|typecheck)|go[[:space:]]+test)([[:space:]]|$)'

# Judge each segment alone, so "make check > log 2>&1; tail log" stays allowed:
# that redirects, it does not pipe, and the gate's own status still stands.
while IFS= read -r seg; do
  [[ "$seg" =~ $gate ]] || continue
  [[ "$seg" == *"|"* ]] || continue
  cat >&2 <<EOF
Blocked: this pipes a gate into another command, so the exit status you read
back belongs to that command and not to the gate. A failing gate reports 0.

  $seg

Run it unpiped and let its own status stand, or capture both:

  make check > "\$TMPDIR/check.log" 2>&1; echo "EXIT=\$?"   # then read the file
  set -o pipefail; make check | tail -40                    # status survives

docs/lessons.md, 2026-09-05. This hook exists because the written rule did not
hold on its own.
EOF
  exit 2
done <<< "$(printf '%s' "$cmd" | sed -E 's/\|\|/\n/g; s/&&/\n/g; s/;/\n/g')"

exit 0
