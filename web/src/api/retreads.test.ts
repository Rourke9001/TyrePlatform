import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { fetchRetreadJobs, logRetreadReturn } from "./retreads";
import { respond, sentBody } from "../test/fixtures";

function respondNoContent(): Response {
  return new Response(null, { status: 204 });
}

describe("the retread queue API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchRetreadJobs", () => {
    it("always sends ?open=true", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(200, [
          {
            id: "rj1",
            tyreId: "t1",
            displayCode: "H1-POS1",
            depotName: "Central Retreader",
            sentAt: "2026-01-01",
            daysOut: 5,
          },
        ]),
      );

      const jobs = await fetchRetreadJobs();

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/retread-jobs?open=true");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].depotName).toBe("Central Retreader");
    });
  });

  describe("logRetreadReturn", () => {
    it("posts the return under the job it closes and resolves with nothing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      const result = await logRetreadReturn("rj1", {
        returnedOn: "2026-02-01",
        casingAccepted: true,
        reportReference: "RPT-1",
        retreadCost: "850.00",
        postTreadMm: "16.00",
      });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/retread-jobs/rj1/return");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({
        returnedOn: "2026-02-01",
        casingAccepted: true,
        reportReference: "RPT-1",
        retreadCost: "850.00",
        postTreadMm: "16.00",
      });
      expect(result).toBeUndefined();
    });

    it("posts casingAccepted: false for a rejected casing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      await logRetreadReturn("rj1", {
        returnedOn: "2026-02-01",
        casingAccepted: false,
        reportReference: "RPT-2",
      });

      expect(sentBody(0)).toEqual({
        returnedOn: "2026-02-01",
        casingAccepted: false,
        reportReference: "RPT-2",
      });
    });
  });
});
