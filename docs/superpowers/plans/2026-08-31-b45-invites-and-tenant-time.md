# B4.5 — tiered invites and tenant time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Verified against the code on 31 Aug 2026 (develop @ efdf251).** Every file path, function name, line reference, test helper and grant this plan names was checked against the tree that day, and the code samples were corrected where they disagreed. An executor should not spend tokens re-deriving them. Where a step still disagrees with the code, the code wins — report it, do not redesign.

**Goal:** Let a CONTROLLER or DEPOT_MANAGER invite a driver without going through the owner, and make every date a screen shows the tenant's date rather than the browser's.

**Architecture:** Two tickets, both edits to code B4 delivered last week. TYRE-83 adds one finer capability and one handler rule; the role narrowing is a capability question answered in `auth`, never a role-name branch in a handler (ADR-0011). TYRE-89 puts the tenant's IANA timezone on `/api/me`, routes every rendered date through one formatter, and moves an assignment's default `from_date` out of the browser and into SQL.

**Tech Stack:** Go 1.24 (`chi`, `pgx` v5, `testify/require`), PostgreSQL 16, React 19 + Vite + TypeScript strict, Tanstack Query, vitest + Testing Library, Playwright, eslint flat config.

**Spec:** `docs/implementation-order.md` § "B4.5 — what sits on B4's code", plus the two Jira tickets (TYRE-83, TYRE-89) and ADR-0013 (`docs/adr/0013-*`), whose "Constraints on later work" names the hook locations this plan edits.

## Global Constraints

Every task's requirements implicitly include these. They are the project's, not this plan's.

- **Tenant isolation lives in the database.** `tenant_id` on any write comes from `app.current_tenant_id()`, never from the request. Every new write path gets a `WITH CHECK` test that aims a write at another tenant and requires it to fail.
- **Handlers assert capabilities, never role names** (ADR-0011). A branch on `a.Role == "CONTROLLER"` is a defect even when it produces the right answer.
- **Refusal messages are ours or they are canned** (ADR-0012). A message written in Go, naming a request field and no schema object, may be forwarded. A message Postgres wrote is canned.
- **Timestamps are stored UTC and displayed in the tenant's timezone** (rule 6, DR-010, CR-003 / FR-TEN-005).
- **No `any` in TypeScript.** `@typescript-eslint/no-explicit-any` is an error.
- **Comments explain *why*.** Every non-obvious rule cites its requirement ID. Never narrate a change or compare to old code — git holds the history. `docs/comments.md` is the standard and `make lint` enforces it.
- **Commits:** conventional, with the Jira key — `feat(api): TYRE-83 …`. Rebase onto `develop`, never merge.
- **Do not weaken a test to make it pass.** If a test is wrong, say so and explain why first.

**Branch:** `TYRE-83-tiered-invites`, cut from `origin/develop`.

> Cut it with `git checkout -b TYRE-83-tiered-invites origin/develop`, naming the remote explicitly. The 29 Aug promotion rewrote every hash on `develop` and a local `develop` that has not been reset still points at the orphaned ones.

**Verification, once per task:** `make check`. It runs fmt, lint and every test in the repo, in CI's order. `make api-test` and `make web-test` narrow it while iterating; `make db-up` must have run first for the Go integration tests.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `api/internal/auth/auth.go` | The capability vocabulary and the role→capability table | 1 |
| `api/internal/auth/auth_test.go` | The table is an exact set — `require.Len` is what keeps it honest | 1 |
| `api/internal/httpapi/httpapi.go` | `refusalError` (new), the `email_inactive` code, `meJSON.Timezone` | 3, 5 |
| `api/internal/httpapi/admin.go` | `mayCreateRole`, the collision classification, the reactivate update, the optional `fromDate` | 2, 3, 7 |
| `api/internal/httpapi/admin_test.go` | Integration tests for all of the above | 2, 3, 7 |
| `api/internal/httpapi/httpapi_test.go` | `plantTenantInZone` helper (new) | 7 |
| `web/src/auth/me.ts` | The wire shape of `/api/me` | 5 |
| `web/src/time/tenantTime.ts` | **New.** The one path a date takes to a screen | 6 |
| `web/src/time/tenantTime.test.ts` | **New.** Fixed instant, two zones, no dependence on the runner's | 6 |
| `web/eslint.config.js` | The ban that stops the rule decaying into a convention | 6 |
| `web/src/driver/DriverHome.tsx` | The one existing bare `toLocaleDateString` on a `Date` | 6 |
| `web/src/api/admin.ts` | `NewUser.reactivate`, `NewAssignment.fromDate` optional | 4, 8 |
| `web/src/admin/AddDriver.tsx` | The narrowed picker, the reactivate branch, losing `today()` | 4, 8 |

---

## Task 1: The InviteDriver capability

**Files:**
- Modify: `api/internal/auth/auth.go`
- Test: `api/internal/auth/auth_test.go`

**Interfaces:**
- Produces: `auth.InviteDriver` (a `auth.Capability` whose value is the string `"InviteDriver"`), held by `RoleController` and `RoleDepotManager` and by no other role.

> **Why ORG_ADMIN does not hold it.** ORG_ADMIN reaches the same invite through `ManageUsers`, which is broader. Granting both would make "holds only InviteDriver" — the condition Task 2 branches on — untrue of the role it was meant to describe, and the test's `cant` list is where that stays visible.

- [ ] **Step 1: Update the capability table test first**

In `api/internal/auth/auth_test.go`, inside `TestRoleCapabilities`, edit five of the seven cases. Add `auth.InviteDriver` to the `can` list of `controller` and `depot manager`; add it to the `cant` list of `driver`, `technician`, `platform admin` and `unknown role`; and give `org admin` a `cant` list where it currently has `nil`.

```go
		{
			// FR-AUT-007 with FR-FIT-018: both controller jobs are this role.
			// FR-AUT-005a: a controller carries the commercial picture.
			// FR-AUT-007 carries erratum D1 — the cadence belongs to whoever
			// is responsible for the drivers, and an ORG_ADMIN is not.
			// D9: driver onboarding must not queue behind the owner.
			name: "controller",
			role: auth.RoleController,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.InviteDriver},
			cant: []auth.Capability{auth.ManageUsers, auth.ManageTemplates},
		},
		{
			// FR-AUT-008: every CONTROLLER permission, ViewValuation included.
			// The narrowing is by depot in the scope views, never by
			// withholding a capability — and ManageConfig has no narrowing at
			// all, since app.configuration is keyed by tenant (D1).
			name: "depot manager",
			role: auth.RoleDepotManager,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.InviteDriver},
			cant: []auth.Capability{auth.ManageUsers, auth.ManageTemplates},
		},
```

