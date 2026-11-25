# Implementation order

Re-verified **17 Nov 2026** against `develop` @ `98d61d27` and the board
(TYRE-486): every open ticket without the `post-poc` label was read with its
links and comments. The plan is the pilot audit's
of 21 Oct 2026 (TYRE-452), which the owner approved that day: U145 (the
Tread rework), U146 (a bug found on a branch is fixed there) and U147 (the
board changes, the product answers and the pilot date). U156 moved the
Tread rework ahead of it on 26 Oct. On 3 Nov the owner placed TYRE-455,
457 and 458 (U162), and the rulings U161 and U163 raised 459, 460 and 461,
whose sprints are a default the owner can move. From 9 to 17 Nov the
pipeline ran the design audit's tickets and its own (TYRE-471 to 485), so
the sprints below did not advance. The run queue is the order work launches
in.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase. Where this
page and the board disagree, the board wins, and the disagreement is a bug in
this page. Re-verify before trusting anything below; the method is at the
end.

A sprint here is a sequencing claim, not a scope claim. Each ticket's own
definition of done, and the U147 comment on it, govern what gets built. What
has merged is recorded in `docs/delivery-history.md`, batch by batch: B1 to
B7, then B9 and the platform lane to 21 Oct 2026, then trips and Tread to
1 Nov 2026. A citation written as
`docs/implementation-order.md §B5` (or §B6, §B7) resolves to the same-named
section there.

## Two ordering rules

Dependency first. Then, more sharply: an integrity rule is cheap before pilot
data exists and expensive after, because afterwards it has to be retrofitted
around rows that already violate it. That is why TYRE-432 (425 folded in) makes
configuration rows written once before BAC's are provisioned, why TYRE-168
fixes distance coverage before TYRE-322 imports odometer history, and why
the register batch lands before the measured window.

Two standing rules from B5's close-out apply to every branch: the API
container is restarted immediately before every `make e2e` and never reused
across two runs, and no test derives a tenant-relative date from the browser
or CI clock (`docs/lessons.md`, 2026-09-03).

## The run queue

`make pipeline` runs one job at a time in this checkout, so the two lanes of
the 21 Oct plan are one line here (TYRE-486). Launch the rows top to bottom.
A row launches only after the row before it has merged, because a new run
stops while another run's PR is open (`/pipeline`, Before anything). When
a row's PR merges, close-out deletes the row (its step 5). The rows left
keep their numbers, so a reference to a row stays right.

The order is the plan's sprint order, with the database and web lanes taken
in turn. Two things differ from the sprint table below: TYRE-432 moves ahead
of the other sprint 2 database rows (Two ordering rules), and the tickets
that later rulings scheduled before the pilot sit after sprint 3. The order
is a default the owner can change. The last column is not: it holds each
row's dependencies.

How to read a row:

- **Launch** is the whole command. One key is a large ticket, unless the
  lead calls it a small fix. Several keys are a small-fix bundle, and the
  run stops if the lead calls any key not small; launch again without it.
- **Carries** names the tickets that ride in the same PR. Each pairing comes
  from the tickets' pilot audit comments of 21 Oct 2026 or a later ruling,
  and the launch ticket has a "Run queue" comment that restates it. The PR
  body carries a `Closes` line for each carried key, and the lead moves each
  at hand-over. `/pipeline` has no rule for a carried key and close-out acts
  only on the keys a PR names, so check the carried keys after the PR merges. A
  "fold" is a ticket that is Done on the board whose work lands here.
- **Before it starts** names what is not code: an ADR, an answer or an asset
  from the owner or BAC, a live step, a row that must merge first. A run
  asks for the first three at its own stops; having them ready shortens the
  wait.
- A key with more than one PR, as TYRE-243 and TYRE-152 have, launches again
  only once the owner has deleted its state directory under
  `.superpowers/sdd/` and its merged branch (`/pipeline`, Before anything,
  step 3).

Small fixes are rare in this queue. Read against the code on 17 Nov, only
TYRE-460 and TYRE-480 are certain small fixes; 457, 461, 115, 363, 311 and
380 read as small fixes from their tickets. Every other open ticket needs a
migration, an endpoint, a route or a screen, or is several defects.

**Sprint 1, what is left**

