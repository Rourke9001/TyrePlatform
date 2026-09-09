# Pre-B6.4 remediation — what lands before TYRE-75 is planned

The 6 Sep 2026 review sweep (TYRE-143, closing comments on that ticket) read
the application at develop `e12068c` as one thing and raised TYRE-144 to
TYRE-213. This page sequences the subset that must land before B6 slice 4
(TYRE-75) is cut, as four slices, each its own branch, PR, review and
`make check`. Everything not listed here stays on the board under TYRE-143
and is scheduled after B6.4 or by the owner's decision. The Jira ticket is the
authority on each item; this page only orders them.

Numbered B6.3.5 in `docs/delivery-history.md` §B6. The handoff prompt that
runs it is gitignored (`docs/HANDOFF_pre_b64_remediation.md`).

## Why these and not the rest

The sweep found three Criticals, all reproduced as the app role: an
inspection row can be rewritten (TYRE-144), a submitted reading's governing
tread can be moved by appending a measurement (TYRE-145), and a driver who
starts the wrong vehicle can never get out (TYRE-146). Each one breaks a
non-negotiable rule in `CLAUDE.md` (rules 3 and 4, and the three-minute
constraint). B6.4 reconciles reported composition into dated rig changes, on
top of inspection and fitment history — it must not be built on history that
can be edited. The Important findings included here are the ones that either
share a migration with a Critical, answer a 500 on a driver-facing route, or
leave a tenant-isolation gap; the sweep's closing comment names them as the
blockers.

## Owner decisions needed before the slices start

| Decision | Ticket | Default if unanswered |
| --- | --- | --- |
| Bound the future side of `submitted_at`? The 000023 comment says no bound at all; the sweep disagrees. | TYRE-166 | Bound the future side only, skew from tenant configuration, past side untouched. |
| Was decision D-A (numbered tread fields) meant to ship without the plan-view glyph and the one-line hint? | TYRE-147 | Ship the glyph and hint; keep `orientation_known = true`. If the glyph is refused, stop stamping `true` from this path instead. |
| May the void path be a controller capability, or must it wait for FR-AUD sign-off? | TYRE-164 | Controller-gated, audited, reason required, no delete. |
| Is the "no spare on this unit" observation a reading, an event, or configuration? | TYRE-155 | An observation on the inspection, one tap on the spare sheet, removes the cell from the denominator. |

## Slice R1 — immutable history and the correction path (database)

One migration (000040), one PR. These interlock: the void is the one UPDATE
the written-once trigger must permit, and the measurement guard is the same
kind of trigger on the child table.

| Ticket | Sev | What lands |
| --- | --- | --- |
| TYRE-144 | Critical | `app.inspection` written-once trigger in the shape of `app.fitment_is_written_once()`; `UPDATE` revoked from `app_rw` except the void columns; suite check for both. |
| TYRE-145 | Critical | `app.reading_measurement` refuses INSERT/UPDATE/DELETE once its reading's inspection is submitted; grant revoke plus trigger; suite check with a control. |
| TYRE-164 | Important | `app.void_inspection(uuid, text)` sets `VOIDED` with a reason, audited; lifecycle writers may set `compensates_event_id`; controller endpoint and refusal codes per ADR-0012/0013. |
| TYRE-166 | Important | Per the owner's decision above; TY005 on a `submitted_at` beyond now plus the configured skew. |
| TYRE-185 | Important | One tread ceiling: `reading_measurement_tread_mm_check` and the TY005 guard read `app.max_tread_mm()`, or the two ceilings get two names and 000039's comment is corrected. |
| TYRE-206 | Important | Suite sections 18, 19 and 21 wrap their planting guards in the transaction; the T2 residue stops appearing on warm runs. |

Gate: Appendix E 15/15 and the section 8 pins unchanged; `make db-test` twice
in a row on a warm database with no residue.

## Slice R2 — the capture flow (web)

No tap is added to the clean path. Every change is measured against the tap
ledger in the lane 6 report before it merges.

