#!/usr/bin/env bash
# The post-deploy smoke of both staging origins (TYRE-51; section 5 of
# docs/superpowers/specs/2026-10-16-platform-readiness-design.md), and
# TYRE-398's first post-deploy smoke tests. It proves routing, CORS and the
# refusal shape. It does not prove that Authorization reaches Go unchanged:
# with no proxy in the path, TYRE-317's first signed-in request settles that.
#
#   bash scripts/deploy-smoke.sh WEB_ORIGIN API_ORIGIN SWA_CONFIG
#
# SWA_CONFIG is the staticwebapp.config.json the deploy uploaded; its
# globalHeaders are what the web origin must send. Each check retries,
# SMOKE_TRIES times SMOKE_POLL_SECONDS apart, for a cold-starting replica or
# a propagating upload. Exit 0 all pass, 1 a check failed, 2 usage.
set -euo pipefail
[ "$#" -eq 3 ] || { echo "usage: $0 WEB_ORIGIN API_ORIGIN SWA_CONFIG" >&2; exit 2; }
web=$1 api=$2 swa_config=$3
tries=${SMOKE_TRIES:-12}
poll=${SMOKE_POLL_SECONDS:-10}

# JSON is read with node, not python3: the deploy's web job sets Node up,
# ubuntu-latest carries it for CI's stub test, and on the Windows host
# python3 is the Store stub (the Makefile's PYTHON).
expected=$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const h = Object.entries(c.globalHeaders ?? {});
  if (h.length === 0) process.exit(1);
  for (const [k, v] of h) console.log(k + "\t" + v);
' "$swa_config") || { echo "$swa_config has no globalHeaders to check" >&2; exit 2; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
code="" why=""

# fetch NAME METHOD URL [HEADER...]: the status in $code, the headers in
# $work/NAME.h and the body in $work/NAME.b. No -L: a redirect is an answer
# to check, not one to follow. A failed transfer is no answer, and a file
# from an earlier try must not be read as this one's.
fetch() {
  local name=$1 method=$2 url=$3
  shift 3
  local args=()
  for h in "$@"; do args+=(-H "$h"); done
  : >"$work/$name.h"
  : >"$work/$name.b"
  code=$(curl -s --max-time 30 -X "$method" ${args[@]+"${args[@]}"} \
    -D "$work/$name.h" -o "$work/$name.b" -w '%{http_code}' "$url") || code=000
}

# values NAME HEADER: each value of HEADER in NAME's response, one per line.
# Names compare case-insensitively, and HTTP's \r is stripped.
values() {
  tr -d '\r' <"$work/$1.h" | awk -v want="$2" '
    BEGIN { want = tolower(want) }
    {
      i = index($0, ":")
      if (i > 0 && tolower(substr($0, 1, i - 1)) == want) {
        v = substr($0, i + 1); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); print v
      }
    }'
}

json_field() { # FILE FIELD: the string at FIELD, or nothing
  node -e '
    try {
      const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      if (typeof v === "string") process.stdout.write(v);
    } catch {}
  ' "$1" "$2"
}

# One value, exactly: a header sent twice fails with every value seen,
# rather than passing on whichever line was read.
one() { # NAME HEADER WANT
  local got=()
  mapfile -t got < <(values "$1" "$2")
  if [ "${#got[@]}" -eq 0 ]; then why="no $2"; return 1; fi
  if [ "${#got[@]}" -gt 1 ]; then why="$2 sent ${#got[@]} times: ${got[*]}"; return 1; fi
  if [ "${got[0]}" != "$3" ]; then why="$2 is '${got[0]}', want '$3'"; return 1; fi
}

web_origin() {
  fetch root GET "$web/"
  [ "$code" = 200 ] || { why="GET $web/ answered $code"; return 1; }
  local name want
  while IFS=$'\t' read -r name want; do
    one root "$name" "$want" || return 1
  done <<<"$expected"
  [[ "$(values root content-security-policy)" == *" $api "* ]] || { why="the CSP does not name $api"; return 1; }
}

