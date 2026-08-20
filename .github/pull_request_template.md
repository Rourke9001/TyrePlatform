## What and why

<!-- One paragraph. The Jira ticket has the detail; say what changed and why
     a reviewer should care. -->

Closes TYRE-

## Checks

- [ ] `make check` passes locally
- [ ] `make db-test` reports ALL CHECKS PASSED **as a non-superuser** (check 0 confirms this)
- [ ] Requirement IDs cited in comments for any non-obvious rule

## The non-negotiables

Tick only what this change actually touches; delete the rest.

- [ ] **Tenancy** — new tables have RLS `ENABLE`d *and* `FORCE`d, with `USING` and `WITH CHECK`
- [ ] **Views** — every new view sets `security_invoker = true`
- [ ] **Connections** — tenant context is `SET LOCAL` inside a transaction, never plain `SET`
- [ ] **Money** — `numeric`/`DECIMAL` end to end; no float anywhere near an amount
- [ ] **Immutability** — no new `UPDATE`/`DELETE` grant on readings, measurements, events or audit
- [ ] **Configuration** — no threshold, band or rate hard-coded
- [ ] **Capture speed** — this does not add taps or seconds to the driver flow (NFR-USE-001)

## Decisions

<!-- If this makes an architectural choice, link the ADR. If it makes one
     without an ADR, write the ADR first. -->
