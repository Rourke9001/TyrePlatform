#!/usr/bin/env bash
# Launches one ticket's pipeline, or a small-fix bundle (TYRE-412, TYRE-470, ADR-0018).
set -euo pipefail
usage='usage: make pipeline T="TYRE-<number> [TYRE-<number> ...]"'
if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^TYRE-[1-9][0-9]*(\ TYRE-[1-9][0-9]*)*$ ]]; then
  echo "$usage" >&2
  exit 2
fi
# A repeated key would run the same ticket twice in one bundle.
read -ra keys <<<"$1"
if [ -n "$(printf '%s\n' "${keys[@]}" | sort | uniq -d)" ]; then
  echo "$usage" >&2
  exit 2
fi
# Exported here, never in settings: every named subagent would be a teammate.
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Git Bash rewrites a leading / into a Windows path when it starts claude.exe.
MSYS2_ARG_CONV_EXCL='/pipeline ' exec claude "/pipeline $1"
