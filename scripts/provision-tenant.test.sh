#!/usr/bin/env bash
# Tenant provisioning, activation and the demonstration load, proved on two
# fresh databases of their own, never tyre, so the suite's pins and its tenant
# sweep stay defined on the fixture (TYRE-374). make db-provision-test runs it
# locally and the CI database job runs it last.
#
# Environment, set by both callers:
#   PSQL         a superuser psql command naming no database; SQL goes in on
#                stdin, because the container cannot see host paths
#   MIGRATE      golang-migrate up to -path=/migrations
#   PG_HOSTPORT  where the migrate container reaches Postgres
#   PYTHON       default python3
#   PROVISION_TEST_DB_ONLY=1 skips the unit tests, only to prove a database
#                check can fail on a mutation they would also catch
set -euo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1
: "${PSQL:?PSQL is a superuser psql command naming no database}"
: "${MIGRATE:?MIGRATE is a golang-migrate command up to -path}"
: "${PG_HOSTPORT:?PG_HOSTPORT is where migrate reaches Postgres}"
PYTHON=${PYTHON:-python3}

work=$(mktemp -d)
# With path conversion off, Git Bash hands /tmp to a native Python as is, so
# the directory is named the way Windows reads it.
if command -v cygpath >/dev/null 2>&1; then work=$(cygpath -m "$work"); fi
trap 'rm -rf "$work"' EXIT

T1=11111111-1111-1111-1111-111111111111

fail() {
  echo "FAIL $1: $2" >&2
  exit 1
}

ok() { echo "ok $1: $2"; }

# run <db> <role> <file> [psql args]: the file on stdin, as the role.
run() {
  local db=$1 role=$2 file=$3
  shift 3
  {
    [ "$role" = postgres ] || echo "SET ROLE $role;"
    cat "$file"
  } | $PSQL -d "$db" -v ON_ERROR_STOP=1 -q "$@"
}

# must_run <step> <db> <role> <file> [psql args]
must_run() {
  local step=$1 log="$work/step-$1.log"
  shift
  run "$@" >"$log" 2>&1 || {
    cat "$log" >&2
    fail "$step" "$3 did not run clean as $2"
  }
}

# must_refuse <step> <text> <db> <role> <file>: a failure counts only when it
# names its cause, since a malformed probe also exits non-zero.
must_refuse() {
  local step=$1 want=$2 out
  shift 2
  if out=$(run "$@" 2>&1); then
    fail "$step" "$3 ran clean; expected a failure naming $want"
  fi
  grep -qF -- "$want" <<<"$out" || {
    printf '%s\n' "$out" >&2
    fail "$step" "$3 failed without naming $want"
  }
}

