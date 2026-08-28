# First Admin Write Surface (B4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ORG_ADMIN build a tenant from nothing — add a unit, add a driver, assign the two — through `POST /api/vehicles`, `POST /api/users` and `POST /api/vehicles/{vehicleID}/drivers`, so that driver reaches a capture screen for that unit.

**Architecture:** Three create endpoints and one library read, all in a new `api/internal/httpapi/admin.go`, all inside `withActor` on a tenant-bound transaction, each gated on a capability that already exists. Request shape is validated in Go before any transaction opens; every rule about the rows themselves is already a schema constraint, so no SQL function and no migration is written. `refusalForPgError` gains one narrow translation step so a form can tell "that fleet number is taken" from any other conflict without a constraint name reaching the wire. Then two React screens reach the endpoints through the existing capability-driven navigation.

**Tech Stack:** Go 1.24 (run in `golang:1.24-alpine` under docker for host parity), `chi`, `pgx`/`pgconn`, `testify/require`, table-driven tests. React 19 + TypeScript strict, Tanstack Query, Vitest, Testing Library, Playwright for the e2e gate. No new dependency in either language.

**Spec:** `docs/superpowers/specs/2026-08-28-admin-write-surface-design.md`. Read it first; this plan argues from it and does not restate its reasoning. Sequencing rationale: `docs/implementation-order.md`, batch B4.

**Ticket:** TYRE-81. Task 1 is the ADR the ticket mandates; Tasks 2–5 are the server; Tasks 6–9 are the client; Task 10 is the close-out.

**Branch:** `TYRE-81-admin-write-surface`, cut from `develop` @ `3a3d6c2`.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **Never write `tenant_id` from a request.** Every insert takes it from `app.current_tenant_id()`, which reads the transaction-bound setting. A request-supplied tenant is precisely what the `WITH CHECK` half of `tenant_isolation` exists to refuse (non-negotiable rule 1).
- **Every query goes through `withActor`.** A query on `store.Pool()` has no tenant bound and RLS returns it nothing — which reads as a data bug and is a missing transaction (`api/CLAUDE.md`).
- **Handlers assert capabilities, never role names** (ADR-0011, ADR-0006). `require(a, auth.ManageAssets)` — never `if a.Role == auth.RoleOrgAdmin`.
- **No migration, no change to `db/tests/`, no change to `db/seeds/`.** This batch adds no schema. If you find yourself opening `db/migrations/`, you have gone outside the plan — see the spec's decision 6 for the one rule that was considered and deliberately deferred.
- **No `DELETE` endpoint and no deactivation endpoint.** D10 settled that leaving is `active = false`, but that surface is TYRE-83's and TYRE-64's POPIA question touches it (spec decision 5).
- **No threshold, band or rate anywhere** (project rule 5). The only numeric literals this plan introduces are length caps on free text and a body-size cap, which are transport limits.
- **`strict: true`, and `@typescript-eslint/no-explicit-any` is an error.** Parse unknown JSON as `unknown` and narrow it.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. `scripts/check-comment-style.mjs` runs in the hook, in `make lint` and in CI, and it is blocking. It rejects `previously`, `used to`, `no longer`, `the old/new version`, `instead of the old`, `renamed from`, `moved here from`. Write every comment in the present tense as a statement of the constraint the current code satisfies. `docs/` and `*.md` are exempt; Go, TypeScript and SQL are not.
- **Cite the requirement ID** for any non-obvious rule (`FR-VEH-004`, `DR-003`, `D8`, `D9`, `D10`, `ADR-0012`, `ADR-0013`).
- **Run `make check` before every commit.** Docker must be running; `make db-up` first, because `make check` runs `db-reset`, `db-test` and the Go integration tests, all of which need Postgres on 5433.
- **`make e2e` is not part of `make check`.** Task 10 adds a spec to it. Run it, or say plainly in the PR that it was not run.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| Source | Text |
| --- | --- |
| FR-VEH-002 (SRS v1.4 Part 2) | "The system shall record for each unit: fleet number, registration number, description, unit kind (HORSE / TRAILER / RIGID / LIGHT, v1.4), axle configuration, home depot, status…" |
| FR-VEH-003 (SRS v1.4 Part 2) | "The system shall accept alphanumeric fleet numbers and shall not assume numeric values." |
| FR-VEH-004 (SRS v1.4 Part 2) | "The system shall enforce uniqueness of fleet number within a tenant…" |
| D8 (Decisions of Record, pageId 16089089) | "Add/edit units (horses, trailers, rigids, light vehicles) = `CONTROLLER`, `DEPOT_MANAGER`, `ORG_ADMIN`, gated on the existing `ManageAssets` capability — never on a role name (ADR-0011)." |
| D8 | "`DEPOT_MANAGER` writes are tenant-wide for now: scope views narrow reads only, and write-side depot scoping is deliberately deferred, not overlooked." |
| D9 (same page) | "`ORG_ADMIN` may invite any role; `CONTROLLER` and `DEPOT_MANAGER` may invite `DRIVER` only, via a new finer capability plus a handler rule on `POST /api/users`. They can never create or promote an admin — no privilege-escalation path. `ManageUsers` stays ORG_ADMIN's alone." |
| D10 (same page) | "Login is scoped to the tenant subdomain (`app.tenant.subdomain` is UNIQUE); the tenant is resolved before authentication, so the collision never surfaces." |
| D10 (same page) | "leaving = `active = false`, never a delete (attribution survives via `vehicle_driver`, FR-VEH-008); a rehire invite hitting the `(tenant_id, email)` constraint against an inactive row offers **reactivation** rather than failing" |
| TYRE-81 | "`POST /api/users` and `POST /api/vehicles`, both gated on capabilities that already exist in `auth` (`ManageUsers`, `ManageAssets`) — never on a role name (ADR-0011)." |
| TYRE-81 | "A vehicle is created against an existing `axle_configuration` chosen from the tenant's library. Authoring new configurations is a separate, larger piece — do not fold it in." |
| TYRE-81 | "`enable_tenant_rls` gives the policy both `USING` and `WITH CHECK`; the `WITH CHECK` half is what stops a write landing in another tenant, so a new write path needs a test that proves it, not just a read test." |
| TYRE-81 | Definition of done: "An ORG_ADMIN can add a driver and a vehicle to Sandbox Fleet through the UI, and the driver can then be assigned and reach a capture. A capability the actor lacks returns 403; a write aimed at another tenant fails on `WITH CHECK`, with a test for each. `make check` green." |

## Decisions this plan makes, and why

Settled here so the implementer does not re-litigate them. The spec argues each one; this is the operative summary.

**1. No SQL function per write, and no migration.** Every rule governing these rows is already a schema constraint. A wrapper function that restates the constraint beneath it is a second place for the rule to be wrong (spec decision 1).

**2. A conflict a form must act on gets its own wire code, translated from the constraint name in Go.** `refusalForPgError` gains one map. The constraint name is translated, never forwarded, so ADR-0012's guarantee holds. An unrecognised constraint keeps the generic `conflict` (spec decision 2).

**3. Go-authored refusal messages are renderable; database-authored ones are not, except the `TY` class.** This is the rule that lets an admin form show "fleetNumber is required" verbatim without re-opening TYRE-77. A validation message is written in `admin.go` by us, names no schema object, and is safe on a screen. Record it in ADR-0013; it is the one addition to ADR-0012's vocabulary.

**4. Validation runs before any transaction opens.** A malformed request has no business reaching the database, and opening a transaction to reject one is work a hostile client can ask for freely.

**5. `PLATFORM_ADMIN` is refused explicitly, not left to the constraint** (spec decision 4).

**6. `unitKind` is required by the API and not by the schema.** 12 of the 18 `INSERT INTO app.vehicle` statements in `db/tests/004_tests.sql` omit it, as do both Go integration fixtures; a `NOT VALID` CHECK would be correct and would churn the acceptance suite for a benefit this batch does not need. Recorded in ADR-0013 as an accepted gap owned by TYRE-88 (spec decision 6).

**7. The assignment endpoint is an assumption, not a stated requirement.** TYRE-81's DoD needs it and TYRE-81's scope section does not name it. Tasks 5 and 9 carry it. If the ticket owner rules it out, drop those two tasks; nothing else depends on them.

**8. The assignment endpoint does not check that the assignee is a DRIVER.** No schema constraint says so, and inventing one in Go would violate decision 1. A non-driver assigned to a unit gains nothing they did not already hold — every role that can be assigned already holds `CaptureInspection` — so the gap is inert. Recorded in ADR-0013 rather than fixed here.

**9. New handlers live in `api/internal/httpapi/admin.go`.** `capture.go` set the precedent that a surface gets its own file; `httpapi.go` keeps the router, the shared refusal machinery and the reads that predate this batch.

## File structure

| File | Change | Responsibility after this plan |
| --- | --- | --- |
| `docs/adr/0013-write-surface-contract.md` | create | Where a rule lives on a write, and how a violation becomes a status |
| `docs/adr/0012-api-error-envelope.md` | modify | Its `TY008`/`TY009` deferral, re-pointed off B4 |
| `api/internal/httpapi/admin.go` | create | The four admin endpoints, their request types and their validation |
| `api/internal/httpapi/httpapi.go` | modify | Four routes; `23P01` in `submitStatus`; `conflictCodes`; the new codes; the `23503` and `errorBody` comments |
| `api/internal/httpapi/admin_test.go` | create | Integration tests for all four endpoints, plus the `WITH CHECK` proof — black-box, `package httpapi_test` |
| `api/internal/httpapi/refusal_internal_test.go` | modify | `conflictCodes` translation — white-box, `package httpapi` |
| `web/src/api/client.ts` | modify | Carries the envelope's message onto `ApiError`, not only its code |
| `web/src/api/client.test.ts` | modify | That the envelope's message survives to the error |
| `web/src/api/admin.ts` | create | Wire types and fetchers for the four endpoints |
| `web/src/api/admin.test.ts` | create | Fetcher shape and refusal-code surfacing |
| `web/src/admin/AddUnit.tsx` | create | The add-a-unit screen |
| `web/src/admin/AddUnit.test.tsx` | create | Its states: success, duplicate fleet number, validation refusal |
| `web/src/admin/AddDriver.tsx` | create | The add-a-driver screen and its assign-to-a-unit step |
| `web/src/admin/AddDriver.test.tsx` | create | Its states, including `email_taken` |
| `web/src/admin/admin.css` | create | Form layout for both screens |
| `web/src/shell/navigation.ts` | modify | Two nav items, gated on `ManageAssets` and `ManageUsers` |
| `web/src/shell/navigation.test.ts` | modify | A driver sees neither |
| `web/src/routes.tsx` | modify | Two routes behind their capabilities |
| `web/src/routes.test.tsx` | modify | A driver reaching either route is told, not blanked |
| `web/e2e/admin.ts` | create | The org-admin actor, seed-derived |
| `web/e2e/admin.spec.ts` | create | Build a unit, a driver and an assignment; the driver reaches capture |
| `web/playwright.config.ts` | modify | Keeps the writing spec on one project |
| `docs/implementation-order.md` | modify | B4 recorded as delivered |

---

### Task 1: ADR-0013, the write-surface contract

