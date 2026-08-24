# Actor Context, Roles and Capability Gating — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every API request a resolved actor — user, tenant, role and depot scope, read from the database under RLS — and gate every handler on capabilities rather than role names.

**Architecture:** Tenant isolation stays in RLS, untouched. Intra-tenant scope predicates are defined once in SQL as `security_invoker` views keyed on `app.current_actor_id()` (ADR-0006), and Go handlers compose them. The resolver supplies identity only; the role is read from `app.app_user` on every request, never taken from a claim (ADR-0011). Handlers assert capabilities so that the fleet-controller and asset-controller jobs can share `CONTROLLER` without the code asserting they are the same job.

**Tech Stack:** PostgreSQL 16 (golang-migrate), Go 1.24 (`chi`, `pgx/v5`, `testify`), React 19 + Vite 7 + TypeScript strict, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-24-actor-context-and-roles-design.md`
**Decision:** `docs/adr/0011-actor-context-and-authorisation.md`
**Ticket:** TYRE-56 (branch `TYRE-56-actor-context-and-roles`, cut from `develop`)

## Global Constraints

- **Tenant isolation lives in the database.** Nothing in this plan adds, removes or weakens an RLS policy. No new `SECURITY DEFINER` function — verification check 8c holds the allowlist at exactly one entry.
- **Every scope predicate is defined once, in SQL, as a view with `security_invoker = true`.** Handlers compose the view; they never re-derive the join (ADR-0006).
- **An unset actor matches no rows.** Every new view fails closed the same way tenant context does (FR-TEN-004).
- **The role is never an input.** It is read from `app.app_user` inside the tenant-bound transaction on every request (ADR-0011, NFR-SEC-006, FR-AUT-011).
- **Go:** stdlib `net/http` plus `chi`. `pgx` directly, no ORM. `context.Context` first parameter always. Errors wrapped `fmt.Errorf("...: %w", err)`. Never `panic` in request handling. Accept interfaces, return structs.
- **TypeScript:** `strict: true`. No `any` — `@typescript-eslint/no-explicit-any` is an error. Function components and hooks. TanStack Query for server state. Prettier owns layout.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. Every non-obvious rule cites its requirement ID. `scripts/check-comment-style.mjs` runs in `make lint` and in CI.
- **Never edit an applied migration.** New work is a new numbered pair. Every `up` gets a mirroring `down`.
- **Do not weaken a test to make it pass.** If a pinned expectation breaks, say so and explain why before changing it.
- **Commands:** `make db-reset`, `make db-test`, `make api-test`, `make web-test`, `make fmt`, `make lint`, `make check`. Docker Desktop must be running for all of them.

---

### Task 1: Scope views and their verification

**Files:**
- Create: `db/migrations/000014_actor_scope_views.up.sql`
- Create: `db/migrations/000014_actor_scope_views.down.sql`
- Modify: `db/tests/004_tests.sql` (append section 28 before the final banner)
- Modify: `db/seeds/gen_seed_fixture.py:64-68` (two more seeded users)

**Interfaces:**
- Consumes: `app.current_actor_id()` (`db/migrations/000001_init.up.sql:32-35`), `app.user_depot`, `app.vehicle.home_depot_id`, `app.tyre.current_depot_id`, `app.fitment`, `app.inspection_task`.
- Produces: `app.v_actor_depot(tenant_id, depot_id)`, `app.v_depot_vehicle` (all `app.vehicle` columns), `app.v_depot_tyre` (all `app.tyre` columns), `app.v_my_inspection_task` (all `app.inspection_task` columns plus `overdue boolean`). Task 3 selects `depot_id` from `app.v_actor_depot`; Task 5 selects from the other three.

- [ ] **Step 1: Write the failing verification section**

Open `db/tests/004_tests.sql`. Find the closing banner at the end of the file:

```sql
\echo ''
\echo '================  ALL CHECKS PASSED  ================'
```

Insert the following **immediately before** those two lines:

```sql
\echo '== 28. Actor scope predicates: depot and task views (FR-AUT-006/008, FR-DSH-012)'
DO $$
DECLARE got text; n int;
BEGIN
  -- Self-contained: pin tenant 1 rather than inherit check 27's session state.
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);

  -- Melusi is scoped to Johannesburg, where all three tenant-1 units are based.
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);
  SELECT string_agg(fleet_number, ',' ORDER BY fleet_number) INTO got FROM app.v_depot_vehicle;
  IF got IS DISTINCT FROM 'HORSE,LINK12,LINK6' THEN
    RAISE EXCEPTION 'FAIL: depot-scoped units read [%], expected HORSE,LINK12,LINK6', got; END IF;

  -- Sipho holds no user_depot row: depot scope is granted, never implied by
  -- tenant membership (FR-AUT-004).
  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: user with no depot scope sees % units', n; END IF;

  -- Tenant 2's user id inside a tenant-1 session: the tenant predicate binds
  -- before the actor predicate, so a stale or stolen actor id cannot cross
  -- the boundary.
  PERFORM set_config('app.actor_id', md5('driver2')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: foreign-tenant actor sees % units', n; END IF;

  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_depot_vehicle;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % units', n; END IF;
  RAISE NOTICE 'PASS  depot-scoped units are granted, tenant-bound and fail closed';
END $$;

DO $$
DECLARE fitted int; scoped int; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);

  -- A tyre is in a depot two ways and FR-AUT-006 means both: sitting there,
  -- or fitted to a unit based there. Scoping on current_depot_id alone would
  -- return zero on this fixture, whose tyres are all fitted.
  SELECT count(*) INTO fitted FROM app.fitment WHERE removed_at IS NULL;
  IF fitted = 0 THEN
    RAISE EXCEPTION 'FAIL: fixture has no open fitments, so this check proves nothing'; END IF;
  SELECT count(*) INTO scoped FROM app.v_depot_tyre;
  IF scoped <> fitted THEN
    RAISE EXCEPTION 'FAIL: depot-scoped tyres = %, open fitments = %', scoped, fitted; END IF;

  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_depot_tyre;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % tyres', n; END IF;
  RAISE NOTICE 'PASS  depot-scoped tyres reach fitted stock and fail closed';
END $$;

DO $$
DECLARE via_view int; direct int; n int;
BEGIN
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', false);
  PERFORM set_config('app.actor_id', md5('driver1')::uuid::text, false);

  -- An invariant, not a count: task rows are generated by check 26, and
  -- pinning a number here would couple two checks together (see the
  -- test-fixture residue note in the open-questions register).
  SELECT count(*) INTO via_view FROM app.v_my_inspection_task;
  SELECT count(*) INTO direct FROM app.inspection_task
   WHERE assigned_user_id = md5('driver1')::uuid AND state IN ('OPEN','ESCALATED');
  IF via_view <> direct THEN
    RAISE EXCEPTION 'FAIL: task view shows %, the predicate it encodes shows %', via_view, direct; END IF;

  PERFORM set_config('app.actor_id', md5('driver3')::uuid::text, false);
  SELECT count(*) INTO n FROM app.v_my_inspection_task WHERE assigned_user_id <> md5('driver3')::uuid;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: actor sees % of another user''s tasks', n; END IF;

  PERFORM set_config('app.actor_id', '', false);
  SELECT count(*) INTO n FROM app.v_my_inspection_task;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: unset actor sees % tasks', n; END IF;

  PERFORM set_config('app.actor_id', '', false);
  RAISE NOTICE 'PASS  task view is actor-scoped and fails closed';
END $$;
```

- [ ] **Step 2: Run it and verify it fails**

```bash
make db-up && make db-test
```

Expected: FAIL, aborting on `relation "app.v_depot_vehicle" does not exist`. If it fails on anything else, stop and read the error — the fixture may have moved.

- [ ] **Step 3: Write the migration**

Create `db/migrations/000014_actor_scope_views.up.sql`:

```sql
-- ============================================================================
--  Actor scope predicates: depot and task (TYRE-56)
--  Implements: FR-AUT-004/006/008 read side, FR-DSH-012 (SRS v1.4 §4.3, §4.14)
-- ============================================================================

-- The depots the acting user is scoped to (FR-AUT-004). Everything below
-- composes this rather than joining user_depot again, so "which depots am I"
-- has exactly one definition. An unset actor matches no rows, failing closed
-- the same way the tenant context does (FR-TEN-004).
CREATE VIEW app.v_actor_depot WITH (security_invoker = true) AS
SELECT ud.tenant_id,
       ud.depot_id
  FROM app.user_depot ud
 WHERE ud.user_id = app.current_actor_id();

-- FR-AUT-006/008: the units within the acting user's depots. Home depot is
-- the unit's base, not where it happens to be standing — a trailer on the
-- road still belongs to the depot that maintains it.
CREATE VIEW app.v_depot_vehicle WITH (security_invoker = true) AS
SELECT v.*
  FROM app.vehicle v
  JOIN app.v_actor_depot d ON d.depot_id = v.home_depot_id;

