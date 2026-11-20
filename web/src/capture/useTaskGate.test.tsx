import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { myTasksQuery, type MyTask } from "../driver/driver.data";
import { testQueryClient } from "../test/fixtures";
import type { Draft } from "./draft";
import { useTaskGate } from "./useTaskGate";

const k2: MyTask = {
  id: "k2",
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  dueAt: "2026-11-22T21:59:59Z",
  state: "OPEN",
  overdue: false,
};
const k3: MyTask = {
  ...k2,
  id: "k3",
  vehicleId: "v2",
  fleetNumber: "BAC711TR",
  captureVehicleId: "v1",
};

const held: Draft = {
  clientUuid: "c1",
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  combinationId: null,
  observedMemberVehicleIds: ["v1", "v2"],
  taskId: "k1",
  startedAt: "2026-11-20T06:00:00.000Z",
  odometerKm: null,
  comment: null,
  defectReport: null,
  positions: {},
  warnings: [],
  absentSpares: [],
  driverSubject: "oid-driver-1",
  legacy: false,
};

beforeEach(() => {
  // The list is served from the cache; its refetch never lands.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<never>(() => undefined)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTaskGate", () => {
  it("decides afresh when the route's link task changes (red team M5)", () => {
    const client = testQueryClient();
    client.setQueryData(myTasksQuery().queryKey, [k2, k3]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ linkTaskId }: { linkTaskId: string }) =>
        useTaskGate({ vehicleId: "v1", linkTaskId, scoped: true, resumedDraft: held }),
      { wrapper, initialProps: { linkTaskId: "k2" } },
    );

    expect(result.current.gate).toEqual({ kind: "choose", task: k2 });
    rerender({ linkTaskId: "k1" });
    expect(result.current.gate).toEqual({ kind: "resume" });
    rerender({ linkTaskId: "k3" });
    expect(result.current.gate).toEqual({ kind: "choose", task: k3 });
  });
});
