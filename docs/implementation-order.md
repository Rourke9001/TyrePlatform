# Implementation order

Re-verified **23 Sep 2026** against `develop` @ `c936401` and the board's open
sprint.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins, and the disagreement is a bug in this page.
Re-verify before trusting anything below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built. Batches B1 to B6 have all merged,
and B7.1 with them. Their records, and the rationale each one left for the
batch after it, are in `docs/delivery-history.md`; a citation written as
`docs/implementation-order.md §B5` resolves to the same-named section there.

## Two ordering rules

Dependency first. Then, more sharply: an integrity rule is cheap before pilot
data exists and expensive after, because afterwards it has to be retrofitted
around rows that already violate it. That is why the database constraints came
before any surface that writes, and the same test applies to whatever is cut
next.

Two standing rules from B5's close-out apply to every branch: the API
container is restarted immediately before every `make e2e` and never reused
across two runs, and no test derives a tenant-relative date from the browser
or CI clock (`docs/lessons.md`, 2026-09-03).

## The open sprint

The board's open sprint is "B7.1.5/B7.2 - Analytics API", 16 to 30 Sep 2026,
and it carries four issues: TYRE-247 (the dashboard substrate, B7.1.5),
TYRE-36 and TYRE-193 (the analytics read API, B7.2) and TYRE-253 (the
ordinal triggers the suite does not reach). TYRE-247 merged 17 Sep 2026
(PR #61, develop `3e2b151`) and TYRE-36 merged 20 Sep 2026 (PR #64, develop
`50461fe`), so the sprint's remaining code is TYRE-253 and the half of
TYRE-193 that the dashboard hero carries. B7.3 is in progress across three
pull requests from one plan written 21 Sep 2026: TYRE-238's substrate (merged
23 Sep 2026, PR #66), TYRE-238's components, then TYRE-239 (the dashboard), cut
after them.

The sprint before it, "B6 - Rig-setup surface", 3 to 17 Sep 2026, closed with
all nine of its issues Done; its record is in `docs/delivery-history.md`.

## B7, analytics and dashboard, in progress

Cut 10 Sep 2026 on the owner's call (analytics before deployment; design
system first; tokens plus CSS with Radix for the hard controls). Design:
`docs/superpowers/specs/2026-09-10-b7-analytics-dashboard-design.md`. This is
the manager dashboard the brief promises and the application does not have.
B7.1 gave the database its half: `app.v_exception`, the threshold and pressure
resolvers, the two value-at-risk views, and suite section 59 pinning 19 / 11 / 9
as numbers. Nothing above the database consumes any of it, so no exception
endpoint, no fleet valuation and no value-at-risk figure exists in the API or
the web app. Four slices and one substrate slice between the first two, each
its own branch, PR and review, each planned after the previous merges:

