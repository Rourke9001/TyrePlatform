import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/apiError";
import type { CaptureContext } from "./captureContext";
import { captureContextQuery, fetchCaptureContext } from "./captureContext";

const body: CaptureContext = {
  vehicleId: "11111111-1111-1111-1111-111111111111",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  averageDailyKm: null,
  combination: null,
  positions: [
    {
      id: "22222222-2222-2222-2222-222222222222",
      vehicleId: "11111111-1111-1111-1111-111111111111",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
      side: "LEFT",
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
    captureSpares: true,
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

  // U148: a resumed draft reads through its own window, and only it does,
  // so the at-now read stays the default (FR-AUT-005).
  it("carries startedAt only when it is given", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchCaptureContext("v1");
    await fetchCaptureContext("v1", "2026-10-22T06:00:00.000Z");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/capture/vehicles/v1");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/capture/vehicles/v1?startedAt=2026-10-22T06%3A00%3A00.000Z",
    );
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
  // either. It reports one thing.
  it("surfaces a refusal without guessing why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) }),
    );

    await expect(fetchCaptureContext(body.vehicleId)).rejects.toThrow(/403/);
  });
});

describe("captureContextQuery key", () => {
  // A read through a draft's window answers for that window, so it never
  // shares a cache entry with the at-now read of the same unit.
  it("differs with and without a startedAt, and only then", () => {
    const atNow = captureContextQuery("v1").queryKey;
    expect(captureContextQuery("v1", undefined).queryKey).toEqual(atNow);
    expect(captureContextQuery("v1", "2026-10-22T06:00:00.000Z").queryKey).not.toEqual(atNow);
  });
});

describe("captureContextQuery retry", () => {
  // A 401 or 403 answers the same on the next attempt (retryQuery, shared
  // with ActorProvider), so a signed-out driver is not made to wait through
  // three renewals.
  it("does not retry a 401 or a 403 but retries a network failure", () => {
    const { retry } = captureContextQuery("v1");
    expect(retry(0, new ApiError(401, "x"))).toBe(false);
    expect(retry(0, new ApiError(403, "x"))).toBe(false);
    expect(retry(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retry(3, new TypeError("Failed to fetch"))).toBe(false);
  });

  // The token store's latch answers every call at once until a reload, so
  // retrying it only shows "Loading" for the length of the retries.
  it("does not retry the latched store's 503 but retries any other 503", () => {
    const { retry } = captureContextQuery("v1");
    expect(retry(0, new ApiError(503, "x", "auth_unavailable"))).toBe(false);
    expect(retry(0, new ApiError(503, "x"))).toBe(true);
  });
});
