import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";

// TYRE-91's tyre register, end to end on Sandbox Fleet (never BAC — BAC's
// rows are the Appendix E/J acceptance fixture, TYRE-80): receive a tyre
// under Sandbox's GENERATED policy, cost it from the awaiting-cost queue,
// then scrap it. One continuous test, not several: each step depends on the
// tyre the previous step just wrote, the same shape as admin.spec.ts's
// single build-a-tenant-from-nothing test.
test.beforeEach(async ({ page }) => {
  await actAsOrgAdmin(page);
});

test("an admin receives, costs and scraps a tyre on Sandbox", async ({ page }) => {
  await page.goto("/fleet/tyres/new");

  // D12's UI contract: under GENERATED (Sandbox is seeded GENERATED, prefix
  // SBX — db/seeds/002_seed_configurations.sql) the screen never offers a
  // field to hand-type a code into, so a receive can never reach
  // app.receive_tyres's TY011 hand-typed-code refusal from here. That
  // refusal stays proven at the SQL/API layer (db/tests/004_tests.sql); what
  // this spec can prove, on screen, is that the contract it exists to
  // enforce actually holds — no code field, and the operator told the
  // platform issues one instead (ReceiveTyre.tsx's AS-014 hint).
  await expect(
    page.getByText(
      /the platform assigns the next code.*mark the sidewall with the code shown after saving/i,
    ),
  ).toBeVisible();
  await expect(page.getByLabel(/display code/i)).toHaveCount(0);

  // Receive one tyre, no price: CFL-002's normal shape for intake, and what
  // puts it in the awaiting-cost backlog the next step reads from.
  await page.getByLabel(/quantity/i).fill("1");
  await page.getByRole("button", { name: /^receive$/i }).click();

  const status = page.getByRole("status");
  await expect(status).toBeVisible();
  const issuedCode = status.getByRole("listitem");
  await expect(issuedCode).toHaveText(/^SBX-\d{5}$/);
  const displayCode = ((await issuedCode.textContent()) ?? "").trim();

  // The register: the just-received tyre is flagged awaiting cost.
  await page.goto("/fleet/tyres");
  const row = page.getByRole("row", { name: new RegExp(displayCode) });
  await expect(row.getByText("Yes", { exact: true })).toBeVisible();

  // Cost it through the register's inline CostForm (TyreList.tsx), rendered
  // only while awaitingCost is true.
  await row.getByLabel(`Purchase price for ${displayCode}`).fill("550.00");
  await Promise.all([
    page.waitForResponse(
      (res) =>
        /\/api\/tyres\/.+\/cost$/.test(new URL(res.url()).pathname) &&
        res.request().method() === "POST",
    ),
    row.getByRole("button", { name: /^set cost$/i }).click(),
  ]);

  // Costed: the query refetches (invalidation in CostForm's onSuccess), the
  // awaiting-cost flag flips and the row's cost form — which renders only on
  // an awaiting-cost row — is gone rather than offering a second submission
  // (D5/TY013: a correction later is a decision this surface does not take).
  await expect(row.getByText("No", { exact: true })).toBeVisible();
  await expect(row.getByLabel(`Purchase price for ${displayCode}`)).toHaveCount(0);

  // Scrap it with a reason (app.dispose_tyre requires one for SCRAPPED) and
  // see its own state change — there is no "active only" filter in the
  // landed register, so the row stays visible with its state updated rather
  // than disappearing from the list.
  await row.getByRole("combobox", { name: `Disposal for ${displayCode}` }).selectOption("SCRAPPED");
  await row.getByLabel(`Reason for ${displayCode}`).fill("worn beyond removal threshold");
  await Promise.all([
    page.waitForResponse(
      (res) =>
        /\/api\/tyres\/.+\/dispose$/.test(new URL(res.url()).pathname) &&
        res.request().method() === "POST",
    ),
    row.getByRole("button", { name: /^dispose$/i }).click(),
  ]);

  await expect(row.getByText("SCRAPPED", { exact: true })).toBeVisible();
});