-- FR-AUT-006: the tyres within the acting user's depots. A tyre is in a depot
-- two ways and the requirement means both — sitting there (in stock, back
-- from the retreader, awaiting cost), or fitted to a unit based there.
-- Scoping on current_depot_id alone would hide every fitted tyre from the
-- technician who maintains it.
CREATE VIEW app.v_depot_tyre WITH (security_invoker = true) AS
SELECT DISTINCT t.*
  FROM app.tyre t
  LEFT JOIN app.fitment f ON f.tyre_id = t.id AND f.removed_at IS NULL
  LEFT JOIN app.vehicle v ON v.id = f.vehicle_id
 WHERE t.current_depot_id IN (SELECT depot_id FROM app.v_actor_depot)
    OR v.home_depot_id    IN (SELECT depot_id FROM app.v_actor_depot);

-- FR-DSH-012: the acting driver's outstanding work. Overdue is not a state —
-- app.task_state has no such value, deliberately — it is an OPEN task past
-- its due date, computed here so no client ever invents the rule.
CREATE VIEW app.v_my_inspection_task WITH (security_invoker = true) AS
SELECT it.*,
       (it.state = 'OPEN' AND it.due_at < now()) AS overdue
  FROM app.inspection_task it
 WHERE it.assigned_user_id = app.current_actor_id()
   AND it.state IN ('OPEN','ESCALATED');
```

Create `db/migrations/000014_actor_scope_views.down.sql`:

```sql
DROP VIEW app.v_my_inspection_task;
DROP VIEW app.v_depot_tyre;
DROP VIEW app.v_depot_vehicle;
DROP VIEW app.v_actor_depot;
```

- [ ] **Step 4: Run the suite and verify it passes**

```bash
make db-reset && make db-test
```

Expected: `PASS  depot-scoped units are granted, tenant-bound and fail closed`, the two other section-28 PASS lines, and `ALL CHECKS PASSED`.

- [ ] **Step 5: Verify the down migration mirrors the up**

```bash
docker compose run --rm migrate -path=/migrations -database "$DB_URL" down 1
docker compose run --rm migrate -path=/migrations -database "$DB_URL" up
```

If `$DB_URL` is not to hand, read it out of the `db-migrate` target in the `Makefile` and use the same value. Expected: both directions succeed with no error. Then `make db-reset && make db-test` once more to leave the database in a known state.

- [ ] **Step 6: Seed two management users**

Only `DRIVER` users exist in the fixture, so nothing can exercise a management surface locally. Open `db/seeds/gen_seed_fixture.py` and find the block that seeds Sipho:

```python
L.append("-- Sipho deliberately has no user_depot row: the verification suite pins")
L.append("-- the depot-scoping count, and nothing about assignment needs depot scope.")
L.append("INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES")
L.append("  (md5('driver3')::uuid,'%s','sipho@example.invalid','Sipho','EMP-0002','DRIVER');"%T)
```

Append immediately after it:

```python
# A CONTROLLER and an ORG_ADMIN so the management surfaces have someone to be
# in development. Neither gets a user_depot row: their scope is the whole
# tenant (FR-AUT-007/009), and the suite pins tenant 1 at exactly one
# depot-scoped user.
L.append("INSERT INTO app.app_user (id,tenant_id,email,display_name,staff_number,role) VALUES")
L.append("  (md5('controller1')::uuid,'%s','nomsa@example.invalid','Nomsa','EMP-0003','CONTROLLER'),"%T)
L.append("  (md5('admin1')::uuid,'%s','pieter@example.invalid','Pieter','EMP-0004','ORG_ADMIN');"%T)
```

- [ ] **Step 7: Confirm the seeded users break no pinned expectation**

```bash
make db-reset && make db-test
```

Expected: `ALL CHECKS PASSED`. The one at risk is the check pinning tenant 1 at exactly one `user_depot` row (`db/tests/004_tests.sql:399-401`) — neither new user has one, so it must still read 1. If any pin breaks, stop and report which and why before changing it.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/000014_actor_scope_views.up.sql db/migrations/000014_actor_scope_views.down.sql db/tests/004_tests.sql db/seeds/gen_seed_fixture.py
git commit -m "feat(db): TYRE-56 actor depot and task scope predicates"
```

---

### Task 2: The authorisation vocabulary

**Files:**
- Create: `api/internal/auth/auth.go`
- Test: `api/internal/auth/auth_test.go`

**Interfaces:**
- Consumes: nothing. This package deliberately imports neither `net/http` nor `pgx`.
- Produces: `auth.Role` (string type) with constants `RoleDriver`, `RoleTechnician`, `RoleController`, `RoleDepotManager`, `RoleOrgAdmin`, `RolePlatformAdmin`; `auth.Capability` with `ViewFleet`, `CaptureInspection`, `ManageAssignments`, `ManageAssets`, `LogRetread`, `ManageConfig`, `ManageUsers`; `auth.Actor{UserID, TenantID uuid.UUID; DisplayName string; Role Role; DepotIDs []uuid.UUID}` with methods `Can(Capability) bool` and `Capabilities() []Capability`. Task 3 constructs `Actor`; Tasks 4 and 5 call `Can`.

- [ ] **Step 1: Write the failing test**

Create `api/internal/auth/auth_test.go`:

```go
package auth_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"tyreplatform/api/internal/auth"
)

func TestRoleCapabilities(t *testing.T) {
	tests := []struct {
		name string
		role auth.Role
		can  []auth.Capability
		cant []auth.Capability
	}{
		{
			// FR-AUT-005: a driver captures, and does nothing else.
			name: "driver",
			role: auth.RoleDriver,
			can:  []auth.Capability{auth.CaptureInspection},
			cant: []auth.Capability{auth.ViewFleet, auth.ManageAssets, auth.LogRetread, auth.ManageConfig, auth.ManageUsers},
		},
		{
			// FR-AUT-006 with §4.7: a technician reads, and has no lifecycle
			// screens at all.
			name: "technician",
			role: auth.RoleTechnician,
			can:  []auth.Capability{auth.ViewFleet},
			cant: []auth.Capability{auth.CaptureInspection, auth.ManageAssets, auth.LogRetread, auth.ManageConfig},
		},
		{
			// FR-AUT-007 with FR-FIT-018: both controller jobs are this role.
			name: "controller",
			role: auth.RoleController,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread},
			cant: []auth.Capability{auth.ManageConfig, auth.ManageUsers},
		},
		{
			// FR-AUT-008: every CONTROLLER permission. The narrowing is by
			// depot in the scope views, never by withholding a capability.
			name: "depot manager",
			role: auth.RoleDepotManager,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread},
			cant: []auth.Capability{auth.ManageConfig, auth.ManageUsers},
		},
		{
			name: "org admin",
			role: auth.RoleOrgAdmin,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ManageConfig, auth.ManageUsers},
			cant: nil,
		},
		{
			// ADR-0011: platform admin rows carry a NULL tenant_id and are
			// invisible in a tenant session, so it can never be the actor on
			// a tenant-scoped request.
			name: "platform admin",
			role: auth.RolePlatformAdmin,
			can:  nil,
			cant: []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageUsers},
		},
		{
			// A value the database grew and Go has not learned yet must fail
			// closed, not open.
			name: "unknown role",
			role: auth.Role("NOT_A_ROLE"),
			can:  nil,
			cant: []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssets},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := auth.Actor{Role: tt.role}
			for _, c := range tt.can {
				require.True(t, a.Can(c), "%s must hold %s", tt.role, c)
			}
			for _, c := range tt.cant {
				require.False(t, a.Can(c), "%s must not hold %s", tt.role, c)
			}
			require.Len(t, a.Capabilities(), len(tt.can), "Capabilities must list exactly what Can allows")
		})
	}
}

// Capabilities feeds GET /api/me, so a caller mutating the returned slice
// must not be able to grant itself something on the next request.
func TestCapabilitiesIsACopy(t *testing.T) {
	a := auth.Actor{Role: auth.RoleDriver}
	got := a.Capabilities()
	require.Equal(t, []auth.Capability{auth.CaptureInspection}, got)

	got[0] = auth.ManageUsers
	require.Equal(t, []auth.Capability{auth.CaptureInspection}, a.Capabilities())
	require.False(t, a.Can(auth.ManageUsers))
}
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
make api-test
```

Expected: FAIL — `no required module provides package tyreplatform/api/internal/auth`.

- [ ] **Step 3: Write the package**

Create `api/internal/auth/auth.go`:

```go
// Package auth holds the authorisation vocabulary: who is acting, what role
// they hold, and what that role may do. It knows nothing of HTTP and nothing
// of SQL — the resolver supplies identity, the store supplies the role, and
// this package answers only "may they".
package auth

import "github.com/google/uuid"

// Role mirrors app.user_role. The database is the authority (ADR-0011); this
// type exists only so Go can hold the value it read.
type Role string

const (
	RoleDriver        Role = "DRIVER"
	RoleTechnician    Role = "TECHNICIAN"
	RoleController    Role = "CONTROLLER"
	RoleDepotManager  Role = "DEPOT_MANAGER"
	RoleOrgAdmin      Role = "ORG_ADMIN"
	RolePlatformAdmin Role = "PLATFORM_ADMIN"
)

// Capability is what a handler asserts. Handlers never test a role name: the
// fleet-controller and asset-controller jobs are one role (SRS §4.3,
// FR-FIT-018), and separating them later has to be an edit to the table
// below rather than a sweep through every handler.
type Capability string

const (
	ViewFleet         Capability = "ViewFleet"
	CaptureInspection Capability = "CaptureInspection"
	ManageAssignments Capability = "ManageAssignments"
	ManageAssets      Capability = "ManageAssets"
	LogRetread        Capability = "LogRetread"
	ManageConfig      Capability = "ManageConfig"
	ManageUsers       Capability = "ManageUsers"
)

// FR-AUT-005..009. DEPOT_MANAGER holds everything CONTROLLER does: FR-AUT-008
// narrows it by depot, and that narrowing lives in the scope views, not here.
// PLATFORM_ADMIN holds nothing — its rows carry a NULL tenant_id and cannot be
// seen from inside a tenant session, so it is never the actor on a
// tenant-scoped request (ADR-0011). A role absent from this map holds nothing,
// which is what makes an unrecognised value fail closed.
var capabilities = map[Role][]Capability{
	RoleDriver:       {CaptureInspection},
	RoleTechnician:   {ViewFleet},
	RoleController:   {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread},
	RoleDepotManager: {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread},
	RoleOrgAdmin:     {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ManageConfig, ManageUsers},
}

// Actor is the resolved caller: who they are, which tenant they act for, and
// what the database says they may do.
type Actor struct {
	UserID      uuid.UUID
	TenantID    uuid.UUID
	DisplayName string
	Role        Role
	DepotIDs    []uuid.UUID
}

func (a Actor) Can(c Capability) bool {
	for _, held := range capabilities[a.Role] {
		if held == c {
			return true
		}
	}
	return false
}

// Capabilities lists what the actor may do, for GET /api/me. The client uses
// it to decide what to render; the server re-checks on every request
// (NFR-SEC-006). The copy is deliberate — the caller must not be able to
// edit the table through the slice it is handed.
func (a Actor) Capabilities() []Capability {
	held := capabilities[a.Role]
	out := make([]Capability, len(held))
	copy(out, held)
	return out
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
make api-test
```

Expected: PASS for every `TestRoleCapabilities` subtest and `TestCapabilitiesIsACopy`.

- [ ] **Step 5: Commit**

```bash
git add api/internal/auth/
git commit -m "feat(api): TYRE-56 role and capability vocabulary"
```

---

### Task 3: Resolve the actor inside the tenant transaction

**Files:**
- Modify: `api/internal/store/store.go` (append after `InTenantTx`, ends line 67)
- Test: `api/internal/store/store_test.go` (append)

**Interfaces:**
- Consumes: `auth.Actor`, `auth.Role` (Task 2); `app.v_actor_depot` (Task 1).
- Produces: `store.ErrNoSuchActor` (an `error` value) and `(*Store).InActorTx(ctx context.Context, tenantID, userID uuid.UUID, fn func(pgx.Tx, auth.Actor) error) error`. Tasks 4 and 5 call it.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/store/store_test.go`. Note the imports it needs — add `"errors"` and `"tyreplatform/api/internal/auth"` to the existing import block:

```go
// plantUser adds a user to a planted tenant via the admin connection. The
// role is bound like any other parameter; the cast is what tells Postgres the
// text is a user_role.
func plantUser(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, role auth.Role, active bool) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var userID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role, active)
		 VALUES ($1, $2, $3, $4::app.user_role, $5) RETURNING id`,
		tenantID, "store-test-"+suffix+"@example.invalid", "Store Test "+suffix, string(role), active,
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

func plantDepotFor(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, userID uuid.UUID) uuid.UUID {
	t.Helper()

	var depotID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		tenantID, "store-test-depot-"+uuid.NewString()[:8],
	).Scan(&depotID)
	require.NoError(t, err)

	_, err = admin.Exec(ctx,
		`INSERT INTO app.user_depot (tenant_id, user_id, depot_id) VALUES ($1, $2, $3)`,
		tenantID, userID, depotID,
	)
	require.NoError(t, err)
	return depotID
}

// The role is read from app.app_user, never supplied by the caller
// (ADR-0011), so planting a role and reading it back is the whole contract.
func TestInActorTxResolvesRoleAndDepotsFromTheDatabase(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleDepotManager, true)
	depotID := plantDepotFor(t, ctx, admin, a.id, userID)

	var got auth.Actor
	require.NoError(t, s.InActorTx(ctx, a.id, userID, func(_ pgx.Tx, actor auth.Actor) error {
		got = actor
		return nil
	}))

	require.Equal(t, userID, got.UserID)
	require.Equal(t, a.id, got.TenantID)
	require.Equal(t, auth.RoleDepotManager, got.Role)
	require.Equal(t, []uuid.UUID{depotID}, got.DepotIDs)
	require.True(t, got.Can(auth.ManageAssets))
}

// FR-AUT-011: deactivation is the only way a user goes away, and it must bite
// on the next request rather than at token expiry.
func TestInActorTxRefusesDeactivatedUser(t *testing.T) {
	ctx := context.Background()
	s, admin, a, _ := openFixtures(t, ctx)
	userID := plantUser(t, ctx, admin, a.id, auth.RoleController, false)

	err := s.InActorTx(ctx, a.id, userID, func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a deactivated user")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
}

// A tenant claimed wrongly, or forged, needs no special case: RLS hides the
// user row and the resolution simply finds nothing.
func TestInActorTxRefusesUserFromAnotherTenant(t *testing.T) {
	ctx := context.Background()
	s, admin, a, b := openFixtures(t, ctx)
	userInB := plantUser(t, ctx, admin, b.id, auth.RoleOrgAdmin, true)

	err := s.InActorTx(ctx, a.id, userInB, func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a user outside the bound tenant")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
}

func TestInActorTxRefusesUnknownUser(t *testing.T) {
	ctx := context.Background()
	s, _, a, _ := openFixtures(t, ctx)

	err := s.InActorTx(ctx, a.id, uuid.New(), func(_ pgx.Tx, _ auth.Actor) error {
		t.Fatal("fn must not run for a user that does not exist")
		return nil
	})
	require.ErrorIs(t, err, store.ErrNoSuchActor)
	require.True(t, errors.Is(err, store.ErrNoSuchActor))
}

// The actor binding must die with the transaction for exactly the reason the
// tenant binding does: a pooled connection must not carry one user's scope
// into the next request.
func TestActorContextDoesNotLeakAcrossTransactions(t *testing.T) {
	ctx := context.Background()
	appURL, adminURL := testURLs(t)

	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	a := plantTenant(t, ctx, admin, "actor-leak")
	userID := plantUser(t, ctx, admin, a.id, auth.RoleTechnician, true)
	plantDepotFor(t, ctx, admin, a.id, userID)

	sep := "?"
	if strings.Contains(appURL, "?") {
		sep = "&"
	}
	s, err := store.New(ctx, appURL+sep+"pool_max_conns=1")
	require.NoError(t, err)
	t.Cleanup(s.Close)

	require.NoError(t, s.InActorTx(ctx, a.id, userID, func(_ pgx.Tx, _ auth.Actor) error { return nil }))

	var count int
	err = s.Pool().QueryRow(ctx, `SELECT count(*) FROM app.user_depot`).Scan(&count)
	require.NoError(t, err)
	require.Zero(t, count, "actor context must not survive the transaction on a pooled connection")
}
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
make api-test
```

Expected: FAIL — `s.InActorTx undefined` and `undefined: store.ErrNoSuchActor`.

- [ ] **Step 3: Write the implementation**

In `api/internal/store/store.go`, add `"errors"` and `"tyreplatform/api/internal/auth"` to the import block, then append at the end of the file:

```go
// ErrNoSuchActor means the request named a user this tenant cannot see, or
// one that has been deactivated. The two are the same refusal to a client and
// distinguishable only in the log (FR-AUT-011, ADR-0011).
var ErrNoSuchActor = errors.New("actor not found or inactive")

// InActorTx runs fn inside a transaction with app.tenant_id and app.actor_id
// both bound, having first resolved the actor from app.app_user under RLS.
//
// The role is never taken from the caller. A token can be stale and a header
// can be forged; app.app_user is the register of record, and reading it here
// is what makes deactivation bite on the next request rather than at token
// expiry (ADR-0011, NFR-SEC-006).
func (s *Store) InActorTx(ctx context.Context, tenantID, userID uuid.UUID, fn func(pgx.Tx, auth.Actor) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning actor transaction: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true)`,
		tenantID.String(), userID.String()); err != nil {
		return fmt.Errorf("binding actor context: %w", err)
	}

	actor := auth.Actor{UserID: userID, TenantID: tenantID}
	var roleName string
	var active bool
	// The tenant_isolation policy does the tenant check: a user belonging to
	// another tenant is not visible here, so a wrong tenant needs no branch.
	// role is cast to text because the enum's OID is not in pgx's type map.
	err = tx.QueryRow(ctx,
		`SELECT display_name, role::text, active FROM app.app_user WHERE id = $1`, userID).
		Scan(&actor.DisplayName, &roleName, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNoSuchActor
	}
	if err != nil {
		return fmt.Errorf("resolving actor: %w", err)
	}
	if !active {
		return ErrNoSuchActor
	}
	actor.Role = auth.Role(roleName)

	depots, err := actorDepots(ctx, tx)
	if err != nil {
		return err
	}
	actor.DepotIDs = depots

	if err := fn(tx, actor); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing actor transaction: %w", err)
	}
	return nil
}

