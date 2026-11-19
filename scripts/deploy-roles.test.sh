#!/usr/bin/env bash
# Cases for scripts/deploy-roles.sh (TYRE-438; section 4.1 of
# docs/superpowers/specs/2026-11-19-deploy-role-check-and-identity-hardening-design.md).
# A stub az on PATH answers each role assignment listing from a table the way
# ARM's documented filters do, so the negative control grants nothing. It
# records any call the check must never make (--assignee, a secret, a write),
# and a case with a recorded call fails whatever its exit.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script="$here/deploy-roles.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat >"$work/bin/az" <<'EOF'
#!/usr/bin/env bash
args="$*"
trap_call() { printf '%s\n' "$args" >>"$STUB_DIR/trap"; exit 3; }
fail_if() { [ "${STUB_FAIL:-}" != "$1" ] || { echo "ERROR: stubbed failure" >&2; exit 1; }; }

prev=""
for a in "$@"; do
  case "$a" in --assignee | --assignee=*) trap_call ;; esac
  [ "$prev" != --method ] || [ "$a" = get ] || trap_call
  prev=$a
done
case "$args" in *"keyvault secret"* | *vault.azure.net* | *listKeys* | *listSecrets*) trap_call ;; esac

T=${STUB_TARGET:-}
case "$args" in
  "account show --query id -o tsv")
    fail_if account; echo "$STUB_SUB"; exit 0 ;;
  "identity show -g rg-tyre-$T -n id-tyre-api-$T --query principalId -o tsv")
    fail_if identity-api; echo "$STUB_API_PID"; exit 0 ;;
  "identity show -g rg-tyre-$T -n id-tyre-deploy-$T --query principalId -o tsv")
    fail_if identity-deploy; echo "$STUB_DEPLOY_PID"; exit 0 ;;
  "keyvault show -g rg-tyre-$T -n kv-tyre-$T --query properties.enableRbacAuthorization -o tsv")
    fail_if keyvault; echo "$STUB_RBAC"; exit 0 ;;
  "rest --method get --url "*) [ "$#" -eq 5 ] || trap_call ;;
  *) trap_call ;;
esac

