# Release an environment

The owner's runbook for both environments: staging (TYRE-368 and TYRE-79,
spec `docs/superpowers/specs/2026-10-09-staging-deploy-path-design.md`,
section 4) and production (TYRE-397, spec
`docs/superpowers/specs/2026-10-19-production-environment-design.md`).
`ENV` names the environment in every command: `staging` or `prod`. Every
`az` write here is the owner's. CI never runs these.

Run every block in Git Bash, from the repo root, in one shell: the `infra/`
and `db/migrations` paths are relative, and later blocks use the `ENV`,
`RG`, `PG`, `KV` and `KVAPI` the first one sets. That block also exports
`MSYS_NO_PATHCONV=1`, because Git Bash otherwise rewrites the `-v` mount,
`-path=/migrations` and `/subscriptions/...` arguments into Windows paths.
In a new shell, run **Before anything** again first.

Run a release from its own worktree, never from a checkout another session
shares: `git worktree add --detach ../TyrePlatform-release origin/develop`,
then `cd` there. Another session's `git switch` moves a shared checkout
between two of your blocks (`docs/lessons.md`, 2026-10-20).

## Before anything

```bash
export MSYS_NO_PATHCONV=1
az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
az account show --query "{subscription:id, tenant:tenantId}" -o table
ENV=staging   # or prod
RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV; KVAPI=kv-tyre-api-$ENV
```

The subscription must be `5a61b832-e331-4529-95ed-ae7b07a9697d`. If
`az account show` shows another one, run
`az account set --subscription 5a61b832-e331-4529-95ed-ae7b07a9697d`. The
CLI's default tenant is the CIAM one, which has no subscription. Both
environments live in this subscription (ADR-0017).

`KV` is the owner's vault and holds the two passwords; `KVAPI` is the
API's and holds `database-url` alone (TYRE-435).

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
   connection whatever `database-url` holds. `$KV` must hold the two
   passwords and `$KVAPI` only `database-url`, and `database-url` must
   connect as `app_login`, which is not a superuser, does not bypass RLS and
   is a member of neither `tyreadmin` nor `azure_pg_admin` (CLAUDE.md
   rule 1). Roles outlive the database drop in step 5, so a hand change
   from an earlier bring-up would survive it:

   ```bash
   [ "$KV" = "kv-tyre-$ENV" ] && [ "$KVAPI" = "kv-tyre-api-$ENV" ] && echo "vaults match $ENV" || echo "vaults do not match $ENV"
   az keyvault secret list --vault-name $KV --query "[].name" -o tsv
   az keyvault secret list --vault-name $KVAPI --query "[].name" -o tsv
   dsn=$(az keyvault secret show --vault-name $KVAPI -n database-url --query value -o tsv)
   docker run --rm -e DSN="$dsn" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea sh -c \
     'psql "$DSN" -At -F " " -c "SELECT current_user, rolsuper, rolbypassrls, pg_has_role(current_user, '"'tyreadmin'"', '"'MEMBER'"'), pg_has_role(current_user, '"'azure_pg_admin'"', '"'MEMBER'"') FROM pg_roles WHERE rolname = current_user;"'
   case "$dsn" in *pool_max_conns*) echo "database-url names pool_max_conns" ;; *) echo "database-url names no pool_max_conns" ;; esac
   case "$dsn" in *"@$PG.postgres.database.azure.com"[:/]*) echo "database-url names $PG" ;; *) echo "database-url does not name $PG" ;; esac
   unset dsn
   ```

   The first line must be `vaults match <env>`. On `vaults do not match`,
   stop and run Before anything again: every read below follows the two
   variables, so a name left in the shell from the other environment
   proves that environment's vault instead. The first list must show `psql-admin-password` and
   `pg-app-login-password`, and no `database-url`. The second must show
   `database-url` and nothing else, because the API can read whatever its
   vault holds. Then expect `app_login f f f f`. Anything else stops the
   bring-up: a revision cannot activate without a working `database-url`.
   Judge a failed connection only after Each release step 1 has run. The
   last line must be `database-url names psql-tyre-<env>`: an `app_login`
   on the other environment's server passes the role check too.

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

   After every platform apply, list the API identity's roles:

   ```bash
   apid=$(az identity show -g $RG -n id-tyre-api-$ENV --query principalId -o tsv)
   echo "apid=$apid"   # must be non-empty
   [ -n "$apid" ] && az role assignment list --assignee-object-id "$apid" --all --include-groups \
     --query "[].{role:roleDefinitionName, scope:scope}" -o table
   ```

   Expect exactly two rows: `AcrPull` on `crtyrestaging`, and
   `Key Vault Secrets User` on `kv-tyre-api-<env>`. Any other row stops the
   release: a role on `kv-tyre-<env>` lets the API read the admin password,
   which bypasses RLS (TYRE-435, CLAUDE.md rule 1). `--include-groups`
   also lists a role the identity holds through a group, which a direct
   listing misses.

   After TYRE-402, the what-if must show no Create or Delete of the API
   identity's AcrPull assignment on `crtyrestaging`: the grant moved into
   the `acr-pull.bicep` module with the same name, so either means the name
   drifted. Stop and fix the template before applying. A Modify of its
   `principalId` to a `reference(...)` is noise, listed below.

   **Staging's what-if noise**, read on 20 Oct 2026 from `develop` at
   `8d92270`, after TYRE-435's switch-over: seven Modifies and nothing
   else. They are `cae-tyre-staging` (`peerAuthentication`,
   `peerTrafficConfiguration`, `customerId`), the API identity's two role
   assignments, AcrPull on `crtyrestaging` and Secrets User on
   `kv-tyre-api-staging` (`principalId`, `principalType`),
   `psql-tyre-staging` (read-only properties), `blobServices/default`
   (`allowPermanentDelete`), the `photos` container (encryption scope) and
   `stapp-tyre-staging` (its repository properties). Anything beyond them is
   a real change: read it before applying. Staging's first apply after
   TYRE-397, which added the blob protections, ran on 20 Oct 2026 as step 0
   of the switch-over below.

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

