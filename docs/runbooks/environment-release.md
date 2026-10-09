# Release an environment

The owner's runbook for TYRE-368 and TYRE-79 (spec
`docs/superpowers/specs/2026-10-09-staging-deploy-path-design.md`, section
4). Written for staging: `ENV` names the environment in every command, and
TYRE-397 decides production's first-apply order, because a new production
has no vault and no secrets before its first platform apply. Every `az`
write here is the owner's. CI never runs these.

Run every block in Git Bash, from the repo root, in one shell: the `infra/`
and `db/migrations` paths are relative, and later blocks use the `ENV`,
`RG`, `PG` and `KV` the first one sets. That block also exports
`MSYS_NO_PATHCONV=1`, because Git Bash otherwise rewrites the `-v` mount,
`-path=/migrations` and `/subscriptions/...` arguments into Windows paths.

## Before anything

```bash
export MSYS_NO_PATHCONV=1
az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
az account show --query "{subscription:id, tenant:tenantId}" -o table
ENV=staging
RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV
```

The subscription must be `5a61b832-e331-4529-95ed-ae7b07a9697d`. If
`az account show` shows another one, run
`az account set --subscription 5a61b832-e331-4529-95ed-ae7b07a9697d`. The
CLI's default tenant is the CIAM one, which has no subscription.

While an environment's Postgres is stopped, its API is down: the API
pings the database at startup and exits without it. That is accepted for
staging (ADR-0017). Production's server is never stopped.

## One-time bring-up

In this order, before the TYRE-79 merge (staging) or the first production
release (TYRE-397).

1. **Read access to the vault.** Until step 4 lands the Secrets Officer
   grant, give yourself Secrets User (a different role, so the two do not
   collide). An empty `--scope` would widen the grant to the whole
   subscription, so the block checks both values first:

   ```bash
   me=$(az ad signed-in-user show --query id -o tsv)
   kvid=$(az keyvault show -n $KV --query id -o tsv)
   echo "me=$me kvid=$kvid"   # both must be non-empty
   [ -n "$me" ] && [ -n "$kvid" ] && \
     az role assignment create --assignee-object-id "$me" --assignee-principal-type User \
       --role "Key Vault Secrets User" --scope "$kvid"
   ```

2. **Prove the secrets.** This connects to Postgres, so first run **Each
   release** step 1 below: a stopped server or a stale firewall IP fails the
   connection whatever `database-url` holds. All three secrets must be
   listed, and `database-url` must connect as `app_login` without bypassing
   RLS:

   ```bash
   az keyvault secret list --vault-name $KV --query "[].name" -o tsv
   dsn=$(az keyvault secret show --vault-name $KV -n database-url --query value -o tsv)
   docker run --rm -e DSN="$dsn" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea sh -c \
     'psql "$DSN" -At -c "SELECT current_user || '"' '"' || rolbypassrls FROM pg_roles WHERE rolname = current_user;"'
   unset dsn
   ```

   Expect `psql-admin-password`, `pg-app-login-password`, `database-url`, then
   `app_login false`. Anything else stops the bring-up: a revision cannot
   activate without a working `database-url`. Judge a failed connection only
   after Each release step 1 has run.

3. **The deploy identity's credential and the GitHub environment.**

   The new token's subject is `...:environment:$ENV` whatever the owner and
   repo portion looks like, so the old `ref:` credential can never serve as
   a fallback: if the portion is wrong, the first deploy fails at
   `azure/login`. List the live credential first and copy its owner and
   repo portion byte for byte into the new subject. The form below is what
   the live credential showed on 9 Oct 2026; the listing is the authority.

   ```bash
   az identity federated-credential list -g $RG --identity-name id-tyre-deploy-$ENV --query "[].{name:name,subject:subject}" -o table
   az identity federated-credential create -g $RG --identity-name id-tyre-deploy-$ENV \
     -n github-env-$ENV --issuer https://token.actions.githubusercontent.com \
     --subject "repo:Rourke9001@92760271/TyrePlatform@1340948199:environment:$ENV" \
     --audiences api://AzureADTokenExchange
   gh api -X PUT repos/Rourke9001/TyrePlatform/environments/$ENV \
     -F "deployment_branch_policy[protected_branches]=false" \
     -F "deployment_branch_policy[custom_branch_policies]=true"
   gh api -X POST repos/Rourke9001/TyrePlatform/environments/$ENV/deployment-branch-policies \
     -f name=develop -f type=branch
   ```

   For production the branch is `main` (TYRE-397). Keep the old
   `github-main` credential until a deploy's "OIDC subject" step prints
   `sub: repo:Rourke9001@92760271/TyrePlatform@1340948199:environment:staging`
   exactly; then delete it:
   `az identity federated-credential delete -g $RG --identity-name id-tyre-deploy-$ENV -n github-main`.

