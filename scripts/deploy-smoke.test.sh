#!/usr/bin/env bash
# Regression cases for scripts/deploy-smoke.sh (TYRE-51), on
# deploy-gate.test.sh's pattern: a stub curl on PATH answers from a table
# keyed on method, URL and Origin, refuses a call without --max-time, and
# records any call outside the table, so a smoke that asked the wrong
# question fails here too.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
smoke="$here/deploy-smoke.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

WEB=https://web.smoke.test
API=https://api.smoke.test
OTHER=https://deploy-smoke.invalid
CSP="default-src 'self'; connect-src 'self' $API https://ciam.smoke.test; frame-ancestors 'none'"

cat >"$work/swa.json" <<EOF
{
  "navigationFallback": { "rewrite": "/index.html" },
  "globalHeaders": {
    "Content-Security-Policy": "$CSP",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Permissions-Policy": "camera=(), geolocation=()"
  }
}
EOF

# The key is method, URL and Origin; cksum because it is POSIX and the
# stub and the table must hash alike.
cat >"$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[[ " $* " == *" --max-time "* ]] || { echo "curl without --max-time" >>"$STUB_DIR/unexpected"; exit 3; }
method=GET url="" origin="" headers="" body="" format=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method=$2; shift 2 ;;
    -H) case "$2" in [Oo]rigin:*) origin=${2#*: } ;; esac; shift 2 ;;
    -D) headers=$2; shift 2 ;;
    -o) body=$2; shift 2 ;;
    -w) format=$2; shift 2 ;;
    --max-time) shift 2 ;;
    -L|--location) echo "curl follows redirects" >>"$STUB_DIR/unexpected"; exit 3 ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "$format" = '%{http_code}' ] || { echo "curl without -w %{http_code}" >>"$STUB_DIR/unexpected"; exit 3; }