### Switching staging to the API's own vault (TYRE-435)

Done on 20 Oct 2026 (TYRE-435 comments 13861 and 13865). The steps stay
as the record of how a vault split reaches a running environment, and they
are not run again.

Staging's API moves to `kv-tyre-api-staging` around the TYRE-435 merge
(spec `docs/superpowers/specs/2026-10-19-api-own-vault-design.md`,
section 4.2). Every merge to `develop` applies `infra/app.bicep`, and from
that merge on it names the new vault. So the vault, its grant and its
secret exist, and the API identity has read the secret from the new vault,
before the merge. The old grant goes only after the merge's deploy is
green: until then it keeps any other deploy to staging working. The branch,
`TYRE-435-scope-api-vault-grant`, adds no migration. Its PR stays a draft
until steps 0 to 2 are done.

0. **Staging's first apply after TYRE-397**, from `develop` as it stood
   before the TYRE-435 merge, if it has not run. Its what-if was read
   against a baseline from the parent of TYRE-397's spec commit, in that
   template's own form (`-f infra/platform.bicep -p env=$ENV ...`), and the
   two runs differed only in the Modify of `blobServices/default`. It has
   run when
   `az storage account blob-service-properties show --account-name sttyre$ENV -g $RG --query isVersioningEnabled -o tsv`
   prints `true`. If it runs, its role listing shows two rows here:
   `AcrPull` on `crtyrestaging` and `Key Vault Secrets User` on
   `kv-tyre-staging`. Any other row stops.

