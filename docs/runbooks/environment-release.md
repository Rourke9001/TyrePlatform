# Release an environment

The owner's runbook for both environments: staging (TYRE-368 and TYRE-79,
spec `docs/superpowers/specs/2026-10-09-staging-deploy-path-design.md`,
section 4) and production (TYRE-397, spec
`docs/superpowers/specs/2026-10-19-production-environment-design.md`).
`ENV` names the environment in every command: `staging` or `prod`. Every
`az` write here is the owner's. CI never runs these.

Run every block in Git Bash, from the repo root, in one shell: the `infra/`
and `db/migrations` paths are relative, and later blocks use the `ENV`,
`RG`, `PG` and `KV` the first one sets. That block also exports
`MSYS_NO_PATHCONV=1`, because Git Bash otherwise rewrites the `-v` mount,
`-path=/migrations` and `/subscriptions/...` arguments into Windows paths.
In a new shell, run **Before anything** again first.

## Before anything

```bash
export MSYS_NO_PATHCONV=1
az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
az account show --query "{subscription:id, tenant:tenantId}" -o table
ENV=staging   # or prod
RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV
```

The subscription must be `5a61b832-e331-4529-95ed-ae7b07a9697d`. If
`az account show` shows another one, run
`az account set --subscription 5a61b832-e331-4529-95ed-ae7b07a9697d`. The
CLI's default tenant is the CIAM one, which has no subscription. Both
environments live in this subscription (ADR-0017).

While an environment's Postgres is stopped, its API is down: the API
pings the database at startup and exits without it. That is accepted for
staging (ADR-0017). Production's server is never stopped.

## One-time bring-up: staging

The record of staging's bring-up, run before the TYRE-79 merge on 11 Oct
2026. Step 4's apply block is the one both environments use for every
later platform apply.

Before the TYRE-79 merge, bring-up runs on the TYRE-79 branch, because
step 4 needs `infra/platform.bicep` and only that branch has it until the
merge. Each release says to migrate from `develop`, and the rule still
holds because TYRE-79 adds no migration, so bring-up applies only
migrations already on `develop`. Before step 5 runs Each release step 2,
run `git fetch`, then confirm that
`git diff --stat origin/develop -- db/migrations` prints nothing. If it
prints anything, stop.

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
   listed, and `database-url` must connect as `app_login`, which is not a
   superuser, does not bypass RLS and is a member of neither `tyreadmin` nor
   `azure_pg_admin` (CLAUDE.md rule 1). Roles outlive the database drop in
   step 5, so a hand change from an earlier bring-up would survive it:

   ```bash
   az keyvault secret list --vault-name $KV --query "[].name" -o tsv
   dsn=$(az keyvault secret show --vault-name $KV -n database-url --query value -o tsv)
   docker run --rm -e DSN="$dsn" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea sh -c \
     'psql "$DSN" -At -F " " -c "SELECT current_user, rolsuper, rolbypassrls, pg_has_role(current_user, '"'tyreadmin'"', '"'MEMBER'"'), pg_has_role(current_user, '"'azure_pg_admin'"', '"'MEMBER'"') FROM pg_roles WHERE rolname = current_user;"'
   case "$dsn" in *pool_max_conns*) echo "database-url names pool_max_conns" ;; *) echo "database-url names no pool_max_conns" ;; esac
   case "$dsn" in *"@$PG.postgres.database.azure.com"[:/]*) echo "database-url names $PG" ;; *) echo "database-url does not name $PG" ;; esac
   unset dsn
   ```

   Expect `psql-admin-password`, `pg-app-login-password`, `database-url`, then
   `app_login f f f f`. Anything else stops the bring-up: a revision cannot
   activate without a working `database-url`. Judge a failed connection only
   after Each release step 1 has run. The last line must be
   `database-url names psql-tyre-<env>`: an `app_login` on the other
   environment's server passes the role check too.

   Then expect `database-url names no pool_max_conns`. The `case` prints a
   verdict, never the value. If it prints `database-url names
   pool_max_conns`, rewrite the secret without it before the next release:
   a DSN's own `pool_max_conns` overrides the pool of 7 (ADR-0005,
   TYRE-305). Post the result on TYRE-305.

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

   Production's credential and environment are Production bring-up step 2.
   Keep the old `github-main` credential until a deploy's "OIDC subject"
   step prints
   `sub: repo:Rourke9001@92760271/TyrePlatform@1340948199:environment:staging`
   exactly; then delete it:
   `az identity federated-credential delete -g $RG --identity-name id-tyre-deploy-$ENV -n github-main`.

