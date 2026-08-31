# TYRE-95 — B4.5 post-merge defects

Fixes what a whole-branch review of the merged B4.5 range
(`develop efdf251..172e59b`, PR #37) found shipped. Jira: TYRE-95.
Branch: `TYRE-95-b45-post-merge-defects`, cut from `develop` at `172e59b`.

**Excluded deliberately.** The four plan deviations PR #37 already records
under "Plan defects found during execution" are history, not work. The
transient UTC date flash on `/my` is a decision that PR took with a stated
rationale ("Do not 'fix' it without measuring") and stands; Task 4 addresses
only the case that rationale does not cover — `/api/me` failing outright.

## Global Constraints

Binding on every task. From CLAUDE.md; violating one is a bug even if tests
pass.

1. **Tenant isolation lives in the database.** RLS, never application code
   alone. The app must not connect as a superuser; every view needs
   `security_invoker = true`.
2. **Readings and fitment events are immutable.** `app_user` is not one of
   them — `UPDATE` is granted there (000002, 000018) and a person is not an
   event.
3. **Every threshold, band and rate is tenant configuration.** No hard-coded
   constants.
4. **Timestamps stored UTC**, displayed in the tenant's timezone, and the only
   path a stored instant takes to a screen is `web/src/time/tenantTime.ts`.
5. **Do not weaken a test to make it pass.** If a test is wrong, say so and
   explain why in the report before changing it. Coverage may move; it may not
   shrink.
6. **Comment why, never what.** Never narrate a change or compare to the old
   code — git holds the history. One rationale lives in one place; other files
   cite it. Cite the requirement ID (`FR-AUT-022`, `CR-011`, `DR-003`) where a
   rule has one. `db/migrations/000001_init.up.sql` is the reference for the
   house comment style.
7. **Go:** `pgx` directly, no ORM. Errors are values, wrapped with
   `fmt.Errorf("...: %w", err)`. Never `panic` in request handling.
   `context.Context` is the first parameter.
8. **TypeScript:** `strict: true`, no `any`. Prettier owns layout — do not
   hand-format.
9. **Migrations** are `db/migrations/NNNNNN_name.{up,down}.sql`, applied by
   golang-migrate. Never edit an applied migration; the next number is
   **000027**. Every `.up.sql` gets a matching `.down.sql`.
10. **Verification is `make check`.** `make db-test` runs as a non-superuser
    and is the one that matters. Do not let a gate pass silently.

## Commands

```
make db-up      make db-reset      make db-test
make test       make fmt           make lint       make check
```

Go runs through docker for 1.24 parity; there is no host `psql`.

---

## Task 1: One email comparison rule

**The defect.** A rehire whose email differs only in case is not recognised as
the same person. `validate()` (`api/internal/httpapi/admin.go:306`) is
`u.email = strings.TrimSpace(b.Email)` with no case folding; the
classification lookup is `WHERE email = $1`; `000001`'s constraint is a plain
`UNIQUE (tenant_id, email)`. So `Thandi@BAC.co.za` typed against a stored
`thandi@bac.co.za` misses the lookup, falls through to the INSERT, is accepted
by the index, and creates a second row for one human — splitting the
inspection history that FR-VEH-008 assumes is one person's.

**Why the schema and the handler must change together.** `000026`'s comment
states the principle this task honours: *"Case folding deliberately matches the
existing index rather than improving on it — one email comparison rule in the
schema, not two."* Changing only the lookup lets a case-variant INSERT pass the
index and still duplicate. Changing only the index turns a rehire into a bare
`email_taken` with no reactivate offer. Both halves, one migration, one rule.

**Files**

- `db/migrations/000027_case_folded_email_uniqueness.up.sql` (new)
- `db/migrations/000027_case_folded_email_uniqueness.down.sql` (new)
- `db/tests/004_tests.sql` (one new section)
- `api/internal/httpapi/admin.go`
- `api/internal/httpapi/admin_test.go`

**What to build**

1. Migration `000027`. Replace both email uniqueness rules with case-folded
   equivalents, so the schema holds one rule:
   - drop the `UNIQUE (tenant_id, email)` table constraint from `000001` and
     create `CREATE UNIQUE INDEX app_user_tenant_email_key ON app.app_user
     (tenant_id, lower(email))`;
   - replace `000026`'s `app_user_platform_admin_email_key` with the same
     shape over `lower(email) WHERE tenant_id IS NULL`.

   Find the real constraint name before dropping it — do not assume Postgres's
   generated name; look it up in `000001` and confirm against
   `information_schema`. The `.down.sql` restores both as they were.

   Guard the data. Before creating either index, a `DO` block must
   `RAISE EXCEPTION` naming any group of rows that collide only once folded,
   rather than letting the index build fail with a bare duplicate-key error.
   Every seeded email is already lowercase, so this should not fire — it exists
   so a future dataset fails loudly and legibly.

2. Handler. Make the classification lookup and the reactivate `UPDATE` compare
   on `lower(email)` against `lower($1)`. Store the address as the admin typed
   it (trimmed) — case is preserved for display; only comparison folds. Say
   that in one comment, citing `000026`'s one-rule principle rather than
   restating it.

3. A db test section asserting the folded rule: inserting `A@B.com` where
   `a@b.com` exists in the same tenant raises `unique_violation`, and the same
   address in a *different* tenant does not. Follow the existing section style
   in `db/tests/004_tests.sql`.

4. A Go test proving the whole path: plant an inactive user with a lowercase
   email, POST the same address in mixed case, assert the response is the
   `email_inactive` refusal (409) and not a 201 — then with `reactivate: true`
   assert it reactivates the *original* row, checking through the admin
   connection that the id is unchanged and no second row exists.

**Verification**

`make db-reset && make db-test` green, then `make test`. State in the report
which constraint name you dropped and how you confirmed it.

**Note for the controller:** this task adds a migration, so `rls-auditor` runs
on it before the task is marked complete.

---

## Task 2: The reactivate contract

Three defects and one decision in the same handler, `createUser` in
`api/internal/httpapi/admin.go`. They are one task because they touch the same
switch and the same tests.

**Files**

- `api/internal/httpapi/admin.go`
- `api/internal/store/store.go`
- `api/internal/httpapi/admin_test.go`
- `web/src/api/admin.ts` and `web/src/admin/AddDriver.tsx` (only as far as the
  200/201 change and the staff-number change force)

**What to build**

1. **A reactivate that reactivated nobody must refuse.** Today the
   `case errors.Is(lookup, pgx.ErrNoRows)` arm carries only the comment
   "Nothing here holds the address; fall through to the insert" and never
   consults `ins.reactivate`. So an admin who clicks Reactivate for a row that
   has since been renamed, or whose address differed by case, gets a
   brand-new user and the words "was added." Refuse instead: when
   `ins.reactivate` is set and no inactive row matched, answer a refusal
   saying the account is no longer there to restore. Add the code and message
   to the refusal vocabulary the way `codeEmailInactive` is added, and put the
   new code in `refusalMessage`'s `speakable` list in the web client so the
   admin reads the specific sentence rather than the generic one.

2. **A reactivate answers 200, not 201.** It is an in-place `UPDATE` of a row
   that already existed; 201 tells a caller a new person now exists, and an
   integration that counts invited drivers or runs onboarding side effects off
   that status will be wrong about someone who has been on the fleet for years.
   The create arm keeps 201. Update the client and any e2e helper that asserts
   on the status.

3. **An explicitly empty staff number clears it.** `text()`
   (`admin.go:132`) maps `""` to nil, so an omitted and an explicitly-empty
   `staffNumber` are indistinguishable, and `COALESCE($3, staff_number)` reads
   both as "keep". Distinguish them: absent keeps the old number
   (FR-AUT-022's identifier must survive a rehire that omits it), explicitly
   empty clears it. `display_name` on the line above overwrites
   unconditionally, so today the same form's two optional fields obey opposite
   rules; this makes the rule statable. Keep the existing staff-number
   retention coverage and add the clearing case.

4. **Pin READ COMMITTED.** `store.InActorTx` (`store.go:87`) calls
   `s.pool.Begin(ctx)` with no isolation option, and the handler's own comment
   explains that under REPEATABLE READ the losing concurrent reactivate raises
   `40001`, which `submitStatus` does not map, so it would surface as a 500
   instead of the 409 a form can act on. `default_transaction_isolation` is an
   Azure Postgres server parameter: a DBA can flip it with no test failing.
   Pass `pgx.TxOptions{IsoLevel: pgx.ReadCommitted}` on `Begin`. This is the
   house pattern — append-only is enforced by revoking grants, not by
   convention — and PR #37 recorded the dependency without deciding against
   enforcing it. Shorten the handler comment to cite the pin rather than
   describe an unenforced assumption.

   Apply the same option to the other `pool.Begin` at `store.go:56` only if it
   shares the dependency; say which you chose and why in the report.

**Verification**

`make test`. Every changed test must be changed for a stated reason, per
Global Constraint 5.

---

## Task 3: The three test gaps

No production code changes. Each of these passes today for the wrong reason,
and each would let a real regression ship green.

**Files**

- `api/internal/httpapi/admin_test.go`
- `api/internal/httpapi/httpapi_test.go`

**What to build**

1. **`InviteDriver` with reactivate.** Every reactivate test plants
   `auth.RoleOrgAdmin`, and `TestTieredInvite` never sets `reactivate`, so the
   combination `mayCreateRole` exists to bound is untested. PR #37 records the
   behaviour as intentional: *"an actor holding only `InviteDriver` can
   reactivate a former ORG_ADMIN as a DRIVER. That is a demotion, never an
   escalation, and it is intentional."* Prove it. A CONTROLLER holding
   `InviteDriver` and not `ManageUsers` reactivates an inactive `ORG_ADMIN`;
   assert the success status and, through the admin connection, that the row's
   role is now `DRIVER`. If a later edit reordered `mayCreateRole` or dropped
   `role = $4` from the `UPDATE`, this test is what catches the escalation.

2. **`TestTieredInvite` asserts more than a status code.** Its eight rows all
   end at `require.Equal(t, tt.want, rec.Code)`. A wrong parameter binding —
   `$4` swapped with `$2`, or a future edit defaulting the role — returns the
   same statuses and stays green. For the rows that expect `StatusCreated`,
   resolve the returned id through the admin connection and assert `role` and
   `tenant_id`. `TestReactivateCannotReachAnotherTenant` already models this.

3. **A second tenant in the timezone test.**
   `TestMeCarriesTheTenantTimezone` plants one tenant, so it cannot
   distinguish a scoped read of `app.tenant` from an unscoped one — it would
   pass if `tenant_self` were weakened to `USING (true)` or the query lost its
   `WHERE id = app.current_tenant_id()`. Plant two tenants in different zones
   and assert each actor sees only its own.

**Verification**

`make test`. Each new assertion must be able to fail: state in the report, per
test, what you broke to watch it fail and what the failure said.

---

## Task 4: The date formatter and the rule 6 gate

**Files**

- `web/src/time/tenantTime.ts`
- `web/src/time/tenantTime.test.ts`
- `web/eslint.config.js`
- `web/src/auth/actorContext.ts` and its consumers, only as far as item 2 needs

**What to build**

1. **`formatTenantDate` must not throw.** `Intl.DateTimeFormat.format()`
   raises `RangeError` on an invalid `Date`, where the `toLocaleDateString()`
   it replaced returned the string `"Invalid Date"`. Verified: `""`,
   `"not-a-date"` and `undefined` all throw; `null` coerces to the epoch and
   does not. `/api/my/tasks` is typed as returning a `string`, but the server
   is the authority, and the throw happens inside `DriverHome`'s map — it
   unwinds the whole route to a blank screen, on the one page a driver opens
   to start a capture, against the three-minute constraint. Guard the parse
   and return a short marker for an unparseable instant. Test every case
   above.

2. **A date must not present as certain when the actor never arrived.** PR #37
   accepted the transient UTC flash on `/my` deliberately — gating the
   driver's landing screen behind a round-trip costs more than the flash — and
   that decision stands. It does not cover `/api/me` failing outright, where
   the UTC fallback never lifts and every date silently reads a day out for a
   Johannesburg tenant. Staging 401s everyone until TYRE-2, so this is the
   live case, not a hypothetical. Distinguish *pending* from *errored*: while
   the actor request is in flight, render as today; once it has errored,
   render the date as provisional. Do not gate the screen and do not add a
   round-trip — the flash is not what you are fixing.

3. **Close the three bypasses in the rule 6 lint gate.** Each was verified by
   running `npx eslint` on a probe file: only `new Intl.DateTimeFormat(...)`
   and `new Date(t).toLocaleString()` are caught today. These three are not:
   - `Intl.DateTimeFormat("en-ZA", {}).format(d)` — ECMA-402 makes it callable
     without `new`, so it is a `CallExpression`, not the `NewExpression` the
     current selector matches;
   - `const d = new Date(t); d.toLocaleString()` — the `toLocaleString`
     selector requires `callee.object.type='NewExpression'`, and
     `toLocaleString` is not among the two `MemberExpression` selectors;
   - `const { DateTimeFormat } = Intl`.

   One judgment call is yours: banning `toLocaleString` by property name alone
   also catches `Number.prototype.toLocaleString`, which is legitimate. Decide
   whether that is acceptable, and if it is not, write a selector that is not
   fooled by it. State the call and its reasoning in the report.

4. **Narrow the `src/time` override.** It is a bare
   `"no-restricted-syntax": "off"`, so the one directory that exists to be the
   only place formatting dates has the rule fully disabled inside it — a
   second file added there could call `toLocaleDateString()` freely. Re-list
   the `toLocale*` selectors in the override and exempt only the `Intl`
   construction the formatter genuinely needs.

**Verification**

`make lint` and `make test`. PR #37 established the convention that a date ban
is proven before it is trusted: for **each** selector you add, plant a
violation, watch the build reject it naming the rule, then remove it. Put the
planted snippet and the exact error line in the report — a selector without
that proof is not done. Confirm the narrowed override with
`npx eslint --print-config` on a file under `src/time/`, showing
`no-restricted-syntax` still active there for the `toLocale*` forms.

---

## Task 5: Retire the stale plan and record the lessons

**Files**

- `docs/superpowers/plans/2026-08-31-b45-invites-and-tenant-time.md`
- `docs/lessons.md`

**What to build**

1. The merged B4.5 plan still prescribes code the branch deliberately
   replaced — `staff_number = $3` at its line 494, the un-`disabled`
   Reactivate button and `refusalMessage(create.error, …)` around 691/713, and
   a Task 6 eslint block without the `Intl` ban — under a header telling the
   next executor the samples were verified and not to re-derive them. Per
   CLAUDE.md a second copy becomes a stale second authority. Add a dated
   superseded note at the top: what shipped differently, that TYRE-95 fixed
   what shipped, and that the code is the authority. Do not rewrite the task
   bodies — the plan is a record of what was planned, and rewriting it
   destroys the process signal PR #37 captured.

2. Append to `docs/lessons.md`, in the file's existing dated-with-an-imperative
   -rule format, only what would change how the next session behaves.
   Candidates, and you should judge which earn a line:
   - a lint selector is not a gate until a planted violation has been rejected
     by it — the B4.5 proofs covered the forms that were written, not the
     forms that were reachable;
   - a review that reads the diff and the plan but not the PR body will
     re-report decisions the author already recorded (four of TYRE-95's
     findings were already in PR #37).

**Verification**

`make lint` — `scripts/check-comment-style.mjs` runs over docs too. No code
changes, so no test run is expected.
