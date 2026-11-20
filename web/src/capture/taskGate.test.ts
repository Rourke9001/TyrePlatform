import { describe, expect, it } from "vitest";

import type { MyTask } from "../driver/driver.data";
import { citedTask, gateFor, openForUnit, taskPath, type GateDraft } from "./taskGate";

function task(overrides: Partial<MyTask> & { id: string }): MyTask {
  return {
    vehicleId: "v1",
    fleetNumber: "BAC039SP",
    dueAt: "2026-11-21T21:59:59Z",
    state: "OPEN",
    overdue: false,
    ...overrides,
  };
}

const k1 = task({ id: "k1" });
const k2 = task({ id: "k2" });
// A towed unit's task, captured through the motive v1.
const k3 = task({ id: "k3", vehicleId: "v2", fleetNumber: "BAC711TR", captureVehicleId: "v1" });

// An unrelated unit's task.
const k9 = task({ id: "k9", vehicleId: "v9" });

const held: GateDraft = { vehicleId: "v1", taskId: "k1", observedMemberVehicleIds: ["v1", "v2"] };

describe("taskPath", () => {
  it("is the task's capture unit with the task named", () => {
    expect(taskPath(k1)).toBe("/capture/v1?taskId=k1");
    expect(taskPath(k3)).toBe("/capture/v1?taskId=k3");
  });
});

describe("openForUnit", () => {
  it("finds a listed task captured through this unit, by the task's own unit or its capture unit", () => {
    expect(openForUnit([k1, k3], "k1", "v1")).toBe(k1);
    expect(openForUnit([k1, k3], "k3", "v1")).toBe(k3);
    expect(openForUnit([k1, k3], "k3", "v2")).toBeUndefined();
    expect(openForUnit([k1], "k9", "v1")).toBeUndefined();
    expect(openForUnit([k1], null, "v1")).toBeUndefined();
  });
});

describe("gateFor", () => {
  it("row 1: a link to an open task for this unit starts", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k1", draft: null, tasks: [k1] })).toEqual({
      kind: "start",
      task: k1,
    });
  });

  it("a link with no task waits on a pending read", () =>
    expect(gateFor({ unit: "v1", linkTaskId: null, draft: null, tasks: "pending" })).toEqual({
      kind: "loading",
    }));

  it("row 2a: no link task and one open task for this unit starts it, an unrelated unit's not counted", () => {
    expect(gateFor({ unit: "v1", linkTaskId: null, draft: null, tasks: [k1, k9] })).toEqual({
      kind: "start",
      task: k1,
    });
    expect(gateFor({ unit: "v1", linkTaskId: null, draft: null, tasks: [k3] })).toEqual({
      kind: "start",
      task: k3,
    });
  });

  it("row 2a: a link task that is not usable stands aside for the one task", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k9", draft: null, tasks: [k1] })).toEqual({
      kind: "start",
      task: k1,
    });
    const elsewhere = task({ id: "kx", vehicleId: "v8", captureVehicleId: "v9" });
    expect(gateFor({ unit: "v1", linkTaskId: "kx", draft: null, tasks: [elsewhere, k1] })).toEqual({
      kind: "start",
      task: k1,
    });
  });

  it("row 2d: a coupled trailer's address with its one task forwards to it, named or not", () => {
    expect(gateFor({ unit: "v2", linkTaskId: null, draft: null, tasks: [k3] })).toEqual({
      kind: "forward",
      task: k3,
    });
    expect(gateFor({ unit: "v2", linkTaskId: "k3", draft: null, tasks: [k3] })).toEqual({
      kind: "forward",
      task: k3,
    });
  });

  it("row 2b: several tasks for the unit are picked, earliest due first, ties in list order", () => {
    const late = task({ id: "late", dueAt: "2026-12-02T21:59:59Z" });
    // k1 and k3 share a due time, k1 listed first.
    expect(
      gateFor({ unit: "v1", linkTaskId: null, draft: null, tasks: [late, k1, k9, k3] }),
    ).toEqual({ kind: "pick", tasks: [k1, k3, late] });
    expect(gateFor({ unit: "v1", linkTaskId: "k9", draft: null, tasks: [late, k1] })).toEqual({
      kind: "pick",
      tasks: [k1, late],
    });
  });

  it("row 2b: a coupled trailer's address with several of its tasks", () => {
    const k4 = task({
      id: "k4",
      vehicleId: "v2",
      captureVehicleId: "v1",
      dueAt: "2026-12-02T21:59:59Z",
    });
    expect(gateFor({ unit: "v2", linkTaskId: null, draft: null, tasks: [k4, k3] })).toEqual({
      kind: "pick",
      tasks: [k3, k4],
    });
  });

  it("row 2c: nothing due when no listed task is for this unit", () => {
    expect(gateFor({ unit: "v1", linkTaskId: null, draft: null, tasks: [] })).toEqual({
      kind: "nothing-due",
    });
    expect(gateFor({ unit: "v1", linkTaskId: "k9", draft: null, tasks: [k9] })).toEqual({
      kind: "nothing-due",
    });
  });

  it("row 3: a failed read with no copy, link or not", () => {
    for (const linkTaskId of ["k1", null]) {
      expect(gateFor({ unit: "v1", linkTaskId, draft: null, tasks: "failed" })).toEqual({
        kind: "tasks-failed",
      });
    }
  });

  it("waits while the read is pending and a link task needs checking", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k1", draft: null, tasks: "pending" })).toEqual({
      kind: "loading",
    });
  });

  it("row 4: the draft's own task or no link resumes, even while the read is pending", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k1", draft: held, tasks: "pending" })).toEqual({
      kind: "resume",
    });
    expect(gateFor({ unit: "v1", linkTaskId: null, draft: held, tasks: "pending" })).toEqual({
      kind: "resume",
    });
  });

  it("row 5: an open task for this unit on a unit the draft covers offers the choice", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k2", draft: held, tasks: [k1, k2] })).toEqual({
      kind: "choose",
      task: k2,
    });
    expect(gateFor({ unit: "v1", linkTaskId: "k3", draft: held, tasks: [k3] })).toEqual({
      kind: "choose",
      task: k3,
    });
  });

  it("row 6: anything else resumes", () => {
    // Not listed.
    expect(gateFor({ unit: "v1", linkTaskId: "k2", draft: held, tasks: [k1] })).toEqual({
      kind: "resume",
    });
    // A towed unit the draft does not cover.
    const solo: GateDraft = { vehicleId: "v1", taskId: "k1", observedMemberVehicleIds: ["v1"] };
    expect(gateFor({ unit: "v1", linkTaskId: "k3", draft: solo, tasks: [k3] })).toEqual({
      kind: "resume",
    });
    // A failed read.
    expect(gateFor({ unit: "v1", linkTaskId: "k2", draft: held, tasks: "failed" })).toEqual({
      kind: "resume",
    });
  });

  it("waits on a different link task while the read is pending", () => {
    expect(gateFor({ unit: "v1", linkTaskId: "k2", draft: held, tasks: "pending" })).toEqual({
      kind: "loading",
    });
  });
});

