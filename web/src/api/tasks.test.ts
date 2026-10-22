import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { fetchUnitTasks, nominate, scheduleTask } from "./tasks";
import { ApiError } from "./client";
import { respond, sentBody, requestedUrl } from "../test/fixtures";

function task() {
  return {
    id: "t1",
    vehicleId: "u9",
    fleetNumber: "HORSE-9",
    dueAt: "2026-09-05T21:59:59.999999Z",
    state: "OPEN",
    overdue: false,
    escalated: false,
    responsibleUserId: "d1",
    responsibleDisplayName: "Test Driver",
    responsibleVia: "NOMINATION",
  };
}

describe("the inspection-task API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
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
    it("posts the body verbatim, an empty one when nothing is chosen", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, task()));

      const result = await scheduleTask("u9", {});

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(requestedUrl(url)).toBe("/api/vehicles/u9/inspection-tasks");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({});
      expect(result).toEqual(task());
    });

    it("carries dueOn and nomineeUserId in the body when given", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, task()));

      await scheduleTask("u9", { dueOn: "2099-01-01", nomineeUserId: "d1" });

      expect(sentBody(0)).toEqual({ dueOn: "2099-01-01", nomineeUserId: "d1" });
    });

    it("carries TY018 through as an ApiError", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(422, { code: "TY018", message: "a task is due today or later, never in the past" }),
      );

      const error = await scheduleTask("u9", {}).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("TY018");
    });
  });

  describe("nominate", () => {
    it("posts the nominee under the task it names", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, task()));

      const result = await nominate("t1", { userId: "d1" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(requestedUrl(url)).toBe("/api/inspection-tasks/t1/nominations");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({ userId: "d1" });
      expect(result).toEqual(task());
    });
  });
});
