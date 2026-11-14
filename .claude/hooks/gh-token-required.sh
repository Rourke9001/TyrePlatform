#!/usr/bin/env bash
# A gh call in a local session without the restricted token runs on gh's stored
# login, which can merge and write branches. Claude Code runs this only for a
# Bash call it reads as gh ("if" in settings.json) and for one it cannot read;
# it reads no command text here (TYRE-473, docs/runbooks/github-access.md).
#
# Claude Code sets CLAUDE_CODE_REMOTE=true in a cloud session, where GitHub sees
# the cloud's own login whatever GH_TOKEN holds (TYRE-481,
# docs/runbooks/github-access.md step 4).
[ "${CLAUDE_CODE_REMOTE:-}" = true ] && exit 0
case "${GH_TOKEN:-}" in
  github_pat_*) exit 0 ;;
esac
echo "This session has no restricted GitHub token, so gh would run on the full stored login. docs/runbooks/github-access.md step 3 installs it." >&2
exit 2
