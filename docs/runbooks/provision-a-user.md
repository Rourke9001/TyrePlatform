# Provision a person for sign-in

The sign-in design's runbook
(`docs/superpowers/specs/2026-09-30-b9-sign-in-design.md`, section 5;
ADR-0016). Checks a, b, c and c2 on TYRE-317 passed on 2 Oct 2026 (comment
13468), and the values they proved are written in below. Every step is an
owner action: CI cannot reach the Entra tenant, and the app cannot write the
link.

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

- Each step says what it expects. Anything else, a count or a value:
  `ROLLBACK;` and stop, before `COMMIT`.
- The binding scopes each statement through its WHERE clause
  (`app.current_tenant_id()`), so the step is correct whether or not the
  role bypasses RLS. Email is unique only per tenant, and a bypassing role
  would otherwise reach another tenant's row at the expected count. A missing
  `set_config` gives 0 rows from a `SELECT` or an `UPDATE`. The `INSERT`
  fails with an error instead, because a row with no tenant breaks the
  `platform_admin_has_no_tenant` check (migration 000001). Under a role that
  does not bypass RLS, the RLS policy refuses the row first. To see which
  kind the Azure role is:

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
  domain; otherwise sign-in fails with `AADSTS501461`. The identifier URI is
  `api://7804c37b-de70-4e9d-8700-f7f7a70fc988`, and check c2 signed in
  through it without that error, so it stays. If the error ever appears,
  change the identifier URI to `https://<tenant>.onmicrosoft.com/tyre-api`,
  change `VITE_AUTH_API_SCOPE` to match, and sign in again. That is
  configuration, not a failure of U101.
- `isFallbackPublicClient` stays false. Microsoft's how-to for mapped claims
  sets it, but it serves an app that requests tokens itself, and tyre-api
  only receives them.
- The `access_as_user` scope.
- `sid` reaches the access token without an optional claim (check c).
  FR-AUD-002's `session_id` depends on it: without it every hourly token
  counts as a new session.
- The tenant claim: the custom user attribute `platformTenantId` (String),
  stored as `extension_f0b6d011402f4b70b8336c088c46bd97_platformTenantId`
  on b2c-extensions-app. It is added in the enterprise app under Attributes
  and Claims with source "Directory schema extension", and emitted as
  `platformTenantId`, the value of `AUTH_TENANT_CLAIM` (check c2).
- No Microsoft Graph application permission (TYRE-378).

**The user flow** (a46a2c2f-4cc0-4422-877e-533ba4c92060)

- Self-service sign-up is off. Set it as an owner action, by a Graph PATCH
  on `identity/authenticationEventsFlows/{user flow id}` (beta) with
  `onInteractiveAuthFlowStart.isSignUpAllowed` set to false.
- The tenant attribute is not collected on the sign-up page. Only the owner
  sets it, by Graph. Anyone who could set it could name any tenant.

**tyre-pwa**

- SPA redirect URIs `http://localhost:5173/` and the Static Web App's
  origin followed by `/`, and nothing else, with implicit grant off. On
  2 Oct 2026 the registration held `http://localhost:5173/auth` and
  `http://localhost:5173`; both are replaced when the Static Web App's
  origin is added for the first staging sign-in. `https://jwt.ms` and the
  implicit grant added for checks b and c were removed the same day.
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
   tenant stops here. A platform admin makes it ACTIVE by hand before its
   first ORG_ADMIN is linked (TYRE-387, option A); the tenant runbook that
   step belongs in is TYRE-387's to write.
2. **Create the person in Entra, by Graph only.** A user created in the
   External ID admin center is given a password, and the passcode flow then
   asks for it instead of sending a code (check b). Work as your own
   delegated session, never as tyre-api:
   `az login --tenant 9f571f6c-5e2c-42ad-9cc2-e173ef4a0c19 --allow-no-subscriptions`.
   Save this as `person.json`, with one new GUID in both places marked
   `<guid>`:

   ```json
   {
     "displayName": "<name>",
     "userType": "Member",
     "creationType": null,
     "passwordPolicies": null,
     "mail": "<email>",
     "mailNickname": "<guid>",
     "otherMails": ["<email>"],
     "identities": [
       { "signInType": "federated", "issuer": "mail", "issuerAssignedId": "<email>" },
       {
         "signInType": "userPrincipalName",
         "issuer": "tyreplatform.onmicrosoft.com",
         "issuerAssignedId": "<guid>@tyreplatform.onmicrosoft.com"
       }
     ]
   }
   ```

   ```sh
   az rest --method POST --url https://graph.microsoft.com/v1.0/users --body '@person.json' --query id -o tsv
   ```

   Microsoft does not document creating this shape. It is what the passcode
   sign-up writes (Microsoft Q&A 5592937; U113, TYRE-317 comment 13469). If
   the person is asked for a password at step 6, the shape has stopped
   working: stop and raise it.

   Then set their tenant attribute. Save this as `tenant.json`:

   ```json
   { "extension_f0b6d011402f4b70b8336c088c46bd97_platformTenantId": "<tenant id>" }
   ```

   ```sh
   az rest --method PATCH --url https://graph.microsoft.com/v1.0/users/<oid> --body '@tenant.json'
   az rest --method GET --url 'https://graph.microsoft.com/v1.0/users/<oid>?$select=displayName,extension_f0b6d011402f4b70b8336c088c46bd97_platformTenantId'
   ```

   Expect their name and the tenant id step 1 showed.
