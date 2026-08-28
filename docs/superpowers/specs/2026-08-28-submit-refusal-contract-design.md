# Design: the submit refusal contract

- **Date:** 2026-08-28
- **Tickets:** TYRE-77 (what a refusal says), then TYRE-78 (the machine-readable
  code it carries). Both under epic TYRE-4 (P3 — Capture app: PWA, offline
  queue, sync). Batch B3 of `docs/implementation-order.md`.
- **Decisions it rests on:** ADR-0009 (online-first with a durable submit
  outbox — why an unmapped error is dangerous) · ADR-0011 (actor context and
  authorisation — why two roles must not learn different things about the same
  vehicle)
- **Decision it produces:** ADR-0012 (the API error envelope)
- **Requirements:** NFR-USE-005, NFR-USE-010 · FR-OFF-011, FR-OFF-012,
  FR-OFF-013 · FR-INS-038 · FR-AUT-005

## Why this exists

`POST /api/inspections` is the only write endpoint the platform has, and it
refuses in fourteen places that share no contract. Every refusal is
`http.Error`, which is `text/plain`. Two consequences, one per ticket.

**TYRE-77.** `statusForPgError` forwards `pgErr.Message` verbatim. That was
harmless while the map held only the private `TY0xx` codes, whose messages are
written in `app.submit_inspection` and say what a driver's phone should see.
The driver-capture review then added the transport-level integrity classes —
`23502`, `23503`, `23514`, `22P02`, `23505` — because leaving them unmapped
meant a 500 that ADR-0009's outbox retries forever. Those messages are
Postgres's, not ours. A mapped `23503` answers 422 carrying a constraint name
and a table name: `reading_tyre_id_fkey`. It discloses internal schema, and it
is not something a driver can act on (NFR-USE-010).

**TYRE-78.** `TY003` is FR-INS-038's duplicate window — a genuine second
inspection of the same unit inside the configured interval, and the one thing
a driver needs to be told about. `23505` is any other unique-key violation.
Both map to 409, `ApiError` carries only the status, and
`web/src/capture/CaptureDone.tsx` attributes every 409 to the duplicate
window. A driver whose submit hit a constraint violation is told their vehicle
was already inspected today.

They ship together because they are one surface. Every write endpoint added
after this inherits whatever settles here, so the cost of deferring is paid
once per endpoint rather than once. TYRE-81's own description asks for these
first.

## Two premises corrected before designing

Both were verified against the repository on 28 Aug 2026 and both change what
the tickets ask for. They are recorded here because a later reader will
otherwise find the tickets and the code disagreeing.

**TYRE-77's stated constraint is not accurate.** The ticket says the `TY0xx`
messages are "asserted by name in `db/tests/004_tests.sql`". The suite
contains no message-text assertion at all — `grep -ci "message"` over that
file returns 0. What it asserts by name are the **SQLSTATEs**, in the form
`EXCEPTION WHEN SQLSTATE 'TY003' THEN got := 'TY003'`. Canning wire messages
therefore touches no database test. The same claim appears in
`docs/implementation-order.md`'s B3 paragraph and is corrected there as part
of this branch.

**TYRE-78 is wider than carrying a code through `ApiError`.** `apiPost`
throws `new ApiError(res.status, ...)` and discards the response body; the
client has never parsed an error body, and there is no JSON error body to
parse. TYRE-78 forces a structured error envelope into existence. That is the
surface every later endpoint inherits, which is why it gets an ADR.

A third, smaller correction: `docs/implementation-order.md` describes B3 as
preserving "the five `TY0xx` messages". There are ten. B1 added `TY008` and
`TY009` in migrations `000024` and `000025`.

## The envelope

Every non-2xx response the API emits carries the same body:

```json
{ "code": "TY003", "message": "a unit in this submit was already inspected within 4 hours" }
```

Both fields are always present. `Content-Type: application/json`. One
unexported helper in `api/internal/httpapi/httpapi.go` owns the shape:

```go
func writeError(ctx context.Context, w http.ResponseWriter, status int, code, message string)
```

It sets the status and delegates to the existing `writeJSON` at
`httpapi.go:497`. All fourteen `http.Error` call sites move to it: four in
`capture.go`, eight in `httpapi.go`, two in `ratelimit.go`.

