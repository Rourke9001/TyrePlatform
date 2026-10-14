# Design: audit rows carry the source address and session id (TYRE-201)

- **Date:** 2026-10-14
- **Ticket:** TYRE-201, under epic TYRE-9. It carries TYRE-383 (folded in on
  13 Oct 2026, TYRE-201 comment 13713, TYRE-383 comment 13710).
- **Decisions it rests on:** ADR-0014 (mutations are audited by one trigger),
  ADR-0016 (`app.session_id` and `app.record_session_start()`), ADR-0012 (the
  refusal envelope), and the owner's answers in the TYRE-201 spec session, 14
  Oct 2026, recorded below under "Decisions".
- **Requirements:** FR-AUD-001, FR-AUD-002, FR-AUD-004 (all in Appendix H.1),
  NFR-SEC-007 (whose per-address limit already resolves the client address
  this design records), and SRS §5.1 `audit_log`.

## Why this exists

FR-AUD-002 names ten fields per audit entry. `app.audit_log` has had a column
for each since 000001, but `app.audit_row_change()` (000035) writes seven of
them. `source_ip` and `session_id` have never held a value on a trigger row.
Six tables carry the trigger today: `vehicle`, `combination`,
`combination_member`, `inspection_task`, `inspection` and
`composition_observation`. TYRE-98 will attach it to seven more, so every
table it widens to would inherit the gap.

Half the plumbing exists. `store.InActorTx` binds `app.session_id` on a
bearer request (ADR-0016), and `app.record_session_start()` (000052) already
writes both columns for a session's first use. Nothing binds `app.source_ip`,
so that function's address is always NULL too.

TYRE-383 adds two defects on the same path:

1. `record_session_start()` casts `app.source_ip` with `::inet`. The day
   anything binds a value that is not an address, the cast raises 22P02.
2. `withActor` runs `refusalForPgError` over everything `InActorTx` returns,
   and 22P02 maps to 422 `invalid_submission`. The capture outbox treats a
   422 as permanent, so a server-side fault in the actor setup would fail a
   held inspection for good.

## Decisions

Owner answers, 14 Oct 2026, in the TYRE-201 spec session:

| # | Question | Answer |
|---|---|---|
| Q1 | What the audit trigger does with an `app.source_ip` that is not an address | Store NULL in both writers, through one helper. An audit detail never fails a business write |
| Q2 | Which of `InActorTx`'s steps answer 500 on failure | Every step before `fn`: context binding, actor lookup, tenant state, depot read, session start. Errors from `fn` and from `Commit` keep today's mapping |

The three design sections were approved as presented.

The ticket's own text predates ADR-0016. Its "record the session id half
against TYRE-2" is superseded: ADR-0016 binds `app.session_id`, and this
ticket keeps only the trigger reading it.

## Design

### 1. The address, from HTTP to the transaction

`requireActor` already computes the client address with `clientAddress()`
(`api/internal/httpapi/ratelimit.go`), honouring `TRUSTED_PROXY_HOPS`. That
one value keys NFR-SEC-007's address counter and names the client in the
refusal log. The audit row records the same value, so the platform has one
definition of the client's address.

- `httpapi.Identity` and `store.ActorKey` both gain `Source netip.Addr`.
  It must be the same field on both, because `withActor` converts one to the
  other (`store.ActorKey(id)`), and that conversion is the compile-time guard
  TYRE-317 put there: a field added to one struct and not the other stops the
  build.
- Resolvers never set `Source`. `requireActor` sets it after `Identify`
  returns, by parsing the client address with `netip.ParseAddr` and
  normalising it with `Unmap()` and `WithZone("")`. On Postgres 16.15,
  `'fe80::1%eth0'` is not a valid `inet`, and `'::ffff:1.2.3.4'` is stored
  as IPv6 unless unmapped. A value that does not parse leaves `Source` zero
  (TYRE-383).
- A dev-header request carries an address too. Its `session_id` stays NULL,
  as today.
- `InActorTx` binds `app.source_ip` with `set_config(..., true)` in the
  statement that already binds `app.tenant_id` and `app.session_id`, and only
  when `Source.IsValid()`. That is the rule `app.session_id` follows: bound
  when there is one, never bound to an empty or placeholder value.
- `Identity`'s doc comment says it is who a request claims to be. It is
  widened to say it also carries where the request came from, which nothing
  takes on trust either.

### 2. A failure in the actor setup answers 500 (Q2)

- `InActorTx` wraps a failure from any step before `fn` in a store error type
  that keeps `%w`, so the cause still reaches the log. The steps are
  `BeginTx`, the context binding, the actor lookup, the tenant state read, `actorDepots` and
  `record_session_start`.
