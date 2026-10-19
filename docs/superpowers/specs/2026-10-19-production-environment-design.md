# Design: the production environment (TYRE-397)

- **Date:** 2026-10-19
- **Tickets:** TYRE-397, under epic TYRE-10. Folded in:
  - TYRE-433, at the owner's request when the run started: nothing flags a
    merge that carries a migration.
  - By comments on TYRE-397: TYRE-313 (c13667), TYRE-411 (c13696), TYRE-403
    (c13707), TYRE-401 (c13717) and TYRE-402 (c13781).
  - TYRE-203's Bicep half, which ADR-0017 makes a gate on production.
- **Decisions it rests on:**
  - ADR-0017 (Option B), ADR-0004 (branching), ADR-0019 (runtime
    `config.json`).
  - Owner rulings U89, U93, U94, U116, U117, U118 and U138, and TYRE-203's
    owner decision of 23 Sep (c13022).
  - The owner's answers in this spec's conversation, 19 Oct 2026, in
    section 2. They are proposed as ruling U139.
- **Requirements:** NFR-BAK-001, 002, 003, 005 and 007; NFR-MNT-006 and 007;
  NFR-AVL-003; NFR-PRV-008; NFR-SEC-012. NFR-BAK-004 (the restore rehearsal)
  stays with TYRE-321.
- **Evidence:** Microsoft Learn, read 18 and 19 Oct 2026. Each claim is
  tagged *documented* (the docs say it) or *reported* (other users say it,
  not checked here).

## 1. Why this exists

BAC's drivers are about to capture real readings, and readings are never
deleted (rule 3). The owner ruled that staging never holds real data (U116),
and ADR-0017 decided the shape: a second environment, production, stamped
from the same templates, holding only the pilot tenant and deployed from
`main`. None of production exists yet.

Two things make this more than a copy of staging:

- **Backups are a gate.** Production may hold nothing real until its backups
  meet the NFR-BAK requirements. Today `infra/platform.bicep` keeps 7 days
  with no geo copy and no blob versioning.
- **Staging ran four migrations behind `develop` for five days** (TYRE-433),
  because the migrate step is manual (U94) and nothing reminded anyone. On
  staging that broke test requests. On production it would break real
  users' requests.

## 2. What the owner decided (19 Oct 2026)

- **BAC's production account starts empty.** None of BAC's old data goes
  in: not the Appendix E and J fixture, and not the paper history
  (TYRE-430, which is not part of go-live).
- **The tyre register is built during onboarding** (consistent with U93).
- **Onboarding is a live run with a BAC member,** as the first real test of
  the onboarding process. Creating BAC's account is step one of that run,
  under TYRE-321, not this ticket. That covers BAC confirming its
  thresholds, its signed agreement records (U138) and its first admin.
- **So TYRE-397 is done** when production is up, its first release is
  verified (section 5), and its backups are in place.
- **Production's API stays awake.** One replica always runs, for about R100
  a month, so the first driver of the day does not wait for it to wake.

The owner also described what BAC's first day needs. Each part is owned
elsewhere, and none of it is this ticket's:

- **Vehicles and horse-and-trailer pairings set up at onboarding.**
  Importing vehicles is TYRE-322; pairings already have the rigs screen.
- **Each driver assigned to a horse before they sign in.** The Add driver
  screen does this today. TYRE-326 adds it to the unit screen, and TYRE-319
  lets a driver start from their assigned vehicle without a task.

## 3. Goals, non-goals, anti-goals

**Goals**

1. Production, stamped from the same templates as staging, with
   configuration that differs only by value (NFR-MNT-007).
2. Production's backups meet NFR-BAK before anything real lands.
3. A fast-forward of `main` deploys production with the image staging
   already ran, and the deploy refuses anything else.
4. A production release never runs new code against an old schema, and
   staging's owed migrations are named after every merge that adds one.
5. The folded tickets' work (sections 4.3 to 4.5).

**Non-goals**

- Creating BAC's account, users, vehicles, pairings or tyre register
  (TYRE-321, TYRE-322, TYRE-326, TYRE-319, TYRE-286).
- Importing history (TYRE-430).
- The restore rehearsal (NFR-BAK-004, TYRE-321).
- An automated migrate (U94).
- A deploy check that reads the database's schema version. That is raised
  as TYRE-434, to land before the first release after BAC's onboarding (see
  section 4.5).
- Production's own registry or CIAM tenant (ADR-0017, Revisit when).
- A custom domain.
- TYRE-398's further smoke tests. This ticket reuses the read-only smoke that
  exists.