For `org admin`, replace `cant: nil,` with:

```go
			// D9's finer capability is not ORG_ADMIN's: it reaches the same
			// invite through ManageUsers, and holding both would make
			// "holds only InviteDriver" false of the role that phrase
			// describes (createUser's mayCreateRole).
			cant: []auth.Capability{auth.InviteDriver},
```

For `driver`, `technician`, `platform admin` and `unknown role`, append `auth.InviteDriver` to the existing `cant` slice.

- [ ] **Step 2: Run the test to verify it fails**

Run: `make api-test`

Expected: FAIL — `undefined: auth.InviteDriver` (a compile error, which is the failure this step wants).

- [ ] **Step 3: Add the capability and grant it**

In `api/internal/auth/auth.go`, add the constant to the `Capability` block, immediately after `ManageUsers`:

```go
	ManageUsers     Capability = "ManageUsers"
	// InviteDriver is ManageUsers narrowed to one role (D9, amending
	// FR-AUT-010). Driver onboarding otherwise queues behind the one person
	// holding ManageUsers, and the fleet stops capturing while it waits. It
	// grants no path to create or promote an administrator: createUser pairs
	// it with the requested role, and DRIVER is the only pairing it accepts,
	// so there is no privilege escalation to reason about.
	InviteDriver Capability = "InviteDriver"
```

Then add it to the two roles in `capabilities`:

```go
	RoleController:   {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig, InviteDriver},
	RoleDepotManager: {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig, InviteDriver},
```

Leave `RoleOrgAdmin` unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `make api-test`

Expected: PASS. If `TestRoleCapabilities` fails on `require.Len`, a `can` list and the map disagree — fix the list, not the assertion.

- [ ] **Step 5: Commit**

```bash
git add api/internal/auth/auth.go api/internal/auth/auth_test.go
git commit -m "feat(auth): TYRE-83 add InviteDriver for controllers and depot managers"
```

---

## Task 2: createUser honours the narrower capability

**Files:**
- Modify: `api/internal/httpapi/admin.go`
- Test: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Consumes: `auth.InviteDriver` from Task 1.
- Produces: `mayCreateRole(a auth.Actor, role string) error` in package `httpapi` — returns `nil` when the actor may create that role, and an error wrapping `errForbidden` otherwise. `withActor` already turns an `errForbidden` into a 403 with the canned message.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/httpapi/admin_test.go`:

```go
// D9: the invite is narrowed by capability and not by role name, so the test
// asserts the pairing of actor and requested role rather than the actor alone.
// A CONTROLLER creating an ORG_ADMIN is the privilege-escalation path the
// decision exists to close, and it is the case worth failing loudly.
func TestTieredInvite(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "tiered")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	body := func(email, role string) string {
		return fmt.Sprintf(`{"email":%q,"displayName":"Someone","role":%q}`, email, role)
	}

	tests := []struct {
		name  string
		role  auth.Role
		makes string
		want  int
	}{
		{"controller invites a driver", auth.RoleController, "DRIVER", http.StatusCreated},
		{"depot manager invites a driver", auth.RoleDepotManager, "DRIVER", http.StatusCreated},
		{"controller may not invite an org admin", auth.RoleController, "ORG_ADMIN", http.StatusForbidden},
		{"controller may not invite a controller", auth.RoleController, "CONTROLLER", http.StatusForbidden},
		{"depot manager may not invite an org admin", auth.RoleDepotManager, "ORG_ADMIN", http.StatusForbidden},
		{"org admin invites any role", auth.RoleOrgAdmin, "ORG_ADMIN", http.StatusCreated},
		{"technician invites nobody", auth.RoleTechnician, "DRIVER", http.StatusForbidden},
		{"driver invites nobody", auth.RoleDriver, "DRIVER", http.StatusForbidden},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			actor := plantUser(t, ctx, admin, tenantID, tt.role)
			email := fmt.Sprintf("tiered-%d-%s@example.invalid", i, uuid.NewString()[:8])
			rec := post(t, h, "/api/users", tenantID.String(), actor.String(), body(email, tt.makes))
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}
```

If `fmt` is not yet imported in this file, add it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `make db-up && make api-test`

Expected: FAIL on the four `StatusForbidden` cases that name a CONTROLLER or DEPOT_MANAGER — they currently get 403 for lacking `ManageUsers`, so the two `StatusCreated` rows fail first with 403 where 201 was wanted.

- [ ] **Step 3: Add the rule and use it**

In `api/internal/httpapi/admin.go`, add above `createUser`:

```go
// mayCreateRole answers D9. ManageUsers creates any role tenantRoles allows;
// InviteDriver creates a DRIVER and nothing else. Both are capability
// questions — the actor's role name never appears, so separating the
// controller jobs later stays an edit to auth's table (ADR-0011).
//
// The pairing is what makes the guardrail hold: an actor without ManageUsers
// cannot create an administrator, so no path here promotes anyone.
func mayCreateRole(a auth.Actor, role string) error {
	if a.Can(auth.ManageUsers) {
		return nil
	}
	if a.Can(auth.InviteDriver) && role == string(auth.RoleDriver) {
		return nil
	}
	return fmt.Errorf("%w: %s may not create %s", errForbidden, a.Role, role)
}
```

Then in `createUser`, replace the capability guard:

```go
			if err := require(a, auth.ManageUsers); err != nil {
				return err
			}
```

with:

```go
			if err := mayCreateRole(a, ins.role); err != nil {
				return err
			}
```

Update `createUser`'s doc comment, replacing "gated on ManageUsers" with "gated on ManageUsers, or on InviteDriver for a DRIVER alone (D9)".

- [ ] **Step 4: Run the test to verify it passes**

Run: `make api-test`

Expected: PASS, including the pre-existing `TestCreateUser` and `TestWriteAimedAtAnotherTenantIsRefused_AppUser`.

- [ ] **Step 5: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go
git commit -m "feat(api): TYRE-83 narrow the invite to DRIVER for controllers"
```

