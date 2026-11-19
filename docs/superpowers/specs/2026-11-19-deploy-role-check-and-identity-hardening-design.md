# Design: the deploy checks the API identity's roles, and the deploy identity is narrowed (TYRE-438)

- **Date:** 2026-11-19
- **Ticket:** TYRE-438, which carries TYRE-437's fix (pilot audit A5 and
  B43, TYRE-438 comment 13968). It merges before BAC onboards.
- **Decisions it rests on:**
  - ADR-0017 (two environments; the owner applies the platform template,
    the pipeline applies the app template, U117) and its 2026-10-19
    amendment (each environment has two vaults, TYRE-435).
  - Owner ruling U170 (TYRE-438 comment 14123): this is not a small fix.
  - The recorded default for the rule (TYRE-438 comment 13968, U147).
  - The owner's answer in this spec's run, 19 Nov 2026, proposed as ruling
    U241: section 2. It is posted on TYRE-438 when the owner approves this
    spec, before the ADR-0017 amendment cites it.
- **Requirements:** NFR-SEC-004 and NFR-SEC-012, as
  `infra/platform.bicep` cites them for the two vaults; CLAUDE.md rule 1.
  NFR-SEC-014 is the trigger the template's accepted trades name. This
  change closes one of those trades early and meets no new requirement.
  No SRS row changes.
- **Evidence:** Microsoft Learn, GitHub Docs and the Azure CLI source,
  read 19 Nov 2026. Each claim is tagged *documented* (the source says
  it) or *not documented* (the source is silent, and section 7 says how
  the first staging deploy settles it).

## 1. Why this exists

Two gaps remain after TYRE-435.

**The API identity's roles are checked by hand.** `id-tyre-api-<env>`
must hold no role that reaches `kv-tyre-<env>`, because that vault holds
`psql-admin-password` and `tyreadmin` bypasses RLS (rule 1). Today the
only gate is the owner's listing after a platform apply
(`docs/runbooks/environment-release.md`, bring-up step 4). A grant added
by hand between applies is seen by nobody. The deploy job signs in to
Azure on every release and can read role assignments, so it can hold
this check.

**The deploy identity can get around RLS.** `id-tyre-deploy-<env>` holds
Contributor on `rg-tyre-<env>`. Contributor's definition is `*` minus
authorization writes, so it can set a new administrator password on
`psql-tyre-<env>` and list the keys of `sttyre<env>` (*documented*:
<https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/privileged#contributor>,
<https://learn.microsoft.com/en-us/rest/api/postgresql/servers/update>,
<https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent>).
`.github/workflows/deploy.yml` grants `id-token: write` to the whole
workflow, and its web job runs `npm ci` and the build in a job that can
ask for that identity's token. A compromised npm dependency could
therefore act as the deploy identity. TYRE-437 confirmed the path, and
the pilot audit ruled it fixed before BAC onboards, not accepted (B43).

## 2. What the owner decided (19 Nov 2026, proposed U241)

1. **The deploy identity is narrowed in both environments.** A custom
   role declared in `infra/platform.bicep` replaces Contributor. Staging
   gets it too, so production never runs a role staging has not deployed
   with.
2. **Production's hand steps run at the next promotion.** The owner
   applies the platform template and removes Contributor just before
   promoting, so the promotion itself proves the narrow role.

Not taken: narrowing production only, which would first exercise the
role on a production deploy; and re-accepting Contributor for the pilot,
which leaves the password path open and contradicts B43.

## 3. Goals, non-goals, anti-goals

**Goals**

1. Every deploy, staging and production, a normal release or a rollback
   dispatch, fails before it changes anything when the API identity
   holds a role that reaches `kv-tyre-<env>`, or any role outside its
   expected set.
2. The step that runs npm cannot obtain an Azure token.
3. The deploy identity cannot write the Postgres server or list storage
   keys.
4. `sttyre<env>` refuses shared-key requests.

**Non-goals**

- A VNet, private endpoints or any other trade `infra/platform.bicep`
  records under TYRE-61. Those notes stay as they are.
- The photo upload path. TYRE-152 builds it. This change only settles
  that it must use a user delegation SAS (section 4.4).