**Anti-goals.** Any of these would make the work a failure even if every
check passes:

- Production runs an API image staging never ran.
- Real data reaches staging, or test data reaches production.
- A deploy goes green while production does not serve the new build.
- A commit authored on `main`, or a re-run of an old CI run, changes what
  production serves.
- The one-shot backup choice in production's first apply is made by
  accident.

## 4. Design

### 4.1 Templates

`infra/platform.bicep` takes per-environment values as parameters. They
default to staging's values, so staging's next apply changes only the blob
protections:

| Setting | Production | Staging | Why |
|---|---|---|---|
| Postgres backup retention | 30 days | 7 days | NFR-BAK-003; 30 also covers NFR-BAK-002's 7 days of point-in-time restore. Staging keeps 7 (ADR-0017). |
| Geo-redundant backup | Enabled | Disabled | See below. |
| Blob versioning, blob soft delete, container soft delete | 30 days | 30 days | NFR-BAK-007. The same in both, because the cost is immaterial and one fewer value differs. |
| `CanNotDelete` lock on the Postgres server and the storage account | yes | no | See below. |
| Postgres maintenance window | custom: Sunday 02:00 to 03:00 SAST (00:00 UTC) | system-managed | NFR-AVL-003. See below. |

- **Geo-redundant backup.**
  - It can be chosen only when the server is created *(documented)*. So
    production's first apply fixes it, and changing it later means
    rebuilding the server.
  - The copy goes to the paired region, South Africa West, so backups stay
    in South Africa (NFR-PRV-008).
  - Geo-restore loses at most about an hour of data *(documented)*, which
    meets NFR-BAK-005.
  - At pilot size it costs close to nothing *(documented pricing: backup
    storage up to the 32 GB provisioned is free)*.
  - Restoring into South Africa West may need a support request, because
    access to that region is restricted *(reported)*. TYRE-321's rehearsal
    should confirm this.
  - The cost of not choosing it now is a rebuild later. My call.
- **The lock.**
  - Deleting a flexible server deletes all of its backups, and Microsoft
    recommends a lock *(documented)*. Deleting the storage account would
    delete the photos, versions included.
  - Contributor cannot write locks. The platform template is the owner's to
    apply (U117), so the lock goes there.
  - A lock also binds child resources such as firewall rules. The builder
    confirms against the docs that it blocks none of the runbook's steps:
    updating the firewall rule, and starting or restarting the server.
    My call.
- **The maintenance window (NFR-AVL-003).**
  - Azure patches the server about monthly, with some downtime. It sends a
    notice five calendar days ahead *(documented)*.
  - A system-managed window can land anywhere from 23:00 to 07:00 server
    time, and 06:00 to 07:00 falls inside the requirement's 06:00 to 18:00
    *(documented)*. So production gets a custom window.
  - Staging stays system-managed. Microsoft recommends that for test
    servers, because they receive each update at least seven days before
    custom-window servers *(documented)*, which makes staging an early
    warning.
  - A critical security update can arrive with less notice or none
    *(documented)*. That is accepted.
  - The owner gets Azure's notices by email through a Service Health alert,
    and passes them to BAC (section 4.6). My call.
- **Requirement IDs.** Cite NFR-BAK IDs where these values are set. The
  staging values cite ADR-0017.

`infra/app.bicep`: `minReplicas` becomes a parameter, 1 for production and 0
for staging. `maxReplicas` stays 2, the bound the rate limiter's
per-process counters assume (TYRE-184 F7, `ratelimit.go`).

`infra/app.prod.bicepparam` matches `app.staging.bicepparam` except for
`env = 'prod'` and `minReplicas = 1`. The auth values are the same, because
there is one CIAM tenant (ADR-0017). Every resource name follows ADR-0017's
Names list.

### 4.2 Deploy

One deploy workflow serves both environments, parameterised by environment.
ADR-0017 calls it a reusable deploy workflow, called as a job in CI's own run
for the pushed branch. Every name derives from the environment: resource
group, app, server, static web app and parameter file. The registry is
`crtyrestaging` for both.

| | Staging | Production |
|---|---|---|
| Runs on | CI, on a push to `develop`, after every gate job | CI, on a push to `main`, after every gate job |
| GitHub environment | `staging` (branch `develop` only) | `production` (branch `main` only) |
| API image | builds and pushes `tyre-api:<sha>`; after the gate passes, records that this image passed staging | builds nothing; deploys `tyre-api:<sha>` |
| Refuses unless | (no extra check) | the commit is an ancestor of `origin/develop` **and** staging's record says that image passed staging's gate |
| Database not `Ready` | starts it and waits | fails: production's server is never stopped, so a stopped one is an incident, not a step (my call) |
| Gate | `scripts/deploy-gate.sh`, unchanged | the same |
| Web | build, bundle checks, `config.json`, upload, `deploy-smoke.sh` | the same, built from the same commit |

