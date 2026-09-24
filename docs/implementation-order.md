# Implementation order

Re-verified **24 Sep 2026** against `develop` @ `1973432` and the board, the
same day a checkpoint audit pruned the board (TYRE-332).

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins, and the disagreement is a bug in this page.
Re-verify before trusting anything below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built. Batches B1 to B6 have all merged,
and B7.1 to B7.2 with them. Their records, and the rationale each one left for
the batch after it, are in `docs/delivery-history.md`; a citation written as
`docs/implementation-order.md §B5` resolves to the same-named section there.

## Two ordering rules

Dependency first. Then, more sharply: an integrity rule is cheap before pilot
data exists and expensive after, because afterwards it has to be retrofitted
around rows that already violate it. That is why the database constraints came
before any surface that writes, and why the W5 chain below has to finish
before the pilot path puts a real tenant's rows in the database.

Two standing rules from B5's close-out apply to every branch: the API
container is restarted immediately before every `make e2e` and never reused
across two runs, and no test derives a tenant-relative date from the browser
or CI clock (`docs/lessons.md`, 2026-09-03).

## Where the board stands

On 24 Sep 2026 a checkpoint audit read every open ticket against `develop` and
SRS Appendix H.1, and walked every screen in a browser. The owner approved its
prune the same day. 21 tickets closed, including epics TYRE-5 and TYRE-57; 10
were parked; 17 were raised (TYRE-315 to TYRE-331); and the owner answered 23
decisions, posted on their tickets as U57 to U79. Search Jira for "Checkpoint
24 Sep 2026" and "checkpoint question" to find them.

The audit's main finding shapes this page. The database and the API are well
ahead of the screens, and six groups of H.1 Musts sat in no batch at all:
login, onboarding with the tyre catalogue, driver self-start and schedules,
photos, reports with export, and import. B9 below is where most of them now
live.

## The queue

The owner set the order on 24 Sep 2026 (U80, on TYRE-239): the dashboard
first, then the pilot path. Two lanes run side by side because they touch
disjoint files: web and API work on the left, database work on the right.

