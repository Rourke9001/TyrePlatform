# Capability Map (B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `ManageConfig` to `CONTROLLER` and `DEPOT_MANAGER`, and reserve a separate `ManageTemplates` capability for `ORG_ADMIN` alone, so that axle-configuration authoring is never reachable through the widened gate.

**Architecture:** Two commits against one file and its test. `api/internal/auth/auth.go` holds the whole authorisation vocabulary; `api/internal/auth/auth_test.go` is the single authority on what the map contains. Nothing in SQL, nothing in Go outside this package, nothing in the web app. The capability table has no database mirror — `app.user_role` is an enum and the grants are modelled only here — so there is no migration in this plan. Task 1 widens, Task 2 refuses; the two-commit split is the deliverable, because the second diff is the record of the failure mode the pairing exists to prevent.

**Tech Stack:** Go 1.24 (run in `golang:1.24-alpine` under docker for host parity), `testify/require`, table-driven tests.

**Spec:** No design document — the two Jira tickets are the specification and are quoted verbatim below. TYRE-74 implements decision D1 of 25 Aug 2026 (*Decisions of Record — D1–D5*, Confluence pageId 14778369); TYRE-84 implements decision D8 of 27 Aug 2026 (*Decisions of Record — D8–D11*, Confluence pageId 16089089). Sequencing rationale: `docs/implementation-order.md`, batch B2.

**Tickets:** TYRE-74 (Task 1) · TYRE-84 (Task 2), in that order and not the other.

**Branch:** `TYRE-74-capability-map`, cut from `develop` @ `4fc3519`.

## Global Constraints

Every task's requirements implicitly include these. Violating one is a bug even if tests pass.

- **Handlers never test a role name.** A capability is what a handler asserts (`require(a, auth.SomeCapability)`); the role-to-capability mapping lives in exactly one table (ADR-0011, `api/CLAUDE.md`). Nothing in this plan may introduce a role-name comparison anywhere.
- **A role absent from the map holds nothing.** That is what makes an unrecognised role value fail closed. Do not add a default, a fallback, or a wildcard.
- **`Capabilities()` returns a copy.** `TestCapabilitiesIsACopy` pins it. Neither task changes that method; if you find yourself editing it, you have gone outside the plan.
- **Every threshold, band and rate is tenant configuration** (project rule 5). This plan adds no numeric literal of any kind.
- **Comments explain *why*, never *what*.** Never narrate a change or compare to old code. Cite the requirement ID for any non-obvious rule. `db/migrations/000001_init.up.sql` is the reference for house style; in Go, the existing comments in `auth.go` are the local reference.
- **`make lint` runs `scripts/check-comment-style.mjs` and it is blocking.** See the trap in *Decisions this plan makes* — one of D1's own erratum phrasings fails it.
- **Run `make check` before every commit.** Docker must be running (`make db-up` first — `make check` runs `db-reset`, `db-test` and the Go integration tests, all of which need Postgres on 5433).
- **No schema, no endpoint, no surface.** TYRE-76 (depot-scoped capture) and TYRE-81 (the admin write surface) both sit downstream of this map settling. Do not design toward either.

## Requirement values, copied verbatim

Do not paraphrase these into the code; they are the acceptance criteria.

