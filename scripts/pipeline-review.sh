#!/usr/bin/env bash
# Runs the review loop's code review as its own Opus process and passes it only
# when every check below holds (TYRE-476, U205, ADR-0023).
# usage: bash scripts/pipeline-review.sh <state dir> <review id>
# Prints one REVIEW: line and nothing else; the caller gates on the exit code
# (0 passed, 1 a check failed, 2 refused before claude ran) and that line.
set -euo pipefail

refuse() {
  echo "REVIEW: failed, $1: $2"
  exit 2
}
fail() {
  echo "REVIEW: failed, $1: $2"
  exit 1
}

[ "$#" -eq 2 ] || refuse usage "bash scripts/pipeline-review.sh <state dir> <review id>"
k=$2
# The id names files, so nothing else may pass.
[[ "$k" =~ ^([0-3]|gate|ci|minor|owner-[1-9][0-9]*)$ ]] || refuse usage "review id '$k' is not 0 to 3, gate, ci, minor or owner-<n>"
[ -d "$1" ] || refuse usage "state directory '$1' does not exist"
state=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
# The bound leaves a large branch room to finish and still ends a hang inside
# the hour (docs/superpowers/specs/2026-11-10-pipeline-model-per-step-design.md,
# Left to the builder). The variable exists for the tests.
bound=${PIPELINE_REVIEW_TIMEOUT:-2700}
[[ "$bound" =~ ^[1-9][0-9]*$ ]] || refuse usage "PIPELINE_REVIEW_TIMEOUT '$bound' is not a number of seconds"
command -v jq >/dev/null 2>&1 || refuse setup "jq is not on PATH"

trap 'echo "REVIEW: failed, internal: line $LINENO"; exit 1' ERR

out=$state/code-review-$k.json
err=$state/code-review-$k.err
md=$state/code-review-$k.md
# A review id runs again after a failure or a wrong-diff rerun, and an earlier
# result must never stand for this one (TYRE-476).
rm -f "$md"
cd "$here/.."

# The flag makes every named subagent a teammate (scripts/pipeline.sh), and the
# review needs none (TYRE-476).
unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
# The backstop the launcher sets (scripts/pipeline.sh), set here too so it
# holds whoever calls this script (TYRE-476).
export CLAUDE_CODE_SUBAGENT_MODEL=opus
# The review runs on Opus alone (U205), and the project and user settings name
# a Fable advisor that the review's subagent inherits. This variable makes the
# child ignore any advisorModel (TYRE-476).
export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
rc=0
start=$SECONDS
# --max-findings default: the skill keeps the last value typed, so a cap set in
# another session would limit every review unseen (TYRE-476).
# </dev/null: print mode reads a piped stdin, and the CLI's own warning says to
# redirect it from /dev/null when nothing is piped, so the review never depends
# on the caller's stdin (TYRE-476).
# The path exclusion is the one scripts/pipeline.sh sets, for the reason given
# there.
MSYS2_ARG_CONV_EXCL='/code-review' timeout -k 60 "$bound" \
  claude -p --model opus --output-format json "/code-review high --max-findings default" \
  >"$out" 2>"$err" </dev/null || rc=$?

# jq on Windows ends each line with a CR (docs/lessons.md, 2026-11-03), so every
# value read through it is stripped before use.
one_object() { jq -se 'length == 1 and (.[0] | type) == "object"' "$out" >/dev/null 2>&1; }
status_detail() {
  local v
  v=$(jq -r '"type \(.type), subtype \(.subtype), is_error \(.is_error), result \(
    if (.result | type) == "string" and .result != "" then (.result | split("\n")[0]) else "none" end)"' \
    "$out" 2>/dev/null) || v="unreadable"
  echo "${v//$'\r'/}"
}

# timeout exits 124, or 137 once its kill follows, and a child that ends by
# itself or is killed from outside can give either, so only a run that lasted
# the bound is a timeout (TYRE-476).
if { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; } && [ $((SECONDS - start)) -ge "$bound" ]; then
  fail timeout "no result within $bound s"
fi
if [ "$rc" -ne 0 ]; then
  detail="claude exited $rc, stderr in $err"
  if one_object; then detail="$detail; $(status_detail)"; fi
  fail exit "$detail"
