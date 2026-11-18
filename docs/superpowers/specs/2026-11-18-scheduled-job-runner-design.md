# A scheduled job runs the daily task generator, and email waits on its provider

Date: 2026-11-18. Ticket: TYRE-371 (epic TYRE-10). Status: approved by the
owner on 18 Nov 2026 (U234). Owner rulings: U147 (B31, B32, D:TYRE-371,
21 Oct 2026), U232 (18 Nov 2026, TYRE-371 comment 14300), U233 (comment
14303) and U234. The decision record is
`docs/adr/0025-scheduled-work-runs-as-a-container-apps-job.md`, Accepted
with this spec's approval.

Requirements this serves, none of them changed: FR-INS-052 and FR-INS-054
(a schedule firing produces a task, and schedules skip non-active units),
FR-EXC-002 (time-based rules evaluated at least daily, which TYRE-243
builds on this runner), NFR-AVL-006 and NFR-OBS-003 (a background job
failure is retried and alerted), NFR-PRV-007 (no personal information in
logs), NFR-SEC-012 (secrets in a managed store), FR-TEN-004 and NFR-SEC-005
(isolation in the database, proven on every build). CLAUDE.md rules 1 and
6. Appendix H.3 criterion 4 depends on tasks being issued without a
controller's hand.

This spec departs from the ticket and its audit comment in five places.

1. **Email is not built.** The provider U147 B32 chose is being retired,
   the owner paused the replacement (U232) and moved the email half to
   TYRE-243 (U233). Section 11 says what this ticket records.
2. **The job connects as its own database role, `app_job`,** not as
   `app_login` (B31). Section 3 gives the reason, and the owner accepted
   it with this spec (U234).
3. **The ticket names `infra/main.bicep`.** The templates are
   `infra/app.bicep`, which the pipeline applies on every release, and
   `infra/platform.bicep`, which the owner applies by hand (U117). The job
   goes in the first and the alert in the second (sections 1 and 6).
4. **Staging's database stays running** (U232), which ends ADR-0017's
   stop-while-idle habit (section 7).
5. **"A failed run is visible" is built as one alert on a missing success
   line,** which also catches a run that never started (section 6).

## Intent

A fleet's controller sets recurring inspection schedules, and
`app.generate_inspection_tasks` turns the ones that have fallen due into
tasks. Nothing calls it. This ticket gives the platform a place to run
work on a clock, runs the generator there once a day for every active
fleet, and tells the owner when a run fails or does not happen.

The same runner is what TYRE-243's daily exception pass and notification
sender will use, so the design has to leave room for a second step and a
second schedule without building either.

## What the spec-stage reading showed

- **The generator runs under row security as written.** It is `LANGUAGE
  sql`, invoker rights, and takes the day as `p_as_of`
  (`db/migrations/000060_per_trip_assignment.up.sql:1345-1370`). Bound to
  a tenant, it sees that tenant's schedules only. It needs no change here.
  Its due instant and its other open items are TYRE-133's (ADR-0013,
  "One writer is still open").
- **It is safe to run twice in a row,** because it skips a unit that has
  an OPEN task, or a closed one whose due day is less than one interval
  behind the run's day (the same lines). That second rule holds the next
  task back for twice the interval once a task is closed, so a weekly
  schedule closed on time gets a task a fortnight. The review of this
  branch found it, and the owner left it to TYRE-133 (U235, TYRE-133
  comment 14306). Two runs at the same moment could both insert, since
  nothing serialises them.
- **Its inserts are audited with no actor,** which `app.audit_row_change`
  permits (`db/migrations/000038_inspection_task_write.up.sql:91-94`).
- **`store.InTenantTx` already binds a tenant with no actor**
  (`api/internal/store/store.go:95-116`). `api/CLAUDE.md` says no handler
  uses it. The job is its first caller.
- **`app.tenant` is under forced row security** with the policy
  `id = app.current_tenant_id()` (`db/migrations/000001_init.up.sql:557-561`),
  and its states are PROVISIONING, ACTIVE, SUSPENDED and CLOSED (`:40`).
- **The API binary is one program with no arguments**
  (`api/cmd/api/main.go:204`), and the image's entrypoint is `/api`
  (`api/Dockerfile`).
- **The pool is sized per replica at 7** against 35 user connections, with
  28 used at the peak of a rolling deploy (ADR-0005's TYRE-305 amendment,
  `api/internal/store/store.go:23-28`).
