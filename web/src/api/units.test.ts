import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  fetchUnit,
  fetchUnitFitments,
  fetchOpenFitments,
  fetchDepots,
  fitTyre,
  removeFitment,
  rotateTyres,
  patchUnit,
  setUnitStatus,
} from "./units";
import { ApiError } from "./client";
import { respond, sentBody } from "../test/fixtures";

function respondNoContent(): Response {
  return new Response(null, { status: 204 });
}

describe("the unit and fitment API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchUnit", () => {
    it("reads one unit by id", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(200, {
          id: "u1",
          fleetNumber: "H1",
          registration: null,
          description: null,
          bodyType: null,
          unitDescriptor: null,
          unitKind: null,
          status: "ACTIVE",
          configurationId: "c1",
          configurationName: "Superlink",
          homeDepotId: null,
          operatingGroupId: null,
          tags: [],
          hasHistory: false,
          removalReasons: [],
          hasOdometer: true,
          positions: [],
        }),
      );

      const unit = await fetchUnit("u1");

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/vehicles/u1");
      expect(unit.fleetNumber).toBe("H1");
      expect(unit.registration).toBeNull();
    });

    it("carries a refusal's message and code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(404, { code: "not_found", message: "no such unit in this fleet" }),
      );

      const error = await fetchUnit("u1").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("not_found");
    });
  });

  describe("fetchUnitFitments", () => {
    it("reads the unit's fitment history as a bare list", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(200, [
          {
            fitmentId: "f1",
            tyreId: "t1",
            displayCode: "H1-POS1",
            positionCode: "POS1",
            fittedAt: "2026-01-01T00:00:00Z",
            removedAt: null,
            fittedOdometer: null,
            removedOdometer: null,
            fittedTreadMm: "12.00",
            removedTreadMm: null,
            removalReason: null,
            distanceKm: null,
            distanceSource: "UNAVAILABLE",
            mountOrientation: "OUTER",
          },
        ]),
      );

      const rows = await fetchUnitFitments("u1");

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/vehicles/u1/fitments");
      expect(rows).toHaveLength(1);
      expect(rows[0].fitmentId).toBe("f1");
    });
  });

  describe("fetchOpenFitments", () => {
    it("always sends ?open=true", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, []));

      await fetchOpenFitments();

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/fitments?open=true");
    });
  });

  describe("fetchDepots", () => {
    it("builds no query string when no type is given", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, []));

      await fetchDepots();

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/depots");
    });

    it("builds ?type= only when given", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, []));

      await fetchDepots("RETREADER");

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/depots?type=RETREADER");
    });
  });

  describe("fitTyre", () => {
    it("posts the fitment under the unit it belongs to", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, { fitmentId: "f1", warnings: [] }));

      const result = await fitTyre("u1", {
        tyreId: "t1",
        positionId: "p1",
        treadMm: "12.00",
        mountOrientation: "OUTER",
      });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/vehicles/u1/fitments");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({
        tyreId: "t1",
        positionId: "p1",
        treadMm: "12.00",
        mountOrientation: "OUTER",
      });
      expect(result).toEqual({ fitmentId: "f1", warnings: [] });
    });
  });

  describe("removeFitment", () => {
    it("posts the removal under the fitment it closes and resolves with nothing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      const result = await removeFitment("f1", { reason: "worn", treadMm: "2.00" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/fitments/f1/remove");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({ reason: "worn", treadMm: "2.00" });
      expect(result).toBeUndefined();
    });
  });

  describe("rotateTyres", () => {
    it("posts the moves under the unit and unwraps the moved fitments", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(201, { moves: [{ tyreId: "t1", fitmentId: "f2" }] }),
      );

      const result = await rotateTyres("u1", {
        moves: [{ tyreId: "t1", toPositionId: "p2", treadMm: "9.00" }],
      });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/vehicles/u1/rotations");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({
        moves: [{ tyreId: "t1", toPositionId: "p2", treadMm: "9.00" }],
      });
      expect(result).toEqual({ moves: [{ tyreId: "t1", fitmentId: "f2" }] });
    });
  });

  describe("patchUnit", () => {
    it("PATCHes the unit and resolves with the unit read's body", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(200, {
          id: "u1",
          fleetNumber: "H1-renamed",
          registration: null,
          description: null,
          bodyType: null,
          unitDescriptor: null,
          unitKind: null,
          status: "ACTIVE",
          configurationId: "c1",
          configurationName: "Superlink",
          homeDepotId: null,
          operatingGroupId: null,
          tags: [],
          hasHistory: false,
          removalReasons: [],
          hasOdometer: true,
          positions: [],
        }),
      );

      const result = await patchUnit("u1", { fleetNumber: "H1-renamed" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/vehicles/u1");
      expect(init?.method).toBe("PATCH");
      expect(sentBody(0)).toEqual({ fleetNumber: "H1-renamed" });
      expect(result.fleetNumber).toBe("H1-renamed");
    });
  });

  describe("setUnitStatus", () => {
    it("posts the status change under the unit and resolves with nothing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      const result = await setUnitStatus("u1", { status: "DISPOSED", reason: "scrapped" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/vehicles/u1/status");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({ status: "DISPOSED", reason: "scrapped" });
      expect(result).toBeUndefined();
    });
  });
});