key=$(printf '%s %s %s' "$method" "$url" "$origin" | cksum | cut -d' ' -f1)
t="$STUB_DIR/t/$key"
[ -e "$t.code" ] || { echo "no answer for $method $url Origin=$origin" >>"$STUB_DIR/unexpected"; exit 3; }
n=$(( $(cat "$t.calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$t.calls"
if [ "$n" -eq 1 ] && [ -e "$t.first.code" ]; then
  cat "$t.first.code"
  exit "$(cat "$t.first.exit")"
fi
code=$(cat "$t.code")
if [ -n "$headers" ]; then
  { printf 'HTTP/2 %s\r\n' "$code"; sed 's/$/\r/' "$t.headers"; printf '\r\n'; } >"$headers"
fi
[ -z "$body" ] || cat "$t.body" >"$body"
printf '%s' "$code"
exit "$(cat "$t.exit")"
EOF
chmod +x "$work/bin/curl"
export STUB_DIR="$work" PATH="$work/bin:$PATH" SMOKE_TRIES=2 SMOKE_POLL_SECONDS=0

key() { printf '%s %s %s' "$1" "$2" "$3" | cksum | cut -d' ' -f1; }

# answer METHOD URL ORIGIN CODE HEADERS BODY [CURL_EXIT]
answer() {
  local t; t="$work/t/$(key "$1" "$2" "$3")"
  printf '%s' "$4" >"$t.code"
  printf '%s\n' "$5" | sed '/^$/d' >"$t.headers"
  printf '%s' "$6" >"$t.body"
  printf '%s' "${7:-0}" >"$t.exit"
}

# first METHOD URL ORIGIN CODE CURL_EXIT: what the first call alone gets.
first() {
  local t; t="$work/t/$(key "$1" "$2" "$3")"
  printf '%s' "$4" >"$t.first.code"
  printf '%s' "$5" >"$t.first.exit"
}

INDEX='<!doctype html><title>Tyre Platform</title>'
HSTS="Strict-Transport-Security: max-age=63072000; includeSubDomains"
WEB_HEADERS="content-type: text/html
Content-Security-Policy: $CSP
$HSTS
permissions-policy: camera=(), geolocation=()"
API_SECURITY="strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
content-security-policy: default-src 'none'; frame-ancestors 'none'"
REFUSED='{"code":"unauthorized","message":"the request names no one"}'

control() {
  rm -rf "$work/t" "$work/unexpected"
  mkdir "$work/t"
  answer GET "$WEB/" "" 200 "$WEB_HEADERS" "$INDEX"
  answer GET "$WEB/fleet/tyres?smoke=1" "" 200 "$WEB_HEADERS" "$INDEX"
  answer GET "$WEB/assets/deploy-smoke-missing.js" "" 404 "content-type: text/html" "not found"
  answer GET "$WEB/config.json" "" 200 "content-type: application/json
Cache-Control: no-cache" "{\"apiOrigin\":\"$API\"}"
  answer OPTIONS "$API/api/org/branding" "$WEB" 204 "$API_SECURITY
access-control-allow-origin: $WEB
access-control-allow-methods: GET, POST, PATCH
access-control-allow-headers: Authorization, Content-Type
access-control-max-age: 7200
vary: Origin" ""
  answer GET "$API/api/org/branding" "$WEB" 401 "content-type: application/json
$API_SECURITY
access-control-allow-origin: $WEB
vary: Origin" "$REFUSED"
  answer GET "$API/api/org/branding" "$OTHER" 401 "content-type: application/json
$API_SECURITY
vary: Origin" "$REFUSED"
}

fails=0
expect() { # name want-exit
  bash "$smoke" "$WEB" "$API" "$work/swa.json" >"$work/out" 2>&1
  local got=$?
  if [ -s "$work/unexpected" ]; then
    echo "FAIL: $1 (an unexpected curl: $(head -1 "$work/unexpected"))"; fails=$((fails + 1))
  elif [ "$got" -ne "$2" ]; then
    echo "FAIL: $1 (exit $got, wanted $2)"; sed 's/^/    /' "$work/out"; fails=$((fails + 1))
  else
    echo "ok: $1"
  fi
}

control; expect "control: both origins answer as deployed" 0

control; first OPTIONS "$API/api/org/branding" "$WEB" 000 28
expect "cold start: the API's first preflight gets no answer, then the right one" 0

control; answer GET "$WEB/" "" 200 "$HSTS
permissions-policy: camera=(), geolocation=()" "$INDEX"
expect "the web origin sends no CSP" 1

control; answer GET "$WEB/" "" 200 "Content-Security-Policy: ${CSP/$API/https://api-other.smoke.test}
$HSTS
permissions-policy: camera=(), geolocation=()" "$INDEX"
expect "the CSP names another API origin" 1

control; answer GET "$WEB/" "" 200 "Content-Security-Policy: $CSP
$HSTS" "$INDEX"
expect "the web origin sends no Permissions-Policy" 1

control; answer GET "$WEB/" "" 200 "$WEB_HEADERS
strict-transport-security: max-age=31536000" "$INDEX"
expect "Strict-Transport-Security sent twice" 1

control; answer GET "$WEB/fleet/tyres?smoke=1" "" 404 "content-type: text/html" "not found"
expect "the deep link 404s" 1

control; answer GET "$WEB/fleet/tyres?smoke=1" "" 200 "$WEB_HEADERS" "<!doctype html><title>Something else</title>"
expect "the deep link answers another body" 1

control; answer GET "$WEB/assets/deploy-smoke-missing.js" "" 200 "content-type: text/html" "$INDEX"
expect "a missing asset answers 200" 1

control; answer GET "$WEB/config.json" "" 404 "content-type: text/html" "not found"
expect "config.json 404s" 1

control; answer GET "$WEB/config.json" "" 200 "Cache-Control: no-cache" '{"apiOrigin":"https://api-other.smoke.test"}'
expect "config.json names another API origin" 1

control; answer GET "$WEB/config.json" "" 200 "content-type: application/json" "{\"apiOrigin\":\"$API\"}"
expect "config.json without Cache-Control: no-cache" 1

# An image from before this CORS: requireActor on the /api sub-router
# answers before chi's method lookup (httpapi.go).
control; answer OPTIONS "$API/api/org/branding" "$WEB" 401 "$API_SECURITY" "$REFUSED"
expect "the preflight 401s" 1

control; answer OPTIONS "$API/api/org/branding" "$WEB" 204 "$API_SECURITY
access-control-allow-headers: Authorization, Content-Type" ""
expect "a 204 preflight without Allow-Origin" 1

control; answer OPTIONS "$API/api/org/branding" "$WEB" 204 "$API_SECURITY
access-control-allow-origin: $WEB
access-control-allow-headers: Content-Type" ""
expect "a 204 preflight that does not allow authorization" 1

control; answer GET "$API/api/org/branding" "$WEB" 200 "$API_SECURITY
access-control-allow-origin: $WEB" '{"displayName":"x"}'
expect "the refusal answers 200" 1

control; answer GET "$API/api/org/branding" "$WEB" 401 "$API_SECURITY" "$REFUSED"
expect "the refusal has no Allow-Origin" 1

control; answer GET "$API/api/org/branding" "$WEB" 401 "${API_SECURITY/x-frame-options: DENY/}
access-control-allow-origin: $WEB" "$REFUSED"
expect "the refusal has no X-Frame-Options" 1

control; answer GET "$API/api/org/branding" "$WEB" 503 "$API_SECURITY
access-control-allow-origin: $WEB" '{"code":"auth_unavailable","message":"sign-in is not configured"}'
expect "the refusal is 503 auth_unavailable" 1

control; answer GET "$API/api/org/branding" "$OTHER" 401 "$API_SECURITY
access-control-allow-origin: $OTHER" "$REFUSED"
expect "another origin is allowed (a reflected Origin)" 1

[ "$fails" -eq 0 ] || { echo "$fails deploy-smoke case(s) failed"; exit 1; }
echo "deploy-smoke: all cases pass"
