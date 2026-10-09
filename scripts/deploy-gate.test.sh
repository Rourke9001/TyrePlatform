#!/usr/bin/env bash
# Regression cases for scripts/deploy-gate.sh (TYRE-79, spec section 2):
# stub az and curl on PATH, passing controls, and every failure the spec
# names must exit non-zero. The stubs refuse calls the gate should never
# make, so a gate that polled the wrong revision or route fails here too.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
gate="$here/deploy-gate.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# az answers in its real -o tsv shape: one value per line. An empty state
# file stands for a revision that does not exist yet: az fails.
cat >"$work/bin/az" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"revision show"*)
    [[ "$args" == *"--revision ca-api-staging--c7-1-0123456 "* || "$args" == *"--revision ca-api-staging--c7-1-0123456" ]] \
      || { echo "revision show for the wrong revision: $args" >&2; exit 3; }
    [ -s "$STUB_DIR/state" ] || { echo "ERROR: revision not found" >&2; exit 1; }
    cat "$STUB_DIR/state" ;;
  *"containerapp show"*) echo "ca-api-staging.example.test" ;;
  *) echo "unexpected az call: $args" >&2; exit 2 ;;
esac
EOF
cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *" --max-time "* ]] || { echo "curl without --max-time" >&2; exit 3; }
out="" url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --max-time|-w) shift 2 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$url" = "https://ca-api-staging.example.test/readyz" ] || { echo "curl to the wrong URL: $url" >&2; exit 3; }
cat "$STUB_DIR/body" >"$out"
cat "$STUB_DIR/code"
EOF
chmod +x "$work/bin/az" "$work/bin/curl"

export STUB_DIR="$work" PATH="$work/bin:$PATH" GATE_POLL_SECONDS=0
sha=0123456789abcdef0123456789abcdef01234567
rev=ca-api-staging--c7-1-0123456
fails=0

case_run() { # name want-exit state(3 lines, or empty) code body
  if [ -n "$3" ]; then printf '%s\n' "$3" >"$work/state"; else : >"$work/state"; fi
  printf '%s' "$4" >"$work/code"
  printf '%s' "$5" >"$work/body"
  bash "$gate" rg-tyre-staging ca-api-staging c7-1-0123456 "$sha" 2 >/dev/null 2>&1
  got=$?
  if { [ "$2" = 0 ] && [ "$got" -ne 0 ]; } || { [ "$2" = 1 ] && [ "$got" -eq 0 ]; }; then
    echo "FAIL: $1 (exit $got, wanted $2)"; fails=$((fails + 1))
  else
    echo "ok: $1"
  fi
}

ok=$'Provisioned\nRunning\n100'
ok_body="{\"status\":\"ready\",\"sha\":\"$sha\",\"revision\":\"$rev\"}"
case_run "control: running, 100, right sha and revision" 0 "$ok" 200 "$ok_body"
case_run "spaced json still parses" 0 "$ok" 200 "{\"status\": \"ready\", \"sha\": \"$sha\", \"revision\": \"$rev\"}"
case_run "activating until the request wakes it still passes" 0 $'Provisioned\nActivating\n100' 200 "$ok_body"
case_run "degraded is not a failure" 0 $'Provisioned\nDegraded\n100' 200 "$ok_body"
case_run "provisioning failed stops at once" 1 $'Failed\nProcessing\n100' 200 "$ok_body"
case_run "running state failed stops at once" 1 $'Provisioned\nFailed\n100' 200 "$ok_body"
case_run "activation failed stops at once" 1 $'Provisioned\nActivationFailed\n100' 200 "$ok_body"
case_run "never takes traffic (timeout)" 1 $'Provisioned\nRunning\n0' 200 "$ok_body"
case_run "degraded and unready rides to the timeout" 1 $'Provisioned\nDegraded\n0' 503 "{\"status\":\"unready\",\"sha\":\"$sha\",\"revision\":\"$rev\"}"
case_run "revision never appears" 1 "" 200 "$ok_body"
case_run "old image: /readyz 404" 1 "$ok" 404 "{\"error\":\"not_found\"}"
case_run "wrong sha serving" 1 "$ok" 200 "{\"status\":\"ready\",\"sha\":\"ffffffffffffffffffffffffffffffffffffffff\",\"revision\":\"$rev\"}"
case_run "old revision serving the same sha" 1 "$ok" 200 "{\"status\":\"ready\",\"sha\":\"$sha\",\"revision\":\"ca-api-staging--c6-1-0123456\"}"
case_run "unready" 1 "$ok" 503 "{\"status\":\"unready\",\"sha\":\"$sha\",\"revision\":\"$rev\"}"

[ "$fails" -eq 0 ] || { echo "$fails deploy-gate case(s) failed"; exit 1; }
echo "deploy-gate: all cases pass"