---

## Task 3: The reactivate branch

**Files:**
- Modify: `api/internal/httpapi/httpapi.go` (the `refusalError` type, the `email_inactive` code and message)
- Modify: `api/internal/httpapi/admin.go` (the classification and the update path)
- Test: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Produces: `refusalError` in package `httpapi` — a handler-composed refusal that `withActor` renders. Constructed as `refusalError{refusal{status: …, code: …, message: …}}`.
- Produces: the wire code `email_inactive` on `POST /api/users`, and the request field `reactivate` (a `bool`, absent meaning false).

> **Why a classification query rather than a smarter constraint.** `app_user_tenant_id_email_key` is a plain unique index over active *and* inactive rows — deliberately, unlike `one_active_staff_number_per_tenant` (000019), because an email identifies a person across employments where a staff number does not. Postgres therefore cannot tell the handler *which* kind of collision it caught. One `SELECT` before the insert classifies it. The constraint stays the authority: a row that appears between the lookup and the insert is still caught, and answers the generic `email_taken`.

> **Why `refusalError` is worth adding now.** `withActor` can currently only be refused from inside a transaction with `errForbidden` or `errVehicleNotVisible` — two fixed sentences. B5 needs handler-composed refusals on nearly every write. Adding the mechanism here, with one caller and a test, is cheaper than adding it under pressure later. ADR-0012's rule is unchanged: the message is written in Go, names no schema object, and is never Postgres's.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/httpapi/admin_test.go`:

```go
// D10: leaving a company is active = false, never a delete, so a rehire meets
// a unique constraint that spans inactive rows. The refusal has to say which
// collision it is, or the screen can only offer "that email is taken" to an
// admin whose next action is to reactivate the person.
func TestReactivateAnInactiveUser(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "rehire")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)

	email := "rehire-" + uuid.NewString()[:8] + "@example.invalid"
	create := fmt.Sprintf(`{"email":%q,"displayName":"Thandi First","role":"DRIVER"}`, email)

	rec := post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var first userBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &first))

	// An active collision stays email_taken: there is nothing to reactivate.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_taken", errorCode(t, rec))

	_, err := admin.Exec(ctx, `UPDATE app.app_user SET active = false WHERE id = $1`, first.ID)
	require.NoError(t, err)

	// Now the same request is a rehire, and must say so rather than repeat
	// the sentence that tells the admin to pick another address.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), create)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_inactive", errorCode(t, rec))

	// The same request carrying the admin's answer reactivates in place: the
	// id is the original person's, so their inspection history stays theirs
	// (FR-VEH-008).
	reactivate := fmt.Sprintf(
		`{"email":%q,"displayName":"Thandi Returned","role":"DRIVER","reactivate":true}`, email)
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), reactivate)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var again userBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &again))
	require.Equal(t, first.ID, again.ID, "a rehire is the same person, not a new row")
	require.True(t, again.Active)
	require.Equal(t, "Thandi Returned", again.DisplayName)

	// And reactivating what is already active is not a silent no-op.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), reactivate)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Equal(t, "email_taken", errorCode(t, rec))
}

// A reactivate is an UPDATE, which is a write path of its own and needs its
// own proof that tenant_isolation's WITH CHECK holds it (rule 1).
func TestReactivateAimedAtAnotherTenantIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	mine, _ := plantTenantWithVehicle(t, ctx, admin, "rehire-mine")
	theirs, _ := plantTenantWithVehicle(t, ctx, admin, "rehire-theirs")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	email := "cross-" + uuid.NewString()[:8] + "@example.invalid"
	var victim uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role, active)
		 VALUES ($1, $2, 'Their Person', 'DRIVER', false) RETURNING id`,
		theirs, email).Scan(&victim))

	// My admin asks to reactivate an address only the other tenant holds. The
	// row is invisible under RLS, so this must read as "nobody here has that
	// address" and create a new user in MY tenant — never touch theirs.
	mineAdmin := plantUser(t, ctx, admin, mine, auth.RoleOrgAdmin)
	rec := post(t, h, "/api/users", mine.String(), mineAdmin.String(),
		fmt.Sprintf(`{"email":%q,"displayName":"Mine","role":"DRIVER","reactivate":true}`, email))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

	var stillInactive bool
	var owner uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT active, tenant_id FROM app.app_user WHERE id = $1`, victim).
		Scan(&stillInactive, &owner))
	require.False(t, stillInactive, "the other tenant's row must not have been reactivated")
	require.Equal(t, theirs, owner)
}
```

Add two small helpers to the same file if they are not already present:

```go
type userBody struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Active      bool   `json:"active"`
}

// errorCode reads the refusal envelope's machine-readable half (ADR-0012), so
// an assertion names the contract rather than a sentence that may be reworded.
// The envelope is flat — errorBody is {"code": …, "message": …} — with no
// wrapper key.
func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	return body.Code
}
```

> The envelope shape above is `errorBody` in `httpapi.go` (`Code`/`Message`, tagged `code`/`message`, written by `writeError`). Verified 31 Aug; it is flat, not nested under `error`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `make api-test`

Expected: FAIL — the second create answers `email_taken` where `email_inactive` was wanted, and the reactivate answers 409 rather than 201.

- [ ] **Step 3: Add the refusal mechanism**

In `api/internal/httpapi/httpapi.go`, add beside `errForbidden`:

```go
// refusalError lets a handler refuse from inside its transaction with a
// refusal it composes, the way errForbidden does for a fixed 403. ADR-0012 is
// unchanged by it: the message is written in Go, names a request field and no
// schema object, and is never one Postgres wrote.
type refusalError struct{ refusal }

func (e refusalError) Error() string { return e.code + ": " + e.message }
```

Add the code and message beside their neighbours:

```go
	codeEmailInactive      = "email_inactive"
```

```go
	msgEmailInactive = "a user with this email address was deactivated; reactivate them instead of adding a new one"
```

> Place each beside the existing `codeEmailTaken` / `msgEmailTaken` and follow whatever declaration style that block uses.

In `withActor`, add a case **before** `case isClient:`:

```go
	var ref refusalError
	// … inside the switch:
	case errors.As(err, &ref):
		writeError(ctx, w, ref.status, ref.code, ref.message)
		return false
