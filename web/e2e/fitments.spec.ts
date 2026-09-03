import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";

// TYRE-92/93/94's fitment surface, end to end on Sandbox Fleet (never BAC —
// BAC's rows are the Appendix E/J acceptance fixture, TYRE-80) as the Sandbox
// controller, who holds ManageAssets and LogRetread and so reaches every
// write on this path: receive stock, fit a trailer and a horse, rotate,
// remove, dispatch a casing to the retreader, log its return, then park and
// dispose the unit.
//
// One continuous test, serial like admin.spec.ts: each step reads what the
// step before it wrote, and these are writes into one shared database. The
// run disposes of Sandbox horse sbveh1 along the way, so `make e2e`'s own
// db-reset before this project runs is load-bearing — no other spec in this
// suite references sbveh1.
test.describe.configure({ mode: "serial" });

// Ids are md5-derived in db/seeds/gen_seed_fixture.py, so they survive a
// reseed: md5('sbcontroller1'), md5('sbveh1') (fleet HORSE, SBX001GP, a
// 6x4 truck tractor that records an odometer) and md5('sbveh2') (fleet
// LINK6, SBX002GP, a 2-axle trailer that does not).
const TENANT = "33333333-3333-3333-3333-333333333333";
const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
const HORSE = "e66c342e-9472-65ce-752d-78b4035c4ec0";
const TRAILER = "a8f398e2-2ede-a028-986b-22b86f1d36d5";

// The dev actor headers the API resolves identity from (APP_DEV_TENANT_HEADER;
// src/api/devTenant.ts is the browser's half). A raw request carries no
// localStorage, so it has to state them itself.
const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };

// The register's own read, used where a fact this flow depends on has no cell
// on any screen — the retread count, and a unit's status once VehicleList
// stops showing one.
function actorGet(page: Page, path: string): Promise<unknown> {
  return page.request.get(path, { headers: ACTOR }).then((res) => {
    expect(res.ok()).toBeTruthy();
    return res.json();
  });
}

function postedResponse(page: Page, path: RegExp) {
  return page.waitForResponse(
    (res) => path.test(new URL(res.url()).pathname) && res.request().method() === "POST",
  );
}

function posted(page: Page, path: RegExp): Promise<unknown> {
  return postedResponse(page, path).then((res) => {
    // actorGet's own check: without it, a step chained under this promise
    // could pass on a 422 refusal as readily as on a real write.
    expect(res.ok()).toBeTruthy();
    return res;
  });
}

// For the calls this suite expects to come back refused (the future-dated
// dispatch and INV-2's still-fitted check): posted()'s res.ok() assertion
// would fail them before the refusal's own text is ever read, and asserting
// the refusal here keeps a step that unexpectedly succeeds from passing.
function postedRefusal(page: Page, path: RegExp): Promise<unknown> {
  return postedResponse(page, path).then((res) => {
    expect(res.ok()).toBeFalsy();
    return res;
  });
}

function panel(page: Page, positionCode: string) {
  return page.getByRole("region", { name: `Position ${positionCode}` });
}

// UnitPlan draws the mounted positions inside their axle groups and the
// spares in a group of their own, so an axle group's buttons are exactly the
// non-spare ones. The codes are read rather than assumed: a fleet's axle
// configurations are tenant data (FR-VEH-002), and the two units here answer
// to different ones.
async function mountedPositions(page: Page): Promise<{ id: string; code: string }[]> {
  const buttons = page
    .getByRole("group", { name: "Unit plan view" })
    .getByRole("group", { name: /^Axle / })
    .locator("[data-position-id]");
  await expect(buttons.first()).toBeVisible();
  const found: { id: string; code: string }[] = [];
  for (const button of await buttons.all()) {
    const label = (await button.getAttribute("aria-label")) ?? "";
    found.push({
      id: (await button.getAttribute("data-position-id")) ?? "",
      // UnitPlan states occupancy in the label as `Position {code}: {occupant}`.
      code: label.replace(/^Position /, "").replace(/:.*$/, ""),
    });
  }
  return found;
}

test.beforeEach(async ({ page }) => {
  await actAsUser(page, CONTROLLER);
});

