---
description: Prove the three-way agreement still holds
---
Run the full verification and report honestly.

1. `make db-reset && make db-test` — the 16-check suite, as `app_login`.
2. Confirm the suite ran as a non-superuser. Check 0 asserts this; if it was
   skipped, the entire run is meaningless and you must say so.
3. Confirm all 15 Appendix E valuations reproduced to the cent.
4. Confirm the Appendix J fixture yields exactly **19 exceptions, 11 urgent,
   9 running positions below the removal threshold**.
5. Confirm every view carries `security_invoker = true`.
6. Report pass/fail per check. Do not summarise a partial pass as success, and
   do not adjust a test to make it green — if a check fails, the finding is
   the deliverable.