Nothing is lost on the way in. No Go test asserts an error body — bodies
appear in the suite only as the failure message of a status assertion — and
the web client reads only `res.status`.

## The code table

`code` names the **reason**, never the layer that found it.

| Source | `code` | Status |
| --- | --- | --- |
| Database, named refusals | `TY003`..`TY007`, verbatim | 409 / 422 |
| Database, integrity classes `23502` `23503` `23514` `22P02` `22023` | `invalid_submission` | 422 |
| Database, other unique violation `23505` | `conflict` | 409 |
| `errVehicleNotVisible` (Go scope check) | `TY007` | 422 |

The fourteen refusal sites, each with the code it emits:

| Site | `code` | Status |
| --- | --- | --- |
| `httpapi.go:120`, `:125`, `:209` | `unauthorized` | 401 |
| `httpapi.go:221`, `:224` | `forbidden` | 403 |
| `httpapi.go:227` (`errVehicleNotVisible`) | `TY007` | 422 |
| `httpapi.go:230` (`statusForPgError`) | per the source table above | 409 / 422 |
| `httpapi.go:234`, `ratelimit.go:108` | `internal` | 500 |
| `capture.go:112` (bad vehicle id), `:328` (body too large or unreadable) | `bad_request` | 400 |
| `capture.go:332`, `:344` (malformed json) | `malformed_json` | 400 |
| `ratelimit.go:124` | `rate_limited` | 429 |

`bad_request` covers both a path parameter that will not parse and a body that
will not read, because the caller's remedy is identical and both are reached
only by a client defect. `malformed_json` stays separate: it is the one 400 a
correct client can provoke by sending a truncated body over a bad connection,
and it is worth telling apart in a support log.

Two properties of this table are load-bearing.

**The integrity classes collapse to one code** because a driver's recovery
action is identical for all five: the payload is wrong in a way the database
declined to name, the identical payload fails identically on every retry, and
somebody has to look at it. Five codes the client would treat the same are
five ways for the contract to drift. `23505` splits out because it is a 409
and must be distinguishable from `TY003` — that is TYRE-78's entire bug.

**`errVehicleNotVisible` carries `TY007`, not a code of its own.** The
sentinel's comment at `httpapi.go:245` already records that its status and
wording are TY007's deliberately: a ScopeTenant actor skips the Go-side
`v_capture_vehicle` check and meets the same condition at
`app.submit_inspection`'s TY007 guard, so refusing a driver differently would
have two roles learn different things about the same vehicle — the
distinction ADR-0011 exists to deny. A distinct code would re-open that gap
inside the new envelope. Because `code` names the reason and the reason is
identical, the two paths produce byte-identical responses.

Raw SQLSTATE never reaches the wire.

## What the message says

- **`TY0xx` forwards `pgErr.Message`.** These are ours. They are hand-written
  in `app.submit_inspection`, they are driver-legible, and they interpolate
  only tenant configuration and payload values the client itself sent —
  `position % carried % tread readings, the tenant configures %`. No table or
  constraint name appears in any of them.
- **Every other code carries a canned constant** keyed on the code.

The decisive argument against canning `TY0xx` in Go is rule 5. TY003's message
is raised as `'a unit in this submit was already inspected within % hours',
v_hours`, and `v_hours` is tenant configuration. A Go constant would either
hard-code four hours or drop the number. Canning would also put the refusal
vocabulary in a second place, against the house rule that one rationale lives
in one place.

The wire message is diagnostic-grade throughout: safe to log, safe to show a
support engineer, never the source of a driver's sentence. **Driver-facing
wording lives client-side, keyed on `code`.** That split is already
established — `outbox.ts:16` calls the stored `lastError` "diagnostics only,
never rendered". Stating it here makes both tickets' definitions of done
consistent with each other.

## The client

`ApiError` gains `code: string | null`. `apiGet` and `apiPost` parse the
response body for it and tolerate a plaintext, empty or unparseable body as
`null` — a proxy or gateway error will not carry the envelope, and a client
that assumes it does is a client that throws while handling an error.