4. **The platform template.** First start the server if it is stopped (an
   apply against a stopped server fails), and read the extension list now in
   force, so the template's value drops nothing added by hand. The password
   is read from the vault and the IP live, every time, and both reach the
   template through `infra/platform.$ENV.bicepparam`, which reads them from
   the apply's environment. Run this whole block, never the apply line
   alone: alone it fails, because the param file finds none of the three
   variables.

   Before any apply that changes `infra/platform.bicep` or a platform param
   file, run the same block once with
   `az deployment group what-if -g $RG -p infra/platform.$ENV.bicepparam`
   in place of `az deployment group create ... -o none`, and read every
   Create, Delete and Modify it lists before you apply.

   ```bash
   [ "$(az postgres flexible-server show -g $RG -n $PG --query state -o tsv)" = Stopped ] \
     && az postgres flexible-server start -g $RG -n $PG -o none
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   ip=$(curl -s https://api.ipify.org)
   me=$(az ad signed-in-user show --query id -o tsv)
   echo "ip=$ip me=$me pw-length=${#pw}"   # all three must be non-empty
   [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     PG_ADMIN_PASSWORD="$pw" DEPLOYER_OBJECT_ID="$me" DEV_MACHINE_IP="$ip" \
     az deployment group create -g $RG -n platform-$(date +%Y%m%d%H%M) \
       -p infra/platform.$ENV.bicepparam -o none
   unset pw
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   ```

   If the first `parameter show` lists an extension other than `PGCRYPTO` and
   `BTREE_GIST`, stop: add it to `platform.bicep` first. Expect the second to
   print `PGCRYPTO,BTREE_GIST` (order may differ).

   After TYRE-402, the what-if must show no change to the API identity's
   AcrPull assignment on `crtyrestaging`: the grant moved into the
   `acr-pull.bicep` module with the same name, so a Create or Delete of it
   means the name drifted. Stop and fix the template before applying.

   **Staging's first apply after TYRE-397.** That template adds the blob
   protections (NFR-BAK-007), and staging's usual what-if noise is
   recorded nowhere, so take a baseline first. Run the what-if twice:
   - From a checkout of `develop` as it stood before TYRE-397 landed, the
     parent of TYRE-397's spec commit. PRs rebase-merge, so `<merge sha>^`
     is TYRE-397's own second-to-last commit, which already has the
     protections:
     `git switch --detach "$(git log origin/develop -1 --format=%H --grep='^docs(spec): TYRE-397 design the production environment$')^"`.
     Use that template's own form:
     `az deployment group what-if -g $RG -f infra/platform.bicep -p env=$ENV pgAdminPassword="$pw" deployerObjectId="$me" devMachineIp="$ip"`,
     inside this block's guards.
   - From `develop` (`git switch develop`), with the form above.

   The expected changes are whatever both runs list, plus the second run's
   Modify of `blobServices/default` (versioning and the two soft deletes).
   Anything else stops the apply.

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

   Then **Each release** below, steps 2 to 4. Leave its step 5 for step 6
   below: the image serving now is the one the merge replaces, and it never
   serves this schema. Tenants come from `provision-a-tenant.md`: on staging,
   Sandbox Fleet through that runbook and the demonstration tenant, and
   nothing else (U116).

6. **Merge TYRE-79.** The merge is the new pipeline's first run. Do not apply
   `infra/app.bicep` by hand first: the 21 Aug image has no `/readyz` and
   would never pass readiness.

   Once the merge's deploy is green, run **Each release** step 5 to record
   the release table's first row: the image read live then, with the version
   and dirty flag that Each release step 3 printed during step 5 above.

