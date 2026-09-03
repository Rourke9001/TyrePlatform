# ADR-0012: The API error envelope

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Rourke Amiss
- **Related:** ADR-0009 (online-first with a durable submit outbox — why an
  unmapped error is dangerous) · ADR-0011 (actor context and authorisation —
  why two roles must not learn different things about the same vehicle) ·
  NFR-USE-005, NFR-USE-010 · FR-OFF-011, FR-OFF-012, FR-OFF-013 · FR-INS-038 ·
  FR-AUT-005

## Context

`POST /api/inspections` is the only write endpoint the platform has, and it
refuses in fourteen places that share no contract. Every refusal is
`http.Error`, which is `text/plain`.

`statusForPgError` forwards `pgErr.Message` verbatim. That was harmless while
the map held only the private `TY0xx` codes, whose messages are written in
`app.submit_inspection` and say what a driver's phone should see. The
driver-capture review then added the transport-level integrity classes —
`23502`, `23503`, `23514`, `22P02`, `22023` and `23505` — because leaving them
unmapped meant a 500 that ADR-0009's outbox retries forever: an unmapped
refusal looks identical to a transient failure, and the one thing the outbox
must never do is retry a submit that can never succeed. Those five integrity
messages are Postgres's, not ours. A mapped `23503` answers 422 carrying a
constraint name and a table name — `reading_tyre_id_fkey` — which discloses
internal schema and is not something a driver can act on (NFR-USE-010). The
fix cannot be to unmap them; that reopens the retry-forever hazard.

A second, separate problem sits on the client. `TY003` — FR-INS-038's
duplicate window, a genuine second inspection of the same unit inside the
configured interval — and `23505` — any other unique-key violation — both
answer 409. `ApiError` carries only the status, and
`web/src/capture/CaptureDone.tsx` attributes every 409 to the duplicate
window. A driver whose submit hit an unrelated constraint violation is told
their vehicle was already inspected today, which sends them to argue about an
inspection that never happened.

## Options considered

### Option A — status only, canned messages

Keep the response as plain text, but can every message so no constraint or
table name reaches the wire. Cheapest change; touches only
`statusForPgError`.

**Its real downside:** `TY003` and `23505` still both answer 409 with no way
to tell them apart. TYRE-78's bug is unfixed, and every later endpoint that
wants to distinguish two refusals at the same status inherits the same gap.

### Option B — forward the raw SQLSTATE as the code

Give the client `23503` or `TY003` directly. Free diagnosability — whatever
Postgres raised is exactly what reaches the wire — and no new vocabulary to
maintain.

**Its real downside:** it makes Postgres's own error classes part of the
public contract. Replacing a `CHECK` constraint with a `TY0xx`-raising
trigger later — a change entirely internal to the database today — becomes a
silent breaking change for every client that branches on the SQLSTATE it
used to see.

### Option C — a `{code, message}` envelope with an API-owned vocabulary

Every refusal answers JSON carrying a `code` the API defines and a
`message`. The private `TY` class forwards its own message verbatim, because
those are ours; every other SQLSTATE maps to one of a small set of API
codes with a canned message.

**Its real downside:** the vocabulary now exists in Go and TypeScript as two
sets of string constants with nothing but tests keeping them aligned.

## Decision

**We will use Option C: every refusal answers a JSON `{code, message}`
envelope.**

```json
{ "code": "TY003", "message": "a unit in this submit was already inspected within 4 hours" }
```

Both fields are always present. `Content-Type: application/json`. One
unexported helper, `writeError`, is the only way a refusal reaches the wire —
it sets `Content-Type` before calling `WriteHeader`, because `WriteHeader`
locks the header map in and a helper that writes the status first has its own
`Content-Type` silently dropped while every status assertion still passes.

Two rules govern the vocabulary, stated here because later tickets depend on
them:

1. **`code` names the reason, never the layer that found it.** The Go scope
   check (`errVehicleNotVisible`) and SQL's `TY007` guard answer the same
   condition — a ScopeTenant actor meets the identical check in
   `app.submit_inspection` that the Go-side `v_capture_vehicle` filter
   already applied — so they answer with the same code, `TY007`. A distinct
   code for the Go-side path would let two roles learn different things about
   the same vehicle, which is the distinction ADR-0011 exists to deny.