# generate <step> <file> <out sql>: prints the tenant id the generator minted.
generate() {
  local log="$work/generate-$1.log" id
  $PYTHON db/seeds/provision_tenant.py "$2" "$3" >"$log" 2>&1 || {
    cat "$log" >&2
    fail "$1" "the generator refused $2"
  }
  id=$(sed -n 's/^tenant id: //p' "$log")
  [[ $id =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ||
    fail "$1" "the generator printed no tenant id for $2"
  echo "$id"
}

super() { $PSQL -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# 1. The generator's refusals and the demonstration file's names.
if [ "${PROVISION_TEST_DB_ONLY:-}" != 1 ]; then
  (cd db/seeds && $PYTHON -m unittest -q test_provision_tenant test_seed_demo) ||
    fail 1 "the generator's unit tests"
  ok 1 "unit tests"
fi

# 2. The fixture and the demonstration file, from the generators as they are.
(cd db/seeds && $PYTHON gen_seed_configurations.py && $PYTHON gen_seed_fixture.py &&
  $PYTHON gen_seed_demo.py) >"$work/generators.log" || fail 2 "a seed generator"

# 3. Two fresh databases at head, and a role standing in for tyreadmin.
# One statement per -c: a multi-statement -c runs as one transaction, and
# neither DROP DATABASE nor CREATE DATABASE runs inside one.
super -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'provision_owner') THEN CREATE ROLE provision_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$"
for db in tyre_provision tyre_demo; do
  super -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
  $MIGRATE -database "postgres://postgres:postgres@$PG_HOSTPORT/$db?sslmode=disable" up \
    >"$work/migrate-$db.log" 2>&1 || {
    cat "$work/migrate-$db.log" >&2
    fail 3 "migrations on $db"
  }
  # 4. provision_owner holds what the owning role holds in Azure but neither
  # owns the tables nor bypasses RLS, so FORCE binds it as it binds tyreadmin.
  $PSQL -d "$db" -v ON_ERROR_STOP=1 -q \
    -c "GRANT USAGE ON SCHEMA app TO provision_owner" \
    -c "GRANT ALL ON ALL TABLES IN SCHEMA app TO provision_owner" \
    -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA app TO provision_owner" \
    -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO provision_owner"
done
ok 3 "tyre_provision and tyre_demo at head"

# 5. The local fixture beside the provisioned tenants, and its counts before.
must_run 5 tyre_provision postgres db/seeds/002_seed_configurations.sql
must_run 5 tyre_provision postgres db/seeds/003_seed_fixture.sql
run tyre_provision postgres db/tests/provision/fixture-counts.sql >"$work/counts-before.txt"
ok 5 "fixture loaded"

# 6. The count gate can fail: one row more than the generator wrote rolls the
# tenant back.
Z=$(generate 6 db/tests/provision/free.json "$work/z.sql")
probe="INSERT INTO app.configuration (tenant_id, key, value, effective_from) VALUES (app.current_tenant_id(), 'count_gate_probe', '1'::jsonb, '-infinity');"
while IFS= read -r line; do
  [ "$line" = "-- count gate" ] && printf '%s\n' "$probe"
  printf '%s\n' "$line"
done <"$work/z.sql" >"$work/z-probe.sql"
[ "$(grep -c count_gate_probe "$work/z-probe.sql")" = 1 ] || fail 6 "the probe row did not go in"
must_refuse 6 "count gate: configuration holds 17, expected 16" tyre_provision postgres "$work/z-probe.sql"
ok 6 "the count gate refuses a count it did not expect"

# 7. Under a role that does not bypass RLS, and with the subdomain the
# rolled-back run left free.
F=$(generate 7 db/tests/provision/free.json "$work/f.sql")
must_run 7 tyre_provision provision_owner "$work/f.sql"
ok 7 "free.json provisioned as provision_owner ($F)"

# 8. As postgres, which bypasses RLS.
G=$(generate 8 db/tests/provision/generated.json "$work/g.sql")
must_run 8 tyre_provision postgres "$work/g.sql"
ok 8 "generated.json provisioned as postgres ($G)"

# 9. A committed file run again is refused on its id, and regenerated on its
# subdomain, with nothing written.
must_refuse 9 tenant_pkey tyre_provision postgres "$work/g.sql"
Y=$(generate 9 db/tests/provision/generated.json "$work/y.sql")
must_refuse 9 tenant_subdomain_key tyre_provision postgres "$work/y.sql"
ok 9 "a second run is refused"

# 10. A failure after the tenant and configuration rows leaves no tenant.
X=$(generate 10 db/tests/provision/fails-after-tenant.json "$work/x.sql")
must_refuse 10 warning_above_retread tyre_provision provision_owner "$work/x.sql"
ok 10 "a failed run rolls back"

# 11. What the two committed tenants hold, and that the refused runs left
# nothing.
must_run 11 tyre_provision postgres db/tests/provision/provisioned.sql \
  -v generated="$G" -v free="$F" -v absent="$Z,$X,$Y"
cat "$work/step-11.log"

# 12. Provisioning touched none of the fixture's rows.
run tyre_provision postgres db/tests/provision/fixture-counts.sql >"$work/counts-after.txt"
[ -s "$work/counts-before.txt" ] || fail 12 "the fixture counts came back empty"
diff "$work/counts-before.txt" "$work/counts-after.txt" || fail 12 "the fixture's row counts moved"
ok 12 "fixture row counts unchanged"

# 13. Activation, as the runbook runs it, under both kinds of role. Pago Pago's
# date is a day behind Kiritimati's, so F's horizon must be the earlier one.
must_run 13 tyre_provision postgres db/tests/provision/activated.sql \
  -v tenant="$G" -v role=postgres -v ahead=
must_run 13 tyre_provision provision_owner db/tests/provision/activated.sql \
  -v tenant="$F" -v role=provision_owner -v ahead="$G"
ok 13 "both tenants activated, each with today where its fleet is"

# 14. The control for step 15: the local fixture does name BAC.
must_run 14 tyre_provision postgres db/tests/provision/bac-strings.sql -v expect=some
ok 14 "the probe finds BAC in the local fixture"

# 15. The demonstration tenant, loaded under a role that does not bypass RLS.
must_run 15 tyre_demo provision_owner db/seeds/demo_tenant.sql
must_run 15 tyre_demo postgres db/tests/provision/demo.sql
must_run 15 tyre_demo postgres db/tests/provision/bac-strings.sql -v expect=none
ok 15 "demonstration tenant loaded with every number kept and no BAC name"

# 16. Clean up only on success, so a failure leaves both databases to inspect;
# the next run drops them first.
for db in tyre_provision tyre_demo; do
  super -c "DROP DATABASE $db WITH (FORCE)"
done
super -c "DROP ROLE provision_owner"
echo "provision-tenant: all steps passed"
