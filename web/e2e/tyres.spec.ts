import { expect, test } from "@playwright/test";

import { actAsOrgAdmin } from "./admin";
import { posted, SANDBOX_PATTERN, SANDBOX_SIZE } from "./sandbox";

// TYRE-91's tyre register (Jira), walked on Sandbox Fleet, never BAC
// (TYRE-80).
test.beforeEach(async ({ page }) => {
  await actAsOrgAdmin(page);
});

test("an admin receives a tyre, prices its receipt and scraps it on Sandbox", async ({ page }) => {
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

  // The register: the just-received tyre is flagged awaiting cost, and is
  // priced with its set on its receipt, never alone (FR-CFG-041).
  await page.goto("/fleet/tyres");
  const row = page.getByRole("row", { name: new RegExp(displayCode) });
  await expect(row.getByText("Yes", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Price it on its receipt" })).toBeVisible();
  await expect(row.getByLabel(`Purchase price for ${displayCode}`)).toHaveCount(0);

  // Record the invoice on the receipt that holds the issued code.
  await page.goto("/fleet/tyres/receipts");
  const receipt = page.getByRole("row", { name: new RegExp(displayCode) });
  await receipt.getByRole("button", { name: "Record invoice" }).click();
  await receipt.getByLabel("Unit price").fill("550.00");
  await Promise.all([
    posted(page, /^\/api\/tyre-receipts\/[^/]+\/invoice$/),
    receipt.getByRole("button", { name: "Save invoice" }).click(),
  ]);
  await expect(page.getByRole("status")).toHaveText("Invoice recorded. 1 tyre priced.");

  // Priced: the register's flag flips, and no cost control is offered for a
  // second submission (D5/TY013: a correction later is a decision this
  // surface does not take).
  await page.goto("/fleet/tyres");
  await expect(row.getByText("No", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "Price it on its receipt" })).toHaveCount(0);

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
// catalogue entries and new tread, is rated, so the register shows a cost
// per mm where an unrated tyre shows a dash. Sandbox has no price list, so
// the typed price is an invoice price (FR-CFG-041).
test("a priced receive through the pickers is rated on the register", async ({ page }) => {
  await page.goto("/fleet/tyres/new");
  await page.getByLabel(/quantity/i).fill("1");
  await page.getByLabel("Size", { exact: true }).selectOption({ label: SANDBOX_SIZE });
  await page.getByLabel("Pattern", { exact: true }).selectOption({ label: SANDBOX_PATTERN });
  await page.getByLabel("New tread (mm)").fill("25.0");
  await page.getByLabel("Unit price").fill("4319.91");
  await expect(page.getByText("This is an invoice price.")).toBeVisible();
  await Promise.all([
    posted(page, /^\/api\/tyres$/),
    page.getByRole("button", { name: /^receive$/i }).click(),
  ]);
  const issuedCode = page.getByRole("status").getByRole("listitem");
  await expect(issuedCode).toHaveText(/^SBX-\d{5}$/);
  const displayCode = ((await issuedCode.textContent()) ?? "").trim();

  await page.goto("/fleet/tyres");
  // allTextContents does not wait, so the table must be on screen first.
  await expect(page.getByRole("columnheader", { name: "Cost per mm", exact: true })).toBeVisible();
  const columns = await page.getByRole("columnheader").allTextContents();
  const rateColumn = columns.indexOf("Cost per mm");
  expect(rateColumn).toBeGreaterThan(0);
  // The code is a row header, which getByRole("cell") skips, so the cells
  // run one index behind the headers (fitments.spec.ts).
  const row = page.getByRole("row", { name: new RegExp(displayCode) });
  // Appendix E's 4319.91 over (25.0 - 4.0) mm, the figure suite section 7
  // pins, at Sandbox's seeded 4.0 threshold: a literal, so a wrong rate
  // fails here, not only a missing one.
  await expect(row.getByRole("cell").nth(rateColumn - 1)).toHaveText("R205.7100");
});