- **Suite section 67a already says the app login may execute no definer
  off the write list** (`db/tests/004_tests.sql:10272-10315`). Under this
  design it stays true unchanged.
- **Container Apps jobs** evaluate cron in UTC, have no setting that stops
  overlapping executions, keep the last 100 executions, and write console
  output to the environment's Log Analytics workspace. The sources are in
  Lead's calls.

## Goals

- The generator runs once a day at 00:15 South African time for every
  ACTIVE tenant, each inside a transaction bound to that tenant.
- One tenant's failure does not stop the others, and still fails the run.
- A failed run is retried once. A run that fails, never starts or logs
  nothing emails the owner within about two hours.
- Each run shows in Log Analytics, with what it did per tenant.
- The API's database role learns no tenant id it was not handed.
- A second step in the daily run, or a second job on another schedule, is
  an addition and not a redesign.

## Non-goals

- Email. No sender, no provider resource, no secret (section 11).
- The exception pass and the notification sender, which are TYRE-243's.
- Any change to `app.generate_inspection_tasks`, its due instant or the
  schedule screens, which are TYRE-133's.
- Running the job from the deploy as a smoke test. Staging migrates after
  its deploy (U94), so the release that adds a migration the job needs
  would fail its own deploy.
- A screen or an API route for job status (FR-ADM-008 is deferred by
  Appendix H.2).
- A job run per time zone. One UTC cron suits the pilot, and ADR-0025
  names the trigger to revisit it.

## Anti-goals

- No route, handler or header that runs a job. The only way to start one
  is the schedule or Azure's own start action.
- The job never connects as `tyreadmin` or any role row security does not
  bind.
- No query that reads or writes a tenant's rows outside a transaction
  bound to that tenant. The one statement run with no tenant bound is the
  call to the listing function.
- No tenant-aware rule in Go. Which day it is for a tenant, and which
  units fall due, stay in SQL.

## Constraints

- Rule 1. The job's role is NOSUPERUSER and NOBYPASSRLS and owns nothing.
- `tyreadmin` is not a superuser on Azure, and a local run as `postgres`
  skips every ownership and grant rule that binds it (ADR-0024, Context).
  The migration is written for `tyreadmin`, and
  `make db-provision-test`'s stand-in leg proves it up, down and up again,
  as it does 000061.
- The pipeline's deploy identity holds Contributor and cannot write a role
  assignment (U117). Nothing in `infra/app.bicep` may need one.
- The repo is public. The owner's alert address never appears in it.
- Every migration is a new pair. This one is 000063.
- `make lint` fails a Bicep warning (TYRE-79) and the comment standard.

## Approaches

ADR-0025 weighs the runner (a Container Apps job, a ticker in the API,
`pg_cron`, a GitHub schedule, and an Azure Functions timer, which the
owner asked about) and how the job reaches every tenant (as
`app_login`, as its own role, as the administrator), with each option's
real downside. This spec builds its decision: a Container Apps job that
connects as `app_job`.

## The design

### 1. The job resource (`infra/app.bicep`)

A second resource beside the API app, of type `Microsoft.App/jobs`, named
`caj-daily-<env>`.

- It runs in `cae-tyre-<env>` with the identity `id-tyre-api-<env>`, pulls
  from the same registry with that identity, and runs the release's
  `apiImage`, so the job and the API are always the same build.
- Trigger `Schedule`, cron `15 22 * * *`. That is 22:15 UTC, which is
  00:15 in South Africa all year, since the country keeps no daylight
  saving time. A comment on the line says so and cites U232.
- `parallelism` 1, `replicaCompletionCount` 1, `replicaRetryLimit` 1,
  `replicaTimeout` 600 seconds.
- The container's `args` are `job` and `daily`. The image's entrypoint
  stays `/api`.
- One secret, `job-database-url`, resolved from `kv-tyre-api-<env>` by the
  job's identity, bound to the environment variable `DATABASE_URL`. The
  job gets no `AUTH_*`, CORS or proxy setting. That vault held
  `database-url` alone until now, and two places say so and change:
  the comment at `infra/platform.bicep:176-179`, and the runbook's vault
  proof, which every release runs (section 8).
- 0.25 CPU and 0.5 Gi, as the API has.

