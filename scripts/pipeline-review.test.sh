#!/usr/bin/env bash
# Cases for scripts/pipeline-review.sh (TYRE-476). The stub claude prints a
# canned result, so these prove the checks and the child's launch shape. Only
# a live review proves "/code-review ..." reaches claude.exe intact on Windows.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/pipeline-review.sh"
root=$(cd "$here/.." && pwd)
work=$(cd "$(mktemp -d)" && pwd)
trap 'rm -rf "$work"' EXIT
# A checkout path can hold a space, so the state directory's does.
state="$work/state dir"
mkdir -p "$work/bin" "$state"

cat >"$work/bin/claude" <<'EOF'
#!/usr/bin/env bash
# Status 1 is an empty stdin at once; 0 would be the caller's input reaching it.
read -r -t 5 _
got=$?
printf '%s\n' "$#" "$@" "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS-unset}" \
  "${MSYS2_ARG_CONV_EXCL-unset}" "${CLAUDE_CODE_SUBAGENT_MODEL-unset}" \
  "${CLAUDE_CODE_DISABLE_ADVISOR_TOOL-unset}" "$PWD" "stdin $got" >"$STUB_DIR/called"
echo "stub stderr" >&2
# exec, so the time bound's signal reaches sleep and no orphan holds the
# temp directory open on Windows.
[ -z "${STUB_SLEEP:-}" ] || exec sleep "$STUB_SLEEP"
[ -z "${STUB_OUT:-}" ] || cat "$STUB_OUT"
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$work/bin/claude"

# The lead's session holds the agent-teams flag, and a caller may hold another
# backstop or leave the advisor tool on. The child gets none of them.
export STUB_DIR="$work" PATH="$work/bin:$PATH" CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_SUBAGENT_MODEL=haiku \
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL=0
unset MSYS2_ARG_CONV_EXCL
# A case that missed the stub would start a real review.
[ "$(command -v claude)" = "$work/bin/claude" ] || { echo "FAIL: the stub claude is not first on PATH"; exit 1; }
# The stub answers at once, so no case but the time bound's needs the default.
export PIPELINE_REVIEW_TIMEOUT=30
fails=0

fence='```'
two='[
  {"file": "scripts/a.sh", "line": 3, "summary": "runs `rm -rf` unguarded", "failure_scenario": "f1"},
  {"file": "scripts/b.sh", "line": 9, "summary": "s2", "failure_scenario": "f2"}
]'
# A result with a fenced json block, then prose.
fenced() { printf '%sjson\n%s\n%s\n\n%s' "$fence" "$1" "$fence" "$2"; }
r_two=$(fenced "$two" "Two findings in the range.")
jq -n --arg r "$r_two" '{type: "result", subtype: "success", is_error: false,
  permission_denials: [], modelUsage: {"claude-opus-5-5": {costUSD: 0.35}}, result: $r}' >"$work/base.json"
# Writes the canned stdout: the base result with one jq edit applied.
canned() { jq "$@" "$work/base.json" >"$work/out.json"; }

