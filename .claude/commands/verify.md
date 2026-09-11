---
description: Prove the three-way agreement still holds
---
Run the full verification and report honestly.

1. `make db-reset && make db-test` — the verification suite, as `app_login`.
2. Confirm the suite ran as a non-superuser. Check 0 asserts this; if it was
   skipped, the entire run is meaningless and you must say so.
3. Confirm all 15 Appendix E valuations reproduced to the cent.
4. Confirm check 8's Appendix J exception sets, asserted through
   `app.v_exception`, and check 59's numbers: **19 exceptions, 11 urgent,
   9 running positions below the removal threshold**, plus the value-at-risk
   figure R16,537.50 running and R1,837.50 spare. The view is the one
   implementation; the API relay (B7.2) and the dashboard e2e (B7.3) read it
   once they land, so until then a suite run is the whole agreement.
5. Confirm every view carries `security_invoker = true`.
6. Report pass/fail per check. Do not summarise a partial pass as success, and
   do not adjust a test to make it green — if a check fails, the finding is
   the deliverable.