| Source | Text |
| --- | --- |
| TYRE-74 | "Add ManageConfig to RoleController and RoleDepotManager in the capabilities map in api/internal/auth/auth.go. Both gain it in full: thresholds, bands and rates included. There is deliberately no narrower split capability." |
| TYRE-74 | "ManageConfig is tenant-wide by nature, because app.configuration rows are keyed by tenant and not by depot. A depot manager exercising it therefore configures the whole tenant, and that breadth is accepted rather than overlooked. Do not invent a depot-scoped variant. ManageUsers is untouched and remains ORG_ADMIN's alone." |
| TYRE-74 (comment, D8) | "ManageConfig's \"in full\" grant covers thresholds, bands, rates and cadence — it must NEVER gate axle configuration templates. Template authoring gets its own capability, ManageTemplates, ORG_ADMIN-only, reserved in TYRE-84." |
| TYRE-74 | Definition of done: "the capabilities map grants ManageConfig to RoleController and RoleDepotManager. A table-driven test asserts both hold it, and asserts DRIVER and TECHNICIAN still do not — the negative half is the half that matters, since a capability table is only as good as what it refuses. auth.scopes is NOT touched: this is a capability change, not a scope change, and DEPOT_MANAGER keeps ScopeDepot. make check is green." |
| TYRE-84 | "a wrong template silently corrupts every position on every unit that uses it. TYRE-74 grants ManageConfig to CONTROLLER and DEPOT_MANAGER in full — if template authoring were gated on ManageConfig, controllers would get template editing the day TYRE-74 lands. The two must never share a gate." |
| TYRE-84 | "add ManageTemplates to the capability table, ORG_ADMIN only, with the table-driven negative tests (CONTROLLER and DEPOT_MANAGER do not hold it). The authoring surface itself is the \"separate, larger piece\" TYRE-81 defers — this ticket reserves the gate so it exists before any such surface does." |
| TYRE-84 | Definition of done: "capability in auth.go with positive and negative assertions; TYRE-74's implementation references this ticket; make check green." |
| D1 (14778369) | "`ManageConfig` is tenant-wide by nature: `app.configuration` rows are keyed by tenant, not by depot, so a depot manager holding it configures the tenant. That is accepted, not overlooked." |
| D8 (16089089) | "Adding a unit means **picking from that library** — controllers and depot managers never author a configuration. Authoring a new configuration (an axle setup not in the library) is a separate restricted action behind a **new capability** `ManageTemplates`, ORG_ADMIN-only for the POC." |
| D8 (16089089) | "It must never be gated on `ManageConfig`: TYRE-74 grants that to controllers in full, and a wrong template silently corrupts every position on every unit using it." |
| FR-AUT-007 (SRS v1.4, erratum D1 at Part 2 v5) | Base text: "The system shall grant a `CONTROLLER` read and write access to all vehicles, tyres and inspections within their tenant." Erratum: `CONTROLLER` holds tenant configuration. |
| FR-AUT-008 (SRS v1.4, erratum D1 at Part 2 v5) | Base text: "The system shall grant a `DEPOT_MANAGER` all `CONTROLLER` permissions scoped to their assigned depots, plus depot reporting." Erratum: `DEPOT_MANAGER` holds it too; `ManageConfig` is tenant-wide and not narrowed by depot. |
| FR-AUT-009 (SRS v1.4, erratum D1 at Part 2 v5) | Base text: "The system shall grant an `ORG_ADMIN` all permissions within their tenant including configuration and user management." Erratum: `ORG_ADMIN`'s configuration rights are not exclusive; user management still is. |
| FR-CFG-001..007 | The platform-seeded axle configuration library with catalogue lineage — the 14 configurations of the Axle Configuration Reference. `ManageTemplates` gates authoring outside it. |

## Decisions this plan makes, and why

Five judgment calls, settled here so the implementer does not re-litigate them.

**1. The map's existing comment is corrected in Task 1, because D1 makes half of it untrue.**

`auth.go:43-44` currently says DEPOT_MANAGER's narrowing "lives in the scope views, not here." That is true of every capability the role holds today and false of `ManageConfig` the moment Task 1 lands: `app.configuration` is keyed by tenant, so there is no scope view for a depot manager's configuration reach to live in, and there is not going to be one. Leaving the sentence unqualified would tell the next reader a narrowing exists that does not — which is the precise misreading that would produce a depot-scoped variant D1 forbids. The exception is stated in the comment.

**2. The `change-narration` comment rule will reject D1's own erratum wording. Do not copy it.**

`scripts/check-comment-style.mjs` fails any comment matching `/\bno longer(?! than)\b/i`, among other change-narration phrases. D1's consolidated erratum for FR-AUT-009 reads "`ORG_ADMIN`'s configuration rights are **no longer** exclusive" — pasting that sentence into a Go comment fails `make lint`. State the constraint in the present tense instead: configuration rights are shared; user management is not. The same rule also blocks `previously`, `used to be`, `the old behaviour`, `renamed from` and `as before`. Comments here describe what the table guarantees now, never what it guaranteed before.

**3. `ManageTemplates` is declared directly beneath `ManageConfig`, not appended to the end of the constant block.**

The two constants are one decision read from two sides, and the point of maximum confusion for a future reader is exactly where they sit adjacent. Placing the boundary comment between them puts the rationale at the line that needs it. Note that `gofmt` aligns contiguous runs of const declarations, so inserting a commented line splits the alignment group and reflows neighbouring lines — the diff is wider than the logical change. Run `make fmt` and accept its output; do not hand-align.

