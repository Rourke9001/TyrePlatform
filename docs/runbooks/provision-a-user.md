# Provision a person for sign-in

The stage 1 draft of the sign-in design's runbook
(`docs/superpowers/specs/2026-09-30-b9-sign-in-design.md`, section 5;
ADR-0016). Items marked **stage 2** are filled in once checks a, b, c and c2
on TYRE-317 have passed. Every step is an owner action: CI cannot reach the
Entra tenant, and the app cannot write the link.

## Before any SQL

- Connect as the database's owning role: `postgres` locally, the Flexible
  Server admin `tyreadmin` in Azure. The app role cannot write
  `app.app_user.subject` (migration 000052).
- Run each SQL step in its own transaction that binds the tenant first:

  ```sql
  BEGIN;
  SELECT set_config('app.tenant_id', '<tenant id>', true);
  -- the step
  COMMIT;
  ```

- Each step says how many rows it expects. Any other count: `ROLLBACK;` and
  stop.
- The binding scopes each statement through its WHERE clause
  (`app.current_tenant_id()`), so the step is correct whether or not the
  role bypasses RLS. Email is unique only per tenant, and a bypassing role
  would otherwise reach another tenant's row at the expected count. A missing
  `set_config` gives 0 rows under either kind of role. To see which kind the
  Azure role is:

  ```sql
  SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

## Entra settings, once

Owner actions, recorded on Confluence page 10682399.

**tyre-api**

- Single-tenant. Microsoft warns against `acceptMappedClaims` on a
  multi-tenant app.
- Requested access token version 2 (check a).
- `acceptMappedClaims` set to true. Microsoft accepts it only when the
  requested audience is the app's GUID or an identifier URI on a verified
  domain; otherwise sign-in fails with `AADSTS501461`. Check a records the
  identifier URI. Only if check c2 returns that error, change the identifier
  URI to `https://<tenant>.onmicrosoft.com/tyre-api`, change
  `VITE_AUTH_API_SCOPE` to match, and run c2 again. That is configuration,
  not a failure of U101.
- The `access_as_user` scope.
- `sid` as an optional claim on the access token. Without it every hourly
  token counts as a new session, and FR-AUD-002's `session_id` cannot tie a
  day's work together. Check c2 confirms it arrives.
- The tenant claim: a custom user attribute for the platform tenant, added
  in the enterprise app under Attributes and Claims with source "Directory
  schema extension". Its emitted name goes into `AUTH_TENANT_CLAIM`.
  **Stage 2:** the name from check c2.
- No Microsoft Graph application permission (TYRE-378).

**The user flow** (a46a2c2f-4cc0-4422-877e-533ba4c92060)

- Self-service sign-up is off. Set it as an owner action, by a Graph PATCH
  on `identity/authenticationEventsFlows/{user flow id}` (beta) with
  `onInteractiveAuthFlowStart.isSignUpAllowed` set to false.
- The tenant attribute is not collected on the sign-up page. Only the owner
  sets it, by Graph. Anyone who could set it could name any tenant.

**tyre-pwa**

- SPA redirect URIs `http://localhost:5173/` and the Static Web App's
  origin followed by `/`, and nothing else. Once checks b and c have their
  results posted, remove `https://jwt.ms` and any implicit-grant setting
  added for them.
- Admin consent to tyre-api's `access_as_user`.

## Provision a person

1. **Confirm the tenant.** A tenant in any state other than ACTIVE has
   every sign-in refused (TYRE-376).

   ```sql
   SELECT id, name, state FROM app.tenant WHERE id = app.current_tenant_id();
   ```

   Expect one row, with the name of the fleet you are provisioning for and
   the state `ACTIVE`. A wrong tenant id that names another ACTIVE tenant
   passes every row count below, so the name is what shows the binding is
   right. Any other name or state: `ROLLBACK;` and stop. A `PROVISIONING`
   tenant stops here, because no procedure makes a tenant ACTIVE yet. The
   owner decides one on TYRE-387.
2. **Create the person in Entra.** Use the External ID admin center or
   Graph, in the shape check b proved works with the passcode flow.
   **Stage 2:** that shape. Then set their tenant attribute by Graph, as
   your own delegated session (Graph Explorer or `az rest`), never as
   tyre-api:

   ```http
   PATCH https://graph.microsoft.com/v1.0/users/{oid}
   {"extension_<b2c-extensions-app id without hyphens>_<name>": "<tenant id>"}
   ```

   **Stage 2:** the exact extension name, also recorded on page 10682399.
