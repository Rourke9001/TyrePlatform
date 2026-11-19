#!/usr/bin/env bash
# The deploy's check of the API identity's roles (TYRE-438; section 4.1 of
# docs/superpowers/specs/2026-11-19-deploy-role-check-and-identity-hardening-design.md).
# id-tyre-api-<env> must hold no role that reaches kv-tyre-<env>, whose
# psql-admin-password bypasses RLS (CLAUDE.md rule 1), and nothing outside
# its expected set. deploy.yml's api job runs it before anything changes.
# It sees only scopes the deploy identity can read, and only when a deploy
# runs, so the runbook's listing after a platform apply stays.
#
# usage: deploy-roles.sh TARGET   (staging or prod)
# Exit 0 clean, 1 refused with an ::error:: line per broken rule, 2 usage.
set -euo pipefail

usage() {
  echo "usage: $0 TARGET (staging or prod)" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
target=$1
case "$target" in staging | prod) ;; *) usage ;; esac
rg=rg-tyre-$target
api_name=id-tyre-api-$target

pointer='(runbook: docs/runbooks/environment-release.md, One-time bring-up: staging, step 4)'
failed=0
flag() {
  echo "::error::deploy-roles rule $1: $2 $pointer"
  failed=1
}
# Rule 5 stops at once: what was not read cannot be proven clean.
refuse() {
  flag "$1" "$2"
  exit 1
}

# Every az, jq and file write is written `if ! cmd`, for the reason
# scripts/deploy-guard.sh gives.
if ! work=$(mktemp -d); then refuse 5 "cannot make a work folder"; fi
trap 'rm -rf "$work"' EXIT

# One value from az -o tsv, CR stripped (Windows), refused when empty.
read_value() { # VAR WHAT CMD...
  local var=$1 what=$2 v
  shift 2
  if ! v=$("$@"); then refuse 5 "cannot read $what (az's error is above)"; fi
  v=${v//$'\r'/}
  [ -n "$v" ] || refuse 5 "$what came back empty"
  printf -v "$var" '%s' "$v"
}

read_value sub "the subscription id" az account show --query id -o tsv
read_value api "$api_name's principal id" \
  az identity show -g "$rg" -n "$api_name" --query principalId -o tsv
read_value deployer "id-tyre-deploy-$target's principal id" \
  az identity show -g "$rg" -n "id-tyre-deploy-$target" --query principalId -o tsv
# Under access policies the vault ignores role assignments, so a policy
# could admit the identity while every listing stays clean (spec 4.1).
if ! mode=$(az keyvault show -g "$rg" -n "kv-tyre-$target" --query properties.enableRbacAuthorization -o tsv); then
  refuse 5 "cannot read kv-tyre-$target's authorization mode (az's error is above)"
fi
mode=${mode//$'\r'/}

group="/subscriptions/$sub/resourceGroups/$rg"
vault="$group/providers/Microsoft.KeyVault/vaults/kv-tyre-$target"

# The only rows id-tyre-api-<env> may hold, as role GUID and scope: AcrPull
# (infra/acr-pull.bicep) and Key Vault Secrets User (kvSecretsForApi in
# infra/platform.bicep). A ticket that grants it a new role, such as
# TYRE-152's storage role, adds the row here in its own PR.
expected_rows() {
  printf '%s\t%s\n' \
    7f951dda-4ed3-4680-a7ca-43fe172d538d "/subscriptions/$sub/resourceGroups/rg-tyre-staging/providers/Microsoft.ContainerRegistry/registries/crtyrestaging" \
    4633458b-17de-408a-b874-0445c86b69e6 "$group/providers/Microsoft.KeyVault/vaults/kv-tyre-api-$target"
}

role_name() {
  case "${1,,}" in
    7f951dda-4ed3-4680-a7ca-43fe172d538d) echo AcrPull ;;
    4633458b-17de-408a-b874-0445c86b69e6) echo "Key Vault Secrets User" ;;
    b86a8fe4-44ce-4948-aee5-eccb2c155cd7) echo "Key Vault Secrets Officer" ;;
    8e3af657-a8ff-443c-a75c-2fe8c4bcb635) echo Owner ;;
    b24988ac-6180-42a0-ab88-20f7382dd24c) echo Contributor ;;
    acdd72a7-3385-48ef-bd42-f606fba81ae7) echo Reader ;;
    *) echo "unknown role" ;;
  esac
}