**4. `httpapi_test.go` and the web app are deliberately not touched.**

Considered and rejected, recorded so a reviewer sees they were not missed:

- `api/internal/httpapi/httpapi_test.go:475-476` asserts a CONTROLLER's `/api/me` payload contains `ManageAssets` and not `ManageUsers`. Both remain true after both tasks. It already proves the wire-carries-the-table mechanics; adding `ManageConfig` and `ManageTemplates` assertions there would duplicate `auth_test.go` in a second place that can drift from it.
- `web/src/shell/navigation.test.ts:14-25` passes a capability list to `navItemsFor` as *input*, and no nav item is gated on `ManageConfig` or `ManageTemplates`. It passes unchanged. Adding `ManageTemplates` to that illustrative list is a fidelity nit that widens the branch past the map.
- No handler gates on `ManageConfig` today — verified with a repo-wide search; `httpapi.go` has no reference to it. The widening therefore changes the `/api/me` payload for two roles and nothing else. That is why it is cheap now and expensive once surfaces exist.

**5. `RoleController` and `RoleDepotManager` hold identical slices after Task 1. Do not collapse them.**

Sharing one variable, or deriving one from the other, would make a future divergence a structural edit rather than a table edit — which is the thing the comment at `auth.go:22-25` exists to prevent. Two entries that happen to agree today are correct.

## What must not change

- **`scopes` is untouched.** This is a capability change, not a scope change. `DEPOT_MANAGER` keeps `ScopeDepot` and `TestScopeDefaultsToDepot` already pins it — cite that test rather than adding an assertion to it.
- **`ManageUsers` stays `ORG_ADMIN`'s alone.** D9 reconfirms it; the tiered-invite capability is TYRE-83's, not this branch's.
- **No depot-scoped `ManageConfig` variant.** D1 records the breadth as accepted and says not to re-litigate it.
- **No `ManageTemplates` for `PLATFORM_ADMIN`**, despite D8's "in practice a customer phones support". `PLATFORM_ADMIN` rows carry a `NULL tenant_id`, are invisible inside a tenant session, and are never the actor on a tenant-scoped request (ADR-0011). It holds nothing, and that stays true.
- **No new capability beyond `ManageTemplates`.** D9's finer invite capability belongs to TYRE-83.

## Running the tests

The auth package is a pure unit test with no database dependency, so the inner loop does not need `make db-up`:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod \
  golang:1.24-alpine go test ./internal/auth/ -v
```

Verified green against `4fc3519` before this plan was written: `TestRoleCapabilities` (7 subtests), `TestCapabilitiesIsACopy`, `TestScopeDefaultsToDepot` (8 subtests).

`make check` at the end of each task needs Docker and Postgres up, because it runs `db-reset`, `db-test`, the Go integration tests and the web suite.

---

### Task 1: TYRE-74 — `ManageConfig` for CONTROLLER and DEPOT_MANAGER

**Files:**
- Modify: `api/internal/auth/auth.go:43-55` (the map comment and two map entries)
- Test: `api/internal/auth/auth_test.go:34-50` (the controller and depot-manager rows)

**Interfaces:**
- Consumes: nothing. This is the first task on the branch.
- Produces: `auth.ManageConfig` held by `auth.RoleController` and `auth.RoleDepotManager`. `Actor.Can(auth.ManageConfig)` returns `true` for both; `Actor.Capabilities()` returns 7 entries for each. Task 2 depends on those counts.

- [ ] **Step 1: Write the failing test**

In `api/internal/auth/auth_test.go`, move `auth.ManageConfig` from `cant` to the end of `can` in the controller row, and update the comment to cite the erratum. Replace the controller case (currently lines 34-41) with:

```go
		{
			// FR-AUT-007 with FR-FIT-018: both controller jobs are this role.
			// FR-AUT-005a: a controller carries the commercial picture.
			// FR-AUT-007 carries erratum D1 — the cadence belongs to whoever
			// is responsible for the drivers, and an ORG_ADMIN is not.
			name: "controller",
			role: auth.RoleController,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig},
			cant: []auth.Capability{auth.ManageUsers},
		},
