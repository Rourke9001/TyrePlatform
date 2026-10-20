# Design: the API reads only its own secret (TYRE-435)

- **Date:** 2026-10-19
- **Ticket:** TYRE-435, which blocks TYRE-321 (BAC's live onboarding).
- **Decisions it rests on:**
  - ADR-0017 (two environments, one platform template each, applied by the
    owner, U117).
  - Owner ruling U140 (TYRE-397 c13845): ticket the API identity's
    vault-wide grant, fix before onboarding.
  - Owner ruling U141 (TYRE-435 c13848): not a small fix, and it lands
    before production's bring-up.
  - The owner's approval in this spec's conversation, 19 Oct 2026, of the
    recommendation in section 2. It is proposed as ruling U142 and is
    posted on TYRE-435 when the owner approves this spec, before the
    ADR-0017 amendment cites it.
- **Requirements:** NFR-SEC-004 (tenant isolation by RLS) and NFR-SEC-012
  (secrets in a managed store); CLAUDE.md rule 1. TYRE-61's NFR-SEC-014 is
  the assessment trigger, not a requirement this meets.
- **Evidence:** Microsoft Learn, read 19 Oct 2026. Each claim is tagged
  *documented* (the docs say it) or *reported* (other users or third
  parties say it, not checked here).

## 1. Why this exists

`infra/platform.bicep` (`kvSecretsForApi`) grants the API's managed
identity, `id-tyre-api-<env>`, Key Vault Secrets User on the whole of
`kv-tyre-<env>`. The API needs one secret, `database-url`. The same grant
lets it read `psql-admin-password`, and `tyreadmin` has `rolbypassrls` true
(TYRE-305 comment 13834). Anything that can act as the API identity can
therefore read every tenant's rows outside RLS. On 19 Oct 2026 staging's
live listing showed exactly this: AcrPull on `crtyrestaging` and Secrets
User on `kv-tyre-staging`.

What can act as the API identity:

- a compromised API process, or a request forgery that reaches the identity
  endpoint (the ticket's examples);
- anything holding Contributor on the resource group, because Contributor
  can attach a user-assigned identity to a job it creates. Contributor's
  definition is `*` minus authorization writes (*documented*, built-in role
  definition). The deploy identity holds Contributor. Its other paths
  around RLS are TYRE-437's investigation, not this ticket.

After this change, acting as the API identity yields `app_login`'s DSN and
nothing else, and `app_login` is bound by RLS.

## 2. What the owner decided (19 Oct 2026)

1. **The API gets its own vault in each environment.** `kv-tyre-api-<env>`
   holds `database-url` and nothing else. The API identity's only Key Vault
   role is Secrets User on that vault. `kv-tyre-<env>` keeps
   `psql-admin-password` and `pg-app-login-password` and becomes the
   owner's alone: the API identity holds no role on it.
2. **Production's bring-up waits for this merge** (U141), so production is
   built this way from its first apply. Only staging is switched over.
3. **The related deploy-identity gap is an investigation**, TYRE-437,
   separate from this ticket.

Why a second vault rather than a grant on the one secret:

- Microsoft recommends "a vault per application per environment ... with
  roles assigned at the key vault scope", and says assigning roles on
  individual secrets "is not recommended" outside two cases: secrets for
  individual users, and a secret shared between applications. Neither
  applies (*documented*, Key Vault RBAC guide).
- A vault-scope grant needs no secret to exist, so production's bring-up
  keeps a single platform apply. A secret-scope grant would need
  `database-url` written first and a second apply after it.
- A secret added to the owner's vault later can never reach the API.

The names are free: `az keyvault check-name` reported both available on
19 Oct 2026, and the subscription held no soft-deleted vaults.

## 3. Goals, non-goals, anti-goals

**Goals**

- In both environments the API identity holds exactly two role
  assignments: AcrPull on `crtyrestaging`, and Key Vault Secrets User on
  `kv-tyre-api-<env>`.
- Staging proves, as the API identity, that `psql-admin-password` is
  refused and `database-url` is read.
- Production's bring-up, as written in the runbook, builds the same shape
  with no extra apply.

**Non-goals**

- The deploy identity's Contributor scope (TYRE-437).
- Network restrictions on either vault (TYRE-61's accepted trade).
- Rotating staging's admin password. Staging holds no real data (U116), and
  nothing suggests the identity was misused. Production's password is
  generated new at bring-up.
- Any change to the API's code. It reads `DATABASE_URL` from its
  environment and never calls Key Vault.

**Anti-goals** (a failure even if it technically works)

- A staging revision that fails to start because the new grant is missing
  or the old one was deleted first.
- Two live copies of `database-url`. A stale second copy is a second
  authority.
- A runbook step that prints a secret's value to prove it.

## 4. Design

### 4.1 Templates

**`infra/platform.bicep`**

- A new vault, `kv-tyre-api-${env}`, with the same properties as
  `kv-tyre-${env}`: standard SKU, RBAC authorisation, soft delete for 7
  days, no lock. Its comment says why it exists, citing TYRE-435 and rule
  1, in a few lines.
- `kvSecretsForApi` moves to the new vault: scope `kvApi`, name
  `guid(kvApi.id, apiIdentity.id, roleKeyVaultSecretsUser)`. The old
  vault-wide assignment is no longer declared anywhere.
- The deployer gets Key Vault Secrets Officer on the new vault too, so the
  owner can write `database-url` into it. Same shape as
  `kvSecretsOfficerForDeployer`.
- A new output, `kvApiUri`.

Deployments are incremental, which "leaves unchanged resources that exist
in the resource group but aren't specified in the template"
(*documented*, ARM deployment modes). So removing the old assignment from
the template does not delete it from staging. Section 4.2 deletes it by
hand, after the new one is serving.

**`infra/app.bicep`**

- The `existing` vault becomes `kv-tyre-api-${env}`. The secret reference
  is unchanged in form: `${kvApi.properties.vaultUri}secrets/database-url`,
  latest version, resolved by the API identity.
- The comment above `api` that names `kvSecretsForApi` as a prerequisite
  names the grant on the API's vault.

Container Apps needs Key Vault Secrets User for the identity to resolve the
reference, and with no version in the URI it picks up a new version
within 30 minutes (*documented*, Container Apps manage secrets).

**`api/cmd/api/main.go`**: the comment at the `DATABASE_URL` read names
`kv-tyre-api-<env>` instead of `kv-tyre-staging`. No code changes.

### 4.2 Staging's switch-over (the owner)

The order matters: every merge to `develop` applies `app.bicep`, and the
new `app.bicep` names the new vault. So the new vault, its grant and its
secret exist before the merge, and the old grant is removed only after the
merge's deploy is green. Until then the old grant is what keeps any other
deploy to staging working.

0. **Staging's first apply after TYRE-397, first and on its own.** It has
   not run yet: on 19 Oct 2026 `sttyrestaging` had no blob versioning, and
   the last platform deployment was 11 Oct. Run it from `develop` exactly
   as the runbook's "Staging's first apply after TYRE-397" says, so this
   ticket's what-if is read against a staging that already matches
   `develop`.
1. **Apply from this branch, before the merge.** This runs once stage 5's
   review shows no open Critical or Important finding, so a review fix to
   `platform.bicep` cannot leave staging on a template `develop` never
   gets. Run the platform what-if twice, from `develop` and from this
   branch. Against the first run, the second adds three Creates
   (`kv-tyre-api-staging`, the API identity's Secrets User on it, and the
   deployer's Secrets Officer on it) and no Delete or Modify. The old
   vault-wide assignment may show as Ignore, which is expected: the
   template no longer declares it. Anything else stops the apply. Then
   apply from this branch. Migrations are untouched, because this branch
   adds none.
2. **Copy `database-url` into the new vault**, value for value, through a
   shell variable that the block unsets and never echoes. A Forbidden on
   the write means the Secrets Officer grant has not taken effect yet:
   wait a few minutes and re-run. Then run the secrets proof (section 4.5)
   with this step's interim expectations: `database-url` is in both vaults
   until step 4, and the role listing shows three rows, the old vault-wide
   grant among them. The DSN checks run against the new vault's copy.
3. **Merge.** The deploy applies `app.bicep` against the new vault. A green
   gate means a revision started with `DATABASE_URL` resolved from
   `kv-tyre-api-staging`: that is the positive proof.
4. **After the deploy is green:**
   - Delete the API identity's Secrets User assignment on
     `kv-tyre-staging`. Use the runbook's list-first shape (bring-up step
     4's removal of the temporary grant): list, and delete only if exactly
     one row shows.
   - Delete `database-url` from `kv-tyre-staging`. Soft delete keeps it
     for 7 days, recoverable only by a Secrets Officer, which the API
     identity is not. No purge is needed.
   - Run the proof (section 4.4) and the role listing (section 4.5).
   - Post the results on TYRE-435.

### 4.3 Production bring-up

The runbook's Production bring-up changes in six places:

- **Its introduction** says it runs after TYRE-435 merges (U141), from a
  checkout at or after that merge, not after TYRE-397's.
- **Step 7** promotes a commit at or after TYRE-435's merge. An earlier
  commit's `app.bicep` would point production's API at `kv-tyre-prod`.
- **Step 3's what-if** lists the new vault and its two role assignments
  among the Creates, all inside `rg-tyre-prod`.
- **Step 5** writes `database-url` to `kv-tyre-api-prod`. The
  `pg-app-login-password` write stays on `kv-tyre-prod`.
- **Step 5's proof** is the secrets proof in section 4.5, under `ENV=prod`.
- **Step 8** adds the role listing in section 4.5.

No step is added and none moves. The proof job in section 4.4 runs on
staging only: production's vaults come from the same template, and its
role listing proves its live state.

### 4.4 The proof, as the API identity (staging, once)

The API image is distroless with no shell, so the proof cannot run inside
the API. Instead the owner runs a one-off Container Apps job on
`cae-tyre-staging`:

- triggered manually, with one replica, no retries and a short timeout;
- `id-tyre-api-staging` attached as its user-assigned identity;
- the Azure CLI image from `mcr.microsoft.com`, pinned by digest as the
  runbook pins its other images;
- a script that signs in with the managed identity and then:
  - reads `psql-admin-password` from `kv-tyre-staging`, and prints
    `psql-admin-password: refused` when the error says Forbidden, or
    `psql-admin-password: READ` otherwise;
  - reads `database-url` from `kv-tyre-api-staging` with
    `--query "length(value)"`, and prints the length only.

It passes when the log shows `refused` and a non-zero length. The job is
deleted afterwards. No line of the script prints a value.

### 4.5 The checks the runbook keeps

**The secrets proof.** Staging bring-up step 2's block, which Each release
step 4 and Production bring-up step 5 already reuse, changes to:

- list `kv-tyre-<env>`: expect `psql-admin-password` and
  `pg-app-login-password`, and no `database-url`;
- list `kv-tyre-api-<env>`: expect `database-url` and nothing else;
- read the DSN from `kv-tyre-api-<env>`, then run the existing role,
  `pool_max_conns` and host checks, unchanged.

Any other name in the API's vault is a finding: whatever is in it, the API
can read.

**The role listing.** After every platform apply (bring-up step 4's block)
and at Production bring-up step 8:

```bash
az role assignment list --assignee <api identity's principal id> --all \
  --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

Expect exactly two rows: AcrPull on `crtyrestaging`, and Key Vault Secrets
User on `kv-tyre-api-<env>`. The block checks that the principal id is
non-empty first, as the runbook's other role commands do.

**Why there is no automated test.** The defect is a live Azure role
assignment. CI's test jobs cannot see Azure state, and the old assignment
survives in Azure after the template stops declaring it, so a check over
the template would pass while the live grant stayed wide. The deploy job
can see it, since it signs in as Contributor on its environment's group,
but a check there would fail this change's own merge deploy while the old
grant stands (switch-over steps 1 to 4), so it cannot land with this
change. The owner scheduled that check before the pilot as TYRE-438,
which lands after switch-over step 4 (U130, 20 Oct 2026). The gates are the what-if
expectation in section 4.2, the proof in section 4.4 and the listing
above, which the runbook repeats on every platform apply.

## 5. Documentation

- **`docs/runbooks/environment-release.md`**
  - Before anything sets `KVAPI=kv-tyre-api-$ENV` next to `KV`, and so do
    the two inline `ENV=...; KV=...` settings in Promote to production.
  - Staging bring-up gains a short "Switching staging to the API's own
    vault (TYRE-435)" record with section 4.2's steps and blocks.
  - Bring-up step 2, step 4, and Production bring-up steps 3, 5 and 8
    change as sections 4.3 and 4.5 say.
- **`docs/runbooks/provision-a-tenant-catalogue.md`**: reads `database-url`
  from `$KVAPI`, and its "set `$RG`, `$PG` and `$KV`" line names `$KVAPI`.
  `provision-a-tenant.md` reads only `psql-admin-password` and is
  unchanged.
- **ADR-0017** gains a dated amendment: each environment has two vaults,
  the API's (`kv-tyre-api-<env>`, `database-url` only) and the owner's
  (`kv-tyre-<env>`), with the reason in a few lines and a pointer to this
  spec. Its Names list is not edited, because the amendment records the
  addition. ADR-0005 stays as it is, as history.
- TYRE-397's spec is a record of that design and is not edited. Where it
  says production's secrets go to `kv-tyre-prod`, this spec and the
  runbook supersede it for `database-url`.

## 6. Costs

Key Vault is priced per operation, and its pricing page lists no
per-vault fee (*documented*, Azure Key Vault pricing). The Standard rate
is reported at USD 0.03 per 10,000 secret operations (*reported*: the
official page did not show the figure when read). The API reads its secret
when a revision starts and checks for a new version within 30 minutes, so
one vault costs well under R1 a month: under R2 a month for both
environments. The proof job runs one small replica for under a minute.
The budgets do not change.

## 7. Definition of done

- The template, runbook, ADR and comment changes are merged.
- Staging is switched over (section 4.2), and on TYRE-435:
  - the role listing shows exactly the two rows;
  - the proof job logged `refused` and a non-zero length;
  - the secrets proof shows `database-url` only in the API's vault;
  - the merge's deploy was green.
- Production's bring-up in the runbook builds the same shape. Its live
  check is TYRE-397's step 8, which runs after this merge.

The PR carries no `Closes` line. Close-out leaves TYRE-435 open until
section 4.2 step 4's results are posted on the ticket.

## 8. Left to the builder

- The exact `az containerapp job create` flags, the digest of the CLI
  image, and whether that CLI signs in with `--client-id` or the older
  `--username`. Check the image's CLI version.
- How the proof job's log is read: `az containerapp job logs show`, or a
  Log Analytics query on `log-tyre-staging`.
- Whether the switch-over record and the proof live in
  `environment-release.md` or as a short section it links to, provided the
  blocks are runnable in Git Bash as the rest of that runbook is.
- The wording of the comments, within `docs/comments.md`.
