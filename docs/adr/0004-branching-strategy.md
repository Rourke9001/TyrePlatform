# ADR-0004: Branching — develop integrates, main mirrors production

- **Status:** Accepted (2026-09-23)
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

**Accepted 2026-09-23 (TYRE-188 F8):** the repo has run on Option B since
20 Aug 2026, and the owner accepted it rather than leave a decision in force
marked Proposed. ADR-0005 builds on it.

Two promotions through a pull request shaped how `main` is promoted today.
PR #2 (21 Aug 2026) went through the merge button, and its merge commit put
`main` ahead of `develop`. The same morning, ruleset 21133437 ("main is
promoted, never authored") began refusing deletion, non-fast-forward pushes
and merge commits on `main`, and commit 752c04b wrote the terminal
promotion, `git push origin origin/develop:main`, into CONTRIBUTING.md.
PR #34 (29 Aug 2026) promoted through the merge button anyway. GitHub
rebase-merged it, which is linear and fast-forward, so ruleset 21133437 let
it through. It rewrote 44 hashes, and the repository's delete-on-merge
setting then deleted `develop` (`docs/lessons.md`, 31 Aug 2026). Ruleset
21929055 ("Protect develop from deletion") followed on 31 Aug.

The gap is still open, and nothing refuses a pull request into `main`. The
repository allows squash and rebase merges, neither ruleset has a rule that
either kind of merge breaks, and the terminal promotion holds by discipline
alone.