- Narrowing what the API identity holds. TYRE-435 did that.
- A check of the deploy identity's own roles in the pipeline. The
  runbook's hand listing covers it (section 5).

**Anti-goals**

- The check never reads, prints or needs a secret value, and the deploy
  identity gains no Key Vault data role.
- The pipeline never applies `infra/platform.bicep` and never writes a
  role assignment (U117).
- No step grants the API identity a role to prove the check fails. The
  negative control is a stub (section 4.1).

## 4. The design

### 4.1 The role check

A new script, `scripts/deploy-roles.sh`, with its cases in
`scripts/deploy-roles.test.sh`, on the pattern of
`scripts/deploy-gate.sh` and `scripts/deploy-gate.test.sh`.

**Where it runs.** In `deploy.yml`'s `api` job, as the step straight
after the Azure login and before "Database running", for both targets
and for a rollback dispatch. The `web` job does not repeat it: a web-only
re-run ships static files and changes nothing the API identity can
reach.

**What it reads.** The vault's authorization mode, and four kinds of
listing of role assignments, all through
`GET {scope}/providers/Microsoft.Authorization/roleAssignments`
(*documented*:
<https://learn.microsoft.com/en-us/rest/api/authorization/role-assignments/list-for-scope?view=rest-authorization-2022-04-01>,
<https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-list-rest>):

| Listing | Scope | Filter | What it returns |
| --- | --- | --- | --- |
| Reach | `kv-tyre-<env>` | `atScope() and assignedTo('<API identity's principal id>')` | Every assignment at the vault or above it that the identity holds directly or through a group. ARM expands groups, transitively, on its side. |
| Whole | `rg-tyre-<env>` | `principalId eq '<API identity's principal id>'` | Every assignment the identity holds directly at, above or below the resource group that the caller can read. It sees a direct role on a single secret, which `atScope()` leaves out. |
| All | `rg-tyre-<env>` | none | Every assignment at, above or below the group, whoever holds it. The script takes from it the distinct scopes below the group. |
| Reach, per scope | each scope All shows below the group, other than the vault | the Reach filter | What the identity holds at that scope directly or through a group. This is what sees a group's role on a single secret of the owner's vault, or on another resource in the group. |
| Control | `kv-tyre-<env>` | `atScope()` | Every assignment at the vault or above it, whoever holds it. |

A group-held role below the vault is the one case neither Reach at the
vault nor Whole can see: `atScope()` stops at the vault, and
`principalId eq` does not expand groups. The per-scope Reach closes it
with the same documented filter. The number of calls is the number of
distinct assignment scopes in the group, a handful.