```

Then the depot-manager case (currently lines 42-50):

```go
		{
			// FR-AUT-008: every CONTROLLER permission, ViewValuation included.
			// The narrowing is by depot in the scope views, never by
			// withholding a capability — and ManageConfig has no narrowing at
			// all, since app.configuration is keyed by tenant (D1).
			name: "depot manager",
			role: auth.RoleDepotManager,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig},
			cant: []auth.Capability{auth.ManageUsers},
		},
```

Leave the driver row (line 24) and technician row (line 32) exactly as they are: both already list `auth.ManageConfig` in `cant`, which is TYRE-74's required negative half. Do not duplicate it.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod \
  golang:1.24-alpine go test ./internal/auth/ -run TestRoleCapabilities -v
```

Expected: FAIL on `TestRoleCapabilities/controller` and `TestRoleCapabilities/depot_manager`, each reporting `CONTROLLER must hold ManageConfig` / `DEPOT_MANAGER must hold ManageConfig`. Exactly one failure per subtest: these are `require` assertions, so `FailNow` aborts the subtest at the first one, and the `require.Len` at line 85 is never reached in this run. That is expected — the length assertion guards the opposite drift, a `can` list that has fallen behind a map entry, and it is what will catch a future grant added to the map without a test.

- [ ] **Step 3: Write the minimal implementation**

In `api/internal/auth/auth.go`, replace the map comment and the two entries (lines 43-55) with:

```go
// FR-AUT-005..009, carrying erratum D1. DEPOT_MANAGER holds everything
// CONTROLLER does: FR-AUT-008 narrows it by depot, and that narrowing lives in
// the scope views, not here. ManageConfig is the one capability with no
// narrowing to live anywhere — app.configuration is keyed by tenant, not by
// depot, so a depot manager holding it configures the whole tenant. D1 accepts
// that breadth deliberately; there is no depot-scoped variant to reach for, and
// template authoring is held away from it entirely (TYRE-84).
// PLATFORM_ADMIN holds nothing — its rows carry a NULL tenant_id and cannot be
// seen from inside a tenant session, so it is never the actor on a
// tenant-scoped request (ADR-0011). A role absent from this map holds nothing,
// which is what makes an unrecognised value fail closed.
var capabilities = map[Role][]Capability{
	RoleDriver:       {CaptureInspection},
	RoleTechnician:   {ViewFleet},
	RoleController:   {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig},
	RoleDepotManager: {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig},
	RoleOrgAdmin:     {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig, ManageUsers},
}
```

`RoleOrgAdmin` is unchanged — it is reproduced here only so the whole map reads correctly in one block.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod \
  golang:1.24-alpine go test ./internal/auth/ -v
```

Expected: PASS, all three tests and all 15 subtests.

- [ ] **Step 5: Run the full check**

```bash
make check
```

Expected: green. `make fmt` runs first and may reflow the map's alignment; that is expected and its output is authoritative. If `make lint` reports a `change-narration` finding, re-read decision 2 above — the comment is describing history rather than the constraint.

- [ ] **Step 6: Commit**

```bash
git add api/internal/auth/auth.go api/internal/auth/auth_test.go
git commit -m "feat(auth): TYRE-74 grant ManageConfig to CONTROLLER and DEPOT_MANAGER

Decision D1 of 25 Aug 2026. An ORG_ADMIN will not have time for day-to-day
cadence; the person responsible for the drivers owns it. Granted in full —
thresholds, bands, rates and cadence — with no narrower split capability and
no depot-scoped variant: app.configuration is keyed by tenant, so a depot
manager exercising it configures the whole tenant, which D1 accepts.

ManageUsers is untouched and stays ORG_ADMIN's alone, and auth.scopes is not
touched at all: DEPOT_MANAGER keeps ScopeDepot. Template authoring is kept
off this gate deliberately and gets its own capability in TYRE-84.

