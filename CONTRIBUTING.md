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

Cut feature branches from `develop`, and rebase onto `develop`. Do not merge
`develop` into your branch. (This said `main` until TYRE-21; ADR-0004 made
`develop` the integration branch and this line was missed.)

## Promoting to `main`

ADR-0004 is explicit that `main` advances **only** by fast-forwarding to a
`develop` commit that has already passed CI. GitHub's merge button cannot
fast-forward — it always writes a merge, squash or rebase commit — so opening a
PR into `main` is the one way to break the rule while appearing to follow it.
Promote from the command line instead:

```
git fetch origin
git push origin origin/develop:main
```

If that is rejected as non-fast-forward, `main` has diverged and something has
been committed or merged into it directly. Fix the divergence; do not force it
away without checking what is on `main` that is not on `develop`.

A ruleset on `main` enforces the mechanics that can be enforced — no deletion,
no non-fast-forward push, linear history. It cannot tell that a commit came
from `develop`, so the discipline above is still yours to keep.

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
