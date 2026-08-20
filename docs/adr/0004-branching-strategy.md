# ADR-0004: Branching — develop integrates, main mirrors production

- **Status:** Proposed
- **Date:** 2026-08-20
- **Deciders:** Rourke (Delivery)

## Context

One engineer, one repo, CI already runs `make check` on push. Azure is not
provisioned yet, but when it is, `main` will feed the environment the sponsor
sees. A demo to the sponsor must never be broken by whatever was pushed an
hour earlier; equally, a one-person project cannot afford ceremony that slows
the push-review-merge loop to a crawl. The branch names also become deploy
triggers in GitHub Actions, so the choice is cheap now and annoying to rename
after the Bicep pipelines exist.

## Options considered

### Option A — Single trunk (`main` only)

Everything lands on `main`; deploys are cut by tag. Simplest possible model
and the usual right answer for one engineer. **Its real downside:** `main`
doubles as both the integration surface and the thing the sponsor's
environment tracks, so a half-finished push and a demo share a branch. With a
non-technical sponsor and demos on short notice, "main is always demoable"
stops being true exactly when it matters.

### Option B — `develop` integrates, `main` is the promoted branch

Feature branches cut from `develop` and land there; `main` only ever
fast-forwards to a `develop` commit that has already passed CI. **Its real
downside:** one more branch to keep in sync, and fast-forward promotion is a
manual step that can be forgotten, leaving `main` stale.

### Option C — Full GitFlow (release, hotfix, support branches)

**Downside dominates:** designed for versioned releases across teams; for a
single-engineer continuously-deployed POC it is pure ceremony.

## Decision

We will use Option B: feature branches rebase onto `develop`; `main` advances
only by fast-forwarding to a vetted `develop` commit and represents what
production/staging runs.

## Consequences

**Good:** `main` is demoable at all times; deploy pipelines get an
unambiguous trigger branch per environment; the feature-branch etiquette in
CLAUDE.md is unchanged except for its target.

**Bad:** promotion is a deliberate manual step; `main` can lag `develop` and
someone (the same one person) must remember to promote after a green run.

**Revisit when:** Azure environments exist and the Bicep/GitHub Actions
pipelines are written — the environment-to-branch mapping, protection rules
and promotion mechanics are deliberately deferred to that ADR.
