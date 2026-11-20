import type { MyTask } from "../driver/driver.data";
import type { Draft } from "./draft";

// What the phone knows of the driver's open tasks: the list, a read still
// waiting, or a read that failed with no copy to fall back on.
export type TasksRead = readonly MyTask[] | "pending" | "failed";

export type GateDraft = Pick<Draft, "vehicleId" | "taskId" | "observedMemberVehicleIds">;

// The rows of the TYRE-319 spec's section 2 table.
export type Gate =
  | { kind: "loading" }
  | { kind: "start"; task: MyTask }
  | { kind: "nothing-due" }
  | { kind: "tasks-failed" }
  | { kind: "resume" }
  | { kind: "choose"; task: MyTask };

// A rig is entered through its motive, so a towed unit's task is open for
// the motive's route, not its own (000060, v_my_inspection_task).
function captureUnit(t: MyTask): string {
  return t.captureVehicleId ?? t.vehicleId;
}

export function openForUnit(
  tasks: readonly MyTask[],
  taskId: string | null,
  unit: string,
): MyTask | undefined {
  if (taskId === null) return undefined;
  return tasks.find((t) => t.id === taskId && captureUnit(t) === unit);
}

// U143 and U147 B16: a scoped actor starts only from an open task of theirs
// on this unit. The server decides who holds a task, so the gate reads only
// GET /api/my/tasks.
export function gateFor(input: {
  unit: string;
  linkTaskId: string | null;
  draft: GateDraft | null;
  tasks: TasksRead;
}): Gate {
  const { unit, linkTaskId, draft, tasks } = input;
  if (draft !== null) {
    // Row 4: a resume whose task matches never waits on the read, so it
    // works with no signal (NFR-AVL-002).
    if (linkTaskId === null || linkTaskId === draft.taskId) return { kind: "resume" };
    if (tasks === "pending") return { kind: "loading" };
    // Row 6: what the phone cannot check, the draft keeps its own task.
    if (tasks === "failed") return { kind: "resume" };
    const task = openForUnit(tasks, linkTaskId, unit);
    // Row 5 (U147 B7): only a task this draft could carry is a choice.
    if (
      task !== undefined &&
      (task.vehicleId === draft.vehicleId ||
        draft.observedMemberVehicleIds.includes(task.vehicleId))
    ) {
      return { kind: "choose", task };
    }
    return { kind: "resume" };
  }
  if (linkTaskId === null) return { kind: "nothing-due" };
  if (tasks === "pending") return { kind: "loading" };
  if (tasks === "failed") return { kind: "tasks-failed" };
  const task = openForUnit(tasks, linkTaskId, unit);
  return task === undefined ? { kind: "nothing-due" } : { kind: "start", task };
}

// The owner's answer 3 (TYRE-319 spec, section 2): the link's task when its
// unit is ticked, else the earliest-due open task on a ticked unit captured
// through this route, else none, and Start is not offered.
export function citedTask(input: {
  linkTask: MyTask | undefined;
  tasks: readonly MyTask[];
  unit: string;
  ticked: readonly string[];
}): MyTask | undefined {
  const { linkTask, tasks, unit, ticked } = input;
  if (linkTask !== undefined && ticked.includes(linkTask.vehicleId)) return linkTask;
  let best: MyTask | undefined;
  for (const t of tasks) {
    if (!ticked.includes(t.vehicleId) || captureUnit(t) !== unit) continue;
    if (best === undefined || Date.parse(t.dueAt) < Date.parse(best.dueAt)) best = t;
  }
  return best;
}