The code then follows the path `lastStatus` already takes, unchanged in shape:

```
outbox.attemptSend  →  OutboxEntry.lastCode  →  CaptureFlow  →  CaptureDone
```

`CaptureDone` branches on `code === "TY003"` for FR-INS-038's wording and
gives FR-OFF-013's generic recovery line otherwise. Both branches state what
happened and what to do, which is NFR-USE-005 in full.

`classify()` is untouched. Both refusals remain permanent — TYRE-78 is
explicit that narrowing `23505` to a retryable status is the wrong fix, and
the outbox is correct as it stands.

## TY008 and TY009: B4 owns them

Neither has an entry in the map. Neither is reachable through
`app.submit_inspection`, so this is not a live bug. TY008 fires on a
`vehicle.configuration_id` change with history present; TY009 on a fitment
whose unit kind carries an odometer. Both need a write surface that does not
exist yet, and B4 builds the first one.

**They are deferred to B4, deliberately.** Two reasons:

- An entry added now could carry no test that can fail, because no endpoint
  can raise the code. `docs/lessons.md` (2026-08-20) records that a test that
  cannot fail is worse than no test. B4 can add the entry and a test that
  exercises it in the same change.
- `000024_configuration_immutable_with_history.up.sql:55` and
  `000025_fitment_odometer_by_unit_kind.up.sql:58` each state that the code
  has no entry in `submitStatus`. Applied migrations are edit-frozen. Adding
  entries now makes both comments false immediately; deferring keeps them true
  until the moment B4 makes the codes reachable, which is the moment they were
  always going to need revisiting.

Recorded in ADR-0012 so B4 inherits the decision rather than rediscovering the
question.

## Testing

- **Go, table-driven.** One row per entry in the code table, asserting status,
  `code`, and whether the message is forwarded or canned. Includes a synthetic
  `23503` whose message carries `reading_tyre_id_fkey`, asserting the string
  appears in neither field of the response.
- **Go, integration.** The existing capture tests already drive real refusals
  against a real Postgres; their assertions extend to the envelope.
- **vitest.** One case per `CaptureDone` branch — `TY003` produces the
  duplicate-window wording, any other permanent code produces the generic
  recovery line — plus the existing outbox permanence assertions, unchanged.
  `stubApi` in `CaptureFlow.test.tsx` needs codes in its error bodies; it
  currently returns `{inspectionId:"i1"}` for every status, including 409.
- **e2e.** `web/e2e/capture.spec.ts:341` drives a genuine duplicate submit
  through a real API and asserts `/already inspected/i`. It becomes an
  end-to-end check that the code survives every hop, and it must stay green.
  The browser-smoke job gates deploys and is not covered by `make check`.
- **db.** Unchanged. The SQLSTATE assertions in `004_tests.sql` still hold,
  and remain the thing that pins the codes. The messages are pinned at the Go
  layer, which is where forwarding happens.

## Sequence

Four commits on `TYRE-77-refusal-contract`, cut from `develop` at `33ccd27`.

| # | Commit | Contents |
| --- | --- | --- |
| 1 | `docs: TYRE-77 ADR-0012` | The envelope's shape, stated once |
| 2 | `feat(api): TYRE-77` | `writeError`, twelve call sites, canned messages, the code table. Client untouched |
| 3 | `feat(capture): TYRE-78` | `ApiError.code`, the outbox and flow thread, `CaptureDone` branching, vitest |
| 4 | `docs: TYRE-77` | `implementation-order.md` corrections; B3 recorded as delivered |

The envelope carries `code` from commit 2, so commit 3 never rewrites commit
2's work. `make check` before each commit, and the branch finishes with a PR
against `develop` and no merge.

## Out of scope

- **The web dashboard's error handling.** It consumes the same `ApiError` and
  keeps working — `code` is additive and it reads only the status.
- **Retry semantics.** `classify()` is correct and is not touched.
- **Renaming `submitStatus`.** It remains the SQLSTATE-to-status map for the
  actor transaction. B4 may widen it; naming is not this branch's business.
- **A shared error vocabulary between Go and TypeScript.** Two string
  constants in two languages is the honest cost of a wire contract; a
  generator is not worth it for a table this size.