The template writes no role assignment. `id-tyre-api-<env>` already holds
AcrPull and Key Vault Secrets User on `kv-tyre-api-<env>`
(`infra/platform.bicep:213-232`).

`deploy.yml` needs no new step. Its `az deployment group create` applies
the job with the app. `scripts/deploy-gate.sh` keeps judging the API's
revision only.

### 2. The `job` subcommand (`api/cmd/api`)

`main` reads its arguments before anything else.

- No argument: the server starts exactly as it does today.
- `job daily`: the daily run, section 4. It reads `DATABASE_URL` and
  nothing else, opens no listener, and exits 0 or non-zero.
- Anything else: it prints one usage line to stderr and exits 2. A typing
  mistake in a template must never start a server inside a job.

The job's code lives in a package of its own under `api/internal`, not in
`httpapi`, and `main` only dispatches. It logs JSON to stdout through
`slog`, as the server does.

### 3. The role and the listing function (migration 000063)

**`app_job`.** `CREATE ROLE app_job LOGIN NOSUPERUSER NOBYPASSRLS
NOCREATEDB NOCREATEROLE`, guarded by `IF NOT EXISTS` as 000001:709-714
guards `app_login`, then `GRANT app_rw TO app_job`. It is a member of
`app_rw` and of nothing else, and owns nothing. Every tenant policy has no
`TO` clause, so each applies to `app_job` exactly as to `app_login`
(ADR-0024, Context). The migration sets no password. The owner sets one
per environment (section 8), as the runbook does for `app_login`.

**`app.active_tenant_ids()`.** Returns `SETOF uuid`: the `id` of every row
of `app.tenant` whose `state` is `ACTIVE`, and nothing else. It is
SECURITY DEFINER, owned by the migrating role, with
`SET search_path = app, pg_temp`. It takes no argument, so a caller cannot
steer it. `REVOKE ALL ... FROM PUBLIC`, then `GRANT EXECUTE ... TO
app_job`. `app_rw` is not granted it, so `app_login` cannot call it.

It has to be a definer the migrating role owns. With no tenant bound, row
security hides every tenant from `app_job`, and an `app_writer` definer is
bound the same way. This is ADR-0021's shape, and it is the third kind of
definer in the schema. `db/CLAUDE.md`, Adding a function, gains it as a
third named exception.

Only ACTIVE tenants are listed, because a PROVISIONING tenant's users are
not yet meant to sign in and a SUSPENDED or CLOSED tenant is refused at
the API (`api/internal/store/store.go:124-127`). A fleet nobody can open
gets no new tasks.

