# Design: threshold policy rows written once (TYRE-299)

- **Date:** 2026-10-14
- **Ticket:** TYRE-299, under epic TYRE-3. It carries TYRE-298 (U68),
  TYRE-310 items 1 and 3 (U70) and TYRE-189 F5. TYRE-310 item 2 (one "now"
  for every current figure) stays on TYRE-244.
- **Decisions it rests on:** U68, U69 and U70 (24 Sep 2026, on TYRE-298,
  TYRE-299 and TYRE-310), and the owner's answers in the TYRE-299 spec
  session, 14 Oct 2026, recorded below under "Decisions". Also ADR-0012 (the
  refusal envelope) and TYRE-142 (one policy resolution per call).
- **Requirements:**
  - Configuration: FR-CFG-010, FR-CFG-011, FR-CFG-012, FR-CFG-044,
    FR-CFG-051, and SRS §5.1 `threshold_policy` with its errata E1 sentinel.
  - Valuation: FR-VAL-006, FR-VAL-020, FR-VAL-021, BR-VAL-002.
  - Retread: FR-FIT-021, FR-FIT-022, FR-TYR-019, BR-FIT-009.
  - Exceptions: FR-EXC-020 and FR-EXC-021 (as amended by B7 U2 and U3).
- **Raised by this spec:** TYRE-425 (the same rules for `target_pressure`
  and `configuration`). The SRS erratum folded into this ticket (owner, 14
  Oct 2026; TYRE-299 comment 13723).

## Why this exists

`app.threshold_policy` holds the removal threshold every stored
`rand_per_mm` divides by, and the cap every retread is checked against. Three
things let a past figure change after it was computed:

1. `app_rw` holds UPDATE on the table, guarded only by the 000017 stamp
   trigger. Editing a past row moves every as-at valuation that resolved
   through it (FR-VAL-020), and FR-VAL-006's reproduction rests on those
   figures staying put.
2. Nothing is unique on `(tenant_id, operating_group_id, axle_class,
   effective_from)`. Two rows at one instant resolve by heap order: a
   rolled-back probe wrote 5.0/cap 3 and 7.0/cap 1 in one transaction and got
   5.0/3.
3. Nothing refuses an INSERT dated in the past. A row effective 2021-06-01
   moved the 2022-01-01 threshold from 4.0 to 6.0 with no UPDATE (TYRE-310
   item 3).

FR-CFG-051 (Must, Appendix H.1) applies configuration changes prospectively
only. Separately, `app.log_retread_return` prices a back-dated return at the
policy in force at `now()` rather than on the day the return happened
(TYRE-310 item 1). The table also carries three columns nothing reads
(TYRE-298) and hard-codes 4.0 mm and a cap of 2 as column defaults
(TYRE-189 F5), which rule 5 forbids.

## Decisions

Owner answers, 14 Oct 2026, in the TYRE-299 spec session:

| # | Question | Answer |
|---|---|---|
| Q1 | FR-CFG-010 still requires a scrap threshold and an insurance pair; U68 drops them | Drop all three columns. The SRS is amended, not worked around: the erratum rows are on TYRE-299, comment 13723 |
| Q2 | How the back-dated refusal treats the E1 baseline | Refuse `effective_from < now()` with no tolerance; exempt `-infinity` when the row's scope has no row yet |
| Q3 | How "written once" is enforced | Revoke UPDATE from `app_rw` and add a trigger that refuses every UPDATE |
| Q4 | Where the retread return resolves its cap | One resolution at the return's instant serves the threshold and the cap |
| Q5 | `target_pressure` and `configuration` share the defects | Raise a ticket (TYRE-425); this PR stays on policy rows |
| S1 | A CHECK that the warning threshold sits above the retread threshold | Add it; the erratum restates FR-CFG-012 to match |

The three design sections were approved as presented.

## Design

Everything ships in one migration pair, 000054, and suite section 70.

### 1. Schema

