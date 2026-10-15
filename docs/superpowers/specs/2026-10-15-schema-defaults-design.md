# Design: defaults and codes that claim what nobody supplied (TYRE-175)

- **Date:** 2026-10-15
- **Ticket:** TYRE-175, under epic TYRE-55. It carries two folded tickets:
  TYRE-213's view drop and `p_payload` line (comment 13637) and TYRE-224's
  section 31 kinds (comment 13650).
- **Decisions it rests on:** ADR-0010 rule 2 (absence is absence, never a
  default), ADR-0012 (the TY class forwards verbatim), owner decision 6 on
  TYRE-143 (comment 12993, drop `app.v_axle_side_divergence`), U130 (the
  triage rule), and the owner's answers in the TYRE-175 spec session, 15 Oct
  2026, recorded below under "Decisions".
- **Requirements:** FR-INS-029a and FR-CFG-024 (the capture convention),
  FR-ANL-045 and BR-ANL-010 (what an unknown orientation excludes),
  FR-IMP-009 (imported rows load as unknown), CHG-010 and CHG-011 in the
  Change and Verification Manifest v1.1 (page 12189697), OI-28 (Appendix
  G.1), FR-TYR-040 as amended by TYRE-418's erratum, and FR-ANL-029 and
  FR-EXC-037 (both deferred to Appendix H.2).

## Why this exists

The 6 Sep sweep (TYRE-143) found three places where the schema states
something nobody supplied:

1. `app.reading_measurement.orientation_known` defaults to `true`
   (000011:149). A writer that leaves the column out claims the reading
   follows FR-INS-029a's convention. CHG-011's resolution, and the backfill
   eight lines below the default, say the opposite for any capture nobody
   vouched for.
2. `app.submit_inspection` writes `orientation_known` as `NOT v_spare`
   (000041:457) and ignores any value in the payload. Only the 2021 backfill
   can ever store `false` on a non-spare.
3. `app.receive_tyres` refuses a future received date with TY012
   (000053:50-51). TY012 means an invalid lifecycle transition or a row the
   tenant cannot see. The code a caller should get is the one for a receive
   refused on its input.

The fourth sweep item, the INVOICE imputation (lane 3 F13), is already
fixed. TYRE-318's 000053:28 records a bare price as UNKNOWN and refuses a
price without a source (TY011). TYRE-419 owns the awaiting-cost pre-select.

The folded items are residue from the same sweep. `app.v_axle_side_divergence`
(000001:683) has no reader and no test, and serves two requirements Appendix
H.2 defers. `db/CLAUDE.md` has no line telling the next write-surface
function to name its input `p_payload`. Section 31's `SEC31-*` units are
HORSE units on a TRAILER_2AXLE configuration, which contradicts 000042's
own rule for deriving a kind.

## Decisions

Owner answers, 15 Oct 2026, in the TYRE-175 spec session:

| # | Question | Answer |
|---|---|---|
| Q1 | What replaces `DEFAULT true` | Drop the default and keep `NOT NULL`, so an omission is a 23502. CHG-011 gets an erratum |
| Q2 | Lane 4 F5, the submit path | Document it. The column comment says submit derives the value; `submit_inspection` is not redefined, so TYRE-283 keeps that function to itself |
| Q3 | The receive future-date code | TY011, `receive_tyres`' own refusal code and one the Receive form already speaks. `dispose_tyre` keeps TY012, its code for every refusal |
| Q4 | How far the kind fix goes | Section 31 only, its units become TRAILER. The ~20 TRAILER, RIGID and LIGHT plants on HORSE_6X4 in other sections go under Set aside |
| U134 | Where section 31's sentence goes | In the fixture comment where the units are planted, not on the `\echo` title line (planner question PD-2, TYRE-175 comment 13755) |

The two design parts below were approved as presented.

On Q4, the owner asked first what a unit's kind and configuration are. A
unit is one vehicle. Its kind says what it is, and two rules read it:
TY009 exempts a trailer from the fitment odometer, and the rig rules tow
only a trailer. Its configuration is the axle layout capture draws, shared
by every unit with that layout. Nothing reads the two together, so a
mismatch changes no behaviour today, and a rule that later ties them would
fail the mismatched fixtures loudly when it lands.