3. **Read their object id** (`oid`) in the admin center.
4. **Create their app user** through the app's admin screen, with the same
   email address. A tenant's first `ORG_ADMIN` has nobody to invite them and
   is inserted instead:

   ```sql
   INSERT INTO app.app_user (tenant_id, email, display_name, role)
   VALUES (app.current_tenant_id(), '<email>', '<name>', 'ORG_ADMIN')
   RETURNING tenant_id, display_name, role;
   ```

   Expect one row: the tenant id step 1 showed, their name and `ORG_ADMIN`.
5. **Link the subject.**

   ```sql
   UPDATE app.app_user SET subject = '<oid>'
    WHERE lower(email) = lower('<email>') AND subject IS NULL
      AND tenant_id = app.current_tenant_id()
   RETURNING id, tenant_id, display_name, role;
   ```

   Expect exactly one row: the tenant id step 1 showed, and the person's
   name and role.
6. **Check the link.** Have the person sign in once before their first
   field day and confirm the app greets them by name. A linking mistake then
   shows before any inspection exists (PD-S1).

## A rehire with a new Entra account

An admin first reactivates the user in the app. `createUser` reactivates by
email and keeps the old subject. Then:

```sql
UPDATE app.app_user SET subject = '<new oid>'
 WHERE lower(email) = lower('<email>') AND subject = '<old oid>'
   AND tenant_id = app.current_tenant_id();
```

Expect `UPDATE 1`.

Inspections the rehire left unsent on a phone under their old account stay
blocked: each is stamped with the old `oid`, and the new account cannot send
them (U104). The leaver step below exists so that never happens.

## A leaver

1. **Clear their work off every phone they used.** A disabled account can
   never send its held inspections. The U104 stamp keeps anyone else from
   sending them, or from discarding one the leaver left open. While any of
   them is on a phone, every other driver's sign-in there is undone. So
   before step 2, the leaver opens the app on each phone, signed in as
   themselves (they sign in again if it asks), and works through these in
   order:

   - **An inspection in progress.** They open it from "My inspections". If
     the app says "An inspection for another vehicle is still open on this
     phone", they tap "Go to it". Then either "Review and submit ›" and
     "Submit inspection", or "Discard this inspection" and "Discard".
   - **"1 inspection needs the office"** (or "2 inspections need the
     office"). The office takes those readings by phone first. Then, for
     each one, the leaver taps "The office has <fleet number>" and
     "Remove".
   - **"1 inspection waiting to send"** (or more). With signal, they tap
     "Sync now" until the line goes. One the office refuses moves to "needs
     the office", above.

   Then they tap "Sign out". The step passes when the app returns to its
   "Sign in" screen with no "waiting to send" or "needs the office" line
   above it. Sign-out is refused while the phone holds an open inspection
   or anything in the outbox (PD-S3). The refusal starts "You can't sign out
   yet." and says what is left (U108).

   **If the leaver cannot do this** and their work is still on a phone,
   every other driver's sign-in there is undone with "Inspections captured
   by another driver are waiting on this phone." It stays that way until
   someone clears the app's site data by hand in the phone's browser
   settings (TYRE-317 comment 13450). That deletes everything the app holds
   on the phone without sending it, other drivers' unsent inspections
   included. Check first. The "waiting to send" and "needs the office" lines
   count every submitted inspection still on the phone, whoever captured
   it. Ask the drivers who share the phone, and get the office any readings
   it does not have before you clear it.
2. **Deactivate their app user.** Until TYRE-377 adds the admin action,
   find the id and deactivate by it:

   ```sql
   SELECT id, tenant_id, display_name, active FROM app.app_user
    WHERE lower(email) = lower('<email>') AND tenant_id = app.current_tenant_id();
   UPDATE app.app_user SET active = false
    WHERE id = '<user id>' AND tenant_id = app.current_tenant_id();
   ```

   Expect one row from the SELECT.

   Expect `UPDATE 1`. It bites on their next request (ADR-0011).
3. **Disable their Entra account.** An access token the API has already
   accepted lapses within 90 minutes; the deactivation above is what stops
   it sooner.

## Not covered here

- Deactivating from the app: TYRE-377.
- An audit row for the subject link: `app.app_user` writes are unaudited
  until TYRE-98.
- A person who needs two tenants needs two Entra accounts (ADR-0016).