**Files:**
- Create: `docs/adr/0013-write-surface-contract.md`
- Modify: `docs/adr/0012-api-error-envelope.md` (Step 6 — its `TY008`/`TY009` deferral)
- Read first: `docs/adr/0000-template.md`, `docs/adr/0012-api-error-envelope.md`, `docs/adr/0011-actor-context-and-authorisation.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the ADR number `ADR-0013`, cited by every comment in Tasks 2–5.

The ADR comes first because its scope is wider than this ticket's code: it records the D9/D10 constraints TYRE-83 will implement, and those are cheaper to write down than to unpick from code that assumed otherwise.

- [ ] **Step 1: Scaffold the ADR**

Run `/adr` and title it "The write-surface contract", or copy `docs/adr/0000-template.md` to `docs/adr/0013-write-surface-contract.md` by hand. Status: `Accepted`. Date: 2026-08-28.

- [ ] **Step 2: Write the Context section**

It must state, in the repo's own voice and without narrating this branch:

- `POST /api/inspections` is the only write the platform has, and it is a SQL function because submitting an inspection carries rules of its own. Four more write surfaces are queued (TYRE-72/73/75, TYRE-48, TYRE-58) and each will copy whatever shape settles here.
- The tenancy guarantee on a write is the `WITH CHECK` half of `tenant_isolation`, not the handler.

- [ ] **Step 3: Write the Decision section — seven numbered decisions**

Each is argued in the spec; the ADR states them and gives the reason in one or two sentences.

1. **A write with no rule of its own is a parameterised insert in Go.** A SQL function is written when there is a rule to express — the duplicate window, the odometer ceiling — not to wrap a constraint. Where a rule is missing from the schema it is added to the schema, as B1 did, never implemented in Go.
2. **`tenant_id` on any insert comes from `app.current_tenant_id()`, never from the request.**
3. **A constraint violation a client must branch on gets a stable wire code, translated from the constraint name in one map in `httpapi.go`.** The name is translated, never forwarded; an unrecognised constraint keeps the generic `conflict`. This extends ADR-0012 rather than amending it.
4. **A Go-authored refusal message is renderable; a database-authored one is not, except the `TY` class.** This is the one addition to ADR-0012's vocabulary and the reason an admin form may show a validation message verbatim.
5. **Request validation is shape only, in Go, before any transaction opens.** It never grows into a business rule: no fleet-number pattern (FR-VEH-003), no threshold, no band, no rate.
6. **`PLATFORM_ADMIN` is not creatable through a tenant surface**, refused explicitly rather than left to `platform_admin_has_no_tenant`.
7. **No write surface removes a row.** Leaving is `active = false` (D10) and lives with TYRE-83; `000018` has already revoked `DELETE` from `app_rw`.

Two consequences of decision 3 that must be stated in the ADR rather than left to be discovered:

- **The translation map is shared with the submit path.** `refusalForPgError` serves every endpoint, so a future exclusion constraint reachable from `POST /api/inspections` will surface to the capture outbox as a 409 rather than a 500. That is the outcome we want — ADR-0009's outbox cannot survive a 500 — but it should be a decision and not an accident.
- **These endpoints carry a body-size cap and no rate limit**, unlike `POST /api/inspections`, whose limiter exists because a driver's outbox can retry without a human present (NFR-SEC-007). An admin form has a human in front of it and sits behind `ManageUsers`/`ManageAssets`. Say that it was considered.

- [ ] **Step 4: Write the Constraints on later work section**

These are recorded now and built later. Copy the wording from the spec's "The D9/D10 constraints the ADR must record", covering: D9 tiered invites and the `InviteDriver` capability; the first ORG_ADMIN created by a PLATFORM_ADMIN at provisioning (FR-AUT-009); D10's reactivate-on-rehire branch and why `email_taken` is a specific code rather than a generic conflict; D10's subdomain-scoped login; D8's deliberately deferred write-side depot scoping.

- [ ] **Step 5: Write the Accepted gaps section**

Two, each with an owner:

- **`vehicle.unit_kind` is required by the API and not by the schema.** State the count — 12 of 18 `INSERT INTO app.vehicle` statements in `db/tests/004_tests.sql` omit it — and name TYRE-88 as the owner of the sweep.
- **The assignment endpoint does not check that its assignee is a DRIVER.** No constraint says so; every assignable role already holds `CaptureInspection`, so the gap is inert.

- [ ] **Step 6: Correct ADR-0012's forward reference**

`docs/adr/0012-api-error-envelope.md` defers `TY008`/`TY009` "to B4". Neither is reachable from anything this batch builds: `TY008` fires on an **update** of `vehicle.configuration_id` and this batch has no update endpoint; `TY009` fires on a fitment write, which is out of scope. Edit that paragraph so it defers to "the batch that builds an update or a fitment write" rather than to B4, and say why. Do not delete the deferral.

- [ ] **Step 7: Run the comment and lint gates**

```bash
make lint
```
Expected: PASS. (`docs/` is exempt from the comment-style check, but `make lint` also runs prettier over markdown.)

- [ ] **Step 8: Commit**

```bash
git add docs/adr/0013-write-surface-contract.md docs/adr/0012-api-error-envelope.md
git commit -m "docs: TYRE-81 ADR-0013, the write-surface contract"
```

---

### Task 2: `GET /api/axle-configurations`

**Files:**
- Create: `api/internal/httpapi/admin.go`
- Modify: `api/internal/httpapi/httpapi.go` (one route)
- Create: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Consumes: `withActor`, `require`, `writeJSON` from `httpapi.go`; `auth.ManageAssets`.
- Produces: `listAxleConfigurations(s *store.Store) http.HandlerFunc`; the wire shape `{id, code, name, version, axleCount}`, which Task 6 types and Task 7 renders.

The vehicle form cannot populate a configuration picker without this, and TYRE-81 requires the configuration to be chosen from the tenant's library.

- [ ] **Step 1: Write the failing test**

Add to a new `api/internal/httpapi/admin_test.go`:

```go
package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/httpapi"
)

type axleConfigBody struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// The library a create form picks from. Gated on ManageAssets — the capability
// that can act on the answer — so a driver is refused the list as well as the
// write (FR-AUT-005 is about what may be asked for, not only what comes back).
func TestAxleConfigurationsAreCapabilityGatedAndTenantScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg")
	otherID, _ := plantTenantWithVehicle(t, ctx, admin, "axlecfg-other")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	require.Equal(t, http.StatusForbidden,
		get(t, h, "/api/axle-configurations", tenantID.String(), driver.String()).Code)

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/axle-configurations", tenantID.String(), orgAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var configs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &configs))
	require.Len(t, configs, 1, "the fixture plants exactly one configuration per tenant")
	require.Equal(t, "HTTPTEST", configs[0].Code)
	require.Equal(t, 2, configs[0].AxleCount)

	// The other tenant's configuration is not reachable, and the refusal is
	// emptiness rather than an error: RLS answers the question honestly.
	otherAdmin := plantUser(t, ctx, admin, otherID, auth.RoleOrgAdmin)
	rec = get(t, h, "/api/axle-configurations", otherID.String(), otherAdmin.String())
	require.Equal(t, http.StatusOK, rec.Code)
	var otherConfigs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &otherConfigs))
	require.Len(t, otherConfigs, 1)
	require.NotEqual(t, configs[0].ID, otherConfigs[0].ID)
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
make test-api
```
If no such target exists, run the Go suite the way the Makefile does — check `make -n test` for the exact docker invocation and reuse it verbatim; the host's Go is 1.26 and the project pins 1.24 (`docs/lessons.md`, 2026-08-20).

Expected: FAIL — the route does not exist, so chi's `NotFound` answers 404 and the first `require.Equal` on 403 fails.

- [ ] **Step 3: Create `admin.go` with the handler**

Leave a blank line between the comment and `package httpapi`, or godoc reads it as a second package doc competing with `httpapi.go`'s.

```go
// The admin write surface: users, units and the assignment between them.
// Every handler here follows ADR-0013 — shape validated in Go before a
// transaction opens, the row's own rules left to the constraints that already
// state them, and tenant_id taken from the bound session and never from the
// request.

package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"tyreplatform/api/internal/auth"
	"tyreplatform/api/internal/store"
)

type axleConfigurationJSON struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Name      string `json:"name"`
	Version   int    `json:"version"`
	AxleCount int    `json:"axleCount"`
}

