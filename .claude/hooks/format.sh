#!/usr/bin/env bash
# Format the file that was just edited, so formatting never shows up in a diff
# as unrelated noise. Silent on success; failures are non-fatal.
set -uo pipefail
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[[ -z "$file" || ! -f "$file" ]] && exit 0
case "$file" in
  *.go)                 gofmt -w "$file" ;;
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css)
                        (cd "$CLAUDE_PROJECT_DIR/web" && npx --no-install prettier --write "$file") 2>/dev/null ;;
  *.py)                 ruff format "$file" 2>/dev/null ;;
esac
exit 0
