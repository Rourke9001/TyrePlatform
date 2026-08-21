# Comment standard

The authority for every code comment in this repo, in every language. The
terse version lives in CLAUDE.md (that is what is in context when comments get
written); this file is the full standard with the reasoning and the examples.
If the two ever disagree, fix the disagreement — this file wins in the
meantime.

Enforced two ways:

- `scripts/check-comment-style.mjs` catches the mechanically detectable
  violations. It runs on every Claude Code file edit (feedback lands before
  the comment is ever committed), in `make lint`, and in CI.
- `/comment-audit` is the judgment pass — run it when closing out a branch.
  It reads the branch diff against this file and flags what a regex cannot.

## The one rule

**A comment states something true about the code that the code cannot say
itself.** Everything below is a corollary.

Comment *why*, never *what*. The reader has the code; what it does is the one
thing they never need told. What they cannot see is the constraint: the
platform behaviour, the requirement, the trade-off, the footgun.

## What a comment must never be

### 1. A narration of the change

The moment a change merges, it stops being a change and becomes the code.
Comments comparing the current code to a prior version — "the old way",
"used to be", "renamed from", "we changed this to" — explain a diff, not the
code. The comparison already has a home with better tooling: git history and
the PR. In the file it is noise that goes stale the day the "old way" is
forgotten.

The same goes for justifying the new way over the old. There is no old way
any more; justify the code against its *constraints*, not against its
history.

```go
// BAD:  Previously we used a mutex here, but channels are cleaner.
// GOOD: One goroutine owns the map; everyone else sends. A mutex would
//       also work but would put the invariant in every caller.
```

### 2. A restatement of the line below it

```sql
-- BAD:  increment the sequence counter
-- BAD:  loop over the axles
```

If deleting the comment loses nothing, delete the comment.

### 3. Information overload

One rationale, stated once, where it binds. If the same explanation is
needed in two files, one of them holds the canonical version and the other
cites it in a line — for example the release-age rationale lives at the top
of `scripts/check-release-age.mjs`, and `ci.yml` just points there. Two full
copies means two things to keep in sync, which is how a rationale quietly
becomes wrong in one place.

The same applies within a comment: say the load-bearing thing and stop. A
comment nobody finishes reading protects nobody.

### 4. Process residue

"As discussed", "per the review", "addressing feedback" — the review is not
in the file. If the feedback mattered, its *conclusion* belongs in the
comment; the conversation does not.

## What a comment should be

The archetypes, all real, all currently in this repo:

**A non-obvious mechanism plus the requirement it satisfies**
(`db/migrations/000001_init.up.sql`):

> It returns NULL when unset, and every policy compares with '=', so an
> unset context matches no rows: the system fails closed (FR-TEN-004).

**A platform fact you cannot get from the code** (`api/cmd/api/main.go`):

> Container Apps sends SIGTERM on scale-in; draining in-flight requests here
> is what makes scale-to-zero invisible to clients.

**A single surprising, load-bearing fact** (`Makefile`):

> python3 on stock Windows is a Microsoft Store stub that opens a browser.

**A documented accepted risk** — name the weakness and the compensating
control rather than pretending it is not there. See the ACCEPTED TRADE note
in `infra/main.bicep` and the DEPLOYMENT NOTE at the end of
`000001_init.up.sql`.

## Requirement and ticket IDs

Every comment that encodes a domain rule cites its requirement ID
(`FR-VAL-006`, `CR-011`, `BR-INS-003`, …) so code and spec stay findable
from each other. Where no SRS requirement applies — scheduling, open
questions, infrastructure — a ticket or open-issue ID (`TYRE-12`, `OI-28`,
`Q7`) is the right substitute. A rule with no ID is either not a rule or
not yet in the spec; both are worth knowing.

`TODO`/`FIXME`/`HACK` must carry an ID on the same line. An untracked TODO
is a decision nobody made; the checker rejects it.

## Explicit exceptions

Named here so nobody cites them as precedent for the wrong thing:

- **Compact domain glosses** on otherwise-opaque columns or fields are fine:
  `sequence int NOT NULL, -- capture order within the configuration`,
  `-- NULL for spare`. The test: the gloss carries domain knowledge the
  identifier cannot, in a handful of words. It is not licence for `// the
  user's name` on `userName`.
- **Bare section dividers** (`-- ---- storage --`) are navigation, not
  comments; they carry no claim so they cannot go stale. Allowed.
- **Generated-SQL comment strings** in `db/seeds/gen_seed_*.py` are output,
  not source comments, but follow the same rules — the generated file is
  what a debugging human reads.
- **Prose documents** (`docs/`, ADRs, markdown) are exempt from the
  change-narration rule: an ADR's whole job is to compare alternatives and
  record history.

## When the checker is wrong

The deterministic check is deliberately narrow, but a flagged phrase can be
innocent — "no longer than 32 bytes" is not change narration. Do not add a
suppression mechanism; rephrase. A comment that trips a history-narration
pattern while making a present-tense claim is usually a comment that reads
ambiguously to humans too.
