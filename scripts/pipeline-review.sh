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
[[ "$k" =~ ^([0-3]|gate|ci|owner-[1-9][0-9]*)$ ]] || refuse usage "review id '$k' is not 0 to 3, gate, ci or owner-<n>"
[ -d "$1" ] || refuse usage "state directory '$1' does not exist"
state=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
# The bound leaves a large branch several times the real-range spike's run and
# still ends a hang inside the hour (the spec, Left to the builder). The
# variable exists for the tests.
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
# The same backstop the launcher sets, so the child gets the spiked environment
# whoever calls this script (TYRE-476).
export CLAUDE_CODE_SUBAGENT_MODEL=opus
# The review runs on Opus alone (U205), and the project and user settings name
# a Fable advisor that the review's subagent inherits. This variable makes the
# child ignore any advisorModel (TYRE-476).
export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
rc=0
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

if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
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
# Sets col to the column of the first character of $2 that is not a space or
# tab, when $2 starts at column $1, and rest to the text from there. A tab runs
# to the next multiple of four (CommonMark 0.31.2, section 2.2).
indent() {
  local s=$2
  col=$1
  while :; do
    case $s in
    " "*) col=$((col + 1)) ;;
    $'\t'*) col=$(((col / 4 + 1) * 4)) ;;
    *) break ;;
    esac
    s=${s:1}
  done
  rest=$s
}
# One scan reads the code fences by CommonMark 0.31.2's rules for fences
# (section 4.5) inside block quotes, so a fence line inside another fence or
# indented as code opens nothing, and the count and the findings block are the
# same blocks. Every fence whose info string's first word is json, in any case,
# counts, and more than one leaves the findings count ambiguous, so the review
# fails (TYRE-476).
quote='^ {0,3}> ?(.*)$'
ticks='^(`{3,})([^`]*)$'
tildes='^(~{3,})(.*)$'
json='^[[:space:]]*[Jj][Ss][Oo][Nn]([[:space:]]|$)'
# The findings block must open with the form the prompt shows.
open='^```json[[:space:]]*$'
fch="" # the open fence's character, empty when no fence is open
flen=0
fq=0   # the block quote depth the open fence sits in
shut=""
take=0 # the open fence is the first json one, whose content is the block
strict=0
closed=0
block=""
n=0
while IFS= read -r raw; do
  line=$raw
  q=0
  # Inside a fence, a marker past the fence's own depth is content.
  while { [ -z "$fch" ] || [ "$q" -lt "$fq" ]; } && [[ "$line" =~ $quote ]]; do
    line=${BASH_REMATCH[1]}
    q=$((q + 1))
  done
  indent 0 "$line"
  if [ -n "$fch" ]; then
    if [ "$q" -lt "$fq" ]; then
      # The line ends the fence's block quote, and the fence with it.
      fch=""
      take=0
    elif [ "$col" -le 3 ] && [[ "$rest" =~ $shut ]]; then
      fch=""
      if [ "$take" -eq 1 ]; then closed=1; fi
      take=0
      continue
    else
      if [ "$take" -eq 1 ]; then block+="$line"$'\n'; fi
      continue
    fi
  fi
  [ "$col" -le 3 ] || continue
  if [[ "$rest" =~ $ticks ]] || [[ "$rest" =~ $tildes ]]; then
    fch=${rest:0:1}
    flen=${#BASH_REMATCH[1]}
    info=${BASH_REMATCH[2]}
    fq=$q
    shut="^[$fch]{$flen,}[[:space:]]*\$"
    if [[ "$info" =~ $json ]]; then
      n=$((n + 1))
      if [ "$n" -eq 1 ]; then
        take=1
        if [[ "$raw" =~ $open ]]; then strict=1; fi
      fi
    fi
  fi
done <<<"$text"
[ "$n" -le 1 ] || fail findings "the result holds $n fenced json blocks"
[ "$strict" -eq 1 ] && [ "$closed" -eq 1 ] || fail findings "no fenced json block in result"
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
