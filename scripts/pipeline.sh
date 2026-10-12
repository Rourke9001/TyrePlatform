#!/usr/bin/env bash
# Launches one ticket's pipeline (TYRE-412, ADR-0018). The agent-teams flag is
# exported for this process only: in a settings file it would turn every
# named subagent in every session into a teammate. Git Bash rewrites an
# argument starting with / into a Windows path when it starts claude.exe;
# the exclusion covers only arguments starting with "/pipeline ".
set -euo pipefail
if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^TYRE-[0-9]+$ ]]; then
  echo "usage: make pipeline T=TYRE-<number>" >&2
  exit 2
fi
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
MSYS2_ARG_CONV_EXCL='/pipeline ' exec claude "/pipeline $1"