// actorDepots reads the depot scope through the single view that defines it
// (ADR-0006). The view keys on app.actor_id, already bound above, so this
// cannot read another user's scope.
func actorDepots(ctx context.Context, tx pgx.Tx) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT depot_id FROM app.v_actor_depot ORDER BY depot_id`)
	if err != nil {
		return nil, fmt.Errorf("reading actor depots: %w", err)
	}
	defer rows.Close()

	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("reading actor depots: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading actor depots: %w", err)
	}
	return ids, nil
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
make api-test
```

Expected: PASS for all five new tests and all four pre-existing `store` tests.

- [ ] **Step 5: Commit**

```bash
git add api/internal/store/
git commit -m "feat(api): TYRE-56 resolve the actor inside the tenant transaction"
```

---

### Task 4: Actor resolution at the HTTP boundary, and GET /api/me

**Files:**
- Modify: `api/internal/httpapi/httpapi.go:21-83` (replace the resolver, middleware and context accessor)
- Modify: `api/cmd/api/main.go:20-63`
- Test: `api/internal/httpapi/httpapi_test.go`
- Modify: `api/CLAUDE.md`

**Interfaces:**
- Consumes: `auth.Actor`, `auth.Capability` (Task 2); `store.InActorTx`, `store.ErrNoSuchActor` (Task 3).
- Produces: `httpapi.Identity{TenantID, UserID uuid.UUID}`; `httpapi.ActorResolver` interface with `Identify(*http.Request) (Identity, bool)`; `httpapi.HeaderActorResolver`; `httpapi.New(s *store.Store, resolver ActorResolver) http.Handler` (same name, changed second parameter). Task 5 adds handlers behind the same middleware.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/httpapi/httpapi_test.go`. Replace the existing `get` helper (lines 83-92) with one that can also send a user header, and update the three call sites in `TestBrandingWithoutTenantIsUnauthorized`, `TestVehiclesWithoutTenantIsUnauthorized` and `TestVehiclesWithNoResolverIsUnauthorized` to pass `""` as the new argument:

```go
func get(t *testing.T, h http.Handler, path, tenant, user string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if tenant != "" {
		req.Header.Set("X-Tenant-ID", tenant)
	}
	if user != "" {
		req.Header.Set("X-User-ID", user)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
```

Every pre-existing test now needs a user too, because `orgBranding` and `listVehicles` both go through `withActor` after this task. Make these five changes in the same file:

- `TestVehiclesScopedToHeaderTenant` (line 94): add `userA := plantUser(t, ctx, admin, tenantA, auth.RoleController)` after the fixtures, and call `get(t, h, "/api/vehicles", tenantA.String(), userA.String())`. `CONTROLLER` because a `DRIVER` is refused this route from Task 5 onward.
- `getBranding` (line 135): change the signature to `getBranding(t *testing.T, h http.Handler, tenant, user string) brandingBody` and pass `user` through to `get`.
- `TestBrandingScopedToHeaderTenant`, `TestBrandingDefaultsWhenAbsent` and `TestBrandingLatestEffectiveWins`: plant one user per tenant with `plantUser(t, ctx, admin, tenantID, auth.RoleDriver)` and pass its id to `getBranding`. `DRIVER` is deliberate — branding asserts no capability, and using the narrowest role proves that.
- `TestBrandingWithoutTenantIsUnauthorized`, `TestVehiclesWithoutTenantIsUnauthorized`, `TestVehiclesWithNoResolverIsUnauthorized`: pass `""` as the new user argument. These assert refusal, so no user is the point.

Then add:

```go
// plantUser adds a user to a planted tenant. The parameter is bound like any
// other; the cast is what tells Postgres the text is a user_role.
func plantUser(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID uuid.UUID, role auth.Role) uuid.UUID {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var userID uuid.UUID
	err := admin.QueryRow(ctx,
		`INSERT INTO app.app_user (tenant_id, email, display_name, role)
		 VALUES ($1, $2, $3, $4::app.user_role) RETURNING id`,
		tenantID, "httpapi-test-"+suffix+"@example.invalid", "Httpapi Test "+suffix, string(role),
	).Scan(&userID)
	require.NoError(t, err)
	return userID
}

type meBody struct {
	UserID       string   `json:"userId"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Depots       []string `json:"depots"`
}

func TestMeReportsTheRoleTheDatabaseHolds(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "me")
	userID := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantID.String(), userID.String())
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	var me meBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &me))
	require.Equal(t, userID.String(), me.UserID)
	require.Equal(t, "CONTROLLER", me.Role)
	require.Contains(t, me.Capabilities, "ManageAssets")
	require.NotContains(t, me.Capabilities, "ManageUsers")
	require.Empty(t, me.Depots)
}

func TestRequestWithoutAUserIsUnauthorized(t *testing.T) {
	h := httpapi.New(nil, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", uuid.NewString(), "").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", uuid.NewString(), "not-a-uuid").Code)
	require.Equal(t, http.StatusUnauthorized, get(t, h, "/api/me", "", uuid.NewString()).Code)
}

// A syntactically valid identity for a user this tenant cannot see is a
// refusal, not an error and not an empty success.
func TestUnknownUserIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "unknown-user")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantID.String(), uuid.NewString())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}

func TestUserFromAnotherTenantIsForbidden(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantA, _ := plantTenant(t, ctx, admin, "cross-a")
	tenantB, _ := plantTenant(t, ctx, admin, "cross-b")
	userInB := plantUser(t, ctx, admin, tenantB, auth.RoleOrgAdmin)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	rec := get(t, h, "/api/me", tenantA.String(), userInB.String())
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}
```

Add `"tyreplatform/api/internal/auth"` to the test file's imports.

- [ ] **Step 2: Run the test and verify it fails**

```bash
make api-test
```

Expected: FAIL — `undefined: httpapi.HeaderActorResolver`.

- [ ] **Step 3: Replace the resolver and middleware**

In `api/internal/httpapi/httpapi.go`, replace lines 21-83 (from the `TenantResolver` comment through `tenantFrom`) with:

```go
// Identity is who a request claims to be. It carries no role: the role is
// read from app.app_user on every request, so a stale or forged claim cannot
// grant anything (ADR-0011).
type Identity struct {
	TenantID uuid.UUID
	UserID   uuid.UUID
}

// ActorResolver names the identity a request acts as. The production
// implementation arrives with the identity provider (FR-AUT-001); until then
// only the dev header resolver exists, and main wires it in only when asked.
type ActorResolver interface {
	Identify(r *http.Request) (Identity, bool)
}

// HeaderActorResolver trusts X-Tenant-ID and X-User-ID verbatim. DEV ONLY:
// anyone who can send a header is anyone, in any tenant, so wiring this into
// a deployed environment is both a cross-tenant breach and an authentication
// bypass by construction (ADR-0011).
type HeaderActorResolver struct{}

func (HeaderActorResolver) Identify(r *http.Request) (Identity, bool) {
	tenantID, err := uuid.Parse(r.Header.Get("X-Tenant-ID"))
	if err != nil {
		return Identity{}, false
	}
	userID, err := uuid.Parse(r.Header.Get("X-User-ID"))
	if err != nil {
		return Identity{}, false
	}
	return Identity{TenantID: tenantID, UserID: userID}, true
}

func New(s *store.Store, resolver ActorResolver) http.Handler {
	r := chi.NewRouter()
	r.Get("/healthz", healthz)
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
		r.Get("/org/branding", orgBranding(s))
	})
	return r
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
}

type identityKey struct{}

// requireActor refuses any request it cannot attribute to a user in a tenant.
// A nil resolver is the safe production default: with no way to name anyone,
// no scoped route answers at all.
func requireActor(resolver ActorResolver) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if resolver == nil {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			id, ok := resolver.Identify(r)
			if !ok {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, id)))
		})
	}
}

func identityFrom(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(identityKey{}).(Identity)
	return id, ok
}

// withActor is the one place a handler turns an identity into an actor. It
// owns the refusal vocabulary so no handler invents its own: 401 means we do
// not know who you are, 403 means we do and you may not.
func withActor(w http.ResponseWriter, r *http.Request, s *store.Store, fn func(pgx.Tx, auth.Actor) error) bool {
	ctx := r.Context()
	id, ok := identityFrom(ctx)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	err := s.InActorTx(ctx, id.TenantID, id.UserID, fn)
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrNoSuchActor):
		// Deliberately indistinguishable to the client: whether the user is
		// deactivated or simply not in this tenant is not theirs to learn.
		slog.WarnContext(ctx, "refusing unresolvable actor", "tenant", id.TenantID, "user", id.UserID)
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	case errors.Is(err, errForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	default:
		slog.ErrorContext(ctx, "actor transaction failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return false
	}
}

// errForbidden lets a handler refuse from inside the transaction and have
// withActor shape the response, so the capability check reads inline with the
// query it guards rather than as a separate pre-flight.
var errForbidden = errors.New("capability not held")

// require refuses unless the actor's role carries the capability. Handlers
// assert capabilities, never role names (auth.Capability).
func require(a auth.Actor, c auth.Capability) error {
	if !a.Can(c) {
		return fmt.Errorf("%w: %s lacks %s", errForbidden, a.Role, c)
	}
	return nil
}

type meJSON struct {
	UserID       string   `json:"userId"`
	DisplayName  string   `json:"displayName"`
	Role         string   `json:"role"`
	Capabilities []string `json:"capabilities"`
	Depots       []string `json:"depots"`
}

// me tells the client what to render. Presentation only — every other
// endpoint re-checks server-side, because a client-side control is a
// convenience and never a boundary (NFR-SEC-006).
func me(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var body meJSON
		ok := withActor(w, r, s, func(_ pgx.Tx, a auth.Actor) error {
			body = meJSON{
				UserID:       a.UserID.String(),
				DisplayName:  a.DisplayName,
				Role:         string(a.Role),
				Capabilities: []string{},
				Depots:       []string{},
			}
			for _, c := range a.Capabilities() {
				body.Capabilities = append(body.Capabilities, string(c))
			}
			for _, d := range a.DepotIDs {
				body.Depots = append(body.Depots, d.String())
			}
			return nil
		})
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(body); err != nil {
			slog.ErrorContext(ctx, "encoding me", "err", err)
		}
	}
}
```

Then update the two existing handlers to use the new plumbing. In `orgBranding`, replace lines 104-131 (`ctx := r.Context()` through the closing of `InTenantTx`) with:

```go
		ctx := r.Context()
		var b brandingJSON
		ok := withActor(w, r, s, func(tx pgx.Tx, _ auth.Actor) error {
			var raw []byte
			err := tx.QueryRow(ctx,
				`SELECT value FROM app.configuration
				  WHERE key = 'branding' AND effective_from <= now()
				  ORDER BY effective_from DESC LIMIT 1`).Scan(&raw)
			if err == nil {
				return json.Unmarshal(raw, &b)
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			// The tenant_self RLS policy scopes this to the session's own row.
			if err := tx.QueryRow(ctx,
				`SELECT name FROM app.tenant`).Scan(&b.DisplayName); err != nil {
				return fmt.Errorf("reading tenant name for branding fallback: %w", err)
			}
			b.PrimaryColor = defaultPrimaryColor
			return nil
		})
		if !ok {
			return
		}
```

`listVehicles` must move too, or the package will not compile: the block you just replaced contained `tenantFrom`, which it calls. Convert it now with **no** capability assertion — Task 5 adds the gate and the depot-scope switch. Replace its body (lines 152-187 of the original file) with:

```go
		ctx := r.Context()
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, _ auth.Actor) error {
			rows, err := tx.Query(ctx,
				`SELECT id, fleet_number, registration FROM app.vehicle ORDER BY fleet_number`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var v vehicleJSON
				if err := rows.Scan(&v.ID, &v.FleetNumber, &v.Registration); err != nil {
					return err
				}
				vehicles = append(vehicles, v)
			}
			return rows.Err()
		})
		if !ok {
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(vehicles); err != nil {
			slog.ErrorContext(ctx, "encoding vehicles", "err", err)
		}
```

Add `"tyreplatform/api/internal/auth"` to the imports.

- [ ] **Step 4: Update main.go to wire the actor resolver**

In `api/cmd/api/main.go`, replace lines 20-26 and 55-63 with:

```go
// devHeaderEnabled decides whether the trust-any-header resolver may exist in
// this process. Container Apps injects CONTAINER_APP_NAME into every deployed
// revision, so its presence vetoes the flag: the dev path cannot be switched
// on in staging with a stray --set-env-vars, only run locally.
func devHeaderEnabled(getenv func(string) string) bool {
	return getenv("APP_DEV_TENANT_HEADER") == "1" && getenv("CONTAINER_APP_NAME") == ""
}
```

and

```go
	// Identity has no production source until the identity provider lands
	// (FR-AUT-001); the dev header resolver must be asked for by name and
	// defaults to off. httpapi.requireActor documents what a nil resolver
	// means.
	var resolver httpapi.ActorResolver
	if devHeaderEnabled(os.Getenv) {
		logger.Warn("X-Tenant-ID/X-User-ID header resolver enabled; anyone who can send a header is anyone")
		resolver = httpapi.HeaderActorResolver{}
	}
```

- [ ] **Step 5: Run the tests and verify they pass**

```bash
make api-test
```

Expected: PASS. `TestMeReportsTheRoleTheDatabaseHolds`, the three refusal tests, and every pre-existing test still green (after the `get` call-site updates from Step 1).

- [ ] **Step 6: Record the widened dev-resolver risk where an engineer will meet it**

In `api/CLAUDE.md`, find the section describing the dev tenant header and add:

```markdown
The dev resolver now supplies a **user** as well as a tenant. Locally, anyone
who can send a header is anyone, in any tenant, so the capability gate is
decorative in development — it is a development convenience with the blast
radius of an authentication bypass. The `CONTAINER_APP_NAME` veto in
`devHeaderEnabled` is the whole safety story; ADR-0011 records why.
```

- [ ] **Step 7: Commit**

```bash
git add api/internal/httpapi/ api/cmd/api/main.go api/CLAUDE.md
git commit -m "feat(api): TYRE-56 actor resolution at the boundary and GET /api/me"
```

---

### Task 5: Capability-gated and scope-composed endpoints

**Files:**
- Modify: `api/internal/httpapi/httpapi.go` (rewrite `listVehicles`, add `listMyVehicles` and `listMyTasks`, register both)
- Test: `api/internal/httpapi/httpapi_test.go`

**Interfaces:**
- Consumes: `withActor`, `require`, `errForbidden` (Task 4); `app.v_depot_vehicle`, `app.v_driver_vehicle`, `app.v_my_inspection_task` (Task 1).
- Produces: `GET /api/vehicles`, `GET /api/my/vehicles`, `GET /api/my/tasks`. Task 7 consumes all three from the web app.

- [ ] **Step 1: Write the failing test**

Append to `api/internal/httpapi/httpapi_test.go`:

```go
func plantDepotVehicle(t *testing.T, ctx context.Context, admin *pgx.Conn, tenantID, userID uuid.UUID) string {
	t.Helper()
	suffix := uuid.NewString()[:8]

	var depotID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.depot (tenant_id, name, type) VALUES ($1, $2, 'DEPOT') RETURNING id`,
		tenantID, "depot-"+suffix,
	).Scan(&depotID))

	_, err := admin.Exec(ctx,
		`INSERT INTO app.user_depot (tenant_id, user_id, depot_id) VALUES ($1, $2, $3)`,
		tenantID, userID, depotID)
	require.NoError(t, err)

	var configID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`INSERT INTO app.axle_configuration (tenant_id, code, name, axle_count)
		 VALUES ($1, 'DEPOTTEST', 'depot test rig', 2) RETURNING id`, tenantID,
	).Scan(&configID))

	fleet := "DEPOT-" + suffix
	_, err = admin.Exec(ctx,
		`INSERT INTO app.vehicle (tenant_id, fleet_number, configuration_id, home_depot_id)
		 VALUES ($1, $2, $3, $4)`,
		tenantID, fleet, configID, depotID)
	require.NoError(t, err)
	return fleet
}