The down migration drops the function, which takes its grant with it. The
role and its membership stay, as 000061's down keeps `app_writer`: `DROP
ROLE` fails while any database in the cluster refers to the role
(`db/migrations/000061_trip_writes_through_definer.down.sql:1-4`), and the
harness's cluster holds three databases that do. The up's `IF NOT EXISTS`
guard is what lets up, down and up run.

The owner was offered B31 as written, with the function granted to
`app_rw` and no second role, and chose `app_job` (U234). ADR-0025's
Option 1 states what the other way would have cost.

### 4. The daily run

1. Open a pool of at most 2 connections, set in code. Get the tenant ids.
   The run takes them from a function it is given. The real job passes
   one that reads `SELECT id FROM app.active_tenant_ids()` with no tenant
   bound. A test passes the tenants it planted (section 10).
2. For each tenant id, in a fixed order, run one `store.InTenantTx`:
   - take `pg_advisory_xact_lock` on a key made from a constant for this
     job and the tenant id, so two runs at once take turns per tenant and
     the second sees the first's tasks;
   - ask `app.active_tenant_ids()` again whether the bound tenant is in
     it, and skip the tenant if not, so one suspended, closed or deleted
     after the listing and before this check gets no task (found in
     review, CR-4). A change committed after this check, while the
     tenant's transaction runs, counts as after the run: the steps never
     read the tenant's state, and a lock on its row that an
     administrator's `UPDATE` would wait on needs `UPDATE` on
     `app.tenant`, which `app_rw` does not hold (CR1-1);
   - run each daily step. Today there is one:
     `SELECT app.generate_inspection_tasks(app.tenant_today((SELECT timezone FROM app.tenant)))`.
     The tenant's day comes from SQL, in the tenant's own zone (rule 6).
3. A tenant whose transaction fails is logged and the run goes on to the
   next. The run exits non-zero if any tenant failed.
4. The whole run has a deadline shorter than the job's `replicaTimeout`,
   so it ends by its own exit code and not by Azure killing it.

The steps are a list in one place, each a name and one SQL statement run
inside the tenant's transaction. TYRE-243's exception pass becomes a
second entry.

A retry by Azure runs every tenant again. That is safe because the
generator skips what it already issued. Zero ACTIVE tenants is a
successful run. Production is in that state until its first tenant is
activated.

### 5. What the job logs

Every line is JSON with a `job` field of `daily` and an `event` field.

- `daily_job_started`.
- `daily_job_tenant_done`, with the tenant id, the step and the number of
  tasks created.
- `daily_job_tenant_skipped`, with the tenant id, for a tenant listed
  ACTIVE that was not by its turn (section 4).
- `daily_job_tenant_failed`, with the tenant id, the step, the SQLSTATE
  and the constraint name when the error has one. Never the error's
  message, detail or hint. This schema's own messages name people, such
  as `'%s is no longer active'` with a display name
  (`db/migrations/000060_per_trip_assignment.up.sql:148`), and the step
  list is built to take TYRE-243's steps (NFR-PRV-007). An error that is
  not a database error logs its Go type and no text.
- `daily_job_succeeded`, with the tenant count and the total created,
  written once and only when every tenant succeeded.
- `daily_job_failed`, with the count of failed tenants.

A tenant id is an identifier and not personal information. No name, email
address, staff number or registration is logged.

The `job` and `event` values of the success line are a contract with the
alert. Each is one Go constant, and a check in `make lint` fails when
`infra/platform.bicep`'s query does not name the same two values. It is a
lint script and not a Go test, because `make api-test` mounts only `api/`
into its container (`Makefile:209-210`). Nothing outside the job's package
writes a line with a `job` field.

### 6. The alert (`infra/platform.bicep`)

Two resources in the owner's template.

**An action group, `ag-tyre-owner`,** with one email receiver. The address
comes from the apply's environment through
`readEnvironmentVariable('OWNER_ALERT_EMAIL')` in each
`platform.<env>.bicepparam`, the way `DEV_MACHINE_IP` does, so it is never
committed. Production may already hold a group of this name, made by hand
at bring-up step 6 (`docs/runbooks/environment-release.md:813-836`). The
template then takes it over under the same name, and the what-if shows it.

**A log search alert rule, `alert-tyre-daily-job-<env>`,** scoped to
`log-tyre-<env>`. Its query parses `Log_s` of `ContainerAppConsoleLogs_CL`
as JSON and counts the rows of the last 26 hours whose own `job` field is
`daily` and whose `event` field is `daily_job_succeeded`. It fires when
the count is below 1. It is evaluated every hour and resolves
itself when a success line arrives. The 26 hours are a day plus the run's
timeout and Log Analytics' ingestion delay, so yesterday's success cannot
age out while today's run is still in flight.

The query reads `Log_s` and no job-name column. `Log_s` is a documented
column, the job-name columns are not, and each environment has its own
workspace. It matches parsed fields and never a substring, because the
API writes text a stranger chooses into the same table: a bearer token
with an unknown key id is logged with that id
(`api/internal/bearer/bearer.go:133-135,157-158`). As a substring, a
request carrying the success text as its key id would silence the alert.
As a JSON value it cannot become a top-level `job` or `event` field. If
the query were wrong in the other direction, the alert would stay fired,
which is the safe way to be wrong.

One rule covers a run that failed after its retry, a run that never
started and a run that produced no logs. With a run at 22:15 UTC, the
owner hears within about two hours.

The rule fires as soon as it is applied, because no success line exists
yet. That first email and the "resolved" email after the first good run
are the proof that the alert works, on staging and again on production.

It lives in the owner's template because the address has no other safe
source. It depends on the workspace, which exists whether or not the job
has been deployed, and on `ContainerAppConsoleLogs_CL`, which does not:
the table appears only once a container in the environment first logs.
Azure runs a rule's query when it creates the rule, so the rule sets
`skipQueryValidation`, and a new environment's first platform apply
succeeds before any container has run
(https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-troubleshoot-log).
Until the table exists the query fails and the rule cannot fire, and
Azure disables a rule whose query fails for a week (same page), so a new
environment's first release follows its platform apply within the week.
With validation off, the fire and resolve of definition of done item 7
proves the query, and `scripts/check-job-log-contract.mjs` holds its two
values. `infra/app.bicep` stays free of the rule, so no release can fail
on a missing action group.

Cost per environment: the job about one US cent a month, and the rule at
most $1.50 a month.

### 7. Staging's database stays running

U232 ends the habit of stopping staging's database while idle. ADR-0017
gains a dated amendment saying so and why: a daily job and an alert on it
are only trustworthy when the database is there. The amendment names the
cost ADR-0017 already budgeted in full.

The runbook's "While an environment's Postgres is stopped" paragraph is
reworded: staging's server is left running, and a stopped one now fails
the nightly job and raises the alert. `deploy.yml`'s step that starts a
stopped staging server stays, since Azure can still stop a server and a
deploy must not fail on it.

### 8. Release order and the owner's steps

The job's template names a secret, and a release fails if Key Vault
cannot resolve it. The role behind that secret is created by a migration,
and staging migrates only after the merge (U94). So the secret is written
first, for a role that does not exist yet.

**Staging, before the merge.** One runbook block: generate a password,
store it as `pg-app-job-password` in `kv-tyre-staging`, and store
`job-database-url` in `kv-tyre-api-staging` as the DSN for `app_job`
with that password. The DSN names no `pool_max_conns`.

The runbook's vault proof (bring-up step 2,
`docs/runbooks/environment-release.md:94-101`, run again by Each release
step 4) changes with it. The owner's vault must show three passwords, the
third being `pg-app-job-password`. The API's vault must show
`database-url` and `job-database-url` and nothing else. The proof also
reads `app_job`'s attributes and that `job-database-url` names
`psql-tyre-<env>` and the role `app_job`, as it does for `database-url`
and `app_login`. On the release that carries this change, the proof's
`app_job` lines are read after the migrate.

**Staging, after the merge's deploy is green.**

1. Each release, as today: migrate to 000063.
2. Set `app_job`'s password from `pg-app-job-password`, as bring-up step 5
   does for `app_login`.
3. Apply `infra/platform.bicep` with `OWNER_ALERT_EMAIL` set. Read the
   what-if first: two Creates on staging, the action group and the rule.
4. The alert email arrives within the hour. Start the job by hand with
   `az containerapp job start`, read its `daily_job_succeeded` line in Log
   Analytics, and wait for the "resolved" email.
5. Next morning, read the 22:15 UTC run's lines the same way.

**Production, at its next promotion.** Production migrates before it is
promoted, so the order is plain: migrate, set the password and both
secrets, apply the platform template, then promote. The runbook's Promote
to production section gains the line that `job-database-url` must exist
before the promotion.

**Every release's checks** (runbook, Each release, step 4) gain three
reads as `tyreadmin`: `app_job`'s attributes, which must print
`f|f|t|f|f|f` for superuser, bypass, login, create role, create database
and replication; the function's owner, definer flag and ACL; and that
`app_login` may not execute it. The owner read also prints the function
owner's `rolsuper OR rolbypassrls`, which must be `t`. If it is `f`, the
owner no longer bypasses row security, the function returns nothing and
the job is silently visiting nobody (ADR-0021). One more read, as
`app_job` through `job-database-url`'s own DSN, runs
`SELECT count(*) FROM app.active_tenant_ids()` beside the administrator's
count of ACTIVE tenants. That one proves the secret reaches the function.
It cannot prove the bypass, since `app.tenant` is under forced row
security and an administrator that lost the bypass would count zero too
(the planner's correction, lead's call 20).

### 9. Rolling back

A rollback dispatch applies today's template with an older image
(`deploy.yml`, `IMAGE_SHA`). An image from before this change has no
`job` subcommand and ignores its arguments, so the job would start a
server, run until `replicaTimeout`, fail and alert every night until the
rollback ends. The runbook's Roll back section says so, and says the alert
is expected for that case.

### 10. Tests

**`db/tests/004_tests.sql`, as `app_login`.**

- Check 8c gains the function as a third class with its own exact pin: a
  definer, owned by the role that owns `app.tenant`, returning `uuid`,
  `search_path` pinned, and an ACL of its owner and `app_job` only.
- Section 67a is unchanged and must still pass. A new leg beside it shows
  the call itself is refused for `app_login` with 42501.
- A new section pins `app_job`'s attributes and that it is a member of
  `app_rw` alone and owns no relation or function.

**`db/tests/005_privileged.sql`, staged as `postgres`, each probe after
`SET LOCAL ROLE app_job` and an assertion of `current_user`.**

- With no tenant bound, `app.active_tenant_ids()` returns the ACTIVE
  tenants' ids. A PROVISIONING, a SUSPENDED and a CLOSED tenant planted
  for the test are each absent, and an ACTIVE control planted beside them
  is present.
- With no tenant bound, `app_job` reads zero rows of `app.tenant` and of
  one tenant-scoped table directly. Bound to one tenant, it reads that
  tenant's rows and none of another's, and an insert naming another
  tenant is refused. This is the rule 1 proof for the new role.

Each test is seen failing first, and each refusal has a control the same
probe still passes (`docs/lessons.md`, 2026-09-03).

**Go, against a real Postgres, connecting as `app_job`.**

- The tests give the run the tenants they planted and never the whole
  database's list. `go test ./...` runs other packages against the same
  database at the same time, and one of them plants an ACTIVE tenant and
  counts what the generator returns
  (`api/internal/httpapi/units_test.go:1336-1395`), so a job run over
  every tenant would break that test and be broken by others' clean-up.
- One test calls the real listing as `app_job`. It asserts that an ACTIVE
  tenant it planted is in the result and one it planted in another state
  is not, and runs no step.
- Two planted tenants with a due schedule each get a task, and a second
  run creates nothing.
- With a step that fails for one tenant, the other tenant's task is still
  created, the run returns an error, and no `daily_job_succeeded` line is
  written.
- The log lines carry the fields section 5 names. A failure whose
  database message names a person logs the SQLSTATE and not the name.
- An unknown argument exits 2 and opens no listener. No argument still
  starts the server.

Local and CI databases set `app_job`'s password where they set
`app_login`'s (`Makefile:222,230`, `.github/workflows/ci.yml:94,195,355`),
and the Go tests get its DSN in a variable of its own beside
`TEST_DATABASE_URL`.

**Lint.** The check of section 5 runs in `make lint` and in CI, with a
self-test that shows it fails on a query naming another value.

**The harness.** `make db-provision-test`'s stand-in leg runs 000063 up,
down and up as a role that is not a superuser.

**Infra.** `make infra-lint` covers both templates and all four param
files. `platform.<env>.bicepparam` gains the new variable, so the lint's
`build-params` call must supply it as it supplies the other three.

### 11. Email

Not built. What this ticket records and leaves:

- ADR-0025 says Azure Communication Services Email is not used and why,
  and names the three replacements researched.
- The owner said on 18 Nov 2026: "just pause this email stuff for now, we
  will probably fo with option 2, but i will bring it up at the
  shareholders meeting this afternoon". Option 2 is Microsoft Graph
  through an Exchange Online mailbox on the owner's domain.
- The ticket's definition of done asks for an ADR that records the email
  provider and Bicep that declares it. The owner moved both to TYRE-243
  (U233: "move the email stuff to 243 as recommned"). TYRE-243 carries a
  "Folds in" comment (14302) with the research, and this PR closes
  TYRE-371 without them.

### 12. Documents

| File | Change |
|---|---|
| `docs/adr/0025-...md` | New. Accepted on approval |
| `docs/architecture.md` | Index line for 0025. A paragraph on the job under Environments |
| `docs/adr/0017-...md` | Dated amendment: staging's database stays running (U232) |
| `docs/adr/0005-...md` | Dated amendment to the pool arithmetic: the job's 2 connections make the peak 30 of 35, and 32 when two executions overlap |
| `docs/adr/0021-...md` | Dated line: the listing function is a second definer the migrating role owns |
| `docs/runbooks/environment-release.md` | Section 8's steps and the changed vault proof, the stopped-server paragraph, Roll back |
| `infra/platform.bicep` | The comment at 176-179: the API's vault holds the two DSNs |
| `db/CLAUDE.md` | Adding a function: the third exception. The 005 paragraph: the new probes |
| `api/CLAUDE.md` | `InTenantTx` has one caller, the job. The `job` subcommand |
| `CLAUDE.md` | No change expected. If a `make` target is added, the Commands block |

The Confluence page "Azure Environment - Staging" (10682399) may still
describe stopping the database. That is the owner's Cowork agent's edit,
listed at hand-over.

### 13. Staging and production

Staging gets the job at the merge. Production gets it at its next
promotion, with the same template. Production holds no recurring schedule
until TYRE-133 gives controllers a way to make one, so its nightly run
creates nothing and still proves the runner and the alert.

### 14. What the owner ruled at approval

1. **The job's database role** (departure 2): `app_job` (U234).
2. **The runner.** The owner asked on 18 Nov 2026 whether an Azure
   Function could do this. ADR-0025's Option E answers it, and the owner
   then approved the Container Apps job (U234).
3. **Where the email half lives:** TYRE-243 (U233).

## Definition of done

1. ADR-0025 is Accepted and indexed. It records the runner, the identity
   it runs as, how the job binds tenant context without a superuser, and
   that the email provider is TYRE-243's to choose (U233).
2. Migration 000063 adds `app_job` and `app.active_tenant_ids()`, and the
   suite and `005_privileged.sql` hold the proofs in section 10.
3. `infra/app.bicep` declares the job. `infra/platform.bicep` declares the
   action group and the alert rule.
4. `api job daily` runs the generator for every ACTIVE tenant under row
   security, and the Go tests in section 10 pass.
5. The documents in section 12 are changed.
6. `make check` is green.
7. After the merge, on staging, the owner's steps in section 8 are done:
   the hand run and the next scheduled run each show a
   `daily_job_succeeded` line in Log Analytics, and the alert was seen to
   fire and to resolve. This is the ticket's "runs once a day on staging,
   and each run shows in Log Analytics" and "a failed run is visible".

Items 1 to 6 are the PR's. Item 7 is the owner's after the merge.

## Lead's calls

Each is an engineering question settled from a source. The research file
is `.superpowers/sdd/2026-11-18-pipeline-TYRE-371/research-docs.md`.

1. **The job goes in `infra/app.bicep`, the alert in
   `infra/platform.bicep`.** The job must run each release's image, and
   only the pipeline's template sees it (`infra/app.bicep:12-15`). The
   alert needs the owner's address and no role assignment either way
   (`infra/platform.bicep:1-10`).
2. **Cron `15 22 * * *`.** "Cron expressions in scheduled jobs are
   evaluated in Coordinated Universal Time (UTC)"
   (https://learn.microsoft.com/en-us/azure/container-apps/jobs). 00:15
   is the owner's choice (U232).
3. **`replicaRetryLimit` 1.** "Set the replica retry limit to at least
   `1`, and design your workload for at-least-once processing" (same
   page). NFR-AVL-006 asks for a retry.
4. **The job guards itself against overlap with an advisory lock per
   tenant.** The schema has no concurrency setting
   (https://learn.microsoft.com/en-us/azure/templates/microsoft.app/jobs),
   and Microsoft's staff say "you'll need to create your own mechanism to
   ensure only 1 execution runs at a time"
   (https://github.com/microsoft/azure-container-apps/issues/1271).
   `pg_advisory_xact_lock` is released at the end of the transaction
   (https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS).
5. **The job resource uses the API version the app already uses,**
   `2024-03-01` (`infra/app.bicep:67`), which the pinned Bicep 0.47.16
   knows. The builder may move both forward together if lint asks.
6. **A log search alert on a missing success line, not a metric alert.**
   The `Executions` metric has a `state` dimension whose values are not
   documented
   (https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-app-jobs-metrics),
   and a metric alert would be scoped to a resource the owner's template
   does not own. Microsoft warns that log alerts can misfire on a lack of
   data (https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-types).
   The 26-hour look-back against a "delay of several minutes"
   (https://learn.microsoft.com/en-us/azure/container-apps/log-options)
   answers that. Hourly evaluation keeps the rule stateful: "Stateful
   alert rules with a frequency of more than 12 hours are not supported"
   (https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-create-log-alert-rule).
7. **The query reads `Log_s` only, parsed as JSON.** "The tables in this
   category are `ContainerAppSystemLogs_CL` and
   `ContainerAppConsoleLogs_CL`"
   (https://learn.microsoft.com/en-us/azure/container-apps/log-monitoring).
   The job-name column appears only in tutorials. Parsed fields and not a
   substring, from the builder check: the API logs a caller's key id
   (`api/internal/bearer/bearer.go:133-135`).
8. **The listing function is a definer the migrating role owns.**
   PostgreSQL skips row security for a superuser, a BYPASSRLS role and an
   unforced table's owner only
   (https://www.postgresql.org/docs/16/ddl-rowsecurity.html), and
   `tyreadmin` reads `rolbypassrls` true (ADR-0021, Context). It pins
   `search_path`, as the manual asks of every definer
   (https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).
9. **The positive probe of the function lives in `005_privileged.sql`.**
   `app_login` is not a member of `app_job`, so the suite cannot become
   it, and 005's probes after `SET LOCAL ROLE` are what `db/CLAUDE.md`
   says prove isolation.
10. **The job's pool is 2 connections, set in code.** 4 replicas at 7 is
    28, and 30 of 35 leaves 5 for `migrate` and an administrator session
    (ADR-0005, TYRE-305 amendment). Two executions can overlap (call 4),
    which makes it 32 and leaves 3. A DSN typed into a vault is the less
    testable place for the number.
11. **The tenant's day is `app.tenant_today`,** the function every other
    tenant-day read uses (`db/migrations/000015_tenant_local_assignment_predicate.up.sql:16`).
12. **Failure lines carry SQLSTATE and constraint name, never message,
    detail or hint.** A constraint error's detail quotes the row's values
    (https://www.postgresql.org/docs/16/protocol-error-fields.html), and
    this schema's messages name people
    (`db/migrations/000060_per_trip_assignment.up.sql:148,248`). From the
    builder check.
13. **No actor is bound.** The audit trigger already permits the
    generator's inserts with none
    (`db/migrations/000038_inspection_task_write.up.sql:91-94`).
14. **An unknown argument exits 2.** The convention for a usage error,
    and the control that keeps a mistyped template from starting a server
    in a job.
15. **Contributor can create the job.** It writes no role assignment, and
    Contributor's only exclusions are authorization writes
    (https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/privileged).
16. **The down migration keeps the role,** as 000061's does
    (`db/migrations/000061_trip_writes_through_definer.down.sql:1-4`).
    From the builder check.
17. **The Go tests narrow the run to planted tenants,** through the
    function the run is given, since the packages share one database
    (`api/internal/httpapi/units_test.go:1336-1395`). From the builder
    check.
18. **The log contract is checked in `make lint`,** since `make api-test`
    cannot read `infra/` (`Makefile:209-210`). From the builder check.
19. **`job-database-url` joins `database-url` in the API's vault,** and
    the vault proof changes to expect it
    (`docs/runbooks/environment-release.md:94-101`). The job runs as the
    API's identity (U147 B31), which reads that vault. From the builder
    check.
20. **The release check reads the function owner's bypass attribute.**
    Comparing two counts cannot show a lost bypass, because forced row
    security binds the administrator's own read of `app.tenant` too
    (`db/migrations/000001_init.up.sql:557-561`,
    https://www.postgresql.org/docs/16/ddl-rowsecurity.html). From the
    planner, 18 Nov 2026, after approval.

## Left to the builder

- The name and layout of the job's Go package, and how `main` splits.
- How the deadline and the pool size are set, within section 4.
- The advisory lock's key.
- The exact KQL and the rule's property names, within section 6.
- Section numbers in the suite and 005.
- How a failing step is staged in the Go test.
- Whether local development gets a `make` target for the job.
- The wording of each runbook block, following the blocks beside it.

## Rejected

- **An Azure Functions timer as the runner.** Its timer runs one instance
  at a time, which saves the advisory lock. It costs a storage account, a
  hosting plan, a function app, storage role assignments, a second Go
  program built as a zip, and a second deploy path that ADR-0017's
  promote-what-staging-ran rule would have to cover. The alert is still
  ours to write. ADR-0025, Option E.
- **A deploy-time run of the job.** Non-goals says why.
- **A separate identity and vault for the job.** It would also hold
  against someone acting as the API's identity, at the cost of a second
  identity, a second AcrPull grant and a third vault per environment. Too
  much for the pilot. ADR-0025 lists the gap under Bad.
- **Treating zero tenants as a failure.** Production starts with none.
- **A session-level advisory lock for the whole run.** It needs one
  connection held for the run and pinned through the pool. The
  per-tenant transaction lock needs neither.
- **Building the email sender against a provider now.** The owner paused
  the choice, and a sender written before it would be written twice.
