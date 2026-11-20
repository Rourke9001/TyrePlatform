import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MyTask } from "../driver/driver.data";
import { formatTenantDate } from "../time/tenantTime";
import { renderWithActor } from "../test/fixtures";
import { TaskPick } from "./TaskPick";

const DUE = "2026-11-21T21:59:59Z";
const a: MyTask = {
  id: "a",
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  dueAt: DUE,
  state: "OPEN",
  overdue: false,
};
const towed: MyTask = {
  ...a,
  id: "kt",
  vehicleId: "v2",
  fleetNumber: "BAC711TR",
  captureVehicleId: "v1",
  overdue: true,
};

function renderPick(tasks: readonly MyTask[]) {
  return renderWithActor(<TaskPick tasks={tasks} />, {
    withRouter: true,
    actor: { timezone: "Asia/Kolkata" },
  });
}

describe("TaskPick", () => {
  it("asks for a choice and lists each task as My inspections does, in the order given", () => {
    const day = formatTenantDate(DUE, "Asia/Kolkata");
    // The date must come from the tenant zone, so the zones must disagree.
    for (const zone of ["UTC", "Africa/Johannesburg"]) {
      expect(day).not.toBe(formatTenantDate(DUE, zone));
    }
    renderPick([towed, a]);
    expect(
      screen.getByText("More than one inspection is due on this vehicle. Choose the one to start."),
    ).toBeInTheDocument();
    const rows = screen
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.startsWith("/capture/"));
    expect(rows.map((r) => r.textContent)).toEqual([
      `BAC711TR, due ${day} (overdue)`,
      `BAC039SP, due ${day}`,
    ]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/capture/v1?taskId=kt",
      "/capture/v1?taskId=a",
    ]);
  });

  it("offers the way back to My inspections", () => {
    renderPick([a, towed]);
    expect(screen.getByRole("link", { name: "My inspections" })).toHaveAttribute("href", "/my");
  });
});
