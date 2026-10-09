# ADR-0017: Staging holds no real data; production is a second environment

- **Status:** Proposed. Accepted when its PR merges.
- **Date:** 2026-10-09
- **Deciders:** Rourke
- **Supersedes:** ADR-0005 (environments and hosting)
- **Related:** ADR-0004 (branching; this closes its revisit trigger) ·
  ADR-0002 (region) · ADR-0016 (identity) · TYRE-397, TYRE-79, TYRE-368,
  TYRE-374, TYRE-203, TYRE-305 · owner rulings U89, U116, U117

## Context

ADR-0005 runs one Azure environment, named staging, and makes it production
for the pilot. That saved a second database bill while the pilot had no
users. Three things have changed since then.

- **Real data is close.** The pilot tenant's drivers are about to capture
  real readings, and readings are append-only (rule 3). Anything written
  beside them stays there. The environment that holds them also holds
  Sandbox Fleet, the Appendix E and J fixture and the suite's probe residue
  (TYRE-374). The owner has ruled that staging must never hold real user data
  (U116, TYRE-79 comment 13569).
- **Deploy bugs only show in Azure.** TYRE-79 is a deploy that went green
  over a crash-looping revision. A missing secret binding, a wrong setting
  or a static web app route can only be found by deploying. With one
  environment, the first place to find such a bug is the one the pilot
  users are on.
- **The deploy fix cannot be tried anywhere.** `main` deploys the only
  environment, and U89 holds `main` until the first verified release. A
  change to the pipeline has no environment to run in before it releases.

A QA stage, as such, is optional for one engineer. The published practice
ties delivery performance to small batches, automated tests, deployment
automation and fast recovery, not to how many environments exist
(learn.microsoft.com/azure/well-architected/mission-critical/mission-critical-deployment-testing).
Local tests already own correctness here: Appendix E to the cent, the
Appendix J pins, RLS and the browser smoke. The pilot is meant to find
workflow bugs. Two reasons for a second environment do not depend on QA at
all: real data must not share a server with resets and experiments, and the
TYRE-79 class of bug exists only in Azure.

The forces against a second environment are cost, since the Postgres server
is most of each environment's bill, and one engineer's time. Microsoft's
Well-Architected guidance also frames staging as a stage that one artifact
is promoted through, not as a mirror of a branch
(learn.microsoft.com/azure/well-architected/operational-excellence/safe-deployments).

This does not touch the tenancy model. Tenant isolation stays in the
database (rule 1), in both environments. The split between environments is a
data-handling boundary on top of RLS, not a replacement for it.

## Options considered

### Option A: one environment, staging is production (ADR-0005)

No new cost or setup. **Its real downside:** real data sits on the server
where test data, fixture rows and deploy experiments land, and a deploy
change is first exercised in front of pilot users.

### Option B: staging for test data, production for the pilot

Staging (`rg-tyre-staging`, as it exists) holds Sandbox Fleet and the
demonstration fixture and is deployed from `develop`. A new production
environment, stamped from the same Bicep, holds the pilot tenant only and is
deployed from `main`. Staging's Postgres is stopped while idle.
**Its real downside:**

- It costs about R350 to R400 a month more, at the 20 Aug 2026 South Africa
  North prices. That is a B1ms server at about R264, plus about R90 of
  storage and backup. Budget the full amount. Stopping staging's server
  saves compute only while it stays stopped, and every `develop` deploy
  starts it again, as does Azure after seven days.
- It doubles the operating surface: a second deploy identity, budget, Key
  Vault and set of secrets.
- Each environment follows a branch. The guidance's concern is code that
  diverges per branch. Here `main` is only ever a `develop` commit and the
  API image is promoted by SHA, so the branch decides when, not what.

### Option C: production only, test on laptops

The existing environment becomes production and nothing else. Testing runs
locally against Sandbox Fleet. **Its real downside:** a laptop has no Entra
sign-in, no Container Apps settings and no static web app routing, so the
TYRE-79 class of bug reaches the pilot first.

