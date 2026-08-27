# Implementation order

Snapshot of **27 Aug 2026**, verified against `develop` @ `604099f`.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins — and the disagreement is a bug in this page. Re-verify
before trusting a disposition below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built.

## What the verification found

A proposed order was drawn from the Decisions of Record (D6–D11) and the board.
Checking it against the repository moved three things:

- **Its first step was already complete.** There are no open pull requests.
  TYRE-49, TYRE-68 and TYRE-69 were merged before the order was written, so
  "land what is in review" is board bookkeeping, not merge work.
- **Two items were sequenced as future work but are already on `develop`** —
  TYRE-52 and TYRE-65.
- **Nine open tickets appeared nowhere in it** — TYRE-58 to TYRE-63, TYRE-76,
  and the three standing blockers TYRE-13/15/19. They are given homes below.

The verification also confirmed the rest of the order's dependency reasoning,
which is why the batches keep its shape.

## Disposition of every not-Done key

### Closed by this pass — the work is on `develop`

| Key | Evidence |
|---|---|
| TYRE-49 | PR #21, merged 22 Aug |
| TYRE-68 | PR #26, merged 26 Aug |
| TYRE-69 | PR #26, merged 26 Aug |
| TYRE-52 | `734644a` / migration `000016`; the decision is recorded at `app.tyre_in_estate_asof` and the suite asserts a disposed-but-still-rated tyre |
| TYRE-54 | PR #22 plus `27dd7e9` |
| TYRE-56 | PR #23. Its one residual — CONTROLLER and DEPOT_MANAGER lacking `ManageConfig` — is TYRE-74's whole scope, so it does not hold this open |
| TYRE-65 | PR #25, merged 24 Aug |

### Open, with a narrowed remainder

| Key | What actually remains |
|---|---|
| TYRE-70 | The mobile-viewport projects and specs landed in `11230eb`. What is outstanding is the acceptance run itself — one real vehicle, on a phone, in airplane mode, with its duration measured against the three-minute target. That is a human sitting in a yard, not agent work |
| TYRE-30 | DR-013 audit columns, the DR-014a DELETE revoke and `staff_number` uniqueness all landed (`873bf82`, `ff76209`, `8ad7c9f`). Two of its folded decisions did not: the PLATFORM\_ADMIN email partial unique index and the `vehicle_driver` overlap constraint. Both are carried into B1. DR-014b left separately as TYRE-60 |

### Open and correctly scoped, verified still needed

| Key | Verified at |
|---|---|
| TYRE-74 | `api/internal/auth/auth.go:52-53` — `ManageConfig` is absent from both roles |
| TYRE-84 | No `ManageTemplates` capability exists |
| TYRE-82 | No trigger or constraint guards `vehicle.configuration_id` against change with history present |
| TYRE-85 | `000011` dropped `fitted_odometer NOT NULL`; nothing re-enforces it where the unit kind has an odometer |
| TYRE-77 | `statusForPgError` forwards `pgErr.Message` verbatim |
| TYRE-78 | `TY003` and `23505` both map to 409 in `submitStatus`, and the client cannot tell them apart |

Also open and unbuilt: TYRE-36, TYRE-38, TYRE-41, TYRE-48, TYRE-51, TYRE-53,
TYRE-58 to TYRE-64, TYRE-72, TYRE-73, TYRE-75, TYRE-76, TYRE-79, TYRE-81,
TYRE-83, TYRE-86.

## The batches

Ordering follows two rules. First, dependency. Second, and more sharply: an
integrity rule is cheap before pilot data exists and expensive after, because
afterwards the rule has to be retrofitted around rows that already violate it.
That is why the database constraints come before any surface that writes.

### B1 — database integrity rules

**TYRE-82, TYRE-85, and TYRE-30's two remaining constraints.**

One migration pass, no UI. These are the only items on the board that become
materially harder once the pilot holds real rows. TYRE-82 stops a unit's axle
configuration changing under its own fitments; TYRE-85 restores the half of
FR-FIT-002 that `000011` relaxed and never replaced. TYRE-30's leftovers are
the same class of small constraint in the same schema territory, so they ride
along rather than waiting for a pass of their own.

The plan is at `docs/superpowers/plans/2026-08-27-db-integrity-rules.md`.