```

Declare `var ref refusalError` above the `switch`, next to the existing `ref, isClient := refusalForPgError(err)` — rename that pair's first variable to `pgRef` so the two do not collide, and update its single use in `case isClient:` to `pgRef`.

- [ ] **Step 4: Classify the collision and add the update path**

In `api/internal/httpapi/admin.go`, add the field to `createUserRequest`:

```go
type createUserRequest struct {
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	StaffNumber *string `json:"staffNumber"`
	Role        string  `json:"role"`
	// D10's rehire answer. Absent means "add a new user"; true means the
	// admin has been shown the deactivated row and asked for it back.
	Reactivate bool `json:"reactivate"`
}
```

Carry it into `userInsert` by adding `reactivate bool` and setting `u.reactivate = b.Reactivate` at the end of `validate()`.

Then replace the body of `createUser`'s transaction — everything from `if err := mayCreateRole(...)` to the `return nil` — with:

```go
			if err := mayCreateRole(a, ins.role); err != nil {
				return err
			}

			// Classify the collision before inserting, because the unique
			// index spans inactive rows and Postgres cannot say which kind it
			// caught. RLS scopes this lookup, so another tenant's address is
			// simply not here and the request proceeds as a create — which is
			// the honest answer for this tenant.
			var existingActive bool
			lookup := tx.QueryRow(ctx,
				`SELECT active FROM app.app_user WHERE email = $1`, ins.email).
				Scan(&existingActive)
			switch {
			case lookup == nil && existingActive:
				return refusalError{refusal{http.StatusConflict, codeEmailTaken, msgEmailTaken}}
			case lookup == nil && !ins.reactivate:
				return refusalError{refusal{http.StatusConflict, codeEmailInactive, msgEmailInactive}}
			case lookup == nil:
				// A rehire is the same person: updating in place keeps the id
				// their inspections are attributed through (FR-VEH-008).
				// UPDATE is granted on app_user — only DELETE was revoked
				// (000002, 000018) — because a person is not an event.
				err := tx.QueryRow(ctx,
					`UPDATE app.app_user
					    SET active = true, display_name = $2, staff_number = $3,
					        role = $4::app.user_role
					  WHERE email = $1 AND NOT active
					 RETURNING id, email, display_name, role::text, staff_number, active`,
					ins.email, ins.displayName, ins.staffNumber, ins.role).
					Scan(&createdID, &created.Email, &created.DisplayName, &created.Role,
						&created.StaffNumber, &created.Active)
				if errors.Is(err, pgx.ErrNoRows) {
					// Reactivated by someone else between the lookup and this
					// update. That is an active collision now, and the admin's
					// next action is the same as for any other one.
					return refusalError{refusal{http.StatusConflict, codeEmailTaken, msgEmailTaken}}
				}
				if err != nil {
					return fmt.Errorf("reactivating user: %w", err)
				}
				created.ID = createdID.String()
				return nil
			case errors.Is(lookup, pgx.ErrNoRows):
				// Nothing here holds the address; fall through to the insert.
			default:
				return fmt.Errorf("checking for an existing user: %w", lookup)
			}

			err := tx.QueryRow(ctx,
				`INSERT INTO app.app_user
				   (tenant_id, email, display_name, staff_number, role)
				 VALUES (app.current_tenant_id(), $1, $2, $3, $4::app.user_role)
				 RETURNING id, email, display_name, role::text, staff_number, active`,
				ins.email, ins.displayName, ins.staffNumber, ins.role).
				Scan(&createdID, &created.Email, &created.DisplayName, &created.Role,
					&created.StaffNumber, &created.Active)
			if err != nil {
				return fmt.Errorf("creating user: %w", err)
			}
			created.ID = createdID.String()
			return nil
```

Declare `var createdID uuid.UUID` above the `withActor` call rather than inside, since both branches assign it. Ensure `errors` and `pgx` are imported in this file.

> **A rehire takes the requested role.** The UPDATE overwrites `role` with `ins.role`, which `mayCreateRole` has already bounded: an actor holding only `InviteDriver` can therefore reactivate a former ORG_ADMIN *as a DRIVER*. That is a demotion, never an escalation, and it is deliberate — the person is being rehired into the job the actor may hire for. Say so in the PR body.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make api-test`

Expected: PASS, including `TestCreateUser`, `TestTieredInvite` and both cross-tenant tests.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/httpapi.go api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go
git commit -m "feat(api): TYRE-83 offer reactivation when a rehire meets the email constraint"
```

---

## Task 4: The screen narrows its picker and offers the rehire

**Files:**
- Modify: `web/src/api/admin.ts`
- Modify: `web/src/admin/AddDriver.tsx`
- Test: `web/src/admin/AddDriver.test.tsx`

**Interfaces:**
- Consumes: the `email_inactive` code from Task 3; `useCan` from `web/src/auth/actorContext.ts`.
- Produces: `NewUser.reactivate?: boolean` on the `createUser` wire type.

- [ ] **Step 1: Write the failing tests**

`web/src/admin/AddDriver.test.tsx` (verified 31 Aug) has **no** actor provider, **no** request spy and **no** `ApiError` injection. Its conventions are: `renderScreen()` wraps only a `QueryClientProvider`; `fetch` is stubbed with `vi.stubGlobal("fetch", vi.fn())` in `beforeEach`; responses are built with `respond(status, body)`; `fillAndSubmit()` types the email and name and clicks *Add user*; `CREATED` is the created-user fixture. Never construct `ApiError` in a test — its signature is `(status, message, code)` and stubbing `fetch` reaches the same branch through the real client.

First extend the render helper so a test can supply capabilities. Replace `renderScreen` with:

```tsx
import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";

