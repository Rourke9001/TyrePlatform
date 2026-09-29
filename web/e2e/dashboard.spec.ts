import { expect, test } from "@playwright/test";

import { actAsPieter } from "./bac";

// CLAUDE.md, Testing: the web leg of the three-way agreement. Each figure
// is the literal the suite pins, so a leg that moves alone fails here.

// docs/lessons.md, 2026-09-03: the fixture's figures hold on any day, so no
// assertion here reads a date off the clock.
test("the dashboard renders the Appendix J figures the suite pins", async ({ page }) => {
  await actAsPieter(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  // H.3 criterion 6: the rand figure, with its provenance disclosed.
  const hero = page.locator("[data-requirement='FR-DSH-017']");
  await expect(hero.getByText("R16,537.50", { exact: true })).toBeVisible();
  await expect(hero).toContainText("of which 9 audit");
  await expect(hero).toContainText("Spares: R1,837.50 from 1 tyre");

  // H.3 criterion 5: 19, 11 and 9, each on the tile that answers its FR.
  const open = page.locator("[data-requirement='FR-DSH-003']");
  await expect(open.getByText("19", { exact: true })).toBeVisible();
  // H.3 criterion 5: the 11 must fail on any other number, and a bare
  // "11 urgent" is a substring of "111 urgent". innerText, because the
  // tile's text content runs the 19 straight into the 11.
  await expect(open).toContainText(/(^|\D)11 urgent/, { useInnerText: true });
  await expect(open).toContainText("as inspected");

  const below = page.locator("[data-requirement='FR-DSH-004']");
  await expect(below.getByText("9", { exact: true })).toBeVisible();
  await expect(below).toContainText("today");
});

test("the exceptions list carries the same 19, and 11 of them critical", async ({ page }) => {
  await actAsPieter(page);
  await page.goto("/exceptions");
  await expect(page.getByText("19 exceptions, as inspected")).toBeVisible();
  const rows = page.getByRole("table", { name: "Exceptions" }).getByRole("row");
  await expect(rows).toHaveCount(20);

  await page.goto("/exceptions?severity=CRITICAL");
  await expect(page.getByText("11 exceptions, as inspected")).toBeVisible();
});

test("the at-risk list carries the nine running tyres and the spare", async ({ page }) => {
  await actAsPieter(page);
  await page.goto("/at-risk");
  const rows = page
    .getByRole("table", { name: "Tyres at or below the removal threshold" })
    .getByRole("row");
  await expect(rows).toHaveCount(11);
  await expect(page.getByRole("article", { name: "Running" })).toContainText("R16,537.50");
});