| Ticket | Sev | What lands |
| --- | --- | --- |
| TYRE-146 | Critical | Confirmed "Discard this inspection" on the held-vehicle screen and the capture screen; names the vehicle and the positions lost; vitest that starts A, discards, starts B. |
| TYRE-148 | Important | A reopened position seeds its field from the first empty slot; resume returns to the sheet that was open. |
| TYRE-155 | Important | Per the owner's decision above; `rig.test.ts` case for a unit presenting no spare. |
| TYRE-147 | Important | Per the owner's decision above; `side` served on `CapturePosition`. |
| TYRE-150 | Important | `duration_seconds` documented as elapsed; the per-position seconds sum carried as the active figure, or the acceptance query written against the sum. |
| TYRE-167 | Minor | A permanently refused outbox entry can be acknowledged and dropped, behind the same confirmation as TYRE-146. |

Gate: `web/e2e/capture.spec.ts` on Sandbox with the cell count pinned at 29
and the running count at 26 (lane 6 F14, part of TYRE-173 — pin it here).

## Slice R3 — API and isolation

| Ticket | Sev | What lands |
| --- | --- | --- |
| TYRE-158 | Important | `INSERT`/`UPDATE` on `app.tenant` revoked from `app_rw`; suite section 37 covers `app.tenant` and `app.jurisdiction_tread_minimum` explicitly. |
| TYRE-160 | Important | `devHeaderEnabled` uses `LookupEnv`; test rows for unset, empty and set. |
| TYRE-162 | Important | `unitByID` and its siblings read `app.v_depot_vehicle`, widened for `ScopeTenant`; per-role integration test for the by-id path. |
| TYRE-170 | Important | `RuntimeParams["timezone"] = "UTC"` in `store.New`; suite probe on `SHOW TimeZone` for `app_login`. |
| TYRE-172 | Important | `unit_kind` scanned as `*string` with the client's null arm, or `SET NOT NULL` after backfill; ADR-0013's owner line corrected. |
| TYRE-174 | Important | `purchaseDate` and `receivedDate` through `dateField`; `22007`/`22008` mapped to 422 in `submitStatus`. |

Gate: `TestRefusalForPgError` rows for every new mapping; lane 1's probes
re-run as `app_login` inside `BEGIN … ROLLBACK`.

## Slice R4 — tests that would have caught R1 to R3

| Ticket | Sev | What lands |
| --- | --- | --- |
| TYRE-177 | Important | Section 31 reaches TY010 with no actor bound. |
| TYRE-179 | Important | The three retread and threshold CHECKs driven by `check_violation` blocks. |
| TYRE-181 | Important | 000039's search_path sentence corrected in 000043's header, which pins the three plpgsql routines; suite check 8d reads proconfig. |
| TYRE-200 | Important | The submit-refusal table asserts a code or message fragment per row. |
| TYRE-202 | Important | TY004, TY005, TY006 asserted on the wire. |
| TYRE-204 | Important | The ios Playwright project's comment stops claiming it runs the outbox spec; the WebKit run is TYRE-227. |

## Deferred past B6.4, by decision of this page

- Architecture tickets from lanes 13a, 13b and 13c (TYRE-149, 151, 153, 156,
  157, 159, 209, 210, 211, 212, 213): behaviour-preserving, valuable, and not
  blocking. TYRE-211 (one `threshold_policy` resolver) lands before TYRE-142
  whenever that is scheduled.
- Scope and planning gaps from lane 10 (TYRE-193 to TYRE-199, 203, 205,
  207): owner and sponsor decisions, not code, though TYRE-193 (the value-at-
  risk chain) decides whether the POC can pass its own criterion 6.
- Dashboard and register (TYRE-176, 182, 183): wait for TYRE-41's exception
  view.
- Every grouped Minor ticket (TYRE-169 to 192 where not named above).

## Rules that apply to every slice

- Migrations are new files; 000001 to 000039 are frozen. Every down file
  restores the previous body verbatim, comments included (TYRE-189 item 3).
- Every refusal is a `TY0xx` code with a test that reaches it, and a row in
  `TestRefusalForPgError` if it crosses the wire.
- No product behaviour changes beyond the ticket's own scope; a tap added to
  the clean capture path fails review.
- `make check` before every commit; the PR body lists which tickets it closes
  and quotes the gate lines. The owner moves tickets to Done on merge.