# Runs the script from $work with the state directory as a relative path and
# input on its stdin, and sets rc and last, the output's last line.
review() {
  local k=$1 out; shift
  rm -f "$work/called"
  out=$(cd "$work" && env STUB_OUT="$work/out.json" "$@" bash "$script" "state dir" "$k" <<<"caller input" 2>&1)
  rc=$?
  last=${out##*$'\n'}
  last=${last//$'\r'/}
}

passes() {
  local label=$1 k=$2 tail=$3; shift 3
  review "$k" "$@"
  if [ "$rc" -eq 0 ] && [ "$last" = "REVIEW: ok, $state/code-review-$k.md, $tail" ] &&
    [ -s "$state/code-review-$k.md" ]; then echo "PASS: $label"; else
    echo "FAIL: $label exited $rc: $last"; fails=$((fails + 1)); fi
}

failed() {
  local label=$1 k=$2 check=$3; shift 3
  review "$k" "$@"
  if [ "$rc" -eq 1 ] && [[ "$last" == "REVIEW: failed, $check: "* ]] &&
    [ ! -e "$state/code-review-$k.md" ]; then echo "PASS: $label"; else
    echo "FAIL: $label exited $rc: $last"; fails=$((fails + 1)); fi
}

# A refusal of the result's shape is pinned to the whole line, since the line
# number in it is what sends the lead to the reply.
refuses() {
  local label=$1 msg=$2
  review 0
  if [ "$rc" -eq 1 ] && [ "$last" = "REVIEW: failed, findings: $msg" ] &&
    [ ! -e "$state/code-review-0.md" ]; then echo "PASS: $label"; else
    echo "FAIL: $label exited $rc: $last"; fails=$((fails + 1)); fi
}
# The refusals of a line that starts with a code fence marker before, inside
# and after the block, and of a result with no block.
marker="starts with a code fence marker after any indent, quote or list markers"
before() { echo "line $1 of the result $marker, and is not a ${fence}json line at the margin"; }
inside() { echo "line $1 of the result $marker, and is not a $fence line at the margin to close the ${fence}json block that opens at line $2"; }
after() { echo "line $1 of the result $marker, and follows the ${fence}json block at lines $2 to $3"; }
none="no line of the result is ${fence}json at the margin"
# The findings array fenced at the margin, six lines, and an empty one, three.
blk="${fence}json"$'\n'"$two"$'\n'"$fence"
empty="${fence}json"$'\n''[]'$'\n'"$fence"
# The findings array with $1 before each of its lines.
pre() { printf '%s' "$1${two//$'\n'/$'\n'$1}"; }

refused() {
  local label=$1 out; shift
  rm -f "$work/called"
  out=$(cd "$work" && env "$@" 2>&1)
  rc=$?
  last=${out##*$'\n'}
  last=${last//$'\r'/}
  if [ "$rc" -eq 2 ] && [[ "$last" == "REVIEW: failed, usage: "* ]] && [ ! -e "$work/called" ]; then
    echo "PASS: refused $label"; else echo "FAIL: $label exited $rc: $last"; fails=$((fails + 1)); fi
}

canned .
passes "a result with findings" 0 "models claude-opus-5-5, findings 2"
want=$(printf '%s\n' 6 -p --model opus --output-format json \
  "/code-review high --max-findings default" unset /code-review opus 1 "$root" "stdin 1")
if [ "$(cat "$work/called")" = "$want" ]; then
  echo "PASS: the child's arguments, environment, checkout and stdin"; else
  echo "FAIL: the child was started as: $(cat "$work/called")"; fails=$((fails + 1)); fi
if [ "$(cat "$state/code-review-0.md")" = "$r_two" ] && grep -q "stub stderr" "$state/code-review-0.err" &&
  jq -e '.type == "result"' "$state/code-review-0.json" >/dev/null; then
  echo "PASS: the result, stdout and stderr files"; else
  echo "FAIL: the files in the state directory are wrong"; fails=$((fails + 1)); fi

canned --arg r "${fence}json"$'\n'"$two"$'\n'"$fence" '.result = $r'
passes "a result that ends at the closing fence" 0 "models claude-opus-5-5, findings 2"
canned --arg r "$(fenced '[]' 'No findings.')" '.result = $r'
passes "an empty array, a clean review" 0 "models claude-opus-5-5, findings 0"
canned --arg r "Read the range."$'\n\n'"$r_two" '.result = $r | .modelUsage["claude-haiku-4-5"] = {}'
passes "a Haiku key beside Opus, and prose before the block" 0 "models claude-haiku-4-5 claude-opus-5-5, findings 2"
canned --arg r "$r_two"$'\n\n'"- Line 3 runs \`rm -rf\`, and a lone $fence ends the block." '.result = $r'
passes "fence text inside a line after the block" 0 "models claude-opus-5-5, findings 2"
# The indent before a marker is spaces and tabs alone, whatever the locale
# counts as blank.
canned --arg r "$r_two"$'\n\n'$'\xc2\xa0'"${fence}bash" '.result = $r'
passes "a no-break space before fence text after the block" 0 "models claude-opus-5-5, findings 2"
canned --arg r "${r_two//$'\n'/$'\r\n'}" '.result = $r'
passes "a result whose lines end in CR LF" 0 "models claude-opus-5-5, findings 2"
# Read by bash, since Git Bash's grep without -U does not match a CR.
written=$(cat "$state/code-review-0.md" 2>/dev/null)
if [ -z "$written" ] || [[ "$written" == *$'\r'* ]]; then
  echo "FAIL: the result file is missing or kept a CR"; fails=$((fails + 1)); else
  echo "PASS: the result file holds no CR"; fi
canned .
passes "a re-review id" gate "models claude-opus-5-5, findings 2"
passes "an owner round id" owner-2 "models claude-opus-5-5, findings 2"
passes "the Minor batch's id" minor "models claude-opus-5-5, findings 2"

canned .
failed "a non-zero exit" 0 exit STUB_EXIT=1
canned '.is_error = true | .result = "Claude AI usage limit reached\nsecond line"'
failed "a non-zero exit with a JSON result" 0 exit STUB_EXIT=1
if [[ "$last" == *"usage limit reached"* && "$last" != *"second line"* ]]; then
  echo "PASS: the exit detail carries the result's first line"; else
  echo "FAIL: the exit detail was: $last"; fails=$((fails + 1)); fi
printf 'not json\n' >"$work/out.json"
failed "output that is not JSON" 0 json
: >"$work/out.json"
failed "empty output at exit 0" 0 json
canned . && cat "$work/out.json" "$work/out.json" >"$work/two.json" && mv "$work/two.json" "$work/out.json"
failed "two JSON objects" 0 json
canned '.is_error = true | .result = "Claude AI usage limit reached\nsecond line"'
failed "is_error true" 0 status
if [[ "$last" == *"usage limit reached"* && "$last" != *"second line"* ]]; then
  echo "PASS: the status detail carries the result's first line"; else
  echo "FAIL: the status detail was: $last"; fails=$((fails + 1)); fi
canned '.subtype = "error_max_turns"'
failed "a subtype other than success" 0 status
canned '.permission_denials = [{tool_name: "Bash", tool_use_id: "t1", tool_input: {command: "git diff"}}]'
failed "a permission denial" 0 denials
canned 'del(.permission_denials)'
failed "no permission_denials field" 0 denials
canned 'del(.modelUsage)'
failed "no modelUsage field" 0 model
canned '.modelUsage["claude-fable-5-2"] = {}'
failed "a claude-fable key beside Opus" 0 model
canned '.modelUsage = {"claude-haiku-4-5": {}}'
failed "no Opus key" 0 model
canned '.result = "The branch looks fine to me."'
refuses "prose with no fenced array" "$none"
canned '.result = 5'
refuses "a result that is not a string" "$none"
canned --arg r "$(fenced '[{"line": 3, "summary": "s"}]' 'One finding.')" '.result = $r'
failed "an element with no file" 0 findings
canned --arg r "$(fenced '{"file": "scripts/a.sh"}' 'One finding.')" '.result = $r'
failed "a fenced object, not an array" 0 findings
canned --arg r "$(fenced '{}'$'\n'"$two" 'One block, two values.')" '.result = $r'
failed "a block that holds two JSON values" 0 findings
canned --arg r "${fence}json"$'\n'"$two" '.result = $r'
refuses "a block with no closing fence" "no $fence line at the margin closes the ${fence}json block that opens at line 1"
# The block is the result's only fenced block, so every other line that starts
# with a code fence marker fails the review by its number, inside the block too
# (docs/superpowers/specs/2026-11-10-pipeline-model-per-step-design.md, What it
# checks).
canned --arg r "${fence}json"$'\n'"$two"$'\n'"\`$fence" '.result = $r'
refuses "a block closed by four backticks" "$(inside 6 1)"
canned --arg r "${fence}json"$'\n'"$two"$'\n'"   $fence" '.result = $r'
refuses "a block closed by an indented closer" "$(inside 6 1)"
canned --arg r "${fence}json"$'\n'"$two"$'\n'"${fence}bash"$'\n'"$fence" '.result = $r'
refuses "a bash fence line inside the block" "$(inside 6 1)"
canned --arg r "Read the range."$'\n\n'"$(fenced '[]' "$r_two")" '.result = $r'
refuses "an empty array before the findings array" "$(after 7 3 5)"
canned --arg r "Read the range."$'\n\n'"$(fenced '{"advisorModel": "fable"}' "$r_two")" '.result = $r'
refuses "a fenced object before the findings array" "$(after 7 3 5)"
canned --arg r "${fence}JSON"$'\n'"$two"$'\n'"$fence"$'\n\n'"$(fenced '[]' 'No findings.')" '.result = $r'
refuses "a JSON block in capitals beside an empty array" "$(before 1)"
canned --arg r "  ${fence}json"$'\n'"$two"$'\n'"  $fence"$'\n\n'"$(fenced '[]' 'No findings.')" '.result = $r'
refuses "an indented json block beside an empty array" "$(before 1)"
canned --arg r "~~~json"$'\n'"$two"$'\n'"~~~"$'\n\n'"$(fenced '[]' 'No findings.')" '.result = $r'
refuses "a tilde json block beside an empty array" "$(before 1)"
canned --arg r "\`${fence}json"$'\n'"$two"$'\n'"\`$fence"$'\n\n'"$(fenced '[]' 'No findings.')" '.result = $r'
refuses "a four-backtick json block beside an empty array" "$(before 1)"
canned --arg r "~~~json"$'\n'"$two"$'\n''~~~' '.result = $r'
refuses "a lone tilde json block" "$(before 1)"
canned --arg r "${fence}JSON"$'\n'"$two"$'\n'"$fence" '.result = $r'
refuses "a lone JSON block in capitals" "$(before 1)"
# CommonMark 0.31.2 reads one json block in each of these, and the review
# fails all the same, since the script reads lines, not Markdown.
canned --arg r "$(fenced "$two" "Check with:"$'\n'"${fence}bash"$'\n'"bash scripts/a.sh"$'\n'"$fence")" '.result = $r'
refuses "trailing prose with a fenced block of its own" "$(after 9 1 6)"
hunk=$'\n'"${fence}json"$'\n''{"k": 1}'$'\n'"$fence"$'\n'
canned --arg r "$(fenced "$two" "The spec hunk:"$'\n\n'"\`${fence}markdown$hunk\`$fence")" '.result = $r'
refuses "a four-backtick fence quoting a json fence, after the block" "$(after 10 1 6)"
canned --arg r "$(fenced "$two" "The spec hunk:"$'\n\n'"~~~markdown$hunk~~~")" '.result = $r'
refuses "a tilde fence quoting a json fence, after the block" "$(after 10 1 6)"
canned --arg r "$(fenced "$two" "For example:"$'\n\n'"    ${fence}json"$'\n    {}\n    '"$fence")" '.result = $r'
refuses "a json fence indented four spaces, after the block" "$(after 10 1 6)"
canned --arg r "$(fenced "$two" "For example:"$'\n\n\t'"${fence}json"$'\n\t{}\n\t'"$fence")" '.result = $r'
refuses "a json fence indented by a tab, after the block" "$(after 10 1 6)"
canned --arg r "- ${fence}bash"$'\n''  bash scripts/a.sh'$'\n'"$r_two" '.result = $r'
refuses "a block after a list item whose fence it ends" "$(before 1)"
canned --arg r "The spec hunk:"$'\n\n'"\`${fence}markdown"$'\n'"$(fenced '[]' '')"$'\n'"\`$fence"$'\n\n'"$r_two" '.result = $r'
refuses "a fence quoting an empty json array, before the block" "$(before 3)"
canned --arg r 'Text'$'\n''2. Note'$'\n''    '"${fence}json"$'\n''    {}'$'\n''    '"$fence"$'\n\n'"$blk" '.result = $r'
refuses "a json fence four spaces under paragraph text, before the block" "$(before 3)"
canned --arg r '<pre>'$'\n'"${fence}json"$'\n''{}'$'\n'"$fence"$'\n''</pre>'$'\n\n'"$blk" '.result = $r'
refuses "a json fence inside an HTML block, before the block" "$(after 7 2 4)"
# A fence marker after list and quote markers counts wherever the line sits.
in_item() { printf '%s%sjson\n%s\n%s%s\n\n%s' "$1" "$fence" "$(sed "s/^/$2/" <<<"$two")" "$2" "$fence" "$(fenced '[]' '')"; }
canned --arg r "$(in_item '1. ' '   ')" '.result = $r'
refuses "a json block on an ordered item's line beside an empty array" "$(before 1)"
canned --arg r "$(in_item '- ' '   ')" '.result = $r'
refuses "a json block on a bullet item's line beside an empty array" "$(before 1)"
canned --arg r "$(in_item '10. Findings:'$'\n\n''    ' '    ')" '.result = $r'
refuses "a json block four spaces under an ordered item beside an empty array" "$(before 3)"
canned --arg r "$(in_item '- Findings:'$'\n''  - In scripts:'$'\n\n''    ' '    ')" '.result = $r'
refuses "a json block in a nested item beside an empty array" "$(before 4)"
canned --arg r '* '"${fence}json"$'\n'"$two"$'\n'"$fence"$'\n\n'"$empty" '.result = $r'
refuses "a json fence on a bullet's line with unindented content, an empty array after" "$(before 1)"
canned --arg r "$blk"$'\n\n''10. Findings:'$'\n''continued'$'\n''    '"${fence}json"$'\n''    []'$'\n''    '"$fence" '.result = $r'
refuses "a json fence under an ordered item after a lazy line, after the block" "$(after 10 1 6)"
canned --arg r "$blk"$'\n\n''-   Findings:'$'\n''more'$'\n''    '"${fence}json"$'\n''    []'$'\n''    '"$fence" '.result = $r'
refuses "a json fence under a bullet item after a lazy line, after the block" "$(after 10 1 6)"
canned --arg r '10. Findings:'$'\n''continued'$'\n''    '"${fence}json"$'\n'"$(pre '    ')"$'\n''    '"$fence"$'\n\n'"$empty" '.result = $r'
refuses "findings under an ordered item after a lazy line, an empty array after" "$(before 3)"
canned --arg r "$blk"$'\n\n''- > '"${fence}json"$'\n''  > []'$'\n''  > '"$fence" '.result = $r'
refuses "a json fence in a quote on a bullet's line, after the block" "$(after 8 1 6)"
canned --arg r "$blk"$'\n\n''10. x'$'\n\n''    > '"${fence}json"$'\n''    > []'$'\n''    > '"$fence" '.result = $r'
refuses "a json fence in a quote four spaces into an item, after the block" "$(after 10 1 6)"
canned --arg r '- > '"${fence}json"$'\n'"$(pre '  > ')"$'\n''  > '"$fence"$'\n\n'"$empty" '.result = $r'
refuses "findings in a quote on a bullet's line, an empty array after" "$(before 1)"
canned --arg r '10. x'$'\n\n''    > '"${fence}json"$'\n'"$(pre '    > ')"$'\n''    > '"$fence"$'\n\n'"$empty" '.result = $r'
refuses "findings in a quote four spaces into an item, an empty array after" "$(before 3)"
canned --arg r "$blk"$'\n\n''- '"${fence}bash"$'\n''  x'$'\n''> '"${fence}json"$'\n''> []'$'\n''> '"$fence" '.result = $r'
refuses "a quoted json fence that ends an item's bash fence, after the block" "$(after 8 1 6)"
canned --arg r '- '"${fence}bash"$'\n''  x'$'\n''> '"${fence}json"$'\n'"$(pre '> ')"$'\n''> '"$fence"$'\n\n'"$empty" '.result = $r'
refuses "findings in a quote that ends an item's bash fence, an empty array after" "$(before 1)"
canned --arg r "$blk"$'\n\n''>'$'\t'"${fence}json"$'\n''>'$'\t''[]'$'\n''>'$'\t'"$fence" '.result = $r'
refuses "a json fence after a quote marker and a tab, after the block" "$(after 8 1 6)"
canned --arg r '>'$'\t'"${fence}json"$'\n'"$(pre '>'$'\t')"$'\n''>'$'\t'"$fence"$'\n\n'"$empty" '.result = $r'
refuses "findings after a quote marker and a tab, an empty array after" "$(before 1)"

canned .
passes "a first run" 1 "models claude-opus-5-5, findings 2"
canned '.is_error = true'
failed "a failed rerun of the same id leaves no result file" 1 status

canned .
start=$SECONDS
failed "a review past its time bound" 0 timeout STUB_SLEEP=20 PIPELINE_REVIEW_TIMEOUT=1
if [ $((SECONDS - start)) -lt 10 ]; then echo "PASS: the bound ended the review"; else
  echo "FAIL: the review ran $((SECONDS - start)) s past a 1 s bound"; fails=$((fails + 1)); fi
# timeout's own statuses, from a child that ends by itself inside the bound.
for s in 124 137; do
  failed "a child that exits $s inside the bound" 0 exit STUB_EXIT=$s
  if [[ "$last" == "REVIEW: failed, exit: claude exited $s, "* ]]; then
    echo "PASS: the exit detail names status $s"; else
    echo "FAIL: the exit detail was: $last"; fails=$((fails + 1)); fi
done

refused "no arguments" bash "$script"
refused "one argument" bash "$script" "state dir"
refused "a review id that is a path" bash "$script" "state dir" ../x
refused "a review id that is not a round" bash "$script" "state dir" 4
refused "a review id that only starts with minor" bash "$script" "state dir" minor-1
refused "a missing state directory" bash "$script" nowhere 0
refused "a time bound that is not a number" PIPELINE_REVIEW_TIMEOUT=soon bash "$script" "state dir" 0

[ "$fails" -eq 0 ] || exit 1
echo "ALL PIPELINE REVIEW CASES PASSED"