| Step | Web and API lane | Database lane |
|---|---|---|
| 1 | Rider PR: TYRE-276 (U53; capture's active-field ring follows it, U77), TYRE-282 (U55), TYRE-280 (U54) and TYRE-269 (an all-unvalued estate reads null, not 0; a view change, so it carries a migration and the valuation verifier) | TYRE-259, its own PR: the governing-tread definer chain scans every tenant's history on each submit. Valuation verifier. TYRE-257 follows it |
| 2 | TYRE-239, the dashboard, with the chart half of TYRE-275 (tooltip placement, and more than five bands blended, U56). Closes TYRE-193 and TYRE-271 | W5b: TYRE-209 with TYRE-108 (rotate only), 112, 134, 135, 136 and 137 riding |
| 3 | B9, the pilot path, below | W5c: TYRE-175, 189 F5, 213 and 201 (source_ip only), with 297, 122 and 224 riding. TYRE-98 follows it |
| 4 | Capture PR (W3): TYRE-173 (F15 now, a capture-only caution shade, U76), 171, 218, 220, 241 (U78), 129, 154, 207 F11, 285 (with 216's on-road swap, U62), 323 and 329. Then photos, TYRE-152. Then TYRE-70's handset run | W5d: TYRE-168, 189 F4 and 190 F10 |
| 5 | W2: TYRE-156, 157, 159, 141, 115, 116, 186 F12, 187 (which takes TYRE-140 items 1 and 4), 274 and the Dialog focus half of 275 | W5e: TYRE-210, taking 189 F6, with 265 |
| 6 | B7.4: TYRE-240, the redesign, carrying TYRE-119, 132, 176, 182, 278, 281, 291, 327, 328 and 330 | |
| 7 | Reports and export: TYRE-320 with 287, 290 and 292 (292 waits on TYRE-109). Milestone M4 | |
| 8 | B8: TYRE-243, the exception lifecycle, rule administration and notifications, with TYRE-58 riding. Milestone M5. TYRE-44 must be answered first | |
| 9 | Import, TYRE-322, and pilot readiness, TYRE-321. Milestone M6 | |

W5b, W5c and W5d each rewrite the lifecycle functions migration 000039
created, so the database lane stays one PR after another. TYRE-214 is parked,
so W5e ends the chain.

## B9, the pilot path

Planned as one spec before it starts, then sliced. Each slice is an H.1 Must
that no batch owned before 24 Sep.

| Slice | Tickets | Why it gates the pilot |
|---|---|---|
| Login | TYRE-317, the only open child of TYRE-2 | FR-AUT-001 and 016; milestones M1 and M6. Staging answers 401 to everyone until it lands |
| Staging | TYRE-79, then TYRE-51 on the Standard SKU with a linked backend (U75), which also carries NFR-SEC-010's web headers from TYRE-205; TYRE-53 rides 79; TYRE-203; the owner's TYRE-63 | Every demo is a laptop until this lands |
| Onboarding and the catalogue | TYRE-318 first, then TYRE-286, 288, 102, 283 and 99 | H.1 says the pilot register is built through first inspections. Today a tyre received in the app records no size, brand, pattern or tread |
| Driver self-start and schedules | TYRE-319 first (U74), then TYRE-133 | A driver reaches capture only through a task; H.3 gate 4 needs schedules |
| What a manager sees | TYRE-325, 324 and 326 | After a submit, no manager screen shows anything, and the unit screen's "Last tread" ignores inspections |
| Depot capture | TYRE-76 | D6 puts it before the pilot |

## Constraints every branch carries

The capture route's entry closure is 134917 gzip bytes, exactly the figure in
`web/bundle-budget.json` (recorded 23 Sep 2026), and the gate only lets that
figure go down. Every capture-route change in the queue adds bytes: TYRE-282's
helper, the W3 PR, photos and the manifest. Each such PR re-records the budget
in its own commit and says why, so the growth is a decision, not an accident
(ADR-0015).

BAC Transport is the acceptance fixture. Tests and demos type in Sandbox Fleet
(TYRE-80) and only browse BAC.

## B7, analytics and dashboard

Cut 10 Sep 2026 on the owner's call. Design:
`docs/superpowers/specs/2026-09-10-b7-analytics-dashboard-design.md`.

| Slice | Tickets | State |
|---|---|---|
| B7.1 | TYRE-41, 183, 193 (view), 38 | **merged** 15 Sep 2026, PR [#55](https://github.com/Rourke9001/TyrePlatform/pull/55), migration 000045 |
| B7.1.5 | TYRE-252, TYRE-247 | **merged** 16 and 17 Sep 2026, PRs [#58](https://github.com/Rourke9001/TyrePlatform/pull/58) and [#61](https://github.com/Rourke9001/TyrePlatform/pull/61), migrations 000046 and 000047. The dashboard read path costs about 70 times its 500 ms budget on the 24-month volume tenant; on the fixture, `GET /api/dashboard` answered in 150 to 200 ms on 24 Sep. TYRE-256 (an ADR first), 257, 258 and 259 own it. None blocks TYRE-239; TYRE-256 blocks a tenant with months of history |
| B7.2 | TYRE-36, TYRE-193 (endpoint) | **merged** 20 Sep 2026, PR [#64](https://github.com/Rourke9001/TyrePlatform/pull/64), no migration |
| B7.3 | TYRE-238, then TYRE-239 | TYRE-238 is Done: PR [#66](https://github.com/Rourke9001/TyrePlatform/pull/66), PR [#70](https://github.com/Rourke9001/TyrePlatform/pull/70) and close-out PR [#71](https://github.com/Rourke9001/TyrePlatform/pull/71), 23 Sep 2026, ADR-0015 Accepted, mockups accepted (TYRE-238 comment 12936). Next is the rider PR, then TYRE-239 (steps 1 and 2 above) |
| B7.4 | TYRE-240 | After the capture PR and W2 (steps 4 to 6). The owner widened it from a restyle to a redesign of everything except the accepted dashboard and exceptions mockups (comments 12933 and 12937); capture stays out (U16) |

The open sprint, "B7.1.5/B7.2 - Analytics API" (16 to 30 Sep 2026), has two
issues left: TYRE-193, In Progress and closing with TYRE-239, and TYRE-253,
which rides the privileged-suite PR below.

## Homed, not scheduled

Decided and buildable, grouped where they share a file or a gate. Pull a group
when a gap appears.

- **Suite PR:** TYRE-245, 294, 300, 316 (tenant B rows, so check 2 cannot pass
  vacuously), 246 and the fitment pin from 248. **Privileged-suite PR:**
  TYRE-253 with TYRE-314 item 1, both in `db/tests/005_privileged.sql`.
- **Observation-surface test PR:** TYRE-230, 231, 234 and 235, no migration.
- **Tenant-day PR:** TYRE-123, 221 (which now carries 000041:529), 244 and
  TYRE-310 item 2 (U70: one "now" for every current figure). TYRE-131's
  refusal timestamps ride W5c or follow it.
- **Register money PR:** TYRE-113 and 120, behind the valuation verifier.
- **Threshold policy:** TYRE-298 (U68), 299 (U69, which also refuses a
  back-dated policy insert, U70), 296 after W5, and TYRE-305's pool of 7 (U71).
- **Gates and tooling:** TYRE-62, 110, 130, 138, 255, 264, 266, 267, 279, 293,
  311 (U72), 313 (U73), 315 and 331. TYRE-262 waits for W5e; TYRE-263 carries
  TYRE-192's leftover pattern under the applied-migration exemption.
- **Owner decisions now buildable:** TYRE-105 (U59), 118 (U61), 236 (U64) and
  270 (U66). TYRE-100 (U58, depot-to-depot transfer) waits for the H.1 paste.
- **Everything else open and valid:** TYRE-109, 114, 121, 139, 219, 223, 227,
  232, 249, 251 item 1, 268, 284 (rescoped to FR-INS-050 and gate 4), 289 and
  330. TYRE-191 stays open as the record of each frozen-migration comment,
  corrected by the next migration that touches its object (U65).

## Blocked on people, not code

**The owner:** sign the POC agreement (TYRE-15); register the domain before
TYRE-51 and TYRE-154 need it (TYRE-19); confirm or drop Renovate (TYRE-304);
remove the Key Vault Administrator assignment (TYRE-63); paste the H.1 row and
the TYRE-217 erratum into the SRS (TYRE-195, 217; the SRS pages exceed the
Confluence connector's limits); settle the POC agreement's M4 wording, which
still names six reports while H.2 defers three; and run the handset capture
(TYRE-70).

**The sponsor:** driver-to-unit assignment (TYRE-44), before B8; whether
pressure is gauged today (TYRE-46), before the dashboard shows an
inflation-compliance figure.

**Parked post-POC.** TYRE-13, 47, 59, 60, 61, 73, 106, 214, 228 and 295 carry
the label `post-poc`. They stay open and off the active board. TYRE-13 and
TYRE-47 keep their rows in `open-issues.md`.

## Re-verifying this page

The method, so the next session can redo it rather than trust it:

```
gh pr list --state open                        # open review work
git log origin/develop --pretty=%s \           # keys actually on develop
  | grep -oE 'TYRE-[0-9]+' | sort -u
git rev-parse origin/develop^{tree} \          # develop and main must agree
             origin/main^{tree}                # after a promotion
```

Match against the board with a `statusCategory != Done` search, excluding the
`post-poc` label, and read the open sprint with `sprint in openSprints()`. A
key present on `develop` and open on the board is a candidate, not a
conclusion. Read the ticket's definition of done before closing it: a key
whose only commit on `develop` is the one that homed it in a page like this
one has been written down, not built.

The third command is the 29 Aug lesson. Compare **trees**, never hashes: a
promotion that went through a pull request rewrites every hash while leaving
the tree identical, so equal trees mean the branches agree and unequal hashes
alone mean nothing. If `origin/develop` is missing entirely, it was deleted by
`deleteBranchOnMerge` and is restored with
`git push origin origin/main:refs/heads/develop`.