// Capabilities rather than a role name: the screen branches on useCan
// (ADR-0011), so the test names what the screen reads.
function renderScreen(capabilities: string[] = ["ManageUsers", "ManageAssignments"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const actor: Me = {
    userId: "u0",
    displayName: "Admin",
    role: "ORG_ADMIN",
    capabilities,
    depots: [],
  };
  return render(
    <ActorContext.Provider value={{ actor, settled: true }}>
      <QueryClientProvider client={client}>
        <AddDriver />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}
```

(Task 5 adds `timezone` to `Me`; add `timezone: "Africa/Johannesburg"` to this fixture then.) Then rename the existing test `"names the rehire case rather than reporting a generic conflict"` to `"names an active collision as an address already in use"` — it drives `email_taken`, and once `email_inactive` exists its old name describes the wrong case.

Append these tests inside the `describe`:

```tsx
  it("offers only DRIVER to an actor holding InviteDriver alone", () => {
    renderScreen(["ManageAssignments", "InviteDriver"]);

    const roles = screen.getAllByRole("option", { name: /driver|controller|admin|technician/i });
    expect(roles).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Driver" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Organisation admin" })).not.toBeInTheDocument();
  });

  it("offers every tenant role to an actor holding ManageUsers", () => {
    renderScreen(["ManageUsers", "ManageAssignments"]);

    expect(screen.getByRole("option", { name: "Organisation admin" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Driver" })).toBeInTheDocument();
  });

  // The refusal has to become an offer, or the admin's only reading is "pick
  // another address" — which for a rehire is wrong and creates a second person.
  it("offers reactivation when the email belongs to a deactivated user", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(409, {
          code: "email_inactive",
          message:
            "a user with this email address was deactivated; reactivate them instead of adding a new one",
        }),
      )
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, []));

    renderScreen();
    await fillAndSubmit();

    const again = await screen.findByRole("button", { name: /reactivate/i });
    await userEvent.click(again);

    await screen.findByRole("status");
    const [, init] = vi.mocked(fetch).mock.calls[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: "new@example.invalid",
      reactivate: true,
    });
  });
```

> `fetch` receives the body as a JSON string in `init.body`, so assertions on what was sent parse it. The existing tests use the default `renderScreen()` and are unaffected by the narrowing: the default actor holds `ManageUsers`, and the form's default role is already `DRIVER`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `make web-test`

Expected: FAIL — every role is offered regardless of capability, and no reactivate button exists.

- [ ] **Step 3: Add the field to the wire type**

In `web/src/api/admin.ts`, extend `NewUser`:

```ts
export interface NewUser {
  email: string;
  displayName: string;
  staffNumber?: string;
  role: TenantRole;
  // D10: the admin's answer to "this address belongs to a deactivated user".
  // Absent is a plain create; the server refuses with email_inactive until it
  // is set, so this can never reactivate somebody silently.
  reactivate?: boolean;
}
```

- [ ] **Step 4: Narrow the picker and add the branch**

In `web/src/admin/AddDriver.tsx`, replace the `ROLES` comment's D9 paragraph with a statement of what the code now does, and add the narrowing inside the component:

```tsx
  // D9. ManageUsers offers the whole list; InviteDriver alone offers DRIVER.
  // The server decides the same question again (mayCreateRole) — this only
  // keeps the form from expressing a request it knows will be refused.
  const canManageUsers = useCan("ManageUsers");
  const roles = canManageUsers ? ROLES : ROLES.filter((r) => r.value === "DRIVER");
```

Render `roles` instead of `ROLES` in the `<select>`. Add the reactivate state and branch:

```tsx
  const [rehire, setRehire] = useState<string | null>(null);
```

In the `create` mutation, add an `onError` that captures the offer, and clear it in `onSuccess`:

```tsx
    onError: (error) => {
      setRehire(error instanceof ApiError && error.code === "email_inactive" ? email : null);
    },
```

Add `setRehire(null);` to the existing `onSuccess` body. Then render the offer beneath the existing error paragraph:

```tsx
      {rehire !== null && (
        <p role="alert">
          {refusalMessage(create.error, "add a user")}{" "}
          <button
            type="button"
            onClick={() =>
              create.mutate({
                email: rehire,
                displayName,
                staffNumber: staffNumber === "" ? undefined : staffNumber,
                role,
                reactivate: true,
              })
            }
          >
            Reactivate {rehire}
          </button>
        </p>
      )}
```

Guard the existing `{create.isError && …}` paragraph with `rehire === null` so the sentence is not rendered twice.

Add `"email_inactive"` to `refusalMessage`'s `speakable` list, so the server's sentence reaches the admin verbatim rather than being replaced by the generic one.

Import `useCan` from `../auth/actorContext`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make web-test`

Expected: PASS, including the existing `AddDriver.test.tsx` cases.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/admin.ts web/src/admin/AddDriver.tsx web/src/admin/AddDriver.test.tsx
git commit -m "feat(web): TYRE-83 narrow the role picker and offer a rehire"
```

---

## Task 5: /api/me carries the tenant's timezone

**Files:**
- Modify: `api/internal/httpapi/httpapi.go`
- Modify: `web/src/auth/me.ts`
- Test: `api/internal/httpapi/httpapi_test.go`

**Interfaces:**
- Produces: `meJSON.Timezone` on the wire as `timezone` — an IANA name such as `Africa/Johannesburg`. Consumed by Tasks 6 and 8.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/httpapi/httpapi_test.go`:

```go
// Rule 6's display half starts here: until /api/me carries it, the web app
// cannot know it is a Johannesburg tenant and every date it renders is the
// browser's guess.
func TestMeCarriesTheTenantTimezone(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tz")
	_, err := admin.Exec(ctx,
		`UPDATE app.tenant SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, tenantID)
	require.NoError(t, err)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})
	actor := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/me", tenantID.String(), actor.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var body struct {
		Timezone string `json:"timezone"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "Pacific/Kiritimati", body.Timezone)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make api-test`

Expected: FAIL — `""` where `"Pacific/Kiritimati"` was wanted.

- [ ] **Step 3: Read and send it**

In `api/internal/httpapi/httpapi.go`, add the field to `meJSON`:

```go
type meJSON struct {
	UserID       string   `json:"userId"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Depots       []string `json:"depots"`
	// The tenant's IANA zone, so the client can render a stored UTC instant
	// as the tenant's civil time (rule 6, FR-TEN-005). Sent here rather than
	// per-response because it changes about never and every screen needs it.
	Timezone string `json:"timezone"`
}
```

In `me`, take the transaction rather than discarding it, and read the column inside it:

```go
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			body = meJSON{
				UserID:       a.UserID.String(),
				DisplayName:  a.DisplayName,
				Role:         string(a.Role),
				Capabilities: []string{},
				Depots:       []string{},
			}
			// In the actor's own transaction, so RLS answers for this tenant
			// and the row cannot be another's.
			if err := tx.QueryRow(ctx,
				`SELECT timezone FROM app.tenant WHERE id = app.current_tenant_id()`).
				Scan(&body.Timezone); err != nil {
				return fmt.Errorf("reading tenant timezone: %w", err)
			}