test("a controller fits, rotates, removes, dispatches, retreads and disposes", async ({ page }) => {
  // Sandbox seeds no tyres, so the flow buys its own stock first. Three, and
  // the codes the platform issues are captured here because a GENERATED
  // policy (D12) means nothing downstream can name a tyre the operator chose.
  await page.goto("/fleet/tyres/new");
  await page.getByLabel(/quantity/i).fill("3");
  await Promise.all([
    posted(page, /^\/api\/tyres$/),
    page.getByRole("button", { name: /^receive$/i }).click(),
  ]);
  const issued = page.getByRole("status").getByRole("listitem");
  await expect(issued).toHaveCount(3);
  const [stockA, stockB, stockC] = (await issued.allTextContents()).map((t) => t.trim());

  // The unit list is the way into a unit (D7), so the trailer is reached by
  // the row link rather than by typing its id.
  await page.goto("/fleet");
  await page.getByRole("link", { name: /SBX002GP/ }).click();
  await expect(page).toHaveURL(new RegExp(TRAILER));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("LINK6");

  const trailerPositions = await mountedPositions(page);
  const [trailerFirst] = trailerPositions;
  await page.locator(`[data-position-id="${trailerFirst.id}"]`).click();
  const trailerPanel = panel(page, trailerFirst.code);
  await expect(trailerPanel.getByRole("combobox", { name: "Tyre" })).toBeVisible();
  // TY009's converse: a trailer carries no odometer, so the fit form must not
  // ask for one. Asserted against a form that has already rendered its tyre
  // picker, so an absent field cannot mean an absent form.
  await expect(trailerPanel.getByLabel("Odometer")).toHaveCount(0);

  await trailerPanel.getByRole("combobox", { name: "Tyre" }).selectOption({ label: stockA });
  await trailerPanel.getByLabel("Tread (mm)").fill("14");
  // CHG-010: which sidewall carries the manufacturer's mark is a fact about
  // the mounting, recorded at the fit. Inboard, not outboard: PositionPanel
  // defaults to MOUNT_ORIENTATIONS[0] (mark outboard), so checking that one
  // would leave the form exactly as it was found and prove nothing about the
  // control — the read-back at the closed leg below is what it earns.
  await trailerPanel.getByRole("radio", { name: "Mark inboard" }).check();
  await Promise.all([
    posted(page, new RegExp(`^/api/vehicles/${TRAILER}/fitments$`)),
    trailerPanel.getByRole("button", { name: "Fit tyre" }).click(),
  ]);
  await expect(
    trailerPanel.getByText(`${stockA} was fitted to ${trailerFirst.code}.`, { exact: true }),
  ).toBeVisible();
  // app.fit_tyre's three advisories are all silent here — no size is recorded
  // on received stock, the casing is new, and the dual mate is empty — so a
  // warning on this fit would mean a rule fired on absence (FR-FIT-005).
  await expect(page.getByRole("status", { name: "Warnings" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: `Position ${trailerFirst.code}: ${stockA}`, exact: true }),
  ).toBeVisible();

  await page.goto("/fleet");
  await page.getByRole("link", { name: /SBX001GP/ }).click();
  await expect(page).toHaveURL(new RegExp(HORSE));
  const horsePositions = await mountedPositions(page);
  const [horseFirst, horseSecond] = horsePositions;

  for (const [position, code] of [
    [horseFirst, stockB],
    [horseSecond, stockC],
  ] as const) {
    await page.locator(`[data-position-id="${position.id}"]`).click();
    const horsePanel = panel(page, position.code);
    await horsePanel.getByRole("combobox", { name: "Tyre" }).selectOption({ label: code });
    await horsePanel.getByLabel("Tread (mm)").fill("16");
    await horsePanel.getByLabel("Odometer").fill("250100");
    await Promise.all([
      posted(page, new RegExp(`^/api/vehicles/${HORSE}/fitments$`)),
      horsePanel.getByRole("button", { name: "Fit tyre" }).click(),
    ]);
    // Proof the fit landed, position by position: the plan names each
    // position's occupant, and RotateForm below builds its rows from the same
    // read, so both fitments have to be visible here before a rotation can
    // pick them up.
    await expect(
      page.getByRole("button", { name: `Position ${position.code}: ${code}`, exact: true }),
    ).toBeVisible();
  }

  // FR-FIT-010: one set of moves, applied whole. Targets are named by
  // position id rather than by code, which is what the select carries.
  //
  // Every name here is matched exactly: the horse's codes run to 10, so a
  // non-exact "Rotate 1" would resolve to positions 1 and 10 together and
  // fail Playwright's strict mode outright, never quietly act on the wrong
  // row. Position 10 carries nothing in this flow, so exact is a guard
  // against a fixture that grows, not a fix for a failure seen here.
  const rotate = page.getByRole("region", { name: "Rotate" });
  await rotate.getByRole("checkbox", { name: `Rotate ${horseFirst.code}`, exact: true }).check();
  await rotate.getByRole("checkbox", { name: `Rotate ${horseSecond.code}`, exact: true }).check();
  await rotate
    .getByRole("combobox", { name: `Target for ${horseFirst.code}`, exact: true })
    .selectOption(horseSecond.id);
  await rotate
    .getByRole("combobox", { name: `Target for ${horseSecond.code}`, exact: true })
    .selectOption(horseFirst.id);
  await rotate.getByLabel(`Tread for ${horseFirst.code}`, { exact: true }).fill("15");
  await rotate.getByLabel(`Tread for ${horseSecond.code}`, { exact: true }).fill("15");
  // Scoped to the rotate section: the position panel offers an odometer of
  // its own, and the unit has one reading at the moment of the rotation.
  await rotate.getByLabel("Odometer").fill("251000");
  await Promise.all([
    posted(page, new RegExp(`^/api/vehicles/${HORSE}/rotations$`)),
    rotate.getByRole("button", { name: "Rotate" }).click(),
  ]);
  await expect(rotate.getByText("The rotation was applied.", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("button", { name: `Position ${horseFirst.code}: ${stockC}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Position ${horseSecond.code}: ${stockB}`, exact: true }),
  ).toBeVisible();

  // CR-012: the closed legs carry a distance and where it came from, together
  // in one cell. 900 km is 251000 less the 250100 both were fitted at, and it
  // is measured because the horse records an odometer.
  // Keyed on the Reason cell, not on the row's text: "rotation" appearing
  // anywhere in a row would be satisfied by a column this assertion is not
  // about.
  const rotated = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "rotation", exact: true }) });
  await expect(rotated).toHaveCount(2);
  for (const code of [stockB, stockC]) {
    await expect(rotated.filter({ hasText: code })).toContainText("900 km (Measured)");
  }

  // FR-FIT-008: the reasons a removal may state are tenant configuration.
  await page.goto(`/fleet/units/${TRAILER}`);
  await page.locator(`[data-position-id="${trailerFirst.id}"]`).click();
  const removalPanel = panel(page, trailerFirst.code);
  await removalPanel.getByRole("combobox", { name: "Reason" }).selectOption("damage");
  await removalPanel.getByLabel("Tread (mm)").fill("12");
  await Promise.all([
    posted(page, /^\/api\/fitments\/[^/]+\/remove$/),
    removalPanel.getByRole("button", { name: "Remove tyre" }).click(),
  ]);
  await expect(
    removalPanel.getByText(`${stockA} was removed from ${trailerFirst.code}.`, { exact: true }),
  ).toBeVisible();
  // CR-012 again, from the other side: a trailer's leg has no odometer to
  // difference, so the cell states the absence rather than a number.
  const trailerLeg = page.getByRole("row").filter({ hasText: stockA });
  await expect(trailerLeg.getByRole("cell", { name: "Unavailable", exact: true })).toBeVisible();
  // CHG-010, read back off the closed leg: the orientation picked at the fit
  // is a fact about the mounting the register keeps, so the radio is worth
  // exercising only if something downstream shows what it recorded.
  await expect(trailerLeg.getByRole("cell", { name: "Mark inboard", exact: true })).toBeVisible();

  await page.goto("/fleet/tyres");
  const casingA = page.getByRole("row").filter({ hasText: stockA });
  await expect(casingA.getByRole("cell", { name: "REMOVED", exact: true })).toBeVisible();
  await Promise.all([
    posted(page, /^\/api\/tyres\/[^/]+\/return$/),
    casingA.getByRole("button", { name: "Return to stock" }).click(),
  ]);
  await expect(
    page.getByText(`Tyre ${stockA} was returned to stock.`, { exact: true }),
  ).toBeVisible();
  await expect(casingA.getByRole("cell", { name: "IN_STOCK", exact: true })).toBeVisible();
  // U1/U2's UI contract: a dispatch is from REMOVED only, and a casing that
  // is back in stock is neither returned again nor sent anywhere — the row
  // offers the one write app.dispose_tyre would accept from this state.
  await expect(casingA.getByRole("radiogroup", { name: "Destination" })).toHaveCount(0);
  await expect(casingA.getByRole("button", { name: "Return to stock" })).toHaveCount(0);
  await expect(casingA.getByRole("combobox", { name: `Disposal for ${stockA}` })).toBeVisible();

  // The rotation left this casing on the horse's second position.
  await page.goto(`/fleet/units/${HORSE}`);
  await page.locator(`[data-position-id="${horseSecond.id}"]`).click();
  const wornPanel = panel(page, horseSecond.code);
  await wornPanel.getByRole("combobox", { name: "Reason" }).selectOption("worn_to_threshold");
  await wornPanel.getByLabel("Tread (mm)").fill("5");
  await wornPanel.getByLabel("Odometer").fill("251500");
  await Promise.all([
    posted(page, /^\/api\/fitments\/[^/]+\/remove$/),
    wornPanel.getByRole("button", { name: "Remove tyre" }).click(),
  ]);
  await expect(
    wornPanel.getByText(`${stockB} was removed from ${horseSecond.code}.`, { exact: true }),
  ).toBeVisible();

  // FR-FIT-011: a removed casing goes to the retreader. The depot picker
  // offers only depots app.dispatch_tyre would accept for the destination, so
  // the list is waited for rather than assumed.
  await page.goto("/fleet/tyres");
  const casingB = page.getByRole("row").filter({ hasText: stockB });
  await expect(casingB.getByRole("cell", { name: "REMOVED", exact: true })).toBeVisible();
  await Promise.all([
    page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/depots" && res.request().method() === "GET",
    ),
    casingB.getByRole("radio", { name: "Retreader", exact: true }).check(),
  ]);
  await casingB
    .getByRole("combobox", { name: `Depot for ${stockB}` })
    .selectOption({ label: "Sandbox Retreaders" });

  // 000033's own future-date guard, rendered verbatim (ADR-0012): a sentOn
  // ahead of the tenant's own today is refused as TY014, never silently
  // clamped. A fixed far-future date, not the browser's tomorrow: the guard
  // compares against app.tenant_today (Africa/Johannesburg), which is already
  // tomorrow's date for the last two UTC hours of every day, so a UTC-derived
  // "tomorrow" would be accepted as today in that window.
  await casingB.getByLabel("Sent on").fill("2999-01-01");
  await Promise.all([
    postedRefusal(page, /^\/api\/tyres\/[^/]+\/dispatch$/),
    casingB.getByRole("button", { name: "Dispatch" }).click(),
  ]);
  await expect(casingB.getByRole("alert")).toHaveText(
    "a casing is sent on or before today, never on a future date",
  );

  // Sent on is left at its default so app.dispatch_tyre stamps the tenant's
  // own today (rule 6) rather than a date read off the browser clock.
  await casingB.getByLabel("Sent on").fill("");
  await Promise.all([
    posted(page, /^\/api\/tyres\/[^/]+\/dispatch$/),
    casingB.getByRole("button", { name: "Dispatch" }).click(),
  ]);
  await expect(
    page.getByText(`Tyre ${stockB} was sent to the retreader.`, { exact: true }),
  ).toBeVisible();
  await expect(casingB.getByRole("cell", { name: "AT_RETREADER", exact: true })).toBeVisible();
  await expect(
    casingB.getByRole("cell", {
      name: "At the retreader — log the return under Retreads",
      exact: true,
    }),
  ).toBeVisible();

  await page.goto("/fleet/tyres/retreads");
  const job = page.getByRole("row").filter({ hasText: stockB });
  await expect(job.getByRole("cell", { name: "Sandbox Retreaders", exact: true })).toBeVisible();
  // A casing dispatched today has been out zero days, read from the column
  // its own header names rather than from whichever cell happens to hold a
  // "0". The queue's first column is the display code as a row header, which
  // getByRole("cell") does not return, so the header list runs one ahead of
  // the cells beside it; a column added anywhere still resolves correctly.
  const columns = await page.getByRole("columnheader").allTextContents();
  const daysOut = columns.indexOf("Days out");
  expect(daysOut).toBeGreaterThan(0);
  // "0" or "1", never asserted equal: the dispatch above and this read both
  // take the tenant's civil today, but a run straddling the tenant's midnight
  // between the two calls can tick that day over once (TYRE-121).
  await expect(job.getByRole("cell").nth(daysOut - 1)).toHaveText(/^[01]$/);

  // The returned-on date comes from the job the dispatch opened, which the
  // API carries as the tenant's own civil date: a date typed from this
  // process's clock would be a day out whenever the two disagree (rule 6).
  const openJobs = (await actorGet(page, "/api/retread-jobs?open=true")) as {
    displayCode: string;
    sentAt: string;
  }[];
  const sentOn = openJobs.find((j) => j.displayCode === stockB)?.sentAt ?? "";
  expect(sentOn).not.toEqual("");

  await job.getByRole("radio", { name: "Accepted" }).check();
  await job.getByLabel(`Report reference for ${stockB}`).fill("RT-1");
  await job.getByLabel(`Returned on for ${stockB}`).fill(sentOn);
  await job.getByLabel(`Retread cost for ${stockB}`).fill("2500.00");
  await job.getByLabel(`Post-tread for ${stockB}`).fill("16");
  await job.getByLabel(`Casing value for ${stockB}`).fill("800");
  await Promise.all([
    posted(page, /^\/api\/retread-jobs\/[^/]+\/return$/),
    job.getByRole("button", { name: "Log return" }).click(),
  ]);
  await expect(
    page.getByText(`The return for ${stockB} was logged.`, { exact: true }),
  ).toBeVisible();

  // An accepted casing comes back as stock, not as a fitted tyre. The count
  // itself has no cell on the register, so BR-FIT-009's cap — the reason a
  // count is kept at all — is checked against the read the screen renders.
  await page.goto("/fleet/tyres");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: stockB })
      .getByRole("cell", { name: "IN_STOCK", exact: true }),
  ).toBeVisible();
  const register = (await actorGet(page, "/api/tyres")) as {
    tyres: { displayCode: string; retreadCount: number }[];
  };
  expect(register.tyres.find((t) => t.displayCode === stockB)?.retreadCount).toBe(1);

  // FR-VEH-006: parking a unit stops it being issued inspection tasks. No
  // task schedule is seeded on Sandbox, so the status itself is the claim
  // this can check, on screen and in the read behind it.
  await page.goto(`/fleet/units/${HORSE}`);
  const statusForm = page.getByRole("region", { name: "Status" });
  await statusForm.getByRole("combobox", { name: "Status" }).selectOption("PARKED");
  await Promise.all([
    posted(page, new RegExp(`^/api/vehicles/${HORSE}/status$`)),
    statusForm.getByRole("button", { name: "Set status" }).click(),
  ]);
  await expect(statusForm.getByText("The status was changed.", { exact: true })).toBeVisible();
  // The select's value is the form's own state, seeded once from the unit and
  // never re-read, so the confirmation and the unit read are what can say the
  // status actually moved.
  expect((await actorGet(page, `/api/vehicles/${HORSE}`)) as { status: string }).toMatchObject({
    status: "PARKED",
  });

  // INV-2: the unit is empty at the moment it is disposed, and the refusal
  // counts what is still on it. app.set_vehicle_status' sentence is rendered
  // verbatim (ADR-0012), so it is pinned verbatim here.
  await statusForm.getByRole("combobox", { name: "Status" }).selectOption("DISPOSED");
  await statusForm.getByLabel("Reason").fill("sold at auction");
  await Promise.all([
    postedRefusal(page, new RegExp(`^/api/vehicles/${HORSE}/status$`)),
    statusForm.getByRole("button", { name: "Set status" }).click(),
  ]);
  await expect(statusForm.getByRole("alert")).toHaveText(
    "this unit still has fitted tyres (1); they come off before it is disposed",
  );

  await page.locator(`[data-position-id="${horseFirst.id}"]`).click();
  const lastPanel = panel(page, horseFirst.code);
  await lastPanel.getByRole("combobox", { name: "Reason" }).selectOption("vehicle_disposal");
  await lastPanel.getByLabel("Tread (mm)").fill("10");
  await lastPanel.getByLabel("Odometer").fill("252000");
  await Promise.all([
    posted(page, /^\/api\/fitments\/[^/]+\/remove$/),
    lastPanel.getByRole("button", { name: "Remove tyre" }).click(),
  ]);
  await expect(
    lastPanel.getByText(`${stockC} was removed from ${horseFirst.code}.`, { exact: true }),
  ).toBeVisible();

  // A precondition on the control, not a claim about the server: the refused
  // submit and the removal that followed both leave the form mounted, and
  // this click means nothing unless it is still sending DISPOSED.
  await expect(statusForm.getByRole("combobox", { name: "Status" })).toHaveValue("DISPOSED");
  await Promise.all([
    posted(page, new RegExp(`^/api/vehicles/${HORSE}/status$`)),
    statusForm.getByRole("button", { name: "Set status" }).click(),
  ]);
  await expect(statusForm.getByText("The status was changed.", { exact: true })).toBeVisible();
  await expect(statusForm.getByRole("alert")).toHaveCount(0);
  // VehicleList renders no status, so the disposal is confirmed against the
  // unit read rather than against a cell that does not exist.
  expect((await actorGet(page, `/api/vehicles/${HORSE}`)) as { status: string }).toMatchObject({
    status: "DISPOSED",
  });
});
