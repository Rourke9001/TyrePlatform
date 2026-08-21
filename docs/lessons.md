# Lessons

Repeatable, avoidable mistakes — things that bit once and must not bite
again. This is a curated register, not a diary: an entry earns its place by
changing how we work next time. If it cannot be written as a rule, it is an
anecdote, not a lesson.

Entry format — keep each one to this shape:

```
## YYYY-MM-DD — Title
**What happened:** one or two lines.
**The rule:** the behaviour that prevents a repeat, stated imperatively.
```

Newest first.

## 2026-08-20 — A tool silently ignoring config is not enforcement (TYRE-21)

**What happened:** `web/.npmrc` set `min-release-age=14`, but the npm bundled
with Node 22 predates the key and ignores unknown config without a warning.
The supply-chain gate read as configured while enforcing nothing. Worse,
`npm config get` echoes the value back even on an npm that ignores it.

**The rule:** never verify a control by checking its configuration is
present; verify the enforcing tool's version supports it, or better, test
the artefact the control is supposed to protect. Presence proves the file
was read, not that anything is enforced.

## 2026-08-20 — A test that cannot fail is worse than no test

**What happened:** the RLS isolation suite passes vacuously when run as a
superuser — every assertion becomes a no-op that still prints PASS. Nothing
looked wrong until the suite was made to assert its own runtime identity
(check 0).

**The rule:** for any test guarding a security property, first prove the
test *can* fail — run it in the broken configuration, or make it assert the
preconditions that give it teeth.

## 2026-08-20 — Windows hosts lie about their toolchain

**What happened:** `python3` on stock Windows is a Microsoft Store stub that
opens a browser; Git Bash rewrites `/migrations` into a Windows path and
breaks container mounts. Both produced confusing failures far from the cause.

**The rule:** on this host, route every command through the Makefile, which
already carries the workarounds (`PYTHON` detection, `MSYS_NO_PATHCONV`).
When adding a new command, assume the host toolchain is hostile and pin the
workaround in the Makefile, not in a shell history.

## 2026-08-21 — A standard nobody's context window contains does not exist

**What happened:** a previous attempt at a comment-style document changed
nothing: generated comments kept violating it because the document was never
in context at the moment comments were written, and nothing checked the
output.

**The rule:** a convention only holds if it is either in the writer's context
at write time (CLAUDE.md) or enforced on the artefact afterwards (hook,
lint, CI) — ideally both. A standalone standards document with neither is
decoration. See `docs/comments.md` for the pattern applied.