4. **The platform template.** First start the server if it is stopped (an
   apply against a stopped server fails), and read the extension list now in
   force, so the template's value drops nothing added by hand. The password
   is read from the vault and the IP live, every time (spec section 4). Run
   this whole block, never the apply line alone: alone it sends an empty
   `pgAdminPassword`.

   ```bash
   [ "$(az postgres flexible-server show -g $RG -n $PG --query state -o tsv)" = Stopped ] \
     && az postgres flexible-server start -g $RG -n $PG -o none
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   ip=$(curl -s https://api.ipify.org)
   me=$(az ad signed-in-user show --query id -o tsv)
   echo "ip=$ip me=$me pw-length=${#pw}"   # all three must be non-empty
   [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     az deployment group create -g $RG -n platform-$(date +%Y%m%d%H%M) -f infra/platform.bicep \
       -p env=$ENV pgAdminPassword="$pw" deployerObjectId="$me" devMachineIp="$ip" -o none
   unset pw
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   ```

   If the first `parameter show` lists an extension other than `PGCRYPTO` and
   `BTREE_GIST`, stop: add it to `platform.bicep` first. Expect the second to
   print `PGCRYPTO,BTREE_GIST` (order may differ).

   Then remove step 1's grant, now that Secrets Officer is live. Re-derive
   every value in this block, because step 1 may have run in another session,
   and an empty `--scope` widens the delete to every match. List first, and
   delete only if the list shows exactly the one assignment:

   ```bash
   me=$(az ad signed-in-user show --query id -o tsv)
   kvid=$(az keyvault show -n $KV --query id -o tsv)
   echo "me=$me kvid=$kvid"   # both must be non-empty
   az role assignment list --assignee-object-id "$me" --role "Key Vault Secrets User" --scope "$kvid" -o table
   # Only after the list shows exactly one row:
   [ -n "$me" ] && [ -n "$kvid" ] && \
     az role assignment delete --assignee-object-id "$me" --role "Key Vault Secrets User" --scope "$kvid"
   ```