| # | Launch | Carries | Lane | Before it starts |
|---|---|---|---|---|
| 2 | `make pipeline T=TYRE-371` | merged in PR #229, the runner half only; email moved to TYRE-243 (U233) | infrastructure, database, API | the owner's staging steps in `environment-release.md`, The daily job (the job's daily run on staging) |
| 3 | `make pipeline T=TYRE-438` | fold 437's fix | infrastructure | the owner's call to narrow `id-tyre-deploy-prod` or re-accept it; a platform apply. It merges before BAC onboards (B43) |

**Sprint 2**

| # | Launch | Carries | Lane | Before it starts |
|---|---|---|---|---|
| 9 | `make pipeline T=TYRE-243` | slice 1, the lifecycle | database, API, web | none |
| 10 | `make pipeline T=TYRE-432` | fold 425 | database | none. It merges before BAC's tenant is provisioned (Two ordering rules) |
| 11 | `make pipeline T=TYRE-152` | its first PR: the server, the queue and the office read | infrastructure, API, web | an ADR first (upload through the API); a role assignment on the photos container |
| 12 | `make pipeline T=TYRE-287` | none | database, API, web | none. Row 24's FR-RPT-030 report links to it |
| 13 | `make pipeline T=TYRE-109` | 286 | API, web, database | none. BAC's answer on operating groups shapes the seed, not the build |
| 14 | `make pipeline T=TYRE-292` | 270 | database | none |
| 15 | `make pipeline T=TYRE-100` | 372; fold 365 | database, API, web | none |

**Sprint 3**

| # | Launch | Carries | Lane | Before it starts |
|---|---|---|---|---|
| 16 | `make pipeline T=TYRE-448` | 285, 152's photo screens and 319's Today screen: the capture slice (U145) | web, capture, API, database | row 11 merged. It merges before driver training |
| 17 | `make pipeline T="TYRE-457 TYRE-460 TYRE-461"` | a small-fix bundle | web | none |
| 18 | `make pipeline T=TYRE-458` | none | API, web, capture | none. The field needs no migration, because `api/internal/httpapi/capture.go` reads positions in its own query, so the lead may call it a small fix |
| 19 | `make pipeline T=TYRE-168` | 190's F10, with 189's F4 | database | none. It merges before row 20 |
| 20 | `make pipeline T=TYRE-322` | none | database, tooling, web | BAC's fuel export; row 19 merged |
| 21 | `make pipeline T=TYRE-133` | none | database, API, web | row 2 merged, for the daily job |
| 22 | `make pipeline T=TYRE-243` | slice 2, notifications | database, API, web | row 2 merged; row 9's state directory and branch deleted |
| 23 | `make pipeline T=TYRE-284` | none | database, API | none |
| 24 | `make pipeline T=TYRE-320` | fold 290 | API, web | the export ADR first; row 12 merged |
| 25 | `make pipeline T=TYRE-354` | 363 and 367: the dashboard residuals PR; folds 362 and 355 | API, web, database tests | none |
| 26 | `make pipeline T=TYRE-459` | none | database | none. It and TYRE-105 in row 33 both restate `app.set_vehicle_status`; the second one rebases |

**Raised since the plan, at Medium.** These have no sprint and sit here by
default. U173, U180 and U188 say before the pilot for 462, 465 and 466.
TYRE-464, 468 and 479 have no ruling on timing, only the board's Medium:

| # | Launch | Carries | Lane | Before it starts |
|---|---|---|---|---|
| 27 | `make pipeline T=TYRE-465` | none (U180) | web, capture | none |
| 28 | `make pipeline T=TYRE-466` | none (U188) | web, capture | a design choice that the spec settles |
| 29 | `make pipeline T=TYRE-464` | none (U178) | web, capture | a note on the Confluence prototype page is in its definition of done |
| 30 | `make pipeline T=TYRE-462` | none (U173) | database, API, web | none |
| 31 | `make pipeline T=TYRE-468` | none (U189) | database | none |
| 32 | `make pipeline T=TYRE-479` | none | process | none |

**Sprint 4**