describe("citedTask", () => {
  const towed = task({
    id: "kt",
    vehicleId: "v2",
    fleetNumber: "BAC711TR",
    captureVehicleId: "v1",
    dueAt: "2026-12-02T21:59:59Z",
  });

  it("case 1: the link's task when its own unit is ticked", () => {
    expect(
      citedTask({ linkTask: towed, tasks: [k1, towed], unit: "v1", ticked: ["v1", "v2"] }),
    ).toBe(towed);
  });

  it("Review Focus 3: the link's task beats an earlier-due one", () => {
    const later = task({ id: "later", dueAt: "2026-12-02T21:59:59Z" });
    const earlier = task({ id: "earlier", dueAt: "2026-11-21T21:59:59Z" });
    expect(
      citedTask({ linkTask: later, tasks: [earlier, later], unit: "v1", ticked: ["v1"] }),
    ).toBe(later);
  });

  it("case 2: otherwise the earliest-due ticked task captured through this unit", () => {
    const first = task({ id: "first", dueAt: "2026-11-25T21:59:59Z" });
    const second = task({ id: "second", dueAt: "2026-11-23T21:59:59Z" });
    const unticked = task({
      id: "unticked",
      vehicleId: "v3",
      captureVehicleId: "v1",
      dueAt: "2026-11-01T21:59:59Z",
    });
    const elsewhere = task({
      id: "elsewhere",
      captureVehicleId: "v9",
      dueAt: "2026-11-02T21:59:59Z",
    });
    expect(
      citedTask({
        linkTask: towed,
        tasks: [first, second, unticked, elsewhere, towed],
        unit: "v1",
        ticked: ["v1"],
      }),
    ).toBe(second);
  });

  it("case 2: the first in list order on a tie", () => {
    const a = task({ id: "a" });
    const b = task({ id: "b" });
    expect(citedTask({ linkTask: towed, tasks: [a, b], unit: "v1", ticked: ["v1"] })).toBe(a);
  });

  it("case 3: nothing ticked carries a task", () => {
    expect(
      citedTask({ linkTask: towed, tasks: [towed], unit: "v1", ticked: ["v1"] }),
    ).toBeUndefined();
  });
});