1. **Apply from the branch**, once stage 5 shows no open Critical or
   Important finding and before the merge. First:

   ```bash
   git fetch origin
   git switch TYRE-435-scope-api-vault-grant
   git merge-base --is-ancestor origin/develop HEAD && echo "the branch contains develop"
   [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/TYRE-435-scope-api-vault-grant)" ] && [ -z "$(git status --porcelain)" ] && echo "the branch matches origin and is clean"
   ```

   It must print both lines. If the first is missing, rebase onto
   `origin/develop`, push with `git push --force-with-lease`, and re-run
   this block. If the rebase brought in a change to `infra/`, stage 5 runs
   again first. If only the second line is missing, `git status` says why:
   stash a local edit, or run `git pull --ff-only` if origin is ahead. An
   edit you mean to keep goes on the PR and through stage 5 first, because
   the apply must be of the reviewed branch. Do not apply until both lines
   print: an apply from a stale or edited checkout puts a `platform.bicep`
   on staging that the PR does not hold.

   If the PR merged before this step, the first line can never print. Cancel
   the merge's `develop` run while it is still queued (`gh run cancel <id>`),
   so its deploy never applies `infra/app.bicep`. Apply from the merge
   commit once `git diff --quiet <reviewed head> HEAD -- infra` succeeds,
   run step 2, and then `gh run rerun <id>` as step 3's deploy
   (`docs/lessons.md`, 2026-10-20).

   Then run the branch's **Before anything** again, so `KVAPI` is set:
   step 0 ran under `develop`'s, which sets none. Then run bring-up step 4's
   block in what-if form twice, from `git switch --detach origin/develop`
   and then from the branch again
   (`git switch TYRE-435-scope-api-vault-grant`). The branch's run adds
   three Creates, `kv-tyre-api-staging` and two role assignments on it, and
   no Delete or Modify beyond the first run's. The API identity's
   assignment on `kv-tyre-staging` is absent from the branch's run, or
   shows as Ignore: the template does not declare it. Anything else stops.
   Then run bring-up step 4's apply block from the branch, and its role
   listing, which shows three rows here: the two expected ones and Secrets
   User on `kv-tyre-staging`. If a later review fix changes
   `infra/platform.bicep`, run this step again before the merge.

2. **Copy `database-url`, then read it as the API identity.**

   ```bash
   dsn=$(az keyvault secret show --vault-name $KV -n database-url --query value -o tsv)
   echo "KV=$KV KVAPI=$KVAPI dsn-length=${#dsn}"   # kv-tyre-staging, kv-tyre-api-staging, then a non-zero length
   [ "$KV" = "kv-tyre-$ENV" ] && [ "$KVAPI" = "kv-tyre-api-$ENV" ] && [ -n "$dsn" ] && \
     az keyvault secret set --vault-name $KVAPI -n database-url --value="$dsn" -o none && \
     copy=$(az keyvault secret show --vault-name $KVAPI -n database-url --query value -o tsv) && \
     { [ "$copy" = "$dsn" ] && echo "database-url copies match" || echo "database-url copies differ"; }
   unset dsn copy
   ```

   Expect `database-url copies match`. On `database-url copies differ`,
   stop and do not merge: re-run the block, and if the copies still
   differ, post on TYRE-435. A Forbidden on the write means the new Secrets
   Officer grant is not in force yet: wait a few minutes and re-run. Then
   run bring-up step 2's secrets proof, where `kv-tyre-staging` still lists
   `database-url` too until step 4.

   Then create the proof job and run it once (the blocks after this list),
   at least ten minutes after step 1's apply. Expect the execution to be
   `Failed` with `psql-admin-password: READ` and
   `database-url: HTTP 200, length <n>`. The `READ` is the defect, seen as
   the API identity, and shows the job can see a read. The `200` shows the
   API identity reads the new vault before the merge relies on it: a
   container app's secrets belong to the app, not to a revision, so a
   reference that fails is not something to find out at the merge. If the
   `database-url` line shows `HTTP 403`, the new grant is not in force yet:
   wait ten minutes and run the job again. Any other HTTP code stops: keep
   the PR a draft and post the log on TYRE-435. A run that shows
   `psql-admin-password: refused`, or no log lines at all, means the
   control failed: check `KV=` in the creation block's echo line and the
   role listing, post on TYRE-435, and stop.

   Keep this run's execution name, status and log lines: post them on
   TYRE-435 now, or paste them into the draft of step 4's comment. The
   lines stay in the workspace, but step 4 usually runs days later, beyond
   the log query's `ago(2h)`: widen it if you need them again. Keep the job
   until step 4. Then mark the PR ready for review.