// listAxleConfigurations serves the library a unit is created against
// (FR-CFG-001..007). Gated on ManageAssets rather than ViewFleet: the list is
// only useful to someone who may create a unit with it, and D8 puts that on
// ManageAssets.
//
// Authoring a configuration is not here and must not arrive here. D8 reserves
// it for ManageTemplates, ORG_ADMIN alone (TYRE-84), because a wrong template
// silently corrupts every position on every unit that uses it.
func listAxleConfigurations(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		// Initialised, not nil: writeJSON encodes what it is handed, and a
		// nil slice reaches the client as JSON `null` rather than `[]`.
		configs := []axleConfigurationJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT id, code, name, version, axle_count
				   FROM app.axle_configuration
				  WHERE active
				  ORDER BY code, version`)
			if err != nil {
				return fmt.Errorf("listing axle configurations: %w", err)
			}
			defer rows.Close()
			for rows.Next() {
				var c axleConfigurationJSON
				var id uuid.UUID
				if err := rows.Scan(&id, &c.Code, &c.Name, &c.Version, &c.AxleCount); err != nil {
					return fmt.Errorf("scanning axle configuration: %w", err)
				}
				c.ID = id.String()
				configs = append(configs, c)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, configs)
	}
}
```

Note: the import block above is the one the whole file ends with, after Tasks 3–5. Go's linters will reject unused imports now — add only what this task's code uses (`fmt`, `net/http`, `github.com/google/uuid`, `github.com/jackc/pgx/v5`, `tyreplatform/api/internal/auth`, `tyreplatform/api/internal/store`) and let each later task add its own.

- [ ] **Step 4: Register the route**

In `api/internal/httpapi/httpapi.go`, inside `r.Route("/api", ...)`, after `r.Get("/org/branding", orgBranding(s))`:

```go
		r.Get("/axle-configurations", listAxleConfigurations(s))
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
make check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go api/internal/httpapi/httpapi.go
git commit -m "feat(api): TYRE-81 serve the tenant's axle configuration library"
```

---

### Task 3: `POST /api/vehicles`

**Files:**
- Modify: `api/internal/httpapi/admin.go`
- Modify: `api/internal/httpapi/httpapi.go` (one route, the new codes, `conflictCodes`, the `23503` and `errorBody` comments)
- Modify: `api/internal/httpapi/admin_test.go`
- Modify: `api/internal/httpapi/refusal_internal_test.go`

**Interfaces:**
- Consumes: `writeError`, `codeInvalidSubmission`, `codeBadRequest`, `codeMalformedJSON`, `refusalForPgError` from `httpapi.go`; `vehicleJSON` from `httpapi.go`.
- Produces: `createVehicle(s *store.Store) http.HandlerFunc`; `decodeJSON(w, r, into) bool`; `refuseInvalid(w, r, err) bool`; `text(field string, in *string) (*string, error)`; `errInvalidRequest`; `invalid(field, why string) error`; `maxCreateBytes`, `maxTextLen`; `conflictCodes` and `conflictMessages`; the wire codes `fleet_number_taken`, `email_taken`, `assignment_overlaps`. Tasks 4 and 5 consume every one of these.

- [ ] **Step 1: Write the failing test for the refusal translation (white-box)**

Add to `api/internal/httpapi/refusal_internal_test.go`. Note the existing file's import alias — `httpapi.go` defines a package-level `require(a, c)` capability helper, so an unaliased `testify/require` in a `package httpapi` file will not build (`docs/lessons.md`, 2026-08-28):

```go
// A conflict a form must act on differently from any other conflict carries
// its own code. The constraint name is translated here and never forwarded,
// so ADR-0012's guarantee that no schema object reaches the wire is unchanged
// (ADR-0013).
func TestConflictConstraintsTranslateToTheirOwnCode(t *testing.T) {
	tests := []struct {
		name       string
		sqlstate   string
		constraint string
		wantCode   string
		wantStatus int
	}{
		{"duplicate fleet number", "23505", "vehicle_tenant_id_fleet_number_key", "fleet_number_taken", http.StatusConflict},
		{"duplicate email", "23505", "app_user_tenant_id_email_key", "email_taken", http.StatusConflict},
		{"overlapping assignment", "23P01", "vehicle_driver_no_overlap", "assignment_overlaps", http.StatusConflict},
		{"an unmapped unique constraint", "23505", "some_other_key", "conflict", http.StatusConflict},
		{"an unmapped exclusion constraint", "23P01", "some_other_excl", "conflict", http.StatusConflict},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, isClient := refusalForPgError(&pgconn.PgError{
				Code:           tt.sqlstate,
				ConstraintName: tt.constraint,
				Message:        "duplicate key value violates unique constraint \"" + tt.constraint + "\"",
			})
			req.True(t, isClient)
			req.Equal(t, tt.wantStatus, ref.status)
			req.Equal(t, tt.wantCode, ref.code)
			req.NotContains(t, ref.message, tt.constraint,
				"a constraint name reached the wire")
		})
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run the Go suite. Expected: FAIL — `23P01` is not in `submitStatus`, so `isClient` is false for the exclusion cases, and the unique cases return `conflict` rather than the specific codes.

- [ ] **Step 3: Add the codes, the map and the `23P01` entry**

In `api/internal/httpapi/httpapi.go`, add to the code constants:

```go
	codeFleetNumberTaken   = "fleet_number_taken"
	codeEmailTaken         = "email_taken"
	codeAssignmentOverlaps = "assignment_overlaps"
```

Add to the message constants:

```go
	msgFleetNumberTaken   = "a unit with that fleet number already exists"
	msgEmailTaken         = "a user with that email address already exists in this tenant"
	msgAssignmentOverlaps = "that driver already holds an overlapping assignment to this unit"
```

Both snippets go **inside** the existing `const (…)` blocks, so neither carries its own closing paren.

Add `23P01` to `submitStatus`, beside `23505`, with its reason:

```go
	// 23P01 is vehicle_driver_no_overlap (000026). Unmapped it would answer
	// 500, which for a form is a spinner that never resolves and for the
	// capture outbox is a retry that never stops (ADR-0009).
	"23P01": http.StatusConflict,
```

Add the translation map immediately above `refusalForPgError`:

```go
// The conflicts a client acts on differently from any other conflict, keyed by
// the constraint that detects them (ADR-0013). The rule is the constraint's —
// DR-003 for a fleet number, D10 for an email, B1's exclusion for an
// assignment — and this map only names the refusal for a caller. The name is
// translated, never forwarded, so ADR-0012 holds; an unrecognised constraint
// keeps the generic conflict, which is the safe direction.
//
// A constraint renamed in a migration without an edit here fails the
// integration test that asserts the code, not one that asserts the name.
var conflictCodes = map[string]string{
	"vehicle_tenant_id_fleet_number_key": codeFleetNumberTaken,
	"app_user_tenant_id_email_key":       codeEmailTaken,
	"vehicle_driver_no_overlap":          codeAssignmentOverlaps,
}

var conflictMessages = map[string]string{
	codeFleetNumberTaken:   msgFleetNumberTaken,
	codeEmailTaken:         msgEmailTaken,
	codeAssignmentOverlaps: msgAssignmentOverlaps,
}
```

Replace the `23505` case in `refusalForPgError` with:

```go
	case pgErr.Code == "23505" || pgErr.Code == "23P01":
		if code, found := conflictCodes[pgErr.ConstraintName]; found {
			return refusal{status: status, code: code, message: conflictMessages[code]}, true
		}
		return refusal{status: status, code: codeConflict, message: msgConflict}, true
```

- [ ] **Step 4: Rewrite the `23503` comment whose premise this batch ends**

`httpapi.go`'s comment block above `submitStatus` ends with a **two-sentence** paragraph. Both sentences die in this task, and replacing only the first leaves the second prescribing the approach ADR-0013 rejects. The paragraph to replace, in full:

```go
// A blanket 23503 is safe here only because app.submit_inspection is the
// single write path. If that stops being true, raise a named TYxxx in SQL
// rather than widening this.
```

Replace it with:

```go
// A blanket 23503 is safe across every write path because the message is
// canned (ADR-0012): a foreign-key violation means the request named
// something that does not exist, and 422 with no schema object in it is the
// honest answer wherever it is raised. A refusal a client must branch on
// earns a code of its own instead — raised as a TY in SQL where a rule is
// being evaluated, or translated from the constraint that detects it where
// the schema already states the rule (ADR-0013).
```

Leave the rest of the block alone: the paragraph above it, explaining why the integrity classes are a backstop rather than a second vocabulary, is still true.

- [ ] **Step 5: Rewrite `errorBody`'s doc comment, which ADR-0013 also makes false**

At the foot of `httpapi.go`, `errorBody` carries: *"Message is diagnostic-grade and is never the source of a driver's sentence — the wording a driver reads is the client's, keyed on Code."* ADR-0013 decision 4 makes a Go-authored message renderable, and Tasks 7 and 8 render one. One rationale in two places, disagreeing, is exactly what the comment standard forbids. Replace that sentence with:

```go
// Message's audience depends on who wrote it (ADR-0013): a message written in
// Go or raised as a TY in SQL is ours and may be rendered, and a message
// Postgres wrote is canned before it ever reaches this struct. A driver's
// sentence is still the client's, keyed on Code — that is FR-OFF-013's
// recovery action and not a diagnostic.
```

- [ ] **Step 6: Run the white-box test to verify it passes**

Run the Go suite. Expected: PASS for `TestConflictConstraintsTranslateToTheirOwnCode`.

- [ ] **Step 7: Write the failing integration test for the endpoint**

Add to `api/internal/httpapi/admin_test.go`:

```go
type createdVehicleBody struct {
	ID           string  `json:"id"`
	FleetNumber  string  `json:"fleetNumber"`
	Registration *string `json:"registration"`
}

type refusalBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func TestCreateVehicle(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenantWithVehicle(t, ctx, admin, "createveh")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	var configID string
	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	rec := get(t, h, "/api/axle-configurations", tenantID.String(), orgAdmin.String())
	var configs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &configs))
	require.NotEmpty(t, configs)
	configID = configs[0].ID

	body := func(fleet string) string {
		return `{"fleetNumber":"` + fleet + `","registration":"CA123456",` +
			`"configurationId":"` + configID + `","unitKind":"HORSE"}`
	}

	// D8: the gate is ManageAssets, and a DRIVER does not hold it.
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	rec = post(t, h, "/api/vehicles", tenantID.String(), driver.String(), body("REFUSED-1"))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	// The create itself, answering 201 with the list projection.
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), body("NEW-1"))
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created createdVehicleBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, "NEW-1", created.FleetNumber)
	require.NotEmpty(t, created.ID)

	// DR-013: created_by is stamped from the bound actor, without the handler
	// naming it — app.current_actor_id() is the column's default.
	var createdBy string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT created_by FROM app.vehicle WHERE id = $1`, created.ID).Scan(&createdBy))
	require.Equal(t, orgAdmin.String(), createdBy)

	// FR-VEH-004 / DR-003, and the code a form branches on (ADR-0013).
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), body("NEW-1"))
	require.Equal(t, http.StatusConflict, rec.Code)
	var refusal refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &refusal))
	require.Equal(t, "fleet_number_taken", refusal.Code)
	require.NotContains(t, rec.Body.String(), "vehicle_tenant_id_fleet_number_key")

	// Shape refusals, each 422 and each naming its field.
	for _, tt := range []struct{ name, payload, field string }{
		{"no fleet number", `{"fleetNumber":"  ","configurationId":"` + configID + `","unitKind":"HORSE"}`, "fleetNumber"},
		{"no unit kind", `{"fleetNumber":"X1","configurationId":"` + configID + `"}`, "unitKind"},
		{"unknown unit kind", `{"fleetNumber":"X2","configurationId":"` + configID + `","unitKind":"SPACESHIP"}`, "unitKind"},
		{"unparseable configuration", `{"fleetNumber":"X3","configurationId":"not-a-uuid","unitKind":"HORSE"}`, "configurationId"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Equal(t, "invalid_submission", ref.Code)
			require.Contains(t, ref.message(), tt.field)
		})
	}

	// A configuration that exists in another tenant is not a reference this
	// tenant can make: the composite FK (tenant_id, configuration_id) checks
	// below RLS, so the refusal is a foreign-key violation and not a leak of
	// whether that id exists (000004, TYRE-29 class).
	otherID, _ := plantTenantWithVehicle(t, ctx, admin, "createveh-other")
	otherAdmin := plantUser(t, ctx, admin, otherID, auth.RoleOrgAdmin)
	rec = get(t, h, "/api/axle-configurations", otherID.String(), otherAdmin.String())
	var otherConfigs []axleConfigBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &otherConfigs))
	rec = post(t, h, "/api/vehicles", tenantID.String(), orgAdmin.String(),
		`{"fleetNumber":"CROSS-1","configurationId":"`+otherConfigs[0].ID+`","unitKind":"HORSE"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())

	// The row carries the actor's tenant. This proves the handler binds it
	// from the session — it does NOT prove the policy would refuse one that
	// did not, because the handler never sends a tenant to be refused. That
	// is Step 14's job, and this assertion must not be described as doing it.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.vehicle WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}

func (r refusalBody) message() string { return r.Message }
```

Delete the `message()` helper and call `ref.Message` directly if you prefer — it exists only so the table above reads in one line.

- [ ] **Step 8: Run it to verify it fails**

Expected: FAIL — no route, so every case gets 404.

- [ ] **Step 9: Add the shared decode and validation helpers to `admin.go`**

```go
// maxCreateBytes caps an admin create body. It is a transport limit, not a
// policy one: the largest of these requests is a handful of short strings.
const maxCreateBytes = 16 << 10

// maxTextLen caps every free-text field on a create. A transport limit for the
// same reason — the columns are unbounded text, and the database is not the
// place to discover that a client sent a megabyte of description.
const maxTextLen = 200

// errInvalidRequest is a request that is malformed as a request: a missing
// field, an unparseable id, a value outside an enum. It is answered 422 with
// the message forwarded, which is safe because the message is ours — written
// here, naming no schema object (ADR-0013). A message Postgres wrote is
// canned, and that distinction is the whole of ADR-0012.
var errInvalidRequest = errors.New("invalid request")

func invalid(field, why string) error {
	return fmt.Errorf("%w: %s %s", errInvalidRequest, field, why)
}

// decodeJSON answers the refusal itself when a body cannot be read. Validation
// runs before any transaction opens (ADR-0013): a malformed request has no
// business reaching the database, and opening a transaction to reject one is
// work a caller can ask for freely.
func decodeJSON(w http.ResponseWriter, r *http.Request, into any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCreateBytes))
	if err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeBadRequest, "body too large or unreadable")
		return false
	}
	if err := json.Unmarshal(raw, into); err != nil {
		writeError(r.Context(), w, http.StatusBadRequest, codeMalformedJSON, "malformed json")
		return false
	}
	return true
}

// refuseInvalid answers a validation failure and reports whether it did, so a
// handler reads as a straight line of guard clauses.
func refuseInvalid(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	writeError(r.Context(), w, http.StatusUnprocessableEntity, codeInvalidSubmission, err.Error())
	return true
}

// text trims and length-checks an optional free-text field, answering nil for
// an absent or blank one so the column holds NULL rather than an empty string.
func text(field string, in *string) (*string, error) {
	if in == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*in)
	if trimmed == "" {
		return nil, nil
	}
	if len(trimmed) > maxTextLen {
		return nil, invalid(field, "is too long")
	}
	return &trimmed, nil
}
```

- [ ] **Step 10: Add the request type, its validation and the handler**

```go
type createVehicleRequest struct {
	FleetNumber     string  `json:"fleetNumber"`
	Registration    *string `json:"registration"`
	Description     *string `json:"description"`
	ConfigurationID string  `json:"configurationId"`
	UnitKind        string  `json:"unitKind"`
	HomeDepotID     *string `json:"homeDepotId"`
}

