# Contributing

One engineer, so this is short. It exists because "documentation as you go, no
undocumented tribal knowledge" is the stated mitigation for risk R4 — a single
engineer being a bottleneck — and because a second person will eventually read
this.

## Tracker

Jira is the tracker: `TYRE` at https://rourke9001.atlassian.net. GitHub Issues
is deliberately not enabled — two backlogs is no backlog.

Confluence holds the specification. The git repo holds documentation *about the
code*. Do not copy a spec document into the repo: a second copy is a stale
second authority, and the project brief exists precisely to stop that.

## Branches and commits

```
TYRE-123-short-description
```

The Jira key in the branch name is what makes the GitHub-for-Jira integration
link the branch, its commits and its PR back to the ticket automatically. It is
worth the eight extra keystrokes.

Conventional commits, with the key in the subject:

```
feat(capture): TYRE-42 auto-advance the thumb keypad between tread boxes
fix(valuation): TYRE-51 floor tread value at zero below the removal threshold
chore(ci): TYRE-60 assert seed generation is deterministic
```

Rebase onto `main`. Do not merge `main` into your branch.

## Before you push

```
make check
```

CI runs the same thing. If `make db-test` fails, nothing else about the change
matters — that suite is the contract.

## Things that will get a change rejected

These are not style preferences. Each one has a specific failure behind it.

| Rule | What goes wrong without it |
|---|---|
| App connects as a superuser | `FORCE ROW LEVEL SECURITY` does not bind superusers. Every policy becomes inert and cross-tenant reads succeed silently. |
| A view without `security_invoker = true` | The view runs as its owner and returns every tenant's rows to any caller. |
| Plain `SET` instead of `SET LOCAL` | With a pooled connection, one tenant's context leaks into the next request. |
| A float anywhere near money | The acceptance gate is cent-exact reproduction of a 2021 valuation. |
| A hard-coded threshold | Correct for this tenant, wrong for the second customer. Everything is configuration. |
| Editing a reading instead of appending a compensating event | Readings are immutable by grant, not convention. If you needed `UPDATE`, the model is wrong. |
| Anything that adds taps to the driver flow | Adoption is the whole game. A slower capture screen fails the POC regardless of what it enables. |

## Writing an ADR

Any architectural choice gets one before the code. `/adr <title>` scaffolds it.
The **Consequences** section must say what the decision makes *harder* — an ADR
that only lists benefits is advocacy, not a record.
