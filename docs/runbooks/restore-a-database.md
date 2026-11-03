# Restore a database

The owner's runbook for restoring an environment's Postgres from its backups
(NFR-BAK-004, NFR-BAK-005; TYRE-321, owner ruling U147 B34). It was first
run as a rehearsal on 3 Nov 2026; the timings and findings below are from
that run. Every `az` write here is the owner's. CI never runs these.

Run every block in Git Bash, in one shell. The first block exports
`MSYS_NO_PATHCONV=1`, because Git Bash otherwise rewrites the
`/subscriptions/...` arguments into Windows paths. A restore never writes to
its source: it creates a new server, and the source keeps running.

## Before anything

```bash
export MSYS_NO_PATHCONV=1
az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
az account show --query "{subscription:id, tenant:tenantId}" -o table
ENV=staging   # or prod
SUB=5a61b832-e331-4529-95ed-ae7b07a9697d
RG=rg-tyre-$ENV; PG=psql-tyre-$ENV; KV=kv-tyre-$ENV
SRC=/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/$PG
PGI=postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
```

**A rehearsal** restores into a resource group of its own, so the clean-up
deletes that group whole and can never name a source server:

```bash
DAY=$(date -u +%Y%m%d)
TRG=rg-tyre-restore-$DAY; NEW=psql-tyre-restore-$DAY
az group create -n $TRG -l southafricanorth --tags purpose=restore-rehearsal -o none
```

**A real recovery** restores into the environment's own group
(`TRG=$RG`) under a new name, and then the API has to be pointed at the new
server: `database-url` in `kv-tyre-api-$ENV` names the server, and the
restored server keeps `app_login` and its password. That cutover has not
been rehearsed.

The restore window is the source's backup retention: 7 days on staging and
30 on production (`az postgres flexible-server show -g $RG -n $PG --query
backup`, `earliestRestoreDate`).

## 1. Before: the restore point and the source's counts

The source's exact row count per `app` table, its schema version and dirty
flag, and the three roles, as `tyreadmin`. `tyreadmin` bypasses RLS, so the
counts cover every tenant; `pg_stat_user_tables` estimates are not evidence.
On a real recovery the source may be gone; skip this step and compare the
restored counts with what the tenant expects instead.

```bash
cat > counts.sql <<'EOF'
SELECT 'schema_migrations', version::text || ' dirty=' || dirty::text FROM public.schema_migrations;
SELECT 'role ' || rolname, 'super=' || rolsuper || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname IN ('app_login','app_rw','tyreadmin') ORDER BY rolname;
SELECT format('SELECT %L, count(*)::text FROM app.%I', c.relname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'app' AND c.relkind = 'r' ORDER BY c.relname \gexec
EOF
pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
docker run --rm -i -e PGPASSWORD="$pw" $PGI psql \
  "host=$PG.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" \
  -At -F '|' -v ON_ERROR_STOP=1 -f - < counts.sql > source.txt
unset pw
date -u +%FT%TZ
```

Pick the restore point (UTC) a few seconds after the time printed. The
counts hold for it only while nothing writes to the source in between.

## 2. Point-in-time restore

```bash
RT=2026-11-03T08:06:00Z   # the restore point, UTC
date -u +%FT%TZ
az postgres flexible-server restore -g $TRG -n $NEW --source-server $SRC --restore-time $RT --no-wait
```

`--source-server` takes the full resource id, which lets the new server land
in another group. Time it from submit to `Ready`; the `show` answers
"not found" for the first minutes, which is not a failure:

```bash
until [ "$(az postgres flexible-server show -g $TRG -n $NEW --query state -o tsv 2>/dev/null)" = Ready ]; do
  date -u +%FT%TZ; sleep 60
done; date -u +%FT%TZ
```

The 3 Nov rehearsal (staging, 32 GB, Standard_B1ms) took about 8 minutes:
submitted 08:06:47Z, `Ready` by 08:15:05Z.

## 3. Geo-restore (production only)

Production's backups are geo-redundant to the paired region, South Africa
West. A geo-restore creates the new server there:

```bash
az postgres flexible-server geo-restore -g $TRG -n psql-tyre-georestore-$DAY \
  --source-server $SRC -l southafricawest --no-wait
```

**On 3 Nov this was refused before anything was created:**
`NoRegisteredProviderFound: No registered resource provider found for
location 'southafricawest' ... for type 'locations/checkNameAvailability'`.
`Microsoft.DBforPostgreSQL/flexibleServers` lists South Africa North and no
South Africa West for this subscription, and Azure lists South Africa West
as a restricted region ("Other"). So a geo-restore needs Azure to open that
region to the subscription first, through a support request. Until it does,
production's geo-redundant backup cannot be restored anywhere, and the
recovery from a South Africa North outage is a point-in-time restore once
the region is back. Whether to raise that request is the owner's call
(TYRE-321).

## 4. Verify

The firewall rules do not come across (0 on 3 Nov), so admit this machine
on the new server only. The roles and passwords do come across, so the
source's admin password connects:

```bash
ip=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create -g $TRG -s $NEW -n AllowDevMachine \
  --start-ip-address "$ip" --end-ip-address "$ip" -o none
pw=$(az keyvault secret show --vault-name $KV -n psql-admin-password --query value -o tsv)
docker run --rm -i -e PGPASSWORD="$pw" $PGI psql \
  "host=$NEW.postgres.database.azure.com dbname=tyre user=tyreadmin sslmode=require" \
  -At -F '|' -v ON_ERROR_STOP=1 -f - < counts.sql > restored.txt
unset pw
diff source.txt restored.txt && echo identical
```

Expect `identical`: the same schema version, not dirty; `app_login` and
`app_rw` neither superuser nor bypassing RLS (CLAUDE.md rule 1); every table
count equal. On 3 Nov all 50 tables matched (679 rows) at schema 60.

## 5. Clean up

A rehearsal deletes its own group, after checking that it holds only the
new server:

```bash
az resource list -g $TRG --query "[].name" -o tsv
az group delete -n $TRG --yes
az group exists -n $TRG    # false
az postgres flexible-server show -g $RG -n $PG --query state -o tsv   # the source, still Ready
```

Production's server and storage account carry CanNotDelete locks
(`az lock list -g rg-tyre-prod`). A restore makes a new server outside them,
so they neither block the restore nor its clean-up, and the clean-up never
touches them. On 3 Nov the delete took about 2.5 minutes.

## 6. Record

Post the duration, the restore point, the result of the diff and anything
refused as a comment on TYRE-321, and add a row to the release table on
Confluence page 10682399 (U118), as a release row does.