3. **Merge.** A green deploy means a revision started with `DATABASE_URL`
   resolved from `kv-tyre-api-staging`. Confirm the reference it runs:

   ```bash
   az containerapp show -g $RG -n ca-api-$ENV --query "properties.configuration.secrets[?name=='database-url'].keyVaultUrl" -o tsv
   ```

   Expect `https://kv-tyre-api-staging.vault.azure.net/secrets/database-url`.
   If the deploy is red, or the URL is any other, stop: keep the old grant
   and secret in place, and post on TYRE-435. The old grant is what keeps
   other deploys to staging working.

   Until step 4, Each release on staging finds `database-url` in both
   vaults, and the role listing after a platform apply shows three rows.
   Both are expected in this window only.

4. **After the deploy is green: the removals, then the proof again.** In
   this order:
   - Delete the old grant. The block checks that `$KV` is the owner's
     vault, because a list scoped to either vault shows exactly one row,
     and counts the rows rather than leaving the count to the eye:

     ```bash
     revoked=
     apid=$(az identity show -g $RG -n id-tyre-api-$ENV --query principalId -o tsv)
     kvid=$(az keyvault show -n $KV --query id -o tsv)
     echo "apid=$apid kvid=$kvid"   # both non-empty, and kvid ends in /vaults/kv-tyre-<env>
     case "$kvid" in */vaults/kv-tyre-$ENV) ;; *) echo "not the owner's vault"; kvid="" ;; esac
     [ -n "$apid" ] && [ -n "$kvid" ] && \
       az role assignment list --assignee-object-id "$apid" --role "Key Vault Secrets User" --scope "$kvid" -o table
     n=$([ -n "$apid" ] && [ -n "$kvid" ] && az role assignment list --assignee-object-id "$apid" \
       --role "Key Vault Secrets User" --scope "$kvid" --query "length(@)" -o tsv)
     echo "rows=$n"   # must be 1
     [ "$n" = 1 ] && az role assignment delete --assignee-object-id "$apid" --role "Key Vault Secrets User" --scope "$kvid" && \
       revoked=1 && echo "old grant deleted"
     ```

     The one row's scope ends in `/vaults/kv-tyre-staging`. On any other
     `rows=`, stop and delete nothing: post the listing on TYRE-435.
   - Delete the old secret, in the same shell and after the block above,
     which sets `revoked` only once it has deleted the one grant on the
     owner's vault:
     `[ "${revoked:-}" = 1 ] && az keyvault secret delete --vault-name $KV -n database-url -o none && echo "old secret deleted"`.
     If the block did not print `old grant deleted`, this deletes nothing
     and prints nothing.
     Soft delete keeps it for 7 days, recoverable only by a Secrets
     Officer, which the API identity is not. No purge.
   - Wait ten minutes ("allow several minutes for role assignments to
     refresh", Key Vault RBAC guide), then run the job again. Ten minutes
     is enough, not the 24 hours the Container Apps managed identity page
     mentions: that cache holds tokens, and Key Vault checks the role
     assignment on each request, so a cached token carries no role. Expect
     `Succeeded` with `psql-admin-password: refused` and
     `database-url: HTTP 200, length <n>`, `<n>` as in step 2. A `READ`
     after a further ten minutes is a finding: stop and post it on
     TYRE-435.
   - Read this run's log lines (the log block after this list) and keep
     them with its execution name and status. Then delete the job:
     `az containerapp job delete -g $RG -n job-tyre-kv-proof --yes -o none`.
   - Run bring-up step 2's secrets proof and bring-up step 4's role
     listing, both with their usual expectations: `database-url` only in
     `kv-tyre-api-staging`, and two rows.
   - Post on TYRE-435: both executions' statuses and log lines, the
     listing, the secrets proof's names, and the merge's deploy run. The
     first execution's lines are the ones step 2 kept.

**The proof job.** The API image is distroless with no shell, so the proof
cannot run inside the API (TYRE-435 spec, section 4.4). It runs as a
one-off Container Apps job with the API identity attached. Every value is
checked, and the guard keeps it on staging. The script goes to a temporary
file through a quoted heredoc, so nothing in it expands in your shell:

```bash
sub=$(az account show --query id -o tsv)
apiid=$(az identity show -g $RG -n id-tyre-api-$ENV --query id -o tsv)
apicid=$(az identity show -g $RG -n id-tyre-api-$ENV --query clientId -o tsv)
caeid=$(az containerapp env show -g $RG -n cae-tyre-$ENV --query id -o tsv)
echo "MSYS_NO_PATHCONV=$MSYS_NO_PATHCONV KV=$KV KVAPI=$KVAPI sub=$sub apiid=$apiid apicid=$apicid caeid=$caeid"   # 1, kv-tyre-staging, kv-tyre-api-staging, then four non-empty values
s=$(cygpath -m "$(mktemp)"); f=$(cygpath -m "$(mktemp)")
cat > "$s" <<'EOF'
set -u
tok=$(curl -s -H "X-IDENTITY-HEADER: $IDENTITY_HEADER" \
  "$IDENTITY_ENDPOINT?resource=https://vault.azure.net&api-version=2019-08-01&client_id=$API_CLIENT_ID" |
  jq -r '.access_token // empty')
[ -n "$tok" ] || { echo "no token for the API identity"; exit 2; }
admin=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $tok" \
  "https://$KV_OWNER.vault.azure.net/secrets/psql-admin-password?api-version=7.4")
api=$(curl -s -o /tmp/api.json -w '%{http_code}' -H "Authorization: Bearer $tok" \
  "https://$KV_API.vault.azure.net/secrets/database-url?api-version=7.4")
len=$(jq -r '.value // "" | length' /tmp/api.json 2>/dev/null)
rm -f /tmp/api.json
case $admin in
  403) echo "psql-admin-password: refused" ;;
  200) echo "psql-admin-password: READ" ;;
  *) echo "psql-admin-password: HTTP $admin" ;;
esac
echo "database-url: HTTP $api, length ${len:-0}"
[ "$admin" = 403 ] && [ "$api" = 200 ] && [ "${len:-0}" -gt 0 ]
EOF
[ "$ENV" = staging ] && [ "$MSYS_NO_PATHCONV" = 1 ] && [ "$KV" = "kv-tyre-$ENV" ] && [ "$KVAPI" = "kv-tyre-api-$ENV" ] && \
  [ -n "$sub" ] && [ -n "$apiid" ] && [ -n "$apicid" ] && [ -n "$caeid" ] && \
python -c 'import json, sys; \
s, f, apiid, apicid, caeid, kv, kvapi = sys.argv[1:]; \
env = [{"name": "API_CLIENT_ID", "value": apicid}, {"name": "KV_OWNER", "value": kv}, {"name": "KV_API", "value": kvapi}]; \
job = {"location": "southafricanorth", \
  "identity": {"type": "UserAssigned", "userAssignedIdentities": {apiid: {}}}, \
  "properties": {"environmentId": caeid, \
    "configuration": {"triggerType": "Manual", "replicaTimeout": 300, "replicaRetryLimit": 0, \
      "manualTriggerConfig": {"parallelism": 1, "replicaCompletionCount": 1}}, \
    "template": {"containers": [{"name": "job-tyre-kv-proof", \
      "image": "mcr.microsoft.com/azure-cli:2.91.0@sha256:933eb8dcb81aecb6f77e03c5b8660f0a1dfa9e1d16525763a27f86ff3b83a044", \
      "command": ["/bin/bash", "-c", open(s).read().replace("\r", "")], \
      "env": env, "resources": {"cpu": 0.25, "memory": "0.5Gi"}}]}}}; \
json.dump(job, open(f, "w")); print("job body written")' \
  "$s" "$f" "$apiid" "$apicid" "$caeid" "$KV" "$KVAPI" && \
az rest --method put \
  --url "/subscriptions/$sub/resourceGroups/$RG/providers/Microsoft.App/jobs/job-tyre-kv-proof?api-version=2024-03-01" \
  --body @"$f" -o none
rm -f "$s" "$f"
az containerapp job show -g $RG -n job-tyre-kv-proof --query properties.provisioningState -o tsv
```

Expect `job body written`, then re-run the last line until it prints
`Succeeded`. On `Failed`, post the error on TYRE-435 and stop. Any other
state means Azure is still provisioning the job: wait and read it again.

The job and its container are both named `job-tyre-kv-proof`, which the
log query below relies on. The image is pinned by digest, as the runbook's other
images are. The admin password's response body goes to `/dev/null`, so
its value is never stored or printed, and the API's secret is reduced to a
length.

Each run of the job:

```bash
ex=$(az containerapp job start -g $RG -n job-tyre-kv-proof --query name -o tsv)
echo "execution=$ex"   # must be non-empty
[ -n "$ex" ] && az containerapp job execution show -g $RG -n job-tyre-kv-proof \
  --job-execution-name "$ex" --query properties.status -o tsv
```

Re-run the last command until it prints `Succeeded` or `Failed`. On
step 4's run the status is the verdict: `Succeeded` only on `refused` with
a non-empty `database-url`, so the log is evidence rather than the test.
On step 2's run `Failed` is expected, so the log lines are the test. If
`ex` comes back empty, list the executions instead:
`az containerapp job execution list -g $RG -n job-tyre-kv-proof --query "[].{name:name, status:properties.status, start:properties.startTime}" -o table`.

Then read the log from the workspace, a few minutes after the run ends.
Your CLI has no `az containerapp job logs` (checked 19 Oct 2026 on
2.88.0):

```bash
wid=$(az monitor log-analytics workspace show -g $RG -n log-tyre-$ENV --query customerId -o tsv)
[ -n "$wid" ] && az monitor log-analytics query -w "$wid" -o tsv --analytics-query \
  "ContainerAppConsoleLogs_CL | where (ContainerName_s == 'job-tyre-kv-proof' or ContainerGroupName_s startswith 'job-tyre-kv-proof') and TimeGenerated > ago(2h) | order by TimeGenerated asc | project TimeGenerated, ContainerGroupName_s, Log_s"
```

The query matches either the container's name or the replica's
`ContainerGroupName_s`, which starts with the execution's name and so with
the job's. Microsoft's jobs quickstart filters on the second ("Create a job
in Azure Container Apps", Query job run logs). The execution's name tells
the two runs' lines apart. `no token for the API identity`, or
an `IDENTITY_HEADER` unbound error, means the job got no identity endpoint:
stop and post the log on TYRE-435.

## Production bring-up

The owner runs this after TYRE-435 merges (U141), from a checkout at or
after that merge, with `ENV=prod` set in Before anything. Production starts
empty: no tenant is created here, and BAC's account is made at TYRE-321's
live onboarding (U139). A new production has no vault and no secrets
before its first platform apply, so the order differs from staging's.

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
   step 1 grant is not needed: this apply grants you Secrets Officer on both
   new vaults, `kv-tyre-prod` and `kv-tyre-api-prod`.

   ```bash
   for _ in 1 2 3 4 5; do
     pw=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')
     [[ $pw =~ [[:upper:]] && $pw =~ [[:lower:]] && $pw =~ [[:digit:]] ]] && break
     pw=""
   done
   ip=$(curl -s https://api.ipify.org)
   me=$(az ad signed-in-user show --query id -o tsv)
   echo "ENV=$ENV RG=$RG ip=$ip me=$me pw-length=${#pw}"   # prod, rg-tyre-prod, then three non-empty values
   [ "$ENV" = prod ] && [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     PG_ADMIN_PASSWORD="$pw" DEPLOYER_OBJECT_ID="$me" DEV_MACHINE_IP="$ip" \
     az deployment group what-if -g $RG -p infra/platform.$ENV.bicepparam
   ```

   The `ENV` guard matters here: in a shell left on staging, this block and
   the apply below would set staging's admin password to a new one.

   Read every line of the what-if (TYRE-402) before the apply:
   - `psql-tyre-prod` shows `backupRetentionDays` 30, `geoRedundantBackup`
     `Enabled`, and `maintenanceWindow` with `customWindow` `Enabled`,
     `dayOfWeek` 0, `startHour` 0 and `startMinute` 0.
   - The two `CanNotDelete` locks are listed, `lock-psql-tyre-prod` and
     `lock-sttyreprod`.
   - The AcrPull assignment for `id-tyre-api-prod` is a Create in
     `rg-tyre-staging`, on `crtyrestaging`.
   - `kv-tyre-api-prod` and its two role assignments, the API identity's
     Key Vault Secrets User and your Secrets Officer, are Creates in
     `rg-tyre-prod`.
   - Every other line is a Create, apart from two Ignores for what steps 1
     and 2 made: `log-tyre-prod` and `id-tyre-deploy-prod`. The first apply
     listed 19 Creates. Stop on any Delete or Modify, and on any Create
     outside `rg-tyre-prod` other than that AcrPull assignment.

   A later re-apply is read the way staging's step 4 says. Then apply:

   **Geo-redundant backup is fixed at this apply. Changing it later means
   rebuilding the server.**

   ```bash
   [ "$ENV" = prod ] && [ -n "$pw" ] && [ -n "$ip" ] && [ -n "$me" ] && \
     PG_ADMIN_PASSWORD="$pw" DEPLOYER_OBJECT_ID="$me" DEV_MACHINE_IP="$ip" \
     az deployment group create -g $RG -n platform-$(date +%Y%m%d%H%M) \
       -p infra/platform.$ENV.bicepparam -o none
   az postgres flexible-server parameter show -g $RG -s $PG -n azure.extensions --query value -o tsv
   ```

   Expect `PGCRYPTO,BTREE_GIST` (order may differ). Keep `pw` in this shell.
   The first apply took under seven minutes.

   Then run the role listing in staging's step 4 and expect its two rows,
   before step 4 puts the admin password into `kv-tyre-prod`.

4. **The admin password secret.**

   ```bash
   echo "ENV=$ENV KV=$KV pw-length=${#pw}"   # prod, kv-tyre-prod, then a non-zero length
   [ "$ENV" = prod ] && [ "$KV" = "kv-tyre-$ENV" ] && [ -n "$pw" ] && \
     az keyvault secret set --vault-name $KV -n psql-admin-password --value="$pw" -o none && \
     { [ "$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)" = "$pw" ] \
       && echo "admin password stored and matches" && unset pw || echo "stored password differs"; }
   ```

   Expect `admin password stored and matches`. On `stored password differs`,
   stop: `pw` stays in the shell, so nothing is lost.

   `--value=` keeps its equals sign in this step and the next: about one
   generated password in 64 starts with `-`, which the CLI would read as a
   flag. On Forbidden, the Secrets Officer grant has not taken effect yet:
   wait a few minutes and re-run. If the shell was lost and `pw` with it,
   generate a new password and re-run step 3's apply block, which sets the
   admin's password to it.

5. **Migrate, then `app_login`'s secrets.** Migration 000001 creates
   `app_login`, so its password can only be set after the migrate.
   - Run **Each release** steps 1 to 4 with `ENV=prod`, from a checkout of
     the commit step 7 will promote (`git switch --detach <sha>`), but leave
     step 4's last paragraph, the secrets proof, for the end of this step:
     `database-url` does not exist yet, and the proof's read of it fails.
     Nothing is dropped and no tenant is created.
   - Then set `app_login`'s password as `tyreadmin`. psql interpolates
     `:'apppw'` only on stdin, never inside `-c`, so the statement is piped
     in. Each write runs only if the one before it succeeded:

   ```bash
   pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
   apppw=$(python -c 'import secrets; print(secrets.token_urlsafe(32))')
   enc=$(python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$apppw")
   echo "KV=$KV KVAPI=$KVAPI pw-length=${#pw} apppw-length=${#apppw} enc-length=${#enc}"   # kv-tyre-prod, kv-tyre-api-prod, then three non-zero lengths
   [ "$KV" = "kv-tyre-$ENV" ] && [ "$KVAPI" = "kv-tyre-api-$ENV" ] && [ -n "$pw" ] && [ -n "$apppw" ] && [ -n "$enc" ] && \
     echo "ALTER ROLE app_login PASSWORD :'apppw';" | \
     docker run --rm -i -e PGPASSWORD="$pw" postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea psql \
       "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" \
       -v ON_ERROR_STOP=1 -v apppw="$apppw" -q && \
     az keyvault secret set --vault-name $KV -n pg-app-login-password --value="$apppw" -o none && \
     az keyvault secret set --vault-name $KVAPI -n database-url \
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

   Then prove the secrets with staging's step 2 block, under `ENV=prod`:
   the two passwords in `kv-tyre-prod` and no `database-url` there,
   `database-url` alone in `kv-tyre-api-prod`, `app_login f f f f`,
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
   at or after TYRE-435's merge. Images from before TYRE-397's merge carry
   no staging record, so the deploy refuses them. An earlier commit's
   `infra/app.bicep` points production's API at `kv-tyre-prod`, where the
   API's identity holds no role, so its revision never starts.

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
   - The role listing in staging's step 4, under `ENV=prod`, shows exactly
     two rows: `AcrPull` on `crtyrestaging` and `Key Vault Secrets User` on
     `kv-tyre-api-prod`.
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
   `ENV=staging; RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV; KVAPI=kv-tyre-api-$ENV`
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
     `ENV=prod; RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV; KVAPI=kv-tyre-api-$ENV`
     and run Each release steps 1 to 4. If step 3's first read shows
     production already at the checkout's highest migration, step 2 changes
     nothing. Stop on anything step 3 stops on. Then `git switch -`.

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

Migration 000060 (TYRE-326, owner ruling U151, TYRE-326 comment 14041) is
the one recorded exception: it ships in one release. Production's image
from before 000060 fails three controller routes on its schema, the
`vehicle_driver` INSERT behind POST `/api/vehicles/{id}/drivers`, the
`assigned_user_id` read behind GET `/api/vehicles/{id}/inspection-tasks`,
and the `create_inspection_task(uuid, uuid, date)` call behind POST
`/api/vehicles/{id}/inspection-tasks`. Production has no tenants, so no one
meets the failure. The exception covers this PR only. The rule applies
again from the moment BAC is live on production.

## Roll back

A rollback is a dispatch of **Deploy** from the repo's Actions tab with
`target` and `image_sha`:

- **Staging:** run it from `develop` with `target` staging and `image_sha`
  set to the full SHA of a commit this pipeline deployed after the TYRE-79
  merge (earlier images have no `/readyz` and fail the gate), and at or
  after TYRE-326's merge (PR #148), below, once 000060 is applied there.
- **Production:** run it from `main` with `target` prod and `image_sha`
  set to the full SHA of a commit on `main`, at or after TYRE-397's merge,
  that staging passed, and at or after TYRE-326's merge (PR #148), below,
  once 000060 is applied there. The deploy refuses any other. Record it as a
  rollback in the release table (Each release step 5).

Either redeploys that image under the branch's current template, and
rebuilds the web from that commit too; a template change that must be
undone is a revert on `develop`, promoted for production. A rollback runs
no down migration, so the schema stays at head, and an old image must
tolerate it.

Once 000060 is applied to a target, that target's floor is TYRE-326's merge
(PR #148) for good: a rollback runs no down migration, so 000060's drops and
its revoke stay, and an image from before the merge fails three controller
routes on that schema (What this order rests on names them). The deploy's
smoke does not exercise those routes. Production stays at schema 59 until
Promote to production's migrate step, so the floor does not apply there
before it.

Re-running an old run never rolls back (TYRE-403). A re-run whose commit
is no longer its branch's head is refused, and going back is only by this
dispatch.

A rollback to a commit from before TYRE-51 ships a web with no `config.json`
handling. That web calls a relative `/api` and 404s, and the web job's smoke
fails, since the commit has no `scripts/deploy-smoke.sh`. This is accepted
while nobody signs in to staging (TYRE-51 spec, What the owner does after
merge).