SRS Part 2 v5 carries erratum D1 against FR-AUT-007/008/009."
```

---

### Task 2: TYRE-84 — `ManageTemplates`, ORG_ADMIN only

**Files:**
- Modify: `api/internal/auth/auth.go:28-41` (the `Capability` constant block) and the `RoleOrgAdmin` map entry
- Test: `api/internal/auth/auth_test.go` (the org-admin row, plus `cant` entries on four other rows)

**Interfaces:**
- Consumes: Task 1's map. `RoleController` and `RoleDepotManager` each hold 7 capabilities and must still hold 7 after this task.
- Produces: `auth.ManageTemplates Capability = "ManageTemplates"`, held by `auth.RoleOrgAdmin` alone. `Actor.Capabilities()` returns 9 entries for `RoleOrgAdmin`.

- [ ] **Step 1: Write the failing test**

In `api/internal/auth/auth_test.go`, add `auth.ManageTemplates` to the org admin's `can` list and give it a `cant` list where it had `nil`. Replace the org admin case with:

```go
		{
			// FR-AUT-009 with erratum D1: configuration is shared, user
			// management is not. ManageTemplates is ORG_ADMIN's alone for a
			// different reason than ManageUsers — see D8 and the constant.
			name: "org admin",
			role: auth.RoleOrgAdmin,
			can:  []auth.Capability{auth.ViewFleet, auth.CaptureInspection, auth.ManageAssignments, auth.ManageAssets, auth.LogRetread, auth.ViewValuation, auth.ManageConfig, auth.ManageUsers, auth.ManageTemplates},
			cant: nil,
		},
```

Then add `auth.ManageTemplates` to the `cant` list of the controller and depot-manager rows Task 1 left as `{auth.ManageUsers}` — this is the assertion the whole batch exists to make:

```go
			cant: []auth.Capability{auth.ManageUsers, auth.ManageTemplates},
```

Apply that same `cant` line to **both** the controller row and the depot manager row. Then extend the driver row's `cant` (line 24) and the technician row's `cant` (line 32) with `auth.ManageTemplates` as their final element.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod \
  golang:1.24-alpine go test ./internal/auth/ -v
```

Expected: FAIL to build, with `undefined: auth.ManageTemplates` reported once per reference. A compile failure is the correct red state here — the test names a symbol the package does not yet export, which is precisely the assertion being made.

- [ ] **Step 3: Write the minimal implementation**

In `api/internal/auth/auth.go`, add the constant directly beneath `ManageConfig` in the `Capability` block, then grant it to `RoleOrgAdmin` alone. The constant block becomes:

```go
const (
	ViewFleet         Capability = "ViewFleet"
	CaptureInspection Capability = "CaptureInspection"
	ManageAssignments Capability = "ManageAssignments"
	ManageAssets      Capability = "ManageAssets"
	LogRetread        Capability = "LogRetread"
	// ViewValuation gates every monetary field and its aggregates — purchase
	// price, rand/mm, casing value, tread value, total value, sale proceeds
	// (FR-AUT-005a). The restriction is enforced server-side by projection: a
	// client surface that omits the field is not the control (NFR-SEC-006).
	ViewValuation Capability = "ViewValuation"
	ManageConfig  Capability = "ManageConfig"
	// ManageTemplates is separate from ManageConfig on purpose (D8). A tenant
	// picks its axle configuration from the platform-seeded library
	// (FR-CFG-001..007); authoring one outside it is ORG_ADMIN's alone,
	// because a wrong template silently corrupts every position on every unit
	// that uses it. ManageConfig reaches thresholds, bands, rates and cadence
	// and is held by CONTROLLER and DEPOT_MANAGER — sharing a gate would hand
	// template authoring to both.
	ManageTemplates Capability = "ManageTemplates"
	ManageUsers     Capability = "ManageUsers"
)
```

And the `RoleOrgAdmin` entry gains it:

```go
	RoleOrgAdmin:     {ViewFleet, CaptureInspection, ManageAssignments, ManageAssets, LogRetread, ViewValuation, ManageConfig, ManageUsers, ManageTemplates},
```

Change nothing else in the map. `RoleController` and `RoleDepotManager` keep the seven capabilities Task 1 gave them.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(pwd)/api:/app" -w /app -v tyre-gomodcache:/go/pkg/mod \
  golang:1.24-alpine go test ./internal/auth/ -v
```

Expected: PASS, all three tests and all 15 subtests.

- [ ] **Step 5: Run the full check**

```bash
make check
```

Expected: green. Confirm that `web-test` passes untouched — `web/src/shell/navigation.test.ts` feeds capability strings to `navItemsFor` as input and no nav item is gated on either capability, so an unchanged web suite is the expected result, not a gap.

- [ ] **Step 6: Commit**

```bash
git add api/internal/auth/auth.go api/internal/auth/auth_test.go
git commit -m "feat(auth): TYRE-84 reserve ManageTemplates for ORG_ADMIN