The principal ids come from `az identity show` on `id-tyre-api-<env>`
and `id-tyre-deploy-<env>`, and the subscription id from the signed-in
account. The script never uses `--assignee`, which queries Microsoft
Graph; the deploy identity has no Graph permission (*documented*: the
CLI's own help for `--assignee-object-id`, and
<https://github.com/Azure/azure-cli/blob/10f2297688f07a26d1098e5359953b64e5b3c3c8/src/azure-cli/azure/cli/command_modules/role/custom.py#L351-L414>).
Whether it calls `az rest` or `az role assignment list` is the
builder's, provided the filters above are what reach ARM. The CLI
source shows `az role assignment list --scope <scope> --assignee-object-id
<id> --include-inherited --include-groups` sends the Reach filter, and
that no CLI flag sends the Whole filter at a resource-group scope.

The vault's mode is one management-plane read, `az keyvault show` on
`kv-tyre-<env>`, of `properties.enableRbacAuthorization`. Under access
policies a vault ignores role assignments, so a vault switched by hand
could admit the identity through a policy while every listing stayed
clean.

**The rule.** The union of the Reach, per-scope Reach and Whole rows is
everything the identity holds that the caller can see. The deploy fails
when any of these holds:

1. A row of the union has a scope that is the owner's vault, a scope
   above it (the resource group, the subscription, a management group)
   or a scope below it (a secret, key or certificate). Any role there,
   whatever it is, is more than the identity should hold.
2. Any other row of the union is outside the expected set. The expected
   set is two rows: AcrPull
   (`7f951dda-4ed3-4680-a7ca-43fe172d538d`) on the registry
   `crtyrestaging`, and Key Vault Secrets User
   (`4633458b-17de-408a-b874-0445c86b69e6`) on `kv-tyre-api-<env>`.
   Rows are compared by role definition GUID and exact scope, never by
   display name.
3. `kv-tyre-<env>` does not report `enableRbacAuthorization` true.
4. A positive control is missing (below).
5. Any call fails, or a principal id or the subscription id comes back
   empty. The check fails closed.

A missing expected row does not fail the check. It is a subset rule, not
equality, for two reasons. Production's deploy identity cannot read
`rg-tyre-staging`, so it may not see the AcrPull row. And a later ticket
that gives the API identity a new role (TYRE-152's storage role is the
known one) adds its row to the expected set in its own PR, merges, and
only then is the platform template applied. With equality, that ticket's
own merge deploy would fail. A missing Secrets User row is caught
anyway: the revision cannot resolve `database-url`, and the gate fails.
The script prints a notice for a missing expected row.

**The positive controls.** *Not documented*: whether a caller that can
read role assignments only at its resource group is shown the rows a
vault inherits from the subscription. If ARM trimmed them, the Reach
listing would pass while an inherited grant stood. Also *not
documented* in one sentence: that a listing with no filter returns the
rows below its scope. The reference says so only for `principalId eq`,
and says `atScope()` leaves them out. So the script requires three
controls:

- the Control listing holds at least one row whose scope is the
  subscription itself. A subscription has an Owner, but an Owner held
  only through a management group, or only as a PIM-eligible
  assignment, leaves no row there, and the control then fails closed;
- the Control listing holds the deploy identity's own row at
  `rg-tyre-<env>`;
- the All listing holds at least one row whose scope is a resource in
  the group. The template's Secrets Officer grant on `kv-tyre-<env>` is
  one in both environments.

If one is missing, the script says which, says it therefore cannot
prove the vault is clean, and exits non-zero. Management-group rows
have no control of their own; the subscription control is taken as
showing that ARM does not trim parent scopes.

**What the check does not prove**, which the runbook and the ADR
amendment must not overstate: it reads Azure role assignments and the
vault's mode. It does not see a role granted in a scope the deploy
identity cannot read, and it runs only when a deploy runs. The hand
listing after a platform apply stays (section 5).

**What it prints.** For each row of the Reach and Whole listings: the
role (GUID, with the name for the GUIDs the script knows), the scope and
the principal type. On failure, an `::error::` line that names the rule
broken and points at the runbook section in section 5. It prints no
secret, and it makes no Key Vault data-plane call.

**The expected set lives in one place**, in the script or beside it,
built from the subscription id, the target and the names above. The
builder chooses the form.

**The negative control** (the ticket's definition of done) is
`scripts/deploy-roles.test.sh`: a stub `az` on `PATH` that answers each
listing from a canned table and refuses any call the script should
never make, as `scripts/deploy-gate.test.sh` does. Its cases, at least:

- staging clean (both expected rows) and production clean (the Secrets
  User row only): pass;
- a role on the vault held directly; one inherited from the resource
  group; one inherited from the subscription; one held through a group:
  each fails on rule 1;
- a role on a single secret of the owner's vault, held directly, and
  the same held through a group: each fails on rule 1;
- an unexpected role elsewhere in the group, such as a storage role,
  held directly and held through a group: each fails on rule 2;
- the right role GUID on the wrong scope, and the right scope with the
  wrong GUID: each fails on rule 2;
- the vault in access-policy mode, and the mode read back empty: each
  fails on rule 3;
- each of the three positive controls missing: fails on rule 4;
- a failing `az` on each kind of call, an empty principal id, an empty
  subscription id: each fails on rule 5;
- an expected row missing: passes, with the notice;
- the stub records a call that uses `--assignee`, touches a secret or
  writes anything, and the test fails on it.

The test gets a Makefile target, `deploy-roles-test`, joins `make test`
beside `deploy-gate-test`, `deploy-guard-test` and `deploy-smoke-test`,
and runs in `ci.yml` where those three run.

### 4.2 The web build leaves the token's reach

`deploy.yml` changes shape:

- The workflow-level `permissions` become `contents: read` alone. The
  `api` job and the `web` job each grant `id-token: write` and
  `contents: read`. A called workflow can only narrow what its caller
  grants, and a job without `id-token: write` cannot request the token
  (*documented*:
  <https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations>,
  <https://docs.github.com/en/actions/reference/security/oidc>).
  `ci.yml`'s two caller jobs keep granting `id-token: write`.
- A new job, `web-build`, has no `environment:`, no `id-token`, and no
  Azure login. It checks out the image's commit, runs
  `npm ci --ignore-scripts`, the build and the three dist checks the
  `web` job runs today, and uploads `web/dist` as an artifact. It needs
  no other job, so it runs beside `api`. It carries a `timeout-minutes`,
  as `scripts/check-workflow-timeouts.mjs` demands.
- The `web` job needs `api` and `web-build`. It keeps its guard, its
  checkout of the image's commit, the Azure login, the runtime
  configuration, the deployment token, the upload, the smoke and
  staging's record. In place of the build it downloads the artifact
  into `web/dist`. It runs no `npm` command.
- The artifact actions are pinned by commit SHA:
  `actions/upload-artifact` v7.0.2, the pin `ci.yml` already carries,
  and `actions/download-artifact` v8.0.2
  (`9000827ccba6bdab643e8b6fd33ac0654aef8333`). The upload sets
  `overwrite: true`, because a second upload of the same name in one
  run fails without it (*documented*: the action's README), and a
  retention of 35 days. `web` downloads the artifact after the
  `production` environment's approval, and a run can wait up to 35
  days, approval waits included (*documented*:
  <https://docs.github.com/en/actions/reference/limits>), so a shorter
  retention fails a deploy the owner approves late.
- `ci.yml`'s Frontend job also moves to `npm ci --ignore-scripts`, so
  the pull request's own CI proves the build under that flag before the
  merge deploy relies on it. Only `esbuild` and `fsevents` carry an
  install script in `web/package-lock.json`. If the build cannot pass
  under the flag, the builder stops and asks.

**A check that keeps it so.** `make lint` gains a check, in the infra
lint beside the workflow timeout check, that fails when a job in
`deploy.yml` both grants `id-token: write` and runs `npm`, or when
`id-token: write` appears at workflow level. It also fails when an
artifact upload in a workflow with an environment and a download sets
`retention-days` under 35, or none. It has a self-test, as the
timeout check does. Whether it extends
`scripts/check-workflow-timeouts.mjs` or is a new script is the
builder's.

The API image build stays in the `api` job. `docker build` runs in a
build container that receives neither the job's environment nor the
runner's Azure login, so it is not the same exposure.

### 4.3 The deploy identity's role

`infra/platform.bicep` declares, per environment:

- a custom role definition, named for the environment (the display name
  must be unique in the Entra tenant), with `assignableScopes` its own
  resource group. A custom role is free, and a resource group is a valid
  assignable scope (*documented*:
  <https://learn.microsoft.com/en-us/azure/role-based-access-control/custom-roles>,
  <https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions#assignablescopes>);
- its assignment to `id-tyre-deploy-<env>` at the resource group. The
  identity stays created by hand and is referenced as `existing`; both
  bring-ups create it before the first platform apply.

**Its permissions** are `*/read` plus an explicit list of writes and
actions, and nothing else. `*/read` is the built-in Reader's grant: it
reads role assignments and resource properties, and it does not cover
`listKeys` or `listSecrets`, which are actions. The list, derived from
every `az` call in `deploy.yml`, `scripts/deploy-gate.sh` and
`scripts/deploy-guard.sh` and from every resource `infra/app.bicep`
writes or references (*documented*:
<https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/compute#microsoftapp>
and the sibling permission pages;
<https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-cli#required-permissions>):

| Needed for | Action |
| --- | --- |
| Deploying, validating and reading a template deployment | `Microsoft.Resources/deployments/*` |
| The container app | `Microsoft.App/containerApps/write` |
| The daily job | `Microsoft.App/jobs/write` |
| Placing both in the environment | `Microsoft.App/managedEnvironments/join/action` |
| Attaching the API identity to both | `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action` |
| Starting staging's server | `Microsoft.DBforPostgreSQL/flexibleServers/start/action` |
| The static web app's deployment token | `Microsoft.Web/staticSites/listSecrets/action` |

`Microsoft.Resources/deployments/*` is the one wildcard beyond `*/read`,
because Microsoft documents the whole resource type as the deploy
requirement. The role must hold no `Microsoft.DBforPostgreSQL/.../write`,
no `Microsoft.Storage/.../listKeys/action`, no `Microsoft.Authorization`
write and no wildcard that covers one. The builder checks the list
against the code again and adds an action only when a call in the
pipeline needs it, with the call named in the template's comment.

Microsoft's guidance for Container Apps is this shape: a custom role
that lists only the operations needed
(<https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets#create-a-custom-role-with-narrower-permissions>).
Not taken: the built-in Container Apps Contributor, which lacks the
deployment and identity actions and carries an `*/action` wildcard.

**What the narrow role still allows**, and why that is accepted: a
deploy can run any image as the API identity, so the deploy identity
can reach `database-url` and `job-database-url`. Both are logins RLS
binds or the daily job's own (ADR-0025). That is what deploying means,
and it is not the admin path this ticket closes.

**The registry grants are untouched.** Staging's identity keeps AcrPush
and production's keeps AcrPull on `crtyrestaging`, both made by hand.
The registry sits in `rg-tyre-staging`, so staging's custom role still
reads it through `*/read`, as Contributor did.

**Removing Contributor is a hand step**, since Bicep did not make that
assignment (section 5).

**Comments that change.** The accepted-trade note at the top of
`infra/platform.bicep` is rewritten: the deploy identity's role is now
declared in the template, and it cites TYRE-438. The header of
`deploy.yml`, the header of `infra/app.bicep` and its `acrLoginServer`
comment say "Contributor" and are corrected. The TYRE-61 notes on
storage, the vaults and the firewall stay.

### 4.4 Shared-key access

`infra/platform.bicep` sets `allowSharedKeyAccess: false` on
`sttyre<env>`. It refuses requests signed with an account key, an
account SAS or a service SAS; Microsoft Entra ID and a user delegation
SAS still work, and the property exists at the API version the template
uses (*documented*:
<https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent>).
Nothing in `api/` or `infra/` uses the account's keys today. The
comment on the `photos` container, which says the API issues SAS URLs,
is corrected to say a user delegation SAS under a role on the API
identity, which TYRE-152 adds. Production's `CanNotDelete` lock allows
the property change.

## 5. Documentation

- **`docs/runbooks/environment-release.md`**
  - Bring-up step 4's role listing names the deploy's step as the
    standing check on every release, keeps the hand listing after every
    platform apply, and says what to do when the deploy fails on it:
    read the printed rows, remove the grant, re-run the failed jobs.
  - A new record, "Narrowing the deploy identity (TYRE-438)", in the
    style of the TYRE-435 switch-over: the what-if expectation (one role
    definition and one assignment created, one storage property
    changed), the apply, the list-then-delete of Contributor on
    `id-tyre-deploy-<env>` with every value checked non-empty first, the
    wait for the change to take effect (*documented*: up to ten minutes,
    <https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting>),
    and the proof: a deploy that goes green under the narrow role.
    Staging's proof is a rollback dispatch of the commit staging already
    runs. The record also gives the one command that grants Contributor
    back if a deploy fails on a missing permission, and says to raise
    the missing action as a finding on TYRE-438.
  - Production bring-up step 2 no longer grants Contributor by hand; the
    first platform apply grants the custom role.
  - Promote to production gains the pre-step for the first promotion
    after this merge: the platform apply and the Contributor removal
    come before the fast-forward (section 2, decision 2).
  - After a platform apply, the hand listing of the deploy identity's
    own roles: the custom role on its group, and its registry role.
- **ADR-0017** gains a dated amendment: each deploy identity holds a
  custom role in place of Contributor, with the reason in a few lines,
  the ruling, and a pointer to this spec. "Who applies what" still
  holds, since the role has no authorization write.
- **`docs/implementation-order.md`** row 3 is close-out's to update.

## 6. Order, and the steps after the merge

Nothing here needs a live step before the merge. The branch's CI proves
the script's cases, the lint checks and the build under
`--ignore-scripts`.

After the merge, the owner's steps, in order:

1. **The merge's own staging deploy** runs the role check and the split
   web build for the first time, still under Contributor. Green is the
   ticket's third definition-of-done line.
2. **Staging:** the platform apply, the Contributor removal, the proof
   deploy (runbook record, section 5).
3. **Production, at the next promotion:** the same three, with the
   promotion as the proof.

The storage property rides on the same platform applies.

## 7. What the first staging deploy settles

Three things cannot be proven before the merge, because only a run in
the `staging` environment on `develop` can sign in as the deploy
identity:

1. **The positive controls.** If ARM does not show a resource-group
   reader the subscription's rows at the vault, the check fails closed
   on the merge deploy. Staging is the only environment affected. The
   fix is a follow-up on TYRE-438's findings, not a weaker check.
2. **A single re-run job and the artifact.** *Not documented*: whether
   "Re-run failed jobs" on the `web` job alone can download the artifact
   an earlier attempt uploaded. If it cannot, the remedy is "Re-run all
   jobs", which the guard admits while the commit is its branch's head.
   The runbook's Roll back section says so.
3. **The role's action list.** A missing action shows as an
   authorization failure on staging's proof deploy, with Contributor one
   command away.

## 8. Testing

- `scripts/deploy-roles.test.sh`, section 4.1's cases.
- The new workflow check's self-test and its run over `deploy.yml`.
- `make lint`: actionlint, the timeout check, Bicep lint on both
  templates and every param file.
- `make check` green before the PR.

No SQL changes, no migration, no API or web source change.

## 9. The ticket's definition of done

TYRE-438's four lines, and TYRE-437's three folded items, with where
each is met:

| Line | Met by |
| --- | --- |
| The step is on `develop`, and the PR's stage 5 report shows no open Critical or Important finding | The merge and the review loop |
| A negative control shows the step fails when a role is present, without granting the API identity anything | `scripts/deploy-roles.test.sh` (4.1) |
| A green staging deploy shows the step passing | The merge's own staging deploy, read by the owner (6, step 1) |
| The runbook's role listing names the step as the standing check and keeps the manual listing for platform applies | Section 5 |
| TYRE-437 (1): the web build in its own job without `id-token`, `npm ci --ignore-scripts` | 4.2 |
| TYRE-437 (2): `allowSharedKeyAccess: false` on `sttyre<env>` | 4.4, live after each platform apply (6) |
| TYRE-437 (3): the deploy identity narrowed, and the trade note cites TYRE-438 | 4.3, live after the Contributor removal (6) |

## 10. Left to the builder

- `az rest` or `az role assignment list`, and how the script parses
  rows, provided section 4.1's filters reach ARM and the script runs under
  Git Bash locally as the other deploy tests do.
- The expected set's form and the names of the known GUIDs.
- The artifact's name, and whether `web/dist` holds hidden files that
  need `include-hidden-files`.
- Whether the `web` job keeps `actions/setup-node` now that it runs only
  `node scripts/write-web-config.mjs`.
- The new lint check's home.
- The runbook's wording and block layout, on the patterns already
  there.

## 11. Lead's calls

Engineering questions the lead settled, each with its source in the
section named. The builder check (19 Nov 2026) raised 12 and 13, and
asked for section 9.

1. The listings and their filters (4.1).
2. A subset rule, with a notice for a missing expected row (4.1).
3. Positive controls that fail closed, in place of trusting an
   undocumented ARM behaviour (4.1, 7).
4. The check runs once, in the `api` job, on every deploy including a
   rollback (4.1).
5. The negative control is a stubbed test, as the ticket's recorded
   default says (4.1; `scripts/deploy-gate.test.sh`).
6. Job-level `id-token`, an artifact between jobs, `overwrite: true`
   (4.2).
7. `--ignore-scripts` in the deploy's build and in CI's Frontend job
   (4.2).
8. A lint check that keeps npm out of a token job (4.2).
9. `*/read` plus an explicit action list for the custom role (4.3).
10. One custom role per environment, declared in the platform template,
    Contributor removed by hand (4.3).
11. A dated amendment to ADR-0017, not a new ADR, as TYRE-435's change
    was (5).
12. A group's role below the vault is caught by running the Reach
    filter at each scope the group's listing shows, with a third
    positive control (4.1).
13. The check also requires the owner's vault to be in RBAC mode, one
    management-plane read (4.1).