```

Leave the rest of the function as it is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `make api-test`

Expected: PASS.

- [ ] **Step 5: Mirror it on the client**

In `web/src/auth/me.ts`, add to the `Me` interface:

```ts
  // The tenant's IANA timezone. Every date a screen shows is formatted in it
  // (rule 6) — see web/src/time/tenantTime.ts, which is the only path.
  timezone: string;
```

Three fixtures construct a `Me` and will fail to typecheck; add `timezone: "Africa/Johannesburg"` to each: `web/src/routes.test.tsx` (the `controller` fixture near line 136), `web/src/auth/RequireCapability.test.tsx` (the `actor` factory near line 8), and the `renderScreen` fixture Task 4 added to `web/src/admin/AddDriver.test.tsx`. Run `make lint` (its `tsc` step) to catch any other.

- [ ] **Step 6: Run everything to verify it passes**

Run: `make api-test && make web-test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/internal/httpapi/httpapi.go api/internal/httpapi/httpapi_test.go web/src/auth/me.ts web/src
git commit -m "feat(api): TYRE-89 send the tenant timezone on /api/me"
```

---

## Task 6: One formatting path, enforced by lint

**Files:**
- Create: `web/src/time/tenantTime.ts`
- Create: `web/src/time/tenantTime.test.ts`
- Modify: `web/eslint.config.js`
- Modify: `web/src/driver/DriverHome.tsx`

**Interfaces:**
- Consumes: `Me.timezone` from Task 5.
- Produces:
  - `formatTenantDate(instant: string | Date, timeZone: string): string`
  - `useTenantDate(): (instant: string | Date) => string` — a hook reading the actor's zone from context.

> **Test design note.** Do not assert "the formatted date equals today". A test that depends on the runner's clock or zone passes on one machine and fails on another. Format one **fixed** instant in two zones far enough apart that their civil dates always differ, and assert both. `Pacific/Kiritimati` (UTC+14) and `Pacific/Midway` (UTC-11) are 25 hours apart, so they never share a civil date.

- [ ] **Step 1: Write the failing test**

Create `web/src/time/tenantTime.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatTenantDate } from "./tenantTime";