## Production bring-up

The owner runs this after TYRE-397 merges, with `ENV=prod` set in Before
anything. Production starts empty: no tenant is created here, and BAC's
account is made at TYRE-321's live onboarding (U139). A new production has
no vault and no secrets before its first platform apply, so the order
differs from staging's.

1. **The containers.** The resource group, the workspace with staging's
   retention, and the budget with staging's alerts. The budget CLI cannot
   set alerts, so staging's budget is read whole and written back under the
   new name, scope and amount; the alerts are never retyped:

   ```bash
   az group create -n $RG -l southafricanorth --tags project=tyreplatform env=prod -o none
   ret=$(az monitor log-analytics workspace show -g rg-tyre-staging -n log-tyre-staging --query retentionInDays -o tsv)
   echo "retention=$ret"   # must be non-empty; staging's is 30
   [ -n "$ret" ] && az monitor log-analytics workspace create -g $RG -n log-tyre-$ENV \
     -l southafricanorth --retention-time "$ret" -o none
   sub=$(az account show --query id -o tsv)
   src=""
   for scope in "/subscriptions/$sub/resourceGroups/rg-tyre-staging" "/subscriptions/$sub"; do
     az rest --method get --url "$scope/providers/Microsoft.Consumption/budgets/budget-tyre-staging?api-version=2023-05-01" \
       -o none 2>/dev/null && { src=$scope; break; }
   done
   echo "staging's budget is at: $src"   # must be non-empty
   f=$(cygpath -m "$(mktemp)")
   [ -n "$src" ] && az rest --method get \
     --url "$src/providers/Microsoft.Consumption/budgets/budget-tyre-staging?api-version=2023-05-01" > "$f" && \
   python -c 'import json, sys; \
   b = json.load(open(sys.argv[1]))["properties"]; \
   out = {"properties": {"category": b["category"], "amount": 50, "timeGrain": b["timeGrain"], \
     "timePeriod": {"startDate": sys.argv[2] + "T00:00:00Z", "endDate": b["timePeriod"]["endDate"]}, \
     "notifications": b["notifications"]}}; \
   json.dump(out, open(sys.argv[1], "w")); \
   print("staging amount", b["amount"], "; alerts copied:", ", ".join(sorted(b["notifications"])))' \
     "$f" "$(date -u +%Y-%m-01)" && \
   az rest --method put \
     --url "/subscriptions/$sub/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/budget-tyre-$ENV?api-version=2023-05-01" \
     --body @"$f" -o none
   rm -f "$f"
   az consumption budget show --budget-name budget-tyre-$ENV -g $RG --query "{amount:amount, alerts:notifications}" -o json
   ```

   The read-back shows `amount` 50 and the same alerts as staging's. The
   budget starts on the first of this month, because a copy of staging's
   older start date could be refused.