**Why a record, not the tag (my call).**
- ADR-0017 asks only that the tag exists. But staging pushes the tag before
  its gate runs, so an image whose staging deploy failed still has one.
- Production would accept it, against the first anti-goal.
- So staging writes a second record, and only once its gate has passed for
  that exact image. A staging rollback that passes the gate writes the
  record for the image it rolled back to.
- The builder chooses the mechanism. Two examples: a second registry tag,
  or a GitHub deployment record keyed by the image's commit. Whichever it
  is, production's deploy identity must be able to read it.
- Note that a GitHub deployment's own commit is the run's commit, not the
  image's, so it is not enough on its own.
- The ADR-0017 amendment records the stronger rule.

**Refusals that apply to both environments:**

- **A re-run of an old CI run is refused (TYRE-403, my call: refuse rather
  than record it as a rollback).**
  - When a re-run (`run_attempt` above 1) starts, its commit must still be
    the head of its branch. Otherwise the re-run is refused, red. Without
    this, re-running yesterday's run would quietly move the environment
    back, with no rollback record. Going back is only by rollback.
  - A first attempt deploys as it does today, even if a newer merge landed
    while it waited. Runs for one branch queue in order, so the newer run
    deploys right after it. Refusing the first attempt would turn every
    quick pair of merges red, and close-out stops on a red run.
- **Rollback (NFR-MNT-006)** is a manual dispatch with `image_sha`: from
  `develop` for staging, from `main` for production.
  - Production's rollback image must be an ancestor of `origin/main`, and
    must carry staging's passed record. Being an ancestor does not prove
    production ever ran it: commits between two promotions are ancestors
    too. It does prove the commit was promoted, and staging vetted it.
  - Like staging's rollback, it redeploys that image under the current
    template and rebuilds the web from that commit.
  - It is recorded as a rollback in the release table.

**Gate rule (TYRE-411):** A stands. The deploy is green when `/readyz`
answers with the expected commit and revision at 100% traffic. Production
reuses the gate unchanged. My call, recorded on TYRE-411.

**Concurrency.**
- CI's top-level `cancel-in-progress` excludes `main` as well as `develop`,
  so a production deploy is never cancelled halfway.
- Production's jobs have their own concurrency groups, separate from
  staging's.

**Production's deploy identity.**
- It needs to read `crtyrestaging` to check the image and staging's record:
  AcrPull on that registry, granted by the owner.
- Staging's identity has always held Contributor on the registry's resource
  group, so these steps have never run with AcrPull alone. The builder
  checks against the docs whether `az acr login` also needs Reader on the
  registry. If it does, the owner grants that too.
- Both grants are read-only. They add to ADR-0017's "Contributor on its own
  resource group only", and the ADR's amendment records them.

**Left to the builder:** the workflow file layout, job and workflow names in
the Actions tab, and how the environment is passed.

### 4.3 Pull requests into main are closed (TYRE-313)

- A workflow closes any pull request whose base is `main`, with a comment
  citing ADR-0004 and U73.
- It is not a required check.
- It never checks out or runs the pull request's code. If it uses
  `pull_request_target`, that rule is what keeps it safe.
- It lands in the same PR as the deploy on `main`.

### 4.4 The comment-style gate (TYRE-401)

`scripts/check-comment-style.mjs` also checks:
- `.bicepparam` files, which use slash comments;
- `*.Dockerfile` files such as `infra/bicep.Dockerfile`, which use hash
  comments.

Each new file type gets a planted self-test case. Any existing file that
fails once it is checked is fixed in this branch.

### 4.5 Release order and reminders (TYRE-433)

**Staging keeps its order:** merge, deploy, then migrate
(`environment-release.md`, When to migrate). The new part is the reminder:

- When the merged PR adds a file under `db/migrations/`, close-out's report
  and its ticket comment list "Run environment-release.md Each release on
  staging, to <highest migration>" under Waiting on the owner.
- A dry run against #122's merge shows the reminder (TYRE-433's definition
  of done).
- Close-out still closes the ticket as it does today. TYRE-433 proposed
  holding the ticket open until the release row exists. That would give
  close-out a second state it has to come back and clear, and the reminder
  plus the production rule below cover the risk. My call.