2. **`TY008` and `TY009` are deliberately absent** from `submitStatus`
   *(TY009 amended 2026-09-03 — see the amendment below)*.
   Neither is reachable through any endpoint that exists today — `TY008`
   fires on a `vehicle.configuration_id` change with history present,
   `TY009` on a fitment whose unit kind carries an odometer, and each needs
   a write surface that does not exist yet: an *update* to `app.vehicle` for
   `TY008`, a write to `app.fitment` for `TY009`. `000024_configuration_immutable_with_history.up.sql:55`
   and `000025_fitment_odometer_by_unit_kind.up.sql:58` each state that the
   code has no entry in `submitStatus`; those migrations are edit-frozen, so
   adding entries now would make both comments false before either code is
   reachable. ADR-0013 governs the first admin write surface built after
   this one, and it adds only *create* endpoints — it reaches neither an
   update of `vehicle.configuration_id` nor a write to `app.fitment` — so
   this deferral does not discharge there either. The batch that builds an
   update or a fitment write adds the entry and a test that can fail in the
   same change.

The code table:

| Source | `code` | Status |
| --- | --- | --- |
| Database, named refusals | `TY003`..`TY016` (`TY008`, `TY010` excepted), verbatim | 409 / 422 |
| Database, integrity classes `23502` `23503` `23514` `22P02` `22023` | `invalid_submission` | 422 |
| Database, other unique violation `23505`, and `23P01` (`vehicle_driver_no_overlap`, 000026) | `conflict` | 409 |
| `errVehicleNotVisible` (Go scope check) | `TY007` | 422 |

| Site | `code` | Status |
| --- | --- | --- |
| Unauthenticated request | `unauthorized` | 401 |
| No such actor / role forbidden | `forbidden` | 403 |
| `errVehicleNotVisible` | `TY007` | 422 |
| `statusForPgError` (renamed `refusalForPgError`) | per the source table above | 409 / 422 |
| Unhandled internal error, rate limiter identity failure | `internal` | 500 |
| Bad vehicle id, body too large or unreadable | `bad_request` | 400 |
| Malformed JSON | `malformed_json` | 400 |
| Rate limited | `rate_limited` | 429 |

The integrity classes collapse to one code, `invalid_submission`, because a
driver's recovery action is identical for all five: the payload is wrong in a
way the database declined to name, the identical payload fails identically on
every retry, and somebody has to look at it. `23505` splits out as
`conflict` because it is a 409 and must be distinguishable from `TY003` —
that split is TYRE-78's entire bug.

`TY0xx` forwards `pgErr.Message` because it is ours: hand-written in
`app.submit_inspection`, driver-legible, and interpolating only tenant
configuration and payload values the client itself sent. `TY003`'s message
interpolates the tenant's configured window, so a Go constant could only
hard-code a wrong number or drop it — canning it would also put the refusal
vocabulary in a second place, against the rule that one rationale lives in
one place. Every other code carries a canned constant. Raw SQLSTATE never
reaches the wire, and no standard Postgres SQLSTATE class begins with `T`, so
testing the `TY` prefix cannot collide with one Postgres might introduce.

Two responses stay outside the envelope in name only: chi's default 404 and
405 handlers are replaced with four lines apiece that route through
`writeError`, because a contract every later endpoint inherits should not
ship with two known exceptions.

## Consequences

**Good:** one parser on the client, `ApiError.code`, handles every refusal.
Every write endpoint added after this inherits a contract instead of
inventing one, so the cost of deciding this is paid once rather than once
per endpoint. Support can key an investigation on a stable code instead of
a Postgres message that may change wording between versions.

**Bad:** the vocabulary exists as two sets of string constants, one in Go and
one in TypeScript, with nothing but tests keeping them aligned. chi's
fallbacks needed explicit handlers where they previously needed none. The
client must tolerate a response with no envelope at all — a proxy or gateway
refusal in front of the API carries none — so `ApiError.code` is
`string | null`, not `string`.

**Revisit when:** a second client (the manager dashboard) needs to branch on
a code the capture app does not use today; or the vocabulary passes roughly
a dozen codes and a generated shared definition starts to pay for itself
over two hand-maintained lists.

**Amended 2026-09-03 (TYRE-92):** consequence 2's premise held for exactly
one batch. `TY009` is reachable now — B5 slice 2 gave `app.fitment` its first
writers, `app.fit_tyre`/`app.remove_tyre`/`app.rotate_tyres`, and
`submitStatus` carries the entry with a test that fails without it.
`TY008` stays out permanently rather than temporarily: TYRE-94, the batch
that could have reopened `vehicle.configuration_id`/`unit_kind` editing,
instead has the unit `PATCH` decoder refuse both fields outright before a
transaction ever opens (`docs/implementation-order.md` §B5) — a database
backstop against a path the API deliberately never offers. An entry for it
would still carry no test able to fail.