Decision D8 of 27 Aug 2026. The platform ships a predefined library of axle
configurations (FR-CFG-001..007) and adding a unit means picking from it;
controllers and depot managers never author one. Authoring outside the library
is a separate restricted action, because a wrong template silently corrupts
every position on every unit that uses it.

Gating it on ManageConfig would have handed template authoring to CONTROLLER
and DEPOT_MANAGER the moment TYRE-74 landed, which is why the two ship on one
branch and why the negative assertions are the substance of this commit. The
authoring surface itself is the separate, larger piece TYRE-81 defers; this
reserves the gate so it exists before any such surface does.

PLATFORM_ADMIN is not granted it: its rows carry a NULL tenant_id and it is
never the actor on a tenant-scoped request (ADR-0011)."
```

---

### Task 3: Close out the branch

**Files:**
- Modify: `docs/implementation-order.md:114-122` (the B2 section)

**Interfaces:**
- Consumes: both commits from Tasks 1 and 2.
- Produces: nothing code depends on. This task exists because B1 set the precedent that a batch records its own delivery, and because the PR needs a reviewable statement of what landed.

- [ ] **Step 1: Run the comment audit**

```
/comment-audit
```

Project rule: run it when closing out a branch. It is a judgment pass over the branch's comments, not a lint run — expect it to read the three comment blocks this branch touched and say whether each explains a constraint or narrates a change.

- [ ] **Step 2: Record B2 as delivered**

In `docs/implementation-order.md`, mark the B2 heading delivered in B1's style (`### B2 — the capability map — **delivered**`) and append to that section:

```markdown
The plan is at `docs/superpowers/plans/2026-08-27-capability-map.md`.

Delivered on `TYRE-74-capability-map` as two commits, in that order:

| Commit | Change | Assertion |
|---|---|---|
| TYRE-74 | `ManageConfig` on `RoleController` and `RoleDepotManager` | both hold it; DRIVER and TECHNICIAN still do not |
| TYRE-84 | `ManageTemplates` on `RoleOrgAdmin` alone | CONTROLLER and DEPOT_MANAGER do not hold it |

No schema change: the capability table has no database mirror, so the whole
batch is one file and its test. No endpoint gated on `ManageConfig` at the
time it widened, which is why the widening was cheap — the cost of deferring
it would have been paid once per surface built on the old shape.
```

Also update the *Open and correctly scoped, verified still needed* table, whose TYRE-74 and TYRE-84 rows now describe a state that no longer holds.

- [ ] **Step 3: Run the full check**

```bash
make check
```

Expected: green.

- [ ] **Step 4: Commit and push**

```bash
git add docs/implementation-order.md
git commit -m "docs: TYRE-74 record B2 as delivered"
git push -u origin TYRE-74-capability-map
```

- [ ] **Step 5: Open the PR against develop — do not merge**

```bash
gh pr create --base develop --title "TYRE-74 + TYRE-84: the capability map" --body-file <path>
```

The body states what each commit does, that no schema changed, and that the two tickets shipped together because separating them is how axle-configuration authoring ends up behind `ManageConfig`. It ends with the repo's PR footer:

```markdown
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Do not merge.** Merges are the owner's call and are made in the GitHub web UI.

## Self-review

**Spec coverage.** TYRE-74's definition of done: map grants (Task 1 Step 3) · table-driven test asserting both hold it (Task 1 Step 1) · DRIVER and TECHNICIAN still refused (already in the fixture, cited in Task 1 Step 1) · `scopes` untouched (*What must not change*; no task modifies it) · `make check` green (Task 1 Step 5). TYRE-84's definition of done: capability in `auth.go` with positive and negative assertions (Task 2 Steps 1 and 3) · TYRE-74's implementation references this ticket (Task 1 Step 3's map comment and Task 1 Step 6's commit message) · `make check` green (Task 2 Step 5).

**Type consistency.** One new symbol, `ManageTemplates`, spelled identically in the constant declaration, the `RoleOrgAdmin` entry, and all five test rows. Capability counts are stated once and reused: 7 for CONTROLLER and DEPOT_MANAGER after Task 1, 9 for ORG_ADMIN after Task 2, and Task 2's interface block restates the 7 as a precondition.

**Placeholders.** None. Every code step carries the code.