| # | Launch | Carries | Lane | Before it starts |
|---|---|---|---|---|
| 33 | `make pipeline T=TYRE-123` | 120, 121, 244, 131, 113 and 105: the register batch, one migration and one valuation-verifier pass; folds 221, 360 and 310's item 2 | database, API | none. It merges before the measured window |
| 34 | `make pipeline T=TYRE-245` | 112: the suite PR; folds 246, 294, 316 and 375, 62's suite half and one assertion of 248 | database tests | none |
| 35 | `make pipeline T=TYRE-140` | 115; fold 141 | web | none |
| 36 | `make pipeline T=TYRE-159` | none | web | none |
| 37 | `make pipeline T=TYRE-434` | none | API, database, infrastructure | row 3 merged |
| 38 | `make pipeline T=TYRE-377` | none | API, database | none |
| 39 | `make pipeline T=TYRE-76` | none | database, API, web | none. An ADR-0006 amendment rides in the PR |
| 40 | `make pipeline T=TYRE-441` | 455: one spec (U162) | database, API, web, capture | none. 455's SRS errata paste blocks its close |
| 41 | `make pipeline T=TYRE-243` | slice 3, rule administration | database, API, web | row 22's state directory and branch deleted |
| 42 | `make pipeline T=TYRE-366` | none | API, web | only if BAC runs two or more operating groups; rows 13 and 14 merged |

**Not a pipeline run.** Each waits on the owner or a live step:

- TYRE-472: merged as #221. It closes on the owner's report that release
  step 4's queries match on staging, at the first release that carries
  000061.
- TYRE-381: merged in #165. It closes on the device check on deployed
  staging, on Android Chrome and iPhone Safari.
- TYRE-321: the readiness week: driver training, BAC onboarded on
  production and the 7-day live run.
- TYRE-398: narrowed to a signed-in release step in
  `docs/runbooks/environment-release.md` (B35), written with a release.
- TYRE-453: during the pilot, after rows 10, 19 and 20, once BAC has keyed
  its sheets.

**Open with no place yet.** Raised since 1 Nov with no sprint and no ruling
on timing, all Low, for the owner to place: TYRE-467 (designed after
ADR-0024, which #221 landed), TYRE-469 (U189), TYRE-480 (a small fix,
`make pipeline T=TYRE-480`) and TYRE-483 (needs a spec).

## The pilot plan

BAC's measured window is targeted for about **2 Dec 2026** (U147), after a
readiness week from 25 Nov. The dates below are estimates from the pace since
13 Oct (12 code PRs merged in 9 days); the order is the commitment. A window
from 2 Dec runs into the December holidays; if the date moves earlier, the
first things out are TYRE-441, 76, 366 and 377. At 1 Nov, past sprint 1's
dates, trips and Tread had merged and the rest of sprint 1's row had not. At
17 Nov sprint 1's row still has the run queue's rows 2 to 5 to go, and the
queue holds 41 runs; the dates have not been re-planned.

The table is the 21 Oct plan, kept as the record of what each sprint was to
unlock; the run queue above decides the order. Its two lanes touch disjoint
files. The database lane runs one PR after another, because each takes the
next migration number and suite section: the next free pair is **000068 and
section 84**, taken by whichever database branch is cut first.