5. **Reset, then migrate (staging only).** Staging's data is disposable
   (U116), and its schema predates 000001's later edits (TYRE-368 comment
   13572).
   **First, drop** the database through ARM, which needs no assumption
   about who owns it inside Postgres. The command asks for confirmation;
   answer it yourself. The guard keeps it from running against production,
   whose database is never dropped:

   ```bash
   [ "$ENV" = staging ] && az postgres flexible-server db delete -g $RG -s $PG -n tyre
   ```

   If ARM refuses because sessions are open, list them as `tyreadmin` from
   the `postgres` database and stop to decide:

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   docker run --rm -e PGPASSWORD="$pw" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea psql \
     "host=$PG.postgres.database.azure.com dbname=postgres user=tyreadmin sslmode=require" -At \
     -c "SELECT pid, usename, application_name FROM pg_stat_activity WHERE datname = 'tyre';"
   unset pw
   ```

   The 21 Aug image never connects, so none are expected.

   **Then recreate** it by re-running the step 4 apply block (the first one),
   which recreates `tyre` with the collation the template declares. Never use
   a hand-typed `CREATE DATABASE`. Right after the grant swap, the Secrets
   Officer grant can take a few minutes to take effect, so if `pw-length=0`
   prints, wait and re-run.

   Then **Each release** below, from step 2. Production's database is new and
   empty, so production skips the drop. Tenants come from TYRE-374.

   Each release says to migrate from `develop`, and this runs before the
   TYRE-79 merge, so bring-up runs on the TYRE-79 branch, where
   `infra/platform.bicep` already exists. The rule still holds because TYRE-79
   adds no migration: bring-up applies only migrations already on `develop`.
   Before Each release step 2, run `git fetch`, then confirm that
   `git diff --stat origin/develop -- db/migrations` prints nothing.

6. **Merge TYRE-79.** The merge is the new pipeline's first run. Do not apply
   `infra/app.bicep` by hand first: the 21 Aug image has no `/readyz` and
   would never pass readiness.

## Each release

Run it from the repo root on a clean checkout of `develop` that includes the
merge commit, never from a feature branch: the migrate reads that checkout's
`db/migrations`, and step 3's check of the highest migration number reads
it too. Bring-up step 5 is the one exception, and says why.

**When to migrate.** Every merge to `develop` deploys staging, and the
migrate is a manual step (U94). Run **Each release** straight after a merge
whose PR carries a migration, once its deploy has gone green.

Until then, the new image runs against the old schema. `/readyz` only
pings, so the gate does not see that, and requests that need the new schema
fail. Staging holds no real data (ADR-0017), so that window is accepted.

Migrating before the merge is not allowed. A migration stays editable on
its feature branch, so a review fix, a renumbering on rebase or an abandoned
PR would leave staging at a version `develop` never had.

Production (TYRE-397) has real data, so TYRE-397 decides its own order.

1. **The database is running, and the firewall admits you.**

   ```bash
   [ "$(az postgres flexible-server show -g $RG -n $PG --query state -o tsv)" = Stopped ] \
     && az postgres flexible-server start -g $RG -n $PG -o none
   ip=$(curl -s https://api.ipify.org)
   az postgres flexible-server firewall-rule show -g $RG -s $PG -n AllowDevMachine --query startIpAddress -o tsv
   echo "your IP: $ip"
   ```

   If the rule's IP differs from yours, update it:

   ```bash
   [ -n "$ip" ] && az postgres flexible-server firewall-rule update -g $RG -s $PG -n AllowDevMachine \
     --start-ip-address "$ip" --end-ip-address "$ip"
   ```

2. **Migrate to head as `tyreadmin`.** The image and digest are the ones the
   Makefile's compose `migrate` service pins (`docker-compose.yml`):

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   enc=$(python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$pw")
   docker run --rm -v "$(pwd)/db/migrations:/migrations" \
     migrate/migrate:v4.19.1@sha256:cc4ad8e19d66791e3689405d9a028ce6e9614f32032db14acda1469f7201d6e4 \
     -path=/migrations \
     -database "postgres://tyreadmin:$enc@$PG.postgres.database.azure.com:5432/tyre?sslmode=require" up
   echo "migrate exit: $?"
   unset pw enc
   ```

3. **Stop on any of these.** A non-zero exit; `version` below reporting
   `(dirty)`; or a version that is not the highest number under
   `db/migrations/`. Recovering a dirty version is a decision for the owner,
   never a reflexive `force`.

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   enc=$(python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$pw")
   docker run --rm -v "$(pwd)/db/migrations:/migrations" \
     migrate/migrate:v4.19.1@sha256:cc4ad8e19d66791e3689405d9a028ce6e9614f32032db14acda1469f7201d6e4 \
     -path=/migrations -database "postgres://tyreadmin:$enc@$PG.postgres.database.azure.com:5432/tyre?sslmode=require" version
   ls db/migrations | tail -1
   unset pw enc
   ```

4. **The 000051 check** (TYRE-368 comment 13439). As `tyreadmin`:

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   docker run --rm -e PGPASSWORD="$pw" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea psql \
     "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" -At \
     -c "SELECT proowner::regrole, proacl FROM pg_proc WHERE oid = 'app.refresh_governing_tread()'::regprocedure;" \
     -c "SELECT has_function_privilege('app_login', 'app.refresh_governing_tread()', 'EXECUTE');"
   unset pw
   ```

   The ACL holds only the owner's entry and the second query returns `f`.
   Otherwise the release stops.

5. **Record the release** in the release table on Confluence page 10682399
   (U118): date, environment, image tag, schema version and dirty flag, who
   ran it. The image tag, read live:

   ```bash
   az containerapp show -g $RG -n ca-api-$ENV --query "properties.template.containers[0].image" -o tsv
   ```

The suite (`db/tests/004_tests.sql`) never runs against a deployed
environment (TYRE-374, U92).

## Roll back

From the repo's Actions tab, run **Deploy staging** from `develop` with
`image_sha` set to the full SHA of an image staging ran before. It
redeploys that image under today's template; a template change that must be
undone is a revert on `develop`. A rollback runs no down migration, so the
schema stays at head, and an old image must tolerate it.