type vehicleInsert struct {
	fleetNumber     string
	registration    *string
	description     *string
	configurationID uuid.UUID
	unitKind        string
	homeDepotID     *uuid.UUID
}

// unitKinds mirrors app.unit_kind. The database is the authority (ADR-0011);
// this list exists so an unknown kind is refused as a malformed request rather
// than reaching the enum cast as a Postgres error a client cannot read.
var unitKinds = map[string]bool{"HORSE": true, "TRAILER": true, "RIGID": true, "LIGHT": true}

// FR-VEH-002 requires a unit's kind to be recorded, and 000025's TY009 trigger
// passes a NULL kind — so a unit created without one is a unit whose
// fitment-odometer rule silently cannot fire. The schema still permits NULL
// for the rows 000011's backfill could not derive; requiring it here stops the
// set growing through the product (ADR-0013's accepted gap, owned by TYRE-88).
func (b createVehicleRequest) validate() (vehicleInsert, error) {
	var v vehicleInsert

	// FR-VEH-003: alphanumeric fleet numbers, with no numeric assumption. The
	// only check is that there is one — a pattern here would reject real data.
	v.fleetNumber = strings.TrimSpace(b.FleetNumber)
	if v.fleetNumber == "" {
		return v, invalid("fleetNumber", "is required")
	}
	if len(v.fleetNumber) > maxTextLen {
		return v, invalid("fleetNumber", "is too long")
	}

	if b.UnitKind == "" {
		return v, invalid("unitKind", "is required")
	}
	if !unitKinds[b.UnitKind] {
		return v, invalid("unitKind", "must be one of HORSE, TRAILER, RIGID, LIGHT")
	}
	v.unitKind = b.UnitKind

	id, err := uuid.Parse(b.ConfigurationID)
	if err != nil {
		return v, invalid("configurationId", "must be a uuid")
	}
	v.configurationID = id

	if b.HomeDepotID != nil && strings.TrimSpace(*b.HomeDepotID) != "" {
		depot, err := uuid.Parse(*b.HomeDepotID)
		if err != nil {
			return v, invalid("homeDepotId", "must be a uuid")
		}
		v.homeDepotID = &depot
	}

	if v.registration, err = text("registration", b.Registration); err != nil {
		return v, err
	}
	if v.description, err = text("description", b.Description); err != nil {
		return v, err
	}
	return v, nil
}

// createVehicle is D8's add-a-unit, gated on ManageAssets and never on a role
// name. A DEPOT_MANAGER holding it writes tenant-wide: the scope views narrow
// reads, and write-side depot scoping is deferred deliberately (D8).
func createVehicle(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body createVehicleRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		ins, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var created vehicleJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssets); err != nil {
				return err
			}
			var id uuid.UUID
			// tenant_id comes from the bound session, never from the request:
			// the WITH CHECK half of tenant_isolation is the guarantee, and a
			// request-supplied tenant is the thing it exists to refuse
			// (non-negotiable rule 1). created_by needs no mention — it
			// defaults to app.current_actor_id() (DR-013, 000017).
			err := tx.QueryRow(ctx,
				`INSERT INTO app.vehicle
				   (tenant_id, fleet_number, registration, description,
				    configuration_id, unit_kind, home_depot_id)
				 VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5::app.unit_kind, $6)
				 RETURNING id, fleet_number, registration`,
				ins.fleetNumber, ins.registration, ins.description,
				ins.configurationID, ins.unitKind, ins.homeDepotID).
				Scan(&id, &created.FleetNumber, &created.Registration)
			if err != nil {
				return fmt.Errorf("creating vehicle: %w", err)
			}
			created.ID = id.String()
			return nil
		})
		if !ok {
			return
		}
		// Content-Type before WriteHeader: WriteHeader locks the header map
		// in, so writeJSON's own Set would be dropped and the response would
		// go out as text/plain with the status assertion still green.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}
```

- [ ] **Step 11: Teach `withActor` about a validation error raised inside the transaction**

Not needed — `refuseInvalid` answers before `withActor` is reached. Confirm by reading `withActor`'s switch: it has no `errInvalidRequest` case and must not gain one, or the same refusal would have two shapes.

- [ ] **Step 12: Register the route**

```go
		r.Post("/vehicles", createVehicle(s))
```

Place it directly after `r.Get("/vehicles", listVehicles(s))`, so the two halves of the same resource read together.

- [ ] **Step 13: Run the suite to verify it passes**

```bash
make check
```
Expected: PASS. If `TestCreateVehicle`'s conflict case reports `conflict` rather than `fleet_number_taken`, the constraint is not named `vehicle_tenant_id_fleet_number_key` on this database — read the real name and fix the map, do not weaken the assertion:

```bash
docker compose exec db psql -U postgres -c "\d app.vehicle"
```

- [ ] **Step 14: Prove the `WITH CHECK` half, with a test that can fail**

TYRE-81 asks for this by name: "a write aimed at another tenant fails on `WITH CHECK`, with a test for each." No handler can produce that write — every one of them binds `tenant_id` from the session — so a test driven through the API cannot reach the policy at all. The test has to issue the insert itself, naming the other tenant.

It goes in `admin_test.go`, calling `s.InActorTx` directly rather than through a handler. That keeps it beside the helpers it needs — `testStore` and `plantUser` are `package httpapi_test`'s, and `store_test.go` is a different package with a different harness. It needs two imports that file does not yet carry: `github.com/jackc/pgx/v5` and `github.com/jackc/pgx/v5/pgconn`.

```go
// The WITH CHECK half of tenant_isolation, which no test driven through a
// handler can reach: every handler binds tenant_id from the session, so none
// of them can produce the row this refuses. USING hides another tenant's
// rows; WITH CHECK refuses a row aimed AT one, and only an insert that names
// the other tenant exercises it.
func TestWriteAimedAtAnotherTenantIsRefused(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenantWithVehicle(t, ctx, admin, "withcheck-a")
	tenantB, _ := plantTenantWithVehicle(t, ctx, admin, "withcheck-b")

	// Tenant B's own configuration, so the row is valid in every way except
	// the one under test. Borrowing tenant A's would fail the composite FK
	// even with the policy gone, and a test that cannot distinguish the two
	// refusals proves neither.
	var configB uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.axle_configuration WHERE tenant_id = $1`, tenantB).Scan(&configB))

	userA := plantUser(t, ctx, admin, tenantA, auth.RoleOrgAdmin)
	err := s.InActorTx(ctx, tenantA, userA, func(tx pgx.Tx, _ auth.Actor) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, unit_kind)
			 VALUES ($1, 'SMUGGLED', $2, 'HORSE')`,
			tenantB, configB)
		return err
	})
	require.Error(t, err, "a row aimed at another tenant was accepted")

	var pgErr *pgconn.PgError
	require.ErrorAs(t, err, &pgErr)
	// 42501 is insufficient_privilege, which is how a row-level security
	// policy refuses a write it will not admit.
	require.Equal(t, "42501", pgErr.Code)

	var landed int
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT count(*) FROM app.vehicle WHERE fleet_number = 'SMUGGLED'`).Scan(&landed))
	require.Zero(t, landed)
}
```

**Prove the test can fail before trusting it** (`docs/lessons.md`, 2026-08-20). Against a scratch database only, never one you will keep — and note **which** kill is the right one:

```bash
docker compose exec db psql -U postgres -d tyre -c \
  "ALTER TABLE app.vehicle DISABLE ROW LEVEL SECURITY;"
```

Re-run the test. Expected: **FAIL at `require.Error`** — with RLS off the insert succeeds, because the row is valid apart from the tenant it names. Then `make db-reset` and re-run: PASS.

Do **not** kill it with `DROP POLICY tenant_isolation ON app.vehicle`. Row-level security stays enabled, a table with RLS on and no policy is default-deny, and the insert is still refused with 42501 — the test stays green and the procedure meant to prove it has teeth proves the opposite. `DISABLE ROW LEVEL SECURITY` is the kill; the policy's own absence is not.

- [ ] **Step 15: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go \
        api/internal/httpapi/httpapi.go api/internal/httpapi/refusal_internal_test.go
git commit -m "feat(api): TYRE-81 create a unit against the tenant's configuration library"
```

---

### Task 4: `POST /api/users`

**Files:**
- Modify: `api/internal/httpapi/admin.go`
- Modify: `api/internal/httpapi/httpapi.go` (one route)
- Modify: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Consumes: `decodeJSON`, `invalid`, `refuseInvalid`, `text` from Task 3.
- Produces: `createUser(s *store.Store) http.HandlerFunc`; `userJSON` with fields `{id, email, displayName, role, staffNumber, active}`, which Task 6 types and Task 8 renders; `tenantRoles`, the one place TYRE-83 narrows.

- [ ] **Step 1: Write the failing test**

Add `"github.com/google/uuid"` to `admin_test.go`'s imports first — this is the first test in the file to call `uuid.NewString()`, and Task 2's import list does not carry it.

Add to `api/internal/httpapi/admin_test.go`:

```go
type createdUserBody struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	StaffNumber *string `json:"staffNumber"`
	Active      bool    `json:"active"`
}

func TestCreateUser(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "createuser")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	email := "new-driver-" + uuid.NewString()[:8] + "@example.invalid"
	body := `{"email":"` + email + `","displayName":"New Driver",` +
		`"staffNumber":"SBX-9001","role":"DRIVER"}`

	// ManageUsers is ORG_ADMIN's alone today (D9 keeps it so). A CONTROLLER
	// holds ManageAssets and not this.
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)
	rec := post(t, h, "/api/users", tenantID.String(), controller.String(), body)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())

	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created createdUserBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, email, created.Email)
	require.Equal(t, "DRIVER", created.Role)
	require.True(t, created.Active, "a created user is active; leaving is active=false and is TYRE-83's")

	// D10: the rehire branch TYRE-83 builds needs to know which conflict it
	// hit, which is why this is not a generic conflict.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusConflict, rec.Code)
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "email_taken", ref.Code)
	require.NotContains(t, rec.Body.String(), "app_user_tenant_id_email_key")

	// ADR-0011: platform staff are never the subject of a tenant-scoped
	// request any more than they are its actor. Refused as an invalid role,
	// not left to platform_admin_has_no_tenant to catch.
	rec = post(t, h, "/api/users", tenantID.String(), orgAdmin.String(),
		`{"email":"pa-`+uuid.NewString()[:8]+`@example.invalid","displayName":"No","role":"PLATFORM_ADMIN"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "invalid_submission", ref.Code)
	require.Contains(t, ref.Message, "role")

	for _, tt := range []struct{ name, payload, field string }{
		{"no email", `{"displayName":"X","role":"DRIVER"}`, "email"},
		{"no display name", `{"email":"a@example.invalid","role":"DRIVER"}`, "displayName"},
		{"unknown role", `{"email":"b@example.invalid","displayName":"X","role":"WIZARD"}`, "role"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, "/api/users", tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Contains(t, ref.Message, tt.field)
		})
	}

	// The row carries the actor's tenant, which proves the handler binds it
	// from the session. The policy's refusal of a row aimed elsewhere is a
	// different property and is proven by TestWriteAimedAtAnotherTenantIsRefused
	// (Task 3, Step 14), which issues the insert a handler cannot.
	var landedTenant string
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT tenant_id FROM app.app_user WHERE id = $1`, created.ID).Scan(&landedTenant))
	require.Equal(t, tenantID.String(), landedTenant)
}
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — 404 on every case.

- [ ] **Step 3: Add the request type, validation and handler to `admin.go`**