fi
if ! one_object; then
  bytes=$(wc -c <"$out")
  fail json "stdout is not one JSON object, ${bytes//[[:space:]]/} bytes in $out"
fi
if ! jq -e '.type == "result" and .subtype == "success" and .is_error == false' "$out" >/dev/null 2>&1; then
  fail status "$(status_detail)"
fi
if ! jq -e '.permission_denials == []' "$out" >/dev/null 2>&1; then
  v=$(jq -r 'if (.permission_denials | type) == "array"
    then [.permission_denials[] | (.tool_name? // "unknown") | tostring] | join(", ")
    else (.permission_denials | tojson) end' "$out" 2>/dev/null) || v="unreadable"
  fail denials "${v//$'\r'/}"
fi
keys=$(jq -r 'if (.modelUsage | type) == "object" then (.modelUsage | keys | join(" ")) else "" end' "$out" 2>/dev/null) || keys=""
keys=${keys//$'\r'/}
if ! jq -e '(.modelUsage | type) == "object"
  and (.modelUsage | keys | any(startswith("claude-opus")))
  and (.modelUsage | keys | all(startswith("claude-opus") or startswith("claude-haiku")))' "$out" >/dev/null 2>&1; then
  fail model "modelUsage keys ${keys:-none}"
fi

# Claude Code does not document this shape, and a reply with no findings array
# must fail, never read as a clean review (TYRE-476).
text=$(jq -r 'if (.result | type) == "string" then .result else "" end' "$out" 2>/dev/null) || text=""
text=${text//$'\r'/}
# The findings block is the result's only fenced block, a ```json line at the
# margin to the next ``` line at the margin, so the script never decides which
# block holds the findings. Any other line that starts with a code fence marker
# after any indent, quote or list markers fails the review by its number
# (docs/superpowers/specs/2026-11-10-pipeline-model-per-step-design.md, What it
# checks).
# A space or a tab, written out, since a locale's blank class can hold a
# no-break space that the rule does not name.
open=$'^```json[ \t]*$'
shut=$'^```[ \t]*$'
mark=$'^([ \t>]|[-+*][ \t]|[0-9]{1,9}[.)][ \t])*(`{3,}|~{3,})'
marker="starts with a code fence marker after any indent, quote or list markers"
st=0 # 0 before the block, 1 inside it, 2 after it
ln=0
at=0
to=0
block=""
while IFS= read -r line; do
  ln=$((ln + 1))
  if [[ "$line" =~ $mark ]]; then
    if [ "$st" -eq 0 ] && [[ "$line" =~ $open ]]; then
      st=1
      at=$ln
      continue
    fi
    if [ "$st" -eq 1 ] && [[ "$line" =~ $shut ]]; then
      st=2
      to=$ln
      continue
    fi
    [ "$st" -ne 0 ] || fail findings "line $ln of the result $marker, and is not a \`\`\`json line at the margin"
    [ "$st" -ne 1 ] || fail findings "line $ln of the result $marker, and is not a \`\`\` line at the margin to close the \`\`\`json block that opens at line $at"
    fail findings "line $ln of the result $marker, and follows the \`\`\`json block at lines $at to $to"
  fi
  if [ "$st" -eq 1 ]; then block+="$line"$'\n'; fi
done <<<"$text"
[ "$st" -ne 0 ] || fail findings "no line of the result is \`\`\`json at the margin"
[ "$st" -eq 2 ] || fail findings "no \`\`\` line at the margin closes the \`\`\`json block that opens at line $at"
jq -se 'length == 1 and (.[0] | type) == "array"' <<<"$block" >/dev/null 2>&1 ||
  fail findings "the fenced block is not a JSON array"
bad=$(jq -r 'to_entries | map(select(.value
  | (type != "object") or ((.file | type) != "string") or .file == "")) | .[0].key // empty' <<<"$block" 2>/dev/null) || bad=""
bad=${bad//$'\r'/}
[ -z "$bad" ] || fail findings "element $bad has no file"
count=$(jq -r 'length' <<<"$block" 2>/dev/null) || count=0
count=${count//$'\r'/}

printf '%s\n' "$text" >"$md"
echo "REVIEW: ok, $md, models $keys, findings $count"
