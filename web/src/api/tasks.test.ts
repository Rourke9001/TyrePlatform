import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { fetchUnitDrivers, fetchUnitTasks, scheduleTask } from "./tasks";
import { ApiError } from "./client";
import { respond, sentBody, requestedUrl } from "../test/fixtures";

function driver() {
  return {
    userId: "d1",
    displayName: "Test Driver",
    staffNumber: "S100",
    viaVehicleId: "u9",
    viaFleetNumber: "HORSE-9",
  };
}

function task() {
  return {
    id: "t1",
    vehicleId: "u9",
    fleetNumber: "HORSE-9",
    dueAt: "2026-09-05T21:59:59.999999Z",
    state: "OPEN",
    overdue: false,
    assignedUserId: "d1",
    assignedDisplayName: "Test Driver",
  };
}

describe("the inspection-task API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchUnitDrivers", () => {
    it("requests the unit's drivers", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, [driver()]));

      const result = await fetchUnitDrivers("u9");

      expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/drivers");
      expect(result).toEqual([driver()]);
    });
  });

  describe("fetchUnitTasks", () => {
    it("requests the unit's inspection tasks", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, [task()]));

      const result = await fetchUnitTasks("u9");

      expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe(
        "/api/vehicles/u9/inspection-tasks",
      );
      expect(result).toEqual([task()]);
    });
  });

  describe("scheduleTask", () => {
    it("posts the body verbatim with no dueOn key when absent", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, task()));

      const result = await scheduleTask("u9", { assigneeUserId: "d1" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(requestedUrl(url)).toBe("/api/vehicles/u9/inspection-tasks");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({ assigneeUserId: "d1" });
      expect(result).toEqual(task());
    });

    it("carries dueOn in the body when given", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, task()));

      await scheduleTask("u9", { assigneeUserId: "d1", dueOn: "2099-01-01" });

      expect(sentBody(0)).toEqual({ assigneeUserId: "d1", dueOn: "2099-01-01" });
    });

    it("carries TY018 through as an ApiError", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(422, { code: "TY018", message: "a due day before the tenant's today is refused" }),
      );

      const error = await scheduleTask("u9", { assigneeUserId: "d1" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("TY018");
    });
  });
});