**No ties.** `ALTER TABLE app.threshold_policy ADD CONSTRAINT
threshold_policy_one_row_per_instant UNIQUE NULLS NOT DISTINCT (tenant_id,
operating_group_id, axle_class, effective_from)`. Both resolvers order by
`(operating_group_id IS NULL), (axle_class IS NULL), effective_from DESC`.
Two candidate rows can share that sort key only if they share the group, the
class and the instant, which the constraint now forbids, so every resolution
picks one row. The seeds' two `-infinity` rows per tenant differ on
`axle_class` (NULL and STEER) and pass. The existing `threshold_policy_lookup`
index stays.

**Written once (U69, Q3).**

- `REVOKE UPDATE ON app.threshold_policy FROM app_rw`, and `threshold_policy`
  comes off check 4's UPDATE allow-list in `db/tests/004_tests.sql`.
- A `BEFORE UPDATE ... FOR EACH ROW` trigger, `threshold_policy_written_once`,
  refuses every UPDATE with SQLSTATE `TY023`. Message: a policy row is
  history, and a change is a new row with a later `effective_from`
  (FR-CFG-051). This is the 000024 pattern U69 names, and it binds the owner
  role and a superuser as well as `app_rw`.
- The 000017 stamp trigger `threshold_policy_stamps_updated` and the audit
  columns stay. They become unreachable, but the migration drops nothing
  beyond what the owner ruled on.

**No back-dating (U70 item 3, Q2).** A `BEFORE INSERT ... FOR EACH ROW`
trigger, `threshold_policy_not_backdated`, raises `TY023` when
`NEW.effective_from < now()`, with one exemption: `NEW.effective_from =
'-infinity'` when no row exists for the same `tenant_id`, `operating_group_id`
and `axle_class` (compared with `IS NOT DISTINCT FROM`). That exemption is
the E1 baseline exactly. `now()` is the transaction's start, so a row
inserted with its `DEFAULT now()` passes, and so does any future date.

The exists check races under READ COMMITTED: a baseline and a dated row
inserted at the same moment for one empty scope, in two sessions, can both
pass. This is accepted. No HTTP route writes the table, and provisioning
writes a tenant's baseline once, before any dated row. Two concurrent
baselines in one scope still collide on the unique constraint.

The trigger function runs with invoker rights and pins `search_path` (db
CLAUDE.md, "Adding a function"). Under RLS, `app_rw` sees only its own
tenant's rows, which are the only rows the exists check needs.

**Unread columns (U68, Q1).** Drop the `retread_at_or_above_scrap` constraint,
then `scrap_threshold_mm`, `insurance_minimum_mm` and `insurance_note`. No
live view or function reads them; 000013:18 inserts them in a data step, which
is history. TYRE-299 comment 13723 carries the SRS change for FR-CFG-010, FR-CFG-011,
FR-CFG-012, §5.1, Appendix D.2, FR-ANL-004 and the glossary.

**Warning above retread (S1).** `ALTER TABLE app.threshold_policy ADD
CONSTRAINT warning_above_retread CHECK (warning_threshold_mm >
retread_threshold_mm)`. A NULL warning passes. Without it, FR-EXC-021's
warning band can be empty. Every seeded and test row already satisfies it.

**No threshold defaults (TYRE-189 F5).** `ALTER COLUMN retread_threshold_mm
DROP DEFAULT` and `ALTER COLUMN max_retreads DROP DEFAULT`; both stay `NOT
NULL`, so every row states its own numbers. `effective_from DEFAULT now()`
stays because it is a date, not a threshold. `retreads_permitted DEFAULT
true` stays: F5 did not name it, and CHG-038 seeds the only `false`.
FR-CFG-011's 4 mm for a new tenant is met by provisioning writing the
baseline row (E1), never by a column default; the erratum restates it that way.

**TY023** goes in `api/internal/httpapi/refusal_codes.json` with `httpStatus:
null`: no route reaches it, the same reasoning as TY008 (ADR-0012). Its
`raisedBy` names both trigger functions.

### 2. The resolver and the back-dated return