### Option D: one Postgres server, two databases

Staging and production share a server, each with its own database. This
saves most of Option B's cost. **Its real downside:** the two share an admin
credential, an extension allow-list, maintenance windows and the 35 user
connections that TYRE-305 already finds tight. A staging experiment that
loads the server slows production. Real data also sits on the server that
staging's tests reach.

## Decision

We will run two environments: staging, deployed from `develop` and holding
only Sandbox Fleet and the demonstration fixture, and production, deployed
from `main` and holding only the pilot tenant's real data (Option B).

The parts of the decision, each with the alternative not taken:

- **Branches.** Every merge to `develop` that passes CI deploys staging. A
  promotion of `main` that passes CI deploys production. `main` still
  advances only by a fast-forward push of a vetted `develop` commit, never by
  a pull request (ADR-0004). U89's "first verified release" is now the first
  production release.
- **Build once.** The staging deploy builds and pushes `tyre-api:<sha>`. The
  production deploy builds no image: it deploys the tag for the commit `main`
  points at, and fails if that tag does not exist. Production therefore only
  ever runs an image that staging ran first. Recovery is the same move
  backwards: redeploying the previous SHA's tag needs no build (NFR-MNT-006).
  *Not taken:* rebuilding the API per environment, which would leave
  production running a binary staging never ran.
- **The web bundle carries no per-environment setting.** Vite bakes its
  settings in at build time. The three `VITE_AUTH_*` values are the same in
  both environments, because both use one CIAM tenant and one tyre-pwa
  registration, and the API is reached by a relative `/api`. A rebuild of
  the same commit is therefore the bundle staging ran. A setting that ever
  has to differ per environment moves to runtime configuration (a fetched
  `config.json`), never to a per-environment build. Otherwise production
  would run a frontend staging never ran, and static web app routing is a
  TYRE-79-class bug.
- **Deploy identities.** Each environment has its own managed identity, with
  Contributor on its own resource group only:
  - `id-tyre-deploy-staging` exists today.
  - `id-tyre-deploy-prod` is new.

  Each identity trusts one GitHub environment through a federated credential
  with subject `environment:staging` or `environment:production`. GitHub's
  deployment-branch rule restricts `staging` to `develop` and `production` to
  `main`. Adding `environment:` to a job changes the OIDC subject, so the
  credential must exist before the workflow changes
  (docs.github.com/actions/reference/security/oidc). *Not taken:* one
  identity with both credentials, which would give either branch the right
  to deploy either environment.
- **Approval, and the guard that makes it safe.** Production's GitHub
  environment has no required reviewer. The fast-forward push of `main` is
  the deliberate act. Discipline alone does not hold that: ruleset 21133437
  refuses force pushes and deletion on `main`, but a squash or rebase pull
  request into `main` is linear and passes it. So the production deploy
  refuses to run unless both of these hold:
  - the commit is an ancestor of `origin/develop`;
  - its image tag exists.

  A commit authored on `main` fails both. *Not taken:* a reviewer click per
  release. It can be added later without other changes.
- **Registry.** Both environments pull from `crtyrestaging`. Production's API
  identity gets AcrPull on it, a cross-resource-group assignment the owner
  applies. *Not taken:* `az acr import` into a production registry, about R90
  a month more. Recorded as a trade: deleting `rg-tyre-staging` would break
  production's image pulls.
- **Who applies what (U117).** In each environment, a platform template
  holds the role assignments, Postgres and Key Vault, and the owner applies
  it by hand. Contributor cannot write role assignments, and the docs give
  no exemption for an unchanged one, so this ADR assumes that a pipeline
  deploy of them fails
  (learn.microsoft.com/azure/role-based-access-control/built-in-roles/privileged).
  An app template holds the container app, with the image as a required
  parameter, and the pipeline applies it on every release. TYRE-79 makes
  that split.
