import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { fetchRigs, createRig, endRig } from "./combinations";
import { ApiError } from "./client";
import { respond, sentBody } from "../test/fixtures";

function rig() {
  return {
    id: "r1",
    motiveVehicleId: "u1",
    motiveFleetNumber: "HORSE-1",
    effectiveFrom: "2026-09-03T07:12:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u1", fleetNumber: "HORSE-1", sequence: 1, descriptor: null, unitKind: "HORSE" },
      {
        vehicleId: "u2",
        fleetNumber: "LINK6",
        sequence: 2,
        descriptor: "front",
        unitKind: "TRAILER",
      },
    ],
  };
}

describe("the rigs API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchRigs", () => {
    it("narrows to open rigs with ?open=true", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, [rig()]));

      await fetchRigs({ open: true });

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/combinations?open=true");
    });

    it("builds no query string when no options are given", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, [rig()]));

      await fetchRigs();

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/combinations");
    });
  });

  describe("createRig", () => {
    it("posts the body verbatim and resolves the rig", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(201, rig()));

      const body = {
        motiveVehicleId: "u1",
        towed: [{ vehicleId: "u2", descriptor: "front" }],
        effectiveOn: "2026-09-03",
      };
      const result = await createRig(body);

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/combinations");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual(body);
      expect(result).toEqual(rig());
    });
  });

  describe("endRig", () => {
    it("posts to the rig's end path and resolves the ended rig", async () => {
      const ended = { ...rig(), effectiveTo: "2026-09-04T06:00:00Z" };
      vi.mocked(fetch).mockResolvedValue(respond(200, ended));

      const result = await endRig("r1", { endedOn: "2026-09-04" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/combinations/r1/end");
      expect(init?.method).toBe("POST");
      expect(sentBody(0)).toEqual({ endedOn: "2026-09-04" });
      expect(result).toEqual(ended);
    });
  });

  describe("refusals", () => {
    it("carries TY017 through as an ApiError", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(422, { code: "TY017", message: "a rig has at least one towed unit" }),
      );

      const error = await createRig({ motiveVehicleId: "u1", towed: [] }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("TY017");
    });
  });
});