```go
type createUserRequest struct {
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	StaffNumber *string `json:"staffNumber"`
	Role        string  `json:"role"`
}

type userInsert struct {
	email       string
	displayName string
	staffNumber *string
	role        string
}

// tenantRoles is app.user_role minus PLATFORM_ADMIN. Platform staff carry a
// NULL tenant_id and are never the subject of a tenant-scoped request any more
// than they are its actor (ADR-0011); platform_admin_has_no_tenant would
// refuse the row anyway, and a refusal that depends on a constraint firing is
// an accident that happens to be safe rather than a decision.
//
// D9 narrows this per actor: CONTROLLER and DEPOT_MANAGER may create DRIVER
// alone, through a finer capability. That narrowing is an edit to this map's
// use in createUser and to nothing else (TYRE-83).
var tenantRoles = map[string]bool{
	"DRIVER": true, "TECHNICIAN": true, "CONTROLLER": true,
	"DEPOT_MANAGER": true, "ORG_ADMIN": true,
}

func (b createUserRequest) validate() (userInsert, error) {
	var u userInsert

	u.email = strings.TrimSpace(b.Email)
	if u.email == "" {
		return u, invalid("email", "is required")
	}
	if len(u.email) > maxTextLen {
		return u, invalid("email", "is too long")
	}

	u.displayName = strings.TrimSpace(b.DisplayName)
	if u.displayName == "" {
		return u, invalid("displayName", "is required")
	}
	if len(u.displayName) > maxTextLen {
		return u, invalid("displayName", "is too long")
	}

	if b.Role == "" {
		return u, invalid("role", "is required")
	}
	if !tenantRoles[b.Role] {
		return u, invalid("role", "is not a role this tenant may create")
	}
	u.role = b.Role

	// FR-AUT-022: a durable identifier independent of the display name, and
	// optional — R13 identifies its driver as "Melusi" and nothing else.
	var err error
	if u.staffNumber, err = text("staffNumber", b.StaffNumber); err != nil {
		return u, err
	}
	return u, nil
}

// createUser is FR-AUT-010's invite, gated on ManageUsers. It creates an
// active user and nothing else: leaving a company is active = false and never
// a delete (D10, FR-VEH-008), and that surface is TYRE-83's.
func createUser(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body createUserRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		ins, err := body.validate()
		if refuseInvalid(w, r, err) {
			return
		}

		var created userJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageUsers); err != nil {
				return err
			}
			var id uuid.UUID
			err := tx.QueryRow(ctx,
				`INSERT INTO app.app_user
				   (tenant_id, email, display_name, staff_number, role)
				 VALUES (app.current_tenant_id(), $1, $2, $3, $4::app.user_role)
				 RETURNING id, email, display_name, role::text, staff_number, active`,
				ins.email, ins.displayName, ins.staffNumber, ins.role).
				Scan(&id, &created.Email, &created.DisplayName, &created.Role,
					&created.StaffNumber, &created.Active)
			if err != nil {
				return fmt.Errorf("creating user: %w", err)
			}
			created.ID = id.String()
			return nil
		})
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}
```

Add the projection type beside it:

```go
type userJSON struct {
	ID          string  `json:"id"`
	Email       string  `json:"email"`
	DisplayName string  `json:"displayName"`
	Role        string  `json:"role"`
	StaffNumber *string `json:"staffNumber"`
	Active      bool    `json:"active"`
}
```

`role` is cast to text in the RETURNING clause for the same reason `store.go` casts it: the enum's OID is not in pgx's type map.

- [ ] **Step 4: Register the route**

```go
		r.Post("/users", createUser(s))
```

- [ ] **Step 5: Run the suite to verify it passes**

```bash
make check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go api/internal/httpapi/httpapi.go
git commit -m "feat(api): TYRE-81 create a tenant user, never a platform admin"
```

---

### Task 5: `POST /api/vehicles/{vehicleID}/drivers`

> **This task carries the plan's one assumption** (spec, "The one gap in the ticket"). TYRE-81's DoD requires a created driver to reach a capture, which needs an `app.vehicle_driver` row; TYRE-81's scope section does not name the endpoint. If the ticket owner rules it out, drop this task and Task 9's assign panel.

**Files:**
- Modify: `api/internal/httpapi/admin.go`
- Modify: `api/internal/httpapi/httpapi.go` (one route)
- Modify: `api/internal/httpapi/admin_test.go`

**Interfaces:**
- Consumes: `decodeJSON`, `invalid`, `refuseInvalid` from Task 3; `codeAssignmentOverlaps` from Task 3.
- Produces: `assignDriver(s *store.Store) http.HandlerFunc`; the wire shape `{id, vehicleId, userId, fromDate}`, which Task 6 types and Task 8 uses.

- [ ] **Step 1: Write the failing test**

```go
type assignmentBody struct {
	ID        string `json:"id"`
	VehicleID string `json:"vehicleId"`
	UserID    string `json:"userId"`
	FromDate  string `json:"fromDate"`
}

func TestAssignDriverToVehicle(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, vehicleID, _ := plantCaptureFixture(t, ctx, admin, "assign")
	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	orgAdmin := plantUser(t, ctx, admin, tenantID, auth.RoleOrgAdmin)
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	path := "/api/vehicles/" + vehicleID.String() + "/drivers"
	body := `{"userId":"` + driver.String() + `","fromDate":"2026-01-01"}`

	// The gate is ManageAssignments. A TECHNICIAN holds ViewFleet and no more.
	tech := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	require.Equal(t, http.StatusForbidden,
		post(t, h, path, tenantID.String(), tech.String(), body).Code)

	rec := post(t, h, path, tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var created assignmentBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &created))
	require.Equal(t, driver.String(), created.UserID)

	// The point of the endpoint: the assignment is what makes the unit
	// reachable, so the driver can now read it (FR-AUT-005,
	// app.v_capture_vehicle).
	require.Equal(t, http.StatusOK,
		get(t, h, "/api/capture/vehicles/"+vehicleID.String(), tenantID.String(), driver.String()).Code)

	// B1's vehicle_driver_no_overlap (000026), reachable for the first time
	// through an endpoint. Unmapped, 23P01 would answer 500.
	rec = post(t, h, path, tenantID.String(), orgAdmin.String(), body)
	require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
	var ref refusalBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
	require.Equal(t, "assignment_overlaps", ref.Code)
	require.NotContains(t, rec.Body.String(), "vehicle_driver_no_overlap")

	for _, tt := range []struct{ name, path, payload, field string }{
		{"unparseable vehicle", "/api/vehicles/not-a-uuid/drivers", body, "vehicleId"},
		{"unparseable user", path, `{"userId":"nope","fromDate":"2026-01-01"}`, "userId"},
		{"no from date", path, `{"userId":"` + driver.String() + `"}`, "fromDate"},
		{"unparseable from date", path, `{"userId":"` + driver.String() + `","fromDate":"01/01/2026"}`, "fromDate"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := post(t, h, tt.path, tenantID.String(), orgAdmin.String(), tt.payload)
			require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
			var ref refusalBody
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &ref))
			require.Contains(t, ref.Message, tt.field)
		})
	}

	// A user in another tenant is not assignable here, and the composite FK
	// (tenant_id, user_id) is what refuses it below RLS (000004).
	otherID, _ := plantTenant(t, ctx, admin, "assign-other")
	stranger := plantUser(t, ctx, admin, otherID, auth.RoleDriver)
	rec = post(t, h, path, tenantID.String(), orgAdmin.String(),
		`{"userId":"`+stranger.String()+`","fromDate":"2026-01-01"}`)
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
}
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — 404.

- [ ] **Step 3: Add the handler to `admin.go`**

```go
type assignDriverRequest struct {
	UserID   string `json:"userId"`
	FromDate string `json:"fromDate"`
}

type assignmentJSON struct {
	ID        string `json:"id"`
	VehicleID string `json:"vehicleId"`
	UserID    string `json:"userId"`
	FromDate  string `json:"fromDate"`
}

// isoDate is the only date format the API accepts or emits. A locale-sensitive
// parse is a defect waiting for a tenant in another timezone (rule 6).
const isoDate = "2006-01-02"

// assignDriver opens a driver-to-unit assignment (FR-VEH-007). It is what
// app.v_capture_vehicle reads, so it is the step between a created driver and
// a capture they can reach.
//
// The assignee's role is deliberately unchecked: no constraint says an
// assignment names a DRIVER, and asserting it here would put a rule in Go that
// the schema does not hold (ADR-0013). Every assignable role already holds
// CaptureInspection, so the gap grants nothing.
//
// to_date is left NULL — an open assignment. Closing one is a different
// action and does not belong on a create.
func assignDriver(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicleID, err := uuid.Parse(chi.URLParam(r, "vehicleID"))
		if err != nil {
			refuseInvalid(w, r, invalid("vehicleId", "must be a uuid"))
			return
		}
		var body assignDriverRequest
		if !decodeJSON(w, r, &body) {
			return
		}
		userID, err := uuid.Parse(strings.TrimSpace(body.UserID))
		if err != nil {
			refuseInvalid(w, r, invalid("userId", "must be a uuid"))
			return
		}
		if strings.TrimSpace(body.FromDate) == "" {
			refuseInvalid(w, r, invalid("fromDate", "is required"))
			return
		}
		from, err := time.Parse(isoDate, strings.TrimSpace(body.FromDate))
		if err != nil {
			refuseInvalid(w, r, invalid("fromDate", "must be a date as YYYY-MM-DD"))
			return
		}

		created := assignmentJSON{VehicleID: vehicleID.String(), UserID: userID.String()}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ManageAssignments); err != nil {
				return err
			}
			var id uuid.UUID
			var fromDate time.Time
			err := tx.QueryRow(ctx,
				`INSERT INTO app.vehicle_driver
				   (tenant_id, vehicle_id, user_id, from_date)
				 VALUES (app.current_tenant_id(), $1, $2, $3)
				 RETURNING id, from_date`,
				vehicleID, userID, from).Scan(&id, &fromDate)
			if err != nil {
				return fmt.Errorf("assigning driver: %w", err)
			}
			created.ID = id.String()
			created.FromDate = fromDate.Format(isoDate)
			return nil
		})
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		writeJSON(ctx, w, created)
	}
}
```

- [ ] **Step 4: Register the route**

```go
		r.Post("/vehicles/{vehicleID}/drivers", assignDriver(s))
```

- [ ] **Step 5: Run the suite to verify it passes**

```bash
make check
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/admin.go api/internal/httpapi/admin_test.go api/internal/httpapi/httpapi.go
git commit -m "feat(api): TYRE-81 open a driver-to-unit assignment"
```

---

### Task 6: the client's admin API module

**Files:**
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/client.test.ts`
- Create: `web/src/api/admin.ts`
- Create: `web/src/api/admin.test.ts`

**Interfaces:**
- Consumes: `apiGet`, `apiPost`, `ApiError` from `web/src/api/client.ts`.
- Produces: an `ApiError` whose `message` is the envelope's when the refusal carried one; `AxleConfiguration`, `CreatedUnit`, `CreatedUser`, `Assignment` types; `fetchAxleConfigurations()`, `createUnit(body)`, `createUser(body)`, `assignDriver(vehicleId, body)`.

**Steps 1–4 come before the admin module and are not optional.** B3 gave `ApiError` the envelope's `code` and left its `message` as the synthetic `POST /api/vehicles failed: 409` that `apiPost` builds — the envelope's message is read for its code and then discarded. ADR-0013 decision 4 and both screens in Tasks 7 and 8 render that message. Without this, Task 7's second and third tests and Task 8's second test fail at their own verification steps, on assertions that look like screen bugs and are not.

- [ ] **Step 1: Write the failing test for the client library**

Add to `web/src/api/client.test.ts`, matching its existing helpers rather than adding new ones:

```ts
it("carries the envelope's own message, which is the server's to write", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ code: "fleet_number_taken", message: "a unit with that fleet number already exists" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const error = await apiPost("/api/vehicles", {}).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).message).toBe("a unit with that fleet number already exists");
  expect((error as ApiError).code).toBe("fleet_number_taken");
});

it("falls back to a diagnostic message when the refusal carried no envelope", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
  const error = await apiPost("/api/vehicles", {}).catch((e: unknown) => e);
  expect((error as ApiError).code).toBeNull();
  expect((error as ApiError).message).toContain("502");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd web && npx vitest run src/api/client.test.ts
```
Expected: FAIL on the first test — the message is `POST /api/vehicles failed: 409`.

- [ ] **Step 3: Read the envelope once, for both fields**

In `web/src/api/client.ts`, replace `refusalCode` with a function that returns both, and update both call sites. The body can only be read once, so code and message must come from the same parse — a second `res.json()` throws.

```ts
// The refusal envelope, or nothing (ADR-0012). A proxy, a gateway or a
// browser-generated failure carries none, so an unreadable body yields nulls
// rather than a throw: an error path that fails while reporting a failure
// loses the inspection the outbox is holding.
//
// Both fields come from one parse because a Response body can only be read
// once.
async function refusal(res: Response): Promise<{ code: string | null; message: string | null }> {
  const none = { code: null, message: null };
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return none;
    return {
      code: "code" in body && typeof body.code === "string" ? body.code : null,
      message: "message" in body && typeof body.message === "string" ? body.message : null,
    };
  } catch {
    return none;
  }
}
```

Then each call site becomes, with the verb and path changing:

```ts
  if (!res.ok) {
    const { code, message } = await refusal(res);
    // The envelope's message is the server's own words and is safe to show
    // where it is Go-authored or TY-class (ADR-0013). The fallback is a
    // diagnostic for the case where there is no envelope at all.
    throw new ApiError(res.status, message ?? `POST ${path} failed: ${res.status}`, code);
  }
```

Update `ApiError`'s doc comment so it states what `message` now is, in the terms ADR-0013 uses — not by describing the change.

- [ ] **Step 4: Run the whole web suite, not just this file**

```bash
cd web && npx vitest run
```
Expected: PASS. `CaptureDone` keys its driver-facing sentences on `code` and never renders `message` (`outbox.ts`: "Diagnostics only, never rendered"), so the capture path is unaffected — but run everything, because this changes a value every failing request produces.

- [ ] **Step 5: Write the failing test for the admin module**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { assignDriver, createUnit, createUser, fetchAxleConfigurations } from "./admin";
import { ApiError } from "./client";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the admin API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the configuration library", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(200, [{ id: "c1", code: "HORSE_6X4", name: "Horse", version: 1, axleCount: 3 }]),
    );
    const configs = await fetchAxleConfigurations();
    expect(configs[0].code).toBe("HORSE_6X4");
  });

  it("surfaces the refusal code so a form can branch on the reason", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(409, { code: "fleet_number_taken", message: "a unit with that fleet number already exists" }),
    );
    await expect(
      createUnit({ fleetNumber: "H1", configurationId: "c1", unitKind: "HORSE" }),
    ).rejects.toMatchObject({ code: "fleet_number_taken" });
  });

  it("carries a validation refusal's own message, which is ours to render", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(422, { code: "invalid_submission", message: "fleetNumber is required" }),
    );
    const error = await createUnit({
      fleetNumber: "",
      configurationId: "c1",
      unitKind: "HORSE",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_submission");
  });

  it("posts an assignment under the unit it belongs to", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(201, { id: "a1", vehicleId: "v1", userId: "u1", fromDate: "2026-01-01" }),
    );
    await assignDriver("v1", { userId: "u1", fromDate: "2026-01-01" });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/vehicles/v1/drivers");
  });

  it("creates a user", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(201, {
        id: "u1",
        email: "a@example.invalid",
        displayName: "A",
        role: "DRIVER",
        staffNumber: null,
        active: true,
      }),
    );
    const created = await createUser({
      email: "a@example.invalid",
      displayName: "A",
      role: "DRIVER",
    });
    expect(created.active).toBe(true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd web && npx vitest run src/api/admin.test.ts
```
Expected: FAIL — `./admin` does not resolve.

- [ ] **Step 7: Write `web/src/api/admin.ts`**

```ts
import { apiGet, apiPost } from "./client";

// Wire shapes of the admin surface (api/internal/httpapi/admin.go). Each
// mirrors the server's projection exactly, so a screen that just created a
// unit holds the same shape it would have read from the list.

export interface AxleConfiguration {
  id: string;
  code: string;
  name: string;
  version: number;
  axleCount: number;
}

// Mirrors app.unit_kind. A union rather than string: the server refuses an
// unknown kind, and a form that can express one is a form that can send a
// request it knows will fail.
export type UnitKind = "HORSE" | "TRAILER" | "RIGID" | "LIGHT";

export interface NewUnit {
  fleetNumber: string;
  registration?: string;
  description?: string;
  configurationId: string;
  unitKind: UnitKind;
  homeDepotId?: string;
}

export interface CreatedUnit {
  id: string;
  fleetNumber: string;
  registration: string | null;
}

// PLATFORM_ADMIN is absent deliberately: it is not creatable through a tenant
// surface (ADR-0011, ADR-0013), and a picker that offers it offers a refusal.
export type TenantRole = "DRIVER" | "TECHNICIAN" | "CONTROLLER" | "DEPOT_MANAGER" | "ORG_ADMIN";

export interface NewUser {
  email: string;
  displayName: string;
  staffNumber?: string;
  role: TenantRole;
}

export interface CreatedUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  staffNumber: string | null;
  active: boolean;
}

export interface NewAssignment {
  userId: string;
  fromDate: string;
}

export interface Assignment {
  id: string;
  vehicleId: string;
  userId: string;
  fromDate: string;
}

export function fetchAxleConfigurations(): Promise<AxleConfiguration[]> {
  return apiGet<AxleConfiguration[]>("/api/axle-configurations");
}

export function createUnit(body: NewUnit): Promise<CreatedUnit> {
  return apiPost<CreatedUnit>("/api/vehicles", body);
}

export function createUser(body: NewUser): Promise<CreatedUser> {
  return apiPost<CreatedUser>("/api/users", body);
}

// The assignment hangs off the unit because it is the unit's relation, and a
// path that says so needs no body field to disambiguate it.
export function assignDriver(vehicleId: string, body: NewAssignment): Promise<Assignment> {
  return apiPost<Assignment>(`/api/vehicles/${vehicleId}/drivers`, body);
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
cd web && npx vitest run src/api/admin.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 9: Commit**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts \n        web/src/api/admin.ts web/src/api/admin.test.ts
git commit -m "feat(web): TYRE-81 carry the refusal envelope's message and type the admin surface"
```

---

### Task 7: the add-a-unit screen

**Files:**
- Create: `web/src/admin/AddUnit.tsx`
- Create: `web/src/admin/AddUnit.test.tsx`
- Create: `web/src/admin/admin.css`

**Interfaces:**
- Consumes: `fetchAxleConfigurations`, `createUnit`, `UnitKind` from Task 6; `ApiError` from `web/src/api/client.ts`.
- Produces: `AddUnit()`, a default-exported-free named component Task 9 routes to at `/admin/units/new`.

- [ ] **Step 1: Write the failing test**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddUnit } from "./AddUnit";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddUnit />
    </QueryClientProvider>,
  );
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIGS = [{ id: "c1", code: "HORSE_6X4", name: "Horse 6x4", version: 1, axleCount: 3 }];

describe("adding a unit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the unit and confirms it by fleet number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(respond(201, { id: "v1", fleetNumber: "H99", registration: null }));

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H99");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/H99/);
  });

  it("says which conflict happened when the fleet number is taken", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(
        respond(409, {
          code: "fleet_number_taken",
          message: "a unit with that fleet number already exists",
        }),
      );

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/fleet number/i);
    // ADR-0012: no schema object reaches a person's screen.
    expect(alert).not.toHaveTextContent(/_key|constraint/i);
  });

  it("shows a validation refusal's own message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(
        respond(422, { code: "invalid_submission", message: "fleetNumber is too long" }),
      );

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too long/i);
  });

  it("reports a refused library rather than rendering an empty picker", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));
    renderScreen();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd web && npx vitest run src/admin/AddUnit.test.tsx
```
Expected: FAIL — `./AddUnit` does not resolve.

- [ ] **Step 3: Write `web/src/admin/AddUnit.tsx`**

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import {
  createUnit,
  fetchAxleConfigurations,
  type CreatedUnit,
  type UnitKind,
} from "../api/admin";
import { ApiError } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import "./admin.css";

// The kinds a unit can be, in the order a fleet thinks of them. The values are
// app.unit_kind's and the labels are not: a screen says "horse", the enum says
// HORSE, and neither should have to become the other.
const KINDS: { value: UnitKind; label: string }[] = [
  { value: "HORSE", label: "Horse" },
  { value: "TRAILER", label: "Trailer" },
  { value: "RIGID", label: "Rigid" },
  { value: "LIGHT", label: "Light vehicle" },
];

// A refused create says what happened in the words of whoever knows: our own
// validation and conflict messages are safe to render (ADR-0013), and anything
// else gets the general sentence rather than a wrong specific one.
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable = ["invalid_submission", "fleet_number_taken", "conflict"];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return "You do not have permission to add a unit.";
    }
  }
  return "The unit could not be added. Try again, or call support if it keeps happening.";
}

// FR-VEH-001..005, gated on ManageAssets (D8). Authoring an axle configuration
// is not here and is ORG_ADMIN's alone through ManageTemplates (TYRE-84) — this
// screen picks from the library and never adds to it.
export function AddUnit() {
  const tenantKey = getDevTenantId() ?? "default";
  const configs = useQuery({
    queryKey: ["axle-configurations", tenantKey],
    queryFn: fetchAxleConfigurations,
  });

  const [fleetNumber, setFleetNumber] = useState("");
  const [registration, setRegistration] = useState("");
  const [unitKind, setUnitKind] = useState<UnitKind | "">("");
  const [configurationId, setConfigurationId] = useState("");
  const [added, setAdded] = useState<CreatedUnit | null>(null);

  const create = useMutation({
    mutationFn: createUnit,
    onSuccess: (unit) => {
      setAdded(unit);
      setFleetNumber("");
      setRegistration("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (unitKind === "") return;
    setAdded(null);
    create.mutate({
      fleetNumber,
      registration: registration === "" ? undefined : registration,
      configurationId: configurationId === "" ? (configs.data?.[0]?.id ?? "") : configurationId,
      unitKind,
    });
  }

  return (
    <section aria-labelledby="add-unit-heading" className="adm-form">
      <h1 id="add-unit-heading">Add a unit</h1>

      {configs.isPending && <p>Loading…</p>}
      {configs.isError && (
        <p role="alert">
          The axle configuration library could not be loaded, so a unit cannot be added yet.
        </p>
      )}

      {configs.isSuccess && (
        <form onSubmit={submit}>
          <label htmlFor="fleetNumber">Fleet number</label>
          {/* FR-VEH-003: alphanumeric, never assumed numeric — so this is a
              text input with no pattern, and the server checks only that
              there is one. */}
          <input
            id="fleetNumber"
            value={fleetNumber}
            onChange={(e) => setFleetNumber(e.target.value)}
            required
          />

          <label htmlFor="registration">Registration</label>
          <input
            id="registration"
            value={registration}
            onChange={(e) => setRegistration(e.target.value)}
          />

          <label htmlFor="unitKind">Unit kind</label>
          <select
            id="unitKind"
            value={unitKind}
            onChange={(e) => setUnitKind(e.target.value as UnitKind)}
            required
          >
            <option value="">Choose…</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>

          <label htmlFor="configurationId">Axle configuration</label>
          <select
            id="configurationId"
            value={configurationId === "" ? (configs.data[0]?.id ?? "") : configurationId}
            onChange={(e) => setConfigurationId(e.target.value)}
            required
          >
            {configs.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code} v{c.version})
              </option>
            ))}
          </select>

          <button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add unit"}
          </button>
        </form>
      )}

      {create.isError && <p role="alert">{refusalMessage(create.error)}</p>}
      {added && <p role="status">{added.fleetNumber} was added.</p>}
    </section>
  );
}
```

- [ ] **Step 4: Write `web/src/admin/admin.css`**

Layout only. Two rules are load-bearing rather than cosmetic and belong with a comment: labels stack above inputs so the form survives a narrow viewport, and the touch target minimum matches the capture app's, because a depot manager may be on the same phone.

```css
/* The admin forms. Layout only — colour comes from the theme tokens
   (web/src/theme/base.css), so a tenant's branding reaches these screens
   without either file knowing about the other. */

