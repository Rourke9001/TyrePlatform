---
description: Prove the three-way agreement still holds
---
Run the full verification and report honestly.

1. `make db-reset && make db-test` — the verification suite, as `app_login`.
2. Confirm the suite ran as a non-superuser. Check 0 asserts this; if it was
   skipped, the entire run is meaningless and you must say so.
3. Confirm all 15 Appendix E valuations reproduced to the cent.
4. Confirm check 8's Appendix J exception sets: the position sets for
   FR-EXC-020/035/038/036/022 behind the expected **19 exceptions, 11 urgent,
   9 running positions below the removal threshold**. Only the suite pins them
   — the capture app and the dashboard have no exception computation yet
   (TYRE-41, TYRE-7), so a run cannot confirm the three-way agreement itself.
5. Confirm every view carries `security_invoker = true`.
6. Report pass/fail per check. Do not summarise a partial pass as success, and
   do not adjust a test to make it green — if a check fails, the finding is
   the deliverable.