# The URL, relative as the script sends it, or a later page's absolute form.
url=$5 page=1
re='^(.*)&%24skiptoken=([0-9]+)$'
case "$url" in
  https://management.azure.com/*)
    [ "${STUB_PAGED:-}" = 1 ] || trap_call
    url=${url#https://management.azure.com}
    [[ "$url" =~ $re ]] || trap_call
    url=${BASH_REMATCH[1]} page=${BASH_REMATCH[2]} ;;
  /*) ;;
  *) trap_call ;;
esac
sent=$url
sp='%20' qu='%27' q="'"
url=${url//"$sp"/ }
url=${url//"$qu"/$q}
[[ "$url" == *'?'* ]] || trap_call
path=${url%%\?*} query=${url#*\?}
suffix=/providers/Microsoft.Authorization/roleAssignments
[[ "$path" == *"$suffix" ]] || trap_call
scope=${path%"$suffix"}
case "$query" in
  'api-version=2022-04-01') filter="" ;;
  'api-version=2022-04-01&$filter='?*) filter=${query#'api-version=2022-04-01&$filter='} ;;
  *) trap_call ;;
esac

lo=${scope,,} rg=${STUB_RG,,} kv=${STUB_KV,,}
if [ "$filter" = "atScope() and assignedTo('$STUB_API_PID')" ]; then
  if [ "$lo" = "$kv" ]; then kind=reach; else kind=per-scope; fi
elif [ "$filter" = "principalId eq '$STUB_API_PID'" ] && [ "$lo" = "$rg" ]; then kind=whole
elif [ -z "$filter" ] && [ "$lo" = "$rg" ]; then kind=all
elif [ "$filter" = "atScope()" ] && [ "$lo" = "$kv" ]; then kind=control
else trap_call
fi
fail_if "$kind"

# STUB_BODY_KIND, when set, limits STUB_BODY to that kind of listing.
if [ -z "${STUB_BODY_KIND:-}" ] || [ "$STUB_BODY_KIND" = "$kind" ]; then
  case "${STUB_BODY:-}" in
    novalue) echo '{"error":{"code":"Stubbed"}}'; exit 0 ;;
    notjson) echo 'not json'; exit 0 ;;
    empty) exit 0 ;;
    blank) printf '\n \n'; exit 0 ;;
    two) printf '{"value":[]}\n{"value":[]}\n'; exit 0 ;;
  esac
fi

holders=" $STUB_API_PID "
while IFS='|' read -r g m; do
  [ "$m" != "$STUB_API_PID" ] || holders+="$g "
done <"$STUB_DIR/groups"

# above: the root, a management group, or a prefix of the other scope.
above() { [ "$1" = / ] || [[ "$1" == /providers/microsoft.management/managementgroups/* ]] || [[ "$2" == "$1"/* ]]; }

sel=()
while IFS='|' read -r name role rscope pid ptype; do
  [ -n "$name" ] || continue
  r=${rscope,,}
  if [ "$r" = "$lo" ]; then rel=at
  elif above "$r" "$lo"; then rel=above
  elif [[ "$r" == "$lo"/* ]]; then rel=below
  else continue
  fi
  if [ "${STUB_TRIM_PARENTS:-}" = 1 ] && above "$r" "$rg"; then continue; fi
  case "$kind" in
    reach | per-scope) [ "$rel" != below ] && [[ "$holders" == *" $pid "* ]] || continue ;;
    whole) [ "$pid" = "$STUB_API_PID" ] || continue ;;
    all)
      [ "$name" != "${STUB_HIDE_ALL:-}" ] || continue
      [ "${STUB_NO_BELOW:-}" != 1 ] || [ "$rel" != below ] || continue ;;
    control) [ "$rel" != below ] || continue ;;
  esac
  [ "${STUB_LOWER:-}" != 1 ] || rscope=$r
  idbase=$rscope; [ "$idbase" != / ] || idbase=""
  sel+=("{\"id\":\"$idbase/providers/Microsoft.Authorization/roleAssignments/$name\",\"name\":\"$name\",\"properties\":{\"roleDefinitionId\":\"/subscriptions/$STUB_SUB/providers/Microsoft.Authorization/roleDefinitions/$role\",\"scope\":\"$rscope\",\"principalId\":\"$pid\",\"principalType\":\"$ptype\"}}")
done <"$STUB_DIR/rows"

n=${#sel[@]} next=""
case "${STUB_PAGED:-}" in
  1)
    if [ "$page" -le "$n" ]; then out=("${sel[page - 1]}"); else out=(); fi
    [ "$page" -ge "$n" ] || next="https://management.azure.com$sent&%24skiptoken=$((page + 1))" ;;
  offarm)
    out=("${sel[@]}")
    next="https://example.test$sent&%24skiptoken=2" ;;
  *) out=("${sel[@]}") ;;
esac
IFS=,
body="${out[*]}"
nl=""
[ -z "$next" ] || nl=",\"nextLink\":\"$next\""
[ "${STUB_NULLNEXT:-}" != 1 ] || nl=',"nextLink":null'
printf '{"value":[%s]%s}\n' "$body" "$nl"
EOF
chmod +x "$work/bin/az"

export STUB_DIR="$work" PATH="$work/bin:$PATH"

# A stub on a folder Git Bash cannot search is skipped and the real az runs
# (docs/lessons.md, 2026-11-11).
[ "$(command -v az)" = "$work/bin/az" ] \
  || { echo "FAIL: az on PATH is '$(command -v az)', not the stub, so no case can run"; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq is not on PATH, and deploy-roles.sh parses every listing with it"; exit 1; }

SUB=11111111-1111-1111-1111-111111111111
API=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
DEPLOY=dddddddd-dddd-dddd-dddd-dddddddddddd
OWNER=0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b
GROUP=99999999-9999-9999-9999-999999999999
ACRPULL=7f951dda-4ed3-4680-a7ca-43fe172d538d
KVSU=4633458b-17de-408a-b874-0445c86b69e6
KVSO=b86a8fe4-44ce-4948-aee5-eccb2c155cd7
OWNER_ROLE=8e3af657-a8ff-443c-a75c-2fe8c4bcb635
CONTRIBUTOR=b24988ac-6180-42a0-ab88-20f7382dd24c
READER=acdd72a7-3385-48ef-bd42-f606fba81ae7
BLOB=ba92f5b4-2d11-453d-a403-e96b0029c9fe
MG=/providers/Microsoft.Management/managementGroups/mg-tyre
ACR="/subscriptions/$SUB/resourceGroups/rg-tyre-staging/providers/Microsoft.ContainerRegistry/registries/crtyrestaging"
export STUB_SUB=$SUB STUB_API_PID=$API STUB_DEPLOY_PID=$DEPLOY STUB_RBAC=true

base() { # ENV: the clean table for one environment
  local e=$1
  RG="/subscriptions/$SUB/resourceGroups/rg-tyre-$e"
  KV="$RG/providers/Microsoft.KeyVault/vaults/kv-tyre-$e"
  KVAPI="$RG/providers/Microsoft.KeyVault/vaults/kv-tyre-api-$e"
  ST="$RG/providers/Microsoft.Storage/storageAccounts/sttyre$e"
  export STUB_RG=$RG STUB_KV=$KV
  cat >"$work/rows" <<ROWS
r-owner|$OWNER_ROLE|/subscriptions/$SUB|$OWNER|User
r-deploy|$CONTRIBUTOR|$RG|$DEPLOY|ServicePrincipal
r-kv-officer|$KVSO|$KV|$OWNER|User
r-kvapi-officer|$KVSO|$KVAPI|$OWNER|User
r-acrpull|$ACRPULL|$ACR|$API|ServicePrincipal
r-kvapi-user|$KVSU|$KVAPI|$API|ServicePrincipal
ROWS
  : >"$work/groups"
}
add() { printf '%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" >>"$work/rows"; }
drop() {
  local keep=() line
  while IFS= read -r line; do [[ "$line" == "$1|"* ]] || keep+=("$line"); done <"$work/rows"
  printf '%s\n' "${keep[@]}" >"$work/rows"
}
member() { printf '%s|%s\n' "$1" "$2" >>"$work/groups"; }

fails=0
case_run() { # LABEL WANT TARGET [TEXT]; WANT is pass, notice, rule1 to rule5 or usage
  local label=$1 want=$2 target=$3 text=${4:-} out got wexit why="" line n=""
  local has_rule=0 other_err=0 any_err=0 any_notice=0 text_notice=0
  : >"$work/trap"
  export STUB_TARGET=$target
  if [ -n "$target" ]; then out=$(bash "$script" "$target" 2>&1); else out=$(bash "$script" 2>&1); fi
  got=$?
  out=${out//$'\r'/}
  case "$want" in pass | notice) wexit=0 ;; usage) wexit=2 ;; *) wexit=1 n=${want#rule} ;; esac
  while IFS= read -r line; do
    case "$line" in
      "::error::deploy-roles rule $n:"*) [ -z "$n" ] || has_rule=1; any_err=1 ;;
      ::error::*) other_err=1 any_err=1 ;;
      ::notice::*) any_notice=1; [[ "$line" != *"$text"* ]] || text_notice=1 ;;
    esac
  done <<<"$out"
  [ "$got" -eq "$wexit" ] || why="exit $got, wanted $wexit"
  [ ! -s "$work/trap" ] || why="${why:+$why; }it made a call the check must never make: $(cat "$work/trap")"
  case "$want" in
    rule[1-5])
      [ "$has_rule" = 1 ] || why="${why:+$why; }no ::error:: line for rule $n"
      [ "$other_err" = 0 ] || why="${why:+$why; }an ::error:: line names another rule" ;;
    pass) [ "$any_err" = 0 ] && [ "$any_notice" = 0 ] || why="${why:+$why; }an ::error:: or ::notice:: line on a clean pass" ;;
    notice) [ "$text_notice" = 1 ] || why="${why:+$why; }no ::notice:: line naming '$text'" ;;
  esac
  [ -z "$text" ] || [[ "$out" == *"$text"* ]] || why="${why:+$why; }the output does not name '$text'"
  if [ -n "$why" ]; then
    echo "FAIL: $label ($why)"
    printf '    %s\n' "$out"
    fails=$((fails + 1))
  else
    echo "ok: $label"
  fi
}

base staging; case_run "staging clean: both expected rows" pass staging "Key Vault Secrets User"
base staging; case_run "the rows are printed with their scopes" pass staging "registries/crtyrestaging"
base prod;    case_run "production clean: AcrPull is outside what it can read" notice prod "AcrPull"
base staging; drop r-acrpull; case_run "an expected row missing passes with a notice" notice staging "AcrPull"
base staging; add x "$KVSU" "$KV" "$API" ServicePrincipal; case_run "a role on the vault, held directly" rule1 staging
base staging; add x "$READER" "$RG" "$API" ServicePrincipal; case_run "a role inherited from the resource group" rule1 staging
base staging; add x "$READER" "/subscriptions/$SUB" "$API" ServicePrincipal; case_run "a role inherited from the subscription" rule1 staging
base staging; add x "$READER" "$MG" "$API" ServicePrincipal; case_run "a role inherited from a management group" rule1 staging
base staging; add x "$READER" "/" "$API" ServicePrincipal; case_run "a role at the root scope" rule1 staging
base staging; member "$GROUP" "$API"; add x "$KVSU" "$KV" "$GROUP" Group; case_run "a role on the vault through a group" rule1 staging
base staging; add x "$KVSU" "$KV/secrets/psql-admin-password" "$API" ServicePrincipal; case_run "a role on one secret, held directly" rule1 staging
base staging; member "$GROUP" "$API"; add x "$KVSU" "$KV/secrets/psql-admin-password" "$GROUP" Group; case_run "a role on one secret through a group" rule1 staging "secrets/psql-admin-password"
base staging; add x "$BLOB" "$ST" "$API" ServicePrincipal; case_run "a storage role, held directly" rule2 staging
base staging; member "$GROUP" "$API"; add x "$BLOB" "$ST" "$GROUP" Group; case_run "a storage role through a group" rule2 staging
base staging; add x "$KVSU" "$KVAPI/secrets/database-url" "$API" ServicePrincipal; case_run "the right role on a secret of the API's vault" rule2 staging
base staging; add x "$KVSO" "$KVAPI" "$API" ServicePrincipal; case_run "the wrong role on the API's vault" rule2 staging
base staging; STUB_RBAC=false case_run "the vault in access-policy mode" rule3 staging
base staging; STUB_RBAC= case_run "the vault's mode read back empty" rule3 staging
base staging; STUB_TRIM_PARENTS=1 case_run "ARM hides the subscription's rows" rule4 staging
base staging; drop r-deploy; case_run "the deploy identity's own row is missing" rule4 staging
base staging; STUB_NO_BELOW=1 case_run "the unfiltered listing omits rows below the group" rule4 staging
for k in account identity-api identity-deploy keyvault reach whole all per-scope control; do
  base staging; STUB_FAIL=$k case_run "az fails on $k" rule5 staging
done
base staging; STUB_API_PID= case_run "an empty API principal id" rule5 staging
base staging; STUB_DEPLOY_PID= case_run "an empty deploy principal id" rule5 staging
base staging; STUB_SUB= case_run "an empty subscription id" rule5 staging
base staging; add x "$KVSU" "$KV/secrets/psql-admin-password" "$API" ServicePrincipal; STUB_HIDE_ALL=x case_run "a role on one secret that only Whole sees" rule1 staging "secrets/psql-admin-password"
base staging; STUB_RBAC=True case_run "the vault's mode read as True" pass staging
base staging; STUB_PAGED=1 case_run "a clean paged listing passes" pass staging
base staging; add x "$KVSU" "$KV/secrets/psql-admin-password" "$API" ServicePrincipal; STUB_HIDE_ALL=x STUB_PAGED=1 case_run "a role only Whole sees, on its last page" rule1 staging
base staging; STUB_NULLNEXT=1 case_run "nextLink null passes" pass staging
base staging; STUB_PAGED=offarm case_run "a nextLink off ARM" rule5 staging
base staging; STUB_BODY=novalue case_run "a listing with no value array" rule5 staging
base staging; STUB_BODY=notjson case_run "a listing that is not JSON" rule5 staging
# az rest exits 0 on a 200 with no body, and jq reads zero documents as zero
# rows, so a page that is not exactly one document fails on rule 5.
base staging; member "$GROUP" "$API"; add x "$KVSU" "$KV" "$GROUP" Group
STUB_BODY=empty STUB_BODY_KIND=reach case_run "an empty Reach body over a group's role on the vault" rule5 staging
base staging; member "$GROUP" "$API"; add x "$BLOB" "$ST" "$GROUP" Group
STUB_BODY=empty STUB_BODY_KIND=per-scope case_run "an empty per-scope body over a group's storage role" rule5 staging
for k in reach whole all per-scope control; do
  base staging; STUB_BODY=empty STUB_BODY_KIND=$k case_run "an empty body on $k" rule5 staging
done
base staging; STUB_BODY=blank STUB_BODY_KIND=reach case_run "a whitespace-only Reach body" rule5 staging
base staging; STUB_BODY=two STUB_BODY_KIND=whole case_run "a Whole body of two documents" rule5 staging
base staging; STUB_LOWER=1 case_run "lower-cased scopes still match the expected rows" pass staging
base staging; add x "$KVSU" "$KV" "$API" ServicePrincipal; STUB_LOWER=1 case_run "lower-cased scopes still find the vault" rule1 staging
base staging; case_run "no target" usage ""
base staging; case_run "an unknown target" usage production

# The trap itself: a stub that let these through would make every case above
# blind to the calls they stand for.
: >"$work/trap"
az role assignment list --assignee x >/dev/null 2>&1
az keyvault secret show --vault-name kv-tyre-staging -n psql-admin-password >/dev/null 2>&1
az rest --method put --url /x >/dev/null 2>&1
mapfile -t trapped <"$work/trap"
if [ "${#trapped[@]}" -eq 3 ]; then
  echo "ok: the stub records --assignee, a secret read and a write"
else
  echo "FAIL: the stub recorded ${#trapped[@]} of the 3 calls it must refuse"; fails=$((fails + 1))
fi

[ "$fails" -eq 0 ] || { echo "$fails deploy-roles case(s) failed"; exit 1; }
echo "deploy-roles: all cases pass"
