import { type Page } from "@playwright/test";

// Sandbox Fleet, never BAC: BAC's rows are the acceptance fixture, and a spec
// that adds units to it changes what Appendix E and Appendix J reproduce
// (TYRE-80).
//
// Ids are md5-derived in db/seeds/gen_seed_fixture.py — md5('sbadmin1') and
// the sandbox tenant's fixed uuid — so they are stable across reseeds.
const ORG_ADMIN = "96b10943-acb4-c3d7-e8cd-3e1fb52e067e";
const TENANT = "33333333-3333-3333-3333-333333333333";

export async function actAsOrgAdmin(page: Page): Promise<void> {
  await page.addInitScript(
    ([user, tenant]) => {
      window.localStorage.setItem("tyre.dev.user-id", user);
      window.localStorage.setItem("tyre.dev.tenant-id", tenant);
    },
    [ORG_ADMIN, TENANT],
  );
}