- `ErrNoSuchActor`, `ErrTenantInactive` and `errActorKeyShape` are returned
  as they are now. The first two keep their 403s.
- `withActor` tests for the new type before it consults `refusalForPgError`,
  and answers 500 with the error logged, as its default arm does.
- Errors from `fn` and from `Commit` are not wrapped and keep today's mapping:
  they come from the handler's own work on what the client sent.

### 3. Migration 000055

- **`app.current_source_ip() RETURNS inet`:** a new `LANGUAGE sql STABLE`
  function beside `app.current_tenant_id()` and `app.current_actor_id()`
  (000001). It returns the bound address, or NULL when nothing is bound, when
  the value is empty, or when `pg_input_is_valid(value, 'inet')` is false.
  `pg_input_is_valid` is in Postgres 16 and needs no exception block per row.
  This is Q1's one helper, and its comment carries the rule: a bad address is
  NULL, never a refusal.
- **`app.audit_row_change()`:** replaced with `CREATE OR REPLACE`. The INSERT
  gains `source_ip` from `app.current_source_ip()` and `session_id` from
  `nullif(current_setting('app.session_id', true), '')`. Nothing else changes:
  the no-op UPDATE skip, `NEW.tenant_id` as the row's tenant, and a NULL actor
  for a seed or suite write all stay as 000035 wrote them.
- **`app.record_session_start()`:** replaced the same way. Its `::inet` cast
  becomes `app.current_source_ip()` (TYRE-383). Its refusals for an unbound
  session, actor or tenant stay.
- **Grants:** `CREATE OR REPLACE` keeps ownership and grants on the two
  existing functions. The helper gets the same EXECUTE that
  `app.current_actor_id()` has; the plan checks how that one is granted.
- No table changes, no new refusal code, no change to `app.audit_log`'s grants.

### 4. Down file

The down restores state, proved by the catalogue rather than by text: both
functions return to their 000035 and 000052 bodies, then the helper is
dropped. No migration after 000035 or 000052 alters either function, so those
bodies are the whole prior state.

### 5. Tests

Suite section 71, as `app_login`, rolled back:

- **71a:** an audited write with `app.source_ip` and `app.session_id` bound
  records that exact address and session id.
- **71b:** with neither bound, both columns are NULL.
- **71c:** `app.source_ip` set to `'not-an-ip'`, and then to `'fe80::1%eth0'`:
  the audited write succeeds and records a NULL address.
- **71d:** `app.record_session_start()` with an `app.source_ip` that is not
  an address stores the session start with a NULL address and does not raise.
  This is TYRE-383's definition of done, and it fails on 000052's body.

Section 68e is not changed.

Go:

- `store`: `app.source_ip` is bound when the key carries a valid `Source`,
  and is not bound, and does not leak into the next transaction on the same
  connection, when `Source` is zero. It sits beside
  `TestInActorTxSessionIDDoesNotLeakIntoTheNextTransaction`.
- `httpapi`: `requireActor` sets `Source` from `X-Forwarded-For` under the
  trusted hop count and from `RemoteAddr` without one; a value that does not
  parse gives the zero `Addr`; a zone is stripped; an IPv4-mapped address is
  unmapped.
- `bearer_integration_test`: the SESSION_START row carries the forwarded
  address, and one audited write through the API carries both the address and
  the session id.
- The classification from section 2: a wrapped `pgconn.PgError` with code
  22P02 from the actor setup answers 500, not 422. Once 000055 lands nothing
  natural makes those steps raise, so this is a unit test over the
  classification with a constructed error, not an injected database fault.

### 6. Docs

- ADR-0014: the paragraph that says `source_ip` and `session_id` are
  permanently NULL under the trigger is restated as current fact, citing
  000055.
- `docs/architecture.md`, the actor sketch: `app.source_ip` is bound beside
  `app.session_id`.
- `api/internal/store/store.go`: the comment saying TYRE-201's trigger "will
  read" `app.session_id` is restated.
- `db/CLAUDE.md` keeps no list of bound settings, so it needs no line.

## Out of scope

- TYRE-98, widening the trigger to seven more tables: the columns come with
  the shared function. A comment on TYRE-98 says so at hand-over.
- FR-AUT-017, an address on every authentication attempt, is not in H.1.
  Refused tokens stay in the API log as ADR-0016 decided.
- Set aside for the PR body:
  - The API log already records the client address on a refusal (ADR-0016),
    against NFR-PRV-007. It predates this ticket.
  - The recorded address is only as right as `TRUSTED_PROXY_HOPS`. Decision
    D7 recorded its ingress check (that the ingress appends the caller as the
    rightmost hop) as not yet performable, and TYRE-51, routing the deployed
    frontend to the API, may add a hop in front of the ingress.