## 1. Migration 000057

One migration, `000057_schema_defaults`, with three parts. Each part's
comment cites its decision and requirement IDs; none restates this spec.

**The default.** `ALTER TABLE app.reading_measurement ALTER COLUMN
orientation_known DROP DEFAULT`. The column stays `NOT NULL`. A new
`COMMENT ON COLUMN` replaces 000011's and says three things: every writer
states the value (ADR-0010 rule 2, CHG-011 as amended), `submit_inspection`
derives it as `NOT is_spare` under FR-INS-029a, and `false` on a non-spare
comes only from the 2021 backfill or an import under FR-IMP-009.

**The view.** `DROP VIEW app.v_axle_side_divergence`. Nothing depends on
it. 000045:202 already reserves the AXLE subject in `app.v_exception` for
FR-EXC-037, so that is where the rule lands if H.2 stops deferring it.

**The refusal code.** `CREATE OR REPLACE FUNCTION app.receive_tyres(payload
jsonb)` with 000053's body, changed in one place: the future-date refusal
raises TY011 instead of TY012, with the same message. The parameter keeps
the name `payload`, because `CREATE OR REPLACE` cannot rename an input
parameter. The plan checks by catalogue that the replacement keeps every
property the function has on develop (owner, grants, `search_path`
pin, comment), not by comparing text.

**The down file** restores the state 000056 left: the `true` default and
000011's comment, the view as the live catalogue defines it (including
`security_invoker = true` and its grants), and 000053's body. The plan
proves the down by catalogue after an up and down round trip, because
`CREATE OR REPLACE` drops properties a later `ALTER` set and the suite
cannot run against a down.

## 2. API and docs

**`api/internal/httpapi/refusal_codes.json`.** TY011's meaning gains "a
received date after the tenant's today". `app.receive_tyres` leaves TY012's
`raisedBy` list; it raises no other TY012. No Go handler changes: TY011
and TY012 are both 422 and both forward verbatim.

**The web app** does not change. `ReceiveTyre.tsx:24` already speaks TY011,
so once TYRE-418 adds the back-datable received date, a future date shows
the server's message instead of fallback copy.

**`db/CLAUDE.md`, "Adding a function".** One line: input parameters carry
the `p_` prefix, and a write-surface function whose whole request is one
jsonb names it `p_payload`, as `app.submit_inspection` does.
`app.receive_tyres(payload)` predates the rule and keeps its name, because
a rename is a migration and breaks a named-argument caller.

## 3. Tests

**New suite section 73**, inside `BEGIN ... ROLLBACK`, as `app_login`. Each
leg fails on develop:

- (a) The catalogue shows `orientation_known` with no default and `NOT NULL`,
  and an insert into `app.reading_measurement` that leaves the column out
  raises 23502.
- (b) `app.receive_tyres` with a received date of the tenant's tomorrow
  raises TY011 with the message "a tyre is received on or before today,
  never on a future date". The same payload dated the tenant's today is
  accepted, so the leg cannot pass on an unrelated refusal.
- (c) `to_regclass('app.v_axle_side_divergence')` is null.

**Check 39o** (`004_tests.sql:4270-4280`) already traps the future-date
refusal as TY012. It moves to TY011 and pins the message, because TY011
covers about twenty receive refusals and the code alone would let the
wrong one pass. This assertion moves on purpose: Q3 changes the code under
test.

**The fixture sweep.** 20 of the suite's 30 inserts into
`app.reading_measurement` leave `orientation_known` out, and so do four Go
test inserts (`analytics_test.go:212`, `httpapi_test.go:330` and `:1132`,
`inspections_test.go:41`), and two in `db/tests/005_privileged.sql` (lines
371 and 415, which `make test` and CI run). Each states `true`, the value the default gave
it. No expectation moves: section 27's count of 159 orientation-unknown
fixture rows stays 159, and nothing an analytics or exception leg reads
changes. The seed generators already state the column.