**Production migrates first, then promotes.** In plain words: new code needs
the new tables, so the database moves first, and the code production is
still running copes with the newer tables for the few minutes until the new
code lands. The runbook's Roll back already relies on the same property:
"an old image must tolerate" the schema at head. TYRE-433 was framed as
updating production's database *after* a release. This design does it
*before*, for the reason above. My call.

**Promote to production** is a new runbook section that close-out step 7
follows:

1. **Choose the commit.** It must be a `develop` commit that staging ran
   green, with staging migrated to that commit's highest migration.
2. **Migrate production first if it is behind.** If production's version is
   below that commit's highest migration, run Each release steps 1 to 4
   with `ENV=prod`. Run them from a checkout of that exact commit, not
   `develop`'s head, which may hold newer migrations. Stop on anything step
   3 stops on.
3. **Fast-forward `main`** to that commit with `git push origin <sha>:main`,
   never through a pull request (ADR-0004).
4. **CI on `main` deploys production.** The gate and the smoke must pass.
5. **Record the release** on page 10682399 (U118).

**Close-out step 7 never migrates production (my call).** Production holds
real data, and the migrate runs as the database's admin.

- Step 7 promotes the chosen commit, not `origin/develop`, and only when
  production's version is already at that commit's highest migration.
- If production is behind, step 7 stops before the push. It lists "migrate
  production per Promote to production, step 2" under Waiting on the owner.
- If the release carries a migration and the time is between 06:00 and
  18:00 SAST, step 7 stops too.
- It stops on a dirty version.
- The owner records the release row.
- The owner can still run the runbook with Claude in a session, as on
  19 Oct. That is the runbook path, with the owner present, not
  close-out's.

**What this order rests on.** Every migration must leave the schema usable
by the image production is running. Nothing checks this today.

- The PR template gets one line for PRs that add a migration: does the image
  now in production still work on this schema? My call.
- A migration that cannot meet the rule, such as dropping or renaming a
  column the running code reads, ships in two releases.
- TYRE-434 adds the automatic check: the deploy refuses when production's
  database is behind the commit. It is deferred because production's first
  release lands on an empty database, so it protects nothing until BAC's
  onboarding. Its ticket carries TYRE-433's question to the owner about U94.

**Release window (NFR-AVL-003, my call).**
- A release that carries a migration is promoted outside 06:00 to 18:00
  SAST.
- A release expected to interrupt service is announced 48 hours ahead.
- A release with no migration may go out at any time. Container Apps keeps
  the old revision serving until the new one is ready *(documented)*.

### 4.6 Production bring-up (the owner, after merge)

`environment-release.md` leaves production's first-apply order to this
ticket, because a new production has no vault and no secrets before its
first platform apply. The runbook gains a production bring-up in this order:

1. **The containers around it:**
   - resource group `rg-tyre-prod` in South Africa North;
   - workspace `log-tyre-prod`;
   - budget `budget-tyre-prod`: USD 50, with staging's alerts.
2. **The deploy identity `id-tyre-deploy-prod`:**
   - Contributor on `rg-tyre-prod`;
   - AcrPull on `crtyrestaging`, plus Reader on it if section 4.2's check
     shows `az acr login` needs it;
   - federated credential with subject `environment:production`, copied
     byte for byte from the live staging credential's form;
   - GitHub environment `production`, restricted to `main`, holding that
     identity's client id.
3. **The first platform apply:**
   - Generate the Postgres admin password locally and never echo it.
   - Run the platform what-if with `env=prod` (TYRE-402). Read every Create,
     Delete and Modify. Confirm that the API identity's AcrPull assignment
     targets `crtyrestaging`.
   - Into an empty resource group every line is a Create. Stop on any
     Delete or Modify, and on any Create outside `rg-tyre-prod` other than
     that AcrPull assignment.
   - Then apply. Geo-redundant backup is fixed at this moment: the runbook
     says so in bold.
4. **The secrets:**
   - Write `psql-admin-password` to `kv-tyre-prod`.
   - Create `app_login` and its password.
   - Write `pg-app-login-password` and `database-url`.
   - Prove the secrets as bring-up step 2 does. The builder writes these
     steps from staging's records (TYRE-368, TYRE-305) and does not invent
     new ones.
5. **Migrate production to head:** Each release steps 1 to 4, with
   `ENV=prod`. Nothing is dropped and no tenants are created.
6. **Sign-in:** add production's static web app origin to tyre-pwa's
   redirect URIs in the CIAM tenant.
   **Maintenance notices:** create a Service Health alert for planned
   maintenance on production's server, emailing the owner, if no existing
   alert covers it. The runbook says the owner passes each notice to BAC at
   least 48 hours ahead (NFR-AVL-003).
