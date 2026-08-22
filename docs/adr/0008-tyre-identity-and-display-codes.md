# ADR-0008: Tyre identity and branded display codes

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Rourke (engineer) · Sponsor (domain authority) — answered directly, 22 August 2026
- **Closes:** OI-21 · **Unblocks:** P1 schema freeze
- **Related:** ADR-0007 (unit model) · SRS §5 DR-002 · FR-TYR-001..007 · CFL-001

## Context

The platform's central premise is that a tyre is tracked as an individual asset across its whole life — through fitting, rotation, removal, retread and refitting — because that is what makes cost-per-kilometre, brand comparison and casing valuation possible. Every one of those depends on knowing _which tyre_ a reading belongs to.

Identity in the physical world is a number branded into the sidewall. Asked who brands them and when, the sponsor answered:

> _"The numbers are branded according to internal policy; each company may assign an identifier to each tyre — there is no correct answer. In BAC's case it is usually the horse or trailer licence number + tyre position. They get branded as they enter the fleet. The manufacturers should do them but they don't."_

And, on the consequence:

> _"That's the gap — when they get retreaded and rotated the internal semantic breaks down… a tyre that gets rotated will still have the same number even if the canonical name doesn't match the rotated position."_

### Why this is more dangerous than it appears

BAC's scheme is **position-derived**. `CA123456-11` encodes _where a tyre is_, not _which tyre it is_. Two failure modes follow, and they are different in kind:

1. **Staleness.** Rotate the tyre from position 11 to 14 and the sidewall still reads 11. A sidewall cannot be un-branded. The sponsor has identified this and accepted it.
2. **Reuse.** When that tyre is scrapped and its replacement is fitted to position 11 of the same trailer, the new tyre is branded `CA123456-11` too. **Two distinct tyres now share a code.**

The second is the dangerous one, and it was not raised in the sponsor's answer because from the yard's point of view nothing is wrong — the brand still describes the wheel correctly. It is only wrong as a database key.

`001_schema.sql` currently declares `UNIQUE (tenant_id, branded_number)` (DR-002). Against this scheme that constraint does two things, both bad: it **rejects a valid insert** the first time a position is re-tyred, and if worked around by reusing the existing row, it **merges two tyres' lifetimes into one** — silently corrupting cost-per-km, wear rate and casing history for that record. This is not a rare edge case; it recurs on a schedule set by tyre life.

## Decision

**Internal identity and branded code are different things and are stored separately.**

|  |  |
| --- | --- |
| `tyre_id` (uuid) | The identity. Immutable, never reused, never surfaced to any user. |
| `display_code` (text) | Whatever the tenant brands. Free text. **No format imposed** — the sponsor is explicit that there is no correct scheme. |

Four rules make this work:

1. **Uniqueness on** `display_code` is enforced per tenant among _currently-active_ tyres only — not globally and not across time. Historical reuse is expected, valid, and must not be rejected.
2. **Branding is a dated event.** A code entered in the yard resolves to _the tyre carrying that code on that date_, so history stays intact and lookups stay unambiguous.
3. **Two active tyres sharing a code is an exception raised for human resolution**, never silently auto-resolved. The system does not guess which tyre a reading belongs to.
4. **Tyres found unbranded** during onboarding are issued a code and flagged `brand_pending` until physically branded. This is workshop work, not driver work.

**Recommended default, not enforced:** for tyres entering the fleet from go-live, a position-independent sequential code (`BAC-04217`). Same branding effort, no collisions, no staleness. The platform ships a per-tenant code generator as the default and accepts any scheme.

### The free feature

Because BAC's code encodes a position, a tyre branded `-11` found fitted at position 14 **implies an unlogged rotation**. This is surfaced as a soft prompt, not an error — giving rotation detection to fleets that do not log rotations reliably. It is a benefit of the scheme the sponsor already uses, not a workaround for it.

## Options considered

### Option A — Branded code as primary key

The obvious reading of DR-002, and what the current schema implements.

**Rejected.** It is not merely inelegant; it is incorrect against the sponsor's actual branding practice and will reject valid data. See CFL-001.

### Option B — Branded code as a globally unique natural key with a suffix on reuse

Append `-2`, `-3` on collision.

**Rejected.** The suffix exists only in the database and not on the tyre, so the code a driver reads and the code the system holds diverge — which is the same failure as Option A, deferred and made harder to diagnose.

### Option C — Surrogate identity + tenant display code _(chosen)_

**Pros:** matches the sponsor's stated model exactly ("a unique internal DB ref and a unique display name"); imposes nothing on any tenant's branding practice; supports historical reuse honestly; makes the duplicate case explicit rather than silent.
**Cons:** a code lookup can return more than one historical tyre and must resolve by date. This is a real cost and it is paid in one query.

## Consequences

**Easier**

* Tenants keep their own branding schemes with no migration or retraining
* Code reuse across time works correctly instead of failing
* Rotation detection comes free from BAC's existing convention
* CFL-001 is resolved before any pilot data is captured

**Harder**

* Lookups resolve by date rather than by equality
* The duplicate-active-code exception needs a resolution UI
* Every report that shows a tyre must decide whether to show the code or the identity; the code is what a human recognises, so it is the code — with the caveat that codes are not unique across history

**To revisit**

* Whether to offer the sequential generator as an opt-in migration for existing fleets, once one asks

## Action items

1. Rename `tyre.branded_number` → `tyre.display_code`
2. Replace `UNIQUE (tenant_id, branded_number)` with a partial unique index over active tyres
3. Add `brand_pending` and a dated branding event
4. Add the duplicate-active-code exception rule
5. Amend **DR-002** in the SRS — it currently states global uniqueness
6. Add the rotation-detected soft prompt to the capture flow
7. Close OI-21