deep_link() {
  fetch deep GET "$web/fleet/tyres?smoke=1"
  [ "$code" = 200 ] || { why="a deep link answered $code"; return 1; }
  cmp -s "$work/root.b" "$work/deep.b" || { why="a deep link answered a body other than /"; return 1; }
  # A reload of any route is this fallback answer, so it carries the same
  # headers as / (NFR-SEC-010).
  local name want
  while IFS=$'\t' read -r name want; do
    one deep "$name" "$want" || { why="the deep link: $why"; return 1; }
  done <<<"$expected"
  # chunkReload.ts reloads on HTML where a script was asked for.
  fetch missing GET "$web/assets/deploy-smoke-missing.js"
  [ "$code" = 404 ] || { why="a missing asset answered $code, not 404"; return 1; }
}

configuration() {
  fetch config GET "$web/config.json"
  [ "$code" = 200 ] || { why="GET $web/config.json answered $code"; return 1; }
  local got
  got=$(json_field "$work/config.b" apiOrigin)
  [ "$got" = "$api" ] || { why="config.json names '${got:-nothing}', want $api"; return 1; }
  # The app fetches it in the default cache mode, so freshness is this.
  one config cache-control no-cache
}

preflight() {
  fetch pre OPTIONS "$api/api/org/branding" "Origin: $web" \
    "Access-Control-Request-Method: GET" "Access-Control-Request-Headers: authorization"
  [ "$code" = 204 ] || { why="the preflight answered $code (an image from before TYRE-51 answers 401)"; return 1; }
  one pre access-control-allow-origin "$web" || return 1
  local allowed
  allowed=$(values pre access-control-allow-headers | tr '[:upper:]' '[:lower:]')
  [[ "$allowed" == *authorization* ]] || { why="the preflight allows headers '${allowed}', not authorization"; return 1; }
}

refusal() {
  fetch ref GET "$api/api/org/branding" "Origin: $web" "Authorization: Bearer deploy-smoke"
  if [ "$code" = 503 ] && [ "$(json_field "$work/ref.b" code)" = auth_unavailable ]; then
    why="the revision has no AUTH_* configuration (ADR-0016)"
    return 2
  fi
  [ "$code" = 401 ] || { why="a malformed bearer answered $code, not 401"; return 1; }
  [ "$(json_field "$work/ref.b" code)" = unauthorized ] || { why="the 401 is not Go's envelope"; return 1; }
  one ref access-control-allow-origin "$web" || return 1
  local h
  for h in strict-transport-security x-content-type-options x-frame-options referrer-policy content-security-policy; do
    [ -n "$(values ref "$h")" ] || { why="the refusal has no $h"; return 1; }
  done
}

other_origin() {
  fetch other GET "$api/api/org/branding" "Origin: https://deploy-smoke.invalid" "Authorization: Bearer deploy-smoke"
  [ "$code" = 401 ] || { why="a malformed bearer from another origin answered $code, not 401"; return 1; }
  local acao
  acao=$(values other access-control-allow-origin)
  [ -z "$acao" ] || { why="another origin was allowed: $acao"; return 1; }
}

# check NAME FUNCTION: retries FUNCTION; a return of 2 is a failure that
# waiting cannot fix, so it stops at once.
check() {
  local name=$1 fn=$2 i rc
  for ((i = 1; i <= tries; i++)); do
    rc=0
    "$fn" || rc=$?
    if [ "$rc" -eq 0 ]; then echo "ok: $name"; return 0; fi
    [ "$rc" -ne 2 ] || break
    [ "$i" -eq "$tries" ] || sleep "$poll"
  done
  echo "::error::$name: $why"
  exit 1
}

check "the web origin's headers" web_origin
check "a deep link returns the app and its headers, a missing asset 404s" deep_link
check "config.json names the API origin" configuration
check "the API answers the web origin's preflight" preflight
check "a refusal carries CORS and the security headers" refusal
check "another origin is not allowed" other_origin
echo "deploy-smoke: $web and $api pass"
