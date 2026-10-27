import { describe, expect, it } from "vitest";

import type { MyTask, MyTrip } from "./driver.data";
import { homeView } from "./driver.view";

function task(id: string, vehicleId: string): MyTask {
  return {
    id,
    vehicleId,
    fleetNumber: vehicleId.toUpperCase(),
    dueAt: "2026-10-23T06:00:00Z",
    state: "OPEN",
    overdue: false,
  };
}

const H1 = { vehicleId: "h1", fleetNumber: "H1" };
const T1 = { vehicleId: "t1", fleetNumber: "T1" };
const T2 = { vehicleId: "t2", fleetNumber: "T2" };
const onTrip: MyTrip = { trip: { motive: H1, trailers: [T1, T2] } };
const noTrip: MyTrip = { trip: null };

// FR-DSH-012 as amended. undefined is a read that has not answered, or
// failed: the screen passes data only once its query has succeeded.
describe("the driver's home view", () => {
  it("rows the truck then each trailer, each with what is due on it", () => {
    const view = homeView([task("k2", "t2"), task("k1", "h1")], onTrip);
    expect(view.trip?.map((u) => [u.fleetNumber, u.due.map((t) => t.id)])).toEqual([
      ["H1", ["k1"]],
      ["T1", []],
      ["T2", ["k2"]],
    ]);
    expect(view.nothingDue).toBe(false);
    expect(view.ungrouped).toBeNull();
  });

  it("says nothing is due only for a trip with no task on it", () => {
    expect(homeView([task("k9", "x9")], onTrip).nothingDue).toBe(true);
    expect(homeView([], noTrip).nothingDue).toBe(false);
  });

  // Nothing is known to be due when the tasks have not loaded.
  it("rows the trip with nothing due and says nothing when the tasks are missing", () => {
    const view = homeView(undefined, onTrip);
    expect(view.trip?.map((u) => u.due)).toEqual([[], [], []]);
    expect(view.nothingDue).toBe(false);
    expect(view.nominated).toEqual([]);
  });

  it("puts a task on no unit of the trip under nominated", () => {
    const view = homeView([task("k1", "h1"), task("k9", "x9")], onTrip);
    expect(view.nominated.map((t) => t.id)).toEqual(["k9"]);
  });

  // The one tap to a task never waits on the trip read.
  it("leaves the tasks ungrouped until the trip has answered", () => {
    const tasks = [task("k1", "h1")];
    const view = homeView(tasks, undefined);
    expect(view.ungrouped).toEqual(tasks);
    expect(view.trip).toBeNull();
    expect(view.nominated).toEqual([]);
    expect(view.notOnTrip).toBe(false);
  });

  it("says the driver is not on a trip only when both reads found nothing", () => {
    expect(homeView([], noTrip).notOnTrip).toBe(true);
    expect(homeView([task("k9", "x9")], noTrip).notOnTrip).toBe(false);
    expect(homeView(undefined, noTrip).notOnTrip).toBe(false);
  });
});
