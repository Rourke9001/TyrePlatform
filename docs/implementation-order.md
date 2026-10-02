# Implementation order

Re-verified **2 Oct 2026** against `develop` @ `437bdff` and the board, at
the close-out of sign-in's three PRs (#92 to #94, TYRE-317 and TYRE-376).

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase. Where this
page and the board
disagree, the board wins, and the disagreement is a bug in this page.
Re-verify before trusting anything below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built. Batches B1 to B6 have all merged,
and so have B7.1 to B7.3, the rider PR and TYRE-259. The records of B1 to B6,
and the rationale each one left for the batch after it, are in
`docs/delivery-history.md`; a citation written as
`docs/implementation-order.md §B5` resolves to the same-named section there.
The B7 slices are recorded in the B7 table below.

## Two ordering rules

Dependency first. Then, more sharply: an integrity rule is cheap before pilot
data exists and expensive after, because afterwards it has to be retrofitted
around rows that already violate it. That is why the database constraints came
before any surface that writes, and why the database lane below takes first the
items whose loss is permanent once real rows exist: TYRE-346 with 300, then
TYRE-299, TYRE-201 with 98, and TYRE-175 with its riders, all before TYRE-286
or TYRE-322 write a real tenant's receipts (U88). W5b and the rest of the W5
chain are refactors that write no wrong row, so they follow.

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

On 30 Sep 2026 the owner read a review of the POC against Appendix H.3 and
answered twelve decisions, posted on their tickets as U88 to U99, which raised
TYRE-368 to 374. Nothing is live yet: no user can sign in on staging, its database
is about 42 migrations behind, and a tyre received today can never be valued.
So B9 starts now instead of 14 Oct, the before-data items go ahead of W5b, and
W2 and B7.4 wait behind what a real driver and a real fleet meet. Search Jira
for "Owner ruling U" to find the rulings.

## The queue

The owner set the order on 24 Sep 2026 (U80, on TYRE-239) and revised it on
30 Sep (U88, U99). Two lanes run side by side because they touch disjoint
files: web, API and infrastructure work on the left, database work on the
right.