| Slice | Ticket | State |
|---|---|---|
| B7.1 | TYRE-41 exception view scoped to the latest inspection; TYRE-211 (resolver half); TYRE-183 pins 19/11/9; TYRE-193 (value-at-risk view); TYRE-38 rides | **merged** 15 Sep 2026, PR [#55](https://github.com/Rourke9001/TyrePlatform/pull/55), migration 000045 |
| B7.1.5 | TYRE-252 first (migration 000046: the measurement-ordinal check becomes statement-level; found at planning, spec S0), then TYRE-247, the dashboard substrate: a volume tenant in Sandbox Fleet (60 units, fortnightly, 24 months, `make db-volume`), the dashboard read path measured on it, and migration 000047 for the index if the plan warrants one (spec B7.1.5, U21, U22, U26) | **merged**: TYRE-252 landed 16 Sep 2026, PR [#58](https://github.com/Rourke9001/TyrePlatform/pull/58), migration 000046, suite section 60; TYRE-247 landed 17 Sep 2026, PR [#61](https://github.com/Rourke9001/TyrePlatform/pull/61), migration 000047, suite section 61. The measurement found the read path costs about 99 seconds warm against U26's 500ms budget, so the index is necessary and nowhere near sufficient; TYRE-256 owns the reshaping, TYRE-257 the load (attributed 17 Sep: the cost was two definer-chain queries without a tenant column and a cached foreign-key plan, not the index), TYRE-258 the relations the volume tenant leaves empty, TYRE-259 the definer-chain defect on the submit path |
| B7.2 | TYRE-36 analytics read API; TYRE-193 (endpoint half). No migration (U21). The rule B7.1 leaves behind, that `v_casing_value_at_risk` nests AUDIT inside its estimated-or-audit count while `v_estate_valuation` keeps the two disjoint, so one payload must not carry both (U27). TYRE-211's write sites and TYRE-142 are one DB-only PR after B7.2, not part of it (U23, U24) | **merged** 20 Sep 2026, PR [#64](https://github.com/Rourke9001/TyrePlatform/pull/64), no migration. TYRE-36 Done. TYRE-193 stays open: its view (000045) and its endpoint (`GET /api/valuation/at-risk`) are built, the H.3 gate is the rendered figure, and that is B7.3's hero. The measurement the batch recorded is the finding, not the shipment: `GET /api/dashboard` costs about 70x U26's 500ms budget on the volume tenant, owned by TYRE-256 and TYRE-257 |
| B7.3 | design system (ADR-0015) and the dashboard, new tickets under TYRE-7 | **In progress** across three PRs from one plan. The substrate merged 23 Sep 2026, PR [#66](https://github.com/Rourke9001/TyrePlatform/pull/66), no migration: ADR-0015 (Proposed until the components land) records tokens, plain CSS, three Radix primitives and inline SVG charts, and the capture route's JavaScript is gated against a recorded budget of 148374 gzip bytes in a single chunk. Next is TYRE-238's components, then TYRE-239. The owner accepted the mockups on 23 Sep 2026 (TYRE-238 comment 12936) and answered its three decisions in the next comment: the exceptions table stacks as cards on a phone, the band names (TYRE-271) are fixed in the components PR, and measurements always show one decimal. |
| B7.4 | TYRE-240, the restyle of the ten existing screens; carries TYRE-176, TYRE-182 and the capture defect TYRE-241 | after B7.3. On 23 Sep 2026 the owner asked for a redesign of everything except the accepted dashboard and exceptions mockups. That widens this row: new mockups at a gate, plus the landing page, the not-found page and the shell. It is proposed on TYRE-240 (comment 12933). The capture flow is out of scope: the owner says it is fine, so U16 holds (comment 12937). The redesign is about usability, because the other screens do not show a new user what to do. The design skills it will use are TYRE-273 |

Exception lifecycle, rule administration and notifications are B8, ticketed
as TYRE-243 under TYRE-7, not part of B7. The view B7.1 built is the rule
source B8 inherits.

## After B7

The candidates below are not sequenced against each other; deployment is
independent of the application work and can fill any gap.

### Deployment

**TYRE-79, TYRE-51, TYRE-53**, with TYRE-61 and TYRE-63 (infrastructure
hardening) alongside. Independent of the application work, so they can fill
any gap. TYRE-79 is the one with a deadline attached: nobody can log in to
staging until TYRE-2, its last deploy reported success while shipping a
crash-looping revision, and staging has to be demonstrably working before
anyone is shown it. Every demo is a laptop until this lands.

### Capture residue under TYRE-4

**TYRE-129** (the four review findings pulled back on 26 Aug), **TYRE-216 to
TYRE-220**, **TYRE-227**, and **TYRE-76**, the depot-scoped capture path. B2
settled that a depot manager holds `CaptureInspection` tenant-wide but still
takes `ScopeDepot`, so TYRE-76 is a scope question, not a capability one.
TYRE-70's acceptance run is one real vehicle, on a phone, in airplane mode,
timed against the three-minute target; that needs a human in a yard, not agent
work.

## Homed, not scheduled

- **TYRE-58** waits for a surface that edits tenant configuration. TYRE-81
  picks from the axle-configuration library and authoring stays ORG_ADMIN's
  through `ManageTemplates` (D8, TYRE-84), so no such surface exists yet.
- **TYRE-59, TYRE-60, TYRE-62** are E1 residue with no dependent. Pull them
  when a gap appears.
- **TYRE-73**, the in-transport lock, is parked post-pilot by its own ticket
  (spec U1, 3 Sep 2026). Nothing in B6's schema forecloses it.
- The review-sweep residue (the `[Sweep]` tickets under TYRE-143) and B6.4's
  follow-ups **TYRE-229 to TYRE-236** (under TYRE-55) are on the board; none is
  Critical.
- B7.1's own residue is **TYRE-244 to TYRE-249**: the UTC day where the tenant
  day belongs in the register and unit inspection status, the exception suite's
  unpinned boundaries, the branches the fixture cannot reach, and seed
  housekeeping.
- B7.2's residue is **TYRE-268** (depot-scoped inflation compliance, the
  migration U21 kept out), **TYRE-269** (an estate total of 0 where every
  member is unvalued should read null) and **TYRE-270** (a tread band label
  names a range the band does not cover). None blocks B7.3; TYRE-270 is the
  one the dashboard legend must not inherit.
- B7.3's residue so far is **TYRE-271**: the inflation band names reach the
  manager as database identifiers, and the dashboard needs one vocabulary for
  them before it renders the inflation panel.
- TYRE-252's residue is **TYRE-253**, under TYRE-9: the DELETE and UPDATE
  ordinal triggers belong in `005_privileged.sql`, since the app role reaches
  neither and the suite therefore proves only the INSERT one. **TYRE-254** asked
  whether an import may bypass the ordinal check and is closed. It may not, and
  it never needs to; the rule it left behind is in `db/CLAUDE.md`.
- **TYRE-255**, under TYRE-10, widens `gate-not-piped.sh` to know that `gh pr
  checks` is a gate too. TYRE-250's hook names `make`, `npm` and `go test`, so
  a piped `gh` call still reports the pipe's status.

## Blocked on people, not code

**TYRE-44, TYRE-46, TYRE-47, TYRE-64** are sponsor questions. They are not
sequenced because no amount of engineering advances them. Chase them in the
background.

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
git rev-parse origin/develop^{tree} \          # develop and main must agree
             origin/main^{tree}                # after a promotion
```

Match against the board with a `statusCategory != Done` search, and read the
open sprint with `sprint in openSprints()`. A key present on `develop` and
open on the board is a candidate, not a conclusion. Read the ticket's
definition of done before closing it: a key whose only commit on `develop` is
the one that homed it in a page like this one has been written down, not
built.

The third command is the 29 Aug lesson. Compare **trees**, never hashes: a
promotion that went through a pull request rewrites every hash while leaving
the tree identical, so equal trees mean the branches agree and unequal hashes
alone mean nothing. If `origin/develop` is missing entirely, it was deleted by
`deleteBranchOnMerge` and is restored with
`git push origin origin/main:refs/heads/develop`.
