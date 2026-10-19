## What and why

<!-- One paragraph. The Jira ticket has the detail; say what changed and why
     a reviewer should care. -->

Closes TYRE-

## How it ran

Stages from CLAUDE.md, How work runs. Delete the line a small fix or a
docs-only PR does not use, and say which one it is.

- Spec: `docs/superpowers/specs/`
- Red team: verdict, and the Critical/Important findings fixed and ruled on
- Small fix: the plan, in a few lines
- [ ] Code review by a separate session (`/review-pr`): report path, and no
      open Critical or Important finding

## Checks

- [ ] `make check` passes locally
- [ ] `make db-test` reports ALL CHECKS PASSED **as a non-superuser** (check 0 confirms this)
- [ ] **Migration:** the image production runs now still works on this schema, or the change ships in two releases (`docs/runbooks/environment-release.md`, Promote to production). Delete this line if the PR adds no migration.
- [ ] Requirement IDs cited in comments for any non-obvious rule, taken from the SRS in Confluence, never invented
- [ ] `/comment-audit` run over the branch diff; every comment states a constraint the code cannot, and reads per the Prose section of `docs/comments.md` (`/unslop`)

## The non-negotiables

Tick only what this change actually touches; delete the rest.

- [ ] **Tenancy**: new tables have RLS `ENABLE`d *and* `FORCE`d, with `USING` and `WITH CHECK`
- [ ] **Views**: every new view sets `security_invoker = true`
- [ ] **Connections**: tenant context is `SET LOCAL` inside a transaction, never plain `SET`
- [ ] **Money**: `numeric`/`DECIMAL` end to end; no float anywhere near an amount
- [ ] **Immutability**: no new `UPDATE`/`DELETE` grant on readings, measurements, events or audit
- [ ] **Configuration**: no threshold, band or rate hard-coded
- [ ] **Capture speed**: this does not add taps or seconds to the driver flow (NFR-USE-001)

## Decisions

<!-- If this makes an architectural choice, link the ADR. If it makes one
     without an ADR, write the ADR first. -->

## Set aside

<!-- Problems found that this PR does not fix and that fail CLAUDE.md's
     schedule test, one line each with file:line. This list is their
     record; close-out tickets only what passes the test (U130). -->