.adm-form {
  max-width: 32rem;
}

/* Stacked, never side by side: these screens are reachable from the same
   phone the capture app runs on, and a two-column form at 360px is a
   horizontal scroll. */
.adm-form form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.adm-form input,
.adm-form select,
.adm-form button {
  /* NFR-USE-008's 44px target, in rem so it survives a browser text-size
     setting. The capture keypad uses the same floor. */
  min-height: 2.75rem;
  font: inherit;
}
```

Check `web/src/capture/capture.css` for the project's actual token names and target-size rule before writing this, and match them; if the capture app states the 44px floor with a different requirement ID, use that one.

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd web && npx vitest run src/admin/AddUnit.test.tsx
```
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add web/src/admin/AddUnit.tsx web/src/admin/AddUnit.test.tsx web/src/admin/admin.css
git commit -m "feat(web): TYRE-81 add-a-unit screen against the configuration library"
```

---

### Task 8: the add-a-driver screen, with its assignment step

**Files:**
- Create: `web/src/admin/AddDriver.tsx`
- Create: `web/src/admin/AddDriver.test.tsx`

**Interfaces:**
- Consumes: `createUser`, `assignDriver`, `TenantRole` from Task 6; `fetchVehicles` from `web/src/api/vehicles.ts`; `ApiError`.
- Produces: `AddDriver()`, routed at `/admin/users/new` by Task 9.

The assign step is folded into this screen rather than given its own: it needs the id of the user just created, and the unit list comes from `GET /api/vehicles`, which every role holding `ManageUsers` can already read. That keeps the DoD's last clause reachable without a `GET /api/users` this ticket does not need.

- [ ] **Step 1: Write the failing test**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddDriver } from "./AddDriver";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddDriver />
    </QueryClientProvider>,
  );
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREATED = {
  id: "u1",
  email: "new@example.invalid",
  displayName: "New Driver",
  role: "DRIVER",
  staffNumber: null,
  active: true,
};

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText(/email/i), "new@example.invalid");
  await userEvent.type(screen.getByLabelText(/name/i), "New Driver");
  await userEvent.click(screen.getByRole("button", { name: /add user/i }));
}

describe("adding a driver", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the user and then offers the assignment that makes them able to capture", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(/New Driver/);
    expect(await screen.findByLabelText(/unit/i)).toBeInTheDocument();
  });

  it("names the rehire case rather than reporting a generic conflict", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(409, {
        code: "email_taken",
        message: "a user with that email address already exists in this tenant",
      }),
    );

    renderScreen();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already exists/i);
    expect(alert).not.toHaveTextContent(/_key|constraint/i);
  });

  it("records the assignment against the unit chosen", async () => {
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

    expect(await screen.findByText(/assigned to H99/i)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe("/api/vehicles/v1/drivers");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd web && npx vitest run src/admin/AddDriver.test.tsx
```
Expected: FAIL — `./AddDriver` does not resolve.

- [ ] **Step 3: Write `web/src/admin/AddDriver.tsx`**

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { assignDriver, createUser, type CreatedUser, type TenantRole } from "../api/admin";
import { ApiError } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { fetchVehicles } from "../api/vehicles";
import "./admin.css";

// The roles a tenant may create. PLATFORM_ADMIN is absent because it is not
// creatable through a tenant surface at all (ADR-0011, ADR-0013).
//
// D9 narrows this per actor — CONTROLLER and DEPOT_MANAGER will be able to
// create DRIVER alone — and TYRE-83 owns that. Until it lands the whole list
// is offered to whoever holds ManageUsers, which is ORG_ADMIN alone.
const ROLES: { value: TenantRole; label: string }[] = [
  { value: "DRIVER", label: "Driver" },
  { value: "TECHNICIAN", label: "Technician" },
  { value: "CONTROLLER", label: "Controller" },
  { value: "DEPOT_MANAGER", label: "Depot manager" },
  { value: "ORG_ADMIN", label: "Organisation admin" },
];

function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable = ["invalid_submission", "email_taken", "assignment_overlaps", "conflict"];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return "You do not have permission to add a user.";
    }
  }
  return "The user could not be added. Try again, or call support if it keeps happening.";
}