3. **Keep their object id** (`oid`): the value the `POST` in step 2 printed.
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

Create the new Entra account and set its tenant attribute as in step 2 of
"Provision a person". An admin then reactivates the user in the app.
`createUser` reactivates by email and keeps the old subject. Then, in one
transaction, run the `SELECT`
from step 1 of "Provision a person", and stop where that step says to stop.
Then:

```sql
UPDATE app.app_user SET subject = '<new oid>'
 WHERE lower(email) = lower('<email>') AND subject = '<old oid>'
   AND tenant_id = app.current_tenant_id()
RETURNING id, tenant_id, display_name;
```

Expect exactly one row: the tenant id the `SELECT` showed and the rehire's
name.

Inspections the rehire left unsent on a phone under their old account stay
blocked: each is stamped with the old `oid`, and the new account cannot send
them (U104). The leaver step below exists so that never happens.

## A leaver

1. **Clear their work off every phone they used.** A disabled account can
   never send the inspections it left on a phone. The U104 stamp keeps
   anyone else from sending those inspections, and from discarding an
   inspection the leaver left open. While any of the leaver's work is on a
   phone, every other driver's sign-in there is undone. So before step 2,
   the leaver opens the app on each phone, signed in as themselves (they
   sign in again if it asks), and works through these in order:

   - **An inspection in progress.** They open it the way it was started:
     its task on "My inspections", or the vehicle's capture address,
     `/capture/<vehicle id>`, if it was started off the vehicle alone. Any
     task listed on "My inspections" also leads to it. A task for the same
     vehicle opens it. A task for another vehicle says "An inspection for
     another vehicle is still open on this phone", and "Go to it" opens it.
     Then either "Review and submit ›" and "Submit inspection", or "Discard
     this inspection" and "Discard". On the "another vehicle" screen,
     "Discard it" and "Discard" do the same without opening it.

     If neither path reaches it, open the capture address of any vehicle
     they drive, in the browser the app was used in. That address is the
     vehicle's page under "Units", `/fleet/units/<vehicle id>`, with
     `fleet/units` changed to `capture`, and it leads to the inspection the
     same way. An app added to the home screen has no address bar to open
     it in. TYRE-390 adds a way back to an open inspection in the app.
   - **"1 inspection needs the office"** (or "2 inspections need the
     office"). The office takes those readings by phone first. Then, for
     each one, the leaver taps "The office has <fleet number>" and
     "Remove". An inspection with no fleet number shows "The office has
     this one" instead.
   - **"1 inspection waiting to send"** (or more). With signal, they tap
     "Sync now" until the line goes. If the office refuses one, its line
     changes to "needs the office". Deal with it as in the item above.

   Then they tap "Sign out". The step passes when the app returns to its
   "Sign in" screen with no "waiting to send" or "needs the office" line
   above it. Sign-out is refused while the phone holds an open inspection
   or anything in the outbox (PD-S3). The refusal starts "You can't sign out
   yet." and says what is left (U108).

   That check holds only while the phone can read the app's storage. A read
   that fails counts as nothing held, so sign-out goes ahead and the lines
   go blank with work still on the phone. If a line went away without being
   sent or removed, reload the app and look again before step 2.

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
   deactivate by email, in one transaction. First run the `SELECT` from
   step 1 of "Provision a person":

   ```sql
   SELECT id, name, state FROM app.tenant WHERE id = app.current_tenant_id();
   ```

   Expect one row with the name of the leaver's fleet, in any state. Any
   other name: `ROLLBACK;` and stop. Then:

   ```sql
   UPDATE app.app_user SET active = false
    WHERE lower(email) = lower('<email>') AND tenant_id = app.current_tenant_id()
   RETURNING id, tenant_id, display_name, active;
   ```

   Expect exactly one row: the tenant id the `SELECT` showed, their name and
   `active` false. It bites on their next request (ADR-0011).
3. **Disable their Entra account.** An access token the API has already
   accepted lapses within 90 minutes; the deactivation above is what stops
   it sooner.

**If their work turns up on a phone later,** nothing needs wiping. An admin
reactivates them under "Add a user" with the same email, name and role. The
app offers "Reactivate <email>", and the user keeps their subject, as for a
rehire above. Re-enable their Entra account. The leaver then signs in on
that phone, clears the work as in step 1 and signs out. Then deactivate them
again (step 2) and disable their Entra account (step 3).

## Not covered here

- Deactivating from the app: TYRE-377.
- An audit row for the subject link: `app.app_user` writes are unaudited
  until TYRE-98.
- A person who needs two tenants needs two Entra accounts (ADR-0016).