- **Identity provider.** Both environments use the one Entra External ID
  tenant from ADR-0016. tyre-pwa's redirect URIs list both static web app
  origins. The isolation runs in both directions:
  - **A sandbox user signing in to production** carries a
    `platformTenantId` that production has no row for. The token-to-actor
    lookup finds nothing, and the request is refused.
  - **A pilot user who opens the staging URL** is refused too, as long as two
    rules hold:
    - **Tenant ids are never shared across environments.** Production's
      pilot tenant is created under a fresh id (TYRE-374), and staging's
      demonstration fixture keeps its own id, so the pilot user's claim
      names no tenant on staging. Even if an id did match, the actor lookup
      is by Entra `oid` against `app_user.subject` (ADR-0016), and the
      fixture seeds synthetic subjects, so the request is refused with 403.
    - **No invite is ever sent from staging to a real person.** Accepting an
      invite binds a real `oid` to a row, and on staging that row sits
      among the fixture.

  *Not taken:* a second CIAM
  tenant for staging, which would mean duplicate app registrations, claim
  mapping and user flows for one engineer to keep in step. Test users and
  pilot users share one directory, and that is accepted for the pilot.
- **Staging's database is stopped while idle.** The owner stops it after a
  test session. The staging deploy starts it if it is stopped, which
  Contributor permits, and waits until it is ready before it deploys.
- **Production's backups are a gate, not a step.** The pilot tenant is not
  provisioned in production until production carries the backup settings
  the NFR-BAK requirements call for (TYRE-203's Bicep half). That is a
  definition-of-done item on TYRE-397. Staging keeps 7 days, because it
  holds nothing that needs recovering.
- **Names.** Production uses the CAF names from ADR-0005 with `prod` for
  `staging`:
  - `rg-tyre-prod`, `psql-tyre-prod`, `cae-tyre-prod`, `ca-api-prod`
  - `stapp-tyre-prod`, `sttyreprod`, `kv-tyre-prod`, `log-tyre-prod`
  - `id-tyre-api-prod`, `id-tyre-deploy-prod`

  `budget-tyre-prod` is USD 50 a month, with the same alerts as staging's.
- **What ADR-0005 still holds.** Its connection-pool amendment (TYRE-184 F8,
  cited by `api/internal/store/store.go`) and its budget arithmetic apply
  to each environment's own server, unchanged. TYRE-305 corrects the pool
  figure.
- **Placement.** ADR-0005's debt carries forward unchanged: both environments
  run in BAC's sponsorship subscription and tenant, and must move before any
  external tenant is onboarded.

## Consequences

**Good:**

- Real personal information exists in one place only. POPIA exposure from
  test work, fixture loads and deploy experiments drops to nothing.
- Every pipeline change runs on staging first, including TYRE-79's own.
- Staging can be reset, reseeded or torn down without asking anyone.
- Production only runs images staging already ran.

**Bad:**

- About R350 to R400 a month more. Budget the full amount, since every
  `develop` deploy restarts staging's server. It stays under the
  agreement's R3,500 cap.
- Staging is a gate only once something tests it after each deploy. The
  revision check and `/readyz` (TYRE-79) prove the right image is serving.
  A post-deploy smoke test against the staging URL, and a read-only one
  against production, are their own ticket.
- Two of everything to keep in step: identities, secrets, budgets, migration
  runs (TYRE-368's runbook runs once per environment) and Confluence state.
- Stopping staging is a manual habit, and Azure undoes it weekly.
- A deploy to staging must first wait for the server to start.
- A fix reaches production only through `develop` and staging. No hotfix
  path skips them.
- One CIAM directory holds test and real users.
- Production depends on a registry in staging's resource group.

**Revisit when:** the first external tenant signs (move both environments out
of the sponsorship subscription, and give production its own registry and
CIAM tenant); the stopped-server habit fails often enough that staging's cost
saving is fiction; or a second engineer joins, which makes a reviewer on
production deploys worth its click.
