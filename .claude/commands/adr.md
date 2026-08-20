---
description: Scaffold and write an architecture decision record
argument-hint: [short title of the decision]
---
Write a new ADR for: **$ARGUMENTS**

1. Find the next number: `ls docs/adr/`. Use four digits, zero-padded.
2. Copy `docs/adr/0000-template.md` to `docs/adr/NNNN-kebab-title.md`.
3. Fill it in properly. Specifically:
   - **Context** states the forces, not the answer. What makes this hard?
   - **Options considered** must include at least two you genuinely weighed,
     each with its real downside. An option list where one choice has no
     downsides means you have not thought about it.
   - **Decision** is one sentence, in the active voice.
   - **Consequences** includes what this makes harder, not only what it
     unlocks, and what would make us revisit it.
4. If the decision touches tenancy, RLS, money arithmetic, or the offline
   sync model, say so explicitly and cross-reference the relevant rule in
   CLAUDE.md.
5. Add a line to the index table at the bottom of `docs/architecture.md`.

Do not implement anything yet. The ADR is the deliverable.
