#!/usr/bin/env bash
# Cases for scripts/pipeline-wait.sh (TYRE-478). A stub sleep first on PATH
# records what it was asked, so a refusal is shown never to wait and 600 is
# shown accepted without waiting; one case runs the real sleep.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/pipeline-wait.sh"
work=$(cd "$(mktemp -d)" && pwd)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat >"$work/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$STUB_DIR/slept"
EOF
chmod +x "$work/bin/sleep"
export STUB_DIR="$work"
stubbed="$work/bin:$PATH"
[ "$(PATH="$stubbed" command -v sleep)" = "$work/bin/sleep" ] || { echo "FAIL: the stub sleep is not first on PATH"; exit 1; }
fails=0

# Each refusal is bounded, so one that reached the real sleep ends in 5 s.
refused() {
  local label=$1 rc err; shift
  rm -f "$work/slept"
  err=$(PATH="$stubbed" timeout 5 bash "$script" "$@" 2>&1 >/dev/null)
  rc=$?
  if [ -e "$work/slept" ]; then
    echo "FAIL: $label reached sleep"; fails=$((fails + 1))
  elif [ "$rc" -ne 2 ] || [[ "$err" != "usage: make pipeline-wait S="* ]]; then
    echo "FAIL: $label exited $rc: $err"; fails=$((fails + 1))
  else
    echo "PASS: refused $label"
  fi
}

refused "no argument"
refused "an empty value" ""
refused "zero" 0
refused "601" 601
refused "a negative value" -5
refused "a signed value" +5
refused "a fraction" 1.5
refused "a unit suffix" 30s
refused "a word" soon
refused "a leading zero" 030
refused "an octal-looking value" 08
refused "a leading space" " 30"
refused "a 20-digit value" 99999999999999999999
refused "two arguments" 30 30

accepted() {
  local label=$1 value=$2
  rm -f "$work/slept"
  if PATH="$stubbed" bash "$script" "$value" && [ "$(cat "$work/slept" 2>/dev/null)" = "$value" ]; then
    echo "PASS: accepts $label"
  else
    echo "FAIL: $label: sleep was asked for '$(cat "$work/slept" 2>/dev/null)'"; fails=$((fails + 1))
  fi
}

accepted "1" 1
accepted "the 600 s bound" 600

start=$SECONDS
if timeout 10 bash "$script" 1 && [ $((SECONDS - start)) -ge 1 ]; then
  echo "PASS: a 1 s wait exits 0 after at least a second"
else
  echo "FAIL: a 1 s wait exited $? after $((SECONDS - start)) s"; fails=$((fails + 1))
fi

# Through make, as the lead types it. make exits 2 for any failed recipe, so
# these cases read its output, not its status.
start=$SECONDS
if timeout 10 make -s -C "$here/.." pipeline-wait S=1 && [ $((SECONDS - start)) -ge 1 ]; then
  echo "PASS: make pipeline-wait S=1 exits 0 after at least a second"
else
  echo "FAIL: make pipeline-wait S=1 exited $? after $((SECONDS - start)) s"; fails=$((fails + 1))
fi

make_refused() {
  local label=$1 out; shift
  rm -f "$work/slept"
  out=$(PATH="$stubbed" timeout 5 make -s -C "$here/.." pipeline-wait "$@" 2>&1)
  if [ "$?" -eq 0 ] || [ -e "$work/slept" ] || [[ "$out" == *INJECTED* ]] || [[ "$out" != *"usage: make pipeline-wait"* ]]; then
    echo "FAIL: make pipeline-wait did not refuse $label: $out"; fails=$((fails + 1))
  else
    echo "PASS: make pipeline-wait refused $label"
  fi
}

make_refused "no S"
make_refused "S=0" S=0
make_refused "a shell suffix" 'S=1;echo INJECTED'
make_refused "a dollar-paren substitution" 'S=1$$(echo INJECTED >&2)'
make_refused "a quote breakout" 'S=1"; echo INJECTED >&2; "'
make_refused "a make function" 'S=1$(shell echo INJECTED >&2)'

[ "$fails" -eq 0 ] || exit 1
echo "ALL PIPELINE WAIT CASES PASSED"
