import { expect, test as setup } from "@playwright/test";

import { MELUSI_DRIVER } from "./bac";
import { assignedVehicle, CONTROLLER_HEADERS, STANDING_DUE_ON } from "./driver";

// TYRE-319: a driver's capture opens only from an open task of theirs, and
// the fixture seeds none, since a seeded task would move suite section 28.
// This plants BAC's standing task on HORSE through the API as the
// controller, once per seed: it goes to the trip driver, and every BAC
// capture that lands no submit opens through it (driver.ts, standingTask).
setup("BAC's driver holds a standing task on HORSE", async ({ request }) => {
  const horse = await assignedVehicle(request, "HORSE");
  const path = `/api/vehicles/${horse.id}/inspection-tasks`;
  const listed = await request.get(path, { headers: CONTROLLER_HEADERS });
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const tasks = (await listed.json()) as { dueAt: string }[];
  if (tasks.some((t) => t.dueAt.startsWith(STANDING_DUE_ON))) return;

  const created = await request.post(path, {
    headers: CONTROLLER_HEADERS,
    data: { dueOn: STANDING_DUE_ON },
  });
  expect(created.status(), await created.text()).toBe(201);
  const task = (await created.json()) as { responsibleUserId: string | null };
  expect(task.responsibleUserId).toBe(MELUSI_DRIVER);
});
