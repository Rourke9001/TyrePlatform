import { type Page } from "@playwright/test";

// Sandbox Fleet, never BAC: BAC's rows are the Appendix E/J acceptance
// fixture (TYRE-80). Ids are md5-derived in db/seeds/gen_seed_fixture.py
// (md5('sbadmin1'), the sandbox tenant's fixed uuid), stable across reseeds.
//
// Identity is the two localStorage keys actAs stamps below; a raw request
// has no localStorage, so it sends the dev actor headers instead
// (APP_DEV_TENANT_HEADER, src/api/devTenant.ts).
const ORG_ADMIN = "96b10943-acb4-c3d7-e8cd-3e1fb52e067e";
const TENANT = "33333333-3333-3333-3333-333333333333";

// Shared by actAsOrgAdmin and actAsUser: addInitScript reapplies its callback
// on every navigation, so switching actor mid-test needs a fresh page, not a
// second call on the existing one.
async function actAs(page: Page, userId: string, tenantId: string): Promise<void> {
  await page.addInitScript(
    ([user, tenant]) => {
      window.localStorage.setItem("tyre.dev.user-id", user);
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
    },
    [userId, tenantId],
  );
}

export async function actAsOrgAdmin(page: Page): Promise<void> {
  await actAs(page, ORG_ADMIN, TENANT);
}

// For any sandbox actor a spec names by id, always the sandbox tenant:
// everything these specs write lives there (TYRE-80, TYRE-81).
export async function actAsUser(page: Page, userId: string): Promise<void> {
  await actAs(page, userId, TENANT);
}
