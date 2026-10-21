# Implementation order

Re-verified **21 Oct 2026** against `develop` @ `4f9414f` and the board, by
the pilot audit (TYRE-452). The owner approved its plan the same day: U145
(the Tread rework), U146 (a bug found on a branch is fixed there) and U147
(the board changes, the product answers and the pilot date).

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase. Where this
page and the board disagree, the board wins, and the disagreement is a bug in
this page. Re-verify before trusting anything below; the method is at the
end.

A sprint here is a sequencing claim, not a scope claim. Each ticket's own
definition of done, and the U147 comment on it, govern what gets built. What
has merged is recorded in `docs/delivery-history.md`, batch by batch: B1 to
B7, then B9 and the platform lane to 21 Oct 2026. A citation written as
`docs/implementation-order.md §B5` (or §B6, §B7) resolves to the same-named
section there.

## Two ordering rules

Dependency first. Then, more sharply: an integrity rule is cheap before pilot
data exists and expensive after, because afterwards it has to be retrofitted
around rows that already violate it. That is why TYRE-432 (with 425) makes
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
first things out are TYRE-441, 76, 366 and 377, then Tread's 447a.

Two lanes run side by side because they touch disjoint files. The database
lane runs one PR after another, because each takes the next migration number
and suite section: the next free pair is **000060 and section 76**, taken by
whichever database branch is cut first.

| Sprint | Dates | Web, API and infrastructure lane | Database lane | Unlocks |
|---|---|---|---|---|
| 0 | 21 to 23 Oct | #141 (ADR-0020, TYRE-444); #142 (U146, TYRE-452); this page's PR with ADR-0021 (TYRE-350) | | A board with only build work on it |
| 1. Foundations and trips | 22 to 30 Oct | TYRE-445 colour and themes (with 281, 343); 446 type; the capture fixes PR (129, 154, 171, 173, 207, 218, 329, 342) with 334; the network PR (389, 381, 388); 371 job runner and email (ADR first); 438 with 437's fix; 379 with 410; 413 | 326 trips; 99 with 102, carrying 450 and #139's 18 set-aside bugs (B40) | Trips, which 319, 133, 441 and 76 build on; the job runner; Tread colour and type on every screen |
| 2. Driver path and manager views | 31 Oct to 7 Nov | 447a core components (with 275); 240's behaviour fixes with 176 and back-dated movements (B41); 152's server, queue and office read | 319 with 323; 325 with void; 287; 243 slice 1, the lifecycle; 109, 286, 292 and 270; 432 with 425; 100 with 372 | A driver captures only against a task; managers see inspections and act on exceptions (agreement 11.2) |
| 3. Capture slice and reports | 8 to 16 Nov | The Tread capture slice: 447b with 152's screens, 448, 285 and 319's Today screen; 320 reports and export (ADR first); 354, 363 and 367 | 168 with 190's F10 (W5d), then 322 odometer import; 133 schedules; 243 slice 2, notifications; 284 compliance | The driver app as trained; H.1's reports; H.3 criterion 4's on-time figure |
| 4. Hardening | 17 to 24 Nov | 115 with 140; 159; 377; 366 if BAC runs two or more operating groups; 434; 398 as a release step | The register batch (123, 120, 121, 244, 131, 113, 105); the suite PR (245, 112); 76 depot capture; 441; 243 slice 3, rule administration | Money and dates right per tenant; the suite covering exceptions |
| Readiness | 25 Nov to 1 Dec | TYRE-321: production migrated and promoted, BAC onboarded live (U139), driver training, the 7-day live run | | The measured window |

TYRE-321's restore rehearsal (NFR-BAK-004, with TYRE-203 folded in) runs this
week, before any of it: staging to a point in time, and the empty production
geo-restored to South Africa West, with `docs/runbooks/restore-a-database.md`
committed (U147 B34).

### Feature work and fixes

Of the 72 tickets in sprints 1 to 4 and readiness, 27 are features, 8 are
platform pieces and 37 are fixes; the fixes travel in about a dozen batched
PRs, so feature work sets the pace.

- **Features:** 76, 99, 100, 102, 109, 133, 152, 154, 243, 284, 285, 286,
  287, 292, 319, 320, 322, 325, 326, 366, 367, 377, 441, 445, 446, 447, 448.