### B2 — the capability map

**TYRE-74, then TYRE-84.**

Both edit the same map in `api/internal/auth/auth.go`. Doing them apart is how
axle-configuration authoring ends up gated on `ManageConfig`, which is the one
outcome TYRE-84 exists to prevent: TYRE-74 widens `ManageConfig` to CONTROLLER
and DEPOT_MANAGER, so a template gate resting on it would silently hand
template authoring to two roles that must not have it. Together they are a
capability constant, two map entries and their tests.

### B3 — the submit refusal contract

**TYRE-77, then TYRE-78.**

TYRE-77 owns what a refusal says; TYRE-78 owns the machine-readable code it
carries. Every write endpoint added after this inherits whatever shape is
settled here, so the cost of deferring is paid once per endpoint. TYRE-81's own
description asks for these first.

TYRE-77's constraint is that the five `TY0xx` messages are deliberately
human-facing and asserted by name in `db/tests/004_tests.sql` — the fix must
preserve them while canning everything else.

### B4 — the first admin write surface

**The TYRE-81 ADR, then TYRE-81, then TYRE-83.**

The ADR comes first because the D9/D10 constraints — the tiered-invite shape,
the reactivate branch, the subdomain-login assumption — are cheaper to record
than to unpick from code. TYRE-83 sits directly on `POST /api/users` and cannot
start before it exists.

**TYRE-58** belongs here, not in the analytics tail: band configuration
write-time validation is a rule about a config-editing surface, and this batch
builds the first one.

### B5 — the rig-setup surface

**TYRE-72, then TYRE-73, then TYRE-75.**

Create and date a combination, lock it while in active transportation, then
reconcile observed composition against membership. The largest build on the
board. It blocks D5's driver-confirm flow and FR-INS-049 scheduling, but
nothing corrupts while it waits, which is why it sits behind the write-path
foundations rather than in front of them.

TYRE-82's front-end consequence — disabling the configuration field once a unit
has history — lands here, with B1 as its citation.

### Parallel track — deployment

**TYRE-79, TYRE-51, TYRE-53.** Independent of the application work, so they can
fill any gap. TYRE-79 is the one with a deadline attached: a deploy that reports
success while shipping a crash-looping revision will be discovered at the worst
possible moment, and staging has to be demonstrably working before anyone is
shown it.

### Tail — analytics and lifecycle

**TYRE-41 (re-scoped first), TYRE-38, TYRE-36, TYRE-48, then TYRE-52's
successors.** TYRE-36 only once the register shape is stable, since it reads it.

### Homed, not scheduled

- **TYRE-76** (depot-scoped capture path) follows B2 — it needs the capability
  map settled before a depot manager can be granted a capture path.
- **TYRE-59, TYRE-60, TYRE-62** are E1 residue with no dependent. They are
  deliberately unscheduled rather than forgotten; pull them when a gap appears.
- **TYRE-61, TYRE-63** are infrastructure hardening and belong with the
  deployment track.
- **TYRE-70** waits on a human with a phone and a vehicle.

### Blocked on people, not code

**TYRE-43, TYRE-44, TYRE-45, TYRE-46, TYRE-47, TYRE-64** are sponsor questions.
They are not sequenced because no amount of engineering advances them. Chase
them in the background; **TYRE-45** — BAC's real inspection sheets — is worth
pushing hardest, since three other items lean on it.

**TYRE-13, TYRE-15, TYRE-19** are the standing blockers in `open-issues.md`.
They carry no batch here because they are decisions, but two have teeth:
TYRE-13 (sponsor acceptance of ADR-0003) gates the P1 schema freeze, and
TYRE-19 (platform name and domain) becomes a hard blocker at custom-domain
setup rather than a soft one.

## Re-verifying this page

The method, so the next session can redo it rather than trust it:

```
gh pr list --state open                        # open review work
git log origin/develop --pretty=%s \           # keys actually on develop
  | grep -oE 'TYRE-[0-9]+' | sort -u
```

Match against the board with a `statusCategory != Done` search. A key present
on `develop` and open on the board is a candidate, not a conclusion — read the
ticket's definition of done before closing it. TYRE-30 is why: three of its
commits are on `develop` and it is still genuinely open.