**One inclusive resolver at any instant.** `app.threshold_policy_in_force`
gains an instant argument, `p_at timestamptz`, and its predicate becomes
`effective_from <= p_at`. The predicate keeps one body: there is no second
copy of the dimension filter or the precedence. Every caller that resolves at
`now()` today keeps doing so, with the same result: `fit_tyre`,
`dispatch_tyre`, `current_removal_threshold_mm`, and the forecast view that
calls it at 000048:87. Section 63 is extended so the as-at resolver
(`threshold_policy_for`, exclusive) and this one keep one precedence at an
arbitrary instant, not only at `now()`.

How the signature changes (a default-valued argument after a drop and
recreate, or a new name with the old one delegating) is the planner's choice.
The view at 000048:87 depends on the function, so a drop has to carry it.

**`app.log_retread_return` (U70 item 1, Q4).** Restated whole, with its
signature, defaults and `search_path` pin, so CREATE OR REPLACE keeps its oid
and grants. It already derives the return's instant, `stamp :=
app.tenant_day_instant(p_returned_on)`: `now()` for today, the tenant-local
start of the day for a past date. That instant is the RETURNED event's
`occurred_at`. The one policy resolution moves from `now()` to `stamp` and
still serves both the threshold and the cap, so one call cannot read the two
from different rows (TYRE-142).

Nothing new is stored on `retread_job`. Rows are written once (U69), and none
is dated before the `BEGIN` of the transaction that writes it (U70). A row is
seen only from its `COMMIT`, so the policy in force at `stamp` is fixed once
every policy writer open at `stamp` has committed. The gap is bounded by the
writing transaction, and a policy row is written by a transaction that does
nothing else and commits at once (U131). From then the rate is re-derivable
from the job's own figures and `stamp`, the RETURNED event's `occurred_at`.

The "no removal threshold is configured" refusal (TY014) names the return
date. Behind a `-infinity` baseline it cannot fire; it fires only for a
tenant whose first row is dated and a return dated before that row, and for
that tenant the date is what the reader needs. The "no retread policy is
configured" refusal (TY015) cannot fire at all: the threshold and the cap
come from one row, `max_retreads` is `NOT NULL`, and TY014 refuses first when
there is no row. It stays as a defence and its comment does not claim
otherwise (red team round 1).

**Unchanged.** `dispatch_tyre` and `fit_tyre` keep resolving at `now()`.
Neither stores a figure that has to be re-derived later, and U70 named the
return only.

### 3. Tests

**Suite section 70, as `app_login`.** Each part goes red when the piece it
pins is reverted.

- **70a.** An UPDATE of a policy row is refused with 42501.
- **70b.** Two tenant-wide rows at one instant are refused with 23505, which
  proves NULLS NOT DISTINCT. Control: the same instant in another axle class
  is accepted.
- **70c.** `now() - interval '1 microsecond'` is refused with TY023; `now()`
  and a future instant are accepted. `-infinity` is refused in BAC's
  tenant-wide scope, which has a row, and accepted in BAC's DRIVE scope,
  which has none.
- **70d.** Catalogue: the three columns are absent; `retread_threshold_mm`
  and `max_retreads` have no default; `warning_above_retread` exists, and an
  insert with `warning_threshold_mm <= retread_threshold_mm` is refused
  with 23514.
- **70e.** TYRE-310's probe, reversed. Over BAC's 4.0 baseline, a 6.0 row is
  inserted at `now()` with a different `max_retreads`. A return dated five
  tenant days ago, at a cost of 2500.00 over a 16.0 mm post-retread tread,
  stores 208.3333 (the 4.0 baseline) and is capped by the baseline's
  `max_retreads`. Control: the same return dated today stores 250.0000 (the
  6.0 row) and is capped by the new row's.

**`db/tests/005_privileged.sql`, as `postgres`.**

- The written-once trigger refuses a superuser UPDATE with TY023. This is
  the half that binds the owner role, which `app_login` cannot stage.
- **Sections 17, 69d and 69g's "no removal threshold configured" probes move
  here.** Each one's transaction deletes the tenant's tenant-wide rows as
  `postgres`, then `SET ROLE app_login`, sets the tenant and runs the probe
  under RLS, and rolls back. The reason, which the PR body repeats: once rows
  are written once, an unconfigured policy is unreachable for a configured
  tenant, so only a superuser can stage it. The probes keep their assertions
  and still run in `make test` and in CI. They no longer run in `make
  db-test`.
- A suite probe that needs a row dated in the past, in a scope that already
  has a row, is restated on present or future instants where its meaning
  survives. Section 18's tenant-2 row dated `2026-08-05` and section 59a's
  group row are the cases to check first. Where the meaning does not survive,
  the probe moves here and disables `threshold_policy_not_backdated` inside
  its rolled-back transaction. The plan lists each case and its choice.

**Existing suite inserts.** `scrap_threshold_mm` comes out of every column
list. Every insert states `retread_threshold_mm` and `max_retreads`, which no
longer default; many omit `max_retreads` today. A `now() - interval` row in a
scope that already has a row becomes `now()`, which the inclusive writer
resolver sees. Each test keeps its meaning.

**Go fixtures** (`api/internal/httpapi/*_test.go`).

- A fresh tenant's first row in a scope is dated `-infinity` (E1), replacing
  `now() - interval '1 hour'` and `'400 days'`.
- `scrap_threshold_mm` comes out of every insert.
- Every insert states `retread_threshold_mm` and `max_retreads`, which no
  longer default. The axle-class row `fitments_test.go` plants is one that
  omits both today.
- A test that stacks a second row in one scope dates it `now()`. The plan
  lists each one.

**Gate.** Appendix E stays 15/15 to the cent and Appendix J stays 19/11/9:
the fixture's rate reads only `RETREAD_THRESHOLD_MM`. `make check` exits 0.

### 4. Seeds

`SCRAP_THRESHOLD_MM` comes out of `db/seeds/seed_policy.py`, and the scrap
column and value come out of both inserts in
`db/seeds/gen_seed_configurations.py`, with its comment.

Both seeded rows omit `max_retreads` today and took the column's `DEFAULT 2`,
so once the default is gone the seed load fails `NOT NULL`. `seed_policy.py`
gains `MAX_RETREADS = 2`, with a line saying it is BAC's seeded cap, and both
inserts state it. The value the seeded rows carry does not change, so
sections 41 and 42 and the Appendix pins see the same cap.

The generated SQL is regenerated, never edited, and `make db-seeds-check`
stays deterministic. The seeded baselines are `-infinity` and pass the
back-date trigger.

### 5. Down file

The down file restores state, proved by the catalogue rather than by text:

- the three columns come back with their CHECKs, `scrap_threshold_mm` refilled
  from `retread_threshold_mm` before `NOT NULL DEFAULT 4.0` and
  `retread_at_or_above_scrap` are restored, so the restored CHECK holds on
  every row;
- `retread_threshold_mm DEFAULT 4.0` and `max_retreads DEFAULT 2` come back;
- `warning_above_retread`, both triggers and their functions, and
  `threshold_policy_one_row_per_instant` go;
- UPDATE is granted to `app_rw` again;
- 000048's bodies of the resolver and `app.log_retread_return` come back
  verbatim, comments included (TYRE-189 F6).

### 6. Docs

- `db/CLAUDE.md`, "Append-only": one line saying `threshold_policy` is
  written once and never back-dated, citing 000054.
- Nothing in `docs/`, `web/` or non-test `api/` names the dropped columns.

## Deployment

On staging, the REVOKE in 000054 is applied by the owner role, as 000051 was
(TYRE-368, comment 13439).

## Out of scope

- One "now" for every current figure: TYRE-244 (U70 item 2).
- `target_pressure` and `configuration`: TYRE-425.
- The SRS paste: by hand, from TYRE-299 comment 13723. TYRE-299's definition of done waits on it.
- `operating_group_id` stays dead until OI-29 settles tenancy.
- An axle-class row's `retread_threshold_mm` and `max_retreads` stay unread:
  U68 kept U5 tenant-wide for readers.