| Step | Web, API and infrastructure lane | Database lane |
|---|---|---|
| 1 | **Merged** 25 Sep 2026, PR [#81](https://github.com/Rourke9001/TyrePlatform/pull/81): the rider PR, TYRE-276 (U53), TYRE-282 (U55), TYRE-280 (U54) and TYRE-269 (migration 000049), with TYRE-338 | **Merged** 29 Sep 2026, PR [#83](https://github.com/Rourke9001/TyrePlatform/pull/83): TYRE-259 with TYRE-348, migration 000050 and suite sections 65 and 66. The definer chain's MIN() and latest-reading lookup name their tenant; the volume load went from 862 s to 248 s. TYRE-346, 347, 349 and 350 are its residuals. TYRE-257 is deferred with 256 and 258 (U88) |
| 2 | **Merged** 30 Sep 2026, PR [#87](https://github.com/Rourke9001/TyrePlatform/pull/87): TYRE-239, the dashboard, with the chart half of TYRE-275 (tooltip placement, and more than five bands blended, U56). No migration. The capture entry budget rose once, from 135255 to 135877 gzip bytes (U84). TYRE-193 and TYRE-271 closed with it; the review's residuals are TYRE-354 to 367 | **Merged** 30 Sep 2026, PR [#89](https://github.com/Rourke9001/TyrePlatform/pull/89): TYRE-346 with TYRE-300. The definer's EXECUTE is revoked from PUBLIC and app_rw (migration 000051, suite section 67), and the Appendix E pins and their siblings compare NULL-safely. TYRE-375 is the residual. On staging, 000051 must be applied by the owner role (TYRE-368, comment 13439) |
| 3 | B9, the pilot path, below, started 30 Sep (U99). Sign-in's code **merged** 2 Oct 2026, PRs [#92](https://github.com/Rourke9001/TyrePlatform/pull/92), [#93](https://github.com/Rourke9001/TyrePlatform/pull/93) and [#94](https://github.com/Rourke9001/TyrePlatform/pull/94): migration 000052, suite section 68, and TYRE-376 closed with it. TYRE-317 stays open for its first staging sign-in and U110 to U113; the CIAM checks passed on 2 Oct. `main` is promoted once, as the first verified release, after TYRE-79's gate, the TYRE-368 runbook and the TYRE-374 reset (U89), and not before sign-in's stage 2 | TYRE-299 with 189 F5 and 298: threshold policy rows written once, and no back-dated insert (U69, U70) |
| 4 | W3's real-driver subset, before the real-vehicle run (M2): TYRE-241 (U78), 323, and photos (TYRE-152) or a softened photo string | TYRE-201 (source_ip) with TYRE-98's six tables, and TYRE-383 (`record_session_start()`'s `::inet` cast) before 201 binds `app.source_ip`. TYRE-317 (000052) binds `app.session_id` and adds `app.record_session_start()`; this step has the trigger read both GUCs |
| 5 | B8: TYRE-243, the exception lifecycle, rule administration and notifications, with TYRE-58 riding, on TYRE-371's job runner. 243's definition of done is a spec, so the build takes its own ticket. It must be live before the measured window opens (agreement 11.2). Milestone M5 | TYRE-175 F12 to F14 with 122, 297, 224 and 213 F4, before TYRE-286 or TYRE-322 write receipts |
| 6 | Reports and export: TYRE-320 with 287, 290 and 292 (292 waits on TYRE-109). Milestone M4 | W5b: TYRE-209 with TYRE-108 (rotate only; its return half is open on TYRE-108), 112, 134, 135, 136 and 137 riding |
| 7 | Pilot readiness, TYRE-321. Milestone M6 | W5d: TYRE-168 (before TYRE-322's odometer import), 189 F4 and 190 F10 |
| 8 | The rest of the capture PR (W3): TYRE-173 (F15 now, a capture-only caution shade, U76), 171, 218, 220, 129, 154, 207 F11, 285 (with 216's on-road swap, U62) and 329, and the error-boundary residuals on capture: TYRE-333, 334, 339 and 340, with 337 and 342 once the owner has called them | W5e: TYRE-210, taking 189 F6, with 265. Deferred (U88) |
| 9 | W2: TYRE-156, 157, 159, 141, 115, 116, 186 F12, 187 (which takes TYRE-140 items 1 and 4), 274, the rest of TYRE-275 (Dialog focus, and the chart tooltip's Escape and `aria-hidden`, WCAG 1.4.13, comment 13401), and TYRE-335 (focus after an in-place retry) | |
| 10 | B7.4: TYRE-240, the redesign, carrying TYRE-119, 132, 176, 182, 278, 281, 291, 327, 328, 330, 345 and 359. Behind the pilot items (U99) | |

TYRE-317 took migration 000052 and suite section 68. The next free pair is
000053 and section 69, taken by whichever database branch is cut first.

The database lane runs one PR after another because each takes the next
migration number and suite section, not because the function bodies overlap.
W5b edits `fit_tyre`, `remove_tyre`, `rotate_tyres` and `return_tyre_to_stock`;
TYRE-175's PR edits `receive_tyres` and `set_tyre_cost` (000031); TYRE-201's
edits the audit trigger (000035). TYRE-214 is parked, so W5e ends the chain.
The privileged-suite PR (TYRE-253 with TYRE-314 item 1) touches only
`db/tests/005_privileged.sql` and runs beside any of them.

## B9, the pilot path

Planned as one spec before it starts, then sliced. Each slice is an H.1 Must
that no batch owned before 24 Sep.

| Slice | Tickets | Why it gates the pilot |
|---|---|---|
| Login | TYRE-317, the only open child of TYRE-2, with TYRE-376 closing alongside. The design is `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md` with ADR-0016 (PR #90), from U91 and U100 to U104: a bearer token validated in Go; the tenant as an Entra claim, proven by the RLS lookup by `oid`; the dev header resolver compiled out; held inspections stamped with their driver. Its three PRs **merged** 2 Oct 2026 (#92 database and API, #93 web, #94 the runbook draft) and TYRE-376 is Done. TYRE-317 stays open for three things. The owner's CIAM checks a, b, c and c2 passed on 2 Oct 2026 (comment 13468, Confluence page 10682399) and the runbook carries their values; the first real sign-in waits on the Staging slice below. U110 to U112 (comment 13464) and U113 (comment 13469: a passcode user is created by Graph in a shape Microsoft does not document) await the owner. TYRE-387 asks whether a PROVISIONING tenant may sign in (UC-05). TYRE-373 carries the SRS changes. The code review's residuals are TYRE-381 to 391 except 387; TYRE-388 waits on U111, and 389 comes before any send dedupe | FR-AUT-001 and 016; milestones M1 and M6. Staging answers 401 to everyone until stage 2 is done and `main` is promoted |
| Staging | TYRE-79, then TYRE-51 on the Standard SKU with a linked backend (U75), which also carries NFR-SEC-010's web headers from TYRE-205 and needs TYRE-341's `navigationFallback` in the same config file; TYRE-53 rides 79; TYRE-305's pool of 7 (U71); TYRE-203's Bicep half; TYRE-368, the migration runbook with `btree_gist` allow-listed (U94); TYRE-374, the reset and the pilot tenants (U92); the owner's TYRE-63 | Every demo is a laptop until this lands. Staging's database was last migrated by hand on 21 Aug |
| Onboarding and the catalogue | TYRE-318 first, with TYRE-370, then TYRE-369 (the tenant's catalogue, per-size casing estimates and price list), TYRE-286, 288, 102, 283 and 99, and TYRE-322 with TYRE-168 (U99) | H.1 builds the pilot register through first inspections (U93). A tyre received before TYRE-318 records no size or new tread and can never be rated, so no real tyre is received before it |
| Driver self-start and schedules | TYRE-319 first (U74), then TYRE-133 on TYRE-371's job runner, with TYRE-284's compliance read (U99) | A driver reaches capture only through a task; H.3 criterion 4 needs schedules and a count of tasks done on time |
| What a manager sees | TYRE-325, 324 and 326 | Since #87 the dashboard reflects submits in aggregate, but no screen shows an inspection or its readings, and the unit screen's "Last tread" ignores inspections |
| Depot capture | TYRE-76 | D6 puts it before the pilot |

## Constraints every branch carries

The capture route's entry closure budget is 139228 gzip bytes in
`web/bundle-budget.json`, recorded 2 Oct 2026 by TYRE-317's web PR (#93, U100:
the token store, the driver stamp and the gate screens; the identity client
loads in a lazy chunk). The gate only lets that figure go down. Every
capture-route change in the queue adds bytes: the W3 PR, photos and the
manifest. Each such PR re-records
the budget in its own commit and says why, so the growth is a decision, not an
accident (ADR-0015).

BAC Transport is the acceptance fixture. Tests and demos type in Sandbox Fleet
(TYRE-80) and only browse BAC. On staging the fixture loads only as a
separately named demonstration tenant, never under the pilot tenant's id
(U92), and the suite never runs there.

## B7, analytics and dashboard

Cut 10 Sep 2026 on the owner's call. Design:
`docs/superpowers/specs/2026-09-10-b7-analytics-dashboard-design.md`.

| Slice | Tickets | State |
|---|---|---|
| B7.1 | TYRE-41, 183, 193 (view), 38 | **merged** 15 Sep 2026, PR [#55](https://github.com/Rourke9001/TyrePlatform/pull/55), migration 000045 |
| B7.1.5 | TYRE-252, TYRE-247 | **merged** 16 and 17 Sep 2026, PRs [#58](https://github.com/Rourke9001/TyrePlatform/pull/58) and [#61](https://github.com/Rourke9001/TyrePlatform/pull/61), migrations 000046 and 000047. On 29 Sep, after TYRE-259, `GET /api/dashboard` took 42.6 to 49.7 s on the 24-month volume tenant against its 500 ms budget, and 0.145 to 0.200 s on the fixture (TYRE-239 comment 13398). TYRE-256 (an ADR first), 257 and 258 own it, deferred (U88): the pilot is 25 vehicles over four weeks, fuel records do not reach the read path, and TYRE-256 blocks only a tenant loaded with months of history |
| B7.2 | TYRE-36, TYRE-193 (endpoint) | **merged** 20 Sep 2026, PR [#64](https://github.com/Rourke9001/TyrePlatform/pull/64), no migration |
| B7.3 | TYRE-238, then TYRE-239 | **merged**. TYRE-238 is Done: PR [#66](https://github.com/Rourke9001/TyrePlatform/pull/66), PR [#70](https://github.com/Rourke9001/TyrePlatform/pull/70) and close-out PR [#71](https://github.com/Rourke9001/TyrePlatform/pull/71), 23 Sep 2026, ADR-0015 Accepted, mockups accepted (TYRE-238 comment 12936). The rider PR merged 25 Sep 2026, PR [#81](https://github.com/Rourke9001/TyrePlatform/pull/81), migration 000049. TYRE-239 merged 30 Sep 2026, PR [#87](https://github.com/Rourke9001/TyrePlatform/pull/87), no migration, with the chart half of TYRE-275; TYRE-193 and TYRE-271 closed with it |
| B7.4 | TYRE-240 | Behind the pilot items, W3 and W2 (steps 8 to 10, U99). The owner widened it from a restyle to a redesign of everything except the accepted dashboard and exceptions mockups (comments 12933 and 12937); capture stays out (U16) |

Sprint 34, the B7.1.5 and B7.2 sprint (16 to 30 Sep 2026), is still active on
the board with all three of its issues Done. Sprint 67, the B7.3 and W5b sprint
(30 Sep to 14 Oct 2026, not yet started), was planned around TYRE-239, which
merged before it began, and around W5b, which U88 moved behind the before-data
items. Sprint 68, the B9 sprint, is dated 14 to 28 Oct, but U99 starts B9 now.
The owner completes sprint 34 and moves the tickets in the browser.

## Homed, not scheduled

Decided and buildable, grouped where they share a file or a gate. Pull a group
when a gap appears.

- **Suite PR:** TYRE-245, 294, 316 (tenant B rows, so check 2 cannot pass
  vacuously), 246 and the fitment pin from 248. **Privileged-suite PR:**
  TYRE-253 with TYRE-314 item 1, both in `db/tests/005_privileged.sql`.
- **Observation-surface test PR:** TYRE-230, 231, 234 and 235, no migration.
- **Tenant-day PR:** TYRE-123, 221 (which now carries 000041:529), 244 and
  TYRE-310 item 2 (U70: one "now" for every current figure). TYRE-131's
  refusal timestamps follow TYRE-175's PR.
- **Register money PR:** TYRE-113 and 120, behind the valuation verifier.
- **Threshold policy:** TYRE-296 after W5.
- **Dashboard residuals** from the TYRE-239 review: TYRE-354 (with U96's
  `me.scope` word), 355 (its degraded states; U90's depot list is TYRE-372),
  356, 357, 358 (beside TYRE-256), 360 (an SRS check first), 362, 363 (U97's
  pin), 364, 365, 366 (after TYRE-109) and 367 (U98's list page). TYRE-359
  rides B7.4.
- **Sign-in residuals** from the code review of #92 to #94: TYRE-381, 382,
  384, 385, 386, 389 (which bounds the request before any send dedupe), 390
  and 391. TYRE-388 follows U111, and TYRE-383 rides database step 4. From
  sign-in's planning: TYRE-377 (no endpoint deactivates a user), 378 (the
  unused Graph grant) and 379 (the Go 1.24 pin). TYRE-380, a dashboard test
  that races its debounce under load, belongs with gates and tooling.
- **Gates and tooling:** TYRE-62, 110, 130, 138, 255, 264, 266, 267, 279, 293,
  311 (U72), 313 (U73), 315, 331, 361, and the lint and confinement gaps from
  the rider PR's review: TYRE-336, 343 and 344. TYRE-262 waits for W5e;
  TYRE-263 carries TYRE-192's leftover pattern under the applied-migration
  exemption.
- **Owner decisions now buildable:** TYRE-100 (U58, depot-to-depot transfer;
  the H.1 paste landed 24 Sep), 105 (U59), 118 (U61), 236 (U64) and 270 (U66).
- **Everything else open and valid:** TYRE-109, 114, 121, 139, 219, 223, 227,
  232, 249, 251 item 1, 268, 289 and 330. TYRE-191 stays open as the record of
  each frozen-migration comment, corrected by the next migration that touches
  its object (U65).

## Blocked on people, not code

**The owner:** answer U110 to U112 (TYRE-317 comment 13464) and U113
(comment 13469) and decide TYRE-387; once staging can sign anyone in, run
sign-in's check d (TYRE-317 comment 13440), TYRE-381's device check and the
`tyreadmin` role query (comment 13462); run the U94 read-only query on staging (TYRE-368, comment 13436)
before its reset; confirm or drop Renovate (TYRE-304); remove the Key
Vault Administrator assignment (TYRE-63); decide whether capture's "Try again"
takes the 56px glove size (TYRE-337) and whether the live pressure entry groups
thousands (TYRE-342); and, once the staging query is in, decide whether the
governing-tread definer runs as an owner that RLS binds (TYRE-350). TYRE-51
and TYRE-154 need the platform domain, which the team registers outside Jira.

Sponsor, commercial, IP and legal questions are handled by the team outside
the project; Jira carries codebase and infrastructure work only (owner,
29 Sep 2026).

**Parked post-POC.** TYRE-59, 60, 61, 73, 106, 214, 228 and 295 carry the
label `post-poc`. They stay open and off the active board.

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