- **Platform:** 321, 371, 379, 398, 410, 413, 434, 438.
- **Fixes:** 105, 112, 113, 115, 120, 121, 123, 129, 131, 140, 159, 168,
  171, 173, 176, 190, 207, 218, 240, 244, 245, 270, 275, 323, 329, 334, 342,
  343, 354, 363, 372, 381, 388, 389, 425, 432, 450.

TYRE-453, the backfill of BAC's paper sheets (FR-IMP-009, from TYRE-430),
lands during the pilot after 322, 432 and 168; it is not a pilot gate (U147
A11).

### After the pilot

TYRE-240's Tread ports of the older screens (fleet register and receipts;
unit, rigs, fitments and retreads; admin forms and people; dashboard,
exceptions and at-risk; landing and shell), then 449. Also 209 with 236,
227, 255, 263, 311, 361, 380 and 395, and the `post-poc` tickets below.

## The Tread rework (epic TYRE-443)

ADR-0020 is accepted with the capture rulings of U145 (#141): capture keeps
numbered tread cells (IR-UI-014), the rig-wide tile number with per-unit
place words (FR-INS-060, Appendix I) and a non-modal sheet; the navigation
does not change before the pilot; U16 is retired. What has to hold for the
rework to land:

1. **Run it locally.** This machine has Docker, superpowers and impeccable;
   the cloud session that wrote the handover had none of them
   (`docs/lessons.md`, 2026-10-20).
2. **TYRE-445 takes four more things:** TYRE-281's gate on the capture
   entry's CSS and fonts (`scripts/check-capture-bundle.mjs` counts
   JavaScript only), a gate on hex colour literals (none exists), Tread's
   spacing, radius and size tokens, and TYRE-343's confinement test,
   rewritten to the new names and made to fail first. `applyCssVars` sets
   every token inline, so only the brand slot stays inline; Tread's
   `space-5` is 20px where today's is 24px; pin `deriveBrandTheme`'s outputs
   before the swap; the CSP refuses an inline theme script.
3. **TYRE-446** drops the latin fonts from 184 KB to 70 KB of woff2.
4. **TYRE-447 splits.** 447a, the core and manager set, in sprint 2; new
   manager screens are built on it from then. 447b, the capture set, inside
   the capture slice in sprint 3, before driver training (OR-TRN-001).
   `tread.css` splits by route, or it lands on the capture entry unseen. The
   port must not copy the artifact's hard-coded mm and kPa, its missing tread
   age, its number format that drops ".0", its bare `<a href>` links, its
   Sheet and Dialog without a focus trap, or its Tabs without a tab panel.
5. **Logic fixes land before restyles**, so each port is a pure restyle: the
   capture fixes in sprint 1, TYRE-240's behaviour fixes in sprint 2.
6. **impeccable advises** (CLAUDE.md's precedence list): audit, critique,
   harden, adapt, clarify, polish and optimize on each slice, and shape for
   243's and 320's screens. Never init, document, extract, hooks or live.

## Constraints every branch carries

A bug found on a branch is fixed on that branch (U146, CLAUDE.md); Set aside
holds only what is not a bug.

The capture route's entry closure budget is 140373 gzip bytes in
`web/bundle-budget.json`, recorded 20 Oct 2026 by TYRE-283 (#139). The gate
only lets that figure go down. Every capture-route change in the queue adds
bytes: the capture fixes, photos, the manifest and the Tread capture slice.
Each such PR re-records the budget in its own commit and says why, so the
growth is a decision, not an accident (ADR-0015).

BAC Transport is the acceptance fixture. Tests and demos type in Sandbox Fleet
(TYRE-80) and only browse BAC. On staging the fixture loads only as a
separately named demonstration tenant, never under the pilot tenant's id
(U92), and the suite never runs there. Production holds only the pilot
tenant, created at TYRE-321's live onboarding (U139).

## Blocked on people, not code

**The owner, this week:** merge #140, #141 and #142 and this page's PR, and
close #138 (superseded by #137); migrate staging to 000059
(`environment-release.md`, Each release); revoke tyre-api's Graph
`User.Read.All` grant and apply the page edits drafted on TYRE-378; paste the
SRS rows drafted on TYRE-442 (six), TYRE-430, TYRE-322, TYRE-76, TYRE-448
and TYRE-372; run the restore rehearsal (TYRE-321); add yourself as required
reviewer on the GitHub production environment (TYRE-413). Production stays
at 58 until the next promotion, which must migrate first. TYRE-371's custom
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
then `git push origin <that sha>:refs/heads/develop`.
