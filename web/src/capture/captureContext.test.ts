import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCaptureContext } from "./captureContext";

const body = {
  vehicleId: "11111111-1111-1111-1111-111111111111",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  combination: null,
  positions: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      vehicleId: "11111111-1111-1111-1111-111111111111",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
      axleNumber: 1,
      isSpare: false,
      unitLabel: "Horse",
      tyreId: "33333333-3333-3333-3333-333333333333",
      tyreCode: "BAC-04217",
      previousGoverningMm: 12.0,
      previousReadingAt: "2026-07-23T06:00:00Z",
      fitmentSincePrevious: false,
      targetKpa: 800,
      warnUnderPct: 10,
      criticalUnderPct: 20,
      warnOverPct: 10,
      criticalOverPct: 20,
    },
  ],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4.0,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.82 },
};

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("fetchCaptureContext", () => {
  it("reads the whole capture context in one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = await fetchCaptureContext(body.vehicleId);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/capture/vehicles/${body.vehicleId}`);
    expect(ctx.positions).toHaveLength(1);
    expect(ctx.config.removalThresholdMm).toBe(4.0);
    expect(ctx.cohortWearRateMmPerMonth["STEER:FIXED"]).toBe(0.82);
  });

  // FR-OFF-002 as amended by E2 and NFR-PRV-006. The device holds the
  // in-progress inspection and nothing else; a cached register on a driver's
  // personal phone is a different product with a different privacy notice.
  it("writes no part of the reference data to device storage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(body) }),
    );

    await fetchCaptureContext(body.vehicleId);

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  // A driver refused a vehicle and a vehicle that does not exist must look
  // identical (ADR-0011), so the client cannot helpfully distinguish them
  // either — it reports one thing.
  it("surfaces a refusal without guessing why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    );

    await expect(fetchCaptureContext(body.vehicleId)).rejects.toThrow(/403/);
  });
});
