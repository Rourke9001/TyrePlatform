# ADR-0025: Scheduled work runs as a Container Apps job under its own database role

- **Status:** Accepted (owner, 18 Nov 2026, U234, with the approval of
  TYRE-371's spec)
- **Date:** 2026-11-18
- **Deciders:** Rourke
- **Related:** TYRE-371 (this record), TYRE-133, TYRE-243 · ADR-0017,
  ADR-0021, ADR-0024 · owner rulings U147 (B31, B32, D:TYRE-371), U232,
  U233 and U234 ·
  FR-EXC-002, FR-INS-052, FR-INS-054, FR-NOT-002, FR-NOT-003, NFR-AVL-006,
  NFR-OBS-003 · CLAUDE.md rule 1 · spec
  `docs/superpowers/specs/2026-11-18-scheduled-job-runner-design.md`

## Context

Three pieces of work need something to run them on a clock, with no user
request behind them. `app.generate_inspection_tasks` turns a fleet's
recurring schedules into tasks once a day (FR-INS-052), and today only a
test calls it. TYRE-243 will add a daily pass over time-based exception
rules (FR-EXC-002) and a sender that delivers a CRITICAL notification
within five minutes (FR-NOT-003).

Three facts shape the choice.

- **A job has no tenant.** Every request binds one tenant, proven from a
  token, and row security does the rest (rule 1). A job has to visit every
  active tenant, and `app.tenant` is under forced row security with the
  policy `id = app.current_tenant_id()` (000001:557-561). With no tenant
  bound, the app role reads no tenant at all.
- **The app role's isolation rests on which tenant ids it is handed.**
  `app_login` can bind any tenant id it knows. The API only ever binds the
  id a verified token names, and a tenant id is a random UUID that appears
  nowhere else. A way for `app_login` to list tenant ids would turn any
  SQL injection in the API into a read of every fleet.
- **Staging's API scales to zero and its database was stopped while idle**
  (ADR-0017). Anything that runs daily needs both to be there.

The pilot audit ruled the direction (U147, 21 Oct 2026). B31 chose a
Container Apps job running the API image as `id-tyre-api-<env>`,
"connecting as `app_login` under RLS". D:TYRE-371 recorded that the job
lists ACTIVE tenant ids through one narrow function. B32 chose Azure
Communication Services for email.

## Options considered

### The runner

**Option A: a Container Apps job on a cron trigger.** A second resource in
the environment the API already runs in, with the same image, identity and
Key Vault reference. Azure bills it only while it runs, about one US cent a
month for a one-minute daily run. Its cron is evaluated in UTC, and
Microsoft's own example for "a process that generates financial reports
nightly" is this job type (learn.microsoft.com/azure/container-apps/jobs).
**Its real downside:** the platform has no setting that stops a second
execution starting while one is running, and a run that never starts
leaves nothing behind. The design answers both. The job takes a database
lock per tenant, so a second run waits and then finds nothing to do, and
the alert fires on the absence of a success line, so a run that never
happened emails the owner the same as one that failed.

**Option B: a ticker inside the API process.** No new resource. **Its real
downside:** staging's API scales to zero, so the ticker would not be
running at 00:15. Production can run two replicas, and both would fire. A
deploy at the wrong minute drops the run.

**Option C: `pg_cron` inside PostgreSQL.** The generator is SQL, so the
schedule would sit beside it. **Its real downside:** a failed run is a row
in a table that something else must poll, the job would run as a database
role chosen in server configuration, and it cannot send email or call an
HTTP API, so TYRE-243's sender would need a second runner anyway.

**Option D: a GitHub Actions schedule that calls an endpoint.** **Its real
downside:** it needs a request handler that runs the generator for every
tenant, which is the thing TYRE-133 rules out, and an endpoint that acts
across tenants is a new way in.

**Option E: an Azure Functions timer trigger.** The owner asked for this
one on 18 Nov 2026. Go runs natively on Functions since 2026, on the Flex
Consumption plan only
(learn.microsoft.com/azure/azure-functions/supported-languages). The timer
runs one instance at a time and "will not trigger again if there is an
outstanding invocation still running"
(learn.microsoft.com/azure/azure-functions/functions-bindings-timer), which
is the one thing Option A has to build for itself. **Its real downside:**
it is a second way to ship the same code. A function app needs a storage
account, a hosting plan and the app itself
(learn.microsoft.com/azure/azure-functions/functions-infrastructure-as-code),
plus storage role assignments for the identity. The work would be a second
Go program on Microsoft's Functions worker, built as a zip beside the
image, with its own deploy step, and ADR-0017's rule that production runs
only what staging ran would need a second mechanism for that zip. The docs
do not list Flex Consumption's regions, so South Africa North is unproven.
The timer "doesn't retry after a function fails" unless a policy is added,
and nothing in Functions alerts when a timer does not fire, so the alert
is still ours to write. It would save about five lines of locking and add
four resources, a build and a deploy path.

### How the job reaches every tenant

**Option 1: connect as `app_login`; `app_rw` may execute the listing
function** (B31 and D:TYRE-371 as recorded). No new role and no new
secret. **Its real downside:** the API's own role can then list every
active tenant's id. The second fact above stops being true.

**Option 2: the job connects as its own role, `app_job`, the only role
that may execute the listing function.** `app_job` is a member of `app_rw`,
so row security binds it exactly as it binds `app_login`. The API's role
gains nothing. **Its real downside:** a second password and a second Key
Vault secret per environment, set once by the owner, and the secret must
exist before the release that first deploys the job. Both secrets sit in
one vault that the one identity reads, so this holds against SQL injection
in the API and not against someone who can act as the API's identity.

**Option 3: connect as the administrator.** Row security does not bind it.
Rule 1 forbids it.

### The listing function

It must read `app.tenant` with no tenant bound, so it runs as SECURITY
DEFINER owned by the migrating role, which row security does not bind
(ADR-0021's shape). An `app_writer` definer cannot do it: row security
binds that role by design (ADR-0024). It takes no argument, reads one
table, and returns ids only.

### Email

Azure Communication Services Email is being retired. Microsoft announced it
on 23 Sep 2026, effective 30 Sep 2028, and "recommend[s] using the two-year
retirement period to migrate existing workloads off ACS Email rather than
onboarding new solutions"
(learn.microsoft.com/azure/communication-services/acs-retirement-and-breaking-changes-guide).
The Azure-managed sender domain B32 named is "intended for testing purposes
only", at 10 emails an hour with no increase available
(learn.microsoft.com/azure/communication-services/concepts/service-limits,
concepts/email/email-quota-increase). One inspection day's notifications
would exceed that.

Three replacements were researched on 18 Nov 2026: Mailgun in its EU
region, Microsoft Graph through an Exchange Online mailbox, and Amazon SES
in Cape Town. The owner paused the choice (U232) and moved it to TYRE-243
(U233), whose spec makes it and whose record will say which.

## Decision

We will run scheduled work as Azure Container Apps jobs in each
environment's existing Container Apps environment, running the API image
with a `job` subcommand as `id-tyre-api-<env>` (Option A, U147 B31).

The job connects as `app_job`, a login role that is a member of `app_rw`
and nothing else, and is the only role that may execute
`app.active_tenant_ids()` (Option 2). It then opens one transaction per
tenant, with that tenant bound, so every read and write runs under row
security. This departs from B31's "connecting as `app_login`" for the
reason in the second fact above, and the owner accepted it with the spec
(U234).

A failed or missing run raises an alert from the absence of the job's
success line in the last day's logs.

Staging's database is no longer stopped while idle (U232).

We will not use Azure Communication Services Email. The email provider is
not chosen in this record. TYRE-243 chooses it (U233).

## Consequences

**Good:** the daily generator runs with no controller touching anything,
which TYRE-133 and Appendix H.3's criterion 4 need. The exception pass and
the notification sender get a runner by adding a step or a second job, not
a design. The API's role learns no tenant id it was not handed. One alert
covers a failed run, a run that never started and a run that logged
nothing.

**Bad:** there are now three kinds of SECURITY DEFINER function, and the
listing function runs with row security off, so its body is the only thing
that keeps it to ids of ACTIVE tenants. Suite check 8c pins it. If an
environment's administrator role ever stops bypassing row security, the
function returns nothing and the job reports success over zero tenants
(ADR-0021's warning). The release check that compares its count with the
administrator's is the control. Each environment has a second database
secret to rotate. An attacker who can act as the API's identity can read
the job's secret. Staging costs its full database compute every month.
Rolling back to an image from before this record leaves a job whose image
has no `job` subcommand, so it fails each night and alerts until the
rollback ends. No email can be sent until TYRE-243 chooses a provider.

**Revisit when:** a tenant outside UTC+2 signs, since one UTC cron suits one time zone; the
job gains a step that takes user input; a second runner would need a
different identity; or TYRE-437's follow-up narrows the administrator
role.
