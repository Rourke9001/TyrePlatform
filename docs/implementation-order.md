# Implementation order

Re-verified **24 Sep 2026** against `develop` @ `8bcae79` with PR #79 applied,
and the board.

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
23 Sep 2026, PR #66), TYRE-238's components (merged 23 Sep 2026, PR #70), then
TYRE-239 (the dashboard), which is next.

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
| B7.3 | design system (ADR-0015) and the dashboard, new tickets under TYRE-7 | **In progress** across three PRs from one plan. The substrate merged 23 Sep 2026, PR [#66](https://github.com/Rourke9001/TyrePlatform/pull/66), no migration: ADR-0015 records tokens, plain CSS, three Radix primitives and inline SVG charts, and the capture route's JavaScript is gated against a recorded budget in a single chunk. The components merged 23 Sep 2026, PR [#70](https://github.com/Rourke9001/TyrePlatform/pull/70), develop `38cc8ff`, no migration: thirteen components with a vitest each, a dev gallery at `/dev/design`, the dev switchers in a collapsed dev bar (TYRE-242, Done), every manager page behind `React.lazy`, and a reload-once handler for a chunk that fails to load. The capture budget went from 148374 to 134917 gzip bytes, and ADR-0015 is Accepted. The owner accepted the mockups on 23 Sep 2026 (TYRE-238 comment 12936) and answered its three decisions in the next comment. Next is TYRE-239, the dashboard, which also finishes TYRE-271 (the band words exist; the screens that render them do not). Two owner answers of 23 Sep 2026 change what it renders, so they land before it or inside it: TYRE-276 (in-content links and focus rings use a fixed platform colour, U53) and TYRE-282 (a comma groups thousands everywhere, including the capture route's kilometres, U55). |
| B7.4 | TYRE-240, the restyle of the ten existing screens; carries TYRE-176, TYRE-182 and the capture defect TYRE-241 | after B7.3. On 23 Sep 2026 the owner asked for a redesign of everything except the accepted dashboard and exceptions mockups. That widens this row: new mockups at a gate, plus the landing page, the not-found page and the shell. It is proposed on TYRE-240 (comment 12933). The capture flow is out of scope: the owner says it is fine, so U16 holds (comment 12937). The redesign is about usability, because the other screens do not show a new user what to do. The design skills it will use are in the repo (TYRE-273, Done); it follows U53 for link colour like every other screen |

Exception lifecycle, rule administration and notifications are B8, ticketed
as TYRE-243 under TYRE-7, not part of B7. The view B7.1 built is the rule
source B8 inherits.

## The sweep waves

The open `[Sweep]` tickets under TYRE-143 were re-triaged on 23 Sep 2026
(TYRE-143 comment 12993), and the owner answered its thirteen decisions the
same day, each on its own ticket. Four waves merged that day: W1b, suite and
docs (PR [#72](https://github.com/Rourke9001/TyrePlatform/pull/72)); W4a, the
API contract (PR [#73](https://github.com/Rourke9001/TyrePlatform/pull/73));
W4b, the refusal-code registry
(PR [#74](https://github.com/Rourke9001/TyrePlatform/pull/74)); and W1a, CI and
tooling (PR [#75](https://github.com/Rourke9001/TyrePlatform/pull/75)). None
added a migration. The DB chain started on 24 Sep 2026 with W5a. What is
left:

| Wave | Tickets | When |
|---|---|---|
| W5a | TYRE-211's write sites with TYRE-142: one inclusive resolver for the policy in force now | **merged** 24 Sep 2026, PR [#77](https://github.com/Rourke9001/TyrePlatform/pull/77), migration 000048, suite section 63 |
| W5b | TYRE-209, input-shape guards | next |
| W5c | TYRE-175, TYRE-189 F5, TYRE-213 (drops `v_axle_side_divergence`), TYRE-201 | after W5b |
| W5d | TYRE-168 (coverage counted from the wear rate's own source), TYRE-189 F4, TYRE-190 F10 as tenant configuration | after W5c |
| W5e | TYRE-210, a committed `db/schema.sql` and a migrate-down gate | last |
| W2, W3 | TYRE-156, 157, 159 and 187; TYRE-186 (a state filter on the tyre list); TYRE-171; TYRE-173, whose F15 (the position badge from the 11px eyebrow to 13px, still the eyebrow in `web/src/capture/capture.css`) the owner said to ship now rather than wait for TYRE-70's handset run (23 Sep 2026) | between TYRE-239 and TYRE-240 |
| Capture | TYRE-152 (a photo on the warned position), TYRE-154 (the manifest and iOS install hint) | their own PR; clashes with neither B7.3 nor B7.4 |
| Infra | TYRE-203 (30-day database backups, blob versioning) | any gap |

W5 runs one PR after another because W5a, W5b and W5c all rewrite the
lifecycle functions migration 000039 created. TYRE-214 is deferred past the
POC (decision 11), so W5e ends the chain. TYRE-176 and TYRE-182 stay with
B7.4.

## After B7

The candidates below are not sequenced against each other; deployment is
independent of the application work and can fill any gap.

### Deployment

**TYRE-79, TYRE-51, TYRE-53**, with TYRE-61 and TYRE-63 (infrastructure
hardening) alongside. Independent of the application work, so they can fill
any gap. TYRE-79 is the one with a deadline attached: nobody can log in to
staging until TYRE-2, its last deploy reported success while shipping a
crash-looping revision, and staging has to be demonstrably working before
anyone is shown it. Every demo is a laptop until this lands. **TYRE-205**
stays In Progress for its Static Web App half, which rides TYRE-51. The API
has sent NFR-SEC-010's security headers since PR #73, and nothing sets them
on the web app's host yet.

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
- B6.4's follow-ups **TYRE-229 to TYRE-236** (under TYRE-55) are on the
  board; none is Critical. The sweep's own leftovers sit outside the waves
  above: **TYRE-191** waits on TYRE-261, and so does **TYRE-192** (In
  Progress), whose remaining comment-gate pattern would flag three lines of
  applied migration 000028. **TYRE-195** is done once the Appendix H.1 row
  is pasted into Confluence, **TYRE-293** pins the format hook's ruff and
  **TYRE-294** adds two suite hardenings from the PR #72 audit.
  **TYRE-184** stays In Progress for F5, which lifts each handler's inline
  `refuseInvalid` chain into a `validate()` method when that handler is
  next touched, never as a sweep, and for the seven enum-cast type names F6
  found, which no live-schema check covers. **TYRE-207**'s F11 has no wave.
  The compliance-language guard in `web/src/test/spoken.ts` runs in six
  capture test files but not on every driver-facing screen (`DriverHome`
  has none), and it must never reach a manager screen, where OR-LEG-002
  requires the operator-responsibility notice. Its F12, dropping
  `v_axle_side_divergence`, is W5c's under TYRE-213. TYRE-205's Static Web
  App half is with the deployment track above. **TYRE-295** (read-only
  transactions, when a replica is planned)
  is TYRE-180 F6, split out. W5a left **TYRE-296** (the "in force now" readers outside
  `threshold_policy`), **TYRE-297** (`receive_tyres` reads the threshold
  once per tyre), **TYRE-298** and **TYRE-299** (owner decisions on how far
  a policy row is honoured and whether it is written once) and **TYRE-300**
  (suite check 7 is not NULL-safe).
- The independent review of PRs #72 to #77 raised **TYRE-301 to TYRE-313**
  on 24 Sep 2026. PR [#79](https://github.com/Rourke9001/TyrePlatform/pull/79)
  landed TYRE-301, 302, 303, 306, 307, 308 and 312, and the first half of
  three more: **TYRE-304** waits on the owner confirming the Renovate app
  runs, **TYRE-309** keeps item 2 (check 2 proves nothing for a table tenant
  B holds no rows in, and the fix needs fixture rows) and **TYRE-311** keeps
  item 3 (the narration rule's precision, the owner's call). **TYRE-305**
  (the API pool against B1ms's 35 user connections), **TYRE-310** (which
  instant prices a back-dated retread return, and two related questions)
  and **TYRE-313** (nothing blocks a pull request into main) wait on owner
  decisions.
- B7.1's own residue is **TYRE-244 to TYRE-249**: the UTC day where the tenant
  day belongs in the register and unit inspection status, the exception suite's
  unpinned boundaries, the branches the fixture cannot reach, and seed
  housekeeping.
- B7.2's residue is **TYRE-268** (depot-scoped inflation compliance, the
  migration U21 kept out), **TYRE-269** (an estate total of 0 where every
  member is unvalued should read null) and **TYRE-270** (a tread band label
  names a range the band does not cover). None blocks B7.3; TYRE-270 is the
  one the dashboard legend must not inherit.
- B7.3's residue so far: **TYRE-271** is half landed (the inflation band words
  are in `vocabulary.ts`; TYRE-239's screens must render them). PR #70 left
  **TYRE-274** (test gaps), **TYRE-275** (Dialog focus return, chart tooltip
  placement, and more than five tread bands, answered as U56), **TYRE-277**
  (two gates that pass over a case), **TYRE-278** (the tyre register's money,
  pre-existing), **TYRE-279** (a CaptureFlow timeout under load) and
  **TYRE-281** (`ui.css` rides in the capture route's blocking stylesheet).
  **TYRE-280** was an owner decision, answered 23 Sep 2026 as U54 (one class
  component as the error boundary, named as an exception in CLAUDE.md), and
  is buildable now, independent of the dashboard. TYRE-276 and TYRE-282 are
  scheduled with TYRE-239 in the B7.3 row above.
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
