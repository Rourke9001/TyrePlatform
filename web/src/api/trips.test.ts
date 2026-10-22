import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { endTrip, fetchDrivers, fetchTripBlockers, fetchUnitTrip, startTrip } from "./trips";
import { respond, sentBody, requestedUrl } from "../test/fixtures";

describe("the trip API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a unit's trip panel and the driver picker", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, { trip: null, pulledBy: null }));
    await fetchUnitTrip("u9");
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/trip");

    vi.mocked(fetch).mockResolvedValue(respond(200, []));
    await fetchDrivers();
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/drivers");
  });

  it("omits addTrailers from the blockers read when none is added, and joins them when some are", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(respond(200, [])));
    await fetchTripBlockers("u9", []);
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/trip-blockers");

    await fetchTripBlockers("u9", ["t1", "t2"]);
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe(
      "/api/vehicles/u9/trip-blockers?addTrailers=t1,t2",
    );
  });

  it("posts a start and an end", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(201, {}));
    await startTrip({ motiveVehicleId: "u9", driverUserId: "d1", addTrailers: ["t1"] });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(requestedUrl(url)).toBe("/api/trips");
    expect(init?.method).toBe("POST");
    expect(sentBody(0)).toEqual({ motiveVehicleId: "u9", driverUserId: "d1", addTrailers: ["t1"] });

    vi.mocked(fetch).mockResolvedValue(respond(200, {}));
    await endTrip("tr1");
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/trips/tr1/end");
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe("POST");
  });
});
