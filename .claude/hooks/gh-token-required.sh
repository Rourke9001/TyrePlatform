#!/usr/bin/env bash
# A gh call without the restricted token runs on gh's stored login, which can
# merge and write branches. Claude Code runs this only for a Bash call it reads
# as gh ("if" in settings.json) and for one it cannot read; it reads no command
# text here (TYRE-473, docs/runbooks/github-access.md).
case "${GH_TOKEN:-}" in
  github_pat_*) exit 0 ;;
esac
echo "This session has no restricted GitHub token, so gh would run on the full stored login. docs/runbooks/github-access.md step 3 installs it (step 4 in the cloud)." >&2
exit 2