# A row is id, role GUID, scope, principal id and type. A row without its
# role, scope or principal is refused rather than judged.
rows_jq='
def need(f; what): (f // "") as $v
  | if ($v | type) == "string" and $v != "" then $v else error("a row without its \(what)") end;
if (.value | type) != "array" then error("no value array") else
  .value[] | [(.id // "-"),
    (need(.properties.roleDefinitionId; "role") | sub(".*/"; "")),
    need(.properties.scope; "scope"),
    need(.properties.principalId; "principal"),
    (.properties.principalType // "unknown")] | @tsv
end'

# ARM pages a long listing, so every page is read, up to 20.
list_assignments() { # SCOPE FILTER OUT WHAT
  local scope=$1 filter=$2 out=$3 what=$4 url next docs pages=0
  # Relative, so az rest prefixes the signed-in cloud's ARM endpoint.
  url="$scope/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01"
  [ -z "$filter" ] || url="$url&\$filter=$filter"
  if ! : >"$out"; then refuse 5 "cannot write the $what listing to $out"; fi
  while :; do
    pages=$((pages + 1))
    [ "$pages" -le 20 ] || refuse 5 "the $what listing runs past 20 pages, and rows not read cannot be proven clean"
    if ! az rest --method get --url "$url" >"$work/body"; then
      refuse 5 "cannot read the $what listing (az's error is above)"
    fi
    # az rest exits 0 on a 200 with no body, and jq reads zero documents as
    # zero rows, so a page that is not one document is not read as clean.
    if ! docs=$(jq -n '[inputs] | length' <"$work/body"); then
      refuse 5 "the $what listing is not JSON (jq's error is above)"
    fi
    docs=${docs//$'\r'/}
    [ "$docs" = 1 ] || refuse 5 "the $what listing came back as $docs JSON documents, not one, so its rows cannot be proven read"
    if ! jq -r "$rows_jq" <"$work/body" | tr -d '\r' >>"$out"; then
      refuse 5 "the $what listing is not a list of role assignments (jq's error is above)"
    fi
    if ! next=$(jq -r '.nextLink // empty' <"$work/body"); then
      refuse 5 "cannot read the $what listing's next page"
    fi
    next=${next//$'\r'/}
    [ -n "$next" ] || return 0
    # az rest sends a nextLink an ARM token, so it is followed only on ARM.
    case "$next" in
      https://management.azure.com/*) url=$next ;;
      *) refuse 5 "the $what listing's next page is off ARM ($next), so it is not followed" ;;
    esac
  done
}

# vault, above or below kv-tyre-<env>, else other. ARM ids are
# case-insensitive, and the trailing / keeps kv-tyre-api-<env> apart.
relation() {
  local s=${1,,} v=${vault,,}
  if [ "$s" = "$v" ]; then
    echo vault
  elif [ "$s" = / ] || [[ "$s" == /providers/microsoft.management/managementgroups/* ]] || [[ "$v" == "$s"/* ]]; then
    echo above
  elif [[ "$s" == "$v"/* ]]; then
    echo below
  else
    echo other
  fi
}

# The filters reach ARM as spec 4.1's table gives them; never --assignee,
# which asks Microsoft Graph, where the deploy identity has no permission.
list_assignments "$vault" "atScope()%20and%20assignedTo(%27$api%27)" "$work/reach" "Reach"
list_assignments "$group" "principalId%20eq%20%27$api%27" "$work/whole" "Whole"
list_assignments "$group" "" "$work/all" "All"
list_assignments "$vault" "atScope()" "$work/control" "Control"

# A group's role below the vault is seen by neither Reach at the vault
# (atScope() stops there) nor Whole (principalId eq expands no group), so
# Reach runs again at every scope below the group that All shows.
declare -A seen=()
scopes=()
while IFS=$'\t' read -r _ _ scope _ _; do
  low=${scope,,}
  [[ "$low" == "${group,,}"/* ]] && [ "$low" != "${vault,,}" ] || continue
  [ -z "${seen[$low]:-}" ] || continue
  seen[$low]=1
  scopes+=("$scope")
done <"$work/all"
union_files=("$work/reach" "$work/whole")
i=0
for scope in "${scopes[@]}"; do
  i=$((i + 1))
  list_assignments "$scope" "atScope()%20and%20assignedTo(%27$api%27)" "$work/scope-$i" "Reach at $scope"
  union_files+=("$work/scope-$i")
done

declare -A union_seen=()
union=()
for f in "${union_files[@]}"; do
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    [ -z "${union_seen[${line,,}]:-}" ] || continue
    union_seen[${line,,}]=1
    union+=("$line")
  done <"$f"
done

declare -A want=() found=()
while IFS=$'\t' read -r guid scope; do
  want["${guid,,}"$'\t'"${scope,,}"]=1
done <<<"$(expected_rows)"

for line in "${union[@]}"; do
  IFS=$'\t' read -r _ guid scope principal ptype <<<"$line"
  name=$(role_name "$guid")
  echo "deploy-roles: $api_name holds $guid ($name) at $scope as $ptype"
  key="${guid,,}"$'\t'"${scope,,}"
  case "$(relation "$scope")" in
    vault | above | below)
      flag 1 "$api_name holds $guid ($name) at $scope, which reaches kv-tyre-$target, whose admin password bypasses RLS. Remove that grant" ;;
    *)
      if [ -n "${want[$key]:-}" ]; then
        found[$key]=1
      else
        flag 2 "$api_name holds $guid ($name) at $scope, outside its expected set. Remove that grant, or add the row to expected_rows in scripts/deploy-roles.sh in its own PR"
      fi ;;
  esac
done

[ "${mode,,}" = true ] \
  || flag 3 "kv-tyre-$target reports enableRbacAuthorization '$mode', not true: under access policies it ignores role assignments, so this check cannot see who reads it. A platform apply restores RBAC mode"

# The positive controls: ARM's documentation does not say a reader of the
# group is shown the rows the vault inherits from the subscription, or the
# rows below the group in an unfiltered listing (spec 4.1, section 7).
cannot="so this check cannot prove kv-tyre-$target is clean"
has_sub=0 has_deployer=0 has_below=0
while IFS=$'\t' read -r _ _ scope principal _; do
  [ "${scope,,}" != "/subscriptions/${sub,,}" ] || has_sub=1
  [ "$principal" != "$deployer" ] || [ "${scope,,}" != "${group,,}" ] || has_deployer=1
done <"$work/control"
while IFS=$'\t' read -r _ _ scope _ _; do
  [[ "${scope,,}" != "${group,,}"/providers/* ]] || has_below=1
done <"$work/all"
[ "$has_sub" = 1 ] || flag 4 "the Control listing at kv-tyre-$target shows no row at the subscription, which always has one, $cannot"
[ "$has_deployer" = 1 ] || flag 4 "the Control listing at kv-tyre-$target shows no row of id-tyre-deploy-$target at $rg, $cannot"
[ "$has_below" = 1 ] || flag 4 "the All listing at $rg shows no row on a resource in it, though kv-tyre-$target always has one, $cannot"

# A subset rule: a missing expected row is a notice, never a failure.
while IFS=$'\t' read -r guid scope; do
  key="${guid,,}"$'\t'"${scope,,}"
  [ -z "${found[$key]:-}" ] || continue
  case "$(role_name "$guid")" in
    AcrPull) why="production's deploy identity cannot read rg-tyre-staging, where the registry is" ;;
    *) why="a revision without it cannot resolve database-url, so the gate fails anyway" ;;
  esac
  echo "::notice::deploy-roles: $api_name has no $(role_name "$guid") row at $scope that this deploy can see; $why"
done <<<"$(expected_rows)"

[ "$failed" = 0 ] || exit 1
echo "deploy-roles: $api_name holds no role that reaches kv-tyre-$target and nothing outside its expected set"
