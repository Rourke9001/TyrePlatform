# Design: the staging deploy path (TYRE-79 with TYRE-368 and TYRE-53)

- **Date:** 2026-10-09
- **Tickets:**
  - TYRE-79, the deploy that went green over a crash-looping revision.
    TYRE-53, the static web apps action pin, is folded into it.
  - TYRE-368, the staging database path.
  - All three are under epic TYRE-10.
- **Decisions it rests on:**
  - Owner rulings U116 to U119 (TYRE-79 comment 13569), U94 (TYRE-368) and
    U89 (TYRE-79 comment 13421).
  - ADR-0017 (PR #104): staging holds no real data, and production is a
    second environment under TYRE-397. ADR-0004 (branching).
  - The TYRE-53 option (a) and `needs: api` defaults, taken in comment
    13569 and not vetoed.
- **Requirements:**
  - NFR-MNT-004: versioned migrations.
  - NFR-MNT-006: automated deploy with rollback.
  - NFR-MNT-007: configuration by value.
  - NFR-OBS-005: a health endpoint over critical dependencies.
  - NFR-SEC-012: secrets in a managed store.
  - The SRS says nothing about least privilege for deploy identities or
    about recording the deployed version. Neither gap conflicts with the
    brief.
- **Evidence:** Microsoft Learn and GitHub Docs, read on 9 Oct 2026 and cited
  inline. Where the docs are silent, this spec says so and takes the
  cautious reading.

## Why this exists

Staging's API has served the 21 Aug image since then. The 27 Aug release
built the right image, but the live container app was never given the
`DATABASE_URL` binding that `infra/main.bicep` declares, so every new
revision exits at startup. Container Apps keeps traffic on the old revision
when a new one fails ("If an update fails, traffic remains pointed to the
old revision", learn.microsoft.com/azure/container-apps/revisions), and the
gate polls `/healthz` on the public address, which the old revision answers.
So the deploy reports green.

Three causes sit under that one symptom:

- **The template is never applied.** The pipeline runs `update --image`.
  That command preserves secrets and env (learn.microsoft.com/cli/azure/containerapp),
  but the live app has none to preserve.
- **The template cannot be applied by the pipeline as written.** It declares
  three role assignments, and the deploy identity holds Contributor, whose
  NotActions exclude `Microsoft.Authorization/*/Write`
  (learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged).
  The docs give no exemption for an assignment that already exists
  unchanged, so this spec assumes the deploy fails.
- **The gate cannot tell revisions apart.** `/healthz` touches nothing, and
  it is not unique to any build.

TYRE-368 adds the database. Staging was migrated once by hand, on 21 Aug,
and head is 000052. The owner read `schema_migrations` on 9 Oct: **version
1, not dirty** (TYRE-368 comment 13572). 000002 to 000008 reached git after
that migration, and 000001 has since been restyled. The next run stops at 000026 because `btree_gist` is not
allow-listed. Nothing records which schema runs beside which image.

## Scope

**In:**

- `infra/main.bicep` split into `platform.bicep`, which the owner applies,
  and `app.bicep`, which the pipeline applies (U117).
- `deploy.yml` deploys staging when CI passes on `develop`, through a GitHub
  environment, with a gate that proves the new revision serves, and a
  rollback dispatch.
- A `/readyz` route that pings the database and names the build's commit
  and its revision.
- The six `AUTH_*` settings on the container app, and the three
  `VITE_AUTH_*` values in the web build.
- A runbook, `docs/runbooks/environment-release.md`, covering:
  - the one-time bring-up;
  - applying the platform template;
  - migrating to head, and stopping on a failed or dirty migrate;
  - the 000051 ACL check;
  - recording the release on Confluence page 10682399 (U118).
- TYRE-53: the action pinned to the `v1` branch head.
- `bicep build`, `bicep lint` and `actionlint` added to `make lint` and CI.

**Out:**

| Work | Where it goes |
|---|---|
| Production: its stamp, deploy job, `main` trigger and guard | TYRE-397 |
| The static web app linked backend and web headers | TYRE-51 |
| The staging reset and tenants | TYRE-374 |
| Post-deploy smoke tests | TYRE-398 |
| Pool size | TYRE-305 |
| Backup settings | TYRE-203 (production's concern under ADR-0017) |
| An automated migrate | After the pilot starts (U94) |

No migration and no suite section.

## 1. The templates

`infra/main.bicep` is replaced by two files. Resource names stay exactly as
they are, so the first apply updates the live resources in place
(incremental mode).

### `infra/platform.bicep`, applied by the owner

**Holds:**

- storage and the photos container;
- Key Vault;
- the API's managed identity;
- the three role assignments;
- Postgres with its firewall rules and the `tyre` database;
- the Container Apps environment;
- the static web app.

**Adds:**

- `Microsoft.DBforPostgreSQL/flexibleServers/configurations` named
  `azure.extensions`, with value `PGCRYPTO,BTREE_GIST` and source
  `user-override`. The parameter is dynamic and needs no restart
  (learn.microsoft.com/azure/postgresql/extensions/how-to-allow-extensions).
  Neither extension needs `shared_preload_libraries`.

**Parameters:** `env`, `pgAdminPassword`, `deployerObjectId` and
`devMachineIp`, as today. `app.bicep` reads the resources it needs as
`existing`, not through this file's outputs.

**The admin password is re-sent on every apply.** The schema allows the
password to change at any time, and the docs are silent on omitting it from
a re-PUT. So the runbook always passes the value read from Key Vault
(`psql-admin-password`). Passing any other value changes the admin password.

### `infra/app.bicep`, applied by the pipeline on every release

**Holds** the container app only. It references the environment, the
identity, the vault and the registry as `existing`. That is legal because
none of them is deployed in this file
(learn.microsoft.com/azure/azure-resource-manager/bicep/existing-resource).

**Parameters:**

- `env`.
- `apiImage`: required, with no default. The quickstart placeholder and the
  ACCEPTED TRADE comment go.
- `revisionSuffix`: required. See section 2.
- The six `AUTH_*` values.
- `acrResourceGroup`, so production can pull from staging's registry
  (ADR-0017).

**Per-environment values** live in `infra/app.staging.bicepparam`. Every
value in it is a public identifier: `AUTH_*` from the b9 handoff and
Confluence page 10682399, Identity section.

**The template sets:**

- the `database-url` Key Vault secret reference and
  `DATABASE_URL = secretRef`;
- `TRUSTED_PROXY_HOPS = 1`;
- the six `AUTH_*` variables;
- `template.revisionSuffix`;
- scale 0 to 2, unchanged;
- probes, which it declares because it has none today, and portal-only TCP
  defaults do not apply to a template deploy
  (learn.microsoft.com/azure/container-apps/health-probes):
  - **startup** and **liveness** on HTTP `/healthz`, port 8080;
  - **readiness** on HTTP `/readyz`.

  A readiness probe that pings the database is correct here: a replica
  without its database cannot serve any `/api` route. Startup stays on
  `/healthz`, so a passing database blip never turns into a restart loop.

**While staging's database is stopped, the API is down.** `store.New` pings
the database at startup and exits if it cannot reach it
(`api/cmd/api/main.go`). A request that wakes a replica in that window gets
a crash-looping replica, until scale-to-zero reaps it. That is accepted for
staging (ADR-0017), and the runbook says so.

The deploy identity (Contributor on `rg-tyre-staging`) can apply this file.
It writes no role assignments, and Contributor allows reading the vault's
URI and the environment's id.

## 2. The pipeline

### Trigger and environment

**Why the deploy is not on `workflow_run`.** For a `workflow_run` event,
`GITHUB_REF` is the repository's default branch, which here is `main`
(docs.github.com/actions/reference/workflows-and-actions/events-that-trigger-workflows).
An environment's deployment-branch rule is checked against that ref. So a
`workflow_run` deploy restricted to `develop` would be refused on every run.

**The shape.** `deploy.yml` becomes a reusable workflow (`on: workflow_call`
and `workflow_dispatch`). `ci.yml` gains a `deploy-staging` job that:

- `uses: ./.github/workflows/deploy.yml`;
- `needs:` every gate job;
- runs only when `github.event_name == 'push' && github.ref ==
  'refs/heads/develop'`;
- grants `id-token: write` at job level.

A called workflow sees the caller's `github` context, so the ref is
genuinely `develop`. The race that `deploy.yml`'s header comment exists to
dodge, where the deploy starts before the suite finishes, goes away with
the `workflow_run` trigger. The deploy now waits on the suite by `needs:`.

**Concurrency.** CI's workflow-level concurrency cancels an in-progress run
on the same ref. On `develop` that could kill a deploy mid-rollout, so it
becomes `cancel-in-progress: ${{ github.ref != 'refs/heads/develop' }}`. A
second push to `develop` waits behind the running one, and GitHub keeps only
the newest of any waiting runs. Pull request and feature-branch runs still
cancel.

The `deploy-staging` caller job in `ci.yml` holds its own concurrency
group, `deploy-staging` with `cancel-in-progress: false`, which keeps CI
deploys single. `deploy.yml` has no workflow-level group. Its `api` and
`web` jobs hold the job-level groups `deploy-staging-api` and
`deploy-staging-web`, and those keep a dispatch and a CI deploy apart.
GitHub's docs do not say that job-level groups inside a called workflow are
honoured, so the first runs confirm it.

**The GitHub environment.** Both deploy jobs set `environment: staging`. The
GitHub environment `staging` has:

- a deployment-branch rule allowing `develop` only;
- no required reviewer.

A `workflow_dispatch` (rollback) must be dispatched from `develop`, or the
same rule refuses it.

**For TYRE-397.** Production can call the same reusable workflow from CI's
push to `main`. A `workflow_run` trigger would also happen to work for
`main`, but only because `main` is the default branch. TYRE-397 should not
rely on that.

**The federated credential.** `id-tyre-deploy-staging` gains subject
`repo:Rourke9001@92760271/TyrePlatform@1340948199:environment:staging`.
Adding `environment:` changes the token's subject
(docs.github.com/actions/reference/security/oidc), so the credential exists
before this merges.

The old `ref:refs/heads/main` credential stays until two things are true:

- a run's diagnostic step has printed the token's `sub` claim, decoded from
  the payload with the token itself never printed;
- that claim matches the new subject byte for byte.

Only then is the old credential deleted. Until TYRE-397, nothing deploys
`main`, which is U89.

### The API job

1. **Database up.** Read the server's state. If it is `Stopped`, start it
   and wait until `Ready` (`az postgres flexible-server start`; Contributor
   holds `start/action`). Starting is idempotent. The workflow never stops
   the server: the owner stops it after a session (ADR-0017).
2. **Image.** Skipped when the dispatch input `image_sha` is set. Otherwise
   build with `--build-arg BUILD_SHA=$IMAGE_SHA` and push
   `crtyrestaging.azurecr.io/tyre-api:$IMAGE_SHA`, as today.
3. **Apply.** Run
   `API_IMAGE=... REVISION_SUFFIX=... az deployment group create -g rg-tyre-staging -n app-<suffix> -p infra/app.staging.bicepparam`.
   The two values go in as environment variables, which the param file
   reads through `readEnvironmentVariable`, because az takes a
   `.bicepparam` file alone after `-p`.
4. **Gate.** Run `scripts/deploy-gate.sh` (below).

**Rollback** (NFR-MNT-006) is a dispatch with `image_sha` set to an earlier
commit. The job skips the build, checks that the tag exists in the
registry, and runs steps 1, 3 and 4 against it. The gate then expects that
earlier commit's SHA and the new revision's name. It needs no traffic
shifting and no multiple-revision mode: the earlier image becomes a new
revision.

A rollback rolls back the image, not the template: `app.bicep` comes from
the dispatched ref, `develop`'s head. A template change that has to be
undone is a revert on `develop`, which deploys normally.

So the workflow carries two values where today it has one (`DEPLOY_SHA`):

- **`TEMPLATE_SHA`**, the commit checked out for `infra/`. That is the CI
  run's commit on a push, and the dispatched ref's head on a rollback.
- **`IMAGE_SHA`**, the tag deployed and the SHA the gate expects. That is
  `TEMPLATE_SHA` on a push, and the `image_sha` input on a rollback.

### The revision suffix

Each deploy needs a fresh suffix. A rollback to an earlier SHA, or a
re-run of the same workflow run, would otherwise reuse a suffix whose
revision already exists. The suffix is
`<c|d><run_number>-<run_attempt>-<first 7 of IMAGE_SHA>`:

- `c` is a CI deploy and `d` is a rollback dispatch. The two count runs
  separately, so without the letter a CI run and a dispatch could share a
  number and, on the same commit, a suffix.
- It starts with a letter, is lower case and is well under the length limit.

The plan verifies the suffix rules against
learn.microsoft.com/azure/container-apps/revisions-manage before relying on
them.

### The gate (`scripts/deploy-gate.sh`)

**Inputs:** resource group, app name, revision **suffix**, expected SHA, and
a timeout (default 10 minutes). The gate forms the revision name
`<app>--<suffix>` itself, so the workflow and the gate cannot disagree about
it.

**One polling loop.** Every 10 seconds until the timeout, each pass checks
the new revision's state and then `/readyz`. The loop passes on the first
pass where `/readyz` holds and the new revision's traffic weight is 100.

1. **Revision state.** `az containerapp revision show` for the new
   revision's name. An old revision's state never reaches the gate, so a
   poisoned old revision cannot fail a deploy.
   - The state stops the gate at once only when `provisioningState` or
     `runningState` is Failed, or a value containing it such as
     ActivationFailed.
   - Any other state, such as Activating, Degraded or Unhealthy, keeps the
     loop polling. Degraded and Unhealthy are transient during a cold start
     with a fresh database connection.
   - The gate passes only when `/readyz` answers 200 through the app's
     FQDN, naming the expected SHA and the revision `<app>--<suffix>`, and
     that revision's `trafficWeight` is 100. A revision that never serves
     fails at the timeout.
   - The pass rule reads neither state, because a new-revision replica
     answering with its own name proves the revision serves, a state check
     adds no proof, and az may report the value differently
     (RunningAtMaxScale, Activating).

   The fields and their values are from the ARM revision model
   (learn.microsoft.com/javascript/api/@azure/arm-appcontainers/revision).
2. **The build is serving.** `GET https://<public fqdn>/readyz` holds when
   it answers 200, with `sha` equal to the expected SHA and `revision` equal
   to `<app>--<suffix>`.
   - The gate needs both fields, because a SHA cannot tell an old revision
     from a new one serving the same commit. A re-run, or a rollback to the
     commit already serving, would otherwise pass against the revision it
     was meant to replace.
   - An image without `/readyz` never holds here. It fails readiness, so
     its revision never takes traffic, and the loop times out.
   - The `sha` check guards a different failure: an image that activates
     but is not the expected commit, such as a wrong tag or a stale
     `latest`.
   - The request runs on every pass, not after the state check passes. With
     `minReplicas: 0`, only a request wakes a replica (red team I2), so a
     gate that waited on the state first could wait on a revision with no
     replica until the timeout. The docs are silent on how readiness counts a
     revision with no replicas, so the state alone is not trusted.

**Timeout.** A loop that times out fails the job. The message names the last
state and the last response.

Every failure exits non-zero. The workflow does not pipe the script.

### The web job

The web job:

- runs after the API job (`needs: api`) and in environment `staging`;
- checks out `IMAGE_SHA`, so a rollback also rebuilds and ships that
  commit's frontend (ADR-0017, one bundle for both environments);
- builds with the three `VITE_AUTH_*` values as literals in `deploy.yml`
  (public identifiers, and the same for both environments under ADR-0017);
- uploads with `Azure/static-web-apps-deploy` pinned to
  `4d27395796ac319302594769cfe812bd207490b1`, the `v1` branch head of
  11 Sep 2024, whose `action.yml` declares `skip_api_build`. That is
  TYRE-53 option (a). Renovate cannot follow a moving branch. The comment
  says so and names the commit date.

## 3. `/readyz`

`GET /readyz` is registered next to `/healthz`, outside `/api`, so it needs
no actor.

- **Ready.** It calls the store's pool `Ping` with a 2-second context, and
  answers 200 with
  `{"status":"ready","sha":"<sha>","revision":"<revision>"}`.
- **Not ready.** It answers 503 with
  `{"status":"unready","sha":"<sha>","revision":"<revision>"}`, and never
  includes the error text.
- **The SHA.** It is set at link time by `-ldflags "-X main.buildSHA=..."`,
  from the Dockerfile's `ARG BUILD_SHA`. It defaults to `dev`. The repo is
  public, so exposing the SHA discloses nothing.
- **The revision.** It is `CONTAINER_APP_REVISION`, which Container Apps
  sets in every container
  (learn.microsoft.com/azure/container-apps/environment-variables), for
  example `ca-api-staging--c7-1-0123456`. It is empty locally. The gate
  requires it to equal the revision it deployed, because a SHA cannot tell an
  old revision from a new one serving the same commit.
- **Headers.** The security headers apply, as they do to every route.

It answers NFR-OBS-005 for the one critical dependency the API has today.
Blob storage is not yet called by the API.

`/healthz` stays unchanged as the liveness check. A database outage then
makes replicas unready, not restarted.

## 4. The runbook (`docs/runbooks/environment-release.md`)

The runbook is written for staging. `ENV` names the environment in every
command, and TYRE-397 decides production's first-apply order. Every step is
an owner action, and every `az` write is confirmed by the owner.

### Before anything

Sign in to the BAC tenant:

```
az login --tenant 9688ca2b-20f0-45ba-a560-11b5cfbde338
```

Then run `az account show` and check that the subscription is
`5a61b832-...`. The CLI's default tenant is the CIAM one, and that trap has
cost a session before.

### One-time bring-up, in this order, before TYRE-79 merges

1. **Vault read for the owner.** The Secrets Officer grant in
   `platform.bicep` is not live (TYRE-63), and reading the admin password
   needs it.
   - Grant yourself **Key Vault Secrets User** on `kv-tyre-staging` by hand.
     It is a different role from the Officer grant the template declares,
     so the two do not collide with `RoleAssignmentExists`.
   - Remove the grant after step 4 lands the Officer grant.
2. **Prove the vault secrets.** List the vault's secrets. All three must
   exist:
   - `psql-admin-password`;
   - `pg-app-login-password`;
   - `database-url`.

   Then connect from the developer machine with the stored `database-url`
   (`sslmode=require`, dockerised `psql`). `SELECT current_user` must
   return `app_login`, and `rolbypassrls` must be false for it.

   If `database-url` is missing or does not connect, the revision cannot
   activate: `main.bicep`'s own comment warns of this. Write or correct the
   secret after step 4 lands the Officer grant, and repeat this step.
3. **The federated credential.** Create the `environment:staging` credential
   on `id-tyre-deploy-staging`, and create the GitHub environment `staging`
   with its deployment-branch rule.
4. **The platform template.** Apply `platform.bicep`, passing
   `psql-admin-password` read from the vault and the developer machine's
   current public IP, read at apply time. A stale `devMachineIp` moves the
   firewall rule, and the next migrate then fails for a confusing reason.
   Confirm that `SHOW azure.extensions` lists both extensions.
5. **Reset, then migrate staging to head.** This is the default path, not a
   fallback:
   - staging's August data is disposable (U116), and TYRE-374's reset is
     sequenced anyway;
   - its schema is at version 1, which was applied before 000001's later
     edits. Migrating forward from there would build on a schema nobody has
     tested since August.

   For production (TYRE-397), the database is new and empty, so this step
   is only the migrate.

   **Drop.** Run `az postgres flexible-server db delete -g rg-tyre-staging
   -s psql-tyre-staging -n tyre`, which asks for confirmation. Crash-looping
   replicas of the old image may hold connections, and the command's help is
   silent on them. If the delete refuses, stop and post the error on
   TYRE-368.

   **Recreate.** Run the whole of step 4 again, not only the template apply:
   the admin password read from the vault, the current public IP, the
   `platform.bicep` apply and the `azure.extensions` check. The template
   declares the `tyre` database, so the collation and owner match what Bicep
   declares. Never use hand-typed `CREATE DATABASE`.

   `app_login` and `app_rw` are cluster roles and survive the drop, and
   000001 creates them only `IF NOT EXISTS`. Then
   migrate the empty database to head (below). Tenants come from TYRE-374.

   The live image does not apply `app.bicep` by hand: the 21 Aug image has
   no `/readyz`, so its revision would never pass readiness. The first
   `app.bicep` apply is the pipeline's, with an image that has the route.
6. **Merge TYRE-79.** The merge is the first run of the new pipeline. Watch
   it go green, then run the red proof in section 5.

### Each release

1. **Start the database** if it is stopped.
2. **Migrate.** Run the dockerised `migrate` (`migrate/migrate:v4.19.1`, the
   digest the Makefile pins) against the environment's server as
   `tyreadmin`, with `sslmode=require`. Run it from the developer machine,
   which the firewall admits.
3. **Stop on any of these.**
   - A non-zero exit.
   - `migrate version` reports dirty. Recovery is a decision, not a step:
     `force` is never run without one.
   - The version is not the highest number under `db/migrations/`.
4. **After 000051** (TYRE-368 comment 13439):
   - `proacl` on `app.refresh_governing_tread()` holds only the owner's
     entry.
   - `has_function_privilege('app_login', ..., 'EXECUTE')` is false.

   Otherwise the release stops.
5. **Record.** Add a row to the release table on Confluence page 10682399
   with:
   - the date;
   - the environment;
   - the image tag, read live from the container app;
   - the `schema_migrations` version and its dirty flag;
   - who ran it.

**When to migrate.** A PR that carries a migration is migrated on staging
straight after its merge's deploy, never before. Migrations stay editable on
their branch (`migration-immutable.sh` refuses an edit only once the file is
on `origin/develop`), so one applied earlier could be edited afterwards and
leave staging on a version that git no longer holds. The new image may run
briefly against the old schema. Staging holds no real data (ADR-0017), so
that window is accepted.

The runbook never weakens a migration to get past existing rows. On
staging, the answer to data that will not migrate is the reset in bring-up
step 5.

**Every platform apply** re-sends `pgAdminPassword`, read from the vault,
and `devMachineIp`, read live. Neither value is copied from an earlier run.

The U94 read-only query (TYRE-368 comment 13436) belongs to TYRE-374's
pre-reset step, not to this runbook.

## 5. Testing and proof

### In `make check`

- **Go, `httpapi`.** `/readyz` answers 200 with the SHA and revision when
  the ping succeeds, and 503 with no error text when it fails. The 503 test
  uses a real store closed before the request.
- **Go, integration.** Against the real Postgres, `/readyz` answers 200.
- **Go, the no-actor table.** The route table in
  `api/internal/httpapi/security_test.go` gains a `/readyz` row beside
  `/healthz`: no actor needed, and the security headers present.
- **The gate.** `scripts/deploy-gate.test.sh` runs the gate with stub `az`
  and `curl` on `PATH`. Its cases:
  - passing: Running at 100 with the right SHA and revision, the same with
    spaced JSON, and an Activating or a Degraded revision at 100 once the
    new revision answers;
  - failing at once: provisioning state Failed, running state Failed, and
    running state ActivationFailed;
  - failing at the timeout:
    - a revision that never takes traffic (weight 0), whether Running and
      answering or Degraded and unready;
    - a revision that never appears;
    - an old image answering 404 on `/readyz`;
    - the wrong SHA;
    - the right SHA from a different revision;
    - a 503 unready answer;
    - a curl that fails (000);
    - a 200 with no body after an unready answer, with or without a failed
      transfer;
    - a 200 with the right body but a failed transfer.

  Each failing case asserts a non-zero exit, and one passing case is the
  control. A new Makefile target runs it, and `make test` calls that target.
- **Lint.**
  - `bicep build` and `bicep lint` on both templates and the param file, in
    a pinned container image.
  - `actionlint` on `.github/workflows/*`, in a pinned image.

  Both join `make lint` in the same order as CI's new job. Each gets a
  planted failure in the plan, to show that it can fail.
- **Release binary.** `scripts/check-release-binary.sh` still passes. The
  `-X` flag adds a string, not a resolver.

### After merge, posted on TYRE-79

1. **Green.** The merge's own deploy:
   - revision `ca-api-staging--c<n>-<attempt>-<sha7>` is Running with 100%
     traffic;
   - `/readyz` names the commit and that revision;
   - `az containerapp show` lists the `DATABASE_URL` secretRef;
   - `/api/me` answers 401, not 503 and not 404, because the `AUTH_*`
     settings are live.
2. **Red.** A dispatch from `develop` with `image_sha=752c04b...`, the
   21 Aug image, which has no `/readyz`.
   - Its revision fails readiness and never takes traffic, so the run fails
     before the image serves anything. That may happen at the apply, if ARM
     blocks until the revision provisions and then times out, or at the
     gate's loop timing out. Either is a pass for the proof.
   - The merge's revision keeps serving throughout.
   - Re-dispatching with a SHA other than the one serving then proves
     rollback. The image must have `/readyz` and exist in the registry, for
     example the merge's commit once a later deploy has replaced it.
   - A re-dispatch with the SHA already serving is meaningful too, because
     the gate also compares the revision name, so it passes only once a new
     revision is the one answering.
3. **TYRE-53.** The web job's log carries no unexpected-input warning.
4. **TYRE-368.** The first runbook run's version (000052) is posted on
   TYRE-368, and the release table holds its first row.

## 6. Documents this changes

- `infra/main.bicep` is deleted. `infra/platform.bicep`, `infra/app.bicep`
  and `infra/app.staging.bicepparam` are new.
- `.github/workflows/deploy.yml`, which becomes reusable.
- `.github/workflows/ci.yml`: the `deploy-staging` job, the concurrency
  expression and the lint job.
- `api/cmd/api/main.go`, `api/internal/httpapi/` (the route and its test),
  and `api/Dockerfile` (`ARG BUILD_SHA`).
- `scripts/deploy-gate.sh` and its test. Makefile targets for the lint and
  the gate test.
- `docs/runbooks/environment-release.md`, new.
- `docs/implementation-order.md`: the Staging row.
- Outside the repo, at close-out:
  - Confluence page 10682399: the release table, and the deploy pipeline
    section, which describes the old `main`-triggered shape;
  - the federated credential and the GitHub environment.

## Open points the plan settles, not the owner

- **The revision suffix rules.** The pattern and the length limit, and
  whether ARM accepts a reused suffix after a rollback, which the design
  avoids anyway.
- **The lint images.** Which pinned image carries the Bicep CLI without a
  network download at run time.
- **Mixed parameters.** Whether `az deployment group create` accepts a
  `.bicepparam` file together with inline `-p` overrides on the runner's
  CLI version. If it does not, the overrides move into the param file
  through `readEnvironmentVariable()`.
- **Whether `az deployment group create` waits for the revision.** If ARM
  blocks until the revision provisions or fails, the gate's state check
  mostly confirms what ARM already said, and that is harmless.
