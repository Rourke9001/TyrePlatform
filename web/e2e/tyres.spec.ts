import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";
import { posted, SANDBOX_PATTERN, SANDBOX_SIZE } from "./sandbox";

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
  await page.getByLabel("Size", { exact: true }).selectOption({ label: SANDBOX_SIZE });
  await page.getByLabel("Pattern", { exact: true }).selectOption({ label: SANDBOX_PATTERN });
  await page.getByLabel("New tread (mm)").fill("25.0");
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
  await row.getByLabel(`Cost source for ${displayCode}`).selectOption("INVOICE");
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

// TYRE-318's definition of done: a priced receive through the form, with its
// catalogue entries and new tread, is rated, so the register shows a Rand/mm
// where an unrated tyre shows a dash.
test("a priced receive through the pickers is rated on the register", async ({ page }) => {
  await page.goto("/fleet/tyres/new");
  await page.getByLabel(/quantity/i).fill("1");
  await page.getByLabel("Size", { exact: true }).selectOption({ label: SANDBOX_SIZE });
  await page.getByLabel("Pattern", { exact: true }).selectOption({ label: SANDBOX_PATTERN });
  await page.getByLabel("New tread (mm)").fill("25.0");
  await page.getByLabel("Purchase price").fill("4319.91");
  await page.getByLabel("Cost source").selectOption("INVOICE");
  await Promise.all([
    posted(page, /^\/api\/tyres$/),
    page.getByRole("button", { name: /^receive$/i }).click(),
  ]);
  const issuedCode = page.getByRole("status").getByRole("listitem");
  await expect(issuedCode).toHaveText(/^SBX-\d{5}$/);
  const displayCode = ((await issuedCode.textContent()) ?? "").trim();

  await page.goto("/fleet/tyres");
  // allTextContents does not wait, so the table must be on screen first.
  await expect(page.getByRole("columnheader", { name: "Rand/mm", exact: true })).toBeVisible();
  const columns = await page.getByRole("columnheader").allTextContents();
  const rateColumn = columns.indexOf("Rand/mm");
  expect(rateColumn).toBeGreaterThan(0);
  // The code is a row header, which getByRole("cell") skips, so the cells
  // run one index behind the headers (fitments.spec.ts).
  const row = page.getByRole("row", { name: new RegExp(displayCode) });
  // Appendix E's 4319.91 over (25.0 - 4.0) mm, the figure suite section 7
  // pins, at Sandbox's seeded 4.0 threshold: a literal, so a wrong rate
  // fails here, not only a missing one.
  await expect(row.getByRole("cell").nth(rateColumn - 1)).toHaveText("R 205.7100");
});
