# Achievements

Big, talkable wins — the CV-grade register. An entry earns its place only if
it is *actionable in conversation*: you can state the problem, what was
built, and a number or property that proves it. Routine delivery does not
belong here; if every merged PR qualifies, nothing does.

Entry format:

```
## Title
**Claim:** the one-sentence version you would say out loud.
**Evidence:** the number, test, or artefact that backs it.
```

Newest first.

## Supply-chain gate that survives its own bypasses (TYRE-21)

**Claim:** built a dependency supply-chain defence that enforces a 14-day
release-age window on what is actually installed — not just on what npm
resolves — closing the `npm ci` lockfile loophole that version pinning and
`.npmrc` policy both miss.

**Evidence:** `scripts/check-release-age.mjs` validates every locked package
against the registry's publish dates on every PR; CI separately proves the
enforcing npm version is new enough to honour the policy, because the failure
mode is silent. Policy has exactly one source of truth (`web/.npmrc`).

## Tenant isolation proven hostile, not assumed

**Claim:** designed multi-tenant row-level security that fails closed and is
verified by a suite which first proves it is *able* to fail — it runs as a
non-superuser and aborts if it is not, because a superuser run passes
vacuously.

**Evidence:** 16-check verification suite (`db/tests/004_tests.sql`) run as
`app_login` in CI on every build (NFR-SEC-005): unset tenant context sees
zero rows, cross-tenant reads and writes are blocked, append-only grants and
`security_invoker` on every view are asserted, not assumed.

## Cent-exact reproduction of the 2021 valuation model

**Claim:** re-implemented a legacy spreadsheet valuation model in SQL and
reproduced all fifteen worked examples from the spec to the cent — the POC's
primary acceptance gate (FR-VAL-006) — with exactly one implementation of
the arithmetic in the whole codebase.

**Evidence:** check 7 of the verification suite pins `app.tread_value()` and
`app.rand_per_mm()` to all 15 SRS Appendix E valuations; the Appendix J
fixture independently yields the expected 19 exceptions / 11 urgent / 9
below-threshold sets.

## Spec and seed data that cannot drift

**Claim:** made the axle-configuration library drift-proof by generating both
the SRS appendix and the database seeds from the same model, with CI
asserting the generation is byte-for-byte deterministic.

**Evidence:** `db/seeds/gen_seed_*.py` are the single source of truth; the
CI "Seeds are deterministic" step regenerates and compares SHA-256 sums on
every build.
