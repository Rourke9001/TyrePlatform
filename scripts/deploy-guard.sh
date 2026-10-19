#!/usr/bin/env bash
# The deploy's refusals (TYRE-397; section 4.2 of
# docs/superpowers/specs/2026-10-19-production-environment-design.md, and
# ADR-0017's 2026-10-19 amendment). `commit` runs in both deploy jobs
# before anything touches Azure: the environment matches its branch, a
# re-run cannot move an environment back (TYRE-403), and production takes
# only a commit staging has run, or rolls back only to one main has had.
# `image` runs before production applies the app template: the image is the
# one staging's gate and smoke passed, by the record staging writes after
# them, and PIN_FILE gets that image by digest, so production runs the bytes
# checked here whatever the tag later names (U140). `serving` runs just
# before staging writes that record: staging's API still runs the image, so
# a rollback since the api job cannot let the smoke certify an image it
# never reached.
#
# usage: deploy-guard.sh commit TARGET REF RUN_SHA RUN_ATTEMPT [ROLLBACK_SHA]
#        deploy-guard.sh image REGISTRY_HOST IMAGE_SHA PIN_FILE
#        deploy-guard.sh serving RESOURCE_GROUP APP REGISTRY_HOST IMAGE_SHA
# Exit 0 admits, 1 refuses with one ::error:: line, 2 is usage.
set -euo pipefail

usage() {
  {
    echo "usage: $0 commit TARGET REF RUN_SHA RUN_ATTEMPT [ROLLBACK_SHA]"
    echo "       $0 image REGISTRY_HOST IMAGE_SHA PIN_FILE"
    echo "       $0 serving RESOURCE_GROUP APP REGISTRY_HOST IMAGE_SHA"
  } >&2
  exit 2
}

refuse() {
  echo "::error::$1"
  exit 1
}

# A list, not a range: under en_US.UTF-8, [a-f] also matches A to E.
hex='[0123456789abcdef]'
full_sha() { [[ "$1" =~ ^$hex{40}$ ]]; }

# Every check is written as `if ! cmd`: under set -e a bare git, docker or
# az failure would end the script before its ::error:: line names the rule.
check_commit() {
  [ "$#" -eq 4 ] || [ "$#" -eq 5 ] || usage
  local target=$1 ref=$2 run_sha=$3 attempt=$4 rollback=${5:-} want branch head shallow

  case "$target" in
    staging) want=develop ;;
    prod) want=main ;;
    *) refuse "unknown target '$target': use staging or prod" ;;
  esac
  # The full ref, because a tag named main has the short name main too.
  [ "$ref" = "refs/heads/$want" ] \
    || refuse "$target deploys only from branch $want, not '$ref': run it from $want"
  branch=$want

  full_sha "$run_sha" \
    || refuse "the run's commit must be a full 40-character lower-case commit SHA, got '$run_sha'"
  [ -z "$rollback" ] || full_sha "$rollback" \
    || refuse "image_sha must be a full 40-character lower-case commit SHA, got '$rollback'"
  [[ "$attempt" =~ ^[1-9][0-9]*$ ]] \
    || refuse "the run attempt must be a positive whole number, got '$attempt'"

  if ! shallow=$(git rev-parse --is-shallow-repository); then
    refuse "cannot read this checkout's history, so nothing can be proven"
  fi
  [ "$shallow" = false ] \
    || refuse "this checkout is shallow, so ancestry cannot be proven: check out with fetch-depth: 0"

  if ! git fetch --quiet origin \
       +refs/heads/develop:refs/remotes/origin/develop \
       +refs/heads/main:refs/remotes/origin/main; then
    refuse "cannot read origin's develop and main, so nothing can be proven"
  fi

  if [ "$attempt" -gt 1 ]; then
    if ! head=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch^{commit}"); then
      refuse "cannot read origin/$branch, so this re-run cannot be judged"
    fi
    [ "$run_sha" = "$head" ] \
      || refuse "TYRE-403: attempt $attempt re-runs $run_sha, but origin/$branch is now $head. A re-run never moves an environment back: roll back by dispatch (runbook, Roll back)"
  fi

  # Every production run, a rollback's included, applies the template and
  # workflow of a commit staging has run.
  if [ "$target" = prod ]; then
    if ! git merge-base --is-ancestor "$run_sha" refs/remotes/origin/develop; then
      refuse "$run_sha is not an ancestor of origin/develop: production deploys only a develop commit (runbook, Promote to production)"
    fi
    if [ -n "$rollback" ] && ! git merge-base --is-ancestor "$rollback" refs/remotes/origin/main; then
      refuse "$rollback is not an ancestor of origin/main: production rolls back only to a commit main has had (runbook, Roll back)"
    fi
  fi

  echo "deploy-guard: $target from $branch at $run_sha${rollback:+, rolling back to $rollback}, admitted"
}

digest_of() {
  docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}'
}

check_image() {
  [ "$#" -eq 3 ] || usage
  local host=$1 sha=$2 pin=$3 image record out_image out_record
  full_sha "$sha" \
    || refuse "image_sha must be a full 40-character lower-case commit SHA, got '$sha'"
  image="$host/tyre-api:$sha"
  record="$image-staging-passed"

  if ! out_image=$(digest_of "$image"); then
    refuse "tyre-api:$sha is not in $host, or the registry could not be read (docker's error is above)"
  fi
  if ! out_record=$(digest_of "$record"); then
    refuse "staging never passed tyre-api:$sha: no tyre-api:$sha-staging-passed in $host (docker's error is above). Promote a commit staging deployed green (runbook, Promote to production)"
  fi
  # Two empty reads would compare equal, so a digest must look like one.
  [[ "$out_image" =~ ^sha256:$hex{64}$ ]] && [[ "$out_record" =~ ^sha256:$hex{64}$ ]] \
    || refuse "no digest read for tyre-api:$sha or its record (got '$out_image' and '$out_record')"
  [ "$out_image" = "$out_record" ] \
    || refuse "tyre-api:$sha does not match staging's record: the tag is $out_image, the record $out_record"

  if ! printf '%s\n' "$host/tyre-api@$out_image" >"$pin"; then
    refuse "cannot write the pinned image to $pin"
  fi
  echo "deploy-guard: tyre-api:$sha is the image staging passed ($out_image), admitted and pinned"
}

check_serving() {
  [ "$#" -eq 4 ] || usage
  local rg=$1 app=$2 host=$3 sha=$4 want live
  full_sha "$sha" \
    || refuse "image_sha must be a full 40-character lower-case commit SHA, got '$sha'"
  want="$host/tyre-api:$sha"

  if ! live=$(az containerapp show -g "$rg" -n "$app" --query 'properties.template.containers[0].image' -o tsv); then
    refuse "cannot read $app's image, so the smoke cannot be tied to tyre-api:$sha (az's error is above)"
  fi
  [ "$live" = "$want" ] \
    || refuse "$app now runs '$live', not $want, so the smoke proved nothing about tyre-api:$sha and staging does not pass it. A rollback or another deploy ran after the api job: $sha earns its record only in a run whose smoke reaches it"

  echo "deploy-guard: $app runs tyre-api:$sha, admitted"
}

[ "$#" -ge 1 ] || usage
sub=$1
shift
case "$sub" in
  commit) check_commit "$@" ;;
  image) check_image "$@" ;;
  serving) check_serving "$@" ;;
  *) usage ;;
esac