func fleetNumbers(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var vehicles []struct {
		FleetNumber string `json:"fleetNumber"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &vehicles))
	out := []string{}
	for _, v := range vehicles {
		out = append(out, v.FleetNumber)
	}
	return out
}

// FR-AUT-005 as a route rather than a filter: the fleet list is not a driver's
// to read at all, and ADR-0006 names these per-role tests as the only thing
// standing between a handler that skips the scope view and a quiet
// intra-tenant overexposure.
func TestFleetListIsCapabilityGated(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "gate")

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	tests := []struct {
		role auth.Role
		want int
	}{
		{auth.RoleDriver, http.StatusForbidden},
		{auth.RoleTechnician, http.StatusOK},
		{auth.RoleDepotManager, http.StatusOK},
		{auth.RoleController, http.StatusOK},
		{auth.RoleOrgAdmin, http.StatusOK},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			userID := plantUser(t, ctx, admin, tenantID, tt.role)
			rec := get(t, h, "/api/vehicles", tenantID.String(), userID.String())
			require.Equal(t, tt.want, rec.Code, rec.Body.String())
		})
	}
}

// FR-AUT-006/008: the depot roles read the fleet through the depot predicate,
// so a unit based elsewhere in the same tenant is invisible to them while a
// CONTROLLER sees both.
func TestFleetListIsDepotScopedForDepotRoles(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, elsewhere := plantTenantWithVehicle(t, ctx, admin, "scoped")
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)
	mine := plantDepotVehicle(t, ctx, admin, tenantID, technician)
	controller := plantUser(t, ctx, admin, tenantID, auth.RoleController)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	scoped := fleetNumbers(t, get(t, h, "/api/vehicles", tenantID.String(), technician.String()))
	require.Contains(t, scoped, mine)
	require.NotContains(t, scoped, elsewhere, "a depot-scoped role must not see a unit based elsewhere")

	whole := fleetNumbers(t, get(t, h, "/api/vehicles", tenantID.String(), controller.String()))
	require.Contains(t, whole, mine)
	require.Contains(t, whole, elsewhere, "a controller reads the whole tenant (FR-AUT-007)")
}

// A driver out of scope gets an empty list, not a refusal: they are entitled
// to ask what they are assigned, and the answer is legitimately nothing.
func TestDriverVehiclesAreAssignmentScoped(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, fleet := plantTenantWithVehicle(t, ctx, admin, "assigned")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	other := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)

	var vehicleID uuid.UUID
	require.NoError(t, admin.QueryRow(ctx,
		`SELECT id FROM app.vehicle WHERE tenant_id = $1 AND fleet_number = $2`, tenantID, fleet,
	).Scan(&vehicleID))
	_, err := admin.Exec(ctx,
		`INSERT INTO app.vehicle_driver (tenant_id, vehicle_id, user_id, from_date)
		 VALUES ($1, $2, $3, (now() AT TIME ZONE 'UTC')::date - 1)`,
		tenantID, vehicleID, driver)
	require.NoError(t, err)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, []string{fleet},
		fleetNumbers(t, get(t, h, "/api/my/vehicles", tenantID.String(), driver.String())))
	require.Empty(t,
		fleetNumbers(t, get(t, h, "/api/my/vehicles", tenantID.String(), other.String())),
		"an unassigned driver sees nothing, and that is an empty list rather than a refusal")
}

func TestMyTasksNeedsCaptureCapability(t *testing.T) {
	ctx := context.Background()
	s, admin := testStore(t, ctx)
	tenantID, _ := plantTenant(t, ctx, admin, "tasks")
	driver := plantUser(t, ctx, admin, tenantID, auth.RoleDriver)
	technician := plantUser(t, ctx, admin, tenantID, auth.RoleTechnician)

	h := httpapi.New(s, httpapi.HeaderActorResolver{})

	require.Equal(t, http.StatusOK, get(t, h, "/api/my/tasks", tenantID.String(), driver.String()).Code)
	require.Equal(t, http.StatusForbidden, get(t, h, "/api/my/tasks", tenantID.String(), technician.String()).Code)
}
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
make api-test
```

Expected: FAIL — `TestFleetListIsCapabilityGated/DRIVER` gets 200 where 403 is wanted, and `/api/my/vehicles` 404s.

- [ ] **Step 3: Write the handlers**

In `api/internal/httpapi/httpapi.go`, register the two new routes inside `New`:

```go
	r.Route("/api", func(r chi.Router) {
		r.Use(requireActor(resolver))
		r.Get("/me", me(s))
		r.Get("/vehicles", listVehicles(s))
		r.Get("/my/vehicles", listMyVehicles(s))
		r.Get("/my/tasks", listMyTasks(s))
		r.Get("/org/branding", orgBranding(s))
	})
```

Replace `listVehicles` (lines 151-188 of the original file) with:

```go
// listVehicles is the management fleet list. A DRIVER does not hold ViewFleet
// and is refused here rather than filtered — FR-AUT-005 is about what they
// may ask for, not only about what comes back. Their route is /api/my/vehicles.
//
// The depot roles read through app.v_depot_vehicle rather than re-deriving
// the join; there is exactly one definition of "within my depots" and it is
// in SQL (ADR-0006, FR-AUT-006/008).
func listVehicles(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.ViewFleet); err != nil {
				return err
			}
			source := `app.vehicle`
			if a.Role == auth.RoleTechnician || a.Role == auth.RoleDepotManager {
				source = `app.v_depot_vehicle`
			}
			var err error
			vehicles, err = scanVehicles(ctx, tx,
				`SELECT id, fleet_number, registration FROM `+source+` ORDER BY fleet_number`)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, vehicles)
	}
}

// listMyVehicles is the driver's own list, through the single predicate that
// defines "currently assigned to me" (FR-AUT-005, app.v_driver_vehicle).
// A driver assigned nothing gets an empty list: asking is legitimate, and the
// answer is legitimately nothing.
func listMyVehicles(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		vehicles := []vehicleJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			var err error
			vehicles, err = scanVehicles(ctx, tx,
				`SELECT DISTINCT vehicle_id, fleet_number, registration
				   FROM app.v_driver_vehicle ORDER BY fleet_number`)
			return err
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, vehicles)
	}
}

type taskJSON struct {
	ID          string `json:"id"`
	VehicleID   string `json:"vehicleId"`
	FleetNumber string `json:"fleetNumber"`
	DueAt       string `json:"dueAt"`
	State       string `json:"state"`
	Overdue     bool   `json:"overdue"`
}

// listMyTasks is the driver's outstanding work (FR-DSH-012). Overdue is
// computed in the view, not here: it is an OPEN task past its due date and
// never a state the client may infer for itself.
func listMyTasks(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		tasks := []taskJSON{}
		ok := withActor(w, r, s, func(tx pgx.Tx, a auth.Actor) error {
			if err := require(a, auth.CaptureInspection); err != nil {
				return err
			}
			rows, err := tx.Query(ctx,
				`SELECT t.id, t.vehicle_id, v.fleet_number, t.due_at, t.state::text, t.overdue
				   FROM app.v_my_inspection_task t
				   JOIN app.vehicle v ON v.id = t.vehicle_id
				  ORDER BY t.due_at`)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var t taskJSON
				var due time.Time
				if err := rows.Scan(&t.ID, &t.VehicleID, &t.FleetNumber, &due, &t.State, &t.Overdue); err != nil {
					return err
				}
				t.DueAt = due.UTC().Format(time.RFC3339)
				tasks = append(tasks, t)
			}
			return rows.Err()
		})
		if !ok {
			return
		}
		writeJSON(ctx, w, tasks)
	}
}

func scanVehicles(ctx context.Context, tx pgx.Tx, query string) ([]vehicleJSON, error) {
	rows, err := tx.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	vehicles := []vehicleJSON{}
	for rows.Next() {
		var v vehicleJSON
		if err := rows.Scan(&v.ID, &v.FleetNumber, &v.Registration); err != nil {
			return nil, err
		}
		vehicles = append(vehicles, v)
	}
	return vehicles, rows.Err()
}

// writeJSON keeps the empty case an empty array rather than null: a client
// distinguishing "no rows" from "field absent" is a bug waiting to happen.
func writeJSON(ctx context.Context, w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.ErrorContext(ctx, "encoding response", "err", err)
	}
}
```

Add `"time"` to the imports.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
make api-test
```

Expected: PASS for all four new tests and every pre-existing test.

- [ ] **Step 5: Run the whole backend gate**

```bash
make db-reset && make db-test && make api-test
```

Expected: `ALL CHECKS PASSED` and `ok tyreplatform/api/...` for all three packages.

- [ ] **Step 6: Commit**

```bash
git add api/internal/httpapi/
git commit -m "feat(api): TYRE-56 capability-gated fleet, driver and task endpoints"
```

---

### Task 6: A DOM test environment and a router

**Files:**
- Modify: `web/package.json`
- Modify: `web/vite.config.ts`
- Create: `web/src/test/setup.ts`
- Create: `web/src/routes.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/main.tsx`
- Test: `web/src/routes.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a working `render()` in Vitest, and `web/src/routes.tsx` exporting `AppRoutes` — a `<Routes>` element mounted inside a `<BrowserRouter>` in `main.tsx`. Task 7 adds capability guards to it.

- [ ] **Step 1: Add the dependencies**

```bash
cd web && npm install --save react-router && npm install --save-dev jsdom @testing-library/react
```

`react-router` v7 is the router package (v6's `react-router-dom` is superseded). Then check the age gate the repo enforces:

```bash
cd .. && make deps-age
```

Expected: pass. If a package is younger than the `.npmrc` window, pin to the newest version that satisfies it rather than widening the window.

- [ ] **Step 2: Configure Vitest for the DOM**

Replace `web/vite.config.ts` with:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// PWA config (vite-plugin-pwa, service worker) arrives with the capture app
// (TYRE-4). ADR-0009 settled the sync design: online-first with a durable
// submit outbox — never Background Sync, which iOS Safari does not have.
export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin /api in dev; `make api-run` serves :8080. Keeping the
    // browser origin-clean means no CORS configuration to un-learn later.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  test: {
    // Components could not be rendered in a test before this: Vitest defaults
    // to the node environment, which has no document.
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Create `web/src/test/setup.ts`:

```ts
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this a component from one test is still mounted during the next,
// and queries match the wrong tree.
afterEach(cleanup);
```

- [ ] **Step 3: Write the failing test**

Create `web/src/routes.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppRoutes } from "./routes";

// VehicleList fetches through TanStack Query, so it throws without a client
// in scope. A fresh client per render keeps one test's cache out of the next.
function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppRoutes", () => {
  it("renders the vehicle list at the root", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: /vehicles/i })).toBeDefined();
  });

  it("renders a not-found view for an unknown path", () => {
    renderAt("/nowhere");
    expect(screen.getByText(/not found/i)).toBeDefined();
  });
});
```

The heading `VehicleList` renders is `<h1 id="vehicles-heading">Vehicles</h1>`
(`web/src/dashboard/VehicleList.tsx:19`), which is what `/vehicles/i` matches.

- [ ] **Step 4: Run the test and verify it fails**

```bash
make web-test
```

Expected: FAIL — `Failed to resolve import "./routes"`.

- [ ] **Step 5: Write the routes**

Create `web/src/routes.tsx`:

```tsx
import { Route, Routes } from "react-router";

import { VehicleList } from "./dashboard/VehicleList";

function NotFound() {
  return <p>Not found.</p>;
}

// The route table. Capability guards arrive with the actor context; until
// then every route is reachable, which is why the API refuses rather than
// relying on the client hiding anything (NFR-SEC-006).
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<VehicleList />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
```

Update `web/src/App.tsx`:

```tsx
import { AppShell } from "./dashboard/AppShell";
import { AppRoutes } from "./routes";

// One application, one deployment: the management interface and the driver
// capture interface are routes within it, not separate apps (IR-UI-001).
export function App() {
  return (
    <AppShell>
      <AppRoutes />
    </AppShell>
  );
}
```

Update `web/src/main.tsx` to wrap the app in a router:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { ThemeProvider } from "./theme/ThemeProvider";
import { App } from "./App.tsx";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
make web-test
```

Expected: PASS for both `AppRoutes` tests and the two pre-existing test files.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts web/src/test/ web/src/routes.tsx web/src/routes.test.tsx web/src/App.tsx web/src/main.tsx
git commit -m "build(web): TYRE-56 router and a DOM test environment"
```

---

### Task 7: Actor-aware client, capability guards and role landing

**Files:**
- Create: `web/src/auth/me.ts`
- Create: `web/src/auth/ActorProvider.tsx`
- Create: `web/src/auth/actorContext.ts`
- Create: `web/src/auth/RequireCapability.tsx`
- Create: `web/src/driver/DriverHome.tsx`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/devTenant.ts`
- Modify: `web/src/api/vehicles.ts`
- Modify: `web/src/routes.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/dashboard/AppShell.tsx`
- Modify: `web/CLAUDE.md`
- Test: `web/src/auth/RequireCapability.test.tsx`

**Interfaces:**
- Consumes: `GET /api/me`, `GET /api/my/vehicles`, `GET /api/my/tasks` (Tasks 4 and 5); `AppRoutes` (Task 6).
- Produces: `Me` interface `{userId, displayName, role, capabilities, depots}`; `useActor(): Me | null`; `<RequireCapability capability="…">`.

- [ ] **Step 1: Write the failing test**

Create `web/src/auth/RequireCapability.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ActorContext } from "./actorContext";
import { RequireCapability } from "./RequireCapability";
import type { Me } from "./me";

const actor = (capabilities: string[]): Me => ({
  userId: "00000000-0000-0000-0000-000000000001",
  displayName: "Test",
  role: "CONTROLLER",
  capabilities,
  depots: [],
});

describe("RequireCapability", () => {
  it("renders its children when the actor holds the capability", () => {
    render(
      <ActorContext value={actor(["ManageAssets"])}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.getByText("asset tools")).toBeDefined();
  });

  // The server refuses regardless (NFR-SEC-006); hiding is a courtesy, so it
  // must be silent rather than an error the user has to read.
  it("renders nothing when the actor does not", () => {
    render(
      <ActorContext value={actor(["CaptureInspection"])}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.queryByText("asset tools")).toBeNull();
  });

  it("renders nothing while the actor is still unknown", () => {
    render(
      <ActorContext value={null}>
        <RequireCapability capability="ManageAssets">
          <p>asset tools</p>
        </RequireCapability>
      </ActorContext>,
    );
    expect(screen.queryByText("asset tools")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
make web-test
```

Expected: FAIL — `Failed to resolve import "./actorContext"`.

- [ ] **Step 3: Write the actor layer**

Create `web/src/auth/me.ts`:

```ts
import { apiGet } from "../api/client";

// Wire shape of GET /api/me (api/internal/httpapi). Capabilities are strings
// rather than a union: the server owns the vocabulary, and a client that
// cannot represent a capability it has not heard of would break on deploy
// ordering rather than degrade.
export interface Me {
  userId: string;
  displayName: string;
  role: string;
  capabilities: string[];
  depots: string[];
}

export function fetchMe(): Promise<Me> {
  return apiGet<Me>("/api/me");
}
```

Create `web/src/auth/actorContext.ts`:

```ts
import { createContext, useContext } from "react";

import type { Me } from "./me";

// Context and hook live apart from the provider component: exporting a
// component and a non-component from one module kills Vite fast refresh
// (react-refresh/only-export-components).
export const ActorContext = createContext<Me | null>(null);

export function useActor(): Me | null {
  return useContext(ActorContext);
}

export function useCan(capability: string): boolean {
  const actor = useActor();
  return actor?.capabilities.includes(capability) ?? false;
}
```

Create `web/src/auth/ActorProvider.tsx`:

```tsx
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { ActorContext } from "./actorContext";
import { fetchMe } from "./me";
import { getDevTenantId } from "../api/devTenant";

export function ActorProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["me", getDevTenantId() ?? "default"],
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
  });

  return <ActorContext value={query.data ?? null}>{children}</ActorContext>;
}
```

Create `web/src/auth/RequireCapability.tsx`:

```tsx
import type { ReactNode } from "react";

import { useCan } from "./actorContext";

// Presentation only. The server refuses the request whatever the client
// renders (NFR-SEC-006), so this hides silently rather than explaining —
// telling someone what they may not do is not information they asked for.
export function RequireCapability({
  capability,
  children,
}: {
  capability: string;
  children: ReactNode;
}) {
  return useCan(capability) ? <>{children}</> : null;
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
make web-test
```

Expected: PASS for all three `RequireCapability` tests.

- [ ] **Step 5: Send the actor header and add the dev actor switcher**

In `web/src/api/client.ts`, replace the body of `apiGet`:

```ts
// Transport only: identity attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevActorId, getDevTenantId } from "./devTenant";

export async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
```

In `web/src/api/devTenant.ts`, append:

```ts
const ACTOR_STORAGE_KEY = "tyre.dev.user-id";

export function getDevActorId(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const stored = window.localStorage.getItem(ACTOR_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage can be unavailable (private mode); the env default still applies.
  }
  return import.meta.env.VITE_DEV_USER_ID ?? null;
}

export function setDevActorId(userId: string): void {
  window.localStorage.setItem(ACTOR_STORAGE_KEY, userId);
}

// The seeded users (db/seeds/gen_seed_fixture.py). Ids are md5-derived so the
// fixture is reproducible; a user list endpoint would be gated on ManageUsers
// and is not what the dev switcher wants anyway.
export const DEV_ACTORS = [
  { id: "b85aef08-6081-80db-9d4d-dad38ae40545", name: "Melusi (driver, Johannesburg)", tenant: "11111111-1111-1111-1111-111111111111" },
  { id: "e4443562-7359-f4c3-de71-b538cdefdc14", name: "Sipho (driver, no depot)", tenant: "11111111-1111-1111-1111-111111111111" },
  { id: "14fc2c61-398c-3508-084e-d61e615e695e", name: "Nomsa (controller)", tenant: "11111111-1111-1111-1111-111111111111" },
  { id: "e00cf25a-d426-83b3-df67-8c61f42c6bda", name: "Pieter (org admin)", tenant: "11111111-1111-1111-1111-111111111111" },
  { id: "d95784fa-a659-7a02-53e4-83e500ced3ee", name: "Thabo (driver, Second Fleet)", tenant: "22222222-2222-2222-2222-222222222222" },
] as const;
```

Add `readonly VITE_DEV_USER_ID?: string;` to the `ImportMetaEnv` interface in `web/src/vite-env.d.ts`, beside the existing `VITE_DEV_TENANT_ID` declaration.

- [ ] **Step 6: Add the driver home and the role landing**

Create `web/src/driver/DriverHome.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { getDevTenantId } from "../api/devTenant";

interface Task {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
}

// FR-DSH-012: the driver's landing view is their own units and their own
// outstanding work — not the fleet, which they cannot read at all.
export function DriverHome() {
  const tenantKey = getDevTenantId() ?? "default";
  const tasks = useQuery({
    queryKey: ["my-tasks", tenantKey],
    queryFn: () => apiGet<Task[]>("/api/my/tasks"),
  });

  return (
    <section aria-labelledby="my-inspections-heading">
      {/* The heading stays outside the loading and error branches: a view
          that loses its title while fetching leaves a screen reader with
          nothing to announce, and a test with nothing to find. */}
      <h1 id="my-inspections-heading">My inspections</h1>
      {tasks.isPending && <p>Loading…</p>}
      {tasks.isError && <p role="alert">Could not load your inspections.</p>}
      {tasks.isSuccess &&
        (tasks.data.length === 0 ? (
          <p>Nothing due.</p>
        ) : (
          <ul>
            {tasks.data.map((t) => (
              <li key={t.id}>
                {t.fleetNumber} — due {new Date(t.dueAt).toLocaleDateString()}
                {/* Never colour alone (NFR-USE-009): overdue says so in words. */}
                {t.overdue ? " (overdue)" : ""}
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
```

Update `web/src/routes.tsx`:

```tsx
import { Navigate, Route, Routes } from "react-router";

import { useCan } from "./auth/actorContext";
import { RequireCapability } from "./auth/RequireCapability";
import { DriverHome } from "./driver/DriverHome";
import { VehicleList } from "./dashboard/VehicleList";

function NotFound() {
  return <p>Not found.</p>;
}

// FR-DSH-001 / FR-DSH-012: the landing view follows the role. A driver has no
// fleet view to land on, and sending them to one they would be refused is a
// worse first impression than sending them to their work.
function Landing() {
  return useCan("ViewFleet") ? <Navigate to="/fleet" replace /> : <Navigate to="/my" replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/fleet"
        element={
          <RequireCapability capability="ViewFleet">
            <VehicleList />
          </RequireCapability>
        }
      />
      <Route path="/my" element={<DriverHome />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
```

Update `web/src/routes.test.tsx`'s first case, which now needs an actor to decide where the root lands:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ActorContext } from "./auth/actorContext";
import { AppRoutes } from "./routes";
import type { Me } from "./auth/me";

const actor = (capabilities: string[]): Me => ({
  userId: "00000000-0000-0000-0000-000000000001",
  displayName: "Test",
  role: "CONTROLLER",
  capabilities,
  depots: [],
});

function renderAt(path: string, me: Me) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ActorContext value={me}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ActorContext>
    </QueryClientProvider>,
  );
}

describe("AppRoutes", () => {
  it("lands a driver on their own work rather than a fleet view they cannot read", () => {
    renderAt("/", actor(["CaptureInspection"]));
    expect(screen.getByRole("heading", { name: /my inspections/i })).toBeDefined();
  });

  it("renders a not-found view for an unknown path", () => {
    renderAt("/nowhere", actor(["ViewFleet"]));
    expect(screen.getByText(/not found/i)).toBeDefined();
  });
});
```

Wrap the app in the provider — in `web/src/main.tsx`, add `import { ActorProvider } from "./auth/ActorProvider";` and place `<ActorProvider>` immediately inside `<BrowserRouter>`, around `<ThemeProvider>`.

- [ ] **Step 7: Add the dev actor switcher to the shell**

Open `web/src/dashboard/AppShell.tsx`. It already contains `DevTenantSwitcher`, a `<select>` writing `localStorage` then calling `window.location.reload()`. Add a sibling `DevActorSwitcher` with the same shape, reading `DEV_ACTORS`, writing both the actor id and that actor's tenant with `setDevActorId` and `setDevTenantId`, then reloading. Both switchers stay behind the existing `import.meta.env.DEV` guard. Also render the actor's display name and role from `useActor()` in the shell header, so it is obvious who the app thinks you are.

- [ ] **Step 8: Point the fleet list at its route and run everything**

`VehicleList` still calls `/api/vehicles`, which is correct — it is now the `ViewFleet` route. Confirm `web/src/api/vehicles.ts` is unchanged, then:

```bash
make web-test && cd web && npm run typecheck && cd ..
```

Expected: all web tests pass and `tsc --noEmit` is clean.

- [ ] **Step 9: Record the one-app shape**

In `web/CLAUDE.md`, replace the opening line "React + Vite. Two applications: the driver capture PWA and the manager dashboard." with:

```markdown
React + Vite. **One application, one deployment** (IR-UI-001): a
mobile-optimised capture interface and a desktop-optimised management
interface, reached by role-appropriate routes within it. They share components
but not priorities — see the three-minute constraint below.
```

- [ ] **Step 10: Commit**

```bash
git add web/src/auth/ web/src/driver/ web/src/routes.tsx web/src/routes.test.tsx web/src/main.tsx web/src/api/ web/src/vite-env.d.ts web/src/dashboard/AppShell.tsx web/CLAUDE.md
git commit -m "feat(web): TYRE-56 actor context, capability guards and role landing"
```

---

### Task 8: Full verification and integration

**Files:**
- Modify: `docs/architecture.md` (the request-path description)
- No new source files.

**Interfaces:**
- Consumes: everything above.
- Produces: a branch ready to raise as a pull request.

- [ ] **Step 1: Run the complete gate**

```bash
make check
```

Expected: `fmt` clean, `lint` clean (gofmt, vet, staticcheck, eslint, tsc and the comment standard), then `db-reset`, `db-test` (`ALL CHECKS PASSED`), `api-test` and `web-test` all green. Docker Desktop must be running. If anything fails, fix it before continuing — do not proceed with a red gate.

- [ ] **Step 2: Drive it by hand once**

```bash
make db-reset
make api-run   # in one terminal, with APP_DEV_TENANT_HEADER=1 in .env
cd web && npm run dev   # in another
```

Open the app, use the dev actor switcher, and confirm by observation:
- Melusi (driver) lands on **My inspections** and cannot reach `/fleet`
- Nomsa (controller) lands on the fleet list and sees all three units
- Pieter (org admin) sees the same plus whatever `ManageConfig` gates

Then confirm the server, not the client, is the boundary:

```bash
curl -i -H "X-Tenant-ID: 11111111-1111-1111-1111-111111111111" \
        -H "X-User-ID: b85aef08-6081-80db-9d4d-dad38ae40545" \
        http://localhost:8080/api/vehicles
```

Expected: `403 Forbidden`. A driver is refused the fleet list even when the request bypasses the UI entirely.

- [ ] **Step 3: Update the architecture request path**

In `docs/architecture.md`, the diagram's API box reads `auth → tenant context → handlers` and the line below it `SET LOCAL app.tenant_id = <claim>`. Update the second to reflect what actually happens now:

```
                      │  pgx, one transaction per request
                      │  SET LOCAL app.tenant_id + app.actor_id
                      │  role read from app_user, never from a claim
```

- [ ] **Step 4: Ask the tenant-isolation auditor to review**

This branch adds views and changes how connections are scoped, which is exactly the trigger for the project's `rls-auditor` agent. Run it against the branch diff and address anything it raises before opening the pull request.

- [ ] **Step 5: Commit and push**

```bash
git add docs/architecture.md
git commit -m "docs: TYRE-56 record the actor-bound request path"
git push -u origin TYRE-56-actor-context-and-roles
```

- [ ] **Step 6: Open the pull request**

Raise it against `develop` through the GitHub web UI, per the repo's convention that merges happen in the browser. Title: `TYRE-56 actor context, roles and capability gating`. Link TYRE-56 in the body and note that FR-AUT-001 remains unmet until the identity-provider sub-project.

---

## Self-review notes

**Spec coverage.** Every component in the design maps to a task: the three scope views to Task 1 (`v_actor_depot` is a fourth, added because "which depots am I" needed one definition rather than three copies); the capability table to Task 2; `InActorTx` to Task 3; the resolver, middleware and `/api/me` to Task 4; the remaining three endpoints to Task 5; the router and DOM test environment to Task 6; `useMe`, guards and the role landing to Task 7. The per-role test matrix ADR-0006 depends on is Task 5, Steps 1-4.

**Two deviations from the spec, both deliberate.** `app.v_depot_tyre` reaches fitted tyres through their unit's home depot as well as `current_depot_id` — scoping on the column alone returns zero rows on the fixture and would hide every fitted tyre from the technician who maintains it. And `app.v_actor_depot` is a fourth view the spec did not name, for the reason above.

**One fixture change with a known risk.** Task 1, Step 6 seeds a `CONTROLLER` and an `ORG_ADMIN` so the management surfaces have someone to be in development. Neither gets a `user_depot` row, because the suite pins tenant 1 at exactly one depot-scoped user (`db/tests/004_tests.sql:399-401`). Step 7 exists to catch it if that reasoning is wrong.

**Not covered here, by design.** Entra External ID and FR-AUT-001, the IdP subject column, FR-AUT-010 invite and suspend, 2FA/PIN/lockout, `PLATFORM_ADMIN` login, and audit-log writes. Each is listed as out of scope in the spec with its reason.
