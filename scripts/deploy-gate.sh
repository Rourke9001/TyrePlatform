#!/usr/bin/env bash
# The staging deploy gate (TYRE-79, spec section 2). Green only when a
# replica of the revision this deploy created answers /readyz with the
# expected commit and its own revision name; /healthz answering through the
# FQDN proves neither, because the old revision keeps traffic when a new
# one fails, and a traffic weight of 100 does not prove a replica serves
# (TYRE-79).
set -euo pipefail
[ "$#" -ge 4 ] || { echo "usage: $0 RESOURCE_GROUP APP REVISION_SUFFIX EXPECTED_SHA [TIMEOUT_SECONDS]" >&2; exit 2; }
rg=$1 app=$2 suffix=$3 want=$4 timeout=${5:-600}
poll=${GATE_POLL_SECONDS:-10}
deadline=$(( $(date +%s) + timeout ))
rev="$app--$suffix"

expired() { [ "$(date +%s)" -ge "$deadline" ]; }

fqdn=$(az containerapp show -g "$rg" -n "$app" --query properties.configuration.ingress.fqdn -o tsv)
body=$(mktemp)
trap 'rm -f "$body"' EXIT

# One loop: with minReplicas 0 only a request wakes a replica, so /readyz is
# polled on every pass. Only a Failed state stops early; Degraded and
# Unhealthy are normal during a cold start and ride to the timeout.
prov="" run="" weight="" code="" got_sha="" got_rev=""
while :; do
  # -o tsv prints one value per line; join them for read. A revision that
  # does not exist yet makes az fail, which leaves the fields empty.
  state=$(az containerapp revision show -g "$rg" -n "$app" --revision "$rev" \
            --query "[properties.provisioningState, properties.runningState, properties.trafficWeight]" \
            -o tsv 2>/dev/null | tr '\n' '\t' || true)
  IFS=$'\t' read -r prov run weight _ <<<"$state" || true
  case "$prov $run" in
    *Failed*) echo "::error::$rev failed: provisioning=$prov running=$run"; exit 1 ;;
  esac
  # A failed transfer is no answer, and a body from an earlier pass must not
  # be read as this one's (TYRE-79).
  : >"$body"
  code=$(curl -s --max-time 30 -o "$body" -w '%{http_code}' "https://$fqdn/readyz") || code=000
  got_sha=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-zA-Z]*\)".*/\1/p' "$body")
  got_rev=$(sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body")
  if [ "$code" = "200" ] && [ "$got_sha" = "$want" ] && [ "$got_rev" = "$rev" ] && [ "$weight" = "100" ]; then
    echo "$rev answers /readyz with $want and holds 100% traffic: the new build is serving"
    exit 0
  fi
  expired && { echo "::error::$rev not serving $want before the timeout (provisioning=${prov:-none} running=${run:-none} traffic=${weight:-none}; /readyz status=$code sha=${got_sha:-none} revision=${got_rev:-none})"; exit 1; }
  sleep "$poll"
done