| Sprint | Dates | Web, API and infrastructure lane | Database lane | Unlocks |
|---|---|---|---|---|
| 0 | 21 to 23 Oct | #141 (ADR-0020, TYRE-444); #142 (U146, TYRE-452); this page's PR with ADR-0021 (TYRE-350) | | A board with only build work on it |
| 1. Foundations and trips | 22 to 30 Oct | Tread, ahead of the plan (U156, below): 445 colour and themes (with 281; 343 folded in), 446 type, 447's components and 240's screen ports (merged, #151 to #154); the capture fixes PR (129, 171, 173, 207, 218, 329, 342; merged, #167) with 154 and 334 and the network PR (389, 381, 388; merged, #165, with 381 awaiting its staging device check), both now written against Tread's capture files; 371 job runner and email (ADR first); 438 with 437's fix; 379 with 410 (merged, #166); 413 (merged, #162) | 326 trips (merged, #148); 99 with 102, carrying 450 and #139's 18 set-aside bugs (B40) | Trips, which 319, 133, 441 and 76 build on; the job runner; Tread colour and type on every screen |
| 2. Driver path and manager views | 31 Oct to 7 Nov | 240's behaviour fixes with 176 and back-dated movements (B41); 152's server, queue and office read | 319 with 323; 325 with void; 287; 243 slice 1, the lifecycle; 109, 286, 292 and 270; 432 (425 folded in); 100 with 372 | A driver captures only against a task; managers see inspections and act on exceptions (agreement 11.2) |
| 3. Capture slice and reports | 8 to 16 Nov | Capture's remaining screens, on Tread's components: 152's photos, 448, 285 and 319's Today screen; 457 page titles and 458 inner and outer place words (U162); 460 double-tap zoom and 461 announced form errors (raised under U163, placed here by default); 320 reports and export (ADR first); 354, 363 and 367 | 459, a retired truck's open trip and a blank cancellation reason (raised under U161, placed here by default); 168 with 190's F10 (W5d), then 322 odometer import; 133 schedules; 243 slice 2, notifications; 284 compliance | The driver app as trained; H.1's reports; H.3 criterion 4's on-time figure |
| 4. Hardening | 17 to 24 Nov | 115 with 140; 159; 377; 366 if BAC runs two or more operating groups; 434; 398 as a release step | The register batch (123, 120, 121, 244, 131, 113, 105); the suite PR (245, 112); 76 depot capture; 441 with 455, one spec for the driver's trip-vehicle screen (U162); 243 slice 3, rule administration | Money and dates right per tenant; the suite covering exceptions |
| Readiness | 25 Nov to 1 Dec | TYRE-321: production migrated and promoted, BAC onboarded live (U139), driver training, the 7-day live run | | The measured window |

TYRE-321's restore rehearsal (NFR-BAK-004, with TYRE-203 folded in, U147
B34) ran on 3 Nov: staging restored to a point in time in about 8 minutes,
every table matching, with `docs/runbooks/restore-a-database.md` written
from the run. The geo-restore of production to South Africa West was
refused, because that region is not open to the subscription. The owner
ruled not to ask Azure to open it: NFR-BAK-005 and 006 now exclude a
region-wide outage (U166, TYRE-321 comment 14113).

### Feature work and fixes

Of the 59 tickets still open in sprints 1 to 4 and readiness, 24 are
features, 5 are platform pieces and 30 are fixes; the fixes travel in about a
dozen batched PRs, so feature work sets the pace.

- **Features:** 76, 99, 100, 102, 109, 133, 152, 243, 284, 285, 286,
  287, 292, 319, 320, 322, 325, 366, 367, 377, 441, 448, 455.
- **Platform:** 321, 371, 398, 434, 438.
- **Fixes:** 105, 112, 113, 115, 120, 121, 123, 131, 140, 159, 168,
  190, 244, 245, 270, 323, 354,
  363, 372, 381, 432, 450, 457, 458, 459, 460, 461. TYRE-275
  folded into 447, 343 into 445 and 425 into 432 on 21 Oct.

TYRE-453, the backfill of BAC's paper sheets (FR-IMP-009, from TYRE-430),
lands during the pilot after 322, 432 and 168; it is not a pilot gate (U147
A11).

### After the pilot

TYRE-449, Tread's per-device settings (C8). Also 209 with 236, 227, 255,
263, 311, 361 and 380, and the `post-poc` tickets below.

## The Tread rework (epic TYRE-443)

