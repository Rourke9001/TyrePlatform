# Implementation order

Re-verified **1 Nov 2026** against `develop` @ `1ab75a2` and the board,
after the Tread stack (#151 to #154) merged. The plan is the pilot audit's
of 21 Oct 2026 (TYRE-452), which the owner approved that day: U145 (the
Tread rework), U146 (a bug found on a branch is fixed there) and U147 (the
board changes, the product answers and the pilot date). U156 moved the
Tread rework ahead of it on 26 Oct. On 3 Nov the owner placed TYRE-455,
457 and 458 (U162), and the rulings U161 and U163 raised 459, 460 and 461,
whose sprints are a default the owner can move. Those changes, staging's
migrate to 000060 and the restore rehearsal are added here without a full
re-verification.

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

## The pilot plan

BAC's measured window is targeted for about **2 Dec 2026** (U147), after a
readiness week from 25 Nov. The dates below are estimates from the pace since
13 Oct (12 code PRs merged in 9 days); the order is the commitment. A window
from 2 Dec runs into the December holidays; if the date moves earlier, the
first things out are TYRE-441, 76, 366 and 377. At 1 Nov, past sprint 1's
dates, trips and Tread had merged and the rest of sprint 1's row had not; the
dates have not been re-planned.

Two lanes run side by side because they touch disjoint files. The database
lane runs one PR after another, because each takes the next migration number
and suite section: the next free pair is **000061 and section 77**, taken by
whichever database branch is cut first.

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

- **Features:** 76, 99, 100, 102, 109, 133, 152, 154, 243, 284, 285, 286,
  287, 292, 319, 320, 322, 325, 366, 367, 377, 441, 448, 455.
- **Platform:** 321, 371, 398, 434, 438.
- **Fixes:** 105, 112, 113, 115, 120, 121, 123, 131, 140, 159, 168,
  176, 190, 240, 244, 245, 270, 323, 334, 354,
  363, 372, 381, 432, 450, 457, 458, 459, 460, 461. TYRE-275
  folded into 447, 343 into 445 and 425 into 432 on 21 Oct.

TYRE-453, the backfill of BAC's paper sheets (FR-IMP-009, from TYRE-430),
lands during the pilot after 322, 432 and 168; it is not a pilot gate (U147
A11).

### After the pilot

TYRE-449, Tread's per-device settings (C8). Also 209 with 236, 227, 255,
263, 311, 361, 380 and 395, and the `post-poc` tickets below.

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

A bug found on a branch is handled by its class (CLAUDE.md, Which bugs a
branch fixes, U191); Set aside holds only what is not a bug.

The capture route's entry has three ceilings, JavaScript and CSS in gzip
bytes and fonts in raw bytes, each with 10% headroom over the figure it was
set from (U200, TYRE-474). Every capture-route change in the queue adds
bytes: the capture fixes, photos, the manifest and capture's remaining
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

**The owner:** have the SRS Cowork agent paste U166's errata for
NFR-BAK-005 and 006 and fix the release log's staging database row
(`docs/HANDOFF_srs_errata_TYRE-321_U166_2026-11-03.md`, gitignored). Staging is at 60 since
3 Nov, so its rollback floor is PR #148 (`environment-release.md`, Roll
back). Production stays at 58 until the next promotion, which must migrate
first. TYRE-371's custom
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
