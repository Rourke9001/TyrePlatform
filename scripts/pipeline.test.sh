#!/usr/bin/env bash
# Cases for scripts/pipeline.sh (TYRE-412). The stub is a script, so Git Bash's
# path conversion never touches it; only a live launch proves "/pipeline ..."
# arrives intact on Windows.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
launcher="$here/pipeline.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat >"$work/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$#" "$1" "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-unset}" \
  "${MSYS2_ARG_CONV_EXCL:-unset}" >"$STUB_DIR/called"
EOF
chmod +x "$work/bin/claude"

export STUB_DIR="$work" PATH="$work/bin:$PATH"
unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS MSYS2_ARG_CONV_EXCL
fails=0

refused() {
  local label=$1 rc; shift
  rm -f "$work/called"
  bash "$launcher" "$@" 2>/dev/null
  rc=$?
  if [ -e "$work/called" ]; then
    echo "FAIL: $label reached claude"; fails=$((fails + 1))
  elif [ "$rc" -ne 2 ]; then
    echo "FAIL: $label exited $rc, not 2"; fails=$((fails + 1))
  else
    echo "PASS: refused $label"
  fi
}

refused "no key"
refused "an empty key" ""
refused "a lowercase key" "tyre-12"
refused "a key with no number" "TYRE-"
refused "a key with a trailing word" "TYRE-12 extra"
refused "a key with a shell suffix" "TYRE-12;true"
refused "two keys" "TYRE-12" "TYRE-13"

rm -f "$work/called"
want=$'1\n/pipeline TYRE-412\n1\n/pipeline '
if bash "$launcher" TYRE-412 && [ "$(cat "$work/called")" = "$want" ]; then
  echo "PASS: launches /pipeline TYRE-412 with the flag and the path exclusion"
else
  echo "FAIL: launch shape was: $(cat "$work/called" 2>/dev/null || echo 'claude not called')"
  fails=$((fails + 1))
fi

# Through make, as the owner types it: a value with a shell separator must
# reach the script as one argument and be refused, never run.
rm -f "$work/called"
out=$(make -s -C "$here/.." pipeline 'T=TYRE-12;echo INJECTED' 2>&1)
if [ -e "$work/called" ] || [[ "$out" == *INJECTED* ]] || [[ "$out" != *usage:* ]]; then
  echo "FAIL: make pipeline did not refuse a shell suffix: $out"; fails=$((fails + 1))
else
  echo "PASS: make pipeline refused a shell suffix"
fi

rm -f "$work/called"
if make -s -C "$here/.." pipeline T=TYRE-412 && [ "$(cat "$work/called")" = "$want" ]; then
  echo "PASS: make pipeline launches /pipeline TYRE-412 with the flag and the path exclusion"
else
  echo "FAIL: make pipeline launch shape was: $(cat "$work/called" 2>/dev/null || echo 'claude not called')"
  fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] || exit 1
echo "ALL PIPELINE LAUNCHER CASES PASSED"