// An assignment's from_date is a date, not a timestamp, so this is the
// browser's local calendar day — which is the person's own day, and is not
// the same thing as the tenant's configured timezone. They differ only for an
// admin working from another country, and a from_date one day out is
// correctable; taking a UTC instant instead would be wrong every evening in
// South Africa.
function today(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// FR-AUT-010's invite, gated on ManageUsers. The assignment step follows the
// create rather than living on its own screen: a driver with no assignment
// reaches no capture (FR-AUT-005, app.v_capture_vehicle), so the two steps are
// one piece of work even though they are two writes.
export function AddDriver() {
  const tenantKey = getDevTenantId() ?? "default";
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [staffNumber, setStaffNumber] = useState("");
  const [role, setRole] = useState<TenantRole>("DRIVER");
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [assignedTo, setAssignedTo] = useState<string | null>(null);

  const vehicles = useQuery({
    queryKey: ["vehicles", tenantKey],
    queryFn: fetchVehicles,
    // The list is only needed once there is somebody to assign.
    enabled: created !== null,
  });

  const create = useMutation({
    mutationFn: createUser,
    onSuccess: (user) => {
      setCreated(user);
      setAssignedTo(null);
    },
  });

  const assign = useMutation({
    mutationFn: (id: string) => assignDriver(id, { userId: created?.id ?? "", fromDate: today() }),
    onSuccess: (_, id) => {
      setAssignedTo(vehicles.data?.find((v) => v.id === id)?.fleetNumber ?? null);
    },
  });

  function submitUser(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      email,
      displayName,
      staffNumber: staffNumber === "" ? undefined : staffNumber,
      role,
    });
  }

  function submitAssignment(e: FormEvent) {
    e.preventDefault();
    const id = vehicleId === "" ? (vehicles.data?.[0]?.id ?? "") : vehicleId;
    if (id === "") return;
    assign.mutate(id);
  }

  return (
    <section aria-labelledby="add-user-heading" className="adm-form">
      <h1 id="add-user-heading">Add a user</h1>

      <form onSubmit={submitUser}>
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label htmlFor="displayName">Name</label>
        <input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />

        {/* FR-AUT-022: a durable identifier independent of the display name,
            and optional — R13 identifies its driver as "Melusi" and nothing
            else. */}
        <label htmlFor="staffNumber">Staff number</label>
        <input
          id="staffNumber"
          value={staffNumber}
          onChange={(e) => setStaffNumber(e.target.value)}
        />

        <label htmlFor="role">Role</label>
        <select
          id="role"
          value={role}
          onChange={(e) => setRole(e.target.value as TenantRole)}
          required
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Adding…" : "Add user"}
        </button>
      </form>

      {create.isError && <p role="alert">{refusalMessage(create.error)}</p>}
      {created && <p role="status">{created.displayName} was added.</p>}

      {created && (
        <form onSubmit={submitAssignment}>
          <h2>Assign to a unit</h2>
          {vehicles.isPending && <p>Loading units…</p>}
          {vehicles.isError && <p role="alert">The unit list could not be loaded.</p>}
          {vehicles.isSuccess && (
            <>
              <label htmlFor="vehicleId">Unit</label>
              <select
                id="vehicleId"
                value={vehicleId === "" ? (vehicles.data[0]?.id ?? "") : vehicleId}
                onChange={(e) => setVehicleId(e.target.value)}
              >
                {vehicles.data.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.fleetNumber}
                  </option>
                ))}
              </select>
              <button type="submit" disabled={assign.isPending}>
                {assign.isPending ? "Assigning…" : "Assign"}
              </button>
            </>
          )}
        </form>
      )}

      {assign.isError && <p role="alert">{refusalMessage(assign.error)}</p>}
      {assignedTo && <p role="status">Assigned to {assignedTo}.</p>}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web && npx vitest run src/admin/AddDriver.test.tsx
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/admin/AddDriver.tsx web/src/admin/AddDriver.test.tsx
git commit -m "feat(web): TYRE-81 add-a-driver screen and the assignment that reaches a capture"
```

---

### Task 9: navigation and routes

**Files:**
- Modify: `web/src/shell/navigation.ts`
- Modify: `web/src/shell/navigation.test.ts`
- Modify: `web/src/routes.tsx`
- Modify: `web/src/routes.test.tsx`

**Interfaces:**
- Consumes: `AddUnit` from Task 7, `AddDriver` from Task 8.
- Produces: the routes `/admin/units/new` and `/admin/users/new`, and the two nav items that reach them.

- [ ] **Step 1: Write the failing navigation test**

Add to `web/src/shell/navigation.test.ts`:

```ts
it("offers the admin screens only to the capabilities that can use them", () => {
  const assets = navItemsFor(["ViewFleet", "ManageAssets"]).map((i) => i.to);
  expect(assets).toContain("/admin/units/new");
  expect(assets).not.toContain("/admin/users/new");

  const users = navItemsFor(["ViewFleet", "ManageUsers"]).map((i) => i.to);
  expect(users).toContain("/admin/users/new");

  // A driver holds neither, and the menu is a courtesy — the route checks
  // again regardless (NFR-SEC-006).
  expect(navItemsFor(["CaptureInspection"]).map((i) => i.to)).toEqual(["/my"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd web && npx vitest run src/shell/navigation.test.ts
```
Expected: FAIL — neither path is in `NAV_ITEMS`.

- [ ] **Step 3: Add the nav items**

In `web/src/shell/navigation.ts`, extend `NAV_ITEMS`:

```ts
export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/fleet", label: "Vehicles", capability: "ViewFleet" },
  { to: "/my", label: "My inspections", capability: "CaptureInspection" },
  // D8 puts add-a-unit on ManageAssets and invites on ManageUsers, which are
  // held by different roles — so they are two items and never one "Admin"
  // group, which would appear for a controller who cannot use half of it.
  { to: "/admin/units/new", label: "Add a unit", capability: "ManageAssets" },
  { to: "/admin/users/new", label: "Add a user", capability: "ManageUsers" },
] as const;
```

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Add to `web/src/routes.test.tsx`. The file already provides everything needed: `renderAt(path, me)` takes a full `Me`, `actor(capabilities)` builds one, and `mockFetchJson(status, body)` stubs the fetch. Passing a bare `{ capabilities: [...] }` object does not typecheck under `strict: true` and fails `make lint` at `tsc`, so use the factory.

```tsx
it("tells an actor without the capability, rather than blanking the screen", () => {
  mockFetchJson(200, []);
  renderAt("/admin/units/new", actor(["CaptureInspection"]));
  expect(screen.getByRole("alert")).toHaveTextContent(/permission/i);
});

it("renders the add-a-unit screen for an actor holding ManageAssets", async () => {
  // The screen fetches the configuration library on mount; an unstubbed
  // relative-URL fetch throws in node, so stub it even though the heading
  // renders outside the query's branches.
  mockFetchJson(200, []);
  renderAt("/admin/units/new", actor(["ManageAssets"]));
  expect(await screen.findByRole("heading", { name: /add a unit/i })).toBeInTheDocument();
});
```

- [ ] **Step 6: Add the routes**

In `web/src/routes.tsx`. Note the pattern `CaptureRoute` already establishes: `RequireCapability` hides silently, which is right for a menu item and wrong for a destination someone navigated to — so an admin route says so instead.

```tsx
// A destination someone navigated to says why it is refused; a menu item just
// disappears. RequireCapability is the second, so these routes are the first.
function AdminRoute({ capability, children }: { capability: string; children: ReactNode }) {
  const can = useCan(capability);
  const settled = useActorSettled();
  if (!settled) return null;
  if (!can) return <p role="alert">You do not have permission to use this screen.</p>;
  return <>{children}</>;
}
```

and inside `AppRoutes`:

```tsx
      <Route
        path="/admin/units/new"
        element={
          <AdminRoute capability="ManageAssets">
            <AddUnit />
          </AdminRoute>
        }
      />
      <Route
        path="/admin/users/new"
        element={
          <AdminRoute capability="ManageUsers">
            <AddDriver />
          </AdminRoute>
        }
      />
```

Add `ReactNode` to the `react` type import and the two component imports at the top.

- [ ] **Step 7: Run the whole web suite**

```bash
cd web && npx vitest run
```
Expected: PASS, with the counts up by this plan's new cases and nothing previously green now red.

- [ ] **Step 8: Commit**

```bash
git add web/src/shell/navigation.ts web/src/shell/navigation.test.ts \
        web/src/routes.tsx web/src/routes.test.tsx
git commit -m "feat(web): TYRE-81 route the admin screens behind their capabilities"
```

---

### Task 10: the end-to-end proof and the close-out

**Files:**
- Create: `web/e2e/admin.ts`
- Create: `web/e2e/admin.spec.ts`
- Modify: `docs/implementation-order.md`
- Modify: `docs/lessons.md` (only if this branch paid for a lesson)

**Interfaces:**
- Consumes: everything above, through the browser.
- Produces: the DoD's own sentence as a passing test.

- [ ] **Step 1: Write the org-admin actor helper**

`web/e2e/admin.ts`, matching `web/e2e/driver.ts`'s shape and its reasoning about seed-derived ids:

```ts
import { type Page } from "@playwright/test";

// Sandbox Fleet, never BAC: BAC's rows are the acceptance fixture, and a spec
// that adds units to it changes what Appendix E and Appendix J reproduce
// (TYRE-80).
//
// Ids are md5-derived in db/seeds/gen_seed_fixture.py — md5('sbadmin1') and
// the sandbox tenant's fixed uuid — so they are stable across reseeds.
const ORG_ADMIN = "96b10943-acb4-c3d7-e8cd-3e1fb52e067e";
const TENANT = "33333333-3333-3333-3333-333333333333";

export async function actAsOrgAdmin(page: Page): Promise<void> {
  await page.addInitScript(
    ([user, tenant]) => {
      window.localStorage.setItem("tyre.dev.user-id", user);
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
    },
    [ORG_ADMIN, TENANT],
  );
}
```

Verify both ids against a reseeded database before trusting them:

```bash
make db-reset
docker compose exec db psql -U postgres -c \
  "SELECT id, email, role FROM app.app_user WHERE tenant_id = '33333333-3333-3333-3333-333333333333';"
```

- [ ] **Step 2: Write the failing spec**

`web/e2e/admin.spec.ts`. It writes rows, so it must be unique per run — a second run against the same seed would hit `fleet_number_taken` and `email_taken`, which are exactly the refusals the unit tests already cover and not what this spec is for.

```ts
import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";

// TYRE-81's definition of done, as one path: an org admin builds a unit and a
// driver from nothing, assigns them, and that driver reaches a capture.
//
// Serial, and unique per run: these are writes into a shared database, and a
// fleet number or email reused across runs is refused by design (DR-003, D10).
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString().slice(-6);
const FLEET = `E2E-${RUN}`;
const EMAIL = `e2e-driver-${RUN}@example.invalid`;

test.beforeEach(async ({ page }) => {
  await actAsOrgAdmin(page);
});

test("an org admin can build a tenant from nothing", async ({ page }) => {
  await page.goto("/admin/units/new");
  await page.getByLabel(/fleet number/i).fill(FLEET);
  await page.getByLabel(/unit kind/i).selectOption("HORSE");
  await page.getByRole("button", { name: /add unit/i }).click();
  await expect(page.getByRole("status")).toContainText(FLEET);

  await page.goto("/admin/users/new");
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/name/i).fill(`E2E Driver ${RUN}`);
  await page.getByRole("button", { name: /add user/i }).click();
  await expect(page.getByRole("status")).toContainText("E2E Driver");

  await page.getByLabel(/unit/i).selectOption({ label: FLEET });
  await page.getByRole("button", { name: /assign/i }).click();
  await expect(page.getByText(new RegExp(`assigned to ${FLEET}`, "i"))).toBeVisible();
});
```

The driver-reaches-capture half is asserted by `TestAssignDriverToVehicle` in Go, against the same relation the browser would use. Add a browser leg only if the e2e run makes it cheap: it needs a second `addInitScript` for the created driver's id, which the UI does not surface, so the honest place for that assertion is the Go test.

- [ ] **Step 3: Register the spec's project**

`web/playwright.config.ts` runs `capture.spec` on the `android` project alone because of FR-INS-038's window. This spec has no such constraint but does write rows, so it runs on **one** project only — `chromium` — which means excluding it from the other two. The `chromium` project already carries a `testIgnore`, so this is an alternation there and a new key on `android`:

```ts
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /capture\.spec/ },
    // admin.spec.ts creates a unit and a user per run. Rows, not just reads —
    // so it runs on one project, like capture.spec.ts and for a related
    // reason: a second project repeats the writes rather than the assertions.
    { name: "android", use: { ...devices["Pixel 7"] }, testIgnore: /admin\.spec/ },
    { name: "ios", use: { ...devices["iPhone 14"] }, testIgnore: /capture\.spec|admin\.spec/ },
```

Keep each project's existing comment; the block above shows only the lines that change.

- [ ] **Step 4: Run the e2e gate**

```bash
make e2e
```
Expected: PASS, with the count up by one. If the assign step cannot find the new unit in the picker, the vehicle list is cached from before the create — the fix is a `queryClient.invalidateQueries` on the vehicles key in `AddUnit`'s `onSuccess`, not a wait in the spec.

- [ ] **Step 5: Record B4 as delivered**

In `docs/implementation-order.md`, replace the B4 section's body with the delivered form the B1, B2 and B3 sections use: what landed, as a table of commits against their assertions, plus anything the branch found that changes what the next batch should expect. Mark the heading **delivered**. Name the plan and the spec by path. Carry forward, explicitly:

- the assignment endpoint was an assumption, and whether the ticket owner confirmed it;
- `unit_kind` is required by the API and not the schema, owned by TYRE-88;
- `TY008`/`TY009` are still not in `submitStatus`, and why B4 did not discharge ADR-0012's deferral.

- [ ] **Step 6: Run the comment audit and the full gate**

```bash
/comment-audit
make check
make e2e
```
Expected: all three clean. Fix what they find; do not weaken an assertion to pass.

- [ ] **Step 7: Commit and open the PR**

```bash
git add web/e2e/admin.ts web/e2e/admin.spec.ts web/playwright.config.ts docs/implementation-order.md
git commit -m "test(e2e): TYRE-81 build a tenant from nothing through the UI"
```

The PR body follows PR #31's shape: a summary per ticket, the gates actually run with their results read from the log rather than the wrapper's exit code, any honest disclosure, and the test plan as a checklist. Two things must be said plainly rather than left to be inferred: that the assignment endpoint was taken as an assumption, and that the definition of done's last clause — the driver reaching a capture — is proven by `TestAssignDriverToVehicle` in Go and not in the browser, because the created driver's id is never surfaced by the UI for a spec to act as.

---

## Self-review

Checked against the spec on 2026-08-28.

**Spec coverage.** Decision 1 → Tasks 3–5 (parameterised inserts, no SQL function, no migration). Decision 2 → Task 3 Steps 1–6. Decision 3, the shape half → Task 3 Step 9 and Task 4 Step 3; the renderable-message half → Task 6 Steps 1–4, then the screens in Tasks 7 and 8. Decision 4 → Task 4 Step 3's `tenantRoles`. Decision 5 → no delete endpoint appears anywhere; asserted by absence and stated in Task 1 Step 3. Decision 6 → Task 3 Step 10's `unitKinds` and Task 1 Step 5. Decision 7 → Task 2. Decision 8 → the 201 in Tasks 3, 4 and 5. Decision 9 → no idempotency key appears. The D9/D10 constraints → Task 1 Step 4. ADR-0012's premises → Task 3 Steps 4–5 and Task 1 Step 6. The `WITH CHECK` requirement → Task 3 Step 14. The assignment assumption → Task 5's banner and Task 10 Step 5.

**Type consistency.** `vehicleJSON` is the server's existing type and Task 3 reuses it rather than defining a second; the client's mirror is `CreatedUnit`, and the two agree field for field. `userJSON` (Task 4) and `CreatedUser` (Task 6) agree. `assignmentJSON` (Task 5) and `Assignment` (Task 6) agree. `axleConfigurationJSON` (Task 2) and `AxleConfiguration` (Task 6) agree. `conflictCodes` values are the `code*` constants added in Task 3 Step 3 and the literals asserted in Task 3 Step 1 — literals in the test on purpose, since a test comparing a constant to itself proves nothing about the wire.

**Review pass, 2026-08-28.** A reviewer with no context read this plan against the real files and found two defects that would have stopped an executor mid-task. Both are fixed above, and both are recorded here because the shape of each is worth recognising again:

1. **The plan built on a client capability that did not exist.** ADR-0013 decision 4 makes a Go-authored refusal message renderable, and both screens render it — but `client.ts` reads the envelope for its `code` and discards the message, so `ApiError.message` is the synthetic `POST /api/vehicles failed: 409`. Tasks 7 and 8 would have failed at their own verification steps on assertions that look like screen bugs. Task 6 now carries the client change first, and `client.ts` is in the file structure where it belongs. **The general form: a decision recorded in an ADR is not a capability the code has.**
2. **The `WITH CHECK` test could not fail.** Asserting that a created row carries the actor's tenant tests the handler's own `app.current_tenant_id()` back at itself — drop the policy entirely and it stays green. TYRE-81 asks for this property by name. Task 3 Step 14 now issues the insert that names another tenant directly, and requires the executor to observe it failing before trusting it (`docs/lessons.md`, 2026-08-20) — with `DISABLE ROW LEVEL SECURITY` as the kill, because a table with RLS on and no policy is default-deny and would keep the test green.

Smaller corrections from the same pass, all applied: the `23503` comment's second sentence — which prescribed the very approach ADR-0013 rejects — is replaced along with the first; `errorBody`'s doc comment gets its own step, since ADR-0013 makes it false; `routes.test.tsx`'s `renderAt` takes a full `Me` and the pasted object literal would not typecheck; the message-constants snippet carried a stray closing paren; `admin_test.go` needed the `uuid` import a task before it was used; three Files blocks disagreed with their own steps.

**Verified against the real files rather than asserted:** every test-helper signature the plan calls (`plantUser`, `plantTenant`, `plantTenantWithVehicle`, `plantCaptureFixture`, `get`, `post`); the three constraint names, against the DDL in `000001` and `000026`; `created_by`'s `app.current_actor_id()` default in `000017`; the `unit_kind` enum values in `000010` and the column's nullability in `000011`; the sandbox org-admin and tenant ids against the seed generator; that no existing web test asserts the synthetic error message the client change replaces.

**One soft spot remains, with the step that resolves it.** Constraint names are read from the migrations, not from a live catalog. Task 3 Step 13 carries the `\d app.vehicle` check and the instruction to fix the map rather than weaken the assertion.
