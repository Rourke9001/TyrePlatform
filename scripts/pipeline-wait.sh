#!/usr/bin/env bash
# The pipeline lead's bounded wait: a foreground pause between reads of the
# team listing, and the background timer that wakes it while it waits for a
# teammate's message (.claude/commands/pipeline.md, Teammates; TYRE-478).
# usage: make pipeline-wait S=<whole seconds, 1 to 600>
#
# 600 s is the Bash tool's limit for one call, and make's own start-up can
# carry a wait at the cap past it, so the playbook's foreground wait is 30 s
# (TYRE-478; close-out uses `timeout 540` for the same reason).
set -euo pipefail

usage="usage: make pipeline-wait S=<whole seconds, 1 to 600>"
# The pattern is tested before any arithmetic, so 08, +5 and a 20-digit value
# never reach the numeric comparison.
if [ "$#" -ne 1 ] || ! [[ "$1" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$1" -gt 600 ]; then
  echo "$usage" >&2
  exit 2
fi
# exec leaves no shell between make and sleep when TaskStop ends the timer.
exec sleep "$1"