**Section 31.** The nine `'HORSE'` literals on `SEC31-*` units become
`'TRAILER'` (`004_tests.sql` lines 2903, 2906, 2909, 2912, 2915, 2918, 2921,
2924 and 3487). The section's fixture comment (`004_tests.sql:2898-2901`,
where the units are planted) gains one sentence (U134): the units are
trailers because they sit on TRAILER_2AXLE (000042's rule, TYRE-224), and
no assertion in the section depends on the kind. No assertion moves. No SEC31 submit sends an
odometer, and the one SEC31 fitment (`SEC31-COMBO`) supplies
`fitted_odometer`, which TY009 accepts under either kind. `SEC31-T2` sits
on tenant 2's HORSE_6X4 and is already a horse.

`make check` runs the whole gate. The Appendix E valuations and the
Appendix J 19/11/9 counts do not move.

## 4. SRS change

The Manifest's CHG-011 (page 12189697, section 4.2) specifies
`orientation_known boolean NOT NULL DEFAULT true`. Dropping the default
departs from it, so CHG-011 gets an erratum, as TYRE-418 did for
FR-TYR-040. SRS pages exceed the Confluence connector's limits, so the
owner has the row pasted by hand, and the ticket is not done until it is.

The row, for SRS Part 3's errata table (page 10878977), whose columns are
Requirement, Erratum, Amendment, Reason and Section. It goes directly after
the FR-TYR-040 row:

- **Requirement:** CHG-011 (Change and Verification Manifest v1.1, section 4.2)
- **Erratum:** (TYRE-175, 15 Oct 2026)
- **Amendment:** `orientation_known` is `boolean NOT NULL` with no default.
  Every writer states it. A capture that follows FR-INS-029a's convention
  stores `true`, a spare stores `false`, and 2021 or imported rows store
  `false` (FR-IMP-009). A writer that leaves it out is refused rather than
  recorded as orientation-known (ADR-0010 rule 2).
- **Reason:** TYRE-175, from the TYRE-143 review sweep (lane 3 F12). A
  default of `true` lets a writer that leaves the column out claim a
  certainty nobody supplied, against ADR-0010 rule 2 and OI-28's answer
  (Q1) that captures without the convention carry `false`. The one writer
  today, submit, states the value (`NOT is_spare`), so no stored row is
  mislabelled.
- **Section:** §5.1 (Part 4), `reading_measurement`; cross-ref
  FR-INS-029a, FR-ANL-045, FR-IMP-009

The Manifest's section 4.2 table has the columns ID, T and Assertion. The
CHG-011 row's Assertion cell gains one sentence pointing to the erratum, so
a reader of the Manifest does not restore the default. Its original text
stays as it is.

No other SRS text changes. Section 5.1 names the column without a default,
FR-TYR-040's erratum already refuses a future received date, and the SRS
defines no refusal codes.

## 5. Set aside

These go in the PR's Set aside list (U130):

- About 20 TRAILER, RIGID and LIGHT fixture units on HORSE_6X4 in sections
  24, 33, 36, 40 to 47, 58, 71 and 72. They take the trailer odometer
  exemption on the fixture horse's positions on purpose, nothing reads kind
  and configuration together, and a rule that ever ties them fails these
  inserts loudly.
- Appendix J.2 (page 10977281) still lists an expected result for
  FR-EXC-037, which Appendix H.2 defers.
- TYRE-207 stays open for its `spoken.ts` finding. This branch discharges
  only its F12, the view.

## Definition of done

- 000057 drops the default, drops the view and moves the receive refusal to
  TY011. Its down is proved by catalogue.
- Suite section 73 pins all three, and check 39o expects TY011 with its
  message. Every fixture states `orientation_known`. Section 31's units are
  trailers.
- `refusal_codes.json` and `db/CLAUDE.md` say what the code does.
- The CHG-011 erratum row is pasted into SRS Part 3, and the Manifest's
  CHG-011 row points to it.
- `make check` exits 0.

Next free numbers after this branch: migration 000058, suite section 74.
