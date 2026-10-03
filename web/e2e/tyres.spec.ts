import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";

// TYRE-91's tyre register (Jira), walked on Sandbox Fleet, never BAC
// (TYRE-80).
test.beforeEach(async ({ page }) => {
  await actAsOrgAdmin(page);
});

test("an admin receives, costs and scraps a tyre on Sandbox", async ({ page }) => {
  await page.goto("/fleet/tyres/new");

  // D12's UI contract: under GENERATED, the screen offers no field to
  // hand-type a code, so it cannot reach TY011's refusal from here (that
  // stays proven at the SQL/API layer, db/tests/004_tests.sql). What this
  // spec proves is the contract itself: no code field, and the operator told
  // the platform issues one (AS-014).
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

  // Costed: the query refetches, the flag flips, and the cost form is gone
  // rather than offering a second submission (D5/TY013: a correction later is
  // a decision this surface does not take).
  await expect(row.getByText("No", { exact: true })).toBeVisible();
  await expect(row.getByLabel(`Purchase price for ${displayCode}`)).toHaveCount(0);

  // Scrap with a reason (app.dispose_tyre requires one for SCRAPPED): no
  // "active only" filter exists yet, so the row stays visible with its state
  // updated rather than disappearing.
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
