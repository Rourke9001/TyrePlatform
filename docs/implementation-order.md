# Implementation order

Re-verified **17 Oct 2026** against `develop` @ `b102945` and the board,
at the close-out of PR #128.

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
TYRE-299, TYRE-201 with 98 and TYRE-175 with its riders (all merged), all before TYRE-286
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
TYRE-368 to 374. Nothing was live then: no user could sign in on staging, its
database was about 42 migrations behind, and a tyre received that day could
never be valued. Since 11 Oct 2026 staging deploys from `develop` and its
database is at head (#105).
So B9 starts now instead of 14 Oct, the before-data items go ahead of W5b, and
W2 and B7.4 wait behind what a real driver and a real fleet meet. Search Jira
with `text ~ "Owner ruling" ORDER BY updated DESC` to find the rulings.

On 8 Oct 2026 the owner approved a second prune, which took the board from
213 open tickets to 172. TYRE-279 was already solved, 33 small tickets were
folded into the 21 tickets whose PR would carry them (each parent has a "Folds
in" comment with the folded scope), and the eight parked tickets were closed
for the POC. TYRE-392 closed as not needed: phones are personally owned
(OI-07), so the U104 undo at sign-in stays (U115). Search Jira for "8 Oct 2026
board prune".

On 13 Oct 2026 the owner approved a third prune, TYRE-423, which put every
open ticket through U130's schedule test: would the owner schedule it before
the pilot? It took the board from 181 open tickets to 126, and from 173 to
102 without `post-poc`. Four closed as done, 32 were folded into the ticket
whose PR carries them (each target has a "Folds in" comment), two owner
questions became comments on their parents, 17 closed as won't do, and 24
carry `post-poc` at Low. Priority now means something: High is on the pilot
path in this page, Medium is before the pilot, and Low only just passes the
test. Search Jira for "triage TYRE-423".

## The queue

The owner set the order on 24 Sep 2026 (U80, on TYRE-239) and revised it on
30 Sep (U88, U99). Two lanes run side by side because they touch disjoint
files: web, API and infrastructure work on the left, database work on the
right.

| Step | Web, API and infrastructure lane | Database lane |
|---|---|---|
| 1 | **Merged** 25 Sep 2026, PR [#81](https://github.com/Rourke9001/TyrePlatform/pull/81): the rider PR, TYRE-276 (U53), TYRE-282 (U55), TYRE-280 (U54) and TYRE-269 (migration 000049), with TYRE-338 | **Merged** 29 Sep 2026, PR [#83](https://github.com/Rourke9001/TyrePlatform/pull/83): TYRE-259 with TYRE-348, migration 000050 and suite sections 65 and 66. The definer chain's MIN() and latest-reading lookup name their tenant; the volume load went from 862 s to 248 s. TYRE-346, 347, 349 and 350 are its residuals. TYRE-257 is deferred with 256 and 258 (U88) |
| 2 | **Merged** 30 Sep 2026, PR [#87](https://github.com/Rourke9001/TyrePlatform/pull/87): TYRE-239, the dashboard, with the chart half of TYRE-275 (tooltip placement, and more than five bands blended, U56). No migration. The capture entry budget rose once, from 135255 to 135877 gzip bytes (U84). TYRE-193 and TYRE-271 closed with it; the review's residuals are TYRE-354 to 367 | **Merged** 30 Sep 2026, PR [#89](https://github.com/Rourke9001/TyrePlatform/pull/89): TYRE-346 with TYRE-300. The definer's EXECUTE is revoked from PUBLIC and app_rw (migration 000051, suite section 67), and the Appendix E pins and their siblings compare NULL-safely. TYRE-375 is the residual, carried on TYRE-245. On staging, 000051 must be applied by the owner role (TYRE-368, comment 13439) |
| 3 | B9, the pilot path, below, started 30 Sep (U99). Sign-in's code **merged** 2 Oct 2026, PRs [#92](https://github.com/Rourke9001/TyrePlatform/pull/92), [#93](https://github.com/Rourke9001/TyrePlatform/pull/93) and [#94](https://github.com/Rourke9001/TyrePlatform/pull/94): migration 000052, suite section 68, and TYRE-376 closed with it. TYRE-317's first staging sign-ins ran on 19 Oct 2026 (comments 13832 and 13836), and it stays open for check d; the CIAM checks passed and U110 to U113 were ruled on 2 Oct. `main` is first promoted as production's first release (ADR-0017, TYRE-397), after TYRE-79's gate, the TYRE-368 runbook and the TYRE-374 staging steps (U89), and not before sign-in's stage 2 | **Merged** 14 Oct 2026, PR [#114](https://github.com/Rourke9001/TyrePlatform/pull/114): TYRE-299, carrying 298 and 310, with 189 F5. Threshold policy rows are written once and never back-dated (migration 000054, suite section 70, U69, U70). On staging, the owner role applies the REVOKE. TYRE-299 stays open until the SRS erratum rows (comment 13723) are pasted into Confluence |
| 4 | W3's real-driver subset, before the real-vehicle run (M2): 323, and photos (TYRE-152) or a softened photo string. TYRE-241 (U78) is done: **merged** 16 Oct 2026, PR [#124](https://github.com/Rourke9001/TyrePlatform/pull/124), a test only (`web/e2e/sheetFit.spec.ts`), the clipping does not reproduce | **Merged** 14 Oct 2026, PR [#116](https://github.com/Rourke9001/TyrePlatform/pull/116): TYRE-201, carrying TYRE-383 (migration 000055, suite section 71). The audit trigger and `app.record_session_start()` record the bound address and session through `app.current_source_ip()`. Then **merged** 15 Oct 2026, PR [#118](https://github.com/Rourke9001/TyrePlatform/pull/118): TYRE-98, migration 000056, suite section 72; the audit trigger reaches nine more tables (ADR-0014). Its FR-AUD-001 erratum is TYRE-427 |
| 5 | B8: TYRE-243, the exception lifecycle, rule administration and notifications, with TYRE-58 riding, on TYRE-371's job runner. 243's definition of done is a spec, so the build takes its own ticket. It must be live before the measured window opens (agreement 11.2). Milestone M5 | **Merged** 15 Oct 2026, PR [#120](https://github.com/Rourke9001/TyrePlatform/pull/120): TYRE-175, carrying 224 and 213's view (migration 000057, suite section 73). `orientation_known` has no default, a future receive date is TY011, and `app.v_axle_side_divergence` is dropped. 213's warning helper rides TYRE-283. TYRE-122 and 297 closed with #110's 000053 |
| 6 | Reports and export: TYRE-320, carrying 290, with 287 and 292 (292 waits on TYRE-109). Milestone M4 | W5b: TYRE-209, carrying both halves of TYRE-108 (rotate and return), 134, 135 (with 136) and 137, with 112 riding |
| 7 | Pilot readiness, TYRE-321. Milestone M6 | W5d: TYRE-168 (before TYRE-322's odometer import) and TYRE-190, carrying its F10 and 189 F4 |
| 8 | The rest of the capture PR (W3): TYRE-173 (F15 now, a capture-only caution shade, U76), 171 (with the odometer hint from 330, closed), 218, 129, 154, 207 F11, 285 (with 216's on-road swap, U62) and 329, and the error-boundary residuals on capture: TYRE-334, carrying 333, 335, 339 and 340. TYRE-220's GO-key check landed with TYRE-241 (PR #124); its handset confirmation waits for the M2 real-phone run. TYRE-337 waits for the BAC pilot's feedback (labels `pilot-feedback` and `post-poc`), and 342 waits on the owner's call | W5e: TYRE-210, taking 189 F6. Deferred (U88); 265 is `post-poc` |
| 9 | W2: TYRE-157 (after TYRE-156), 159, 140's remaining items (carrying 141), 115, and the rest of TYRE-275 (Dialog focus, and the chart tooltip's Escape and `aria-hidden`, WCAG 1.4.13, comment 13401). TYRE-156, 186 and 187 (which takes TYRE-140 items 1 and 4) are `post-poc`, and 116 and 274 closed (TYRE-423) | |
| 10 | B7.4: TYRE-240, the redesign, carrying TYRE-119, 176 (with 278), 281, 291, 327, 328 and 182. TYRE-132, 345 and 359 are folded into it. Behind the pilot items (U99) | |

TYRE-318 took migration 000053 and suite section 69. TYRE-299 took 000054 and
section 70, and TYRE-201 took 000055 and section 71. TYRE-98 took 000056 and section 72, and TYRE-175 took 000057 and section 73. TYRE-369 took 000058 and section 74. The next free pair is 000059 and section 75, taken by whichever
database branch is cut first.

The database lane runs one PR after another because each takes the next
migration number and suite section, not because the function bodies overlap.
W5b edits `fit_tyre`, `remove_tyre`, `rotate_tyres` and `return_tyre_to_stock`;
TYRE-175's PR edited `receive_tyres` (000057); TYRE-201's
edits the audit trigger (000035). TYRE-214 is closed for the POC, so W5e ends
the chain. The privileged-suite PR (TYRE-253, carrying TYRE-314 and 349) is
`post-poc`.

## B9, the pilot path

Planned as one spec before it starts, then sliced. Each slice is an H.1 Must
that no batch owned before 24 Sep.

| Slice | Tickets | Why it gates the pilot |
|---|---|---|
| Login | TYRE-317, the only open child of TYRE-2, with TYRE-376 closing alongside. The design is `docs/superpowers/specs/2026-09-30-b9-sign-in-design.md` with ADR-0016 (PR #90), from U91 and U100 to U104: a bearer token validated in Go; the tenant as an Entra claim, proven by the RLS lookup by `oid`; the dev header resolver compiled out; held inspections stamped with their driver. Its three PRs **merged** 2 Oct 2026 (#92 database and API, #93 web, #94 the runbook draft) and TYRE-376 is Done. Its first real sign-ins ran on staging on 19 Oct 2026, one per tenant (comments 13832 and 13836), and TYRE-317 stays open for check d. The owner's CIAM checks a, b, c and c2 passed on 2 Oct 2026 (comment 13468, Confluence page 10682399) and the runbook carries their values. The owner ruled U110 A and U111, U112 B (comment 13472), U113 A (a passcode user is created by Graph, comment 13469) and TYRE-387 A (a platform admin makes a tenant ACTIVE before its first ORG_ADMIN). TYRE-373 carries the SRS changes, with 387's FR-TEN-009 erratum; 387's tenant activation step rides TYRE-374. Of the code review's residuals, TYRE-381, 388 and 389 (carrying 385) stay open: U111 B landed as TYRE-396 (#101, 9 Oct 2026), which overtook 382 and narrowed 388 to bounding the redirect callback's wait, and 389 comes before any send dedupe. 383 rides TYRE-201, 384, 386 and 391 closed, and 393 is `post-poc` (TYRE-423). U112 B and TYRE-392 (U114) were dropped on 8 Oct 2026: phones are personally owned, so the U104 undo at sign-in stays (U115) | FR-AUT-001 and 016; milestones M1 and M6. Staging answers 401 to everyone until stage 2 is done and the Staging slice below lands |
| Staging | **Merged** 11 Oct 2026, PR [#105](https://github.com/Rourke9001/TyrePlatform/pull/105) (`e055ae2`): TYRE-79 with TYRE-368 and TYRE-53 (spec `2026-10-09-staging-deploy-path-design.md`, ADR-0017). Staging deploys from `develop` through CI, the template is split (U117), and `docs/runbooks/environment-release.md` brings an environment up and migrates it; it reset staging and migrated it to 000052 on 11 Oct. TYRE-79, TYRE-368 and TYRE-53 are Done, and the first release row is on Confluence page 10682399. Of its residuals, TYRE-402 and 405 (carrying 408) closed with TYRE-51, which leaves TYRE-397 carrying 401, 403 and 313 and 411's question on the gate, which it answers: the gate stands; 410 stays open, 409 rides TYRE-414, and 400, 404, 406 and 407 closed (TYRE-423). Production is TYRE-397: its PR adds production's templates, backups and deploy, with TYRE-203's Bicep half and TYRE-313, 401, 403, 411 and 433 folded in, and the owner brings production up after the merge (`docs/runbooks/environment-release.md`, Production bring-up). Post-deploy smoke tests are TYRE-398. TYRE-51 **merged** 16 Oct 2026, PR [#126](https://github.com/Rourke9001/TyrePlatform/pull/126) (`7afbce8`), under U137 (comment 13779, ADR-0019): the web calls the API at the Container App's own origin over CORS, with the Static Web App on the Free SKU, not U75's Standard SKU and linked backend. TYRE-51, TYRE-341, TYRE-402, TYRE-405 and TYRE-408 are Done, with NFR-SEC-010's web headers from TYRE-205 in the same config file. TYRE-305 closed on 19 Oct 2026 with the staging figures and the DSN check (comment 13834). **Merged** 17 Oct 2026, PR [#128](https://github.com/Rourke9001/TyrePlatform/pull/128) (`b102945`, no migration): half of TYRE-374, the provisioning procedure (`db/seeds/provision_tenant.py`), `docs/runbooks/provision-a-tenant.md` with TYRE-387's activation step, and the demonstration tenant's generator. The owner's steps ran on 19 Oct 2026: staging was first migrated from 000054 to 000058, then Sandbox Fleet and Demonstration Fleet were provisioned and made ACTIVE, each with a linked ORG_ADMIN, and recorded on page 10682399 (U92, U116). TYRE-374 is Done (comments 13830, 13831 and 13833). Production starts empty: BAC's account is created at TYRE-321's live onboarding (U139). Residuals: TYRE-432 (configuration and target_pressure editable in place, before the pilot) and TYRE-433 (nothing flags a merge that owes staging a migrate) | Staging serves `develop`'s head since 11 Oct, and since 19 Oct 2026 both its tenants' ORG_ADMINs sign in there (TYRE-317 comments 13832 and 13836) |
| Onboarding and the catalogue | **Merged** 13 Oct 2026, PR [#110](https://github.com/Rourke9001/TyrePlatform/pull/110) (`26c950e`, migration 000053): TYRE-318 with TYRE-370, 421 and 422, the first ticket through `make pipeline` (TYRE-412, ADR-0018). `GET /api/tyre-catalogue` and the Receive tyres pickers are live, and `receive_tyres` refuses a tyre it cannot rate. Then **merged** 16 Oct 2026, PR [#122](https://github.com/Rourke9001/TyrePlatform/pull/122) (migration 000058, suite section 74): TYRE-369, the tenant's catalogue, per-size casing estimates and price list, which also closed TYRE-427. Next TYRE-286, 288, 102 (carrying 420, `log_retread_return`'s pattern check), 283, 99 and 419 (the cost form's pre-selected INVOICE), and TYRE-322 with TYRE-168 (U99) | H.1 builds the pilot register through first inspections (U93). A tyre received before TYRE-318 recorded no size or new tread and could never be rated, so no real tyre was received before it. TYRE-418, supplier at receipt, proposes an SRS change and comes before the pilot; TYRE-417, the catalogue admin screen, is `post-poc`, since H.1 lets the catalogue be seeded (TYRE-369) |
| Driver self-start and schedules | TYRE-319 first (U74, carrying TYRE-390's way back to a task-less draft), then TYRE-133 on TYRE-371's job runner, with TYRE-284's compliance read (U99) | A driver reaches capture only through a task; H.3 criterion 4 needs schedules and a count of tasks done on time |
| What a manager sees | TYRE-325, 324 and 326 | Since #87 the dashboard reflects submits in aggregate, but no screen shows an inspection or its readings, and the unit screen's "Last tread" ignores inspections |
| Depot capture | TYRE-76 | D6 puts it before the pilot |

## Constraints every branch carries

The capture route's entry closure budget is 139268 gzip bytes in
`web/bundle-budget.json`, recorded 8 Oct 2026 by TYRE-396 (#101, +40 for the
renewal's subject check). The token store, the driver stamp and the gate
screens sit in the entry (TYRE-317, #93, U100); the identity client loads in a
lazy chunk. The gate only lets that figure go down. Every
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

- **Suite PR:** TYRE-245, carrying 246, 294, 316 (tenant B rows, so check 2
  cannot pass vacuously) and 375, with the fitment pin from 248 and the
  suite half of 62 (its folded 249 half is set aside).
- **Tenant-day PR:** TYRE-123, carrying 221 (with 000041:529), and 244,
  carrying 360 and TYRE-310 item 2 (U70: one "now" for every current
  figure). TYRE-131's
  refusal timestamps follow TYRE-175's PR (merged).
- **Register money PR:** TYRE-113 and 120, behind the valuation verifier.
- **Dashboard residuals** from the TYRE-239 review: TYRE-354 (with U96's
  `me.scope` word, carrying 362 and 355's degraded states), 363 (U97's pin),
  366 (after TYRE-109) and 367 (U98's list page). U90's depot list is
  TYRE-372, carrying 365's depot-scope tests. 356 and 357 (with 364) closed,
  and 358 is `post-poc` beside TYRE-256.
- **Sign-in residuals** from the code review of #92 to #94: TYRE-381, 388
  (narrowed to bounding the callback's wait) and 389 (which bounds the
  request before any send dedupe, carrying 385). TYRE-383 rides database
  step 4. U111 B (TYRE-317 comment 13472) landed as TYRE-396 (#101) and
  overtook 382; U112 B and TYRE-392 were dropped (U115). 384, 386 and 391
  closed, and TYRE-393, an invite that creates the Entra account, is
  `post-poc`: it comes before a second customer onboards. From
  sign-in's planning: TYRE-377 (no endpoint deactivates a user), 378 (the
  unused Graph grant) and 379 (the Go 1.24 pin). TYRE-380, a dashboard test
  that races its debounce under load, belongs with gates and tooling.
- **Gates and tooling:** TYRE-304 (Renovate runs, but its two regex
  managers detect nothing), 255, 311 (U72), 361 (carrying 331), 395 (CI
  holds a code PR until its separate review is recorded, TYRE-394),
  TYRE-413 (the allow list lets a session merge a PR or push to `develop`
  with no prompt), 414 (the pipeline and close-out leftovers from TYRE-412,
  carrying 409 and TYRE-415's question), and the confinement gap from the
  rider PR's review: TYRE-343 (carrying 336). TYRE-263 carries TYRE-192's
  leftover pattern under the applied-migration exemption and TYRE-110's
  `.css` fixture case. TYRE-313's guard on PRs into `main` (U73) rides
  TYRE-397. 130, 138, 293 and 344 closed (TYRE-423).
- **Owner decisions now buildable:** TYRE-100 (U58, depot-to-depot transfer;
  the H.1 paste landed 24 Sep), 105 (U59), 236 (U64) and 270 (U66). 118
  (U61) is closed.
- **Everything else open and valid:** TYRE-109 (which TYRE-292 waits on at
  step 6), 121, 227 and 289. TYRE-191 stays open as the record of each
  frozen-migration comment, corrected by the next migration that touches
  its object (U65), and carries 223's. 139, 219 and 330 closed.

## Blocked on people, not code

**The owner:** run sign-in's check d (TYRE-317 comment 13440) from
20 Oct 2026, 24 hours after the first staging sign-in, and TYRE-381's device
check; decide whether the live pressure entry groups thousands (TYRE-342);
decide whether the governing-tread definer runs as an owner that RLS binds
(TYRE-350), now that the staging query is in (TYRE-305 comment 13834: the
definer's owner is `tyreadmin`, which bypasses RLS); and decide
whether a fresh reviewer teammate checks a pipeline branch before its PR
opens (TYRE-414, from 415). TYRE-154
needs the platform domain, which the team registers outside Jira.

Sponsor, commercial, IP and legal questions are handled by the team outside
the project; Jira carries codebase and infrastructure work only (owner,
29 Sep 2026).

**Parked post-POC.** TYRE-59, 60, 61, 73, 106, 214, 228 and 295 were closed
for the POC on 8 Oct 2026 and keep the label `post-poc`, so they can be
reopened after the pilot. TYRE-256, 257, 258 and the TYRE-260 refactors (262,
264 to 267) carry the same label and stay open, off the active board. The
TYRE-423 triage on 13 Oct 2026 labelled 16 more and set all 24 to Low:
TYRE-114, 156, 186, 187, 230 (carrying 231, 234 and 235), 232, 251 item 1,
253 (carrying 314 and 349), 268, 296, 315, 337, 347, 358, 393 and 417.

## Re-verifying this page

The method, so the next session can redo it rather than trust it:

```
gh pr list --state open                        # open review work
git log origin/develop --pretty=%s \           # keys actually on develop
  | grep -oE 'TYRE-[0-9]+' | sort -u
git merge-base --is-ancestor origin/main \     # main must be a develop
  origin/develop && echo ok                    # commit
```

Match against the board with a `statusCategory != Done` search, excluding the
`post-poc` label, and read the open sprint with `sprint in openSprints()`. A
key present on `develop` and open on the board is a candidate, not a
conclusion. Read the ticket's definition of done before closing it: a key
whose only commit on `develop` is the one that homed it in a page like this
one has been written down, not built.

The third command checks ancestry, not trees. `main` is the `develop`
commit production runs, so between promotions it sits behind `develop`'s
head and the trees differ; what must hold is that `main` is an ancestor of
`develop`. If it is not, a commit reached `main` some other way (ADR-0004).
If `origin/develop` is missing entirely, it was deleted by
`deleteBranchOnMerge`. Restore it from the head of its newest CI push run,
not from `main`, which would drop every commit not yet promoted:
`gh run list -R Rourke9001/TyrePlatform --branch develop --event push --limit 1 --json headSha --jq '.[0].headSha'`,
then `git push origin <that sha>:refs/heads/develop`.
