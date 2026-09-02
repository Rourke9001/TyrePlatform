import { type Page } from "@playwright/test";

// Sandbox Fleet, never BAC: BAC's rows are the acceptance fixture, and a spec
// that adds units to it changes what Appendix E and Appendix J reproduce
// (TYRE-80).
//
// Ids are md5-derived in db/seeds/gen_seed_fixture.py — md5('sbadmin1') and
// the sandbox tenant's fixed uuid — so they are stable across reseeds.
const ORG_ADMIN = "96b10943-acb4-c3d7-e8cd-3e1fb52e067e";
const TENANT = "33333333-3333-3333-3333-333333333333";

// Shared by actAsOrgAdmin and actAsUser: both stamp the same two keys, and
// addInitScript reapplies its callback on every navigation the page makes —
// which is why switching actor mid-test needs a fresh page, not a second call
// on the same one.
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

// For any sandbox actor a spec names by id: a driver this run created and
// just assigned a unit, whose reach into a capture is TYRE-81's DoD, or a
// seeded one whose capabilities the flow needs, such as the sandbox
// controller. Always the sandbox tenant — everything these specs write lives
// there (TYRE-80).
export async function actAsUser(page: Page, userId: string): Promise<void> {
  await actAs(page, userId, TENANT);
}
