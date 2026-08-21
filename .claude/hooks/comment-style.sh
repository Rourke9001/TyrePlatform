#!/usr/bin/env bash
# Runs the deterministic comment check on the file that was just edited.
# Exit 2 is the mechanism that matters: it returns the findings to the model
# while the edit is still in hand, which is the only point where a style rule
# reliably changes what gets written (docs/comments.md, TYRE-22).
set -uo pipefail
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[[ -z "$file" || ! -f "$file" ]] && exit 0
# The standard binds this repo, not scratch files elsewhere on the machine.
[[ "${file//\\//}" == "${CLAUDE_PROJECT_DIR//\\//}"/* ]] || exit 0
command -v node >/dev/null 2>&1 || exit 0
if ! out=$(node "$CLAUDE_PROJECT_DIR/scripts/check-comment-style.mjs" "$file" 2>&1); then
  printf '%s\n' "$out" >&2
  exit 2
fi
exit 0
