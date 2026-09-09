# Implementation order

Re-verified **9 Sep 2026** against `develop` @ `db84995` and the board's open
sprint.

**Jira is the live authority.** This page exists so a session working in the
repo can see the shape of the queue without leaving the codebase, the same way
`open-issues.md` does for the blocker register. Where this page and the board
disagree, the board wins, and the disagreement is a bug in this page.
Re-verify before trusting anything below; the method is at the end.

A batch here is a sequencing claim, not a scope claim. Each ticket's own
definition of done governs what gets built. Batches B1 to B6 have all merged.
Their records, and the rationale each one left for the batch after it, are in
`docs/delivery-history.md`; a citation written as
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

The board's open sprint is "B6 — Rig-setup surface", 3 to 17 Sep 2026. Seven
of its nine issues are Done. TYRE-124 was the seventh, transitioned on 9 Sep:
its correction had been in migration 000037 since PR #43 and only the ticket
was stale. What remains in the sprint is not code:

| Key | State | What remains |
|---|---|---|
| TYRE-125 | owner decision | Which `tread_source` label a fit-, removal- or retread-written tread carries: a third label such as `FITMENT`, or record that `AUDIT` is the umbrella for "not an inspection reading". Suite 44b pins today's behaviour; nothing to build until answered |
| TYRE-128 | owner questions | The register of PR #41's close-out. The eight decisions were answered 3 Sep; items 7 and 8 and the small fixes landed on B6.1 to B6.3. Still open: whether decision 7 (enums are cast-authoritative) reaches `unitKinds` and `tenantRoles`; `cost_source` after a retread re-rate (spec D3 is silent); INFERRED distance provenance has no front-end exercise until OI-31 coupling records exist. Close it once those are answered or split out |

The sprint closes on decisions, not pull requests.

## The next batch

Nothing is cut yet. The next batch is planned before it is cut, brainstorm and
design first as B5 and B6 were, and these are the candidates. Which comes
first is the owner's call: the dashboard gap decides what the POC can show,
the deployment gap decides where it can be shown.

### Analytics and lifecycle

**TYRE-41 (re-scoped first), TYRE-38, TYRE-36, then TYRE-52's successors.**
TYRE-36 only once the register shape is stable, since it reads it. This is the
manager dashboard the brief promises and the application does not have: no
exception surface, no fleet valuation and no cost per kilometre exists
anywhere in the API or the web app. The 19/11/9 agreement lives only in suite
section 8 (TYRE-183).

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
