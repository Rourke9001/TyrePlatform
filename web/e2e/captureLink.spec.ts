import { expect, test, type Page } from "@playwright/test";

import { actAsUser } from "./admin";
import { captureAll, done, onScreen, startHere, startInspection, submit } from "./captureSteps";
import {
  apiGet,
  apiPost,
  configFor,
  createUnit,
  DRIVER_ACTOR,
  nominateSandboxDriver,
  SANDBOX_DRIVER,
  TENANT,
  type AxleConfiguration,
} from "./sandbox";

// A capture link with no usable task (TYRE-491, U245), judged at phone size:
// the ticket asks for the choice screen on both phones. Sandbox Fleet only
// (TYRE-80). Serial for load, as auth.spec.ts says.
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString().slice(-6);
const NOTHING_DUE =
  "Nothing is due on this vehicle for you. An inspection starts from a task on My inspections.";
const PICK = "More than one inspection is due on this vehicle. Choose the one to start.";
// A literal day no run reaches, so no tenant date comes from the browser
// clock (docs/lessons.md, 2026-09-03).
const LATER = "2099-12-30";

interface Unit {
  id: string;
  fleet: string;
  taskIds: string[];
}

// One unit per test, named for the project too, so the two phones never share
// a fleet number (DR-003). Setup goes through page.request as the controller.
async function unitWithTasks(
  page: Page,
  label: string,
  dueOns: (string | undefined)[],
): Promise<Unit> {
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const fleet = `CL${label}-${test.info().project.name[0].toUpperCase()}${RUN}`;
  const id = await createUnit(page, fleet, "HORSE", configFor(configs, "HORSE_6X4"));
  const taskIds: string[] = [];
  for (const dueOn of dueOns) taskIds.push((await nominateSandboxDriver(page, id, dueOn)).id);
  return { id, fleet, taskIds };
}

test.describe("a capture link with no task (U245)", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "one set of writes and one walk prove the gate; ios buys the choice screen's viewport",
  );

  test("one open task: Start shows, the address stays, and the submit closes the task", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const unit = await unitWithTasks(page, "O", [undefined]);
    await actAsUser(page, SANDBOX_DRIVER);
    await page.goto(`/capture/${unit.id}`);

    await expect(page.getByRole("button", { name: /start inspection/i })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/capture/${unit.id}$`));
    await startHere(page);
    await captureAll(page);
    await submit(page);

    await expect(done(page)).toContainText("Inspection sent");
    const mine = (await apiGet(page, "/api/my/tasks", DRIVER_ACTOR)) as { id: string }[];
    expect(mine.map((t) => t.id)).not.toContain(unit.taskIds[0]);
    expect(await apiGet(page, `/api/vehicles/${unit.id}/inspection-tasks`)).toEqual([]);
  });

  test("two open tasks: the pick screen lists both, earliest due first, and a row leads to Start and back", async ({
    page,
  }) => {
    const unit = await unitWithTasks(page, "P", [undefined, LATER]);
    await actAsUser(page, SANDBOX_DRIVER);
    await page.goto(`/capture/${unit.id}`);

    const main = page.getByRole("main");
    const rows = main.getByRole("link", { name: new RegExp(`^${unit.fleet}, due `) });
    await expect(main.getByText(PICK)).toBeVisible();
    await expect(page.getByRole("button", { name: /start inspection/i })).toHaveCount(0);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute(
      "href",
      `/capture/${unit.id}?taskId=${unit.taskIds[0]}`,
    );
    await expect(rows.nth(1)).toHaveAttribute(
      "href",
      `/capture/${unit.id}?taskId=${unit.taskIds[1]}`,
    );

    await rows.nth(1).click();
    await expect(page).toHaveURL(new RegExp(`\\?taskId=${unit.taskIds[1]}$`));
    await expect(page.getByRole("button", { name: /start inspection/i })).toBeVisible();

    await page.goBack();
    await expect(rows).toHaveCount(2);
  });

  test("no open task on a unit the driver holds: Nothing is due", async ({ page }) => {
    const unit = await unitWithTasks(page, "N", []);
    const driver = (await apiPost(page, "/api/users", {
      email: `cl-driver-${RUN}@example.invalid`,
      displayName: `Link Driver ${RUN}`,
      role: "DRIVER",
    })) as { id: string };
    await apiPost(page, "/api/trips", {
      motiveVehicleId: unit.id,
      driverUserId: driver.id,
      addTrailers: [],
    });
    // The premise: the driver holds the unit through the trip and has no task.
    const headers = { "X-Tenant-ID": TENANT, "X-User-ID": driver.id };
    const vehicles = (await apiGet(page, "/api/my/vehicles", headers)) as { id: string }[];
    expect(vehicles.map((v) => v.id)).toContain(unit.id);
    expect(await apiGet(page, "/api/my/tasks", headers)).toEqual([]);

    await actAsUser(page, driver.id);
    await page.goto(`/capture/${unit.id}`);

    await expect(page.getByText(NOTHING_DUE)).toBeVisible();
    await expect(page.getByRole("button", { name: /start inspection/i })).toHaveCount(0);
    await expect(
      page.getByRole("main").getByRole("link", { name: "My inspections" }),
    ).toHaveAttribute("href", "/my");
  });
});

test("the choice screen keeps both controls on screen at glove size", async ({ page }) => {
  test.setTimeout(120_000);
  const unit = await unitWithTasks(page, "C", [undefined, LATER]);
  await actAsUser(page, SANDBOX_DRIVER);
  await startInspection(page, { vehicleId: unit.id, taskId: unit.taskIds[0] });
  await expect(page.getByRole("heading", { name: /^0 of \d+ done$/ })).toBeVisible();

  await page.goto(`/capture/${unit.id}?taskId=${unit.taskIds[1]}`);
  await expect(page.getByText(/The task you opened is a different one\./)).toBeVisible();
  for (const name of ["Carry on for this task", "Start again"]) {
    const box = await onScreen(page, page.getByRole("button", { name }), name);
    expect(box.height, `${name} is too short for a glove`).toBeGreaterThanOrEqual(56);
    expect(box.width, `${name} is too narrow for a glove`).toBeGreaterThanOrEqual(56);
  }
});
