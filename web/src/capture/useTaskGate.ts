import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { myTasksQuery, type MyTask } from "../driver/driver.data";
import type { Draft } from "./draft";
import { gateFor, openForUnit, type Gate, type TasksRead } from "./taskGate";

const NO_TASKS: readonly MyTask[] = [];

// The phone's half of TYRE-319: which of the spec's section 2 rows the
// capture route shows, from the list "My inspections" reads. A tenant-wide
// actor is not gated.
export function useTaskGate(args: {
  vehicleId: string;
  linkTaskId: string | null;
  scoped: boolean;
  // The draft loaded from the phone for this unit, null after a Start in
  // this visit.
  resumedDraft: Draft | null;
}): {
  gate: Gate;
  tasks: readonly MyTask[];
  linkTask: MyTask | undefined;
  tasksError: unknown;
  reload: () => void;
  settle: () => void;
} {
  const { vehicleId, linkTaskId, scoped, resumedDraft } = args;
  const query = useQuery({ ...myTasksQuery(), enabled: scoped });

  // A copy kept through a failed refresh is used as it stands: the server is
  // the control (TY029), the gate only keeps a driver out of refused work.
  let read: TasksRead;
  if (query.data !== undefined) read = query.data;
  else if (query.isError) read = "failed";
  // A held draft never waits on a read that cannot answer: paused for want
  // of signal, or retrying after a failure (NFR-AVL-002, spec section 2's
  // note). With no draft a paused read stays pending, since starting needs
  // the server.
  else if (resumedDraft !== null && (query.fetchStatus === "paused" || query.failureCount > 0)) {
    read = "failed";
  } else read = "pending";
  const tasks = typeof read === "string" ? NO_TASKS : read;

  const computed: Gate = scoped
    ? gateFor({ unit: vehicleId, linkTaskId, draft: resumedDraft, tasks: read })
    : { kind: "resume" };

  // Rows 4 to 6 are decided once per vehicle and link task, so a refetch
  // that lands mid-capture never swaps the walk-around for the choice
  // screen (TYRE-319). The route keeps one CaptureFlow across a change of
  // its vehicle or task (routes.tsx), so a new key decides afresh.
  const key = `${vehicleId}|${linkTaskId ?? ""}`;
  const [latch, setLatch] = useState<{ key: string; gate: Gate } | null>(null);
  let gate = computed;
  if (resumedDraft === null) {
    if (latch !== null) setLatch(null);
  } else if (latch !== null && latch.key === key) {
    gate = latch.gate;
  } else if (computed.kind === "resume" || computed.kind === "choose") {
    setLatch({ key, gate: computed });
  }

  return {
    gate,
    tasks,
    linkTask: openForUnit(tasks, linkTaskId, vehicleId),
    tasksError: query.error,
    reload: () => void query.refetch(),
    settle: () => setLatch({ key, gate: { kind: "resume" } }),
  };
}
