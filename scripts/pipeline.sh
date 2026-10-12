#!/usr/bin/env bash
# Launches one ticket's pipeline (TYRE-412, ADR-0018).
set -euo pipefail
if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^TYRE-[0-9]+$ ]]; then
  echo "usage: make pipeline T=TYRE-<number>" >&2
  exit 2
fi
# Exported here, never in settings: every named subagent would be a teammate.
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
# Git Bash rewrites a leading / into a Windows path when it starts claude.exe.
MSYS2_ARG_CONV_EXCL='/pipeline ' exec claude "/pipeline $1"