// A fixed instant in two zones 25 hours apart. Their civil dates can never
// agree, so this asserts the zone is honoured no matter where it runs — which
// is the whole point of the rule (rule 6, FR-TEN-005).
describe("formatTenantDate", () => {
  const instant = "2026-01-01T23:00:00Z";

  // Exact strings, not toContain: "2026" contains "02", so a substring
  // assertion on the day could never fail (docs/lessons.md, 20 Aug).
  it("renders the tenant's civil date, not the runner's", () => {
    expect(formatTenantDate(instant, "Pacific/Kiritimati")).toBe("02 Jan 2026");
    expect(formatTenantDate(instant, "Pacific/Midway")).toBe("01 Jan 2026");
  });

  it("puts a South African tenant on its own day for an instant captured abroad", () => {
    // 22:30 UTC is already the next day in Johannesburg (UTC+2).
    expect(formatTenantDate("2026-03-14T22:30:00Z", "Africa/Johannesburg")).toBe("15 Mar 2026");
    expect(formatTenantDate("2026-03-14T22:30:00Z", "America/Los_Angeles")).toBe("14 Mar 2026");
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(formatTenantDate(new Date(instant), "Pacific/Midway")).toEqual(
      formatTenantDate(instant, "Pacific/Midway"),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make web-test`

Expected: FAIL — cannot resolve `./tenantTime`.

- [ ] **Step 3: Write the formatter and the hook**

Create `web/src/time/tenantTime.ts`:

```ts
import { useActor } from "../auth/actorContext";

// The only path a stored instant takes to a screen (rule 6, DR-010,
// FR-TEN-005). Storage is UTC throughout; what a person reads is their
// tenant's civil time, which is not the browser's — a South African fleet's
// truck inspected in America must still read as the South African day.
//
// en-ZA rather than the browser's locale: the tenant's calendar is the
// tenant's, and a date that reorders its parts per viewer is harder to read
// against a printed sheet, not easier.
export function formatTenantDate(instant: string | Date, timeZone: string): string {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(at);
}

// UTC is the fallback only while GET /api/me is in flight. A screen that
// renders dates before the actor settles is showing a placeholder anyway; a
// wrong zone that persists would be a bug in the screen, not here.
export function useTenantDate(): (instant: string | Date) => string {
  const timeZone = useActor()?.timezone ?? "UTC";
  return (instant) => formatTenantDate(instant, timeZone);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `make web-test`

Expected: PASS.

- [ ] **Step 5: Convert the one screen that renders a date**

In `web/src/driver/DriverHome.tsx`, import the hook, call it in the component, and replace line 44's expression:

```tsx
  const tenantDate = useTenantDate();
```

```tsx
                  {t.fleetNumber} — due {tenantDate(t.dueAt)}
```

- [ ] **Step 6: Add the ban that keeps the rule**

In `web/eslint.config.js`, add to the `rules` block:

```js
      // Rule 6's display half, enforced rather than remembered (TYRE-89).
      // toLocaleDateString and toLocaleTimeString exist only on Date, so
      // naming them is precise; toLocaleString is also Number's, and the
      // odometer readings that use it are numbers and unaffected — only its
      // Date form is named.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='toLocaleDateString']",
          message:
            "Render dates through formatTenantDate/useTenantDate (web/src/time/tenantTime.ts) — the browser's zone is not the tenant's (rule 6).",
        },
        {
          selector: "MemberExpression[property.name='toLocaleTimeString']",
          message:
            "Render times through web/src/time/tenantTime.ts — the browser's zone is not the tenant's (rule 6).",
        },
        {
          selector:
            "CallExpression[callee.object.type='NewExpression'][callee.object.callee.name='Date'][callee.property.name='toLocaleString']",
          message:
            "Render dates through web/src/time/tenantTime.ts — the browser's zone is not the tenant's (rule 6).",
        },
      ],
```

- [ ] **Step 7: Prove the ban fails the build, then prove the tree is clean**

Temporarily add `new Date().toLocaleDateString();` to `web/src/driver/DriverHome.tsx`, run `make lint`, and confirm it fails naming that line. **Remove it**, then run `make lint` again and confirm it passes.

Run: `make lint`

Expected: first FAIL with the rule's message, then PASS. A rule that cannot fail is not a gate.

- [ ] **Step 8: Commit**

```bash
git add web/src/time web/eslint.config.js web/src/driver/DriverHome.tsx
git commit -m "feat(web): TYRE-89 render every date in the tenant's timezone"
```

---

## Task 7: An assignment's date defaults to the tenant's day

**Files:**
- Modify: `api/internal/httpapi/admin.go`
- Modify: `api/internal/httpapi/httpapi_test.go` (new helper)
- Test: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Produces: `POST /api/vehicles/{vehicleID}/drivers` accepts a body with no `fromDate`; the row lands on the tenant's civil day.
- Produces: `plantTenantInZone(t, ctx, admin, label, tz string) (uuid.UUID, string)` in `httpapi_test.go` — a `plantTenantWithVehicle` that sets the tenant's timezone.

> **No migration.** The default is a SQL expression inside the existing parameterised insert, which is ADR-0013's shape. A column default could not reach `app.current_tenant_id()` usefully, and a SQL function for one `COALESCE` would put a rule where nothing else about this write lives.

- [ ] **Step 1: Add the helper**

In `api/internal/httpapi/httpapi_test.go`, beside `plantTenantWithVehicle`:

```go
// plantTenantInZone is plantTenantWithVehicle for a tenant that is not on the
// runner's clock — the only way to prove a date was computed in the tenant's
// zone rather than coincidentally matching UTC.
func plantTenantInZone(t *testing.T, ctx context.Context, admin *pgx.Conn, label, tz string) (uuid.UUID, string) {
	t.Helper()
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, label)
	_, err := admin.Exec(ctx, `UPDATE app.tenant SET timezone = $2 WHERE id = $1`, tenantID, tz)
	require.NoError(t, err)
	return tenantID, fleet
}
```

- [ ] **Step 2: Write the failing test**

Append to `api/internal/httpapi/admin_test.go`:

```go
// Two tenants 25 hours apart cannot share a civil date at any instant, so this
// holds whatever time CI runs at. An admin working late from another zone must
// not date a South African tenant's assignment a day out (rule 6).
func TestAssignmentDefaultsToTheTenantDay(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	east, _ := plantTenantInZone(t, ctx, admin, "tz-east", "Pacific/Kiritimati") // UTC+14
	west, _ := plantTenantInZone(t, ctx, admin, "tz-west", "Pacific/Midway")     // UTC-11

	landed := func(tenantID uuid.UUID) string {
		actor := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
		driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
		var vehicleID uuid.UUID
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT id FROM app.vehicle WHERE tenant_id = $1 LIMIT 1`, tenantID).Scan(&vehicleID))

		var before string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT app.tenant_today(timezone)::text FROM app.tenant WHERE id = $1`,
			tenantID).Scan(&before))

		rec := post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
			tenantID.String(), actor.String(),
			fmt.Sprintf(`{"userId":%q}`, driver.String()))
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())

		var body struct {
			FromDate string `json:"fromDate"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))

		// Read the tenant's day again after the write, and accept either.
		// A run straddling the tenant's midnight would otherwise flake, and a
		// test that lectures about clock independence must not depend on one.
		var after string
		require.NoError(t, admin.QueryRow(ctx,
			`SELECT app.tenant_today(timezone)::text FROM app.tenant WHERE id = $1`,
			tenantID).Scan(&after))
		require.Contains(t, []string{before, after}, body.FromDate)
		return body.FromDate
	}

	require.NotEqual(t, landed(east), landed(west),
		"two tenants 25 hours apart must never land an omitted date on the same day")

	// An explicit date is still honoured — the default is a default.
	actor := plantUser(t, ctx, admin, east, auth.RoleOrgAdmin)
	driver := plantUser(t, ctx, admin, east, auth.RoleDriver)
	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 LIMIT 1`, east).Scan(&vehicleID))
	rec := post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
		east.String(), actor.String(),
		fmt.Sprintf(`{"userId":%q,"fromDate":"2020-02-29"}`, driver.String()))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "2020-02-29")

	// A malformed date is still a malformed date, not a silent default.
	rec = post(t, h, "/api/vehicles/"+vehicleID.String()+"/drivers",
		east.String(), actor.String(),
		fmt.Sprintf(`{"userId":%q,"fromDate":"29-02-2020"}`, driver.String()))
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `make api-test`

Expected: FAIL — 422 `fromDate is required` on the first request.

- [ ] **Step 4: Make the date optional and default it in SQL**

In `api/internal/httpapi/admin.go`, inside `assignDriver`, replace the required-date guard:

```go
		if strings.TrimSpace(body.FromDate) == "" {
			refuseInvalid(w, r, invalid("fromDate", "is required"))
			return
		}
		from, err := time.Parse(isoDate, strings.TrimSpace(body.FromDate))
		if err != nil {
			refuseInvalid(w, r, invalid("fromDate", "must be a date as YYYY-MM-DD"))
			return
		}
```

with:

```go
		// Absent means "today in the tenant's zone", computed in SQL where
		// that zone lives (rule 6). A browser's calendar day is the admin's,
		// not the tenant's, and the two differ for most of every day.
		// Malformed is still refused — only absence defaults.
		var from *time.Time
		if raw := strings.TrimSpace(body.FromDate); raw != "" {
			parsed, err := time.Parse(isoDate, raw)
			if err != nil {
				refuseInvalid(w, r, invalid("fromDate", "must be a date as YYYY-MM-DD"))
				return
			}
			from = &parsed
		}
```

and replace the insert's `VALUES` clause:

```go
				`INSERT INTO app.vehicle_driver
				   (tenant_id, vehicle_id, user_id, from_date)
				 VALUES (app.current_tenant_id(), $1, $2,
				         COALESCE($3::date,
				                  app.tenant_today((SELECT timezone FROM app.tenant
				                                     WHERE id = app.current_tenant_id()))))
				 RETURNING id, from_date`,
```

The parameter stays `from`; pgx sends a nil `*time.Time` as SQL NULL, which is what `COALESCE` needs.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make api-test`

Expected: PASS, including `TestAssignDriverToVehicle`.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go api/internal/httpapi/httpapi_test.go
git commit -m "feat(api): TYRE-89 default an assignment to the tenant's day"
```

---

## Task 8: The screen stops computing a date

**Files:**
- Modify: `web/src/api/admin.ts`
- Modify: `web/src/admin/AddDriver.tsx`
- Test: `web/src/admin/AddDriver.test.tsx`

**Interfaces:**
- Consumes: the optional `fromDate` from Task 7.
- Produces: `NewAssignment.fromDate?: string`; `today()` is deleted.

- [ ] **Step 1: Write the failing test**

Append to `web/src/admin/AddDriver.test.tsx`:

```tsx
  // The browser's calendar day is the admin's, not the tenant's. Sending none
  // lets the server compute it where the tenant's zone lives (TYRE-89).
  it("sends no date with an assignment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]))
      .mockResolvedValueOnce(
        respond(201, { id: "a1", vehicleId: "v1", userId: "u1", fromDate: "2026-08-28" }),
      );

    renderScreen();
    await fillAndSubmit();
    await screen.findByLabelText(/unit/i);
    await userEvent.selectOptions(screen.getByLabelText(/unit/i), "v1");
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));
    await screen.findByText(/assigned to H99/i);

    const [, init] = vi.mocked(fetch).mock.calls[2];
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("fromDate");
  });
