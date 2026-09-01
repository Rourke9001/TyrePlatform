# HANDOFF — Codebase Quality & Architecture Refactor (behaviour-preserving)

## Role
You are a senior engineer doing a structural clean-up of the TyrePlatform repository. You are not adding features. You are not "improving" behaviour. You are making the existing behaviour live in better-shaped code.

## Mission
1. Separate concerns properly (domain / application / infrastructure / presentation).
2. Increase modularity — small units with one reason to change.
3. Reduce tight coupling — depend on interfaces at boundaries, not concrete implementations.
4. Improve scalability of the *code*, not the runtime (i.e. adding a 19th module or 2nd tenant flow shouldn't require touching unrelated files).
5. Make the codebase easier to maintain for a solo engineer over years.

**Hard constraint: DO NOT change product behaviour.** Same inputs → same outputs, same side effects, same errors, same DB rows, same API contracts, same RLS outcomes. If a refactor would "fix" something, stop and log it under Findings → Behaviour Defects; do not fix it here.

## Scope
- **In scope:** all application source, tests, seed/fixture generators, tooling scripts, config wiring.
- **Out of scope (do not touch):** `migrations/**` (or equivalent — any versioned schema migration files), generated code, vendored deps, the SRS/ADR docs under `docs/`.
- Migrations are read-only reference. Schema shape informs the domain model; you do not alter it.

## Phase 0 — Setup & baseline (no edits)
1. Read `README`, `docs/adr/*`, and the build artifacts index. ADR-0003 (tenancy), ADR-0004 (unit-centric fleet), ADR-0005 (tyre identity), ADR-0006 (client/on-device), ADR-0007 (provenance) are architectural constraints — refactors must respect them, not relitigate them.
2. Run the full test suite. Record pass/fail counts and runtime. This is your behaviour oracle. If it is red, stop and report — do not proceed on a red baseline.
3. Produce a dependency map: modules → what they import → what imports them. Flag cycles.
4. Produce a size/complexity table per file (LOC, public surface, cyclomatic hotspots).

## Phase 1 — Audit (no edits)
Walk the codebase and classify every non-trivial unit into a **Keep/Kill Ledger**. Categories:

| Tag | Meaning |
|---|---|
| `DUP` | Duplicated logic (≥2 sites doing materially the same thing). Cite both paths. |
| `FORCED-FIT` | Code bent to serve a purpose it wasn't designed for; delete-and-rewrite beats adapt. |
| `DEAD` | Unreferenced, unreachable, or only referenced by other dead code. Prove it (grep + call-graph). |
| `SPECULATIVE` | Built for a future that hasn't arrived (abstractions with one implementation, config with one value, feature flags nothing reads). |
| `REFACTOR-WORTH` | Real refactor case where payoff > risk. State the payoff concretely. |
| `REFACTOR-NOT-WORTH` | Ugly but isolated, stable, and tested. Leave it. Say why. |
| `EARN-ITS-KEEP` | Unclear value. Owner must justify or it goes. Pose the question. |
| `BEHAVIOUR-DEFECT` | Bug found during audit. **Do not fix.** Log for separate ticket. |

For each entry: path, tag, one-line evidence, one-line proposed action, risk (L/M/H), and which tests cover it (or "UNCOVERED").

Specific things to look for in this codebase:
- Tenant scoping / RLS context set in more than one way or more than one place.
- Position-map / axle-configuration logic duplicated between generators, prototypes, and app code.
- Valuation arithmetic (`tread_value`, casing value, `rand_per_mm`) existing anywhere other than one domain function.
- Measured-vs-derived provenance handling (ADR-0007) leaking into presentation code.
- Offline/outbox code (TYRE-4) tangled with capture UI.
- Seed/fixture scripts carrying business rules that the app also carries.
- Prototype HTML (`*_prototype.html`, `*_dashboard.html`) that has become de facto production or is now fully dead.

**Gate:** Stop here and output the Ledger + dependency map + proposed target structure. Wait for approval before Phase 2. If running unattended, proceed only with `REFACTOR-WORTH` items rated risk L/M that have test coverage; leave everything else as proposals.

## Phase 2 — Refactor (edits, incremental)
Rules:
- One logical change per commit. Commit message format: `refactor(<area>): <what> [ledger #N]`.
- Run the full suite after every commit. Any diff in test outcome = revert, do not "fix forward".
- Where a unit is `UNCOVERED` and you must touch it, **first** add a characterisation test that pins current behaviour (including current bugs), then refactor, then leave the test.
- Dead code: delete outright. No commenting out, no `_deprecated` folders.
- Duplication: extract to a single owner. Domain rules → domain layer. Never "shared/utils" as a dumping ground — name the module after the concept.
- Coupling: introduce an interface only where there are ≥2 real callers or a real seam (DB, HTTP, clock, filesystem, auth). One implementation + one interface = `SPECULATIVE`, don't do it.
- No renames of public API routes, DB objects, env vars, CLI flags, or exported fixture formats. Internal renames are fine.
- Do not upgrade dependencies. Do not reformat files you aren't otherwise changing.
- Do not add ADRs, C4 diagrams, or OpenAPI specs. Explicitly deprioritised.

Target layering (adapt to what's actually there; don't force it):
```
src/
  domain/          # pure: entities, value objects, valuation rules, position maps, invariants. No I/O.
  application/     # use cases / services orchestrating domain + ports. Tenant context lives here.
  infrastructure/  # DB (incl. RLS session wiring), auth (Entra), storage, outbox, clock.
  interfaces/      # HTTP handlers, CLI, capture client. Thin. Maps in/out, no rules.
  shared/          # only truly cross-cutting: result types, errors, ids. Small. Justify every file.
tests/
  unit/ integration/ characterisation/ fixtures/
tools/             # seed & fixture generators, importing from domain — never re-implementing it
```

## Phase 3 — Deliverables
Produce, in this order, as markdown in `docs/refactor/` plus the commits:

1. **Keep/Kill Ledger** (final, with status per row: DONE / PROPOSED / DEFERRED / REJECTED + reason).
2. **New folder structure** — actual tree as committed, with a one-line purpose per top-level directory and a before→after move map for every relocated file.
3. **Clean architecture breakdown** — the layers, the dependency rule (arrows point inward only), what each layer may and may not import, and where the three cross-cutting concerns (tenant context, provenance, auth/role capability) enter and how they propagate.
4. **Refactored code** — in the repo, not in the doc. The doc links to commits.
5. **Explanation of architectural improvements** — per ledger item that was actioned: problem, change, why it's behaviour-neutral, evidence (test run before/after, diff of any generated output or fixture). Keep it factual; no adjectives.
6. **Behaviour Defects list** — each with repro, expected vs actual, suspected spec reference (SRS FR/BR id if known). Suggested Jira summaries, ready to create. Do not create them.
7. **Baseline vs final**: test counts, coverage delta, LOC delta, cycle count delta, file count delta.

## Definition of done
- Test suite green with identical outcomes to baseline (plus any new characterisation tests).
- Zero import cycles, or each remaining cycle listed with justification.
- No file tagged `DEAD` remains.
- No business rule (valuation, position maps, staleness, tenant scoping, provenance) has more than one implementation.
- `migrations/**` untouched — verify with `git diff --stat <baseline>..HEAD -- migrations/` returning empty.
- A stranger can open `docs/refactor/` and understand what moved, why, and how to verify nothing changed.

## If in doubt
Prefer the smaller change. Prefer deleting over abstracting. Prefer a proposal in the ledger over a risky edit. Log, don't guess.
