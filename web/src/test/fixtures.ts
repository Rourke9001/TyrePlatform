import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";

import type { Me } from "../auth/me";
import type { FitmentHistoryRow, OpenFitment, Unit, UnitPosition } from "../api/units";

// The default retries a failed request three times with backoff, which
// would schedule timers that outlive the test body.
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// The one construction site for a test actor. When the server adds a field
// to Me, tsc fails here and nowhere else — a search cannot find every
// literal a test file builds (docs/lessons.md, 31 Aug 2026).
export function me(overrides: Partial<Me> = {}): Me {
  return {
    userId: "u0",
    displayName: "Test",
    role: "CONTROLLER",
    capabilities: [],
    depots: [],
    timezone: "Africa/Johannesburg",
    displayCodePolicy: "FREE",
    ...overrides,
  };
}

export function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The narrowing throws rather than casts: RequestInit.body is BodyInit, and
// String() on a Blob or FormData yields "[object Object]", which would make
// a JSON assertion pass while testing nothing (docs/lessons.md, 31 Aug 2026).
export function sentBody(call: number): unknown {
  const init = vi.mocked(fetch).mock.calls[call][1];
  if (typeof init?.body !== "string") {
    throw new Error(`call ${call} did not send a string body`);
  }
  return JSON.parse(init.body);
}

// The unit surface's construction sites, for the reason me() is one: a
// screen's test builds a Unit, a position and a history row across half a
// dozen files, and a field the server adds must fail tsc in one place rather
// than pass silently in each of them (docs/lessons.md, 31 Aug 2026).
export function openFitment(overrides: Partial<OpenFitment> = {}): OpenFitment {
  return {
    fitmentId: "f1",
    tyreId: "t1",
    displayCode: "TY001",
    fittedAt: "2026-08-01T06:00:00Z",
    fittedOdometer: 100000,
    fittedTreadMm: "14.5",
    mountOrientation: "MARK_OUTBOARD",
    tyreStatus: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    lastTreadMm: "12.0",
    ...overrides,
  };
}

export function unitPosition(overrides: Partial<UnitPosition> & { id: string }): UnitPosition {
  return {
    code: "POS1",
    sequence: 1,
    axleNumber: 1,
    axleClass: "STEER",
    side: "LEFT",
    slot: "SINGLE",
    isSpare: false,
    fitment: null,
    ...overrides,
  };
}

export function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: "u1",
    fleetNumber: "HORSE-1",
    registration: "SBX001GP",
    description: null,
    bodyType: null,
    unitDescriptor: null,
    unitKind: "HORSE",
    status: "ACTIVE",
    configurationId: "c1",
    configurationName: "6x4 horse",
    homeDepotId: null,
    operatingGroupId: null,
    tags: [],
    hasHistory: false,
    removalReasons: ["Worn out", "Damaged"],
    hasOdometer: true,
    positions: [],
    ...overrides,
  };
}

export function fitmentRow(
  overrides: Partial<FitmentHistoryRow> & { fitmentId: string },
): FitmentHistoryRow {
  return {
    tyreId: "t1",
    displayCode: "TY001",
    positionCode: "POS1",
    fittedAt: "2026-08-01T06:00:00Z",
    removedAt: "2026-08-20T06:00:00Z",
    fittedOdometer: 100000,
    removedOdometer: 112000,
    fittedTreadMm: "14.5",
    removedTreadMm: "9.0",
    removalReason: "Worn out",
    distanceKm: 12000,
    distanceSource: "MEASURED",
    mountOrientation: "MARK_OUTBOARD",
    ...overrides,
  };
}

// sentBody's narrowing for the other half of a call. fetch takes
// RequestInfo | URL, and String() on a Request or a URL object yields text a
// path assertion would match by accident, so the shape is checked rather
// than coerced (docs/lessons.md, 31 Aug 2026).
export function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input !== "string") {
    throw new Error("fetch was called with something other than a path string");
  }
  return input;
}