**U156 (owner, 26 Oct 2026) moved the rework ahead of the plan.** Every
route moved to Tread in one branch, `TYRE-443-tread-frontend` (deleted on
3 Nov; the tag `tread-demo-safe-0` keeps its head), and landed as
four stacked PRs cut from it after the 28 Oct demo: #151 the foundation (445,
446), #152 the components (447), #153 the manager screens and #154 capture
(240's ports, with U160's half key). `docs/delivery-history.md` records the
stack. ADR-0020's Sequence paragraph is superseded; the rest of its Decision
stands: the capture rulings of U145 (#141), the navigation rule and the
non-negotiable rules. The design spec is
`docs/superpowers/specs/2026-10-26-tread-frontend-design.md`, and ADR-0022
holds the frontend layers.

The epic stays open for:

- TYRE-457 and 458 (U162) and TYRE-460 and 461 (U163), all in sprint 3,
  and TYRE-449 after the pilot.
- The old Radix Select (`web/src/ui/legacy/`), which Dashboard's and
  Exceptions' filters keep until a Tread select keeps the combobox role.
  Until then not every route renders only Tread.
- A web-design-guidelines audit of #151's files, which no review round ran.

Screens still to build are built on Tread's components. They do not copy the
artifact's hard-coded mm and kPa, its missing tread age, its number format
that drops ".0" or its bare `<a href>` links. impeccable advises (CLAUDE.md's
precedence list): audit, critique, harden, adapt, clarify, polish and
optimize on each slice, and shape for 243's and 320's screens. Never init,
document, extract, hooks or live.

## Constraints every branch carries

A bug found on a branch is handled by its class (`docs/how-work-runs.md`, Which
bugs a branch fixes, U191). Set aside holds what is not a bug, and two kinds of
Minor nobody verified: one a fixer could not reproduce, and an `unrelated` one
whose board search found no ticket (the same section, U212).

The capture route's entry has three ceilings, JavaScript and CSS in gzip
bytes and fonts in raw bytes, each with 10% headroom over the figure it was
set from (U200, TYRE-474). Every capture-route change in the queue adds
bytes: the capture fixes, photos and capture's remaining
screens. A rise under a ceiling passes and shows in the PR's "Capture bundle
size" job summary, and the PR names the import that grew the entry, so the
growth is a decision, not an accident (U84, ADR-0015). A change that would
cross a ceiling moves its import behind `React.lazy`, or raises the ceiling
by hand with its reason (web/CLAUDE.md, The design system).

BAC Transport is the acceptance fixture. Tests and demos type in Sandbox Fleet
(TYRE-80) and only browse BAC. On staging the fixture loads only as a
separately named demonstration tenant, never under the pilot tenant's id
(U92), and the suite never runs there. Production holds only the pilot
tenant, created at TYRE-321's live onboarding (U139).

## Blocked on people, not code

**The owner:** decide `id-tyre-deploy-prod`'s role for row 3; run TYRE-381's device check,
TYRE-472's staging check (The run queue, Not a pipeline run) and TYRE-154's
iPhone and Android checks on staging (merged in #234). Also have
the SRS Cowork agent paste U166's errata for
NFR-BAK-005 and 006 and fix the release log's staging database row
(`docs/HANDOFF_srs_errata_TYRE-321_U166_2026-11-03.md`, gitignored). Staging is at 60 since
3 Nov, so its rollback floor is PR #148 (`environment-release.md`, Roll
back). Production stays at 58 until the next promotion, which must migrate
first. TYRE-243's email
sender domain needs the platform domain, which the team registers outside
Jira.

**BAC, at onboarding:** whether it runs operating groups (TYRE-109, 366), its
fuel-record export (TYRE-322), and how many paper sheets the backfill covers
(TYRE-453).

Sponsor, commercial, IP and legal questions are handled by the team outside
the project; Jira carries codebase and infrastructure work only (owner,
29 Sep 2026).

**Parked post-POC.** TYRE-59, 60, 61, 73, 106, 214, 228 and 295 were closed
for the POC on 8 Oct 2026 and keep the label `post-poc`, so they can be
reopened after the pilot. Open with the same label, all at Low: TYRE-58,
114, 156, 157, 186, 187, 191, 210, 230, 232, 251, 253, 256, 257, 258, 262,
264 to 268, 289, 296, 315, 337, 347, 358, 393, 417, 428, 431, 451 and
454.

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
`post-poc` label. A key present on `develop` and open on the board is a
candidate, not a conclusion. Read the ticket's definition of done and its
U147 comment before closing it: a key whose only commit on `develop` is the
one that homed it in a page like this one has been written down, not built.

The third command checks ancestry, not trees. `main` is the `develop`
commit production runs, so between promotions it sits behind `develop`'s
head and the trees differ; what must hold is that `main` is an ancestor of
`develop`. If it is not, a commit reached `main` some other way (ADR-0004).
If `origin/develop` is missing entirely, it was deleted by
`deleteBranchOnMerge`. Restore it from the head of its newest CI push run,
not from `main`, which would drop every commit not yet promoted:
`gh run list -R Rourke9001/TyrePlatform --branch develop --event push --limit 1 --json headSha --jq '.[0].headSha'`,
then `git push origin <that sha>:refs/heads/develop`, which is the owner's push,
with `TYRE_PROMOTE=1`. Ruleset 21929055 now refuses the deletion this guards
against (TYRE-473).