2. **The deploy identity and the GitHub environment.** Production's identity
   holds Contributor on its own group and AcrPull on staging's registry,
   both read-only beyond its group (ADR-0017). An empty `--scope` would widen
   a grant, so every value is checked first:

   ```bash
   az identity create -g $RG -n id-tyre-deploy-$ENV -l southafricanorth -o none
   pid=$(az identity show -g $RG -n id-tyre-deploy-$ENV --query principalId -o tsv)
   cid=$(az identity show -g $RG -n id-tyre-deploy-$ENV --query clientId -o tsv)
   rgid=$(az group show -n $RG --query id -o tsv)
   acrid=$(az acr show -n crtyrestaging --query id -o tsv)
   echo "pid=$pid cid=$cid rgid=$rgid acrid=$acrid"   # all four must be non-empty
   [ -n "$pid" ] && [ -n "$rgid" ] && \
     az role assignment create --assignee-object-id "$pid" --assignee-principal-type ServicePrincipal \
       --role Contributor --scope "$rgid" -o none
   [ -n "$pid" ] && [ -n "$acrid" ] && \
     az role assignment create --assignee-object-id "$pid" --assignee-principal-type ServicePrincipal \
       --role AcrPull --scope "$acrid" -o none
   ```

   The credential's subject names the GitHub environment `production`, not
   `$ENV`. List staging's live credential and copy its owner and repo
   portion byte for byte, as staging's step 3 says; the form below is what
   it showed on 9 Oct 2026:

   ```bash
   az identity federated-credential list -g rg-tyre-staging --identity-name id-tyre-deploy-staging --query "[].{name:name,subject:subject}" -o table
   az identity federated-credential create -g $RG --identity-name id-tyre-deploy-$ENV \
     -n github-env-production --issuer https://token.actions.githubusercontent.com \
     --subject "repo:Rourke9001@92760271/TyrePlatform@1340948199:environment:production" \
     --audiences api://AzureADTokenExchange
   gh api -X PUT repos/Rourke9001/TyrePlatform/environments/production \
     -F "deployment_branch_policy[protected_branches]=false" \
     -F "deployment_branch_policy[custom_branch_policies]=true"
   gh api -X POST repos/Rourke9001/TyrePlatform/environments/production/deployment-branch-policies \
     -f name=main -f type=branch
   [ -n "$cid" ] && gh variable set AZURE_CLIENT_ID --env production --body "$cid" -R Rourke9001/TyrePlatform
   gh variable list --env production -R Rourke9001/TyrePlatform
   ```

   The read-back must show `AZURE_CLIENT_ID` with production's client id.
   An environment variable overrides the repository's, which is staging's:
   without it the deploy would log in with staging's client id, whose
   credentials never match `environment:production`, so the login fails.

   If the staging listing above still shows `github-main`, delete it as
   staging's step 3 says: a job on `main` with no environment could
   otherwise log in as staging's deployer.

   Production's identity has AcrPull alone, not Reader, on `crtyrestaging`
   (ADR-0017's 2026-10-19 amendment). Two things the first deploy can show:
   - The "Staging passed this image" step may print a warning that names
     `crtyrestaging.azurecr.io` as the default registry login server. That
     is the CLI's fallback for a registry the identity cannot list, and it
     is expected.
   - If that step fails at `az acr login` with an authorization error,
     grant Reader on `crtyrestaging` to `id-tyre-deploy-prod` (the AcrPull
     block above with `--role Reader`) and re-run the failed jobs. The
     guard admits the re-run while its commit is still `main`'s head.

3. **The first platform apply.** The vault does not exist yet, so the admin
   password is generated here and kept in this shell for step 4. It is
   never echoed. Azure wants three character classes, so the block checks
   for an upper-case letter, a lower-case letter and a digit. Staging's
   step 1 grant is not needed: this apply grants you Secrets Officer on the
   new vault.

   ```bash
   for _ in 1 2 3 4 5; do
     pw=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')
     [[ $pw =~ [[:upper:]] && $pw =~ [[:lower:]] && $pw =~ [[:digit:]] ]] && break
     pw=""
   done
   ip=$(curl -s https://api.ipify.org)
   me=$(az ad signed-in-user show --query id -o tsv)
   echo "ip=$ip me=$me pw-length=${#pw}"   # all three must be non-empty
   [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     PG_ADMIN_PASSWORD="$pw" DEPLOYER_OBJECT_ID="$me" DEV_MACHINE_IP="$ip" \
     az deployment group what-if -g $RG -p infra/platform.$ENV.bicepparam
   ```

   Read every line of the what-if (TYRE-402) before the apply:
   - `psql-tyre-prod` shows `backupRetentionDays` 30, `geoRedundantBackup`
     `Enabled`, and `maintenanceWindow` with `customWindow` `Enabled`,
     `dayOfWeek` 0, `startHour` 0 and `startMinute` 0.
   - The two `CanNotDelete` locks are listed, `lock-psql-tyre-prod` and
     `lock-sttyreprod`.
   - The AcrPull assignment for `id-tyre-api-prod` is a Create in
     `rg-tyre-staging`, on `crtyrestaging`.
   - Into an empty resource group, every line is a Create. Stop on any
     Delete or Modify, and on any Create outside `rg-tyre-prod` other than
     that AcrPull assignment.

   A later re-apply is read the way staging's step 4 says. Then apply:

   **Geo-redundant backup is fixed at this apply. Changing it later means
   rebuilding the server.**

   ```bash
   [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     PG_ADMIN_PASSWORD="$pw" DEPLOYER_OBJECT_ID="$me" DEV_MACHINE_IP="$ip" \
     az deployment group create -g $RG -n platform-$(date +%Y%m%d%H%M) \
       -p infra/platform.$ENV.bicepparam -o none
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   ```

   Expect `PGCRYPTO,BTREE_GIST` (order may differ). Keep `pw` in this shell.

4. **The admin password secret.**

   ```bash
   [ -n "$pw" ] && az keyvault secret set --vault-name $KV -n psql-admin-password --value="$pw" -o none \
     && unset pw
   ```

   `--value=` keeps its equals sign in this step and the next: about one
   generated password in 64 starts with `-`, which the CLI would read as a
   flag. On Forbidden, the Secrets Officer grant has not taken effect yet:
   wait a few minutes and re-run. If the shell was lost and `pw` with it,
   generate a new password and re-run step 3's apply block, which sets the
   admin's password to it.

5. **Migrate, then `app_login`'s secrets.** Migration 000001 creates
   `app_login`, so its password can only be set after the migrate.
   - Run **Each release** steps 1 to 4 with `ENV=prod`, from a checkout of
     the commit step 7 will promote (`git switch --detach <sha>`). Nothing
     is dropped and no tenant is created.
   - Then set `app_login`'s password as `tyreadmin`. psql interpolates
     `:'apppw'` only on stdin, never inside `-c`, so the statement is piped
     in. Each write runs only if the one before it succeeded:

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   apppw=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')
   enc=$(python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$apppw")
   echo "pw-length=${#pw} apppw-length=${#apppw} enc-length=${#enc}"   # all three must be non-zero
   [ -n "$pw" ] && [ -n "$apppw" ] && [ -n "$enc" ] && \
     echo "ALTER ROLE app_login PASSWORD :'apppw';" | \
     docker run --rm -i -e PGPASSWORD="$pw" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea psql \
       "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" \
       -v ON_ERROR_STOP=1 -v apppw="$apppw" -q && \
     az keyvault secret set --vault-name $KV -n pg-app-login-password --value="$apppw" -o none && \
     az keyvault secret set --vault-name $KV -n database-url \
       --value "postgres://app_login:$enc@$PG.postgres.database.azure.com:5432/tyre?sslmode=require" -o none && \
     echo "app_login's password and both secrets are set"
   unset pw apppw enc
   ```

   `database-url` names no `pool_max_conns` (PR #5's form, TYRE-23; the
   pool is the API's own, TYRE-305).

   If the block does not print its last line, re-run the whole block. A
   write that failed after the `ALTER ROLE` leaves `app_login` with a
   password the closing `unset` has thrown away, and the re-run sets a new
   one and writes both secrets again.

   Then prove all three secrets with staging's step 2 block, under
   `ENV=prod`: the three secret names, `app_login f f f f`,
   `database-url names no pool_max_conns` and
   `database-url names psql-tyre-prod`. This proof is not optional.
   `tyreadmin` has `rolbypassrls` true (TYRE-305 comment 13834), so an admin
   DSN in `database-url` would run the API outside RLS (CLAUDE.md rule 1).

6. **Sign-in and maintenance notices.**

   Sign-in: add production's web origin to tyre-pwa's SPA redirect URIs.
   No record says how staging's origin was added, so use the Entra admin
   center for the TyrePlatform tenant, and keep staging's origin and
   localhost. Then read the list back from the CIAM tenant:

   ```bash
   az staticwebapp show -g $RG -n stapp-tyre-$ENV --query defaultHostname -o tsv
   # add https://<that host>/ in the Entra admin center, then:
   az login --tenant 9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19 --allow-no-subscriptions
   az ad app show --id 15552f43-eb78-438b-9c3d-809c5024e25e --query spa.redirectUris
   az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
   az account set --subscription 5a61b832-e331-4529-95ed-ae7b07a9697d
   ```

   The list holds `http://localhost:5173/`, staging's origin and
   production's, each followed by `/` (`provision-a-user.md`, tyre-pwa).

   Maintenance notices: Azure emails a planned maintenance notice five days
   ahead through Service Health. List the subscription's activity log
   alerts and read their conditions:

   ```bash
   az monitor activity-log alert list --query "[].{name:name, rg:resourceGroup, enabled:enabled, conditions:condition.allOf}" -o json
   ```

   An enabled alert whose conditions are `category` `ServiceHealth` with
   no narrower `incidentType` than `Maintenance`, scoped to the
   subscription, already covers production's server. If none does, create
   one that emails the address staging's budget alerts go to:

   ```bash
   sub=$(az account show --query id -o tsv)
   src=""
   for scope in "/subscriptions/$sub/resourceGroups/rg-tyre-staging" "/subscriptions/$sub"; do
     az rest --method get --url "$scope/providers/Microsoft.Consumption/budgets/budget-tyre-staging?api-version=2023-05-01" \
       -o none 2>/dev/null && { src=$scope; break; }
   done
   [ -n "$src" ] && az rest --method get \
     --url "$src/providers/Microsoft.Consumption/budgets/budget-tyre-staging?api-version=2023-05-01" \
     --query "properties.notifications.*.contactEmails[]" -o tsv | sort -u
   email=   # type the address the list shows
   [ -n "$email" ] && \
     az monitor action-group create -g $RG -n ag-tyre-owner --short-name tyreowner \
       --action email owner "$email" -o none && \
     az monitor activity-log alert create -g $RG -n alert-tyre-maintenance \
       --condition category=ServiceHealth and properties.incidentType=Maintenance \
       --scope "/subscriptions/$sub" \
       --action-group "$(az monitor action-group show -g $RG -n ag-tyre-owner --query id -o tsv)" \
       --description "Azure planned maintenance, including psql-tyre-prod (NFR-AVL-003)" -o none
   ```

   Pass each notice for `psql-tyre-prod` to BAC at least 48 hours ahead
   (NFR-AVL-003). The server's own window is Sunday 00:00 to 01:00 UTC,
   02:00 to 03:00 SAST. A critical security update can arrive with less
   notice or none.

7. **The first release.** **Promote to production**, below, with a commit
   at or after TYRE-397's merge. Images from before it carry no staging
   record, so the deploy refuses them.

8. **Verify and record** (TYRE-397 spec, section 5). Each of these must
   hold:
   - CI's `deploy-prod` jobs are green: the guard, staging's record, the
     gate, the bundle checks and the smoke.
   - Each release step 3 with `ENV=prod` shows the commit's highest
     migration, not dirty.
   - Signing in at `https://<host>/` with the staging test account shows
     "Your account is not set up" (`ACCESS_COPY` in
     `web/src/auth/actorContext.ts`), and `/api/me` answers 403 in the
     browser's network tab. Production has no tenant, so staging's
     account names one it does not have: the two environments are
     isolated.
   - The NFR-BAK settings read live:

   ```bash
   az postgres flexible-server show -g $RG -n $PG --query "{retention: backup.backupRetentionDays, geo: backup.geoRedundantBackup, window: maintenanceWindow}" -o json
   az storage account blob-service-properties show --account-name sttyre$ENV -g $RG --query "{versioning: isVersioningEnabled, blobDays: deleteRetentionPolicy.days, containerDays: containerDeleteRetentionPolicy.days}" -o json
   az lock list -g $RG -o table
   az containerapp show -g $RG -n ca-api-$ENV --query properties.template.scale.minReplicas -o tsv
   ```

   Expect retention 30, geo `Enabled` and the window `Enabled`, 0, 0, 0,
   which the portal's Maintenance blade shows as Sunday 00:00 UTC; then
   `true`, 30 and 30; then two `CanNotDelete` locks; then `1`.

   Then record the first row (Each release step 5, `ENV=prod`).

## Each release

Staging runs it from the repo root on a clean checkout of `develop` that
includes the merge commit, never from a feature branch. Production runs it
from a checkout of exactly the commit being promoted (Promote to
production). Either way, the migrate reads that checkout's
`db/migrations`, and step 3's check of the highest migration number reads
it too. Staging's bring-up before the TYRE-79 merge is the one exception,
and the top of One-time bring-up: staging says why.

**When to migrate.** Every merge to `develop` deploys staging, and the
migrate is a manual step (U94). Run **Each release** straight after a merge
whose PR carries a migration, once its deploy has gone green.

Until then, the new image runs against the old schema. `/readyz` only
pings, so the gate does not see that, and requests that need the new schema
fail. Staging holds no real data (ADR-0017), so that window is accepted.

Migrating before the merge is not allowed. A migration stays editable on
its feature branch, so a review fix, a renumbering on rebase or an abandoned
PR would leave staging at a version `develop` never had.

Production has real data, so it migrates first and is promoted after:
**Promote to production**, below.

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
   `(dirty)`; or a version that is not the highest number under this
   checkout's `db/migrations/`. Recovering a dirty version is a decision for
   the owner, never a reflexive `force`.

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   enc=$(python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$pw")
   docker run --rm -v "$(pwd)/db/migrations:/migrations" \
     migrate/migrate:v4.19.1@sha256:cc4ad8e19d66791e3689405d9a028ce6e9614f32032db14acda1469f7201d6e4 \
     -path=/migrations -database "postgres://tyreadmin:$enc@$PG.postgres.database.azure.com:5432/tyre?sslmode=require" version
   ls db/migrations | tail -1
   unset pw enc
   ```

4. **The 000051 and 000054 checks, and `database-url`** (TYRE-368 comment 13439, TYRE-299). As `tyreadmin`:

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   docker run --rm -e PGPASSWORD="$pw" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea psql \
     "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" -At \
     -c "SELECT proowner::regrole, proacl FROM pg_proc WHERE oid = 'app.refresh_governing_tread()'::regprocedure;" \
     -c "SELECT has_function_privilege('app_login', 'app.refresh_governing_tread()', 'EXECUTE');" \
     -c "SELECT has_any_column_privilege('app_login', 'app.threshold_policy', 'UPDATE');"
   unset pw
   ```

   The ACL holds only the owner's entry, and the second and third queries
   return `f`. Otherwise the release stops. The third reads
   `has_any_column_privilege` so a column-level grant fails it too, as suite
   check 4 does.

   Then run the block of One-time bring-up: staging, step 2, under this
   `ENV`, and expect what it lists. Every release proves `database-url`
   again, because a hand rotation to the admin's DSN would run the API
   outside RLS (CLAUDE.md rule 1) with every gate green.

5. **Record the release** in the release table on Confluence page 10682399
   (U118): date, environment, image, schema version and dirty flag, who
   ran it. Production runs its image by digest (U140), so its row also
   names the promoted commit. The image, read live:

   ```bash
   az containerapp show -g $RG -n ca-api-$ENV --query "properties.template.containers[0].image" -o tsv
   ```

The suite (`db/tests/004_tests.sql`) never runs against a deployed
environment (TYRE-374, U92).

## Promote to production

New code needs the new tables, so production's database moves first, and
the code production still runs copes with the newer tables for the few
minutes until the new code lands. The deploy refuses a commit that is not
on `develop` and an image staging did not pass, but it does not read
production's schema yet (TYRE-434).

1. **Choose the commit.** `sha` is a full `develop` commit that staging ran
   green:

   ```bash
   sha=   # the full 40-character SHA
   git fetch origin
   git merge-base --is-ancestor "$sha" origin/develop && \
     git merge-base --is-ancestor origin/main "$sha" && echo "on develop and ahead of main"
   az acr repository show-tags -n crtyrestaging --repository tyre-api --query "[?@=='$sha-staging-passed']" -o tsv
   ```

   The first must print `on develop and ahead of main`, and the second the
   tag `<sha>-staging-passed`, which staging's deploy writes only in the
   commit's own run, after its gate and smoke pass against that image; it
   is the check production's deploy makes. A staging rollback writes none. Then, on
   a clean tree, `git switch --detach "$sha"`. Each release step 3 compares
   the version against the current checkout's `db/migrations`, so every
   version read from here to step 2 runs on this checkout.

   Staging's version must be at or above that checkout's highest
   migration: run Each release step 3 with
   `ENV=staging; RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV`
   (step 1 first if staging's server is stopped). If it is below, run
   Each release on staging from `develop` first.

2. **Migrate production first if it is behind.**
   - **The release window comes first, because it gates the migrate.** A
     release carries a migration when this lists a file:

     ```bash
     git diff --name-only --diff-filter=A origin/main "$sha" -- db/migrations
     echo "SAST hour: $(( (10#$(date -u +%H) + 2) % 24 ))"
     ```

     Such a release, migrate and push alike, runs outside 06:00 to 18:00
     SAST (NFR-AVL-003): stop if the hour is from 6 to 17. A release
     expected to interrupt service is announced to BAC 48 hours ahead. A
     release without a migration may go out at any time, because Container
     Apps keeps the old revision serving until the new one is ready.
     Production bring-up's first release is exempt: it migrates an empty
     database that no one uses yet, and the diff against `main` would list
     every migration.
   - Still on the `$sha` checkout, set
     `ENV=prod; RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV` and run
     Each release steps 1 to 4. If step 3's first read shows production
     already at the checkout's highest migration, step 2 changes nothing.
     Stop on anything step 3 stops on. Then `git switch -`.

3. **Fast-forward `main`:** `git push origin "$sha":main`, never through a
   pull request (ADR-0004). A pull request into `main` is closed
   automatically (TYRE-313).

4. **CI on `main` deploys production.** Watch it:

   ```bash
   gh run list -R Rourke9001/TyrePlatform --branch main --commit "$sha" --workflow CI
   ```

   The `deploy-prod` jobs' gate and smoke must pass.

5. **Record the release** (Each release step 5, `ENV=prod`, U118).

Close-out's step 7 follows this section when the owner asks, but never
migrates production: it stops where step 2 would be needed, and lists the
migrate for the owner (`.claude/commands/close-out.md`).

**What this order rests on.** Every migration leaves the schema usable by
the image production is running. One that cannot, such as a dropped or
renamed column the running code reads, ships in two releases. The pull
request template asks this of every PR that adds a migration, and TYRE-434
adds the automatic check.

## Roll back

A rollback is a dispatch of **Deploy** from the repo's Actions tab with
`target` and `image_sha`:

- **Staging:** run it from `develop` with `target` staging and `image_sha`
  set to the full SHA of a commit this pipeline deployed after the TYRE-79
  merge (earlier images have no `/readyz` and fail the gate).
- **Production:** run it from `main` with `target` prod and `image_sha`
  set to the full SHA of a commit on `main`, at or after TYRE-397's merge,
  that staging passed. The deploy refuses any other. Record it as a
  rollback in the release table (Each release step 5).

Either redeploys that image under the branch's current template, and
rebuilds the web from that commit too; a template change that must be
undone is a revert on `develop`, promoted for production. A rollback runs
no down migration, so the schema stays at head, and an old image must
tolerate it.

Re-running an old run never rolls back (TYRE-403). A re-run whose commit
is no longer its branch's head is refused, and going back is only by this
dispatch.

A rollback to a commit from before TYRE-51 ships a web with no `config.json`
handling. That web calls a relative `/api` and 404s, and the web job's smoke
fails, since the commit has no `scripts/deploy-smoke.sh`. This is accepted
while nobody signs in to staging (TYRE-51 spec, What the owner does after
merge).