7. **The first release:** promote `main` (section 4.5).
8. **Verify and record:** section 5, then record the first row.

The runbook's Before anything works for `ENV=prod`. The staging-only steps
(drop the database, stop the server) keep their guards.

## 5. The first production release (U89)

Production has no tenant at its first release. "Verified" therefore means
all of the following:

- **The deploy job is green.** That covers the ancestry check and the check
  for staging's passed record, the gate (the new revision serves the commit
  at 100% of traffic), the web bundle checks, and the read-only smoke
  against production's two origins. Images from before this PR carry no
  record, so production's first release, and every rollback target after
  it, is this PR's merge or later.
- **The schema is at head.** Production is at the commit's highest
  migration, not dirty (Each release step 3).
- **Staging's sign-ins are refused in production.** The owner signs in at
  production's web address with the staging test account, and is refused,
  because the account names a tenant production does not have (ADR-0017,
  Identity provider). This is the by-hand proof that the two environments
  are isolated.
- **The release row is recorded** on page 10682399.

That release is U89's "first verified release".

## 6. Documentation

- **ADR-0017:**
  - Set its status to Accepted. Its PR merged, but the line still reads
    Proposed.
  - Add a dated amendment (TYRE-397, U139) covering:
    - production's API stays awake;
    - geo-redundant backup and the locks on production;
    - the deploy identity's read grants on the registry;
    - production refuses an image without staging's passed record, which is
      stronger than "the tag exists";
    - migrate before promote, the release window, and production's
      maintenance window;
    - BAC's provisioning moved to TYRE-321's live onboarding.
- **ADR-0005:** Superseded by ADR-0017.
- **`docs/architecture.md`:** a production row.
- **`docs/implementation-order.md`:** describes both environments.
- **`environment-release.md`:** sections 4.5 and 4.6, and production's Roll
  back.
- **`.claude/commands/close-out.md`:** the owed-release reminder, and step 7.
- **CLAUDE.md, Repo etiquette:** "`main` mirrors what production/staging
  runs" becomes "`main` is what production runs; `develop` is what staging
  runs".
- **Confluence page 10682399:** the owner adds production's environment and
  its first release row after the merge. Confluence is not in the PR.

## 7. Costs

These are monthly, at South Africa North retail prices (20 Aug 2026;
Container Apps from the retail prices API, 18 Oct 2026).

| Environment | Per month |
|---|---|
| Production | about R450 to R500: database about R264, storage and backup about R90, the awake API about R100. 30-day and geo backups cost about R0 at pilot size. |
| Staging | about R400 to R450 while its database runs, less while it is stopped. |
| **Total** | **about R850 to R950**, against the agreement's R3,500 cap. That is about R100 above U116's R350 to R400 for production, the cost of the awake API. |

## 8. Definition of done (narrowed, U139)

**In the PR:**
- Everything in sections 4 and 6, with `make check` green.
- Stubbed tests for each deploy refusal:
  - not an ancestor of `origin/develop`;
  - no record that staging's gate passed for the image;
  - a re-run of a commit that is no longer the head is refused (TYRE-403),
    while a first attempt in the same position deploys;
  - a production rollback image that is not an ancestor of `origin/main`,
    or carries no staging record.
- The comment gate's planted self-tests (TYRE-401).
- The close-out dry run against #122's merge (TYRE-433).

**After the merge, with the owner:**
- Production brought up as in section 4.6, with the what-if read first
  (TYRE-402).
- The first release verified and recorded as in section 5.
- The NFR-BAK settings shown live on production: 30-day retention, geo
  backup, blob protections and the locks.

**Ticket handling:**
- Close-out must not close TYRE-397 at the merge, because the after-merge
  half is part of its definition of done.
- TYRE-203: this branch carries its Bicep half. TYRE-203 stays open for the
  restore rehearsal, as its 23 Sep comment says, unless the owner splits
  the half out to a child ticket.

**Not in this definition of done:**
- BAC's account (TYRE-321).
- The restore rehearsal (TYRE-321).
- The schema check (TYRE-434).

## 9. Left to the builder

- The workflow layout and names, and whether the refusals live in scripts
  (testable like `deploy-gate.sh`) or inline.
- How the refusals are stub-tested in CI, following the existing script
  tests.
- How close-out detects that a merged PR added a migration.
- Where the locks sit in the template.
- The exact runbook wording, as long as it follows staging's existing
  blocks and guards.