```

> This mirrors the setup of the existing `"records the assignment against the unit chosen"` test, which is the file's create-then-assign driver. `fetch` carries the body as a JSON string in `init.body`, so the assertion parses it — `not.toHaveProperty` on the raw string would pass vacuously.

- [ ] **Step 2: Run the test to verify it fails**

Run: `make web-test`

Expected: FAIL — the body carries `fromDate`.

- [ ] **Step 3: Make the field optional and stop sending one**

In `web/src/api/admin.ts`:

```ts
export interface NewAssignment {
  userId: string;
  // Omitted means the tenant's today, computed server-side where the tenant's
  // timezone lives (rule 6, TYRE-89). A browser-computed day is a day out for
  // any admin not sitting in the tenant's zone.
  fromDate?: string;
}
```

In `web/src/admin/AddDriver.tsx`, delete the `today()` function and its comment entirely, and change the assign mutation:

```tsx
  const assign = useMutation({
    mutationFn: (id: string) => assignDriver(id, { userId: created?.id ?? "" }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `make web-test`

Expected: PASS.

- [ ] **Step 5: Run the whole gate**

Run: `make check`

Expected: PASS — fmt, lint, db tests, api tests, web tests. If `make lint` reports an unused import in `AddDriver.tsx`, remove it; if it reports a comment-style violation, fix the comment rather than silencing the check.

- [ ] **Step 6: Run the browser proof**

Run: `make db-reset`, then `make api-run` in a second terminal with `APP_DEV_TENANT_HEADER=1` in `.env`, then `make e2e`.

Expected: PASS, 21 specs — `admin.spec.ts` still builds a tenant from nothing and reaches a capture. It is not in `make check` deliberately; it needs a live stack.

- [ ] **Step 7: Commit**

```bash
git add web/src/api/admin.ts web/src/admin/AddDriver.tsx web/src/admin/AddDriver.test.tsx
git commit -m "feat(web): TYRE-89 let the server date an assignment"
```

---

## Closing the branch

- [ ] Run `/comment-audit` — a judgment pass over every comment the branch added. Comments explain *why*; a comment that narrates the change is a defect.
- [ ] Run `/verify` — the three-way agreement (database, capture app, dashboard) must still hold: 19 exceptions, 11 urgent, 9 running positions below the removal threshold.
- [ ] Open the PR against `develop`. State in the body that **deactivation was deliberately not built** — TYRE-83's `active = false` half touches TYRE-64's POPIA question, which is with the sponsor. The reactivate path is built because it needs no answer to that question; the deactivate path is not.
- [ ] Note in the PR that `refusalError` was added with one caller, for B5's write surfaces to reuse.

## Out of scope, deliberately

- **Deactivation and delete.** TYRE-64's POPIA question is open. `000018` already revoked `DELETE` from the app role, so nothing here can delete a user in any case.
- **The valuation as-at and analytics day boundaries** in `000006` / `000007`, which still use the UTC date. E1's V4 verification looked at those and left them: what "as at a date" means for money is a separate question from what a screen displays.
- **A tenant timezone editor.** The column exists and defaults to `Africa/Johannesburg`; the surface that edits tenant configuration is TYRE-58's, not this.

---

## Self-Review

**Spec coverage.** TYRE-83's definition of done: the capability with table-driven positive and negative tests (Task 1, Task 2 — a CONTROLLER inviting an ORG_ADMIN gets 403); the reactivate branch tested against an inactive same-email row (Task 3); `make check` green (Task 8, Step 5). TYRE-89's: `/api/me` carries `timezone`, tested (Task 5); no bare `toLocale*` on a `Date` in `web/src` and lint fails if one is added (Task 6, Steps 6–7); a render test for a fixed UTC instant under a tenant zone that is not the runner's (Task 6, Step 1); a Go integration test that an assignment created with no `fromDate` lands on the tenant's date where that differs from UTC (Task 7). All covered.

**Type consistency.** `formatTenantDate(instant, timeZone)` and `useTenantDate()` are named identically in Tasks 6 and 8's imports. `mayCreateRole(a, role)` is defined in Task 2 and unchanged in Task 3. `refusalError{refusal{…}}` is constructed the same way in every use. `plantTenantInZone` is defined in Task 7 Step 1 before its use in Step 2. `userBody` and `errorCode` are defined in Task 3 and reused in Task 7.

**Verified against the code, 31 Aug 2026.** The refusal envelope is flat (`errorBody`, `httpapi.go`) and Task 3's `errorCode` reads it that way. `AddDriver.test.tsx` stubs `fetch` and has no actor provider; Tasks 4 and 8 now extend its `renderScreen` and assert on parsed request bodies. `app.tenant_today` (000015), `tenant.timezone` (000001), the `UPDATE` grant on `app_user` (only `DELETE` revoked, 000002), every Go test helper Task 5 and 7 call, `useCan`, the `ROLES` labels and the `DRIVER` default role all exist as this plan uses them. Where a step and the code still disagree, the code wins and the plan was wrong — report it rather than redesign.
